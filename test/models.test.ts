import { describe, expect, it } from "vitest";

import type {
  ContextInfo,
  Edge,
  ListTagsResponse,
  LoadGuardrailsResponse,
  SleepReportDetail,
  ToolTrigger,
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

const edge: Edge = {
  source_id: "mem_a",
  target_id: "mem_b",
  edge_type: "semantic_similarity",
  weight: 1.5,
  confidence: 0.92,
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

  it("ListTagsResponse compiles and reads", () => {
    expect(listTags.tags?.[0]?.tag).toBe("typescript");
    expect(listTags.total).toBe(2);
  });

  it("Edge compiles and reads", () => {
    expect(edge.edge_type).toBe("semantic_similarity");
    expect(edge.weight).toBe(1.5);
  });

  it("SleepReportDetail inherits SleepReport fields", () => {
    // Base SleepReport field:
    expect(sleepReport.memories_processed).toBe(200);
    // Detail-only fields:
    expect(sleepReport.action_count).toBe(1);
    expect(sleepReport.actions?.[0]?.action_type).toBe("create_edge");
  });
});
