import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  KaguraAuthError,
  KaguraConnectionError,
  KaguraError,
  KaguraNotFoundError,
  KaguraFeatureNotAvailableError,
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

  it("maps a v0.75 403 FEAT-001 to KaguraFeatureNotAvailableError by its gate", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "FEAT-001",
      message:
        "Feature 'resources' not available on L plan. Upgrade to XL plan to access this feature.",
      details: {
        gate: "plan",
        feature: "resources",
        required_plan: "promax",
        required_plan_display: "XL",
        current_plan: "pro",
      },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/resource-tokens"));
    expect(err).toBeInstanceOf(KaguraFeatureNotAvailableError);
    const plan = err as KaguraFeatureNotAvailableError;
    expect(plan.message).toBe(
      "Feature 'resources' not available on L plan. Upgrade to XL plan to access this feature.",
    );
    expect(plan.gate).toBe("plan");
    expect(plan.feature).toBe("resources");
    expect(plan.requiredPlan).toBe("promax");
    expect(plan.requiredPlanDisplay).toBe("XL");
    expect(plan.currentPlan).toBe("pro");
  });

  it("maps a pre-v0.75 403 FEAT-001 to KaguraFeatureNotAvailableError by its code", async () => {
    // v0.68-v0.74 sent only details.feature beside the code.
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "FEAT-001",
      message: "Resources require the XL plan.",
      details: { feature: "resources" },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/resource-tokens"));
    expect(err).toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect((err as KaguraFeatureNotAvailableError).gate).toBeNull();
    expect((err as KaguraFeatureNotAvailableError).feature).toBe("resources");
    expect((err as KaguraFeatureNotAvailableError).requiredPlan).toBeNull();
  });

  it("maps a 403 QUOTA-001 to KaguraQuotaError — a 403 is not always a plan refusal", async () => {
    // The resource-token cap keeps its 403 in v0.75 but is a quota.
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "QUOTA-001",
      message: "Token limit reached. Your L plan allows 3 active tokens.",
      details: {
        gate: "quota",
        quota_type: "resource_tokens",
        current: 3,
        limit: 3,
        required_plan: "promax",
        required_plan_display: "XL",
        current_plan: "pro",
        feature: "resources",
        resets_at: null,
      },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/resource-tokens"));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect(err).not.toBeInstanceOf(KaguraFeatureNotAvailableError);
    const quota = err as KaguraQuotaError;
    expect(quota.message).toBe("Token limit reached. Your L plan allows 3 active tokens.");
    expect(quota.gate).toBe("quota");
    expect(quota.quotaType).toBe("resource_tokens");
    expect(quota.current).toBe(3);
    expect(quota.limit).toBe(3);
    expect(quota.requiredPlanDisplay).toBe("XL");
    expect(quota.feature).toBe("resources");
    expect(quota.retryAfter).toBeNull();
  });

  it("chooses the class from the gate before the code", async () => {
    // The gate and the code disagree here, so checking the code first
    // would give a KaguraFeatureNotAvailableError.
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "FEAT-001",
      message: "Connector seat limit reached.",
      details: { gate: "quota", quota_type: "connectors", current: 2, limit: 2 },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect((err as KaguraQuotaError).quotaType).toBe("connectors");
  });

  it("types a refusal by its gate when the code is none the SDK knows", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "HTTP-403",
      message: "Feature 'team_invitations' not available on M plan.",
      details: { gate: "plan", feature: "team_invitations", required_plan: "pro" },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect((err as KaguraFeatureNotAvailableError).feature).toBe("team_invitations");
  });

  it("maps a pre-v0.75 403 CONNECTOR-001 to KaguraQuotaError by its code", async () => {
    // v0.74 sent the connector seat cap with its own code and legacy counts.
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "CONNECTOR-001",
      message: "Connector seat limit reached. Your plan allows 2 connector(s).",
      details: { max_connectors: 2, active_connectors: 3 },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/connectors"));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    const quota = err as KaguraQuotaError;
    expect(quota.message).toBe("Connector seat limit reached. Your plan allows 2 connector(s).");
    expect(quota.gate).toBeNull();
    expect(quota.quotaType).toBeNull();
    // The legacy seat counts stand in for the canonical current / limit.
    expect(quota.current).toBe(3);
    expect(quota.limit).toBe(2);
  });

  it("reads the workspace cap's pre-v0.75 owned_count / cap as current / limit", async () => {
    const server = new FakeRest();
    server.status = 429;
    server.body = JSON.stringify({
      error: "QUOTA-001",
      message: "Workspace limit reached.",
      details: {
        quota_type: "workspace_limit_reached",
        owned_count: 1,
        cap: 3,
        tier: "free",
        next_tier: "basic",
      },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/workspaces"));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    const quota = err as KaguraQuotaError;
    expect(quota.quotaType).toBe("workspace_limit_reached");
    expect(quota.current).toBe(1);
    expect(quota.limit).toBe(3);
  });

  it("reads the analysis quota's pre-v0.75 used_today / limit_today as current / limit", async () => {
    const server = new FakeRest();
    server.status = 429;
    server.body = JSON.stringify({
      error: "QUOTA-001",
      message: "Analysis daily quota exceeded: 3/3 runs today (addon bonus 0).",
      details: { quota_type: "memory_analysis", used_today: 4, limit_today: 3 },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/analyses"));
    const quota = err as KaguraQuotaError;
    expect(quota).toBeInstanceOf(KaguraQuotaError);
    expect(quota.current).toBe(4);
    expect(quota.limit).toBe(3);
  });

  it("maps a pre-v0.75 429 QUOTA-001 by its code, with the payload", async () => {
    const server = new FakeRest();
    server.status = 429;
    server.body = JSON.stringify({
      error: "QUOTA-001",
      message: "Storage limit reached.",
      details: { quota_type: "storage_bytes", current: 1024, limit: 1024 },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    const quota = err as KaguraQuotaError;
    // The server's message and counts, not the bare 429's fixed text.
    expect(quota.message).toBe("Storage limit reached.");
    expect(quota.gate).toBeNull();
    expect(quota.quotaType).toBe("storage_bytes");
    expect(quota.current).toBe(1024);
    expect(quota.limit).toBe(1024);
  });

  it("maps a pre-v0.75 429 QUOTA-002 by its code, keeping the server's message", async () => {
    const server = new FakeRest();
    server.status = 429;
    server.body = JSON.stringify({
      error: "QUOTA-002",
      message: "Daily embedding spend cap reached.",
      details: { quota_type: "embedding_spend_daily" },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect((err as KaguraQuotaError).message).toBe("Daily embedding spend cap reached.");
    expect((err as KaguraQuotaError).quotaType).toBe("embedding_spend_daily");
  });

  it("keeps every 429 a KaguraQuotaError, even one whose body reads as a plan refusal", async () => {
    // No server sends this today, but a 429 has always been a quota here.
    const server = new FakeRest();
    server.status = 429;
    server.body = JSON.stringify({
      error: "FEAT-001",
      message: "Feature 'resources' not available on L plan.",
      details: { gate: "plan", feature: "resources" },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect(err).not.toBeInstanceOf(KaguraFeatureNotAvailableError);
  });

  it("scrubs a gate refusal's message carrying credential markers", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "FEAT-001",
      message: "Not on your plan. Echo: Authorization: Bearer kagura_leaked_key_value",
      details: { gate: "plan", feature: "resources" },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect((err as KaguraFeatureNotAvailableError).message).toBe("HTTP 403");
  });

  it("keeps a FEAT-001 behind an allowlist or deployment switch a KaguraFeatureNotAvailableError", async () => {
    // Pre-v0.75 servers send these as bare FEAT-001, so the class must not
    // change with the server version; `gate` says no upgrade will help.
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "FEAT-001",
      message: "Managed embeddings are disabled on this deployment.",
      details: { gate: "deployment", feature: "managed_embeddings", required_plan: null },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect((err as KaguraFeatureNotAvailableError).gate).toBe("deployment");
    expect((err as KaguraFeatureNotAvailableError).requiredPlan).toBeNull();
  });

  it("leaves a 403 that is no gate refusal on the generic mapping", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "AUTH-101",
      message: "Insufficient permissions",
      details: {},
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("GET", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraConnectionError);
    expect((err as KaguraConnectionError).message).toBe("HTTP 403: Insufficient permissions");
  });

  it("carries the gate payload on a 429 QUOTA-001", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T23:59:00Z"));
    try {
      const server = new FakeRest();
      server.status = 429;
      server.body = JSON.stringify({
        error: "QUOTA-001",
        message: "Daily analysis quota reached.",
        details: {
          gate: "quota",
          quota_type: "memory_analysis",
          current: 5,
          limit: 5,
          used_today: 5,
          resets_at: "2026-09-24T00:00:00Z",
        },
      });
      const probe = makeProbe(server);

      const err = await caught(probe.requestPublic("POST", "/api/v1/things"));
      expect(err).toBeInstanceOf(KaguraQuotaError);
      const quota = err as KaguraQuotaError;
      expect(quota.message).toBe("Daily analysis quota reached.");
      expect(quota.quotaType).toBe("memory_analysis");
      expect(quota.usedToday).toBe(5);
      // No Retry-After header, so the wait comes from resets_at.
      expect(quota.retryAfter).toBe(60);

      // A Retry-After header, when sent, wins over resets_at.
      server.responseHeaders = { "Retry-After": "5" };
      const withHeader = await caught(probe.requestPublic("POST", "/api/v1/things"));
      expect((withHeader as KaguraQuotaError).retryAfter).toBe(5);
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps a RATE-001 body's message and reads its details.retry_after with no header", async () => {
    // The resource events-per-hour quota: a 429 RATE-001 whose only retry
    // hint is in the body.
    const server = new FakeRest();
    server.status = 429;
    server.body = JSON.stringify({
      error: "RATE-001",
      message: "Event quota exceeded: 10/10 events per hour",
      details: { retry_after: 3600 },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/resources/r/events"));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    const quota = err as KaguraQuotaError;
    expect(quota.message).toBe("Event quota exceeded: 10/10 events per hour");
    expect(quota.retryAfter).toBe(3600);
    // Not a typed cap: no gate payload is read from it.
    expect(quota.gate).toBeNull();
    expect(quota.limit).toBeNull();

    // A Retry-After header, when sent, wins over the body.
    server.responseHeaders = { "Retry-After": "60" };
    const withHeader = await caught(probe.requestPublic("POST", "/api/v1/resources/r/events"));
    expect((withHeader as KaguraQuotaError).retryAfter).toBe(60);
  });

  it("scrubs a RATE-001 message carrying credential markers back to the fixed text", async () => {
    const server = new FakeRest();
    server.status = 429;
    server.body = JSON.stringify({
      error: "RATE-001",
      message: "Slow down. Echo: Authorization: Bearer kagura_leaked_key_value",
      details: { retry_after: 60 },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("POST", "/api/v1/things"));
    expect((err as KaguraQuotaError).message).toBe("Quota exceeded. Try again later.");
    expect((err as KaguraQuotaError).retryAfter).toBe(60);
  });

  it("reads details.retry_after on a typed 429 that sent no Retry-After", async () => {
    const server = new FakeRest();
    server.status = 429;
    server.body = JSON.stringify({
      error: "QUOTA-001",
      message: "Daily REST quota exceeded.",
      details: { gate: "quota", quota_type: "api_rest_daily", retry_after: 86400 },
    });
    const probe = makeProbe(server);

    const err = await caught(probe.requestPublic("GET", "/api/v1/things"));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect((err as KaguraQuotaError).retryAfter).toBe(86400);
  });

  it("ignores a negative or non-numeric details.retry_after", async () => {
    const server = new FakeRest();
    server.status = 429;
    const probe = makeProbe(server);
    for (const retryAfter of [-5, "3600", null]) {
      server.body = JSON.stringify({
        error: "RATE-001",
        message: "Too many requests.",
        details: { retry_after: retryAfter },
      });
      const err = await caught(probe.requestPublic("GET", "/api/v1/things"));
      expect((err as KaguraQuotaError).retryAfter).toBeNull();
    }
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

  it("drops the MCP URL's query from the derived base URL (#38)", async () => {
    const server = new FakeRest();
    const client = ProbeClient.fromMcpUrl({
      apiKey: "k",
      mcpUrl: "https://x.test/mcp?tools=recall&guardrails=off",
      fetch: server.fetch,
      env: {},
    });

    expect(client.baseUrl).toBe("https://x.test");
    await client.requestPublic("GET", "/api/v1/things");
    expect(server.requests[0]!.url).toBe("https://x.test/api/v1/things");
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
