/**
 * The session-tool methods (#86): bootstrap, changesSince, listMatching,
 * rememberBatch, forget({ memoryIds }), describeTools, guide,
 * listRevisions and rollbackSession. Each sends exactly the arguments set,
 * under the server's names, refuses what the Python SDK 0.44.0 refuses
 * before any request, and maps the server's refusals as Python does.
 */

import { describe, expect, it } from "vitest";

import { KaguraClient, pythonOptionNames } from "../src/client.js";
import {
  KaguraCapacityLockedError,
  KaguraError,
  KaguraNotFoundError,
  KaguraPartialSessionRollbackError,
  KaguraPermissionError,
  KaguraQuotaError,
  KaguraResponseError,
} from "../src/errors.js";
import { FakeServer, makeClient } from "./fakeServer.js";

const CTX = "11111111-2222-4333-8444-555555555555";
const M1 = "aaaaaaaa-0000-4000-8000-000000000001";
const M2 = "aaaaaaaa-0000-4000-8000-000000000002";

function setup(tool?: string, reply?: unknown): { server: FakeServer; client: KaguraClient } {
  const server = new FakeServer();
  if (tool !== undefined) server.toolResults[tool] = reply;
  return { server, client: makeClient(server) };
}

/** The `tools/call` params of every call the client made. */
function toolCalls(server: FakeServer): { name: string; arguments: Record<string, unknown> }[] {
  return server.requests
    .filter((r) => r.body?.method === "tools/call")
    .map((r) => r.body?.params as { name: string; arguments: Record<string, unknown> });
}

/** Run `call`, expecting it to throw before any request. */
async function refusedLocally(
  call: (client: KaguraClient) => Promise<unknown>,
  message: string | RegExp,
): Promise<void> {
  const { server, client } = setup();
  await expect(call(client)).rejects.toThrow(message);
  expect(server.requests).toHaveLength(0);
}

const COMPONENTS = { changes: { status: "ok", changes: [], has_more: false } };
const BOOTSTRAP_OK = { status: "success", components: COMPONENTS };

describe("bootstrap", () => {
  it("sends context_id alone when nothing else is set", async () => {
    const { server, client } = setup("bootstrap", BOOTSTRAP_OK);
    const result = await client.bootstrap({ contextId: CTX });
    expect(toolCalls(server)).toEqual([{ name: "bootstrap", arguments: { context_id: CTX } }]);
    expect(result).toEqual(BOOTSTRAP_OK);
  });

  it("sends every option under its wire name", async () => {
    const { server, client } = setup("bootstrap", BOOTSTRAP_OK);
    await client.bootstrap({
      contextId: CTX,
      since: "7d",
      include: ["pinned", "changes"],
      maxChars: 5000,
      format: "index",
    });
    expect(toolCalls(server)[0]!.arguments).toEqual({
      context_id: CTX,
      since: "7d",
      include: ["pinned", "changes"],
      max_chars: 5000,
      format: "index",
    });
  });

  it("sends a Date since as its UTC instant, and full at 10000", async () => {
    const { server, client } = setup("bootstrap", BOOTSTRAP_OK);
    await client.bootstrap({ contextId: CTX, since: new Date("2026-11-01T09:00:00+09:00"), format: "full", maxChars: 10000 });
    expect(toolCalls(server)[0]!.arguments).toEqual({
      context_id: CTX,
      since: "2026-11-01T00:00:00.000Z",
      max_chars: 10000,
      format: "full",
    });
  });

  it("treats null options as unset, as Python's `is not None`", async () => {
    const { server, client } = setup("bootstrap", BOOTSTRAP_OK);
    await client.bootstrap({
      contextId: CTX,
      since: null as unknown as string,
      include: null as unknown as [],
      maxChars: null as unknown as number,
      format: null as unknown as "full",
    });
    expect(toolCalls(server)[0]!.arguments).toEqual({ context_id: CTX });
  });

  it.each([
    [{ include: [] }, "include must be a non-empty subset of pinned, upcoming, changes"],
    [{ include: ["pinned", "recall"] }, "include must be a non-empty subset of pinned, upcoming, changes"],
    [{ include: "pinned" }, "include must be a list of strings, not str"],
    [{ include: ["pinned", 1] }, "include[1] must be a str, got int"],
    [{ maxChars: 1999 }, "maxChars must be an integer between 2000 and 100000, got 1999"],
    [{ maxChars: 100001 }, "maxChars must be an integer between 2000 and 100000, got 100001"],
    [{ maxChars: 5000.5 }, "maxChars must be an integer between 2000 and 100000, got 5000.5"],
    [{ format: "short" }, "format must be 'full' or 'index', got 'short'"],
    [
      { format: "full", maxChars: 9999 },
      'format="full" needs maxChars of at least 10000; pass format="index" (or omit format) under it',
    ],
    [{ since: new Date(Number.NaN) }, "since must be a valid Date"],
  ])("refuses %j before any request", async (options, message) => {
    await refusedLocally((client) => client.bootstrap({ contextId: CTX, ...(options as object) }), message);
  });

  it("returns an unreadable guardrails block as null, as Python reads it", async () => {
    const reply = { components: COMPONENTS, guardrails: { items: "x" }, extra: 1 };
    const { client } = setup("bootstrap", reply);
    const result = await client.bootstrap({ contextId: CTX });
    expect(result.guardrails).toBeNull();
    // Nothing else changes, an unknown key included.
    expect(result).toEqual({ ...reply, guardrails: null });
  });

  it("keeps an absent guardrails absent (?guardrails=off) and a readable one as sent", async () => {
    const absent = await setup("bootstrap", BOOTSTRAP_OK).client.bootstrap({ contextId: CTX });
    expect("guardrails" in absent).toBe(false);
    const block = { items: [{ memory_id: M1, summary: "s" }], total_available: 1, truncated: false };
    const sent = await setup("bootstrap", { ...BOOTSTRAP_OK, guardrails: block }).client.bootstrap({ contextId: CTX });
    expect(sent.guardrails).toEqual(block);
  });

  it("throws KaguraResponseError for a reply without components", async () => {
    const { client } = setup("bootstrap", { status: "success" });
    const err = await client.bootstrap({ contextId: CTX }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as KaguraResponseError).operation).toBe("bootstrap");
    expect((err as Error).message).toContain("BootstrapResponse (components: Field required)");
  });

  it("throws KaguraNotFoundError for context_not_found", async () => {
    const { client } = setup("bootstrap", { status: "error", error: "context_not_found", message: "nope" });
    const err = await client.bootstrap({ contextId: CTX }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraNotFoundError);
    expect((err as KaguraError).code).toBe("context_not_found");
  });

  it("throws KaguraError with the code for a refused argument (an older server)", async () => {
    const { client } = setup("bootstrap", {
      status: "error",
      error: "invalid_argument",
      message: "bootstrap does not accept the argument 'format'.",
      unknown_arguments: ["format"],
    });
    const err = await client.bootstrap({ contextId: CTX, format: "index" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).code).toBe("invalid_argument");
    expect((err as KaguraError).details.unknown_arguments).toEqual(["format"]);
  });
});

const CHANGES_OK = { status: "success", changes: [], has_more: false };

describe("changesSince", () => {
  it("sends context_id and since alone when nothing else is set", async () => {
    const { server, client } = setup("changes_since", CHANGES_OK);
    expect(await client.changesSince({ contextId: CTX, since: "2026-11-01" })).toEqual(CHANGES_OK);
    expect(toolCalls(server)).toEqual([{ name: "changes_since", arguments: { context_id: CTX, since: "2026-11-01" } }]);
  });

  it("sends every option under its wire name, Dates as UTC instants", async () => {
    const { server, client } = setup("changes_since", CHANGES_OK);
    await client.changesSince({
      contextId: CTX,
      since: new Date("2026-11-04T09:00:00Z"),
      until: new Date("2026-11-04T10:00:00Z"),
      kinds: ["created", "restored"],
      cursor: "abc",
      limit: 20,
      sessionId: "sess_1",
      byMe: true,
      maxChars: 20000,
    });
    expect(toolCalls(server)[0]!.arguments).toEqual({
      context_id: CTX,
      since: "2026-11-04T09:00:00.000Z",
      until: "2026-11-04T10:00:00.000Z",
      kinds: ["created", "restored"],
      cursor: "abc",
      limit: 20,
      session_id: "sess_1",
      by_me: true,
      max_chars: 20000,
    });
  });

  it("sends byMe false, as Python sends False (`is not None`)", async () => {
    const { server, client } = setup("changes_since", CHANGES_OK);
    await client.changesSince({ contextId: CTX, since: "2026-11-01", byMe: false });
    expect(toolCalls(server)[0]!.arguments).toEqual({ context_id: CTX, since: "2026-11-01", by_me: false });
  });

  it.each([
    [{ kinds: "created" }, "kinds must be a list of strings, not str"],
    [{ maxChars: 9999 }, "maxChars must be an integer between 10000 and 100000, got 9999"],
    [{ until: new Date(Number.NaN) }, "until must be a valid Date"],
  ])("refuses %j before any request", async (options, message) => {
    await refusedLocally(
      (client) => client.changesSince({ contextId: CTX, since: "2026-11-01", ...(options as object) }),
      message,
    );
  });

  it("throws KaguraError with the server's code for a refused window", async () => {
    const { client } = setup("changes_since", {
      status: "error",
      error: "validation_error",
      message: "until must be later than since.",
    });
    const err = await client.changesSince({ contextId: CTX, since: "2026-11-01", until: "2026-10-01" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).code).toBe("validation_error");
    expect((err as Error).message).toBe("changes_since failed (validation_error): until must be later than since.");
  });

  it("throws KaguraResponseError for a reply without has_more", async () => {
    const { client } = setup("changes_since", { status: "success", changes: [] });
    const err = await client.changesSince({ contextId: CTX, since: "2026-11-01" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as KaguraResponseError).operation).toBe("changes_since");
  });
});

const LIST_OK = { status: "success", memories: [], total: 0, has_more: false };

describe("listMatching", () => {
  it("calls the MCP list tool with context_id alone when nothing else is set", async () => {
    const { server, client } = setup("list", LIST_OK);
    expect(await client.listMatching({ contextId: CTX })).toEqual(LIST_OK);
    expect(toolCalls(server)).toEqual([{ name: "list", arguments: { context_id: CTX } }]);
  });

  it("sends every option under its wire name", async () => {
    const { server, client } = setup("list", LIST_OK);
    await client.listMatching({
      contextId: CTX,
      filters: { type: "task", "details.status": "open" },
      orderBy: "observed_at",
      direction: "asc",
      cursor: "50",
      limit: 10,
      includeDetails: true,
      maxChars: 30000,
    });
    expect(toolCalls(server)[0]!.arguments).toEqual({
      context_id: CTX,
      filters: { type: "task", "details.status": "open" },
      order_by: "observed_at",
      direction: "asc",
      cursor: "50",
      limit: 10,
      include_details: true,
      max_chars: 30000,
    });
  });

  it("sends an empty filters object, and include_details only when true", async () => {
    const { server, client } = setup("list", LIST_OK);
    await client.listMatching({ contextId: CTX, filters: {}, includeDetails: false });
    expect(toolCalls(server)[0]!.arguments).toEqual({ context_id: CTX, filters: {} });
  });

  it("refuses an out-of-range maxChars before any request", async () => {
    await refusedLocally(
      (client) => client.listMatching({ contextId: CTX, maxChars: 100001 }),
      "maxChars must be an integer between 10000 and 100000, got 100001",
    );
  });

  it("throws KaguraResponseError (operation list) for a reply without total", async () => {
    const { client } = setup("list", { status: "success", memories: [], has_more: false });
    const err = await client.listMatching({ contextId: CTX }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as KaguraResponseError).operation).toBe("list");
  });
});

const ITEM = { summary: "S", content: "C", type: "note" };
const BATCH_OK = {
  status: "success",
  results: [{ index: 0, status: "success", memory_id: M1, scope: "persistent" }],
  count: 1,
  succeeded: 1,
  failed: 0,
};

describe("rememberBatch", () => {
  it("sends the items as given and nothing else when no option is set", async () => {
    const { server, client } = setup("remember_batch", BATCH_OK);
    const items = [ITEM, { ...ITEM, tags: ["a"], details: { tool_trigger: { tools: ["Bash"] } }, context_id: CTX }];
    expect(await client.rememberBatch({ contextId: CTX, items })).toEqual(BATCH_OK);
    // No SDK defaults: no importance, no type added.
    expect(toolCalls(server)).toEqual([{ name: "remember_batch", arguments: { context_id: CTX, items } }]);
  });

  it("sends every batch option under its wire name, false included", async () => {
    const { server, client } = setup("remember_batch", BATCH_OK);
    await client.rememberBatch({ contextId: CTX, items: [ITEM], atomic: false, dedupe: "check", tagsNormalize: true, verbose: false });
    expect(toolCalls(server)[0]!.arguments).toEqual({
      context_id: CTX,
      items: [ITEM],
      atomic: false,
      dedupe: "check",
      tags_normalize: true,
      verbose: false,
    });
  });

  it.each([
    ["not a list", "x", "items must be a list of dicts, got str"],
    ["empty", [], "items must hold 1 to 50 items, got 0"],
    ["51 items", Array.from({ length: 51 }, () => ITEM), "items must hold 1 to 50 items, got 51"],
    ["a non-object item", [ITEM, ["x"]], "items[1] must be a dict, got list"],
    [
      "batch-level keys on an item",
      [{ ...ITEM, dedupe: "off", verbose: true }],
      "items[0] carries dedupe, verbose: set dedupe / tags_normalize / verbose on rememberBatch itself, not on an item",
    ],
    [
      "another context's id",
      [{ ...ITEM, context_id: "other" }],
      "items[0] carries another context_id: the batch's context_id applies to every item",
    ],
    [
      "51 tags",
      [{ ...ITEM, tags: Array.from({ length: 51 }, (_v, i) => `t${i}`) }],
      "items[0]: tags accepts at most 50 tags, got 51",
    ],
    ["a 101-character tag", [ITEM, { ...ITEM, tags: ["x".repeat(101)] }], "items[1]: each tag must be at most 100 characters, got 101"],
  ])("refuses %s before any request", async (_name, items, message) => {
    await refusedLocally(
      (client) => client.rememberBatch({ contextId: CTX, items: items as never }),
      message,
    );
  });

  it.each(["batch_failed", "batch_refused"])("throws KaguraError %s with the rows in details.results", async (code) => {
    const results = [
      { index: 0, status: "error", error: "missing_fields", message: "Missing required field: content" },
      { index: 1, status: "skipped", message: "batch refused: another item is invalid" },
    ];
    const { client } = setup("remember_batch", {
      status: "error",
      error: code,
      message: "No item was written; see results.",
      results,
      count: 2,
      succeeded: 0,
      candidates: 0,
      failed: 1,
      skipped: 1,
    });
    const err = await client.rememberBatch({ contextId: CTX, items: [ITEM, ITEM], atomic: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).code).toBe(code);
    expect((err as KaguraError).details.results).toEqual(results);
  });

  it("throws KaguraError timeout without rows", async () => {
    const { client } = setup("remember_batch", {
      status: "error",
      error: "timeout",
      message: "The atomic batch did not finish in time and was rolled back; nothing was written.",
      count: 2,
    });
    const err = await client.rememberBatch({ contextId: CTX, items: [ITEM, ITEM], atomic: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).code).toBe("timeout");
    expect((err as KaguraError).details.results).toBeUndefined();
  });

  it("throws KaguraQuotaError for an atomic batch over the daily quota", async () => {
    const { client } = setup("remember_batch", {
      status: "error",
      error: "quota_exceeded",
      message: "Daily memory limit reached.",
      quota_type: "memories_per_day",
      current: 990,
      limit: 1000,
      count: 20,
    });
    const err = await client.rememberBatch({ contextId: CTX, items: [ITEM], atomic: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect((err as KaguraQuotaError).quotaType).toBe("memories_per_day");
    expect((err as KaguraQuotaError).code).toBe("quota_exceeded");
  });

  it("throws KaguraCapacityLockedError for a locked workspace", async () => {
    const { client } = setup("remember_batch", {
      status: "error",
      error: "capacity_locked",
      message: "The workspace is over its Free capacity.",
      gate: "capacity",
    });
    await expect(client.rememberBatch({ contextId: CTX, items: [ITEM] })).rejects.toBeInstanceOf(KaguraCapacityLockedError);
  });

  it("throws KaguraResponseError (operation remember_batch) for a reply without count", async () => {
    const { client } = setup("remember_batch", { status: "success", results: [], succeeded: 0, failed: 0 });
    const err = await client.rememberBatch({ contextId: CTX, items: [ITEM] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as KaguraResponseError).operation).toBe("remember_batch");
  });
});

const FORGET_OK = {
  status: "success",
  deleted_count: 2,
  memory_ids: [M1, M2],
  results: [
    { memory_id: M1, status: "deleted" },
    { memory_id: M2, status: "deleted" },
  ],
  count: 2,
  succeeded: 2,
  skipped: 0,
  failed: 0,
};

describe("forget({ memoryIds })", () => {
  it("sends context_id and memory_ids, as given, and no k", async () => {
    const { server, client } = setup("forget", FORGET_OK);
    const ids = [M1, `{${M2.toUpperCase()}}`];
    expect(await client.forget({ contextId: CTX, memoryIds: ids })).toEqual(FORGET_OK);
    expect(toolCalls(server)).toEqual([{ name: "forget", arguments: { context_id: CTX, memory_ids: ids } }]);
  });

  it.each([
    [{ memoryId: M2 }, "Provide exactly one of memoryId, memoryIds or query"],
    [{ query: "old" }, "Provide exactly one of memoryId, memoryIds or query"],
    [{ k: 5 }, "k applies to query mode only, not to memoryIds"],
  ])("refuses memoryIds with %j before any request", async (extra, message) => {
    await refusedLocally(
      (client) => client.forget({ contextId: CTX, memoryIds: [M1], ...(extra as object) } as never),
      message,
    );
  });

  it.each([
    [[], "memoryIds must hold 1 to 50 ids, got 0"],
    [Array.from({ length: 51 }, (_v, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`), "memoryIds must hold 1 to 50 ids, got 51"],
    [[M1, "abc-123"], "memoryIds[1] is not a memory UUID"],
    [[M1, M1.toUpperCase()], `memoryIds lists ${M1} more than once`],
    [M1, "memoryIds must be a list of strings, not str"],
    [[M1, 7], "memoryIds[1] must be a str, got int"],
  ])("refuses the ids %j before any request", async (memoryIds, message) => {
    await refusedLocally((client) => client.forget({ contextId: CTX, memoryIds: memoryIds as never }), message);
  });

  it("throws KaguraError batch_failed with the rows when every id failed", async () => {
    const results = [{ memory_id: M1, status: "error", error: "not_attempted", message: "send it again" }];
    const { client } = setup("forget", {
      status: "error",
      error: "batch_failed",
      message: "No id was deleted; see results.",
      deleted_count: 0,
      memory_ids: [],
      results,
      count: 1,
      succeeded: 0,
      skipped: 0,
      failed: 1,
    });
    const err = await client.forget({ contextId: CTX, memoryIds: [M1] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).code).toBe("batch_failed");
    expect((err as KaguraError).details.results).toEqual(results);
  });

  it("throws KaguraResponseError (operation forget) for a reply that is no ForgetBatchResult", async () => {
    // An older server ignored memory_ids and answered the single form.
    const { client } = setup("forget", { status: "success", deleted_count: 0, memory_ids: [] });
    const err = await client.forget({ contextId: CTX, memoryIds: [M1] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as KaguraResponseError).operation).toBe("forget");
  });

  it("leaves the single forms as they were: k only in query mode, default 10", async () => {
    const { server, client } = setup("forget", { status: "success", deleted_count: 1, memory_ids: [M1] });
    await client.forget({ contextId: CTX, memoryId: M1 });
    await client.forget({ contextId: CTX, query: "old" });
    expect(toolCalls(server).map((c) => c.arguments)).toEqual([
      { context_id: CTX, memory_id: M1 },
      { context_id: CTX, query: "old", k: 10 },
    ]);
    await expect(client.forget({ contextId: CTX })).rejects.toThrow("Provide either memoryId or query");
  });
});

describe("describeTools and guide", () => {
  it("describeTools sends nothing by default, then query and names", async () => {
    const { server, client } = setup("describe_tools", { status: "success", tools: [], listed: [] });
    await client.describeTools();
    await client.describeTools({ query: "graph", names: ["explore", "create_edge"] });
    expect(toolCalls(server)).toEqual([
      { name: "describe_tools", arguments: {} },
      { name: "describe_tools", arguments: { query: "graph", names: ["explore", "create_edge"] } },
    ]);
  });

  it("guide sends nothing by default, then the topics", async () => {
    const { server, client } = setup("guide", { status: "success", topics: [{ topic: "index", text: "…" }] });
    await client.guide();
    await client.guide(["recall", "remember.dedupe"]);
    expect(toolCalls(server)).toEqual([
      { name: "guide", arguments: {} },
      { name: "guide", arguments: { topics: ["recall", "remember.dedupe"] } },
    ]);
  });

  it.each([
    [(c: KaguraClient) => c.describeTools({ names: Array.from({ length: 21 }, (_v, i) => `t${i}`) }), "names holds at most 20 names, got 21"],
    [(c: KaguraClient) => c.describeTools({ names: "explore" as never }), "names must be a list of strings, not str"],
    [(c: KaguraClient) => c.guide(Array.from({ length: 21 }, (_v, i) => `t${i}`)), "topics holds at most 20 names, got 21"],
    [(c: KaguraClient) => c.guide([1] as never), "topics[0] must be a str, got int"],
  ])("refuses %#: over 20 names or not a list of strings, before any request", async (call, message) => {
    await refusedLocally(call, message);
  });

  it("throws KaguraResponseError for a guide reply without topics", async () => {
    const { client } = setup("guide", { status: "success" });
    const err = await client.guide().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as KaguraResponseError).operation).toBe("guide");
  });
});

const REVISIONS_OK = { status: "success", memory_id: M1, current_version: 1, revisions: [], has_more: false };

describe("listRevisions", () => {
  it("sends context_id and memory_id alone, then every option", async () => {
    const { server, client } = setup("list_revisions", REVISIONS_OK);
    await client.listRevisions({ contextId: CTX, memoryId: M1 });
    await client.listRevisions({ contextId: CTX, memoryId: M1, limit: 5, cursor: "c", maxChars: 10000 });
    expect(toolCalls(server)).toEqual([
      { name: "list_revisions", arguments: { context_id: CTX, memory_id: M1 } },
      { name: "list_revisions", arguments: { context_id: CTX, memory_id: M1, limit: 5, cursor: "c", max_chars: 10000 } },
    ]);
  });

  it("refuses an out-of-range maxChars before any request", async () => {
    await refusedLocally(
      (client) => client.listRevisions({ contextId: CTX, memoryId: M1, maxChars: 5000 }),
      "maxChars must be an integer between 10000 and 100000, got 5000",
    );
  });

  it("throws KaguraNotFoundError for a forgotten memory (memory_not_found)", async () => {
    const { client } = setup("list_revisions", { status: "error", error: "memory_not_found", message: "Memory not found." });
    await expect(client.listRevisions({ contextId: CTX, memoryId: M1 })).rejects.toBeInstanceOf(KaguraNotFoundError);
  });
});

const ROLLBACK_PLAN = { status: "dry_run", dry_run: true, plan: { forget: 1 }, items: [], events: 1, remaining: 0 };

describe("rollbackSession", () => {
  it("always sends dry_run, true by default", async () => {
    const { server, client } = setup("rollback_session", ROLLBACK_PLAN);
    expect(await client.rollbackSession({ contextId: CTX, sessionId: "sess_1" })).toEqual(ROLLBACK_PLAN);
    await client.rollbackSession({ contextId: CTX, sessionId: "sess_1", dryRun: false });
    expect(toolCalls(server)).toEqual([
      { name: "rollback_session", arguments: { context_id: CTX, dry_run: true, session_id: "sess_1" } },
      { name: "rollback_session", arguments: { context_id: CTX, dry_run: false, session_id: "sess_1" } },
    ]);
  });

  it("sends a window as since / until, Dates as UTC instants", async () => {
    const { server, client } = setup("rollback_session", ROLLBACK_PLAN);
    await client.rollbackSession({ contextId: CTX, since: new Date("2026-11-04T09:00:00Z"), until: "2026-11-04T10:00:00" });
    expect(toolCalls(server)[0]!.arguments).toEqual({
      context_id: CTX,
      dry_run: true,
      since: "2026-11-04T09:00:00.000Z",
      until: "2026-11-04T10:00:00",
    });
  });

  it.each([
    [{}, "Provide exactly one of sessionId or since"],
    [{ sessionId: "s", since: "2026-11-04" }, "Provide exactly one of sessionId or since"],
    [{ sessionId: "s", until: "2026-11-04" }, "until needs since"],
  ])("refuses %j before any request", async (options, message) => {
    await refusedLocally((client) => client.rollbackSession({ contextId: CTX, ...(options as object) }), message);
  });

  it("throws KaguraNotFoundError for session_not_found, keeping the envelope", async () => {
    const { client } = setup("rollback_session", {
      status: "error",
      error: "session_not_found",
      message: "No session with this id that you can roll back exists in this context.",
      session_id: "sess_1",
      help: "changes_since(...) lists a session's writes.",
    });
    const err = await client.rollbackSession({ contextId: CTX, sessionId: "sess_1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraNotFoundError);
    expect((err as KaguraError).code).toBe("session_not_found");
    expect((err as KaguraError).message).toBe(
      "rollback_session: No session with this id that you can roll back exists in this context.",
    );
    expect((err as KaguraError).help).toBe("changes_since(...) lists a session's writes.");
  });

  it.each(["no_writes_in_window", "already_rolled_back"])("throws KaguraError %s", async (code) => {
    const { client } = setup("rollback_session", { status: "error", error: code, message: "m", retryable: false });
    const err = await client.rollbackSession({ contextId: CTX, since: "2026-11-04" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraError);
    expect(err).not.toBeInstanceOf(KaguraPartialSessionRollbackError);
    expect((err as KaguraError).code).toBe(code);
    expect((err as KaguraError).retryable).toBe(false);
  });

  it("throws KaguraPermissionError below the editor role", async () => {
    const { client } = setup("rollback_session", {
      status: "error",
      error: "permission_denied",
      message: "Cannot roll back sessions.",
      required_role: "editor",
    });
    const err = await client.rollbackSession({ contextId: CTX, sessionId: "s" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraPermissionError);
    expect((err as KaguraPermissionError).requiredRole).toBe("editor");
  });

  it("throws KaguraResponseError (operation rollback_session) for a reply without dry_run", async () => {
    const { client } = setup("rollback_session", { status: "dry_run" });
    const err = await client.rollbackSession({ contextId: CTX, sessionId: "s" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as KaguraResponseError).operation).toBe("rollback_session");
  });
});

describe("pythonOptionNames (the CLI's marker)", () => {
  it.each([
    [
      (c: KaguraClient) => c.bootstrap(pythonOptionNames({ contextId: CTX, format: "full" as const, maxChars: 5000 })),
      'format="full" needs max_chars of at least 10000; pass format="index" (or omit format) under it',
    ],
    [
      (c: KaguraClient) => c.bootstrap(pythonOptionNames({ contextId: CTX, maxChars: 1999 })),
      "max_chars must be an integer between 2000 and 100000, got 1999",
    ],
    [
      (c: KaguraClient) => c.forget(pythonOptionNames({ contextId: CTX, memoryIds: [M1, "x"] })),
      "memory_ids[1] is not a memory UUID",
    ],
    [
      (c: KaguraClient) => c.forget(pythonOptionNames({ contextId: CTX, memoryIds: [M1], memoryId: M2 }) as never),
      "Provide exactly one of memory_id, memory_ids or query",
    ],
    [
      (c: KaguraClient) => c.forget(pythonOptionNames({ contextId: CTX, memoryIds: [M1], k: 3 }) as never),
      "k applies to query mode only, not to memory_ids",
    ],
  ])("names the options as Python does in local refusal %#, before any request", async (call, message) => {
    await refusedLocally(call, message);
  });

  it("changes nothing that is sent", async () => {
    const { server, client } = setup("forget", FORGET_OK);
    await client.forget(pythonOptionNames({ contextId: CTX, memoryIds: [M1, M2] }));
    expect(toolCalls(server)).toEqual([{ name: "forget", arguments: { context_id: CTX, memory_ids: [M1, M2] } }]);
  });
});

describe("session_not_found on any tool", () => {
  it("is KaguraNotFoundError through callRawTool too", async () => {
    const { client } = setup("changes_since", { status: "error", error: "session_not_found", message: "gone" });
    await expect(client.callRawTool("changes_since", {})).rejects.toBeInstanceOf(KaguraNotFoundError);
  });
});

/**
 * The argument names each tool's inputSchema declares
 * (`backend/src/mcp_server/tools/_definitions.py`): a strict fake refuses
 * any other, as memory-cloud v0.82.0+ does (`invalid_argument`).
 */
const DECLARED_V0_143: Record<string, readonly string[]> = {
  bootstrap: ["context_id", "format", "include", "max_chars", "since"],
  changes_since: ["by_me", "context_id", "cursor", "kinds", "limit", "max_chars", "session_id", "since", "until"],
  list: ["context_id", "cursor", "direction", "filters", "include_details", "limit", "max_chars", "order_by"],
  remember_batch: ["atomic", "context_id", "dedupe", "items", "tags_normalize", "verbose"],
  forget: ["context_id", "k", "memory_id", "memory_ids", "query"],
  describe_tools: ["names", "query"],
  guide: ["topics"],
  list_revisions: ["context_id", "cursor", "limit", "max_chars", "memory_id"],
  rollback_session: ["context_id", "dry_run", "session_id", "since", "until"],
};

/** v0.93.0, where the session tools start: no `format`, no `session_id` / `by_me`, no `memory_ids`. */
const DECLARED_V0_93: Record<string, readonly string[]> = {
  ...DECLARED_V0_143,
  bootstrap: ["context_id", "include", "max_chars", "since"],
  changes_since: ["context_id", "cursor", "kinds", "limit", "max_chars", "since", "until"],
  forget: ["context_id", "k", "memory_id", "query"],
};

function strict(declared: Record<string, readonly string[]>): { server: FakeServer; client: KaguraClient } {
  const server = new FakeServer();
  server.declaredArguments = declared;
  Object.assign(server.toolResults, {
    bootstrap: BOOTSTRAP_OK,
    changes_since: CHANGES_OK,
    list: LIST_OK,
    remember_batch: BATCH_OK,
    forget: FORGET_OK,
    describe_tools: { status: "success" },
    guide: { status: "success", topics: [] },
    list_revisions: REVISIONS_OK,
    rollback_session: ROLLBACK_PLAN,
  });
  return { server, client: makeClient(server) };
}

describe("a strict server: no undeclared argument is sent", () => {
  it("v0.143.0 accepts every method with every option set", async () => {
    const { server, client } = strict(DECLARED_V0_143);
    await client.bootstrap({ contextId: CTX, since: "7d", include: ["pinned"], maxChars: 5000, format: "index" });
    await client.changesSince({
      contextId: CTX,
      since: "2026-11-01",
      until: "2026-11-02",
      kinds: ["created"],
      cursor: "c",
      limit: 5,
      sessionId: "s",
      byMe: true,
      maxChars: 10000,
    });
    await client.listMatching({
      contextId: CTX,
      filters: { type: "task" },
      orderBy: "created_at",
      direction: "asc",
      cursor: "50",
      limit: 5,
      includeDetails: true,
      maxChars: 10000,
    });
    await client.rememberBatch({ contextId: CTX, items: [ITEM], atomic: true, dedupe: "off", tagsNormalize: true, verbose: true });
    await client.forget({ contextId: CTX, memoryIds: [M1, M2] });
    await client.describeTools({ query: "graph", names: ["explore"] });
    await client.guide(["recall"]);
    await client.listRevisions({ contextId: CTX, memoryId: M1, limit: 5, cursor: "c", maxChars: 10000 });
    await client.rollbackSession({ contextId: CTX, since: "2026-11-01", until: "2026-11-02", dryRun: false });
    await client.rollbackSession({ contextId: CTX, sessionId: "s" });
    expect(toolCalls(server).map((c) => c.name)).toEqual([
      "bootstrap",
      "changes_since",
      "list",
      "remember_batch",
      "forget",
      "describe_tools",
      "guide",
      "list_revisions",
      "rollback_session",
      "rollback_session",
    ]);
  });

  it("v0.93.0 accepts every call that leaves the newer options unset", async () => {
    const { client } = strict(DECLARED_V0_93);
    await client.bootstrap({ contextId: CTX, since: "7d", include: ["changes"], maxChars: 10000 });
    await client.changesSince({ contextId: CTX, since: "2026-11-01", kinds: ["created"], limit: 5 });
    await client.forget({ contextId: CTX, query: "old", k: 3 });
  });

  it.each([
    ["bootstrap format", (c: KaguraClient) => c.bootstrap({ contextId: CTX, format: "index" }), "'format'"],
    ["changesSince byMe", (c: KaguraClient) => c.changesSince({ contextId: CTX, since: "2026-11-01", byMe: true }), "'by_me'"],
    ["forget memoryIds", (c: KaguraClient) => c.forget({ contextId: CTX, memoryIds: [M1] }), "'memory_ids'"],
  ])("v0.93.0 refuses %s as invalid_argument, a KaguraError with the code", async (_name, call, argument) => {
    const { client } = strict(DECLARED_V0_93);
    const err = await call(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).code).toBe("invalid_argument");
    expect((err as Error).message).toContain(argument);
  });
});
