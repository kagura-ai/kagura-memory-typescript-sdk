import { describe, expect, it } from "vitest";

import type {
  AgentBootstrapResponse,
  AuditVerifyResponse,
  ContextInfo,
  Edge,
  IndexerStatusResponse,
  ListContextsResponse,
  ListTagsResponse,
  LoadGuardrailsResponse,
  MemoryListResponse,
  ResourceEventsListResponse,
  RollbackResult,
  SearchConfig,
  ServerInfo,
  SleepReport,
  SleepReportDetail,
  ToolTrigger,
  UsageInfo,
  UsageQuotaLimitOnly,
} from "../src/models.js";

// Compile-focused tests: the value here is that realistic wire payloads
// type-check against the interfaces. The runtime assertions are minimal.

const contextInfo: ContextInfo = {
  status: "success",
  context: {
    id: "ctx_abc123",
    name: "engineering-notes",
    display_name: "Engineering Notes",
    summary: null,
    is_private: true,
    is_locked: false,
    embedding_model: "text-embedding-3-small",
    embedding_dimensions: 1536,
    search_config: {
      semantic_weight: 0.6,
      bm25_weight: 0.4,
      fetch_factor: 3,
      use_rerank: false,
      reranker_provider: null,
      reranker_model: null,
    },
  },
  workspace: {
    id: "ws_xyz",
    name: "kagura-ai",
    description: null,
  },
  stats: {
    total_memories: 128,
    working_memories: 12,
    persistent_memories: 116,
    details: { by_type: { note: 90, decision: 38 } },
  },
  instructions: null,
};

const contextInfoWithGuardrails: ContextInfo = {
  context: { id: "ctx_abc123", name: "engineering-notes" },
  guardrails: {
    items: [
      {
        memory_id: "mem_g",
        summary: "Do not delete the branch when merging",
        importance: 0.9,
        authored_by_caller: false,
        source_type: "manual",
      },
    ],
    total_available: 1,
    truncated: false,
    tool_triggered_version: "v1-4f2c",
  },
};

// The write shape: `on` and `action` default server-side.
const minimalTrigger: ToolTrigger = { tool: "Bash|PowerShell" };

const guardrails: LoadGuardrailsResponse = {
  status: "success",
  format: 1,
  version: "v1-9a0e",
  pinned: [
    {
      memory_id: "mem_p",
      summary: "Answer in Japanese",
      context_summary: "Team convention",
      type: "rule",
      importance: 0.8,
      delivery_mode: "always",
      tool_trigger: null,
      source_type: "manual",
      authored_by_caller: true,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    },
  ],
  tool_triggered: [
    {
      memory_id: "mem_g",
      summary: "Do not delete the branch when merging",
      context_summary: null,
      type: "rule",
      importance: 0.9,
      delivery_mode: "on_recall",
      tool_trigger: {
        tool: "Bash",
        on: "pre",
        match: "gh pr merge\\b.*--delete-branch",
        action: "block",
      },
      source_type: "manual",
      authored_by_caller: false,
      created_at: "2026-09-02T00:00:00Z",
      updated_at: "2026-09-03T00:00:00Z",
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
  context_id: "ctx_abc123",
  context_name: "engineering-notes",
  context_display_name: null,
  context_is_private: true,
  context_is_locked: false,
};

const listTags: ListTagsResponse = {
  context_id: "ctx_abc123",
  context_name: "engineering-notes",
  tags: [
    { tag: "typescript", count: 42, last_used_at: "2026-07-01T09:30:00Z" },
    { tag: "pagination", count: 7, last_used_at: null },
  ],
  total: 2,
};

// The `config` echoed by update_search_config: every field, including the
// reinforce re-rank and routing knobs get_context_info does not return.
const searchConfig: SearchConfig = {
  semantic_weight: 0.6,
  bm25_weight: 0.4,
  fetch_factor: 3,
  use_rerank: true,
  reranker_provider: "self_hosted",
  reranker_model: null,
  reinforce_enabled: true,
  reinforce_max_boost: 0.15,
  reinforce_require_host_arbitration: false,
  routing_mode: "log_only",
};

// One default item and one carrying every opt-in field, so both shapes
// type-check against the same item interface.
const listContexts: ListContextsResponse = {
  status: "success",
  contexts: [
    {
      id: "ctx_abc123",
      name: "engineering-notes",
      is_private: true,
      is_locked: false,
      last_used_at: "2026-09-21T08:00:00Z",
    },
    {
      id: "ctx_def456",
      name: "never-used",
      is_private: false,
      is_locked: false,
      last_used_at: null,
      summary: "A long summary cut at 300 characters…",
      summary_truncated: true,
      embedding_model: "text-embedding-3-small",
      memory_count: 0,
    },
  ],
  count: 2,
  total: 2,
  limit: 10,
  can_create: true,
};

// A Sleep-discovered edge: the relation and its provenance are separate.
const edge: Edge = {
  source_id: "mem_a",
  target_id: "mem_b",
  edge_type: "related_to",
  weight: 1.5,
  confidence: 0.92,
  origin: "semantic",
  created_at: "2026-06-30T12:00:00Z",
  last_updated: null,
};

// Exercises the SleepReportDetail extends SleepReport inheritance.
const sleepReport: SleepReportDetail = {
  report_id: "rpt_001",
  context_id: null,
  status: "completed",
  started_at: "2026-07-04T02:00:00Z",
  completed_at: "2026-07-04T02:05:41Z",
  memories_processed: 200,
  edges_created: 15,
  memories_merged: 3,
  memories_promoted: 4,
  llm_calls_made: 9,
  llm_tokens_used: 12345,
  memories_flagged: 2,
  embedding_calls_made: 6,
  error_message: null,
  edge_discovery_result: { candidates: 40 },
  dedup_result: null,
  merge_retention_result: { purged: 0, retention_days: 30, cutoff: "2026-06-04 02:00" },
  actions: [
    {
      id: "act_1",
      phase: "edge_discovery",
      action_type: "create_edge",
      memory_id: "mem_a",
      target_id: "mem_b",
      details: { weight: 1.5 },
      created_at: "2026-07-04T02:01:00Z",
    },
  ],
  action_count: 1,
};

// A run whose judge-LLM calls partly failed: still a finished run.
const degradedRun: SleepReport = {
  report_id: "rpt_002",
  status: "degraded",
  memories_processed: 50,
  edges_created: 2,
  memories_merged: 0,
  memories_promoted: 1,
  llm_calls_made: 12,
  llm_tokens_used: 4000,
  llm_call_failures: 3,
};

const rollback: RollbackResult = {
  report_id: "rpt_002",
  status: "rolled_back",
  rollback_summary: {
    edges_deleted: 2,
    merges_reversed: 0,
    merges_unreversible: 0,
    importance_restored: 0,
    promotions_reversed: 0,
    importance_kept: 0,
    promotions_kept: 1,
    archives_restored: 0,
    errors: [],
  },
};

// /api/v1/system/info as a v0.75.0 server sends it.
const serverInfo: ServerInfo = {
  name: "Kagura Memory Cloud",
  version: "0.75.0",
  description: "Remote MCP Server + Web Management",
  environment: "production",
  search_defaults: { use_rerank: false, reranker_provider: "voyage", reranker_model: "rerank-2" },
  features: {
    neural_memory: true,
    research_tools: false,
    plan_page: true,
    byok: true,
    cost_display: true,
    managed_connectors: true,
    managed_llm: true,
    referrals: false,
    beta_invites: false,
    reranking: true,
    // A flag a later server adds still type-checks.
    some_future_flag: true,
  },
};

const usage: UsageInfo = {
  plan: "pro",
  memories: { used: 1200, limit: 50000, percentage: 2.4 },
  contexts: { used: 4, limit: 20 },
  members: { used: 2, limit: 5 },
  mcp_calls_per_day: { used: 317, limit: 10000 },
};

// Deprecated, but still exported so existing imports compile.
const limitOnly: UsageQuotaLimitOnly = { limit: 10000 };

const indexerStatus: IndexerStatusResponse = {
  resource_id: "slack",
  state: {
    job_status: "idle",
    active_version: 3,
    last_offset: 120,
    metrics: { applied_upserts: 0, skipped_reason: "memories_per_day_exceeded" },
  },
  recent_events: [{ id: 120, op: "upsert", doc_id: "msg-1" }],
};

const resourceEvents: ResourceEventsListResponse = {
  events: [
    {
      // A BigInt past 2^53 - 1, which a JSON number could not hold exactly.
      id: "9007199254740993",
      op: "delete",
      doc_id: "msg-1",
      version: null,
      importance: 0.6,
      created_at: "2026-09-20T10:00:00Z",
      payload: null,
      event_metadata: null,
      payload_bytes: 0,
      payload_truncated: false,
    },
  ],
  next_cursor: null,
};

const memoryList: MemoryListResponse = {
  memories: [
    {
      id: "mem_a",
      summary: "Coffee shop with reliable wifi",
      type: "note",
      scope: "persistent",
      importance: 0.5,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      location: { lat: 35.6812, lon: 139.7671 },
    },
    {
      id: "mem_b",
      summary: "A memory with no place",
      type: "note",
      scope: "working",
      importance: 0.5,
      created_at: "2026-09-02T00:00:00Z",
      updated_at: "2026-09-02T00:00:00Z",
      location: null,
    },
  ],
  total: 2,
  has_more: false,
};

const auditVerify: AuditVerifyResponse = {
  valid: true,
  entries: 42,
  head: "ab12",
  erasure_pseudonymized: [7, 19],
};

// A keyword-only recall flags its component and, since server v0.66.0,
// the envelope too; degraded_reason tells it from a failed component.
const bootstrap: AgentBootstrapResponse = {
  status: "success",
  degraded: true,
  agent: { agent_id: "agent_1", name: "ci-agent" },
  components: {
    recall: {
      status: "ok",
      results: [],
      degraded: true,
      degraded_reason: "embedding_unavailable",
    },
  },
};

describe("models", () => {
  it("ContextInfo with nested SearchConfig/ContextStats compiles and reads", () => {
    expect(contextInfo.context.search_config?.semantic_weight).toBe(0.6);
    expect(contextInfo.stats?.total_memories).toBe(128);
    expect(contextInfo.workspace?.name).toBe("kagura-ai");
  });

  it("ContextInfo carries the optional guardrails block", () => {
    expect(contextInfoWithGuardrails.guardrails?.items[0]?.memory_id).toBe("mem_g");
    // Absent, not null: the key is only there when the server sent it.
    expect(contextInfo.guardrails).toBeUndefined();
  });

  it("LoadGuardrailsResponse compiles and reads both lanes", () => {
    expect(guardrails.pinned[0]?.tool_trigger).toBeNull();
    expect(guardrails.tool_triggered[0]?.tool_trigger?.action).toBe("block");
    expect(minimalTrigger.on).toBeUndefined();
  });

  it("SearchConfig carries the reinforce and routing fields", () => {
    expect(searchConfig.reinforce_max_boost).toBe(0.15);
    expect(searchConfig.routing_mode).toBe("log_only");
  });

  it("ListContextsResponse compiles and reads", () => {
    expect(listContexts.contexts[0]?.summary).toBeUndefined();
    expect(listContexts.contexts[1]?.summary_truncated).toBe(true);
    expect(listContexts.hint).toBeUndefined();
  });

  it("ListTagsResponse compiles and reads", () => {
    expect(listTags.tags?.[0]?.tag).toBe("typescript");
    expect(listTags.total).toBe(2);
  });

  it("Edge compiles and reads", () => {
    expect(edge.edge_type).toBe("related_to");
    expect(edge.origin).toBe("semantic");
    expect(edge.weight).toBe(1.5);
  });

  it("SleepReportDetail inherits SleepReport fields", () => {
    // Base SleepReport field:
    expect(sleepReport.memories_processed).toBe(200);
    // Detail-only fields:
    expect(sleepReport.action_count).toBe(1);
    expect(sleepReport.actions?.[0]?.action_type).toBe("create_edge");
    expect(sleepReport.merge_retention_result?.retention_days).toBe(30);
    // Optional, so a report from an older server still type-checks:
    expect(sleepReport.llm_call_failures).toBeUndefined();
  });

  it("SleepReport carries the degraded status and its failure count", () => {
    expect(degradedRun.status).toBe("degraded");
    expect(degradedRun.llm_call_failures).toBe(3);
  });

  it("RollbackResult carries the kept and unreversible counts", () => {
    expect(rollback.rollback_summary.promotions_kept).toBe(1);
    expect(rollback.rollback_summary.merges_unreversible).toBe(0);
  });

  it("ServerInfo carries every feature flag and the search defaults", () => {
    expect(serverInfo.features?.reranking).toBe(true);
    expect(serverInfo.features?.some_future_flag).toBe(true);
    expect(serverInfo.search_defaults?.reranker_provider).toBe("voyage");
  });

  it("UsageInfo types the daily MCP calls as used/limit", () => {
    expect(usage.mcp_calls_per_day.used).toBe(317);
    expect(usage.mcp_calls_per_day.limit).toBe(limitOnly.limit);
  });

  it("IndexerStatusResponse accepts the daily-quota skip reason", () => {
    expect(indexerStatus.state?.metrics.skipped_reason).toBe("memories_per_day_exceeded");
  });

  it("ResourceEventRecord.id is a string, unlike ResourceEventItem.id", () => {
    expect(resourceEvents.events?.[0]?.id).toBe("9007199254740993");
    expect(resourceEvents.events?.[0]?.event_metadata).toBeNull();
    expect(typeof indexerStatus.recent_events?.[0]?.id).toBe("number");
  });

  it("MemoryListItem carries an optional location", () => {
    expect(memoryList.memories?.[0]?.location?.lat).toBe(35.6812);
    expect(memoryList.memories?.[1]?.location).toBeNull();
  });

  it("AuditVerifyResponse carries the erasure-pseudonymized rows", () => {
    expect(auditVerify.erasure_pseudonymized).toEqual([7, 19]);
  });

  it("a keyword-only bootstrap recall is flagged on the component and the envelope", () => {
    expect(bootstrap.degraded).toBe(true);
    expect(bootstrap.components?.recall?.degraded).toBe(true);
  });
});
