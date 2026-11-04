/**
 * Page sizes on `listContexts` / `getState` (#89), the port of the Python
 * SDK 0.44.0's `tests/test_list_paging.py` (python-sdk#315).
 *
 * memory-cloud v0.82.0 (#1743) pages both lists and declares `limit` on
 * `list_contexts` (1-200; at most 20 with `include_details` and no
 * `name_contains`) and `limit` / `max_chars` on `get_state`.
 * `list_contexts` declares no `max_chars` up to v0.143.0, so none is sent:
 * from v0.82.0 an undeclared argument is refused (`invalid_argument`,
 * #1742). Servers before v0.82.0 ignore the arguments. Every request goes
 * through the real JSON-RPC transport against the fake server.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import type { ListContextsOptions } from "../src/client.js";
import { KaguraError } from "../src/errors.js";
import type { ListContextsResponse } from "../src/models.js";
import { FakeServer, makeClient } from "./fakeServer.js";

const CTX = "11111111-2222-4333-8444-555555555555";

/** The `inputSchema` properties memory-cloud v0.143.0 declares (`_definitions.py`). */
const DECLARED = {
  list_contexts: ["cursor", "include_details", "include_stats", "include_summary", "limit", "name_contains"],
  get_state: ["context_id", "cursor", "key", "limit", "max_chars"],
  create_context: ["description", "display_name", "embedding_model", "is_private", "name", "summary", "usage_guide"],
} as const;

function context(n: number): Record<string, unknown> {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `ctx-${n}`,
    is_private: false,
    is_locked: false,
    last_used_at: "2026-11-01T00:00:00Z",
  };
}

/** A strict v0.143.0 fake: an argument the tool does not declare is refused. */
function strictServer(): FakeServer {
  const server = new FakeServer();
  server.declaredArguments = { ...DECLARED };
  server.toolResults.list_contexts = {
    status: "success",
    contexts: [context(1)],
    count: 1,
    total: 1,
    has_more: false,
    next_cursor: null,
    limit: 500,
    can_create: true,
  };
  server.toolResults.get_state = {
    status: "success",
    context_id: CTX,
    states: { a: 1, b: { step: 2 } },
    count: 2,
    has_more: true,
    next_cursor: "b",
  };
  return server;
}

function toolCalls(server: FakeServer): Array<{ name: string; arguments: Record<string, unknown> }> {
  return server.requests
    .filter((r) => r.body?.method === "tools/call")
    .map((r) => r.body?.params as { name: string; arguments: Record<string, unknown> });
}

// ===========================================================================
// KaguraClient.listContexts({ limit })
// ===========================================================================

describe("listContexts({ limit }) (memory-cloud v0.82.0+, #89)", () => {
  it("sends no paging argument by default, so an older server sees nothing new", async () => {
    const server = strictServer();
    const client = makeClient(server);
    await client.listContexts();
    await client.listContexts({ includeDetails: true });
    expect(toolCalls(server).map((c) => c.arguments)).toEqual([{}, { include_details: true }]);
  });

  it.each([1, 20, 200])("sends limit %d and the cursor when set", async (limit) => {
    const server = strictServer();
    server.toolResults.list_contexts = {
      status: "success",
      contexts: [context(100)],
      count: 400,
      total: 1,
      has_more: true,
      next_cursor: String(100 + limit),
    };
    const result: ListContextsResponse = await makeClient(server).listContexts({ cursor: "100", limit });
    expect(server.toolCallArgs(0)).toEqual({ cursor: "100", limit });
    expect([result.has_more, result.next_cursor]).toEqual([true, String(100 + limit)]);
  });

  it.each<[string, ListContextsOptions, Record<string, unknown>]>([
    ["details-20", { includeDetails: true, limit: 20 }, { include_details: true, limit: 20 }],
    // nameContains lifts the 20-row cap on includeDetails pages.
    [
      "details-filtered-200",
      { includeDetails: true, nameContains: "auth", limit: 200 },
      { name_contains: "auth", include_details: true, limit: 200 },
    ],
    ["summary-200", { includeSummary: true, limit: 200 }, { include_summary: true, limit: 200 }],
  ])("%s pages are sent as given", async (_name, options, sent) => {
    const server = strictServer();
    await makeClient(server).listContexts(options);
    expect(server.toolCallArgs(0)).toEqual(sent);
  });

  it.each<[string, unknown, Record<string, unknown>]>([
    ["padded", "  auth ", { name_contains: "auth" }], // trimmed, as the server reads it
    ["blank", "   ", {}], // blank: no filter, so not sent
    ["empty", "", {}],
    ["null", null, {}], // Python's None: unset
    // Python's str.strip(): the \x1c-\x1f separators and NEL go, a BOM stays,
    // where JavaScript's trim() would do the opposite of both.
    ["python whitespace", "\u0085\u001cauth\u001f", { name_contains: "auth" }],
    ["bom", "﻿auth", { name_contains: "﻿auth" }],
    ["non-string", 123, { name_contains: 123 }], // left for the server to refuse
  ])("sends a %s nameContains as the server reads it", async (_name, nameContains, sent) => {
    const server = new FakeServer();
    await makeClient(server).listContexts({ nameContains, includeDetails: true } as unknown as ListContextsOptions);
    expect(server.toolCallArgs(0)).toEqual({ ...sent, include_details: true });
  });

  it.each<[string, unknown, string]>([
    ["0", { limit: 0 }, "limit must be an integer between 1 and 200, got 0"],
    ["201", { limit: 201 }, "limit must be an integer between 1 and 200, got 201"],
    // A boolean is not an integer, as on the server (`type(x) is int`).
    ["true", { limit: true }, "limit must be an integer between 1 and 200, got True"],
    ["50.5", { limit: 50.5 }, "limit must be an integer between 1 and 200, got 50.5"],
    ["'50'", { limit: "50" }, "limit must be an integer between 1 and 200, got '50'"],
    ["NaN", { limit: Number.NaN }, "limit must be an integer between 1 and 200, got nan"],
    // The server refuses this page with validation_error.
    [
      "details 21",
      { includeDetails: true, limit: 21 },
      "includeDetails returns full summaries: pass nameContains or a limit of at most 20, got 21",
    ],
    // A blank nameContains is trimmed to no filter on the server.
    [
      "details blank filter 21",
      { includeDetails: true, nameContains: "   ", limit: 21 },
      "includeDetails returns full summaries: pass nameContains or a limit of at most 20, got 21",
    ],
    // So is a non-string one (the cap is checked before its type there).
    [
      "details non-string filter 21",
      { includeDetails: true, nameContains: 123, limit: 21 },
      "includeDetails returns full summaries: pass nameContains or a limit of at most 20, got 21",
    ],
  ])("refuses limit %s before any request", async (_name, options, message) => {
    const server = strictServer();
    await expect(makeClient(server).listContexts(options as ListContextsOptions)).rejects.toThrow(
      new Error(message),
    );
    expect(server.requests).toEqual([]);
  });

  it("takes no maxChars: v0.82.0-v0.143.0 declare none on list_contexts and refuse an undeclared one", async () => {
    expectTypeOf<ListContextsOptions>().not.toHaveProperty("maxChars");
    const server = strictServer();
    // A caller that slips one in anyway (plain JavaScript) still sends none.
    await makeClient(server).listContexts({ limit: 5, maxChars: 20_000 } as ListContextsOptions);
    expect(server.toolCallArgs(0)).toEqual({ limit: 5 });
  });

  it("a strict v0.143.0 fake accepts every option at once", async () => {
    const server = strictServer();
    await makeClient(server).listContexts({
      nameContains: " dev ",
      includeSummary: true,
      includeDetails: true,
      includeStats: true,
      cursor: "100",
      limit: 200,
    });
    expect(toolCalls(server)).toEqual([
      {
        name: "list_contexts",
        arguments: {
          name_contains: "dev",
          include_summary: true,
          include_details: true,
          include_stats: true,
          cursor: "100",
          limit: 200,
        },
      },
    ]);
  });

  it("a server that refuses limit throws its invalid_argument once, without a retry", async () => {
    const server = new FakeServer();
    // A v0.82.0+ server whose list_contexts schema had no limit.
    server.declaredArguments = {
      list_contexts: ["cursor", "include_details", "include_stats", "include_summary", "name_contains"],
    };
    const error = await makeClient(server)
      .listContexts({ limit: 50 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraError);
    expect((error as KaguraError).message).toContain(
      "list_contexts does not accept the argument 'limit'. Arguments its inputSchema declares: " +
        "cursor, include_details, include_stats, include_summary, name_contains.",
    );
    expect(toolCalls(server).map((c) => c.arguments)).toEqual([{ limit: 50 }]);
  });
});

// ===========================================================================
// KaguraClient.createContext — the quota pre-check asks for one row
// ===========================================================================

describe("createContext's quota pre-check (#89)", () => {
  it("reads a one-row listContexts page: count / limit / can_create do not depend on the page", async () => {
    const server = strictServer();
    server.toolResults.create_context = { status: "success", context: { id: CTX, name: "dev" } };
    await makeClient(server).createContext({ name: "dev" });
    expect(toolCalls(server)).toEqual([
      { name: "list_contexts", arguments: { limit: 1 } },
      { name: "create_context", arguments: { name: "dev", is_private: true } },
    ]);
  });

  it("still refuses at the limit from that one row", async () => {
    const server = strictServer();
    server.toolResults.list_contexts = {
      status: "success",
      contexts: [context(1)],
      count: 3,
      total: 1,
      has_more: true,
      next_cursor: "1",
      limit: 3,
      can_create: false,
    };
    await expect(makeClient(server).createContext({ name: "dev" })).rejects.toThrow(
      "Context limit reached (3/3). Delete unused contexts or upgrade your plan.",
    );
    expect(toolCalls(server).map((c) => c.name)).toEqual(["list_contexts"]);
  });
});

// ===========================================================================
// KaguraClient.getState({ limit, maxChars })
// ===========================================================================

describe("getState({ limit, maxChars }) in list mode (memory-cloud v0.82.0+, #89)", () => {
  it("sends limit and max_chars only when set", async () => {
    const server = strictServer();
    const client = makeClient(server);
    await client.getState({ contextId: CTX });
    const result = await client.getState({ contextId: CTX, cursor: "a", limit: 2, maxChars: 10_000 });
    await client.getState({ contextId: CTX, limit: 200 });
    await client.getState({ contextId: CTX, maxChars: 100_000 });
    // `null` is unset, as Python's None is.
    await client.getState({ contextId: CTX, limit: null, maxChars: null } as unknown as { contextId: string });
    expect(toolCalls(server).map((c) => c.arguments)).toEqual([
      { context_id: CTX },
      { context_id: CTX, cursor: "a", limit: 2, max_chars: 10_000 },
      { context_id: CTX, limit: 200 },
      { context_id: CTX, max_chars: 100_000 },
      { context_id: CTX },
    ]);
    expect([result.has_more, result.next_cursor]).toEqual([true, "b"]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["limit 0", { limit: 0 }, "limit must be an integer between 1 and 200, got 0"],
    ["limit 201", { limit: 201 }, "limit must be an integer between 1 and 200, got 201"],
    ["limit true", { limit: true }, "limit must be an integer between 1 and 200, got True"],
    ["maxChars 9999", { maxChars: 9_999 }, "maxChars must be an integer between 10000 and 100000, got 9999"],
    [
      "maxChars 100001",
      { maxChars: 100_001 },
      "maxChars must be an integer between 10000 and 100000, got 100001",
    ],
    ["maxChars true", { maxChars: true }, "maxChars must be an integer between 10000 and 100000, got True"],
    [
      "maxChars '20000'",
      { maxChars: "20000" },
      "maxChars must be an integer between 10000 and 100000, got '20000'",
    ],
    [
      "maxChars 20000.5",
      { maxChars: 20_000.5 },
      "maxChars must be an integer between 10000 and 100000, got 20000.5",
    ],
  ])("refuses %s before any request", async (_name, paging, message) => {
    const server = strictServer();
    await expect(
      makeClient(server).getState({ contextId: CTX, ...paging } as { contextId: string }),
    ).rejects.toThrow(new Error(message));
    expect(server.requests).toEqual([]);
  });

  it.each<[Record<string, unknown>, string]>([
    [{ limit: 10 }, "limit: list mode only; omit key to list the entries"],
    [{ maxChars: 20_000 }, "maxChars: list mode only; omit key to list the entries"],
    [{ cursor: "a", limit: 10 }, "cursor, limit: list mode only; omit key to list the entries"],
    [
      { cursor: "a", limit: 10, maxChars: 20_000 },
      "cursor, limit, maxChars: list mode only; omit key to list the entries",
    ],
    // Out of range too: the key is what is wrong, so that is what it names.
    [{ limit: 0 }, "limit: list mode only; omit key to list the entries"],
  ])("refuses %j with a key before any request: the server reads them in list mode only", async (paging, message) => {
    const server = strictServer();
    await expect(
      makeClient(server).getState({ contextId: CTX, key: "step", ...paging } as { contextId: string }),
    ).rejects.toThrow(new Error(message));
    expect(server.requests).toEqual([]);
  });

  it("reads one key as before when no list-mode option is set", async () => {
    const server = strictServer();
    server.toolResults.get_state = { status: "success", key: "step", value: 2, found: true };
    await makeClient(server).getState({ contextId: CTX, key: "step" });
    expect(server.toolCallArgs(0)).toEqual({ context_id: CTX, key: "step" });
  });
});
