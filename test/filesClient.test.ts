import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { KaguraConnectionError, KaguraIntegrityError } from "../src/errors.js";
import { FilesClient } from "../src/filesClient.js";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Route {
  status: number;
  body?: unknown;
  /** Echo the request; used to capture the R2 PUT body. */
  capture?: (rec: Recorded) => void;
}

/**
 * Fake server covering the 3-leg upload flow: the reserve/confirm REST
 * calls (matched by pathname) and the R2 PUT (matched by absolute URL).
 */
class FakeServer {
  requests: Recorded[] = [];
  routes: Record<string, Route> = {};

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    let body: unknown;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as unknown;
    } else if (init?.body !== undefined && init?.body !== null) {
      body = init.body; // Uint8Array for the R2 PUT
    }
    const rec: Recorded = { url, method: init?.method ?? "GET", headers, body };
    this.requests.push(rec);

    // Match the R2 PUT by full URL first, then REST calls by pathname.
    const key = this.routes[url] ? url : new URL(url).pathname;
    const route = this.routes[key];
    if (!route) {
      return new Response(JSON.stringify({ detail: "no route" }), { status: 404 });
    }
    route.capture?.(rec);
    const nullBody = route.status === 204 || route.status === 304;
    return new Response(nullBody ? null : JSON.stringify(route.body ?? {}), {
      status: route.status,
    });
  };

  find(pathOrUrl: string): Recorded | undefined {
    return this.requests.find((r) => r.url === pathOrUrl || new URL(r.url).pathname === pathOrUrl);
  }
}

const WS = "11111111-1111-1111-1111-111111111111";

function makeClient(server: FakeServer): FilesClient {
  return new FilesClient({ apiKey: "kagura_test", baseUrl: "https://x.test", fetch: server.fetch });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function sha256Base64(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64");
}

describe("validation", () => {
  it("rejects a non-UUID contextId", async () => {
    const client = makeClient(new FakeServer());
    await expect(
      client.upload({ contextId: "auto", source: new Uint8Array([1]), filename: "a.bin" }),
    ).rejects.toThrow(/contextId must be a UUID/);
  });

  it("requires a filename for byte sources", async () => {
    const client = makeClient(new FakeServer());
    await expect(
      client.upload({ contextId: WS, source: new Uint8Array([1]) }),
    ).rejects.toThrow(/filename is required/);
  });
});

describe("upload happy path", () => {
  it("drives reserve → checksum-bound PUT → confirm with the correct sha256", async () => {
    const bytes = new TextEncoder().encode("hello world");
    const hex = sha256Hex(bytes);
    const b64 = sha256Base64(bytes);
    // Presign that signed the checksum header → the SDK must send it.
    const uploadUrl =
      "https://r2.test/bucket/obj?X-Amz-SignedHeaders=host%3Bx-amz-checksum-sha256&sig=abc";

    const server = new FakeServer();
    server.routes["/api/v1/files/reserve"] = {
      status: 200,
      body: { file_id: "file-1", upload_url: uploadUrl, expires_at: "2026-01-01T00:00:00Z" },
    };
    server.routes[uploadUrl] = { status: 200 };
    server.routes["/api/v1/files/file-1/confirm"] = {
      status: 200,
      body: {
        id: "file-1",
        workspace_id: WS,
        filename: "greeting.txt",
        content_type: "text/plain",
        size_bytes: bytes.byteLength,
        sha256: hex,
        status: "confirmed",
        created_at: "2026-01-01T00:00:00Z",
      },
    };

    const client = makeClient(server);
    const result = await client.upload({
      contextId: WS,
      source: bytes,
      filename: "greeting.txt",
    });

    expect(result.id).toBe("file-1");

    // Reserve carried the right wire shape and sha256.
    const reserve = server.find("/api/v1/files/reserve")!;
    expect(reserve.body).toEqual({
      workspace_id: WS,
      filename: "greeting.txt",
      content_type: "text/plain",
      size_bytes: bytes.byteLength,
      sha256: hex,
    });

    // R2 PUT was unauthenticated and carried the base64 checksum header.
    const put = server.find(uploadUrl)!;
    expect(put.method).toBe("PUT");
    expect(put.headers.authorization).toBeUndefined();
    expect(put.headers["x-amz-checksum-sha256"]).toBe(b64);
    expect(put.headers["content-type"]).toBe("text/plain");

    // Confirm put workspace_id on the query and sha256 in the body.
    const confirm = server.find("/api/v1/files/file-1/confirm")!;
    expect(new URL(confirm.url).searchParams.get("workspace_id")).toBe(WS);
    expect(confirm.body).toEqual({ sha256: hex });
  });

  it("omits the checksum header when the presign did not sign it (#226)", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const uploadUrl = "https://r2.test/bucket/obj?X-Amz-SignedHeaders=host&sig=abc";
    const server = new FakeServer();
    server.routes["/api/v1/files/reserve"] = {
      status: 200,
      body: { file_id: "f2", upload_url: uploadUrl, expires_at: "2026-01-01T00:00:00Z" },
    };
    server.routes[uploadUrl] = { status: 200 };
    server.routes["/api/v1/files/f2/confirm"] = {
      status: 200,
      body: {
        id: "f2",
        workspace_id: WS,
        filename: "a.bin",
        content_type: "application/octet-stream",
        size_bytes: 3,
        sha256: sha256Hex(bytes),
        status: "confirmed",
        created_at: "2026-01-01T00:00:00Z",
      },
    };
    const client = makeClient(server);
    await client.upload({ contextId: WS, source: bytes, filename: "a.bin" });
    const put = server.find(uploadUrl)!;
    expect(put.headers["x-amz-checksum-sha256"]).toBeUndefined();
  });
});

describe("upload error paths", () => {
  it("maps an R2 400 to KaguraIntegrityError", async () => {
    const bytes = new Uint8Array([9]);
    const uploadUrl = "https://r2.test/o?X-Amz-SignedHeaders=host%3Bx-amz-checksum-sha256";
    const server = new FakeServer();
    server.routes["/api/v1/files/reserve"] = {
      status: 200,
      body: { file_id: "f3", upload_url: uploadUrl, expires_at: "2026-01-01T00:00:00Z" },
    };
    server.routes[uploadUrl] = { status: 400, body: "<Error>BadDigest</Error>" };
    const client = makeClient(server);
    await expect(
      client.upload({ contextId: WS, source: bytes, filename: "a.bin" }),
    ).rejects.toBeInstanceOf(KaguraIntegrityError);
  });

  it("returns the existing FileObject on a 409 dedup hit", async () => {
    const existing = {
      id: "dup-1",
      workspace_id: WS,
      filename: "a.bin",
      content_type: "application/octet-stream",
      size_bytes: 1,
      sha256: sha256Hex(new Uint8Array([1])),
      status: "confirmed",
      created_at: "2026-01-01T00:00:00Z",
    };
    const server = new FakeServer();
    server.routes["/api/v1/files/reserve"] = {
      status: 409,
      body: { detail: "duplicate", existing_file: existing },
    };
    const client = makeClient(server);
    const result = await client.upload({
      contextId: WS,
      source: new Uint8Array([1]),
      filename: "a.bin",
    });
    expect(result.id).toBe("dup-1");
    // No PUT/confirm should have happened.
    expect(server.requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/api/v1/files/reserve",
    ]);
  });

  it("re-throws a non-dedup reserve error", async () => {
    const server = new FakeServer();
    server.routes["/api/v1/files/reserve"] = { status: 500, body: { detail: "boom" } };
    const client = makeClient(server);
    await expect(
      client.upload({ contextId: WS, source: new Uint8Array([1]), filename: "a.bin" }),
    ).rejects.toBeInstanceOf(KaguraConnectionError);
  });
});

describe("downloadUrl / delete / list", () => {
  it("downloadUrl returns the presigned URL and sends workspace_id", async () => {
    const server = new FakeServer();
    server.routes["/api/v1/files/f1/download-url"] = {
      status: 200,
      body: { download_url: "https://r2.test/get?sig=x" },
    };
    const client = makeClient(server);
    const url = await client.downloadUrl("f1", { contextId: WS });
    expect(url).toBe("https://r2.test/get?sig=x");
    expect(new URL(server.find("/api/v1/files/f1/download-url")!.url).searchParams.get("workspace_id")).toBe(WS);
  });

  it("delete issues a DELETE with workspace_id and tolerates 204", async () => {
    const server = new FakeServer();
    server.routes["/api/v1/files/f1"] = { status: 204 };
    const client = makeClient(server);
    await expect(client.delete("f1", { contextId: WS })).resolves.toBeUndefined();
    expect(server.find("/api/v1/files/f1")!.method).toBe("DELETE");
  });

  it("list wraps a bare array into FileListResponse", async () => {
    const server = new FakeServer();
    server.routes["/api/v1/files"] = {
      status: 200,
      body: [
        {
          id: "f1",
          workspace_id: WS,
          filename: "a",
          content_type: "text/plain",
          size_bytes: 1,
          sha256: "x",
          status: "confirmed",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const client = makeClient(server);
    const page = await client.list({ contextId: WS });
    expect(page.files).toHaveLength(1);
    expect(page.next_cursor).toBeNull();
  });

  it("list passes through a {files,next_cursor} envelope", async () => {
    const server = new FakeServer();
    server.routes["/api/v1/files"] = {
      status: 200,
      body: { files: [], next_cursor: "abc" },
    };
    const client = makeClient(server);
    const page = await client.list({ contextId: WS, limit: 10 });
    expect(page.next_cursor).toBe("abc");
    expect(new URL(server.find("/api/v1/files")!.url).searchParams.get("limit")).toBe("10");
  });
});

describe("403 workspace hint (#115)", () => {
  it("builds a workspace-mismatch hint naming the requested workspace", async () => {
    const server = new FakeServer();
    server.routes["/api/v1/files/reserve"] = { status: 403, body: { detail: "forbidden" } };
    const client = makeClient(server);
    const error = await client
      .upload({ contextId: WS, source: new Uint8Array([1]), filename: "a.bin" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraConnectionError);
    // authSource is null for a bare apiKey constructor → generic 403 shape.
    expect((error as Error).message).toContain("HTTP 403");
  });
});
