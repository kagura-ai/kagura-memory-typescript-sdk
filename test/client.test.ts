import { describe, expect, it } from "vitest";

import { KaguraClient, MIN_SERVER_VERSION } from "../src/client.js";
import {
  KaguraAuthError,
  KaguraConnectionError,
  KaguraError,
  KaguraNotFoundError,
  KaguraQuotaError,
  KaguraRateLimitError,
} from "../src/errors.js";
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

  it("maps withTags to with_tags and omits it when unset or empty (#8)", async () => {
    const server = new FakeServer();
    server.toolResults.list_tags = { context_id: "c", tags: [], total: 0 };
    const client = makeClient(server);

    await client.listTags({ contextId: "c", prefix: "when:", withTags: ["client:acme"] });
    await client.listTags({ contextId: "c" });
    // An empty drill-down is a no-op filter server-side; omit it rather
    // than sending `tags @> '{}'`, mirroring how `prefix: ""` is dropped.
    await client.listTags({ contextId: "c", withTags: [] });

    expect(server.toolCallArgs(0)).toMatchObject({
      prefix: "when:",
      with_tags: ["client:acme"],
    });
    expect(server.toolCallArgs(1)).not.toHaveProperty("with_tags");
    expect(server.toolCallArgs(2)).not.toHaveProperty("with_tags");
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
    expect(MIN_SERVER_VERSION).toBe("0.17.1");
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
