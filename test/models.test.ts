import { describe, expect, it } from "vitest";

import type {
  ContextInfo,
  Edge,
  ListTagsResponse,
  Memory,
  SleepReportDetail,
} from "../src/models.js";

// Compile-focused tests: the value here is that realistic wire payloads
// type-check against the interfaces. The runtime assertions are minimal.

const memory: Memory = {
  memory_id: "mem_01J8ZK3T",
  summary: "Prefer limit/cursor pagination for resource events",
  score: 0.87,
};

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
  it("Memory payload compiles and reads", () => {
    expect(memory.memory_id).toBe("mem_01J8ZK3T");
    expect(memory.score).toBeCloseTo(0.87);
  });

  it("ContextInfo with nested SearchConfig/ContextStats compiles and reads", () => {
    expect(contextInfo.context.search_config?.semantic_weight).toBe(0.6);
    expect(contextInfo.stats?.total_memories).toBe(128);
    expect(contextInfo.workspace?.name).toBe("kagura-ai");
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
