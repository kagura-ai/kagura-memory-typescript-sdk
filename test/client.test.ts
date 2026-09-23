import { afterEach, describe, expect, it, vi } from "vitest";

import { KaguraClient, MIN_SERVER_VERSION } from "../src/client.js";
import {
  KaguraAuthError,
  KaguraConnectionError,
  KaguraError,
  KaguraNotFoundError,
  KaguraPartialRollbackError,
  KaguraPermissionError,
  KaguraFeatureNotAvailableError,
  KaguraQuotaError,
  KaguraRateLimitError,
} from "../src/errors.js";
import type { ListContextsResponse, SearchConfig } from "../src/models.js";
import { FakeServer, makeClient, SESSION_EXPIRED_BODY } from "./fakeServer.js";

describe("construction", () => {
  it("accepts an explicit api key and https MCP URL", () => {
    const client = makeClient(new FakeServer());
    expect(client.mcpUrl).toBe("https://x.test/mcp");
  });

  it("strips trailing slashes from the MCP URL", () => {
    const client = makeClient(new FakeServer(), { mcpUrl: "https://x.test/mcp/" });
    expect(client.mcpUrl).toBe("https://x.test/mcp");
  });

  it("rejects plain-HTTP non-loopback MCP URLs", () => {
    expect(() => makeClient(new FakeServer(), { mcpUrl: "http://evil.test/mcp" })).toThrow(
      /MCP URL must use HTTPS/,
    );
  });

  it("allows localhost HTTP for development", () => {
    expect(() => makeClient(new FakeServer(), { mcpUrl: "http://localhost:8080/mcp" })).not.toThrow();
  });
});

describe("MCP session", () => {
  it("initializes once and reuses the session id", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.listContexts();
    await client.listContexts();

    expect(server.requests).toHaveLength(3); // 1 init + 2 tool calls
    const init = server.requests[0]!;
    expect((init.body!.params as Record<string, unknown>).protocolVersion).toBe("2025-03-26");
    expect(server.requests[1]!.headers["mcp-session-id"]).toBe("session-123");
    expect(server.requests[2]!.headers["mcp-session-id"]).toBe("session-123");
  });

  it("sends the bearer token on every request", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.listContexts();
    for (const request of server.requests) {
      expect(request.headers.authorization).toBe("Bearer test-key");
    }
  });

  it("throws KaguraConnectionError when no session id is returned", async () => {
    const server = new FakeServer();
    server.sessionId = null;
    const client = makeClient(server);
    await expect(client.listContexts()).rejects.toThrow(/No session ID returned/);
  });

  it("maps 401 to KaguraAuthError", async () => {
    const server = new FakeServer();
    server.forcedResponse = new Response("{}", { status: 401 });
    const client = makeClient(server);
    await expect(client.listContexts()).rejects.toBeInstanceOf(KaguraAuthError);
  });

  it("maps 429 to KaguraRateLimitError with retryAfter", async () => {
    const server = new FakeServer();
    server.forcedResponse = new Response(JSON.stringify({ detail: "slow down" }), {
      status: 429,
      headers: { "Retry-After": "7" },
    });
    const client = makeClient(server);
    const error = await client.listContexts().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraRateLimitError);
    expect((error as KaguraRateLimitError).retryAfter).toBe(7);
  });

  it("wraps network failures in KaguraConnectionError", async () => {
    const failingFetch: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const client = new KaguraClient({
      apiKey: "k",
      mcpUrl: "https://x.test/mcp",
      fetch: failingFetch,
    });
    await expect(client.listContexts()).rejects.toThrow(/Connection failed: fetch failed/);
  });

  it("surfaces JSON-RPC protocol errors as KaguraConnectionError", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.listContexts(); // establish session with normal flow
    server.forcedResponse = new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32600, message: "bad request" } }),
      { status: 200 },
    );
    await expect(client.listContexts()).rejects.toThrow(/MCP error: bad request/);
  });
});

/** Drop session-123 server-side, as an idle hour or a deploy does. */
function expire(server: FakeServer): void {
  server.expiredSessions.add("session-123");
  server.sessionId = "session-456"; // what the next initialize opens
}

describe("expired MCP session recovery (#39)", () => {
  it("re-initializes once without the stale session id and retries the call", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = { status: "success", contexts: ["c1"] };
    const client = makeClient(server);
    await client.listContexts();
    expire(server);

    const result = await client.listContexts();

    expect(result.contexts).toEqual(["c1"]);
    expect(server.calls().slice(2)).toEqual([
      ["tools/call", "session-123"], // rejected: the session is gone
      ["initialize", undefined], // exactly one re-initialize, without the stale id
      ["tools/call", "session-456"], // exactly one retry, on the new session
    ]);
    expect(server.requests[4]!.body).toEqual(server.requests[2]!.body);

    // The new session is kept: the next call needs no initialize.
    await client.listContexts();
    expect(server.calls().slice(5)).toEqual([["tools/call", "session-456"]]);
  });

  it("surfaces a second 404 as KaguraConnectionError naming the expired session", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.listContexts();
    expire(server);
    server.expiredSessions.add("session-456"); // dropped again straight away

    const error = await client.listContexts().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KaguraConnectionError);
    expect((error as KaguraConnectionError).message).toBe(
      "MCP session expired; the client re-initialized once and the retry still got " +
        `HTTP 404: ${SESSION_EXPIRED_BODY.error.message}`,
    );
    // One re-initialize and one retry, then the error: no loop.
    expect(server.calls().slice(2)).toEqual([
      ["tools/call", "session-123"],
      ["initialize", undefined],
      ["tools/call", "session-456"],
    ]);
  });

  it("says only HTTP 404 when neither 404 has a body to quote", async () => {
    const server = new FakeServer();
    let dropped = false;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await server.fetch(input, init);
      // Once dropped, every request naming a session gets an empty 404.
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return dropped && headers["mcp-session-id"] ? new Response("", { status: 404 }) : response;
    };
    const client = makeClient(server, { fetch });
    await client.listContexts();
    dropped = true;
    server.sessionId = "session-456";

    const error = await client.listContexts().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KaguraConnectionError);
    expect((error as KaguraConnectionError).message).toBe(
      "MCP session expired; the client re-initialized once and the retry still got HTTP 404",
    );
    expect(server.calls().slice(2)).toEqual([
      ["tools/call", "session-123"],
      ["initialize", undefined],
      ["tools/call", "session-456"],
    ]);
  });

  it("keeps the typed error when the retry fails for another reason", async () => {
    const server = new FakeServer();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await server.fetch(input, init);
      // The retry, on the re-opened session, is rate limited.
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["mcp-session-id"] === "session-456") {
        return new Response(JSON.stringify({ detail: "slow down" }), {
          status: 429,
          headers: { "Retry-After": "7" },
        });
      }
      return response;
    };
    const client = makeClient(server, { fetch });
    await client.listContexts();
    expire(server);

    const error = await client.listContexts().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KaguraRateLimitError);
    expect((error as KaguraRateLimitError).retryAfter).toBe(7);
    expect(server.calls().slice(2)).toEqual([
      ["tools/call", "session-123"],
      ["initialize", undefined],
      ["tools/call", "session-456"],
    ]);
  });

  it("does not retry a 404 on the first initialize", async () => {
    const server = new FakeServer();
    server.forcedResponse = new Response(JSON.stringify(SESSION_EXPIRED_BODY), { status: 404 });
    const client = makeClient(server);

    const error = await client.listContexts().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KaguraConnectionError);
    expect((error as KaguraConnectionError).message).toBe(
      `HTTP 404: ${SESSION_EXPIRED_BODY.error.message}`,
    );
    expect(server.calls()).toEqual([["initialize", undefined]]);
  });

  it("does not retry a 404 on the re-initialize, and the next call opens a fresh session", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.listContexts();
    server.forcedResponse = new Response(JSON.stringify(SESSION_EXPIRED_BODY), { status: 404 });

    await expect(client.listContexts()).rejects.toThrow(
      `HTTP 404: ${SESSION_EXPIRED_BODY.error.message}`,
    );
    expect(server.calls().slice(2)).toEqual([
      ["tools/call", "session-123"],
      ["initialize", undefined],
    ]);

    server.forcedResponse = null;
    server.sessionId = "session-456";
    await client.listContexts();
    expect(server.calls().slice(4)).toEqual([
      ["initialize", undefined],
      ["tools/call", "session-456"],
    ]);
  });

  it("does not re-initialize on a 404 Method-not-found, which is not about the session", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.listContexts();
    server.forcedResponse = new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } }),
      { status: 404 },
    );

    await expect(client.listContexts()).rejects.toThrow("HTTP 404: Method not found");
    expect(server.calls().slice(2)).toEqual([["tools/call", "session-123"]]);
  });

  it("does not re-initialize on a 401", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.listContexts();
    server.forcedResponse = new Response("{}", { status: 401 });

    await expect(client.listContexts()).rejects.toBeInstanceOf(KaguraAuthError);
    expect(server.calls().slice(2)).toEqual([["tools/call", "session-123"]]);
  });
});

describe("concurrent MCP session opens (#39)", () => {
  it("shares one initialize between concurrent first calls", async () => {
    const server = new FakeServer();
    const client = makeClient(server);

    await Promise.all([client.listContexts(), client.listContexts(), client.listContexts()]);

    expect(server.calls()).toEqual([
      ["initialize", undefined],
      ["tools/call", "session-123"],
      ["tools/call", "session-123"],
      ["tools/call", "session-123"],
    ]);
  });

  it("shares one re-initialize between concurrent calls on an expired session", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.listContexts();
    expire(server);

    await Promise.all(Array.from({ length: 5 }, () => client.listContexts()));

    // The first handshake plus ONE re-open, not one per caller.
    expect(server.calls().filter(([method]) => method === "initialize")).toHaveLength(2);
    expect(server.calls().slice(-5)).toEqual(Array(5).fill(["tools/call", "session-456"]));
  });

  it("close() during an in-flight initialize is not undone by it", async () => {
    const server = new FakeServer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await server.fetch(input, init);
      if (server.requests.length === 1) {
        await gate; // hold the first initialize reply
      }
      return response;
    };
    const client = makeClient(server, { fetch });

    const first = client.listContexts();
    while (server.requests.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await client.close();
    release();
    await first;
    server.sessionId = "session-456";
    await client.listContexts();

    // The handshake close() interrupted served the call that started it,
    // but the next call opens a fresh session instead of reusing it.
    expect(server.calls()).toEqual([
      ["initialize", undefined],
      ["tools/call", "session-123"],
      ["initialize", undefined],
      ["tools/call", "session-456"],
    ]);
  });

  it("keeps a session another call re-opened when a late 404 names the old one", async () => {
    const server = new FakeServer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await server.fetch(input, init);
      // Hold back the first reply to the "slow" call, so its 404 for the
      // old session lands after another call has re-opened a new one.
      if (!held && typeof init?.body === "string" && init.body.includes('"name":"slow"')) {
        held = true;
        await gate;
      }
      return response;
    };
    const client = makeClient(server, { fetch });
    await client.listContexts();
    expire(server);

    const slow = client.callRawTool("slow");
    await client.listContexts();
    release();
    await slow;

    expect(server.calls().filter(([method]) => method === "initialize")).toHaveLength(2);
    expect(server.calls().at(-1)).toEqual(["tools/call", "session-456"]);
  });

  it("never sends a call without a session id while another call forgets the stale one", async () => {
    // A call that finds the session just before a concurrent 404 forgets it
    // must send the id it found, not re-read the field after an await. The
    // window is a few microtask ticks wide, so start that call on each tick
    // after the 404 is let through.
    for (let ticks = 0; ticks < 20; ticks++) {
      const server = new FakeServer();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = false;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const response = await server.fetch(input, init);
        // Hold back the body of the "slow" call's 404 for the old session.
        if (!held && typeof init?.body === "string" && init.body.includes('"name":"slow"')) {
          const text = await response.text();
          Object.defineProperty(response, "text", {
            value: async () => {
              await gate;
              return text;
            },
          });
          held = true;
        }
        return response;
      };
      const client = makeClient(server, { fetch });
      await client.listContexts();
      expire(server);

      const slow = client.callRawTool("slow");
      while (!held) {
        await Promise.resolve();
      }
      release();
      for (let i = 0; i < ticks; i++) {
        await Promise.resolve();
      }
      await Promise.all([slow, client.callRawTool("other")]);

      const toolCalls = server.calls().filter(([method]) => method === "tools/call");
      expect(toolCalls.filter(([, session]) => session === undefined), `ticks=${ticks}`).toEqual([]);
      expect(
        server.calls().filter(([method]) => method === "initialize"),
        `ticks=${ticks}`,
      ).toHaveLength(2);
    }
  });

  it("rejects every caller of a failed shared initialize and retries on the next call", async () => {
    const server = new FakeServer();
    server.forcedResponse = new Response("", { status: 503 });
    const client = makeClient(server);

    const results = await Promise.allSettled([client.listContexts(), client.listContexts()]);

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(server.calls()).toEqual([["initialize", undefined]]);

    server.forcedResponse = null;
    await client.listContexts();
    expect(server.calls().slice(1)).toEqual([
      ["initialize", undefined],
      ["tools/call", "session-123"],
    ]);
  });
});

describe("domain error translation (#180 semantics)", () => {
  it("throws KaguraNotFoundError for *_not_found codes", async () => {
    const server = new FakeServer();
    server.toolResults.recall = {
      status: "error",
      error: "context_not_found",
      message: "Context xyz not found",
    };
    const client = makeClient(server);
    await expect(client.recall({ contextId: "xyz", query: "q" })).rejects.toBeInstanceOf(
      KaguraNotFoundError,
    );
  });

  it("throws KaguraError for other domain error codes", async () => {
    const server = new FakeServer();
    server.toolResults.remember = {
      status: "error",
      error: "validation_failed",
      message: "summary too short",
    };
    const client = makeClient(server);
    const error = await client
      .remember({ contextId: "c", summary: "s", content: "x" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraError);
    expect((error as KaguraError).message).toBe(
      "remember failed (validation_failed): summary too short",
    );
  });
});

describe("typed plan / quota / rollback / permission errors (#40)", () => {
  async function failure(
    server: FakeServer,
    call: (c: KaguraClient) => Promise<unknown>,
  ): Promise<unknown> {
    return call(makeClient(server)).then(
      () => {
        throw new Error("expected the call to reject");
      },
      (e: unknown) => e,
    );
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps a v0.75 quota_exceeded envelope by its gate, with the payload", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T23:00:00Z"));
    const server = new FakeServer();
    server.toolResults.remember = {
      status: "error",
      error: "quota_exceeded",
      message: "Daily memory limit reached (100/day).",
      gate: "quota",
      quota_type: "memories_per_day",
      current: 100,
      limit: 100,
      used_today: 100,
      requested: 1,
      required_plan: "basic",
      required_plan_display: "M",
      current_plan: "free",
      resets_at: "2026-09-24T00:00:00+00:00",
    };
    const err = await failure(server, (c) =>
      c.remember({ contextId: "c", summary: "s", content: "x" }),
    );

    expect(err).toBeInstanceOf(KaguraQuotaError);
    const quota = err as KaguraQuotaError;
    // Same text the generic mapping produced, so message matching still works.
    expect(quota.message).toBe(
      "remember failed (quota_exceeded): Daily memory limit reached (100/day).",
    );
    expect(quota.gate).toBe("quota");
    expect(quota.quotaType).toBe("memories_per_day");
    expect(quota.current).toBe(100);
    expect(quota.limit).toBe(100);
    expect(quota.usedToday).toBe(100);
    expect(quota.requiredPlan).toBe("basic");
    expect(quota.requiredPlanDisplay).toBe("M");
    expect(quota.currentPlan).toBe("free");
    expect(quota.resetsAt).toBe("2026-09-24T00:00:00+00:00");
    expect(quota.retryAfter).toBe(3600);
  });

  it("maps a pre-v0.75 quota_exceeded envelope by its code", async () => {
    // v0.68-v0.74: no gate, no canonical `current` — only the legacy counts.
    const server = new FakeServer();
    server.toolResults.remember = {
      status: "error",
      error: "quota_exceeded",
      message: "Memory limit reached.",
      quota_type: "memory_limit",
      limit: 1000,
    };
    const err = await failure(server, (c) =>
      c.remember({ contextId: "c", summary: "s", content: "x" }),
    );

    expect(err).toBeInstanceOf(KaguraQuotaError);
    const quota = err as KaguraQuotaError;
    expect(quota.gate).toBeNull();
    expect(quota.quotaType).toBe("memory_limit");
    expect(quota.limit).toBe(1000);
    expect(quota.current).toBeNull();
    expect(quota.retryAfter).toBeNull();
  });

  it("reads used_today as current when an older server sends no current", async () => {
    const server = new FakeServer();
    server.toolResults.remember = {
      status: "error",
      error: "quota_exceeded",
      message: "Daily memory limit reached.",
      quota_type: "memories_per_day",
      limit: 100,
      used_today: 100,
    };
    const err = (await failure(server, (c) =>
      c.remember({ contextId: "c", summary: "s", content: "x" }),
    )) as KaguraQuotaError;
    expect(err.usedToday).toBe(100);
    expect(err.current).toBe(100);
  });

  it("maps a v0.75 plan_required envelope by its gate, with the payload", async () => {
    const server = new FakeServer();
    server.toolResults.setup_resource = {
      status: "error",
      error: "plan_required",
      message:
        "Feature 'resources' not available on L plan. Upgrade to XL plan to access this feature.",
      gate: "plan",
      feature: "resources",
      required_plan: "promax",
      required_plan_display: "XL",
      current_plan: "pro",
    };
    const err = await failure(server, (c) => c.setupResource({ resourceId: "r" }));

    expect(err).toBeInstanceOf(KaguraFeatureNotAvailableError);
    const plan = err as KaguraFeatureNotAvailableError;
    expect(plan.message).toMatch(/^setup_resource failed \(plan_required\): Feature 'resources'/);
    expect(plan.gate).toBe("plan");
    expect(plan.feature).toBe("resources");
    expect(plan.requiredPlan).toBe("promax");
    expect(plan.requiredPlanDisplay).toBe("XL");
    expect(plan.currentPlan).toBe("pro");
  });

  it("maps a pre-v0.75 plan_required envelope by its code", async () => {
    // v0.68-v0.74 sent only `required_plan` beside the code.
    const server = new FakeServer();
    server.toolResults.update_context = {
      status: "error",
      error: "plan_required",
      message: "Public contexts require the L plan.",
      required_plan: "pro",
    };
    const err = await failure(server, (c) => c.updateContext({ contextId: "c", isPublic: true }));

    expect(err).toBeInstanceOf(KaguraFeatureNotAvailableError);
    const plan = err as KaguraFeatureNotAvailableError;
    expect(plan.gate).toBeNull();
    expect(plan.requiredPlan).toBe("pro");
    expect(plan.feature).toBeNull();
    expect(plan.requiredPlanDisplay).toBeNull();
  });

  it("maps create_context's v0.75 shared-context refusal to KaguraFeatureNotAvailableError", async () => {
    // Before v0.75 this was a validation_error; it is a plan gate now.
    const server = new FakeServer();
    server.toolResults.list_contexts = { can_create: true, contexts: [] };
    server.toolResults.create_context = {
      status: "error",
      error: "plan_required",
      message: "Feature 'shared_contexts' not available on S plan.",
      gate: "plan",
      feature: "shared_contexts",
      required_plan: "basic",
      required_plan_display: "M",
      current_plan: "free",
    };
    const err = await failure(server, (c) => c.createContext({ name: "team", isPrivate: false }));
    expect(err).toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect((err as KaguraFeatureNotAvailableError).feature).toBe("shared_contexts");
  });

  it("chooses the class from the gate, not the code", async () => {
    // The first code disagrees with its gate and the second is none the SDK
    // knows, so each is typed only if the gate is read, and read first.
    const server = new FakeServer();
    server.toolResults.setup_connector = {
      status: "error",
      error: "plan_required",
      message: "Connector seat limit reached.",
      gate: "quota",
      quota_type: "connectors",
      current: 2,
      limit: 2,
    };
    server.toolResults.analyze_context = {
      status: "error",
      error: "analysis_disabled",
      message: "Analyses are not enabled for this workspace.",
      gate: "allowlist",
      feature: "memory_analysis",
    };
    const client = makeClient(server);

    const quota = await client.callRawTool("setup_connector").catch((e: unknown) => e);
    expect(quota).toBeInstanceOf(KaguraQuotaError);
    expect((quota as KaguraQuotaError).quotaType).toBe("connectors");

    const plan = await client.callRawTool("analyze_context").catch((e: unknown) => e);
    expect(plan).toBeInstanceOf(KaguraFeatureNotAvailableError);
    // allowlist: no tier lifts it, so there is no plan to offer.
    expect((plan as KaguraFeatureNotAvailableError).gate).toBe("allowlist");
    expect((plan as KaguraFeatureNotAvailableError).requiredPlan).toBeNull();
  });

  it("maps a pre-v0.75 feature_not_available envelope by its code", async () => {
    // The analysis tools' twin of plan_required, sent with no gate before v0.75.
    const server = new FakeServer();
    server.toolResults.analyze_context = {
      status: "error",
      error: "feature_not_available",
      message: "Memory analysis is not available on your plan.",
      feature: "memory_analysis",
    };
    const err = await failure(server, (c) => c.callRawTool("analyze_context"));

    expect(err).toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect((err as KaguraFeatureNotAvailableError).gate).toBeNull();
    expect((err as KaguraFeatureNotAvailableError).feature).toBe("memory_analysis");
  });

  it("maps a pre-v0.75 CONNECTOR-001 envelope from setup_connector by its code", async () => {
    // setup_connector forwards the connector seat cap's REST code as is.
    const server = new FakeServer();
    server.toolResults.setup_connector = {
      status: "error",
      error: "CONNECTOR-001",
      message: "Connector seat limit reached. Your plan allows 2 connector(s).",
      max_connectors: 2,
      active_connectors: 3,
    };
    const err = await failure(server, (c) => c.callRawTool("setup_connector"));

    expect(err).toBeInstanceOf(KaguraQuotaError);
    const quota = err as KaguraQuotaError;
    expect(quota.gate).toBeNull();
    // The legacy seat counts stand in for the canonical current / limit.
    expect(quota.current).toBe(3);
    expect(quota.limit).toBe(2);
  });

  it("reads the analysis quota's pre-v0.75 limit_today as limit", async () => {
    // v0.74 analysis_gates: used_today / limit_today, no current / limit.
    const server = new FakeServer();
    server.toolResults.analyze_context = {
      status: "error",
      error: "quota_exceeded",
      message: "Analysis daily quota exceeded: 3/3 runs today (addon bonus 0).",
      quota_type: "memory_analysis",
      used_today: 4,
      limit_today: 3,
      addon_bonus: 0,
      remaining_today: 0,
    };
    const err = (await failure(server, (c) =>
      c.callRawTool("analyze_context"),
    )) as KaguraQuotaError;
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect(err.quotaType).toBe("memory_analysis");
    expect(err.usedToday).toBe(4);
    expect(err.current).toBe(4);
    expect(err.limit).toBe(3);
  });

  it("prefers the canonical current / limit over the legacy names v0.75 keeps beside them", async () => {
    const server = new FakeServer();
    server.toolResults.setup_connector = {
      status: "error",
      error: "CONNECTOR-001",
      message: "Connector seat limit reached.",
      gate: "quota",
      quota_type: "connectors",
      current: 3,
      limit: 5,
      active_connectors: 98,
      max_connectors: 99,
    };
    const err = (await failure(server, (c) =>
      c.callRawTool("setup_connector"),
    )) as KaguraQuotaError;
    expect(err.current).toBe(3);
    expect(err.limit).toBe(5);
  });

  it("reads ingest_events' retry_after_seconds as retryAfter", async () => {
    // The resource events-per-hour quota: no gate, no resets_at, only a
    // top-level retry hint.
    const server = new FakeServer();
    server.toolResults.ingest_events = {
      status: "error",
      error: "quota_exceeded",
      message: "Event quota exceeded: 10/10 events per hour",
      retry_after_seconds: 3600,
    };
    const err = (await failure(server, (c) =>
      c.callRawTool("ingest_events"),
    )) as KaguraQuotaError;
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect(err.retryAfter).toBe(3600);
    expect(err.message).toBe(
      "ingest_events failed (quota_exceeded): Event quota exceeded: 10/10 events per hour",
    );
  });

  it("keeps a transport 429 a KaguraRateLimitError, with the daily quota's payload", async () => {
    // v0.75 answers the daily MCP call quota at the HTTP layer, in the REST
    // envelope. The class stays the one existing handlers catch.
    const server = new FakeServer();
    server.forcedResponse = new Response(
      JSON.stringify({
        error: "QUOTA-001",
        message: "Daily MCP quota exceeded: 1001/1000. Resets at midnight UTC.",
        details: { gate: "quota", quota_type: "api_mcp_daily", retry_after: 86400 },
      }),
      { status: 429, headers: { "Retry-After": "86400" } },
    );
    const err = await failure(server, (c) => c.listContexts());

    expect(err).toBeInstanceOf(KaguraRateLimitError);
    expect(err).not.toBeInstanceOf(KaguraQuotaError);
    const limited = err as KaguraRateLimitError;
    expect(limited.message).toBe(
      "Rate limit exceeded (HTTP 429): Daily MCP quota exceeded: 1001/1000. " +
        "Resets at midnight UTC.",
    );
    expect(limited.gate).toBe("quota");
    expect(limited.quotaType).toBe("api_mcp_daily");
    expect(limited.retryAfter).toBe(86400);
  });

  it("falls back to the body's retry_after on a transport 429 with no Retry-After", async () => {
    const server = new FakeServer();
    server.forcedResponse = new Response(
      JSON.stringify({
        error: "RATE-001",
        message: "Rate limit exceeded: 61/60 requests per minute",
        details: { retry_after: 60, limit: 60, remaining: 0 },
      }),
      { status: 429 },
    );
    const err = (await failure(server, (c) => c.listContexts())) as KaguraRateLimitError;

    expect(err).toBeInstanceOf(KaguraRateLimitError);
    expect(err.retryAfter).toBe(60);
    // A per-minute limit is no typed quota, so its `limit` is not read.
    expect(err.limit).toBeNull();
  });

  it("ignores wrong-typed gate fields instead of trusting the shape", async () => {
    const server = new FakeServer();
    server.toolResults.remember = {
      status: "error",
      error: "quota_exceeded",
      message: "limit",
      gate: "quota",
      quota_type: 42,
      limit: "100",
      current: null,
      resets_at: 0,
    };
    const err = (await failure(server, (c) =>
      c.remember({ contextId: "c", summary: "s", content: "x" }),
    )) as KaguraQuotaError;
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect(err.quotaType).toBeNull();
    expect(err.limit).toBeNull();
    expect(err.current).toBeNull();
    expect(err.resetsAt).toBeNull();
  });

  it("maps partial_rollback to KaguraPartialRollbackError carrying the summary", async () => {
    const server = new FakeServer();
    const summary = {
      edges_deleted: 3,
      merges_reversed: 1,
      merges_unreversible: 1,
      importance_restored: 0,
      promotions_reversed: 0,
      importance_kept: 0,
      promotions_kept: 0,
      archives_restored: 2,
      errors: ["Action 9 (merge): edge was changed by a later write"],
    };
    server.toolResults.rollback_sleep_run = {
      status: "error",
      error: "partial_rollback",
      message:
        "Rollback completed with 1 error(s). " +
        "Report marked as 'failed' — inspect errors and retry if needed.",
      report_id: "r1",
      rollback_summary: summary,
    };
    const err = await failure(server, (c) =>
      c.rollbackSleepRun({ contextId: "c", reportId: "r1" }),
    );

    expect(err).toBeInstanceOf(KaguraPartialRollbackError);
    const partial = err as KaguraPartialRollbackError;
    expect(partial.message).toMatch(/^rollback_sleep_run failed \(partial_rollback\): /);
    expect(partial.reportId).toBe("r1");
    expect(partial.summary).toEqual(summary);
  });

  it("gives partial_rollback an empty summary when the server omits it", async () => {
    const server = new FakeServer();
    server.toolResults.rollback_sleep_run = {
      status: "error",
      error: "partial_rollback",
      message: "partial",
    };
    const err = (await failure(server, (c) =>
      c.rollbackSleepRun({ contextId: "c", reportId: "r1" }),
    )) as KaguraPartialRollbackError;
    expect(err).toBeInstanceOf(KaguraPartialRollbackError);
    expect(err.reportId).toBeNull();
    expect(err.summary).toEqual({});
  });

  it("maps permission_denied to KaguraPermissionError carrying requiredRole", async () => {
    const server = new FakeServer();
    server.toolResults.remember = {
      status: "error",
      error: "permission_denied",
      message: "Cannot remember: tool guardrails require context editor or above.",
      required_role: "editor",
    };
    const err = await failure(server, (c) =>
      c.remember({ contextId: "c", summary: "s", content: "x", details: { tool_trigger: {} } }),
    );

    expect(err).toBeInstanceOf(KaguraPermissionError);
    expect((err as KaguraPermissionError).requiredRole).toBe("editor");
    expect((err as KaguraPermissionError).message).toBe(
      "remember failed (permission_denied): " +
        "Cannot remember: tool guardrails require context editor or above.",
    );
  });

  it("refuses a workspace viewer's forget outright rather than skipping its target", async () => {
    // handle_forget checks the workspace role before it looks at any target.
    const server = new FakeServer();
    server.toolResults.forget = {
      status: "error",
      error: "permission_denied",
      message: "Viewers have read-only access. Cannot delete memories.",
      your_role: "viewer",
      required_role: "member",
    };
    const err = await failure(server, (c) => c.forget({ contextId: "c", memoryId: "m1" }));

    expect(err).toBeInstanceOf(KaguraPermissionError);
    expect((err as KaguraPermissionError).requiredRole).toBe("member");
  });

  it("maps updateSearchConfig's missing context to KaguraPermissionError, not KaguraNotFoundError", async () => {
    // update_search_config answers every access failure, a missing context
    // included, with permission_denied and no required_role.
    const server = new FakeServer();
    server.toolResults.update_search_config = {
      status: "error",
      error: "permission_denied",
      message: "Context not found",
    };
    const err = await failure(server, (c) =>
      c.updateSearchConfig({ contextId: "00000000-0000-0000-0000-000000000000" }),
    );

    expect(err).toBeInstanceOf(KaguraPermissionError);
    expect(err).not.toBeInstanceOf(KaguraNotFoundError);
    expect((err as KaguraPermissionError).requiredRole).toBeNull();
  });

  it("leaves other codes on the generic KaguraError", async () => {
    const server = new FakeServer();
    server.toolResults.update_context = {
      status: "error",
      error: "cannot_make_private",
      message: "Cannot make private: context has a resource_id.",
    };
    const err = await failure(server, (c) => c.updateContext({ contextId: "c", isPublic: false }));
    expect(err).toBeInstanceOf(KaguraError);
    expect(err).not.toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect(err).not.toBeInstanceOf(KaguraQuotaError);
    expect(err).not.toBeInstanceOf(KaguraPermissionError);
  });
});

describe("remember", () => {
  it("sends defaults and omits unset optionals", async () => {
    const server = new FakeServer();
    server.toolResults.remember = { status: "success", memory_id: "m1" };
    const client = makeClient(server);
    const result = await client.remember({ contextId: "ctx", summary: "sum", content: "body" });

    expect(result.memory_id).toBe("m1");
    expect(server.toolCallArgs()).toEqual({
      context_id: "ctx",
      summary: "sum",
      content: "body",
      type: "note",
      importance: 0.5,
    });
  });

  it("sends a non-default delivery_mode but not the default", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.remember({
      contextId: "ctx",
      summary: "s",
      content: "c",
      deliveryMode: "always",
    });
    await client.remember({
      contextId: "ctx",
      summary: "s",
      content: "c",
      deliveryMode: "on_recall",
    });
    expect(server.toolCallArgs(0).delivery_mode).toBe("always");
    expect(server.toolCallArgs(1)).not.toHaveProperty("delivery_mode");
  });

  it("passes through optional fields with snake_case wire names", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.remember({
      contextId: "ctx",
      summary: "s",
      content: "c",
      tags: ["a"],
      sourceUri: "https://src.test",
      sourceType: "url",
      contextSummary: "why",
      details: { code: 1 },
      linkedMemoryIds: ["m1"],
      linkedSourceUris: ["file:///x"],
    });
    expect(server.toolCallArgs()).toMatchObject({
      tags: ["a"],
      source_uri: "https://src.test",
      source_type: "url",
      context_summary: "why",
      details: { code: 1 },
      linked_memory_ids: ["m1"],
      linked_source_uris: ["file:///x"],
    });
  });

  it("forwards supersedes as-is and omits it when unset (#7)", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.remember({
      contextId: "ctx",
      summary: "s",
      content: "c",
      supersedes: "11111111-2222-3333-4444-555555555555",
    });
    await client.remember({ contextId: "ctx", summary: "s", content: "c" });

    expect(server.toolCallArgs(0).supersedes).toBe("11111111-2222-3333-4444-555555555555");
    expect(server.toolCallArgs(1)).not.toHaveProperty("supersedes");
  });
});

describe("recall", () => {
  it("rejects empty queries", async () => {
    const client = makeClient(new FakeServer());
    await expect(client.recall({ contextId: "c", query: "  " })).rejects.toThrow(
      /query must be a non-empty string/,
    );
  });

  it("requires contextId or contextIds", async () => {
    const client = makeClient(new FakeServer());
    await expect(client.recall({ query: "q" })).rejects.toThrow(
      /Either contextId or contextIds/,
    );
  });

  it("validates contextIds count (2-20)", async () => {
    const client = makeClient(new FakeServer());
    await expect(client.recall({ query: "q", contextIds: ["one"] })).rejects.toThrow(
      /must contain 2-20 IDs/,
    );
    await expect(
      client.recall({ query: "q", contextIds: Array.from({ length: 21 }, (_, i) => `c${i}`) }),
    ).rejects.toThrow(/must contain 2-20 IDs/);
  });

  it("rejects invalid searchMode", async () => {
    const client = makeClient(new FakeServer());
    await expect(
      client.recall({ contextId: "c", query: "q", searchMode: "fuzzy" as never }),
    ).rejects.toThrow(/Invalid searchMode/);
  });

  it("sends minimal wire args by default and flags only when set", async () => {
    const server = new FakeServer();
    server.toolResults.recall = { status: "success", results: [] };
    const client = makeClient(server);
    await client.recall({ contextId: "c", query: "auth flow" });
    expect(server.toolCallArgs()).toEqual({ query: "auth flow", k: 5, context_id: "c" });

    await client.recall({
      contextIds: ["a", "b"],
      query: "q",
      k: 10,
      useRerank: true,
      filters: { type: "code" },
      searchMode: "semantic",
      includeExploreHints: true,
      includeSuperseded: true,
    });
    expect(server.toolCallArgs(1)).toEqual({
      query: "q",
      k: 10,
      context_ids: ["a", "b"],
      use_rerank: true,
      filters: { type: "code" },
      search_mode: "semantic",
      include_explore_hints: true,
      include_superseded: true,
    });
  });

  it("sends useRerank: false rather than dropping it (#37)", async () => {
    // Since server v0.69.0 an omitted use_rerank follows the context's
    // search config, so dropping false would let a rerank-enabled context
    // rerank anyway. Only undefined may leave the key off the wire.
    const server = new FakeServer();
    const client = makeClient(server);
    await client.recall({ contextId: "c", query: "q", useRerank: false });
    await client.recall({ contextIds: ["a", "b"], query: "q", useRerank: false });
    await client.recall({ contextId: "c", query: "q", useRerank: undefined });
    await client.recall({ contextId: "c", query: "q" });

    expect(server.toolCallArgs(0).use_rerank).toBe(false);
    expect(server.toolCallArgs(1).use_rerank).toBe(false);
    expect(server.toolCallArgs(2)).not.toHaveProperty("use_rerank");
    expect(server.toolCallArgs(3)).not.toHaveProperty("use_rerank");
  });

  it("reads back what supersedes shadowed, and only when asked (#25)", async () => {
    const server = new FakeServer();
    const superseded = {
      memory_id: "old-1",
      summary: "prod colour is green",
      superseded_by: "new-1",
    };
    const current = { memory_id: "new-1", summary: "prod colour is blue" };
    const client = makeClient(server);

    server.toolResults.recall = { status: "success", results: [current] };
    const defaultRecall = await client.recall({ contextId: "c", query: "prod colour" });

    server.toolResults.recall = { status: "success", results: [current, superseded] };
    const withHistory = await client.recall({
      contextId: "c",
      query: "prod colour",
      includeSuperseded: true,
    });

    // The property RememberOptions.supersedes documents: the old version is
    // shadowed out of default recall, not destroyed.
    expect(server.toolCallArgs(0)).not.toHaveProperty("include_superseded");
    expect(server.toolCallArgs(1).include_superseded).toBe(true);
    expect((defaultRecall.results as Array<{ memory_id: string }>).map((r) => r.memory_id)).toEqual([
      "new-1",
    ]);
    expect((withHistory.results as Array<{ memory_id: string }>).map((r) => r.memory_id)).toEqual([
      "new-1",
      "old-1",
    ]);
  });

  it("omits include_superseded when explicitly false (#25)", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.recall({ contextId: "c", query: "q", includeSuperseded: false });
    expect(server.toolCallArgs()).not.toHaveProperty("include_superseded");
  });

  it("omits empty filters like the Python truthiness check", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.recall({ contextId: "c", query: "q", filters: {} });
    expect(server.toolCallArgs()).not.toHaveProperty("filters");
  });
});

describe("recallUpcoming", () => {
  it("sends include_details only when includeDetails is true (#42)", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.recallUpcoming({ contextId: "c", from: "now" });
    await client.recallUpcoming({ contextId: "c", includeDetails: true });
    await client.recallUpcoming({ contextId: "c", includeDetails: false });

    // Since server v0.73.0 items carry `trigger` by default; the flag is the
    // only way back to the full `details` object.
    expect(server.toolCallArgs(0)).toEqual({ context_id: "c", k: 20, from: "now" });
    expect(server.toolCallArgs(1)).toEqual({ context_id: "c", k: 20, include_details: true });
    expect(server.toolCallArgs(2)).not.toHaveProperty("include_details");
  });
});

describe("listContexts (#42)", () => {
  it("stays callable with no arguments and sends no flags", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.listContexts();
    expect(server.toolCallArgs()).toEqual({});
  });

  it("maps each option to its snake_case wire name", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.listContexts({
      nameContains: "notes",
      includeSummary: true,
      includeDetails: true,
      includeStats: true,
    });
    expect(server.toolCallArgs()).toEqual({
      name_contains: "notes",
      include_summary: true,
      include_details: true,
      include_stats: true,
    });
  });

  it("omits flags that are false or unset", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.listContexts({ includeSummary: false, includeDetails: false, includeStats: false });
    await client.listContexts({ nameContains: "notes" });
    expect(server.toolCallArgs(0)).toEqual({});
    expect(server.toolCallArgs(1)).toEqual({ name_contains: "notes" });
  });

  it("returns the envelope typed, including the empty-workspace hint", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = {
      status: "success",
      contexts: [],
      count: 0,
      total: 0,
      limit: 5,
      can_create: true,
      hint: "No contexts are visible to you yet.",
    };
    const client = makeClient(server);
    const result: ListContextsResponse = await client.listContexts();
    expect(result.contexts).toEqual([]);
    expect(result.can_create).toBe(true);
    expect(result.hint).toBe("No contexts are visible to you yet.");
  });
});

describe("memory mutation guards", () => {
  it("updateMemory requires exactly one of memoryId/externalId", async () => {
    const client = makeClient(new FakeServer());
    await expect(client.updateMemory({ contextId: "c" })).rejects.toThrow(/exactly one/);
    await expect(
      client.updateMemory({ contextId: "c", memoryId: "m", externalId: "e" }),
    ).rejects.toThrow(/exactly one/);
  });

  it("updateMemory forwards details and omits the key when unset (#6)", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.updateMemory({
      contextId: "c",
      memoryId: "m1",
      details: { location: { lat: 35.68, lon: 139.76 } },
    });
    await client.updateMemory({ contextId: "c", memoryId: "m1", summary: "s" });

    expect(server.toolCallArgs(0)).toEqual({
      context_id: "c",
      memory_id: "m1",
      details: { location: { lat: 35.68, lon: 139.76 } },
    });
    expect(server.toolCallArgs(1)).not.toHaveProperty("details");
  });

  it("updateMemory sends an explicitly empty details object (#6)", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.updateMemory({ contextId: "c", memoryId: "m1", details: {} });
    expect(server.toolCallArgs(0)).toHaveProperty("details", {});
  });

  it("updateMemory maps dismissSupersedeCandidate and omits it unless true (#42)", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.updateMemory({ contextId: "c", memoryId: "m1", dismissSupersedeCandidate: true });
    await client.updateMemory({ contextId: "c", memoryId: "m1", dismissSupersedeCandidate: false });
    await client.updateMemory({ contextId: "c", memoryId: "m1", summary: "s" });

    expect(server.toolCallArgs(0)).toEqual({
      context_id: "c",
      memory_id: "m1",
      dismiss_supersede_candidate: true,
    });
    expect(server.toolCallArgs(1)).not.toHaveProperty("dismiss_supersede_candidate");
    expect(server.toolCallArgs(2)).not.toHaveProperty("dismiss_supersede_candidate");
  });

  it("updateMemory rejects dismissSupersedeCandidate with externalId before any request (#42)", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await expect(
      client.updateMemory({
        contextId: "c",
        externalId: "doc-1",
        summary: "s",
        content: "c",
        type: "note",
        dismissSupersedeCandidate: true,
      }),
    ).rejects.toThrow(/dismissSupersedeCandidate requires memoryId/);
    // Not even the MCP session was opened.
    expect(server.requests).toHaveLength(0);
  });

  it("updateMemory rejects dismissSupersedeCandidate with an empty externalId too (#42)", async () => {
    // `""` slips past the truthy exactly-one check but is still sent as
    // external_id, which the server counts as present and rejects.
    const server = new FakeServer();
    const client = makeClient(server);
    await expect(
      client.updateMemory({
        contextId: "c",
        memoryId: "m1",
        externalId: "",
        dismissSupersedeCandidate: true,
      }),
    ).rejects.toThrow(/dismissSupersedeCandidate requires memoryId/);
    expect(server.requests).toHaveLength(0);
  });

  it("forget requires memoryId or query, and only query mode sends k", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await expect(client.forget({ contextId: "c" })).rejects.toThrow(
      /Provide either memoryId or query/,
    );
    await client.forget({ contextId: "c", memoryId: "m1" });
    expect(server.toolCallArgs(0)).toEqual({ context_id: "c", memory_id: "m1" });
    await client.forget({ contextId: "c", query: "old stuff" });
    expect(server.toolCallArgs(1)).toEqual({ context_id: "c", query: "old stuff", k: 10 });
  });

  it("mergeContexts rejects identical source and target", async () => {
    const client = makeClient(new FakeServer());
    await expect(client.mergeContexts({ sourceId: "a", targetId: "a" })).rejects.toThrow(
      /must be different/,
    );
  });

  it("createEdge rejects self-loops", async () => {
    const client = makeClient(new FakeServer());
    await expect(
      client.createEdge({ contextId: "c", sourceId: "m", targetId: "m" }),
    ).rejects.toThrow(/self-loops/);
  });
});

describe("createContext quota pre-check", () => {
  it("throws KaguraQuotaError when can_create is false", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = { can_create: false, count: 5, limit: 5 };
    const client = makeClient(server);
    await expect(client.createContext({ name: "new" })).rejects.toThrow(
      /Context limit reached \(5\/5\)/,
    );
  });

  it("carries the counts but no gate or plan fields, which list_contexts does not send (#40)", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = { can_create: false, count: 5, limit: 5 };
    const client = makeClient(server);
    const err = (await client
      .createContext({ name: "new" })
      .catch((e: unknown) => e)) as KaguraQuotaError;
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect(err.quotaType).toBe("contexts");
    expect(err.current).toBe(5);
    expect(err.limit).toBe(5);
    // The pre-check is the SDK's inference, not a server gate block, so the
    // plan is unknown here, which the docs must not read as "no plan lifts it".
    expect(err.gate).toBeNull();
    expect(err.requiredPlan).toBeNull();
    expect(err.requiredPlanDisplay).toBeNull();
    expect(err.currentPlan).toBeNull();
    const called = server.requests.some(
      (r) => (r.body?.params as { name?: string })?.name === "create_context",
    );
    expect(called).toBe(false);
  });

  it("carries the server's gate block when create_context itself refuses past the pre-check", async () => {
    // A concurrent create can win the race between the two calls; the
    // server's own refusal then names the plan that lifts the cap.
    const server = new FakeServer();
    server.toolResults.list_contexts = { can_create: true, count: 0, limit: 1 };
    server.toolResults.create_context = {
      status: "error",
      error: "quota_exceeded",
      message:
        "Context limit reached. Your S plan allows 1 context(s) per workspace. " +
        "Upgrade to M plan for more contexts.",
      help: "Delete unused contexts or upgrade your plan.",
      gate: "quota",
      quota_type: "contexts",
      current: 1,
      limit: 1,
      required_plan: "basic",
      required_plan_display: "M",
      current_plan: "free",
    };
    const client = makeClient(server);
    const err = (await client
      .createContext({ name: "new" })
      .catch((e: unknown) => e)) as KaguraQuotaError;
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect(err.gate).toBe("quota");
    expect(err.quotaType).toBe("contexts");
    expect(err.requiredPlan).toBe("basic");
    expect(err.requiredPlanDisplay).toBe("M");
    expect(err.currentPlan).toBe("free");
  });

  it("renders ? for missing or null count/limit (#183)", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = { can_create: false, count: null };
    const client = makeClient(server);
    await expect(client.createContext({ name: "new" })).rejects.toThrow(
      /Context limit reached \(\?\/\?\)/,
    );
  });

  it("treats a present can_create:null as 'cannot create' (matches Python not-get)", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = { can_create: null, count: 5, limit: 5 };
    const client = makeClient(server);
    await expect(client.createContext({ name: "new" })).rejects.toThrow(KaguraQuotaError);
    // The create_context tool must NOT have been called after the quota block.
    expect(server.requests.some((r) => (r.body?.params as { name?: string })?.name === "create_context")).toBe(false);
  });

  it("lets the server decide when list_contexts could not read the quota (limit 0)", async () => {
    // list_contexts answers a failed quota lookup with limit 0 and
    // can_create false; every plan allows at least one context.
    const server = new FakeServer();
    server.toolResults.list_contexts = { can_create: false, count: 0, limit: 0 };
    server.toolResults.create_context = { status: "success", id: "ctx-0" };
    const client = makeClient(server);
    await expect(client.createContext({ name: "new" })).resolves.toMatchObject({ id: "ctx-0" });
  });

  it("allows creation when can_create is absent (defaults to true)", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = { contexts: [] }; // no can_create key
    server.toolResults.create_context = { status: "success", id: "ctx-9" };
    const client = makeClient(server);
    await expect(client.createContext({ name: "ok" })).resolves.toMatchObject({ id: "ctx-9" });
  });

  it("creates when allowed, defaulting is_private to true", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = { can_create: true, contexts: [] };
    server.toolResults.create_context = { status: "success", id: "ctx-1" };
    const client = makeClient(server);
    const result = await client.createContext({ name: "notes", displayName: "Notes" });
    expect(result.id).toBe("ctx-1");
    expect(server.toolCallArgs(1)).toEqual({
      name: "notes",
      is_private: true,
      display_name: "Notes",
    });
  });
});

describe("updateSearchConfig", () => {
  it("sends only the context id when nothing else is set", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.updateSearchConfig({ contextId: "c" });
    expect(server.toolCallArgs()).toEqual({ context_id: "c" });
  });

  it("maps the reinforce and routing options to snake_case (#42)", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.updateSearchConfig({
      contextId: "c",
      reinforceEnabled: true,
      reinforceMaxBoost: 0.2,
      reinforceRequireHostArbitration: true,
      routingMode: "log_only",
    });
    expect(server.toolCallArgs()).toEqual({
      context_id: "c",
      reinforce_enabled: true,
      reinforce_max_boost: 0.2,
      reinforce_require_host_arbitration: true,
      routing_mode: "log_only",
    });
  });

  it("sends false and 0, which are settings rather than absent flags (#42)", async () => {
    // New contexts start with reinforce enabled, so `false` is the whole
    // point of passing it — it must reach the wire, not be dropped.
    const server = new FakeServer();
    const client = makeClient(server);
    await client.updateSearchConfig({
      contextId: "c",
      reinforceEnabled: false,
      reinforceMaxBoost: 0,
      reinforceRequireHostArbitration: false,
    });
    expect(server.toolCallArgs()).toEqual({
      context_id: "c",
      reinforce_enabled: false,
      reinforce_max_boost: 0,
      reinforce_require_host_arbitration: false,
    });
  });

  it("returns the echoed config typed as SearchConfig (#42)", async () => {
    // get_context_info does not return the reinforce and routing fields, so
    // this echo is the only typed place to read them back.
    const server = new FakeServer();
    server.toolResults.update_search_config = {
      status: "success",
      message: "Search configuration updated.",
      context_id: "c",
      config: {
        semantic_weight: 0.6,
        bm25_weight: 0.4,
        fetch_factor: 3,
        use_rerank: false,
        reranker_provider: "voyage",
        reranker_model: "rerank-2",
        reinforce_enabled: false,
        reinforce_max_boost: 0.15,
        reinforce_require_host_arbitration: false,
        routing_mode: "off",
      },
    };
    const client = makeClient(server);
    const result = await client.updateSearchConfig({ contextId: "c", reinforceEnabled: false });
    const config: SearchConfig = result.config;
    expect(config.reinforce_enabled).toBe(false);
    expect(config.routing_mode).toBe("off");
  });
});

describe("edges", () => {
  it("listEdges returns the edges array", async () => {
    const server = new FakeServer();
    server.toolResults.list_edges = {
      status: "success",
      edges: [{ source_id: "a", target_id: "b", edge_type: "related_to", weight: 0.5 }],
    };
    const client = makeClient(server);
    const edges = await client.listEdges({ contextId: "c", memoryId: "a" });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target_id).toBe("b");
  });

  it("deleteEdge defaults to true when the server omits 'deleted'", async () => {
    const server = new FakeServer();
    server.toolResults.delete_edge = { status: "success" };
    const client = makeClient(server);
    await expect(
      client.deleteEdge({ contextId: "c", sourceId: "a", targetId: "b" }),
    ).resolves.toBe(true);
  });
});

describe("listTags validation", () => {
  it.each([
    [{ limit: 0 }, /limit must be between/],
    [{ limit: 501 }, /limit must be between/],
    [{ minCount: 0 }, /minCount must be between/],
    [{ prefix: "x".repeat(201) }, /prefix must be at most/],
  ])("rejects %o", async (overrides, pattern) => {
    const client = makeClient(new FakeServer());
    await expect(client.listTags({ contextId: "c", ...overrides })).rejects.toThrow(pattern);
  });

  it("only sends a non-empty prefix", async () => {
    const server = new FakeServer();
    server.toolResults.list_tags = { context_id: "c", tags: [], total: 0 };
    const client = makeClient(server);
    await client.listTags({ contextId: "c" });
    expect(server.toolCallArgs()).toEqual({ context_id: "c", limit: 50, min_count: 1, sort: "count" });
  });

  it.each([[undefined], [[]], [["  ", ""]]])(
    "stays on MCP list_tags, with no with_tags, for withTags %o",
    async (withTags) => {
      // An empty drill-down is a no-op filter server-side (`tags @> '{}'`),
      // and blank values are dropped before it is judged empty.
      const server = new FakeServer();
      server.toolResults.list_tags = { context_id: "c", context_name: "n", tags: [], total: 0 };
      const client = makeClient(server);
      await client.listTags({ contextId: "c", ...(withTags === undefined ? {} : { withTags }) });
      expect(server.toolCallArgs()).toEqual({ context_id: "c", limit: 50, min_count: 1, sort: "count" });
      expect(server.requests.every((r) => r.method === "POST")).toBe(true);
    },
  );

  it.each([
    [Array.from({ length: 51 }, (_, i) => `t${i}`), /withTags accepts at most 50 tags, got 51/],
    [["ok", "x".repeat(201)], /each withTags value must be at most 200 characters, got 201/],
  ])("rejects withTags %#, before any request", async (withTags, pattern) => {
    const server = new FakeServer();
    const client = makeClient(server);
    await expect(client.listTags({ contextId: "c", withTags })).rejects.toThrow(pattern);
    expect(server.requests).toEqual([]);
  });
});

describe("listTags withTags drill-down (#47)", () => {
  // MCP list_tags has no with_tags through server v0.76.0 and drops it
  // silently, so a drill-down goes to the REST route that has it.
  const TAGS_PATH = "/api/v1/contexts/c1/tags";
  const REST_BODY = {
    context_id: "c1",
    tags: [
      { tag: "when:2026-09", count: 2, sample_summary: null, last_used_at: "2026-09-01T00:00:00Z" },
    ],
    total: 1,
  };
  const MCP_BODY = {
    status: "success",
    context_id: "c1",
    context_name: "demo",
    tags: [{ tag: "client:acme", count: 5, last_used_at: null }],
    total: 1,
  };

  function drillServer(): FakeServer {
    const server = new FakeServer();
    server.restResults[TAGS_PATH] = REST_BODY;
    server.toolResults.list_tags = MCP_BODY;
    return server;
  }

  function toolCalls(server: FakeServer): Record<string, unknown>[] {
    return server.requests
      .filter((r) => r.body?.method === "tools/call")
      .map((r) => r.body!.params as Record<string, unknown>);
  }

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => {
        throw new Error("expected the call to reject");
      },
      (e: unknown) => e,
    );
  }

  it("sends the drill-down to the REST tags route as repeated, trimmed with_tags keys", async () => {
    const server = drillServer();
    const client = makeClient(server);
    await client.listTags({
      contextId: "c1",
      prefix: "when:",
      withTags: ["client:acme", " kind:invoice ", "  "],
    });

    const rest = server.requests[0]!;
    expect(rest.method).toBe("GET");
    const url = new URL(rest.url);
    expect(url.origin + url.pathname).toBe(`https://x.test${TAGS_PATH}`);
    // Repeated keys, never comma-joined: the server reads `a,b` as ONE tag.
    expect(url.searchParams.getAll("with_tags")).toEqual(["client:acme", "kind:invoice"]);
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("min_count")).toBe("1");
    expect(url.searchParams.get("sort")).toBe("count");
    expect(url.searchParams.get("prefix")).toBe("when:");
    expect(rest.headers.authorization).toBe("Bearer test-key");
    // No MCP call ever carries with_tags.
    for (const call of toolCalls(server)) {
      expect(call.arguments).not.toHaveProperty("with_tags");
    }
  });

  it("passes limit, minCount and sort through, and omits an empty prefix", async () => {
    const server = drillServer();
    const client = makeClient(server);
    await client.listTags({ contextId: "c1", limit: 7, minCount: 3, sort: "alpha", withTags: ["a"] });
    const params = new URL(server.requests[0]!.url).searchParams;
    expect(params.get("limit")).toBe("7");
    expect(params.get("min_count")).toBe("3");
    expect(params.get("sort")).toBe("alpha");
    expect(params.has("prefix")).toBe(false);
  });

  it("returns the MCP path's exact shape, naming the context via list_tags limit 1", async () => {
    const server = drillServer();
    const client = makeClient(server);
    const result = await client.listTags({ contextId: "c1", withTags: ["client:acme"] });

    expect(result).toEqual({
      status: "success",
      context_id: "c1",
      context_name: "demo",
      tags: [{ tag: "when:2026-09", count: 2, last_used_at: "2026-09-01T00:00:00Z" }],
      total: 1,
    });
    // The REST route has no context_name. The lookup is list_tags itself:
    // the same access check as the REST route, and one tag of payload.
    expect(toolCalls(server)).toEqual([
      { name: "list_tags", arguments: { context_id: "c1", limit: 1 } },
    ]);
    // REST first, so its errors are the ones a caller sees.
    expect(server.requests[0]!.method).toBe("GET");
  });

  it("maps a missing last_used_at to null, as the MCP path sends it", async () => {
    const server = drillServer();
    server.restResults[TAGS_PATH] = { context_id: "c1", tags: [{ tag: "a", count: 1 }], total: 1 };
    const client = makeClient(server);
    const result = await client.listTags({ contextId: "c1", withTags: ["b"] });
    expect(result.tags).toEqual([{ tag: "a", count: 1, last_used_at: null }]);
  });

  it("reuses the name a plain listTags returned, with no extra call", async () => {
    const server = drillServer();
    const client = makeClient(server);
    await client.listTags({ contextId: "c1" });
    const result = await client.listTags({ contextId: "c1", withTags: ["client:acme"] });

    expect(result.context_name).toBe("demo");
    expect(toolCalls(server)).toHaveLength(1); // the plain call only
  });

  it("looks a context's name up once per client", async () => {
    const server = drillServer();
    const client = makeClient(server);
    await client.listTags({ contextId: "c1", withTags: ["a"] });
    await client.listTags({ contextId: "c1", withTags: ["b"] });
    expect(toolCalls(server)).toHaveLength(1);

    // The cache belongs to the client, not the process.
    await makeClient(server).listTags({ contextId: "c1", withTags: ["a"] });
    expect(toolCalls(server)).toHaveLength(2);
  });

  it("keys the name cache on the canonical id the server returns", async () => {
    // The caller may spell the UUID in upper case; both routes answer with
    // the canonical lower-case form.
    const id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const server = new FakeServer();
    server.restResults[`/api/v1/contexts/${id.toUpperCase()}/tags`] = { ...REST_BODY, context_id: id };
    server.toolResults.list_tags = { ...MCP_BODY, context_id: id };
    const client = makeClient(server);
    await client.listTags({ contextId: id.toUpperCase() });
    const result = await client.listTags({ contextId: id.toUpperCase(), withTags: ["a"] });

    expect(result.context_id).toBe(id);
    expect(result.context_name).toBe("demo");
    expect(toolCalls(server)).toHaveLength(1);
  });

  it("throws KaguraNotFoundError on a REST 404, and looks no name up", async () => {
    const server = new FakeServer(); // no REST result → 404
    const client = makeClient(server);
    const err = await rejection(client.listTags({ contextId: "c1", withTags: ["a"] }));

    expect(err).toBeInstanceOf(KaguraNotFoundError);
    expect((err as Error).message).toBe("list_tags: Not Found");
    expect(server.requests).toHaveLength(1);
  });

  it("throws KaguraError, not KaguraConnectionError, on a REST 422", async () => {
    const server = new FakeServer();
    server.forcedResponse = new Response(
      JSON.stringify({ detail: "with_tags accepts at most 50 tags." }),
      { status: 422 },
    );
    const client = makeClient(server);
    const err = await rejection(client.listTags({ contextId: "c1", withTags: ["a"] }));

    expect(err).toBeInstanceOf(KaguraError);
    expect(err).not.toBeInstanceOf(KaguraConnectionError);
    expect((err as Error).message).toBe(
      "list_tags failed (invalid_argument): with_tags accepts at most 50 tags.",
    );
  });

  it("formats a FastAPI validation 422 the same way", async () => {
    const server = new FakeServer();
    server.forcedResponse = new Response(
      JSON.stringify({
        detail: [{ loc: ["path", "context_id"], msg: "Input should be a valid UUID", type: "uuid_parsing" }],
      }),
      { status: 422 },
    );
    const client = makeClient(server);
    const err = await rejection(client.listTags({ contextId: "nope", withTags: ["a"] }));

    expect(err).toBeInstanceOf(KaguraError);
    expect(err).not.toBeInstanceOf(KaguraConnectionError);
    expect((err as Error).message).toMatch(/^list_tags failed \(invalid_argument\): .*valid UUID/);
  });

  it.each([
    [401, KaguraAuthError],
    [429, KaguraRateLimitError],
  ])("keeps the standard mapping for HTTP %i", async (status, errorClass) => {
    const server = new FakeServer();
    server.forcedResponse = new Response(JSON.stringify({ detail: "no" }), { status });
    const client = makeClient(server);
    await expect(client.listTags({ contextId: "c1", withTags: ["a"] })).rejects.toBeInstanceOf(
      errorClass,
    );
  });

  it("throws KaguraNotFoundError when the name lookup cannot see the context", async () => {
    const server = drillServer();
    server.toolResults.list_tags = {
      status: "error",
      error: "context_not_found",
      message: "Context not found or you don't have access to it.",
    };
    const client = makeClient(server);
    await expect(client.listTags({ contextId: "c1", withTags: ["a"] })).rejects.toBeInstanceOf(
      KaguraNotFoundError,
    );
  });

  it("throws KaguraConnectionError when the name lookup has no context_name", async () => {
    const server = drillServer();
    server.toolResults.list_tags = { status: "success", context_id: "c1", tags: [], total: 0 };
    const client = makeClient(server);
    await expect(client.listTags({ contextId: "c1", withTags: ["a"] })).rejects.toThrow(
      /Unexpected list_tags response: missing 'context_name'/,
    );
  });

  it.each([
    [{ context_id: "c1", total: 0 }],
    [{ context_id: "c1", tags: [] }],
    [{ tags: [], total: 0 }],
    [{ context_id: "c1", tags: [{ tag: "a" }], total: 1 }],
  ])("throws KaguraConnectionError on a malformed REST body %o", async (body) => {
    const server = drillServer();
    server.restResults[TAGS_PATH] = body;
    const client = makeClient(server);
    const err = await rejection(client.listTags({ contextId: "c1", withTags: ["a"] }));

    expect(err).toBeInstanceOf(KaguraConnectionError);
    expect((err as Error).message).toMatch(/^Unexpected list_tags response/);
    expect(toolCalls(server)).toEqual([]);
  });

  it("drops blank values before counting them against the 50-tag cap", async () => {
    const server = drillServer();
    const client = makeClient(server);
    const withTags = [...Array.from({ length: 50 }, (_, i) => `t${i}`), ...Array(10).fill("  ")];
    await client.listTags({ contextId: "c1", withTags });
    expect(new URL(server.requests[0]!.url).searchParams.getAll("with_tags")).toHaveLength(50);
  });

  it("measures the 200-character cap in characters, as the server does", async () => {
    // Python's len() counts code points; a UTF-16 .length would count this
    // tag as 400 and refuse a value the server accepts.
    const server = drillServer();
    const client = makeClient(server);
    await client.listTags({ contextId: "c1", withTags: ["🏷".repeat(200)] });
    expect(new URL(server.requests[0]!.url).searchParams.get("with_tags")).toBe("🏷".repeat(200));
  });

  it("uses the REST base URL of a workspace-scoped MCP URL", async () => {
    const server = drillServer();
    const client = makeClient(server, { mcpUrl: "https://x.test/mcp/w/ws-1?profile=core" });
    await client.listTags({ contextId: "c1", withTags: ["a"] });
    expect(server.requests[0]!.url).toMatch(/^https:\/\/x\.test\/api\/v1\/contexts\/c1\/tags\?/);
    // The name lookup is an MCP call and keeps the MCP URL as given.
    expect(server.requests[1]!.url).toBe("https://x.test/mcp/w/ws-1?profile=core");
  });

  it("encodes the context id into one path segment", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.listTags({ contextId: "a/b", withTags: ["a"] }).catch(() => undefined);
    expect(new URL(server.requests[0]!.url).pathname).toBe("/api/v1/contexts/a%2Fb/tags");
  });
});

describe("recallNearby (#5)", () => {
  it("sends the WHERE-axis args with defaults and returns the typed response", async () => {
    const server = new FakeServer();
    server.toolResults.recall_nearby = {
      status: "success",
      context_id: "ctx",
      context_name: "demo",
      results: [
        { memory_id: "m1", summary: "s", type: "note", details: {}, distance_m: 42.5 },
      ],
    };
    const client = makeClient(server);
    const result = await client.recallNearby({ contextId: "ctx", lat: 35.68, lon: 139.76 });

    expect(result.status).toBe("success");
    expect(result.results[0]!.distance_m).toBe(42.5);
    expect(server.toolCallArgs()).toEqual({
      context_id: "ctx",
      lat: 35.68,
      lon: 139.76,
      radius_m: 1000,
      k: 20,
    });
  });

  it("forwards explicit radiusM and k", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.recallNearby({ contextId: "ctx", lat: 0, lon: 0, radiusM: 250, k: 5 });
    expect(server.toolCallArgs()).toMatchObject({ radius_m: 250, k: 5 });
  });

  it.each([
    [{ lat: 90.1, lon: 0 }, /lat must be a finite number between -90 and 90/],
    [{ lat: -90.1, lon: 0 }, /lat must be a finite number between -90 and 90/],
    [{ lat: Number.NaN, lon: 0 }, /lat must be a finite number between -90 and 90/],
    [{ lat: 0, lon: 180.1 }, /lon must be a finite number between -180 and 180/],
    [{ lat: 0, lon: -180.1 }, /lon must be a finite number between -180 and 180/],
    [{ lat: 0, lon: Number.POSITIVE_INFINITY }, /lon must be a finite number between -180 and 180/],
  ])("rejects out-of-range coordinates %o", async (coords, pattern) => {
    const client = makeClient(new FakeServer());
    await expect(client.recallNearby({ contextId: "c", ...coords })).rejects.toThrow(pattern);
  });

  it("accepts the exact range boundaries", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await expect(
      client.recallNearby({ contextId: "c", lat: -90, lon: 180 }),
    ).resolves.toBeDefined();
  });
});

describe("loadGuardrails (#41)", () => {
  const item = {
    summary: "s",
    type: "rule",
    importance: 0.9,
    source_type: "manual",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  };
  const payload = {
    status: "success",
    format: 1,
    version: "v1-abc",
    pinned: [
      {
        ...item,
        memory_id: "m-pin",
        context_summary: "why",
        delivery_mode: "always",
        tool_trigger: null,
        authored_by_caller: true,
      },
    ],
    tool_triggered: [
      {
        ...item,
        memory_id: "m-tool",
        context_summary: null,
        delivery_mode: "on_recall",
        tool_trigger: { tool: "Bash", on: "pre", match: "gh pr merge", action: "block" },
        authored_by_caller: false,
      },
    ],
    total_available: 2,
    truncated: false,
    cap: 50,
    pinned_cap: 100,
    pinned_total_available: 1,
    pinned_truncated: false,
    tool_triggered_total_available: 1,
    tool_triggered_truncated: false,
    context_id: "ctx",
    context_name: "demo",
  };

  it("sends only context_id when cap is unset and returns the typed response", async () => {
    const server = new FakeServer();
    server.toolResults.load_guardrails = payload;
    const client = makeClient(server);
    const result = await client.loadGuardrails({ contextId: "ctx" });

    expect(server.requests[1]!.body!.params).toMatchObject({ name: "load_guardrails" });
    // No client-side default: omitting cap leaves the server's (50) in charge.
    expect(server.toolCallArgs()).toEqual({ context_id: "ctx" });
    expect(result.tool_triggered[0]!.tool_trigger?.action).toBe("block");
    expect(result.pinned[0]!.tool_trigger).toBeNull();
    expect(result.tool_triggered_truncated).toBe(false);
  });

  it("forwards cap when set and omits an explicit undefined", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.loadGuardrails({ contextId: "ctx", cap: 5 });
    await client.loadGuardrails({ contextId: "ctx", cap: undefined });

    expect(server.toolCallArgs(0)).toEqual({ context_id: "ctx", cap: 5 });
    expect(server.toolCallArgs(1)).toEqual({ context_id: "ctx" });
  });

  it("throws KaguraNotFoundError for an unknown context", async () => {
    const server = new FakeServer();
    server.toolResults.load_guardrails = {
      status: "error",
      error: "context_not_found",
      message: "Context not found",
    };
    const client = makeClient(server);
    await expect(client.loadGuardrails({ contextId: "nope" })).rejects.toBeInstanceOf(
      KaguraNotFoundError,
    );
  });
});

describe("getContextInfo guardrails (#41)", () => {
  const context = { id: "ctx", name: "demo" };

  it("keeps absent, null, and a block distinguishable", async () => {
    const server = new FakeServer();
    const client = makeClient(server);

    server.toolResults.get_context_info = {
      status: "success",
      context,
      guardrails: {
        items: [
          {
            memory_id: "m1",
            summary: "s",
            importance: 0.8,
            authored_by_caller: true,
            source_type: "manual",
          },
        ],
        total_available: 1,
        truncated: false,
        tool_triggered_version: "v1-abc",
      },
    };
    const withBlock = await client.getContextInfo({ contextId: "ctx" });
    expect(withBlock.guardrails?.items[0]!.memory_id).toBe("m1");
    expect(withBlock.guardrails?.tool_triggered_version).toBe("v1-abc");

    // null (the read failed) and absent (?guardrails=off) mean different
    // things, so the SDK must not normalize one into the other.
    server.toolResults.get_context_info = { status: "success", context, guardrails: null };
    const failed = await client.getContextInfo({ contextId: "ctx" });
    expect(failed.guardrails).toBeNull();

    server.toolResults.get_context_info = { status: "success", context };
    const off = await client.getContextInfo({ contextId: "ctx" });
    expect("guardrails" in off).toBe(false);
  });
});

describe("REST endpoints", () => {
  it("getServerInfo hits the REST base URL derived from the MCP URL", async () => {
    const server = new FakeServer();
    server.restResults["/api/v1/system/info"] = { name: "memory-cloud", version: "0.20.0" };
    const client = makeClient(server, { mcpUrl: "https://x.test/mcp/w/ws-1" });
    const info = await client.getServerInfo();
    expect(info.version).toBe("0.20.0");
    expect(server.requests[0]!.url).toBe("https://x.test/api/v1/system/info");
    expect(server.requests[0]!.headers.authorization).toBe("Bearer test-key");
  });

  it("getServerInfo drops the MCP URL's query from the REST base URL (#38)", async () => {
    const server = new FakeServer();
    server.restResults["/api/v1/system/info"] = { name: "memory-cloud", version: "0.73.0" };
    const client = makeClient(server, { mcpUrl: "https://x.test/mcp?profile=core" });
    await client.getServerInfo();
    expect(server.requests[0]!.url).toBe("https://x.test/api/v1/system/info");
    // MCP calls still carry the query: the server reads the profile there.
    await client.listContexts();
    expect(server.requests).toHaveLength(3); // REST + MCP init + tool call
    for (const request of server.requests.slice(1)) {
      expect(request.url).toBe("https://x.test/mcp?profile=core");
    }
  });

  it("checkServerVersion returns info and never throws on old servers", async () => {
    const server = new FakeServer();
    server.restResults["/api/v1/system/info"] = { name: "mc", version: "0.1.0" };
    const client = makeClient(server);
    const info = await client.checkServerVersion();
    expect(info.version).toBe("0.1.0");
    expect(MIN_SERVER_VERSION).toBe("0.75.0");
  });

  it("checkServerVersion warns below MIN_SERVER_VERSION and is silent at it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const [version, warns] of [
        ["0.74.9", true],
        ["0.75.0", false],
        ["0.76.0", false],
      ] as const) {
        warn.mockClear();
        const server = new FakeServer();
        server.restResults["/api/v1/system/info"] = { name: "mc", version };
        await makeClient(server).checkServerVersion();
        expect(warn.mock.calls.length > 0, version).toBe(warns);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("listMemories normalizes q and builds query params", async () => {
    const server = new FakeServer();
    server.restResults["/api/v1/memory/list"] = { memories: [], total: 0, has_more: false };
    const client = makeClient(server);
    await client.listMemories({ contextId: "ctx", q: "  ", type: "note" });
    const url = new URL(server.requests[0]!.url);
    expect(url.pathname).toBe("/api/v1/memory/list");
    expect(url.searchParams.get("context_id")).toBe("ctx");
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.get("type")).toBe("note");
    expect(url.searchParams.get("limit")).toBe("50");

    await client.listMemories({ q: "  auth  " });
    const url2 = new URL(server.requests[1]!.url);
    expect(url2.searchParams.get("q")).toBe("auth");
  });

  it("getMemoryStats defaults to a sort field the server accepts", async () => {
    // Server v0.34.0 (#1046) dropped `use_count`; sending it is a 400.
    const server = new FakeServer();
    server.restResults["/api/v1/contexts/ctx/memory-stats"] = {
      memories: [],
      total: 0,
      sort_by: "access_count",
      sort_order: "desc",
    };
    const client = makeClient(server);
    await client.getMemoryStats({ contextId: "ctx" });
    const url = new URL(server.requests[0]!.url);
    expect(url.pathname).toBe("/api/v1/contexts/ctx/memory-stats");
    expect(url.searchParams.get("sort_by")).toBe("access_count");
    expect(url.searchParams.get("sort_order")).toBe("desc");

    await client.getMemoryStats({ contextId: "ctx", sortBy: "reference_count", sortOrder: "asc" });
    const url2 = new URL(server.requests[1]!.url);
    expect(url2.searchParams.get("sort_by")).toBe("reference_count");
    expect(url2.searchParams.get("sort_order")).toBe("asc");
  });

  it("maps REST 404 through the standard status mapping", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await expect(client.getEmbeddingStatus()).rejects.toBeInstanceOf(KaguraConnectionError);
  });
});

describe("sleep maintenance", () => {
  it("getSleepReport flattens the report envelope", async () => {
    const server = new FakeServer();
    server.toolResults.get_sleep_report = {
      status: "success",
      report: { report_id: "r1", context_id: "c1", run_status: "completed" },
      actions: [{ action: "merge" }],
      action_count: 1,
    };
    const client = makeClient(server);
    const detail = await client.getSleepReport({ contextId: "c1", reportId: "r1" });
    expect(detail.report_id).toBe("r1");
    expect(detail.action_count).toBe(1);
    expect(detail.actions).toHaveLength(1);
  });

  it("getSleepHistory returns reports and translates report_not_found", async () => {
    const server = new FakeServer();
    server.toolResults.get_sleep_history = { status: "success", reports: [{ report_id: "r1" }] };
    const client = makeClient(server);
    const history = await client.getSleepHistory({ contextId: "c1" });
    expect(history).toHaveLength(1);

    server.toolResults.get_sleep_report = {
      status: "error",
      error: "report_not_found",
      message: "no such report",
    };
    await expect(
      client.getSleepReport({ contextId: "c1", reportId: "nope" }),
    ).rejects.toBeInstanceOf(KaguraNotFoundError);
  });
});

describe("tool definitions", () => {
  it("returns the tools list from tools/list", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    const tools = await client.getToolDefinitions();
    expect(tools).toEqual([{ name: "recall" }]);
  });
});

describe("callRawTool (#28)", () => {
  it("reaches a tool the SDK has no typed wrapper for", async () => {
    const server = new FakeServer();
    server.toolResults.secret_list = { status: "success", secrets: [] };
    const client = makeClient(server);

    // The case that motivated it: every secret_* MCP tool was unreachable
    // because callTool is private, so a forgotten wrapper was a dead end.
    const result = await client.callRawTool("secret_list", { workspace_id: "w1" });

    expect(result).toEqual({ status: "success", secrets: [] });
    expect(server.requests[1]!.body!.params).toEqual({
      name: "secret_list",
      arguments: { workspace_id: "w1" },
    });
  });

  it("passes arguments through verbatim, with no camelCase mapping", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.callRawTool("some_tool", { context_id: "c", camelCase: 1 });

    // Deliberate: this is a raw escape hatch, so the caller owns wire form.
    // A silent snake_case conversion here would be worse than none, because
    // it would only cover the keys someone thought of.
    expect(server.requests[1]!.body!.params).toEqual({
      name: "some_tool",
      arguments: { context_id: "c", camelCase: 1 },
    });
  });

  it("defaults to empty arguments", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    await client.callRawTool("no_args_tool");
    expect(server.toolCallArgs()).toEqual({});
  });

  it("still translates domain errors instead of returning them as data", async () => {
    const server = new FakeServer();
    server.toolResults.secret_get = {
      status: "error",
      error: "secret_not_found",
      message: "no such secret",
    };
    const client = makeClient(server);
    const error = await client
      .callRawTool("secret_get", { name: "x" })
      .catch((e: unknown) => e);

    // The point is that it throws rather than handing back {status:"error"}
    // as if it were data. The *precise* class depends on the code being one
    // the SDK knows — `secret_not_found` is not, so it lands on the generic
    // KaguraError. That is documented on callRawTool rather than papered
    // over by guessing at codes nobody has verified against the server.
    expect(error).toBeInstanceOf(KaguraError);
    expect(error).not.toBeInstanceOf(KaguraNotFoundError);
    expect((error as Error).message).toBe(
      "secret_get failed (secret_not_found): no such secret",
    );
  });

  it("maps a code the SDK does know", async () => {
    const server = new FakeServer();
    server.toolResults.anything = {
      status: "error",
      error: "context_not_found",
      message: "Context xyz not found",
    };
    const client = makeClient(server);
    await expect(client.callRawTool("anything")).rejects.toBeInstanceOf(KaguraNotFoundError);
  });

  it("rejects an empty tool name", async () => {
    const client = makeClient(new FakeServer());
    await expect(client.callRawTool("  ")).rejects.toThrow(/toolName must be a non-empty string/);
    await expect(client.callRawTool("")).rejects.toThrow(/toolName must be a non-empty string/);
  });
});
