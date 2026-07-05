import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  KaguraAuthError,
  KaguraConnectionError,
  KaguraError,
  KaguraNotFoundError,
  KaguraQuotaError,
} from "../src/errors.js";
import { SDK_VERSION } from "../src/http.js";
import { DEFAULT_REST_BASE_URL, KaguraRestClient } from "../src/restBase.js";
import type {
  HttpMethod,
  KaguraRestClientOptions,
  RequestContext,
  RestResponse,
} from "../src/restBase.js";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Scripted fetch stub — the TS analogue of the Python httpx MockTransport. */
class FakeRest {
  requests: Recorded[] = [];
  status = 200;
  body = "{}";
  responseHeaders: Record<string, string> = {};
  /** When set, fetch throws this instead of responding. */
  error: unknown = null;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    this.requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (this.error !== null) {
      throw this.error;
    }
    return new Response(this.body, { status: this.status, headers: this.responseHeaders });
  };
}

/** Subclass that exposes the protected spine for direct testing. */
class ProbeClient extends KaguraRestClient {
  requestPublic(
    method: HttpMethod,
    p: string,
    opts?: {
      json?: Record<string, unknown>;
      params?: Record<string, unknown>;
      extraHeaders?: Record<string, string>;
    },
  ): Promise<RestResponse> {
    return this.request(method, p, opts);
  }

  jsonPublic(response: RestResponse): unknown {
    return this.json(response);
  }

  expectListPublic(response: RestResponse): unknown[] {
    return this.expectList(response);
  }
}

function makeProbe(server: FakeRest, options: KaguraRestClientOptions = {}): ProbeClient {
  return new ProbeClient({
    apiKey: "test-key",
    baseUrl: "https://x.test",
    fetch: server.fetch,
    ...options,
  });
}

function makeOAuthProbe(server: FakeRest): ProbeClient {
  return new ProbeClient({
    oauth: { getAuthHeader: async () => "Bearer oauth-token" },
    baseUrl: "https://x.test",
    fetch: server.fetch,
  });
}

function envelopeOf(
  text: string,
  status = 200,
  method: HttpMethod = "GET",
  p = "/api/v1/x",
): RestResponse {
  return { status, headers: new Headers(), text, method, path: p };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (e: unknown) => e,
  );
}

describe("construction", () => {
  it("requires apiKey or oauth, naming the class and its factory", () => {
    expect(() => new KaguraRestClient()).toThrow(
      /KaguraRestClient requires apiKey, or use KaguraRestClient\.fromMcpUrl/,
    );
  });

  it("names the subclass (not the base) in the missing-credentials error", () => {
    expect(() => new ProbeClient({})).toThrow(
      /ProbeClient requires apiKey, or use ProbeClient\.fromMcpUrl/,
    );
  });

  it("defaults the base URL to the production origin", () => {
    const client = new ProbeClient({ apiKey: "k" });
    expect(client.baseUrl).toBe(DEFAULT_REST_BASE_URL);
    expect(client.timeoutMs).toBe(30_000);
  });

  it("strips trailing slashes from the base URL", () => {
    const client = makeProbe(new FakeRest(), { baseUrl: "https://x.test///" });
    expect(client.baseUrl).toBe("https://x.test");
  });

  it("rejects plain-HTTP non-loopback base URLs", () => {
    expect(() => makeProbe(new FakeRest(), { baseUrl: "http://evil.test" })).toThrow(
      /Base URL must use HTTPS/,
    );
  });

  it("allows localhost HTTP for development", () => {
    expect(() => makeProbe(new FakeRest(), { baseUrl: "http://localhost:8080" })).not.toThrow();
  });
});

describe("request spine", () => {
  it("sends the bearer token and SDK User-Agent on every request", async () => {
    const server = new FakeRest();
    const probe = makeProbe(server);
    await probe.requestPublic("GET", "/api/v1/things");

    const req = server.requests[0]!;
    expect(req.url).toBe("https://x.test/api/v1/things");
    expect(req.method).toBe("GET");
    expect(req.headers.authorization).toBe("Bearer test-key");
    expect(req.headers["user-agent"]).toBe(`kagura-memory-sdk/${SDK_VERSION}`);
  });

  it("serializes only set params, dropping undefined and null", async () => {
    const server = new FakeRest();
    const probe = makeProbe(server);
    await probe.requestPublic("GET", "/api/v1/things", {
      params: { limit: 50, offset: 0, q: undefined, context_id: null },
    });

    expect(server.requests[0]!.url).toBe("https://x.test/api/v1/things?limit=50&offset=0");
  });

  it("sends a JSON body with content-type and merges extra headers last", async () => {
    const server = new FakeRest();
    const probe = makeProbe(server);
    await probe.requestPublic("POST", "/api/v1/things", {
      json: { display_name: "n" },
      extraHeaders: { "x-extra": "1" },
    });

    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.body).toBe('{"display_name":"n"}');
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["x-extra"]).toBe("1");
  });

  it("returns the {status, headers, text} envelope with method+path for 2xx", async () => {
    const server = new FakeRest();
    server.body = '{"ok":true}';
    server.responseHeaders = { "x-marker": "yes" };
    const probe = makeProbe(server);

    const envelope = await probe.requestPublic("GET", "/api/v1/items");
    expect(envelope.status).toBe(200);
    expect(envelope.text).toBe('{"ok":true}');
    expect(envelope.headers.get("x-marker")).toBe("yes");
    expect(envelope.method).toBe("GET");
    expect(envelope.path).toBe("/api/v1/items");
  });

  it("wraps transport failures as KaguraConnectionError with the cause", async () => {
    const server = new FakeRest();
    const boom = new TypeError("fetch failed");
    server.error = boom;
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("GET", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraConnectionError);
    expect((err as KaguraConnectionError).message).toBe("Connection failed: fetch failed");
    expect((err as KaguraConnectionError).cause).toBe(boom);
  });
});

describe("status mapping", () => {
  it("maps 401 to KaguraAuthError with the API-key hint in static mode", async () => {
    const server = new FakeRest();
    server.status = 401;
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("GET", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraAuthError);
    expect((err as KaguraAuthError).message).toBe("Authentication failed. Check your API key.");
  });

  it("maps 401 to the OAuth recovery hint in OAuth mode", async () => {
    const server = new FakeRest();
    server.status = 401;
    const probe = makeOAuthProbe(server);

    const err = await caught(probe.requestPublic("GET", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraAuthError);
    expect((err as KaguraAuthError).message).toBe(
      "Authentication failed. Re-run `kagura auth login` or inspect ~/.kagura/credentials.json.",
    );
  });

  it("maps 403 to the generic HTTP mapping by default", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = '{"detail":"Forbidden"}';
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("GET", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraConnectionError);
    expect((err as KaguraConnectionError).message).toBe("HTTP 403: Forbidden");
  });

  it("lets subclasses override the 403 hook", async () => {
    class Custom403Client extends ProbeClient {
      protected override error403(response: RestResponse, _context: RequestContext): KaguraError {
        return new KaguraAuthError(`no access (HTTP ${response.status})`);
      }
    }
    const server = new FakeRest();
    server.status = 403;
    const probe = new Custom403Client({
      apiKey: "k",
      baseUrl: "https://x.test",
      fetch: server.fetch,
    });

    const err = await caught(probe.requestPublic("GET", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraAuthError);
    expect((err as KaguraAuthError).message).toBe("no access (HTTP 403)");
  });

  it("maps 404 to KaguraNotFoundError with the server detail", async () => {
    const server = new FakeRest();
    server.status = 404;
    server.body = '{"detail":"Context not found"}';
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("GET", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraNotFoundError);
    expect((err as KaguraNotFoundError).message).toBe("Context not found");
  });

  it('falls back to "Not found" when the 404 body has no detail', async () => {
    const server = new FakeRest();
    server.status = 404;
    server.body = "<html>gone</html>";
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("GET", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraNotFoundError);
    expect((err as KaguraNotFoundError).message).toBe("Not found");
  });

  it("maps 429 to KaguraQuotaError honoring a numeric Retry-After", async () => {
    const server = new FakeRest();
    server.status = 429;
    server.responseHeaders = { "Retry-After": "7" };
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("GET", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect((err as KaguraQuotaError).message).toBe("Quota exceeded. Try again later.");
    expect((err as KaguraQuotaError).retryAfter).toBe(7);
  });

  it("treats a non-numeric Retry-After as absent on 429", async () => {
    const server = new FakeRest();
    server.status = 429;
    server.responseHeaders = { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" };
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("GET", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect((err as KaguraQuotaError).retryAfter).toBeNull();
  });

  it("maps 500 to the generic HTTP error with server detail", async () => {
    const server = new FakeRest();
    server.status = 500;
    server.body = '{"detail":"boom"}';
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("GET", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraConnectionError);
    expect((err as KaguraConnectionError).message).toBe("HTTP 500: boom");
  });

  it("keeps the status bare when a 500 body has no usable detail", async () => {
    const server = new FakeRest();
    server.status = 500;
    server.body = "not json";
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("GET", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraConnectionError);
    expect((err as KaguraConnectionError).message).toBe("HTTP 500");
  });
});

describe("response-body helpers", () => {
  it("json() parses a valid body", () => {
    const probe = makeProbe(new FakeRest());
    expect(probe.jsonPublic(envelopeOf('{"a":1}'))).toEqual({ a: 1 });
  });

  it("json() maps a proxy/CDN HTML page to KaguraConnectionError naming the endpoint", () => {
    const probe = makeProbe(new FakeRest());
    expect(() =>
      probe.jsonPublic(envelopeOf("<html>maintenance</html>", 200, "GET", "/api/v1/items")),
    ).toThrow(/Server returned a non-JSON body \(HTTP 200\) for GET \/api\/v1\/items\./);
  });

  it("expectList() returns a JSON array as-is", () => {
    const probe = makeProbe(new FakeRest());
    expect(probe.expectListPublic(envelopeOf("[1,2]"))).toEqual([1, 2]);
  });

  it("expectList() rejects a non-array body, describing the shape mismatch", () => {
    const probe = makeProbe(new FakeRest());
    expect(() =>
      probe.expectListPublic(envelopeOf('{"items":[]}', 200, "GET", "/api/v1/items")),
    ).toThrow(
      /Unexpected response shape for GET \/api\/v1\/items: expected a JSON array, got object\./,
    );
  });

  it("expectList() names null bodies as null, not object", () => {
    const probe = makeProbe(new FakeRest());
    expect(() => probe.expectListPublic(envelopeOf("null"))).toThrow(/got null\./);
  });
});

describe("fromMcpUrl", () => {
  it("resolves an explicit apiKey and derives the base URL from a workspace MCP URL", async () => {
    const server = new FakeRest();
    const client = ProbeClient.fromMcpUrl({
      apiKey: "explicit-key",
      mcpUrl: "https://x.test/mcp/w/xyz",
      fetch: server.fetch,
      env: {},
    });

    expect(client.baseUrl).toBe("https://x.test");
    await client.requestPublic("GET", "/api/v1/things");
    expect(server.requests[0]!.headers.authorization).toBe("Bearer explicit-key");
  });

  it("defaults to the production base URL when no MCP URL is stored", () => {
    const client = ProbeClient.fromMcpUrl({ apiKey: "k", env: {} });
    expect(client.baseUrl).toBe(DEFAULT_REST_BASE_URL);
  });

  it("resolves KAGURA_API_KEY / KAGURA_MCP_URL from the injected env", async () => {
    const server = new FakeRest();
    const client = ProbeClient.fromMcpUrl({
      fetch: server.fetch,
      env: { KAGURA_API_KEY: "env-key", KAGURA_MCP_URL: "https://envhost.test/mcp" },
    });

    expect(client.baseUrl).toBe("https://envhost.test");
    await client.requestPublic("GET", "/api/v1/things");
    expect(server.requests[0]!.headers.authorization).toBe("Bearer env-key");
  });

  it("passes timeoutMs through and defaults it to 30000", () => {
    expect(ProbeClient.fromMcpUrl({ apiKey: "k", env: {}, timeoutMs: 5000 }).timeoutMs).toBe(5000);
    expect(ProbeClient.fromMcpUrl({ apiKey: "k", env: {} }).timeoutMs).toBe(30_000);
  });

  it("throws the actionable resolver error when no credentials exist", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-restbase-"));
    try {
      expect(() => ProbeClient.fromMcpUrl({ env: {}, home })).toThrow(KaguraAuthError);
      expect(() => ProbeClient.fromMcpUrl({ env: {}, home })).toThrow(/No credentials found/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("is inherited by subclasses and returns the subclass type", () => {
    class FilesLikeClient extends ProbeClient {}
    const client = FilesLikeClient.fromMcpUrl({ apiKey: "k", env: {} });
    expect(client).toBeInstanceOf(FilesLikeClient);
    // Compile-time check: the polymorphic factory returns the subclass type.
    const typed: FilesLikeClient = client;
    expect(typed.baseUrl).toBe(DEFAULT_REST_BASE_URL);
  });
});

describe("lifecycle", () => {
  it("close() resolves and subclasses can override it", async () => {
    let closed = 0;
    class TrackingClient extends KaguraRestClient {
      override async close(): Promise<void> {
        closed += 1;
        await super.close();
      }
    }
    const client = new TrackingClient({ apiKey: "k" });
    await client.close();
    await client.close();
    expect(closed).toBe(2);
  });
});
