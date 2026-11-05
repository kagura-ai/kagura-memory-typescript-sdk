/**
 * memory-cloud v0.141.0 realignment (#85; the Python SDK 0.43.0's #299):
 * response fields, cursor paging, the write caps and the sleep arguments.
 *
 * **Models.** A v0.141.0-shaped body reaches the caller with every new
 * field, and the SDK's pydantic-parity readers fill a field an older
 * server leaves out with the Python model's default.
 *
 * **Paging and caps** (memory-cloud v0.82.0, #1743). A cursor argument is
 * sent only when set; `listAgents` follows `next_cursor` and stops on a
 * broken or repeated cursor or after 50 pages; `listEdges` (no cursor on
 * the server) warns when the server cut a direction; the `remember` /
 * `updateMemory` tag caps and the `setState` value cap are checked before
 * any request, at the server's bound.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { sleepReport } from "./sleepFixtures.js";

import { KaguraPartialRollbackError, KaguraResponseError } from "../src/errors.js";
import type {
  Agent,
  ContextInfo,
  ListContextsResponse,
  MemoryListResponse,
  SleepReport,
  SleepReportDetail,
  SleepReportSource,
} from "../src/models.js";
import {
  EMBEDDING_STATUS,
  INDEXER_STATUS_RESPONSE,
  readModel,
  SERVER_INFO,
  SLEEP_REPORT,
  SLEEP_REPORT_DETAIL,
} from "../src/pyModels.js";
import { FakeServer, makeClient } from "./fakeServer.js";

const CTX = "11111111-2222-4333-8444-555555555555";

function toolCalls(server: FakeServer): Array<{ name: string; arguments: Record<string, unknown> }> {
  return server.requests
    .filter((r) => r.body?.method === "tools/call")
    .map((r) => r.body!.params as { name: string; arguments: Record<string, unknown> });
}

/** A FakeServer answering `tool` with each page in turn. */
function paged(server: FakeServer, tool: string, pages: unknown[]): void {
  const fetch = server.fetch;
  let n = 0;
  server.fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    if (body?.method === "tools/call" && (body.params as { name: string }).name === tool) {
      server.toolResults[tool] = pages[Math.min(n, pages.length - 1)];
      n += 1;
    }
    return fetch(input, init);
  };
}

// ===========================================================================
// Models
// ===========================================================================

describe("v0.141.0 response fields", () => {
  it("ServerInfo reads the two plan flags, false from an older server", () => {
    const features = {
      neural_memory: true,
      research_tools: false,
      plan_page: true,
      byok: true,
      cost_display: true,
      managed_connectors: false,
      managed_llm: true,
      referrals: false,
      beta_invites: true,
      reranking: true,
    };
    const body = (extra: Record<string, unknown>) => ({
      name: "Kagura Memory Cloud",
      version: "0.141.0",
      search_defaults: { use_rerank: true, content_chunks_enabled: true },
      features: { ...features, ...extra },
    });
    const v0141 = readModel(
      body({ content_chunks_require_plan: true, llm_selector_require_plan: false }),
      SERVER_INFO,
      "KaguraClient.get_server_info",
    );
    expect(v0141.features).toEqual({ ...features, content_chunks_require_plan: true, llm_selector_require_plan: false });
    expect(v0141.search_defaults).toEqual({ use_rerank: true, content_chunks_enabled: true });
    const older = readModel(body({}), SERVER_INFO, "KaguraClient.get_server_info");
    expect(older.features).toMatchObject({ content_chunks_require_plan: false, llm_selector_require_plan: false });
    expect(() => readModel(body({ llm_selector_require_plan: "maybe" }), SERVER_INFO, "op")).toThrow(
      "features.llm_selector_require_plan: Input should be a valid boolean, unable to interpret input",
    );
  });

  it("getServerInfo returns a v0.141.0 body with its new flags", async () => {
    const server = new FakeServer();
    server.restResults["/api/v1/system/info"] = {
      name: "Kagura Memory Cloud",
      version: "0.141.0",
      features: { content_chunks_require_plan: true, llm_selector_require_plan: true },
    };
    const info = await makeClient(server).getServerInfo();
    expect(info.features?.content_chunks_require_plan).toBe(true);
    expect(info.features?.llm_selector_require_plan).toBe(true);
  });

  it("EmbeddingStatus reads embedding_attempted_at (v0.95.0+), null when absent", async () => {
    const body = {
      total: 2,
      by_status: { failed: 2 },
      failed_memories: [
        {
          id: "m-1",
          summary: "s",
          embedding_error: "claim_expired: the run outlived its claim on every retry",
          created_at: "2026-11-01T00:00:00Z",
          updated_at: null,
          embedding_attempted_at: "2026-11-02T00:00:00.5Z",
        },
        { id: "m-2", summary: "s", embedding_error: null, created_at: "2026-11-01T00:00:00Z", updated_at: null },
      ],
    };
    const read = readModel(body, EMBEDDING_STATUS, "KaguraClient.get_embedding_status") as {
      failed_memories: Array<Record<string, unknown>>;
    };
    expect(read.failed_memories.map((m) => m.embedding_attempted_at)).toEqual(["2026-11-02T00:00:00.500000Z", null]);
    expect(Object.keys(read.failed_memories[1]!).at(-1)).toBe("embedding_attempted_at");

    const server = new FakeServer();
    server.restResults["/api/v1/workspace/embedding-status"] = body;
    const status = await makeClient(server).getEmbeddingStatus();
    expect(status.failed_memories[0]!.embedding_attempted_at).toBe("2026-11-02T00:00:00.5Z");

    server.restResults["/api/v1/workspace/embedding-status"] = {
      ...body,
      failed_memories: [{ ...body.failed_memories[0], embedding_attempted_at: "yesterday" }],
    };
    await expect(makeClient(server).getEmbeddingStatus()).rejects.toThrow(
      /failed_memories\.0\.embedding_attempted_at: Input should be a valid datetime/,
    );
  });

  it.each([
    [{ failed_events: 3, skipped_reason: "plan_suspended" }, 3],
    [{}, 0],
  ])("IndexerStateMetrics reads failed_events (v0.135.0+) from %j", (metrics, expected) => {
    const read = readModel(
      {
        resource_id: "products",
        state: { job_status: "idle", active_version: 1, last_offset: 0, metrics },
      },
      INDEXER_STATUS_RESPONSE,
      "ResourceClient.get_indexer_status",
    ) as { state: { metrics: Record<string, unknown> } };
    expect(read.state.metrics.failed_events).toBe(expected);
    expect(Object.keys(read.state.metrics)).toEqual([
      "applied_upserts",
      "applied_deletes",
      "errors",
      "failed_events",
      "skipped_reason",
    ]);
  });

  it("SleepReport reads source (v0.138.0+), null from an older server, any string kept", () => {
    const row = {
      report_id: "r-1",
      status: "completed",
      memories_processed: 1,
      edges_created: 0,
      memories_merged: 0,
      memories_promoted: 0,
      llm_calls_made: 0,
      llm_tokens_used: 0,
    };
    const source: SleepReportSource = "analysis";
    expect(readModel({ ...row, source }, SLEEP_REPORT, "get_sleep_history").source).toBe("analysis");
    expect(readModel({ ...row, source: "future" }, SLEEP_REPORT, "get_sleep_history").source).toBe("future");
    expect(readModel(row, SLEEP_REPORT, "get_sleep_history").source).toBeNull();
  });

  it("SleepReport.llm_call_failures is null, not 0, when the server sends none or null", async () => {
    // Python's `llm_call_failures: int | None = None`; the type says so too
    // (this assignment would not compile with `number`).
    const older: SleepReport = {
      report_id: "r-1",
      status: "completed",
      memories_processed: 1,
      edges_created: 0,
      memories_merged: 0,
      memories_promoted: 0,
      llm_calls_made: 0,
      llm_tokens_used: 0,
      llm_call_failures: null,
    };
    expect(readModel(older, SLEEP_REPORT, "get_sleep_history").llm_call_failures).toBeNull();
    const absent: Record<string, unknown> = { ...older };
    delete absent.llm_call_failures;
    expect(readModel(absent, SLEEP_REPORT, "get_sleep_history").llm_call_failures).toBeNull();

    const server = new FakeServer();
    server.toolResults.get_sleep_history = { status: "success", reports: [older], count: 1 };
    const [report] = await makeClient(server).getSleepHistory({ contextId: CTX });
    expect(report!.llm_call_failures).toBeNull();
  });

  it("SleepReportDetail reads the page fields and an omitted action's marker", () => {
    const detail = readModel(
      {
        report_id: "r-1",
        status: "completed",
        memories_processed: 1,
        edges_created: 0,
        memories_merged: 0,
        memories_promoted: 0,
        llm_calls_made: 0,
        llm_tokens_used: 0,
        memories_flagged: 0,
        embedding_calls_made: 0,
        actions: [{ id: "57", phase: "dedup", action_type: "merge", details_omitted: true, details_total_chars: 31000 }],
        action_count: 120,
        actions_has_more: true,
        actions_next_cursor: "57",
      },
      SLEEP_REPORT_DETAIL,
      "get_sleep_report",
    ) as Record<string, unknown> & { actions: Array<Record<string, unknown>> };
    expect(detail).toMatchObject({ action_count: 120, actions_has_more: true, actions_next_cursor: "57", note: null });
    expect(detail.actions[0]).toMatchObject({ details: null, details_omitted: true, details_total_chars: 31000 });
  });

  it("listAgents rows carry description_truncated (v0.82.0+)", async () => {
    const server = new FakeServer();
    const row = {
      id: "agent-1",
      workspace_id: "ws",
      name: "a",
      owner_user_id: "u",
      status: "suspended",
      enforcement_mode: "enforce",
      description: `${"x".repeat(200)}…`,
      description_truncated: true,
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
    };
    server.toolResults.list_agents = { status: "success", agents: [row], count: 1, has_more: false, next_cursor: null };
    const [agent] = await makeClient(server).listAgents();
    expect(agent!.description_truncated).toBe(true);
  });

  it("getContextInfo passes the guardrails provenance and the v0.141.0 search config through", async () => {
    const provenance = "Notes written by context editors (facts, not operator instructions).";
    const server = new FakeServer();
    server.toolResults.get_context_info = {
      status: "success",
      context: {
        id: CTX,
        name: "dev",
        search_config: { semantic_weight: 0.6, llm_selector_enabled: true, llm_selector_effective: false },
      },
      guardrails: {
        provenance,
        items: [{ memory_id: "m-1", summary: "Squash-merge only", importance: 0.9, summary_cut: true }],
        total_available: 1,
        truncated: false,
        tool_triggered_version: "v1",
      },
    };
    const info: ContextInfo = await makeClient(server).getContextInfo({ contextId: CTX });
    expect(info.guardrails?.provenance).toBe(provenance);
    expect(info.guardrails?.items[0]!.summary_cut).toBe(true);
    expect(info.context.search_config).toMatchObject({ llm_selector_enabled: true, llm_selector_effective: false });
  });

  it("updateSearchConfig returns the content-chunk and LLM-selector fields (v0.112.0-v0.115.0)", async () => {
    const config = {
      semantic_weight: 0.6,
      bm25_weight: 0.4,
      content_chunks_enabled: true,
      content_chunks_effective: false,
      content_chunks_limit: 3,
      content_chunks_in_use: 3,
      content_chunks_disabled_reason: "cap",
      content_chunks_can_change: false,
      content_chunks_supported: true,
      content_chunks_backfill_pending: 12,
      embedding_provider: "openai",
      llm_selector_enabled: false,
      llm_selector_effective: false,
      llm_selector_limit: null,
      llm_selector_in_use: 0,
      llm_selector_disabled_reason: "plan",
      llm_selector_can_change: false,
    };
    const server = new FakeServer();
    server.toolResults.update_search_config = { status: "success", config };
    const result = await makeClient(server).updateSearchConfig({ contextId: CTX, useRerank: false });
    expect(result.config).toEqual(config);
  });

  it("listMemories rows carry observed_at as the stored text", async () => {
    const server = new FakeServer();
    const body: MemoryListResponse = {
      memories: [
        {
          id: "m-1",
          summary: "s",
          type: "note",
          scope: "persistent",
          importance: 0.5,
          created_at: "2026-11-01T00:00:00Z",
          updated_at: "2026-11-01T00:00:00Z",
          observed_at: "2024-03-07",
        },
        {
          id: "m-2",
          summary: "s",
          type: "note",
          scope: "persistent",
          importance: 0.5,
          created_at: "2026-11-01T00:00:00Z",
          updated_at: "2026-11-01T00:00:00Z",
          observed_at: "2024-03-07T09:30:00Z",
        },
      ],
      total: 2,
    } as MemoryListResponse;
    server.restResults["/api/v1/memory/list"] = body;
    const page = await makeClient(server).listMemories();
    expect(page.memories!.map((m) => m.observed_at)).toEqual(["2024-03-07", "2024-03-07T09:30:00Z"]);
  });

  it.each([[{ has_more: true }, true], [{}, undefined]])("listTags passes has_more through: %j", async (sent, expected) => {
    const server = new FakeServer();
    server.toolResults.list_tags = {
      status: "success",
      context_id: CTX,
      context_name: "dev",
      tags: [{ tag: "python", count: 3, last_used_at: null }],
      total: 1,
      ...sent,
    };
    const result = await makeClient(server).listTags({ contextId: CTX, limit: 500 });
    expect(result.has_more).toBe(expected);
    // The server's bound is still 1-500; only an MCP page is held to 200.
    expect(server.toolCallArgs(0).limit).toBe(500);
  });
});

describe("rollbackSleepRun requeue counts (v0.112.0+)", () => {
  const summary = {
    edges_deleted: 1,
    merges_reversed: 2,
    merges_unreversible: 1,
    importance_restored: 0,
    promotions_reversed: 0,
    importance_kept: 0,
    promotions_kept: 0,
    archives_restored: 1,
    chunks_requeued: 1,
    points_requeued: 2,
    errors: ["Action 42 (merge): edge changed"],
  };

  it("a clean rollback returns them", async () => {
    const server = new FakeServer();
    server.toolResults.rollback_sleep_run = {
      status: "rolled_back",
      report_id: "r-1",
      rollback_summary: { ...summary, merges_unreversible: 0, errors: [] },
    };
    const result = await makeClient(server).rollbackSleepRun({ contextId: CTX, reportId: "r-1" });
    expect(result.rollback_summary).toMatchObject({ chunks_requeued: 1, points_requeued: 2 });
  });

  it("a partial rollback's summary is checked with them, as Python's RollbackSummary does", async () => {
    const server = new FakeServer();
    server.toolResults.rollback_sleep_run = {
      status: "error",
      error: "partial_rollback",
      message: "1 action could not be reversed",
      report_id: "r-1",
      rollback_summary: summary,
    };
    const err = await makeClient(server)
      .rollbackSleepRun({ contextId: CTX, reportId: "r-1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraPartialRollbackError);
    expect((err as KaguraPartialRollbackError).summary).toMatchObject({ chunks_requeued: 1, points_requeued: 2 });

    server.toolResults.rollback_sleep_run = {
      status: "error",
      error: "partial_rollback",
      message: "1 action could not be reversed",
      report_id: "r-1",
      rollback_summary: { ...summary, points_requeued: "two" },
    };
    const drift = await makeClient(server)
      .rollbackSleepRun({ contextId: CTX, reportId: "r-1" })
      .catch((e: unknown) => e);
    expect(drift).toBeInstanceOf(KaguraPartialRollbackError);
    expect((drift as Error).message).toContain("(rollback_summary could not be read)");
    expect(((drift as Error).cause as Error).message).toContain(
      "points_requeued: Input should be a valid integer, unable to parse string as an integer",
    );
  });
});

// ===========================================================================
// Sleep arguments
// ===========================================================================

describe("getSleepReport paging (v0.82.0+)", () => {
  const report = { ...sleepReport("r-9"), source: "analysis" };

  it.each([
    [{}, { report_id: "r-9" }],
    [{ actionsCursor: "57" }, { report_id: "r-9", actions_cursor: "57" }],
    [
      { actionsCursor: "57", actionsLimit: 200, maxChars: 50_000 },
      { report_id: "r-9", actions_cursor: "57", actions_limit: 200, max_chars: 50_000 },
    ],
  ])("sends %j as %j and never context_id", async (options, expected) => {
    const server = new FakeServer();
    server.toolResults.get_sleep_report = { status: "success", report, actions: [], action_count: 0 };
    await makeClient(server).getSleepReport({ contextId: CTX, reportId: "r-9", ...options });
    expect(server.toolCallArgs(0)).toEqual(expected);
  });

  it("flattens the page keys and note from the envelope", async () => {
    const note = "This is an analysis report (source 'analysis'): it records the LLM spend of a Memory Analysis run.";
    const server = new FakeServer();
    server.toolResults.get_sleep_report = {
      status: "success",
      report,
      actions: [{ id: "57", phase: "dedup", action_type: "merge", details_omitted: true, details_total_chars: 31000 }],
      action_count: 120,
      actions_has_more: true,
      actions_next_cursor: "57",
      note,
    };
    const detail: SleepReportDetail = await makeClient(server).getSleepReport({ contextId: CTX, reportId: "r-9" });
    expect(detail).toMatchObject({
      report_id: "r-9",
      source: "analysis",
      action_count: 120,
      actions_has_more: true,
      actions_next_cursor: "57",
      note,
    });
    expect(detail.actions![0]).toMatchObject({ details_omitted: true, details_total_chars: 31000 });
  });

  it("adds no paging key an older server did not send", async () => {
    const server = new FakeServer();
    server.toolResults.get_sleep_report = { status: "success", report, actions: [], action_count: 0 };
    const detail = await makeClient(server).getSleepReport({ contextId: CTX, reportId: "r-9" });
    expect(Object.keys(detail)).toEqual([...Object.keys(report), "actions", "action_count"]);
  });
});

describe("getSleepHistory source (v0.138.0+)", () => {
  it.each([
    [undefined, { context_id: CTX, limit: 10 }],
    ["all" as const, { context_id: CTX, limit: 10, source: "all" }],
    ["analysis" as const, { context_id: CTX, limit: 10, source: "analysis" }],
  ])("source %j sends %j", async (source, expected) => {
    const server = new FakeServer();
    server.toolResults.get_sleep_history = { status: "success", reports: [], count: 0 };
    await makeClient(server).getSleepHistory({ contextId: CTX, ...(source !== undefined ? { source } : {}) });
    expect(server.toolCallArgs(0)).toEqual(expected);
  });
});

describe("every new argument is one memory-cloud v0.143.0 declares", () => {
  // The `inputSchema` properties of memory-cloud v0.143.0
  // (backend/src/mcp_server/tools/_definitions.py). From v0.82.0
  // (memory-cloud#1742) a tool refuses an argument its schema does not
  // declare with invalid_argument, so a wrong wire name fails every call.
  const DECLARED: Record<string, readonly string[]> = {
    get_sleep_report: ["actions_cursor", "actions_limit", "max_chars", "report_id"],
    get_sleep_history: ["context_id", "limit", "source"],
    list_contexts: ["cursor", "include_details", "include_stats", "include_summary", "limit", "name_contains"],
    get_state: ["context_id", "cursor", "key", "limit", "max_chars"],
    list_agents: ["cursor", "limit"],
    list_edges: ["context_id", "edge_types", "limit", "memory_id", "min_weight"],
  };

  it("a strict v0.143.0 fake accepts each method with every new option set", async () => {
    const server = new FakeServer();
    server.declaredArguments = DECLARED;
    server.toolResults.get_sleep_report = {
      status: "success",
      report: sleepReport("r-9"),
      actions: [],
      action_count: 0,
    };
    server.toolResults.get_sleep_history = { status: "success", reports: [], count: 0 };
    paged(server, "list_agents", [agentsPage(["a"], "1"), agentsPage(["b"])]);
    server.toolResults.list_edges = { status: "success", edges: [] };
    const client = makeClient(server);

    await client.getSleepReport({ contextId: CTX, reportId: "r-9", actionsCursor: "57", actionsLimit: 20, maxChars: 50_000 });
    await client.getSleepHistory({ contextId: CTX, limit: 5, source: "all" });
    await client.listContexts({ cursor: "100", nameContains: "dev", includeSummary: true, includeDetails: true });
    await client.getState({ contextId: CTX, cursor: "a" });
    expect(await client.listAgents()).toHaveLength(2);
    await client.listEdges({ contextId: CTX, memoryId: "m-1", minWeight: 0.1, edgeTypes: ["related_to"], limit: 10 });

    expect(toolCalls(server).map((c) => c.name)).toEqual([
      "get_sleep_report",
      "get_sleep_history",
      "list_contexts",
      "get_state",
      "list_agents",
      "list_agents",
      "list_edges",
    ]);
  });

  it("the strict fake refuses an argument v0.143.0 does not declare", async () => {
    const server = new FakeServer();
    server.declaredArguments = DECLARED;
    await expect(makeClient(server).callRawTool("get_sleep_history", { context_id: CTX, sources: "all" })).rejects.toThrow(
      "get_sleep_history does not accept the argument 'sources'",
    );
  });
});

// ===========================================================================
// Cursor paging
// ===========================================================================

describe("listContexts / getState cursor (v0.82.0+)", () => {
  it.each([
    [undefined, {}],
    ["100", { cursor: "100" }],
  ])("listContexts cursor %j sends %j", async (cursor, expected) => {
    const server = new FakeServer();
    server.toolResults.list_contexts = {
      status: "success",
      contexts: [{ id: CTX, name: "dev", is_private: true, is_locked: false }],
      count: 150,
      total: 1,
      has_more: true,
      next_cursor: "101",
    };
    const result: ListContextsResponse = await makeClient(server).listContexts(
      cursor !== undefined ? { cursor } : {},
    );
    expect(server.toolCallArgs(0)).toEqual(expected);
    expect([result.has_more, result.next_cursor]).toEqual([true, "101"]);
  });

  it("getState sends cursor in list mode", async () => {
    const server = new FakeServer();
    server.toolResults.get_state = { status: "success", states: { b: 2 }, count: 1, has_more: false, next_cursor: null };
    const result = await makeClient(server).getState({ contextId: CTX, cursor: "a" });
    expect(server.toolCallArgs(0)).toEqual({ context_id: CTX, cursor: "a" });
    expect(result.states).toEqual({ b: 2 });
  });

  it("getState refuses a cursor with a key before any request, in the Python SDK 0.44.0's words", async () => {
    const server = new FakeServer();
    // Python 0.43.0 said "cursor pages the list of entries; omit key to list
    // them"; 0.44.0 (#317), the parity target, names the argument.
    await expect(makeClient(server).getState({ contextId: CTX, key: "step", cursor: "a" })).rejects.toThrow(
      /^cursor: list mode only; omit key to list the entries$/,
    );
    // An empty cursor is still a cursor (Python's `is not None`).
    await expect(makeClient(server).getState({ contextId: CTX, key: "step", cursor: "" })).rejects.toThrow(
      /^cursor: list mode only; omit key to list the entries$/,
    );
    expect(server.requests).toEqual([]);
  });
});

function agentRow(name: string): Agent {
  return {
    id: `agent-${name}`,
    workspace_id: "ws",
    name,
    owner_user_id: "u",
    status: "active",
    enforcement_mode: "enforce",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  };
}

function agentsPage(names: string[], nextCursor: string | null = null): Record<string, unknown> {
  return {
    status: "success",
    agents: names.map(agentRow),
    count: names.length,
    has_more: nextCursor !== null,
    next_cursor: nextCursor,
  };
}

describe("listAgents follows next_cursor (v0.82.0+)", () => {
  it("reads every page: the first call sends nothing, then only cursor", async () => {
    const server = new FakeServer();
    paged(server, "list_agents", [agentsPage(["a", "b"], "2"), agentsPage(["c"])]);
    const agents = await makeClient(server).listAgents();
    expect(agents.map((a) => a.name)).toEqual(["a", "b", "c"]);
    expect(toolCalls(server)).toEqual([
      { name: "list_agents", arguments: {} },
      { name: "list_agents", arguments: { cursor: "2" } },
    ]);
  });

  it("drops a row an earlier page returned (the offset cursor shifted)", async () => {
    const server = new FakeServer();
    // "new" was registered after page 1, so "b" moved down onto page 2.
    paged(server, "list_agents", [agentsPage(["a", "b"], "2"), agentsPage(["b", "c"])]);
    const agents = await makeClient(server).listAgents();
    expect(agents.map((a) => a.id)).toEqual(["agent-a", "agent-b", "agent-c"]);
  });

  it("is one call against an older server", async () => {
    const server = new FakeServer();
    server.toolResults.list_agents = { status: "success", agents: [agentRow("a")], count: 1 };
    expect(await makeClient(server).listAgents()).toHaveLength(1);
    expect(toolCalls(server)).toEqual([{ name: "list_agents", arguments: {} }]);
  });

  it.each([
    [[agentsPage(["a"], "1"), agentsPage(["b"], "1")], "list_agents: unexpected server response (a page repeated an earlier next_cursor)"],
    [[{ ...agentsPage(["a"]), has_more: true }], "list_agents: unexpected server response (has_more without a next_cursor)"],
    [[{ ...agentsPage(["a"]), has_more: true, next_cursor: "" }], "list_agents: unexpected server response (has_more without a next_cursor)"],
  ])("stops on a broken cursor", async (pages, message) => {
    const server = new FakeServer();
    paged(server, "list_agents", pages);
    const err = await makeClient(server)
      .listAgents()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as KaguraResponseError).message).toBe(message);
    expect((err as KaguraResponseError).operation).toBe("list_agents");
  });

  it("gives up after 50 pages", async () => {
    const server = new FakeServer();
    paged(
      server,
      "list_agents",
      Array.from({ length: 51 }, (_, i) => agentsPage([`a${i}`], String(i + 1))),
    );
    await expect(makeClient(server).listAgents()).rejects.toThrow("list_agents: the list did not end within 50 pages");
    expect(toolCalls(server)).toHaveLength(50);
  });
});

describe("listEdges cut directions (v0.82.0+) and min_weight (v0.117.0+)", () => {
  let warn: MockInstance<(...args: unknown[]) => void>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const edge = { source_id: "m-1", target_id: "m-2", edge_type: "related_to", weight: 0.5, confidence: 1 };

  it.each([
    [{ outgoing_has_more: true, incoming_has_more: false }, "outgoing"],
    [{ outgoing_has_more: true, incoming_has_more: true }, "outgoing and incoming"],
    [{ outgoing_has_more: false, incoming_has_more: false }, null],
    [{}, null],
  ])("warns when the server cut a direction: %j", async (flags, warned) => {
    const server = new FakeServer();
    server.toolResults.list_edges = { status: "success", memory_id: "m-1", edges: [edge], count: 1, ...flags };
    const edges = await makeClient(server).listEdges({ contextId: CTX, memoryId: "m-1" });
    expect(edges).toHaveLength(1);
    if (warned === null) {
      expect(warn).not.toHaveBeenCalled();
    } else {
      expect(warn).toHaveBeenCalledWith(
        `list_edges returned 1 edges of memory m-1, but more ${warned} edges exist past the ` +
          "per-direction limit: raise limit (max 200), or narrow with min_weight / edge_types",
      );
    }
  });

  it.each([
    [10, false],
    [200, false],
    [500, true],
  ])("with limit %j warns only when the server's clamp made the cut (%j)", async (limit, warns) => {
    const server = new FakeServer();
    server.toolResults.list_edges = {
      status: "success",
      memory_id: "m-1",
      edges: [],
      count: 0,
      outgoing_has_more: true,
      incoming_has_more: false,
    };
    await makeClient(server).listEdges({ contextId: CTX, memoryId: "m-1", limit });
    expect(server.toolCallArgs(0).limit).toBe(limit);
    expect(warn).toHaveBeenCalledTimes(warns ? 1 : 0);
  });

  it("keeps sending min_weight 0.0, not the server's 0.05 default", async () => {
    const server = new FakeServer();
    server.toolResults.list_edges = { status: "success", edges: [] };
    await makeClient(server).listEdges({ contextId: CTX, memoryId: "m-1" });
    expect(server.toolCallArgs(0)).toEqual({ context_id: CTX, memory_id: "m-1", min_weight: 0 });
  });

  it("routes this warning and checkServerVersion's through the warn option, not console.warn", async () => {
    const server = new FakeServer();
    server.toolResults.list_edges = { status: "success", edges: [edge], outgoing_has_more: true };
    server.restResults["/api/v1/system/info"] = { name: "Kagura Memory Cloud", version: "0.70.0", features: {} };
    const messages: string[] = [];
    const client = makeClient(server, { warn: (message: string) => void messages.push(message) });

    await client.listEdges({ contextId: CTX, memoryId: "m-1" });
    await client.checkServerVersion();

    expect(messages).toEqual([
      "list_edges returned 1 edges of memory m-1, but more outgoing edges exist past the " +
        "per-direction limit: raise limit (max 200), or narrow with min_weight / edge_types",
      "Server version 0.70.0 is below the SDK's tested minimum 0.75.0. Some features may not work; " +
        "older servers may silently ignore unknown parameters.",
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a no-op warn option silences them", async () => {
    const server = new FakeServer();
    server.toolResults.list_edges = { status: "success", edges: [], incoming_has_more: true };
    await makeClient(server, { warn: () => {} }).listEdges({ contextId: CTX, memoryId: "m-1" });
    expect(warn).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Write caps (v0.82.0+), on every server
// ===========================================================================

/** `count` distinct tags of `length` characters. */
function tags(count: number, length = 5): string[] {
  return Array.from({ length: count }, (_, i) => String(i).padStart(length, "0").slice(-length));
}

describe("remember / updateMemory tag caps", () => {
  it.each([
    ["at the bound", tags(50, 100), null],
    ["an astral tag of 100 code points", ["😀".repeat(100)], null],
    ["51 tags", tags(51), "tags accepts at most 50 tags, got 51"],
    ["a 101-character tag", ["ok", "x".repeat(101)], "each tag must be at most 100 characters, got 101"],
    ["a 101-code-point astral tag", ["😀".repeat(101)], "each tag must be at most 100 characters, got 101"],
  ])("remember: %s", async (_name, list, message) => {
    const server = new FakeServer();
    const client = makeClient(server);
    const call = client.remember({ contextId: CTX, summary: "summary text", content: "c", tags: list });
    if (message === null) {
      await call;
      expect(server.toolCallArgs(0).tags).toEqual(list);
    } else {
      await expect(call).rejects.toThrow(message);
      expect(server.requests).toEqual([]);
    }
  });

  it.each([
    ["at the bound", tags(50, 100), null],
    ["51 tags", tags(51), "tags accepts at most 50 tags, got 51"],
    ["a 101-character tag", ["ok", "y".repeat(101)], "each tag must be at most 100 characters, got 101"],
  ])("updateMemory: %s", async (_name, list, message) => {
    const server = new FakeServer();
    const client = makeClient(server);
    const call = client.updateMemory({ contextId: CTX, memoryId: "m-1", tags: list });
    if (message === null) {
      await call;
      expect(server.toolCallArgs(0).tags).toEqual(list);
    } else {
      await expect(call).rejects.toThrow(message);
      expect(server.requests).toEqual([]);
    }
  });
});

describe("setState value cap", () => {
  // Compact JSON of a string is its characters plus two quotes, so these
  // sit at the 16,384-character bound and one past it. A non-ASCII value
  // counts one character per code point (`ensure_ascii=False`), as the
  // server counts it.
  it.each([
    ["ascii at the bound", "x".repeat(16_382), null],
    ["ascii one over", "x".repeat(16_383), 16_385],
    ["non-ASCII at the bound", "あ".repeat(16_382), null],
    ["astral at the bound", "😀".repeat(16_382), null],
    ["an object at the bound", { k: "x".repeat(16_376) }, null],
    ["an object one over", { k: "x".repeat(16_377) }, 16_385],
    // `\n` is written as two characters, a control character as six (`\u0001`).
    ["escapes counted as written", "\n".repeat(8_191), null],
    ["escapes over", "\u0001".repeat(2_731), 16_388],
    // 0.00001 reaches the server as a float, which it measures as Python's
    // repr `1e-05` (5 characters), not as the 7 of `0.00001`.
    ["floats as Python writes them", Array(2_730).fill(0.00001), null],
    ["floats as Python writes them, one over", Array(2_731).fill(0.00001), 16_387],
    ["an array of ints", Array(8_192).fill(1), 16_385],
  ])("%s", async (_name, value, refusedAt) => {
    const server = new FakeServer();
    const call = makeClient(server).setState({ contextId: CTX, key: "k", value });
    if (refusedAt === null) {
      await call;
      expect(server.toolCallArgs(0).value).toEqual(value);
    } else {
      await expect(call).rejects.toThrow(
        `value must be at most 16384 characters as compact JSON, got ${refusedAt}; ` +
          "store large data as a memory and keep its id in the state",
      );
      expect(server.requests).toEqual([]);
    }
  });
});
