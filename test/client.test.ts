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

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/**
 * Minimal fake MCP + REST server behind a fetch stub — the TS analogue of
 * the httpx MockTransport used by the Python test suite.
 */
class FakeServer {
  requests: Recorded[] = [];
  /** Tool name → payload object serialized into content[0].text. */
  toolResults: Record<string, unknown> = {};
  /** URL path → REST GET JSON response. */
  restResults: Record<string, unknown> = {};
  /** When set, every request returns this raw response. */
  forcedResponse: Response | null = null;
  sessionId: string | null = "session-123";

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    this.requests.push({ url, method: init?.method ?? "GET", headers, body });

    if (this.forcedResponse) {
      return this.forcedResponse.clone();
    }

    const rpcMethod = body?.method;
    if (rpcMethod === "initialize") {
      const responseHeaders: Record<string, string> = {};
      if (this.sessionId) {
        responseHeaders["mcp-session-id"] = this.sessionId;
      }
      return new Response("{}", { status: 200, headers: responseHeaders });
    }
    if (rpcMethod === "tools/call") {
      const params = body?.params as { name: string };
      const payload = this.toolResults[params.name] ?? { status: "success" };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
        }),
        { status: 200 },
      );
    }
    if (rpcMethod === "tools/list") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "recall" }] } }),
        { status: 200 },
      );
    }

    // REST GET
    const path = new URL(url).pathname;
    const payload = this.restResults[path];
    if (payload === undefined) {
      return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  };

  /** Wire body of the Nth tools/call request (0-based among tool calls). */
  toolCallArgs(n = 0): Record<string, unknown> {
    const calls = this.requests.filter((r) => r.body?.method === "tools/call");
    const params = calls[n]?.body?.params as { arguments: Record<string, unknown> };
    return params.arguments;
  }
}

function makeClient(server: FakeServer, options: Record<string, unknown> = {}): KaguraClient {
  return new KaguraClient({
    apiKey: "test-key",
    mcpUrl: "https://x.test/mcp",
    fetch: server.fetch,
    ...options,
  });
}

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
    });
    expect(server.toolCallArgs(1)).toEqual({
      query: "q",
      k: 10,
      context_ids: ["a", "b"],
      use_rerank: true,
      filters: { type: "code" },
      search_mode: "semantic",
      include_explore_hints: true,
    });
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
