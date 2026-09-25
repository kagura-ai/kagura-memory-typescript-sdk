/**
 * The SDK's progress events (#57): `FilesClient.upload({ onProgress })` and
 * `ResourceClient.ingestEvents(…, { onProgress })`, the Python SDK's
 * `logger=` hooks. The sequences are the ones `files_client.py` and
 * `resource_client.py` emit, failure by failure, and each ends with exactly
 * one terminal event.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { KaguraResponseError } from "../src/errors.js";
import { FilesClient } from "../src/filesClient.js";
import * as sdk from "../src/index.js";
import type {
  IngestEventsOptions,
  ProgressCallback,
  ProgressKind,
  UploadOptions,
} from "../src/index.js";
import { emitProgress, PROGRESS_SCHEMA_VERSION, type ProgressEvent } from "../src/progress.js";
import { ResourceClient } from "../src/resourceClient.js";

const WS = "11111111-1111-4111-8111-111111111111";
const UPLOAD_URL = "https://r2.test/bucket/obj?sig=abc";

interface Route {
  status: number;
  body?: unknown;
  /** The body as sent, in place of `body`'s JSON. */
  raw?: string;
}

/** Routes the 3-leg upload: the PUT by its full URL, REST calls by pathname. */
class FakeUpload {
  bodies: unknown[] = [];
  routes: Record<string, Route> = {
    "/api/v1/files/reserve": {
      status: 200,
      body: { file_id: "file-1", upload_url: UPLOAD_URL, expires_at: "2026-01-01T00:00:00Z" },
    },
    [UPLOAD_URL]: { status: 200 },
    "/api/v1/files/file-1/confirm": {
      status: 200,
      body: {
        id: "file-1",
        workspace_id: WS,
        filename: "greeting.txt",
        content_type: "text/plain",
        size_bytes: 11,
        sha256: "a".repeat(64),
        status: "uploaded",
        created_at: "2026-01-01T00:00:00Z",
      },
    },
  };

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (typeof init?.body === "string") this.bodies.push(JSON.parse(init.body));
    const route = this.routes[url] ?? this.routes[new URL(url).pathname];
    if (route === undefined) return new Response('{"detail":"no route"}', { status: 404 });
    return new Response(route.raw ?? JSON.stringify(route.body ?? {}), { status: route.status });
  };
}

/** Python's #250 message for a 2xx body its model refuses. */
function shapeMessage(operation: string, model: string, problem: string): string {
  return (
    `${operation}: unexpected server response for ${model} (${problem}). ` +
    "The server may be newer than this SDK; upgrading kagura-memory may help."
  );
}

/**
 * Record the rejections nobody handled while `run` runs, and for a moment
 * after: Node reports one once the microtasks drain.
 */
async function unhandledDuring(run: () => Promise<unknown> | void): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return unhandled;
}

/** A callback that rejects asynchronously: it typechecks as a ProgressCallback. */
const rejectingCallback: ProgressCallback = async (e) => {
  throw new Error(`sink failed on ${e.kind}`);
};

function client(fake: FakeUpload): FilesClient {
  return new FilesClient({ apiKey: "kagura_test", baseUrl: "https://x.test", fetch: fake.fetch });
}

function recorder(): { events: ProgressEvent[]; onProgress: (e: ProgressEvent) => void } {
  const events: ProgressEvent[] = [];
  return { events, onProgress: (e) => void events.push(e) };
}

const BYTES = new TextEncoder().encode("hello world");

const RESERVE = {
  stage: "reserve",
  kind: "action",
  msg: "Reserving upload",
  detail: { desc: "greeting.txt (11 bytes)" },
};
const UPLOAD = { stage: "upload", kind: "action", msg: "Uploading to object store" };
const CONFIRM = { stage: "confirm", kind: "action", msg: "Confirming upload" };

function failed(msg: RegExp, detail: Record<string, unknown>) {
  return { stage: "complete", kind: "error", msg: expect.stringMatching(msg), detail };
}

describe("FilesClient.upload({ onProgress })", () => {
  it("reports reserve, upload and confirm, then one success", async () => {
    const fake = new FakeUpload();
    const { events, onProgress } = recorder();
    const result = await client(fake).upload({
      contextId: WS,
      source: BYTES,
      filename: "greeting.txt",
      onProgress,
    });
    expect(result.id).toBe("file-1");
    expect(events).toEqual([
      RESERVE,
      UPLOAD,
      CONFIRM,
      {
        stage: "complete",
        kind: "success",
        msg: "Upload complete",
        detail: { file_id: "file-1", size_bytes: 11 },
      },
    ]);
  });

  it("names the file id the reserve handed out when the object store refuses the body", async () => {
    const fake = new FakeUpload();
    fake.routes[UPLOAD_URL] = { status: 400 };
    const { events, onProgress } = recorder();
    await expect(
      client(fake).upload({ contextId: WS, source: BYTES, filename: "greeting.txt", onProgress }),
    ).rejects.toThrow(/HTTP 400/);
    expect(events).toEqual([
      RESERVE,
      UPLOAD,
      failed(/^Upload failed: Object store rejected upload with HTTP 400 — /, {
        reserved_file_id: "file-1",
        uploaded: false,
        confirm_started: false,
        confirmed: false,
      }),
    ]);
  });

  it("says the confirm was sent when its answer failed", async () => {
    // confirm_started without confirmed: the server may have finalized the
    // file, so a consumer must check before uploading again.
    const fake = new FakeUpload();
    fake.routes["/api/v1/files/file-1/confirm"] = { status: 500, body: { detail: "boom" } };
    const { events, onProgress } = recorder();
    await expect(
      client(fake).upload({ contextId: WS, source: BYTES, filename: "greeting.txt", onProgress }),
    ).rejects.toThrow();
    expect(events).toEqual([
      RESERVE,
      UPLOAD,
      CONFIRM,
      failed(/^Upload failed: /, {
        reserved_file_id: "file-1",
        uploaded: true,
        confirm_started: true,
        confirmed: false,
      }),
    ]);
  });

  it("ends the stream with an error when the reserve is refused", async () => {
    const fake = new FakeUpload();
    fake.routes["/api/v1/files/reserve"] = { status: 422, body: { detail: "bad" } };
    const { events, onProgress } = recorder();
    await expect(
      client(fake).upload({ contextId: WS, source: BYTES, filename: "greeting.txt", onProgress }),
    ).rejects.toThrow();
    expect(events).toEqual([
      RESERVE,
      failed(/^Upload failed: /, {
        reserved_file_id: null,
        uploaded: false,
        confirm_started: false,
        confirmed: false,
      }),
    ]);
  });

  it("emits the error event for a check that fails before any request", async () => {
    // Python moved its validators inside the guard for exactly this.
    const fake = new FakeUpload();
    const { events, onProgress } = recorder();
    await expect(
      client(fake).upload({ contextId: "nope", source: BYTES, filename: "a.txt", onProgress }),
    ).rejects.toThrow("context_id must be a UUID; got 'nope'.");
    expect(events).toEqual([
      failed(/^Upload failed: context_id must be a UUID; got 'nope'\. Use the OAuth profile/, {
        reserved_file_id: null,
        uploaded: false,
        confirm_started: false,
        confirmed: false,
      }),
    ]);
    expect(fake.bodies).toEqual([]);
  });

  it("emits the error event when the file cannot be read", async () => {
    const { events, onProgress } = recorder();
    const missing = path.join(os.tmpdir(), `kagura-missing-${process.pid}-${Date.now()}.bin`);
    await expect(
      client(new FakeUpload()).upload({ contextId: WS, source: missing, onProgress }),
    ).rejects.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: "complete", kind: "error" });
  });

  it("ends a 409 dedup hit with a success naming the existing file", async () => {
    const fake = new FakeUpload();
    fake.routes["/api/v1/files/reserve"] = {
      status: 409,
      body: {
        detail: "duplicate",
        existing_file: {
          id: "file-0",
          workspace_id: WS,
          filename: "greeting.txt",
          content_type: "text/plain",
          size_bytes: 11,
          sha256: "a".repeat(64),
          status: "confirmed",
          created_at: "2026-01-01T00:00:00Z",
        },
      },
    };
    const { events, onProgress } = recorder();
    const result = await client(fake).upload({
      contextId: WS,
      source: BYTES,
      filename: "greeting.txt",
      onProgress,
    });
    expect(result.id).toBe("file-0");
    expect(events).toEqual([
      RESERVE,
      {
        stage: "complete",
        kind: "success",
        msg: "Dedup hit — existing file returned",
        detail: { file_id: "file-0", deduped: true },
      },
    ]);
  });

  it("ends a 409 without the existing file with an error", async () => {
    // What memory-cloud sends today: a message, no existing_file.
    const fake = new FakeUpload();
    fake.routes["/api/v1/files/reserve"] = {
      status: 409,
      body: { detail: "file with sha256=abc already exists in workspace" },
    };
    const { events, onProgress } = recorder();
    await expect(
      client(fake).upload({ contextId: WS, source: BYTES, filename: "greeting.txt", onProgress }),
    ).rejects.toThrow();
    expect(events.map((e) => e.kind)).toEqual(["action", "error"]);
  });

  it("finishes the upload when the callback throws", async () => {
    const fake = new FakeUpload();
    const result = await client(fake).upload({
      contextId: WS,
      source: BYTES,
      filename: "greeting.txt",
      onProgress: () => {
        throw new Error("sink broke");
      },
    });
    expect(result.id).toBe("file-1");
  });

  it("finishes the upload when an async callback rejects, and leaves no rejection unhandled", async () => {
    let result: { id: string } | undefined;
    const unhandled = await unhandledDuring(async () => {
      result = await client(new FakeUpload()).upload({
        contextId: WS,
        source: BYTES,
        filename: "greeting.txt",
        onProgress: rejectingCallback,
      });
    });
    expect(result?.id).toBe("file-1");
    expect(unhandled).toEqual([]);
  });

  it.each<[string, string]>([
    ["null", "Input should be a valid dictionary or instance of FileObject"],
    ["[]", "Input should be a valid dictionary or instance of FileObject"],
    ["{}", "id: Field required; workspace_id: Field required; filename: Field required (+5 more)"],
    [
      '{"id": "file-1", "workspace_id": "w", "filename": "f", "content_type": "t", "size_bytes": 1, "sha256": "s", "status": "uploaded"}',
      "created_at: Field required",
    ],
  ])("does not report a confirm answered with %s as confirmed", async (raw, problem) => {
    // Python parses its FileObject, the whole model, before `confirmed = True`.
    const fake = new FakeUpload();
    fake.routes["/api/v1/files/file-1/confirm"] = { status: 200, raw };
    const { events, onProgress } = recorder();
    const message = shapeMessage("FilesClient.upload", "FileObject", problem);
    const error = await client(fake)
      .upload({ contextId: WS, source: BYTES, filename: "greeting.txt", onProgress })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraResponseError);
    expect((error as Error).message).toBe(message);
    expect(events).toEqual([
      RESERVE,
      UPLOAD,
      CONFIRM,
      {
        stage: "complete",
        kind: "error",
        msg: `Upload failed: ${message}`,
        detail: { reserved_file_id: "file-1", uploaded: true, confirm_started: true, confirmed: false },
      },
    ]);
  });

  describe("the library default", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("writes nothing to stderr", async () => {
      const write = vi.spyOn(process.stderr, "write");
      await client(new FakeUpload()).upload({ contextId: WS, source: BYTES, filename: "greeting.txt" });
      expect(write).not.toHaveBeenCalled();
    });
  });

  it("sends the canonical form of a braced context id, as Python's normalize_uuid does", async () => {
    const fake = new FakeUpload();
    await client(fake).upload({
      contextId: `{${WS.toUpperCase()}}`,
      source: BYTES,
      filename: "greeting.txt",
    });
    expect(fake.bodies[0]).toMatchObject({ workspace_id: WS });
  });

  it("refuses a padded context id, as uuid.UUID does", async () => {
    await expect(
      client(new FakeUpload()).upload({ contextId: ` ${WS}`, source: BYTES, filename: "a.txt" }),
    ).rejects.toThrow(`context_id must be a UUID; got ' ${WS}'.`);
  });

  it("reads a path source, naming the file by its basename", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-progress-"));
    try {
      const file = path.join(dir, "greeting.txt");
      fs.writeFileSync(file, BYTES);
      const { events, onProgress } = recorder();
      await client(new FakeUpload()).upload({ contextId: WS, source: file, onProgress });
      expect(events[0]).toEqual(RESERVE);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ResourceClient.ingestEvents(…, { onProgress })", () => {
  function resourceClient(status: number, body: unknown): ResourceClient {
    return new ResourceClient({
      apiKey: "kagura_test",
      baseUrl: "https://x.test",
      fetch: async () => new Response(JSON.stringify(body), { status }),
    });
  }
  const EVENTS = [
    { op: "upsert" as const, docId: "a" },
    { op: "upsert" as const, docId: "b" },
  ];

  it("reports the batch, then its counts", async () => {
    const { events, onProgress } = recorder();
    await resourceClient(200, { created_count: 2, failed_count: 0 }).ingestEvents(
      "res-1",
      "rk",
      EVENTS,
      { onProgress },
    );
    expect(events).toEqual([
      {
        stage: "ingest_events",
        kind: "action",
        msg: "Ingesting events batch",
        detail: { desc: "2 event(s) for resource res-1" },
      },
      { stage: "complete", kind: "success", msg: "Batch ingested", detail: { created: 2, failed: 0 } },
    ]);
  });

  it("ends a failed batch with an error naming what was attempted", async () => {
    const { events, onProgress } = recorder();
    await expect(
      resourceClient(500, { detail: "down" }).ingestEvents("res-1", "rk", EVENTS, { onProgress }),
    ).rejects.toThrow();
    expect(events[1]).toEqual(
      failed(/^Batch ingest failed: /, { events_attempted: 2, resource_id: "res-1" }),
    );
    expect(events).toHaveLength(2);
  });

  it("stays silent without a callback", async () => {
    await expect(
      resourceClient(200, { created_count: 2 }).ingestEvents("res-1", "rk", EVENTS),
    ).resolves.toMatchObject({ created_count: 2 });
  });

  it.each([null, []])("ends a batch answered with %j with the error event, as Python's model check does", async (body) => {
    // Read after the guard, the counts of a null body threw a TypeError and
    // the stream ended with no terminal event.
    const { events, onProgress } = recorder();
    const message = shapeMessage(
      "ResourceClient.ingest_events",
      "ResourceEventBatchResponse",
      "Input should be a valid dictionary or instance of ResourceEventBatchResponse",
    );
    const error = await resourceClient(200, body)
      .ingestEvents("res-1", "rk", EVENTS, { onProgress })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraResponseError);
    expect((error as Error).message).toBe(message);
    expect(events).toEqual([
      expect.objectContaining({ stage: "ingest_events", kind: "action" }),
      {
        stage: "complete",
        kind: "error",
        msg: `Batch ingest failed: ${message}`,
        detail: { events_attempted: 2, resource_id: "res-1" },
      },
    ]);
  });

  it("finishes the batch when an async callback rejects, and leaves no rejection unhandled", async () => {
    let created: number | undefined;
    const unhandled = await unhandledDuring(async () => {
      const result = await resourceClient(200, { created_count: 2 }).ingestEvents("res-1", "rk", EVENTS, {
        onProgress: rejectingCallback,
      });
      created = result.created_count;
    });
    expect(created).toBe(2);
    expect(unhandled).toEqual([]);
  });
});

describe("emitProgress", () => {
  it("swallows what the sink throws", () => {
    expect(() =>
      emitProgress(
        () => {
          throw new Error("x");
        },
        { stage: "s", kind: "action" },
      ),
    ).not.toThrow();
  });

  it("swallows what an async sink rejects with, which would otherwise end the process", async () => {
    const unhandled = await unhandledDuring(() => {
      emitProgress(rejectingCallback, { stage: "s", kind: "action" });
    });
    expect(unhandled).toEqual([]);
  });

  it("swallows a thenable whose then throws, and ignores a non-promise return value", async () => {
    const thenable = (() => ({
      then: () => {
        throw new Error("then broke");
      },
    })) as unknown as ProgressCallback;
    const unhandled = await unhandledDuring(() => {
      emitProgress(thenable, { stage: "s", kind: "action" });
      emitProgress((() => 42) as unknown as ProgressCallback, { stage: "s", kind: "action" });
    });
    expect(unhandled).toEqual([]);
  });

  it("is a no-op without a sink", () => {
    expect(() => emitProgress(undefined, { stage: "s", kind: "action" })).not.toThrow();
  });

  it("stamps schema version 1, as Python's NDJSON does", () => {
    expect(PROGRESS_SCHEMA_VERSION).toBe(1);
  });
});

describe("public surface", () => {
  it("exports the progress types and version from the entry point, and keeps emitProgress internal", () => {
    // Compile-time half: these annotations fail typecheck if index.ts stops
    // re-exporting the types.
    const kind: ProgressKind = "success";
    const onProgress: ProgressCallback = () => {};
    const upload: Pick<UploadOptions, "onProgress"> = { onProgress };
    const ingest: IngestEventsOptions = { onProgress };
    expect([kind, typeof upload.onProgress, typeof ingest.onProgress]).toEqual([
      "success",
      "function",
      "function",
    ]);
    expect(sdk.PROGRESS_SCHEMA_VERSION).toBe(1);
    expect(Object.keys(sdk)).not.toContain("emitProgress");
  });
});
