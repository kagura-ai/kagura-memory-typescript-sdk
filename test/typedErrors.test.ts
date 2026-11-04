/**
 * The server's error envelope, the Free capacity lock, OAuth scopes and
 * 503s (#84; the Python SDK's #299 part 1, `tests/test_typed_errors.py`).
 *
 * Fixtures use the bodies memory-cloud v0.143.0 sends: the MCP tool-error
 * envelope (`mcp_server/tools/_errors.py`), the `/mcp` transport's JSON-RPC
 * errors and its OAuth-style 503 (`mcp_server/transport.py`), and the REST
 * `{error, message, details}` envelope (`api/main.py`). No assertion reads
 * a message to decide the class: each checks the class, `code` and
 * `details`.
 */

import { describe, expect, it } from "vitest";

import type { KaguraClient } from "../src/client.js";
import {
  KaguraAuthError,
  KaguraCapacityLockedError,
  KaguraConnectionError,
  KaguraError,
  KaguraFeatureNotAvailableError,
  KaguraNotFoundError,
  KaguraQuotaError,
  KaguraResponseError,
  KaguraServiceUnavailableError,
} from "../src/errors.js";
import {
  annotateServerError,
  insufficientScopeError,
  serverErrorFields,
  serviceUnavailableError,
} from "../src/http.js";
import { KaguraRestClient } from "../src/restBase.js";
import type { HttpMethod, RestResponse } from "../src/restBase.js";
import { SecretClient } from "../src/secrets/client.js";
import { WorkspaceClient } from "../src/workspaceClient.js";
import { FakeRest, FakeServer, makeClient } from "./fakeServer.js";

// ---------------------------------------------------------------------------
// Fixtures: what the server sends
// ---------------------------------------------------------------------------

const CLEANUP_URL = "https://memory.kagura-ai.com/workspace/settings/plan";
const WORKSPACE = "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c";

/** `CapacityLockedError.details` (services/capacity_lock.py `CapacityLock.as_dict`). */
const LOCK_FIGURES = {
  memory_count: 1250,
  memory_limit: 1000,
  over_memories: 250,
  used_bytes: 0,
  storage_limit_bytes: 104857600,
  over_bytes: 0,
  cleanup_url: CLEANUP_URL,
};

const LOCK_MESSAGE =
  "This workspace is over the Free plan's capacity (250 memories over). Search and saving " +
  "are paused until it is cleaned up or re-subscribed; listing, deleting and export still work.";

const LOCK_HELP =
  `Remove 250 memories or re-subscribe at ${CLEANUP_URL}. Until then you can still call list, ` +
  "list_contexts and get_usage, delete with forget, delete_context (which frees the context's " +
  "files too) or delete_file, clear a context's files in bulk from the web UI's storage page, " +
  "and export a context from the web UI.";

/** MCP `capacity_locked` (`_refusal`: the details without nulls, plus `help`). */
const MCP_CAPACITY_LOCKED = {
  status: "error",
  error: "capacity_locked",
  message: LOCK_MESSAGE,
  gate: "capacity",
  ...LOCK_FIGURES,
  help: LOCK_HELP,
};

/** REST `403 CAPACITY-001` (`memory_cloud_exception_handler`). */
const REST_CAPACITY_LOCKED = {
  error: "CAPACITY-001",
  message: LOCK_MESSAGE,
  details: { gate: "capacity", ...LOCK_FIGURES },
};

/** The refusal for a caller outside the locked workspace: every figure `null` on REST. */
const REST_CAPACITY_LOCKED_OUTSIDER = {
  error: "CAPACITY-001",
  message:
    "The workspace that owns this context is over its plan's capacity. Search and saving are " +
    "paused until its owner cleans it up or re-subscribes.",
  details: {
    gate: "capacity",
    memory_count: null,
    memory_limit: null,
    over_memories: null,
    used_bytes: null,
    storage_limit_bytes: null,
    over_bytes: null,
    cleanup_url: null,
  },
};

/** MCP `payload_too_large` (memory-cloud v0.108.0+, #2003). */
const MCP_PAYLOAD_TOO_LARGE = {
  status: "error",
  error: "payload_too_large",
  message:
    "Memory size 1,200,000 characters exceeds limit 1,000,000 characters (1 MB). " +
    "Split the material into several memories.",
  limit: 1_000_000,
  actual: 1_200_000,
  help:
    "One memory holds up to 1,000,000 characters across summary, context_summary, content " +
    "and details. Split long material into several memories, one topic each, and keep the " +
    "summary to one or two sentences.",
};

/** A write that failed on the server side with an unknown outcome (v0.82.0+, #1742). */
const MCP_WRITE_FAILURE = {
  status: "error",
  error: "remember_error",
  message: "remember could not reach a service it depends on (database, search index, file storage or model provider).",
  cause: "service_unavailable",
  help:
    "This tool changes data, and the change may or may not have been applied. Check with " +
    "recall before calling it again, so it is not applied twice. If it keeps failing, report " +
    "the correlation_id.",
  correlation_id: "4bf92f3577b34da6a3ce929d0e0e4736",
  retryable: false,
  outcome: "unknown",
};

/** `FEAT-001` `members` for a member without a seat (v0.100.0+, #1943). */
const FEAT_MEMBERS_DETAILS = {
  gate: "plan",
  feature: "members",
  current_plan: "free",
  required_plan: "basic",
  required_plan_display: "M",
  limit: 1,
  current: 3,
};

/** `/mcp`'s 403 for a tool the OAuth token lacks the scope of (v0.79.0+, #1686). */
function mcpInsufficientScope(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: -32001,
        message:
          "remember needs the OAuth scope memory:write, which this connection's authorization does not grant.",
        data: {
          error: "insufficient_scope",
          required_scope: "memory:write",
          help:
            "Reconnect this server in your MCP client and approve access that includes " +
            "memory:write, then call the tool again. Tools the current authorization covers keep working.",
        },
      },
    }),
    {
      status: 403,
      headers: {
        "WWW-Authenticate":
          'Bearer error="insufficient_scope", error_description="This tool needs the memory:write scope", ' +
          'scope="memory:read memory:write"',
      },
    },
  );
}

/** `/mcp`'s 503 when the credential could not be verified (v0.82.0+, #1742). */
function mcpAuthUnavailable(): Response {
  return new Response(
    JSON.stringify({
      error: "temporarily_unavailable",
      error_description: "Could not verify credentials right now; retry shortly.",
      correlation_id: "a1b2c3d4e5f60718",
    }),
    { status: 503, headers: { "retry-after": "5" } },
  );
}

/** `/mcp`'s JSON-RPC transport failure: a dependency down, a read (safe to repeat). */
function mcpTransportFailure(data: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32603, message: "The tool call could not reach a service it depends on.", data },
    }),
    { status: 503, headers },
  );
}

/** REST `503 DB-002` (`_database_unavailable_response`, reasons from v0.104.0). */
function restDbUnavailable(reason: string): Response {
  return new Response(
    JSON.stringify({ error: "DB-002", message: "Database connection failed", details: { reason } }),
    { status: 503, headers: { "Retry-After": "5" } },
  );
}

/** A FakeServer whose `tools/call` answers `reply()`; the handshake still succeeds. */
function failingToolCall(reply: () => Response): FakeServer {
  const server = new FakeServer();
  const answer = server.fetch;
  server.fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const response = await answer(input, init);
    return body?.method === "tools/call" ? reply() : response;
  };
  return server;
}

async function rejection(call: Promise<unknown>): Promise<KaguraError> {
  return call.then(
    () => {
      throw new Error("expected the call to reject");
    },
    (e: unknown) => e as KaguraError,
  );
}

function remember(client: KaguraClient): Promise<unknown> {
  return client.remember({ contextId: "c", summary: "s", content: "x" });
}

/** Exposes the REST spine for direct testing. */
class ProbeClient extends KaguraRestClient {
  get(path: string, method: HttpMethod = "GET"): Promise<RestResponse> {
    return this.request(method, path);
  }
}

function restAnswering(status: number, body: unknown, headers: Record<string, string> = {}): FakeRest {
  const rest = new FakeRest();
  rest.status = status;
  rest.body = typeof body === "string" ? body : JSON.stringify(body);
  rest.responseHeaders = headers;
  return rest;
}

function probe(rest: FakeRest): ProbeClient {
  return new ProbeClient({ apiKey: "kagura_test", baseUrl: "https://x.test", fetch: rest.fetch });
}

// ---------------------------------------------------------------------------
// The classes
// ---------------------------------------------------------------------------

describe("KaguraError keeps what the server sent", () => {
  it("has no code and empty details when the SDK raised it itself", () => {
    const e = new KaguraError("boom");
    expect(e.code).toBeUndefined();
    expect(e.details).toEqual({});
    expect([e.help, e.serverCause, e.correlationId, e.retryable, e.outcome]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("reads the envelope fields from details", () => {
    const e = new KaguraError("remember failed", {
      code: "remember_error",
      details: {
        cause: "timeout",
        help: "Check with recall.",
        correlation_id: "abc",
        retryable: false,
        outcome: "unknown",
      },
    });
    expect(e.code).toBe("remember_error");
    expect(e.help).toBe("Check with recall.");
    expect(e.serverCause).toBe("timeout");
    expect(e.correlationId).toBe("abc");
    expect(e.retryable).toBe(false);
    expect(e.outcome).toBe("unknown");
  });

  it("reads a field of the wrong type as null, as Python's properties do", () => {
    const e = new KaguraError("x", {
      details: { help: 1, cause: null, correlation_id: ["a"], retryable: "yes", outcome: {} },
    });
    expect([e.help, e.serverCause, e.correlationId, e.retryable, e.outcome]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("copies details rather than aliasing the caller's object", () => {
    const details: Record<string, unknown> = { help: "a" };
    const e = new KaguraError("x", { details });
    details.help = "b";
    expect(e.help).toBe("a");
  });

  it("keeps Error.cause for the chained error, beside the server's cause", () => {
    const root = new TypeError("fetch failed");
    const e = new KaguraConnectionError("Connection failed", {
      cause: root,
      details: { cause: "service_unavailable" },
    });
    expect(e.cause).toBe(root);
    expect(e.serverCause).toBe("service_unavailable");
  });

  it("is passed through every subclass's options", () => {
    const quota = new KaguraQuotaError("q", null, { code: "QUOTA-001", details: { limit: 3 } });
    expect([quota.code, quota.details]).toEqual(["QUOTA-001", { limit: 3 }]);
    const feature = new KaguraFeatureNotAvailableError("f", { code: "FEAT-001" });
    expect(feature.code).toBe("FEAT-001");
  });
});

describe("KaguraServiceUnavailableError", () => {
  it("is a KaguraConnectionError, so existing handlers keep catching it", () => {
    const e = new KaguraServiceUnavailableError("HTTP 503", { retryAfter: 5, reason: "pool_exhausted" });
    expect(e).toBeInstanceOf(KaguraConnectionError);
    expect(e).toBeInstanceOf(KaguraError);
    expect(e.name).toBe("KaguraServiceUnavailableError");
    expect([e.retryAfter, e.reason]).toEqual([5, "pool_exhausted"]);
  });

  it("defaults retryAfter and reason to null", () => {
    const e = new KaguraServiceUnavailableError("HTTP 503");
    expect([e.retryAfter, e.reason, e.code]).toEqual([null, null, undefined]);
  });
});

describe("KaguraCapacityLockedError", () => {
  it("is neither a quota nor a plan gate", () => {
    const e = new KaguraCapacityLockedError("locked");
    expect(e).toBeInstanceOf(KaguraError);
    expect(e).not.toBeInstanceOf(KaguraQuotaError);
    expect(e).not.toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect(e).not.toBeInstanceOf(KaguraConnectionError);
    expect(e.name).toBe("KaguraCapacityLockedError");
  });

  it("carries the overage figures, null when not given", () => {
    const e = new KaguraCapacityLockedError("locked", { cleanupUrl: CLEANUP_URL, overMemories: 250 });
    expect(e.gate).toBe("capacity");
    expect(e.cleanupUrl).toBe(CLEANUP_URL);
    expect(e.overMemories).toBe(250);
    expect([e.memoryCount, e.memoryLimit, e.usedBytes, e.storageLimitBytes, e.overBytes]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The shared readers
// ---------------------------------------------------------------------------

describe("serverErrorFields", () => {
  it("reads the REST envelope's details", () => {
    expect(serverErrorFields(JSON.stringify(REST_CAPACITY_LOCKED))).toEqual([
      "CAPACITY-001",
      REST_CAPACITY_LOCKED.details,
    ]);
  });

  it("reads a JSON-RPC error's data", async () => {
    const text = await mcpInsufficientScope().text();
    const [code, fields] = serverErrorFields(text)!;
    expect(code).toBe("insufficient_scope");
    expect(fields.required_scope).toBe("memory:write");
  });

  it("reads an OAuth-style body without its error", async () => {
    expect(serverErrorFields(await mcpAuthUnavailable().text())).toEqual([
      "temporarily_unavailable",
      {
        error_description: "Could not verify credentials right now; retry shortly.",
        correlation_id: "a1b2c3d4e5f60718",
      },
    ]);
  });

  it.each([
    ["not JSON", "<html>"],
    ["a FastAPI detail", '{"detail": "Not Found"}'],
    ["a JSON-RPC error without data.error", '{"jsonrpc":"2.0","error":{"code":-32603,"message":"x"}}'],
    ["a list", "[1]"],
  ])("is null for %s", (_label, text) => {
    expect(serverErrorFields(text)).toBeNull();
  });
});

describe("annotateServerError", () => {
  it("sets the code and the fields without the envelope's frame", () => {
    const e = annotateServerError(new KaguraError("x"), "payload_too_large", MCP_PAYLOAD_TOO_LARGE);
    expect(e.code).toBe("payload_too_large");
    expect(e.details).toEqual({ limit: 1_000_000, actual: 1_200_000, help: MCP_PAYLOAD_TOO_LARGE.help });
  });

  it("keeps a code and details the error already has", () => {
    const e = new KaguraError("x", { code: "context_not_found", details: { a: 1 } });
    annotateServerError(e, "HTTP-404", { b: 2 });
    expect([e.code, e.details]).toEqual(["context_not_found", { a: 1 }]);
  });
});

describe("insufficientScopeError", () => {
  it("names data.required_scope over the challenge's granted-plus-required scope", async () => {
    const response = mcpInsufficientScope();
    const e = insufficientScopeError(response.headers, await response.text())!;
    expect(e).toBeInstanceOf(KaguraAuthError);
    expect(e.code).toBe("insufficient_scope");
    expect(e.details.required_scope).toBe("memory:write");
    expect(e.help).toMatch(/^Reconnect this server/);
    expect(e.message).toBe(
      "The OAuth sign-in lacks the memory:write scope this call needs (HTTP 403 insufficient_scope). " +
        "Run `kagura-memory auth login` to sign in again with it; a `--read-only` login grants memory:read only.",
    );
  });

  it("reads the REST challenge's scope when the body names none", () => {
    const headers = new Headers({ "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="memory:write"' });
    const body = JSON.stringify({ error: "HTTP-403", message: "Insufficient scope: 'memory:write' required", details: {} });
    const e = insufficientScopeError(headers, body)!;
    expect(e.code).toBe("insufficient_scope");
    expect(e.details).toEqual({ required_scope: "memory:write" });
  });

  it("finds the Bearer challenge after another scheme's", () => {
    const headers = new Headers({
      "WWW-Authenticate": 'Basic realm="proxy", Bearer error="insufficient_scope", scope="memory:read"',
    });
    expect(insufficientScopeError(headers, "")?.details.required_scope).toBe("memory:read");
  });

  it("unescapes a quoted-pair and reads a bare token value", () => {
    const headers = new Headers({ "WWW-Authenticate": 'Bearer error=insufficient_scope, scope="memory:\\"x\\""' });
    expect(insufficientScopeError(headers, "")?.details.required_scope).toBe('memory:"x"');
  });

  it("says 'a scope' when nothing names it", () => {
    const headers = new Headers({ "WWW-Authenticate": 'Bearer error="insufficient_scope"' });
    const e = insufficientScopeError(headers, "")!;
    expect(e.message).toMatch(/^The OAuth sign-in lacks a scope this call needs/);
    expect(e.details).toEqual({});
  });

  it("is null for any other 403", () => {
    const headers = new Headers({ "WWW-Authenticate": 'Bearer error="invalid_token"' });
    expect(insufficientScopeError(headers, JSON.stringify(REST_CAPACITY_LOCKED))).toBeNull();
    expect(insufficientScopeError(new Headers(), "")).toBeNull();
  });
});

describe("serviceUnavailableError", () => {
  it("takes Retry-After from the header and the reason from details.reason", async () => {
    const response = restDbUnavailable("pool_exhausted");
    const e = serviceUnavailableError(response.headers, "HTTP 503: Database connection failed", await response.text());
    expect([e.retryAfter, e.reason, e.code]).toEqual([5, "pool_exhausted", "DB-002"]);
    expect(e.details).toEqual({ reason: "pool_exhausted" });
  });

  it("falls back to data.retry_after_seconds and the MCP cause", async () => {
    const response = mcpTransportFailure({
      error: "service_unavailable",
      cause: "service_unavailable",
      retryable: true,
      retry_after_seconds: 5,
      correlation_id: "c1",
    });
    const e = serviceUnavailableError(response.headers, "HTTP 503", await response.text());
    expect([e.retryAfter, e.reason, e.code, e.correlationId]).toEqual([5, "service_unavailable", "service_unavailable", "c1"]);
  });

  it("falls back to the code as the reason", async () => {
    const response = mcpAuthUnavailable();
    const e = serviceUnavailableError(response.headers, "HTTP 503", await response.text());
    expect([e.retryAfter, e.reason]).toEqual([5, "temporarily_unavailable"]);
  });

  it("has no wait and no reason for a body that names nothing", () => {
    const e = serviceUnavailableError(new Headers(), "HTTP 503", "<html>");
    expect([e.retryAfter, e.reason, e.code]).toEqual([null, null, undefined]);
  });

  it.each(["-1", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT"])("ignores a Retry-After of %j", (value) => {
    const e = serviceUnavailableError(new Headers({ "Retry-After": value }), "HTTP 503", "");
    expect(e.retryAfter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MCP: the tool-error envelope
// ---------------------------------------------------------------------------

describe("MCP envelope → class", () => {
  it("capacity_locked → KaguraCapacityLockedError with the figures (v0.99.0+)", async () => {
    const server = new FakeServer();
    server.toolResults.remember = MCP_CAPACITY_LOCKED;
    const e = (await rejection(remember(makeClient(server)))) as KaguraCapacityLockedError;
    expect(e).toBeInstanceOf(KaguraCapacityLockedError);
    expect(e.message).toBe(`remember failed (capacity_locked): ${LOCK_MESSAGE}`);
    expect(e.code).toBe("capacity_locked");
    expect(e.gate).toBe("capacity");
    expect(e.cleanupUrl).toBe(CLEANUP_URL);
    expect([e.memoryCount, e.memoryLimit, e.overMemories]).toEqual([1250, 1000, 250]);
    expect([e.usedBytes, e.storageLimitBytes, e.overBytes]).toEqual([0, 104857600, 0]);
    expect(e.help).toBe(LOCK_HELP);
    expect(e.details).toEqual({ gate: "capacity", ...LOCK_FIGURES, help: LOCK_HELP });
  });

  it("capacity_locked from an outsider has no figures (MCP omits the nulls)", async () => {
    const server = new FakeServer();
    server.toolResults.recall = {
      status: "error",
      error: "capacity_locked",
      message: REST_CAPACITY_LOCKED_OUTSIDER.message,
      gate: "capacity",
      help: "This context belongs to a workspace you do not manage; ask its owner, or work in your own workspace's contexts.",
    };
    const e = (await rejection(makeClient(server).recall({ contextId: "c", query: "q" }))) as KaguraCapacityLockedError;
    expect(e).toBeInstanceOf(KaguraCapacityLockedError);
    expect([e.cleanupUrl, e.memoryCount, e.overMemories, e.overBytes]).toEqual([null, null, null, null]);
  });

  it("a capacity figure of the wrong type reads null, the error stays typed", async () => {
    const server = new FakeServer();
    server.toolResults.remember = { ...MCP_CAPACITY_LOCKED, over_memories: "250", memory_count: 12.5, cleanup_url: 7 };
    const e = (await rejection(remember(makeClient(server)))) as KaguraCapacityLockedError;
    expect(e).toBeInstanceOf(KaguraCapacityLockedError);
    expect([e.overMemories, e.memoryCount, e.cleanupUrl]).toEqual([null, null, null]);
    expect(e.details.over_memories).toBe("250");
  });

  it("payload_too_large is a plain KaguraError with limit / actual (v0.108.0+)", async () => {
    const server = new FakeServer();
    server.toolResults.remember = MCP_PAYLOAD_TOO_LARGE;
    const e = await rejection(remember(makeClient(server)));
    expect(e.constructor).toBe(KaguraError);
    expect(e).not.toBeInstanceOf(KaguraQuotaError);
    expect(e.code).toBe("payload_too_large");
    expect(e.details.limit).toBe(1_000_000);
    expect(e.details.actual).toBe(1_200_000);
    expect(e.help).toBe(MCP_PAYLOAD_TOO_LARGE.help);
  });

  it("a server failure keeps cause, correlation_id, retryable and outcome (v0.82.0+)", async () => {
    const server = new FakeServer();
    server.toolResults.remember = MCP_WRITE_FAILURE;
    const e = await rejection(remember(makeClient(server)));
    expect(e.constructor).toBe(KaguraError);
    expect(e.code).toBe("remember_error");
    expect(e.serverCause).toBe("service_unavailable");
    expect(e.correlationId).toBe(MCP_WRITE_FAILURE.correlation_id);
    expect(e.retryable).toBe(false);
    expect(e.outcome).toBe("unknown");
    expect(e.help).toBe(MCP_WRITE_FAILURE.help);
  });

  it("feature_not_available names the feature the plan dropped (v0.100.0+)", async () => {
    const server = new FakeServer();
    server.toolResults.remember = {
      status: "error",
      error: "feature_not_available",
      message: "This context is paused on the Free plan.",
      ...FEAT_MEMBERS_DETAILS,
      feature: "contexts",
      help: "This feature is not enabled for the workspace; the response says which plan or switch it needs.",
    };
    const e = (await rejection(remember(makeClient(server)))) as KaguraFeatureNotAvailableError;
    expect(e).toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect(e.feature).toBe("contexts");
    expect(e.code).toBe("feature_not_available");
    expect([e.details.limit, e.details.current]).toEqual([1, 3]);
  });

  it("a not-found keeps its code and help too", async () => {
    const server = new FakeServer();
    server.toolResults.recall = {
      status: "error",
      error: "context_not_found",
      message: "Context not found",
      help: "Check the id.",
    };
    const e = await rejection(makeClient(server).recall({ contextId: "c", query: "q" }));
    expect(e).toBeInstanceOf(KaguraNotFoundError);
    expect([e.code, e.details]).toEqual(["context_not_found", { help: "Check the id." }]);
  });

  it("a quota keeps the envelope as details", async () => {
    const server = new FakeServer();
    server.toolResults.remember = {
      status: "error",
      error: "quota_exceeded",
      message: "Daily memory limit reached (100/day).",
      gate: "quota",
      quota_type: "memories_per_day",
      current: 100,
      limit: 100,
    };
    const e = await rejection(remember(makeClient(server)));
    expect(e).toBeInstanceOf(KaguraQuotaError);
    expect(e.code).toBe("quota_exceeded");
    expect(e.details).toEqual({ gate: "quota", quota_type: "memories_per_day", current: 100, limit: 100 });
  });
});

// ---------------------------------------------------------------------------
// MCP: the /mcp transport's HTTP errors
// ---------------------------------------------------------------------------

describe("/mcp HTTP status → class", () => {
  it("403 insufficient_scope → KaguraAuthError naming the scope (v0.79.0+)", async () => {
    const e = await rejection(remember(makeClient(failingToolCall(mcpInsufficientScope))));
    expect(e).toBeInstanceOf(KaguraAuthError);
    expect(e.code).toBe("insufficient_scope");
    expect(e.details.required_scope).toBe("memory:write");
    expect(e.message).toContain("the memory:write scope");
  });

  it("a 403 that is no scope refusal stays a connection error", async () => {
    const forbidden = () =>
      new Response(JSON.stringify({ error: "access_denied", error_description: "You are not a member of this workspace." }), {
        status: 403,
      });
    const e = await rejection(remember(makeClient(failingToolCall(forbidden))));
    expect(e).toBeInstanceOf(KaguraConnectionError);
    expect(e).not.toBeInstanceOf(KaguraServiceUnavailableError);
    expect([e.code, e.details]).toEqual([
      "access_denied",
      { error_description: "You are not a member of this workspace." },
    ]);
  });

  it("503 temporarily_unavailable → KaguraServiceUnavailableError (v0.82.0+)", async () => {
    const e = (await rejection(remember(makeClient(failingToolCall(mcpAuthUnavailable))))) as KaguraServiceUnavailableError;
    expect(e).toBeInstanceOf(KaguraServiceUnavailableError);
    expect(e).toBeInstanceOf(KaguraConnectionError);
    expect(e.message).toBe("HTTP 503: Could not verify credentials right now; retry shortly.");
    expect([e.retryAfter, e.reason, e.code, e.correlationId]).toEqual([
      5,
      "temporarily_unavailable",
      "temporarily_unavailable",
      "a1b2c3d4e5f60718",
    ]);
  });

  it("the same 503 on the initialize handshake is typed too", async () => {
    const server = new FakeServer();
    server.forcedResponse = mcpAuthUnavailable();
    const e = await rejection(remember(makeClient(server)));
    expect(e).toBeInstanceOf(KaguraServiceUnavailableError);
  });

  it("503 transport failure on a read: retry window from data, reason from cause", async () => {
    const data = {
      error: "service_unavailable",
      cause: "service_unavailable",
      help: "This tool only reads, so calling it again is safe.",
      correlation_id: "c2",
      retryable: true,
      retry_after_seconds: 5,
    };
    const e = (await rejection(
      makeClient(failingToolCall(() => mcpTransportFailure(data, { "retry-after": "5" }))).recall({
        contextId: "c",
        query: "q",
      }),
    )) as KaguraServiceUnavailableError;
    expect([e.retryAfter, e.reason, e.code, e.retryable]).toEqual([5, "service_unavailable", "service_unavailable", true]);
  });

  it("503 transport failure on a write: no retry window, outcome unknown", async () => {
    const data = {
      error: "timeout",
      cause: "timeout",
      help: "This tool changes data, and the change may or may not have been applied.",
      correlation_id: "c3",
      retryable: false,
      outcome: "unknown",
    };
    const e = (await rejection(remember(makeClient(failingToolCall(() => mcpTransportFailure(data)))))) as KaguraServiceUnavailableError;
    expect(e).toBeInstanceOf(KaguraServiceUnavailableError);
    expect([e.retryAfter, e.reason, e.retryable, e.outcome]).toEqual([null, "timeout", false, "unknown"]);
  });

  it("500 internal_error stays a KaguraConnectionError with the envelope", async () => {
    const internal = () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          error: {
            code: -32603,
            message: "The tool call failed because of an unexpected server error.",
            data: { error: "internal_error", cause: "internal_error", correlation_id: "c4", retryable: false, outcome: "unknown" },
          },
        }),
        { status: 500 },
      );
    const e = await rejection(remember(makeClient(failingToolCall(internal))));
    expect(e.constructor).toBe(KaguraConnectionError);
    expect([e.code, e.serverCause, e.correlationId]).toEqual(["internal_error", "internal_error", "c4"]);
  });
});

// ---------------------------------------------------------------------------
// KaguraClient's REST reads
// ---------------------------------------------------------------------------

describe("KaguraClient REST reads → class", () => {
  function restFailing(response: () => Response): FakeServer {
    const server = new FakeServer();
    server.forcedResponse = null;
    server.fetch = async () => response();
    return server;
  }

  it("503 DB-002 → KaguraServiceUnavailableError with the reason", async () => {
    const e = (await rejection(
      makeClient(restFailing(() => restDbUnavailable("connection_refused"))).getEmbeddingStatus(),
    )) as KaguraServiceUnavailableError;
    expect(e).toBeInstanceOf(KaguraServiceUnavailableError);
    expect(e.message).toBe("HTTP 503: Database connection failed");
    expect([e.retryAfter, e.reason, e.code]).toEqual([5, "connection_refused", "DB-002"]);
  });

  it("403 insufficient_scope → KaguraAuthError naming the challenge's scope", async () => {
    const response = () =>
      new Response(JSON.stringify({ error: "HTTP-403", message: "Insufficient scope: 'memory:read' required", details: {} }), {
        status: 403,
        headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="memory:read"' },
      });
    const e = await rejection(makeClient(restFailing(response)).getEmbeddingStatus());
    expect(e).toBeInstanceOf(KaguraAuthError);
    expect([e.code, e.details]).toEqual(["insufficient_scope", { required_scope: "memory:read" }]);
  });

  it("a 404 remapped to the MCP tool's error keeps that code and the REST fields", async () => {
    const response = () =>
      new Response(JSON.stringify({ error: "RES-001", message: "Context not found", details: { context_id: "c" } }), {
        status: 404,
      });
    // The listTags drill-down stands in for MCP list_tags over REST.
    const e = await rejection(makeClient(restFailing(response)).listTags({ contextId: "c", withTags: ["a"] }));
    expect(e).toBeInstanceOf(KaguraNotFoundError);
    expect(e.message).toBe("list_tags: Context not found");
    expect([e.code, e.details]).toEqual(["context_not_found", { context_id: "c" }]);
  });
});

// ---------------------------------------------------------------------------
// REST clients
// ---------------------------------------------------------------------------

describe("REST status → class", () => {
  it("403 CAPACITY-001 → KaguraCapacityLockedError (v0.99.0+)", async () => {
    const e = (await rejection(probe(restAnswering(403, REST_CAPACITY_LOCKED)).get("/api/v1/memory"))) as KaguraCapacityLockedError;
    expect(e).toBeInstanceOf(KaguraCapacityLockedError);
    expect(e.message).toBe(LOCK_MESSAGE);
    expect(e.code).toBe("CAPACITY-001");
    expect(e.details).toEqual(REST_CAPACITY_LOCKED.details);
    expect([e.cleanupUrl, e.overMemories, e.storageLimitBytes]).toEqual([CLEANUP_URL, 250, 104857600]);
    expect(e.help).toBeNull();
  });

  it("an outsider's CAPACITY-001 has every figure null", async () => {
    const e = (await rejection(
      probe(restAnswering(403, REST_CAPACITY_LOCKED_OUTSIDER)).get("/api/v1/memory"),
    )) as KaguraCapacityLockedError;
    expect(e).toBeInstanceOf(KaguraCapacityLockedError);
    expect([e.cleanupUrl, e.memoryCount, e.overMemories, e.overBytes]).toEqual([null, null, null, null]);
  });

  it("CAPACITY-001 is typed by the gate even without the code", async () => {
    const body = { ...REST_CAPACITY_LOCKED, error: "HTTP-403" };
    const e = await rejection(probe(restAnswering(403, body)).get("/api/v1/memory"));
    expect(e).toBeInstanceOf(KaguraCapacityLockedError);
    expect(e.code).toBe("HTTP-403");
  });

  it("CAPACITY-001 beats a client's own 403 hook", async () => {
    const rest = restAnswering(403, REST_CAPACITY_LOCKED);
    const client = new WorkspaceClient({ apiKey: "kagura_test", baseUrl: "https://x.test", fetch: rest.fetch });
    const e = await rejection(client.listMembers(WORKSPACE));
    expect(e).toBeInstanceOf(KaguraCapacityLockedError);
  });

  it("403 FEAT-001 members → KaguraFeatureNotAvailableError with feature (v0.100.0+)", async () => {
    const body = { error: "FEAT-001", message: "Your seat is paused on the Free plan.", details: FEAT_MEMBERS_DETAILS };
    const rest = restAnswering(403, body);
    const client = new WorkspaceClient({ apiKey: "kagura_test", baseUrl: "https://x.test", fetch: rest.fetch });
    const e = (await rejection(client.listMembers(WORKSPACE))) as KaguraFeatureNotAvailableError;
    expect(e).toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect(e.feature).toBe("members");
    expect(e.code).toBe("FEAT-001");
    expect([e.details.limit, e.details.current]).toEqual([1, 3]);
  });

  it("403 insufficient_scope → KaguraAuthError, before any client's 403 hook (v0.79.0+)", async () => {
    const body = { error: "HTTP-403", message: "Insufficient scope: 'memory:write' required", details: {} };
    const headers = { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="memory:write"' };
    for (const make of [
      (rest: FakeRest) => new WorkspaceClient({ apiKey: "k", baseUrl: "https://x.test", fetch: rest.fetch }).listMembers(WORKSPACE),
      (rest: FakeRest) => new SecretClient({ apiKey: "k", baseUrl: "https://x.test", fetch: rest.fetch }).listSecrets(),
      (rest: FakeRest) => probe(rest).get("/api/v1/memory", "POST"),
    ]) {
      const e = await rejection(make(restAnswering(403, body, headers)));
      expect(e).toBeInstanceOf(KaguraAuthError);
      expect([e.code, e.details]).toEqual(["insufficient_scope", { required_scope: "memory:write" }]);
    }
  });

  it.each(["pool_exhausted", "connection_refused", "deadlock", "database_error"])(
    "503 DB-002 %s → KaguraServiceUnavailableError (v0.104.0+)",
    async (reason) => {
      const rest = new FakeRest();
      const response = restDbUnavailable(reason);
      rest.status = 503;
      rest.body = await response.text();
      rest.responseHeaders = { "Retry-After": "5" };
      const e = (await rejection(probe(rest).get("/api/v1/memory"))) as KaguraServiceUnavailableError;
      expect(e).toBeInstanceOf(KaguraServiceUnavailableError);
      expect(e).toBeInstanceOf(KaguraConnectionError);
      expect(e.message).toBe("HTTP 503: Database connection failed");
      expect([e.retryAfter, e.reason, e.code, e.details]).toEqual([5, reason, "DB-002", { reason }]);
    },
  );

  it("a 503 with no body is typed, with no wait and no reason", async () => {
    const e = (await rejection(probe(restAnswering(503, "")).get("/api/v1/memory"))) as KaguraServiceUnavailableError;
    expect(e).toBeInstanceOf(KaguraServiceUnavailableError);
    expect([e.message, e.retryAfter, e.reason, e.code]).toEqual(["HTTP 503", null, null, undefined]);
  });

  it("every other status keeps the body's code and details", async () => {
    const body = { error: "RES-002", message: "File already exists", details: { existing_file: { id: "f1" } } };
    const e = await rejection(probe(restAnswering(409, body)).get("/api/v1/files"));
    expect(e.constructor).toBe(KaguraConnectionError);
    expect([e.code, e.details]).toEqual(["RES-002", { existing_file: { id: "f1" } }]);
  });

  it("a validation error keeps VAL-001's errors", async () => {
    const errors = [{ loc: ["body", "summary"], msg: "Field required", type: "missing" }];
    const body = { error: "VAL-001", message: "Request validation failed", details: { errors } };
    const e = await rejection(probe(restAnswering(422, body)).get("/api/v1/memory"));
    expect([e.code, e.details]).toEqual(["VAL-001", { errors }]);
  });
});

// ---------------------------------------------------------------------------
// get_usage's capacity_lock
// ---------------------------------------------------------------------------

describe("getUsage capacity_lock (v0.99.0+)", () => {
  const USAGE = {
    status: "success",
    plan: "free",
    memories: { used: 1250, limit: 1000, percentage: 125.0 },
    contexts: { used: 2, limit: 3 },
    members: { used: 1, limit: 1 },
    mcp_calls_per_day: { used: 4, limit: 500 },
  };

  it("returns the lock as the server sent it", async () => {
    const server = new FakeServer();
    server.toolResults.get_usage = { ...USAGE, capacity_lock: { ...LOCK_FIGURES, help: LOCK_HELP } };
    const usage = await makeClient(server).getUsage();
    expect(usage.capacity_lock).toEqual({ ...LOCK_FIGURES, help: LOCK_HELP });
    expect(usage.capacity_lock?.over_memories).toBe(250);
  });

  it("reads a REST-shaped lock with purge_at", async () => {
    const server = new FakeServer();
    const lock = { ...LOCK_FIGURES, purge_at: "2026-12-04T04:00:00Z" };
    server.toolResults.get_usage = { ...USAGE, capacity_lock: lock };
    expect((await makeClient(server).getUsage()).capacity_lock?.purge_at).toBe("2026-12-04T04:00:00Z");
  });

  it.each([
    ["null (within capacity)", { ...USAGE, capacity_lock: null }],
    ["absent (a server older than v0.99.0)", USAGE],
    ["an object with no fields", { ...USAGE, capacity_lock: {} }],
  ])("accepts a lock that is %s", async (_label, reply) => {
    const server = new FakeServer();
    server.toolResults.get_usage = reply;
    await expect(makeClient(server).getUsage()).resolves.toEqual(reply);
  });

  it("refuses a lock the Python model refuses, naming the field", async () => {
    const server = new FakeServer();
    server.toolResults.get_usage = { ...USAGE, capacity_lock: { ...LOCK_FIGURES, over_memories: "many" } };
    const e = await rejection(makeClient(server).getUsage());
    expect(e).toBeInstanceOf(KaguraResponseError);
    expect((e as KaguraResponseError).operation).toBe("get_usage");
    expect(e.message).toContain("capacity_lock.over_memories");
  });

  it("refuses a lock that is not an object", async () => {
    const server = new FakeServer();
    server.toolResults.get_usage = { ...USAGE, capacity_lock: "locked" };
    const e = await rejection(makeClient(server).getUsage());
    expect(e).toBeInstanceOf(KaguraResponseError);
    expect(e.message).toContain("CapacityLock");
  });
});
