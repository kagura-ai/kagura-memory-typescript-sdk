/**
 * Recall shape and response budgets (#82; Python SDK 0.43.0, python-sdk
 * #298 / #295).
 *
 * memory-cloud changed what `recall` returns by default — compact hits from
 * v0.108.0 (#2002), content on the top results from v0.114.0 (#2124), a
 * character budget on recall / load_pinned / load_guardrails /
 * get_agent_bootstrap from v0.82.0 (#1743), `explore_hints_omitted` on a URL
 * without `explore` from v0.135.0 (#2470). The replies below are shaped like
 * memory-cloud v0.143.0's `utils/recall_projection.py` and
 * `mcp_server/tools/memory.py::_recall_envelope`.
 */

import { describe, expect, it } from "vitest";

import { AgentsClient } from "../src/agentsClient.js";
import type { RecallResponse, ToolResult } from "../src/index.js";
import { FakeRest, FakeServer, makeClient } from "./fakeServer.js";

const CTX = "11111111-2222-4333-8444-555555555555";
const AGENT = "6f0d9c2e-8a11-4b3e-9c55-1a2b3c4d5e6f";
const MEM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const MEM_B = "aaaaaaaa-0000-4000-8000-000000000002";
const MEM_C = "aaaaaaaa-0000-4000-8000-000000000003";

const CONFIDENCE = {
  level: "high",
  top_score: 0.71,
  prominence: 0.52,
  relative_margin: 3.1,
  result_count: 2,
  rationale: "Top hit stands well above the candidate-pool background.",
};
const CONTEXT_FIELDS = {
  context_id: CTX,
  context_name: "dev",
  context_display_name: "Dev",
  context_is_private: false,
  context_is_locked: false,
};
const EXPLORE_NOT_LISTED =
  "explore is not listed on this connection: add it to the tools= or add_tools= " +
  "list in the MCP URL's query if it has one, otherwise add add_tools=explore or " +
  "set profile=full.";

/**
 * verbosity omitted (compact), full omitted (3 on trusted rows), the budget
 * took the second hit's content, and include_explore_hints on a core-profile
 * URL.
 */
const COMPACT_REPLY = {
  confidence: CONFIDENCE,
  status: "success",
  results: [
    {
      memory_id: MEM_A,
      summary:
        "Deploy target moved to ap-northeast-1 after the latency review; the old " +
        "us-east-1 stack stays a warm standby until the cut-over…",
      summary_cut: true,
      content: "c".repeat(1500),
      content_truncated: true,
      content_next_offset: 1500,
      type: "decision",
      importance: 0.8,
      score: 0.8123,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: null,
      supersede_candidate: {
        memory_id: MEM_C,
        summary: "Deploy target is us-east-1",
        similarity: 0.93,
        verified: true,
      },
      folded: { count: 1, memory_ids: [MEM_C] },
    },
    {
      memory_id: MEM_B,
      summary: "Runbook: rotate the deploy key",
      type: "note",
      importance: 0.5,
      score: 0.61,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-02T00:00:00Z",
      observed_at: "2026-08-30",
    },
  ],
  count: 2,
  ...CONTEXT_FIELDS,
  related_tags: [{ tag: "deploy", count: 2 }],
  explore_hints_omitted: EXPLORE_NOT_LISTED,
  full_applied: 1,
};

/** verbosity "full", full 1, the LLM selector on, and a cut budget. */
const FULL_REPLY = {
  confidence: { ...CONFIDENCE, result_count: 1 },
  status: "success",
  results: [
    {
      memory_id: MEM_A,
      summary:
        "Deploy target moved to ap-northeast-1 after the latency review; the old " +
        "us-east-1 stack stays a warm standby until the cut-over in March, when the " +
        "DNS weights flip.",
      content: "The latency review … the DNS weights flip.",
      spans: [
        { start: 0, end: 18 },
        { start: 240, end: 262 },
      ],
      type: "decision",
      importance: 0.8,
      scope: "persistent",
      score: 0.8123,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: null,
      version: 3,
      tags: ["deploy", "aws"],
    },
  ],
  count: 1,
  selector: {
    applied: true,
    model: "judge-small",
    kept: 1,
    dropped: 1,
    dropped_memory_ids: [MEM_C],
  },
  ...CONTEXT_FIELDS,
  context_summary_omitted: true,
  truncated: true,
};

/** A client over a fake server whose every tools/call answers `reply`. */
function wired(reply: unknown = { status: "success", results: [] }) {
  const server = new FakeServer();
  server.toolResults = {
    recall: reply,
    recall_nearby: reply,
    load_pinned: reply,
    load_guardrails: reply,
    get_agent_bootstrap: reply,
  };
  return { server, client: makeClient(server) };
}

/** Every tools/call the client sent, as `[tool name, arguments]`. */
function toolCalls(server: FakeServer): Array<[string, Record<string, unknown>]> {
  return server.requests
    .filter((r) => r.body?.method === "tools/call")
    .map((r) => {
      const params = r.body!.params as { name: string; arguments: Record<string, unknown> };
      return [params.name, params.arguments];
    });
}

describe("recall({ verbosity, full, maxChars })", () => {
  it("omits all three by default, so the server's defaults apply", async () => {
    const { server, client } = wired();
    await client.recall({ contextId: CTX, query: "deploy" });
    expect(toolCalls(server)).toEqual([["recall", { query: "deploy", k: 5, context_id: CTX }]]);
  });

  it.each([
    ["full", 0, 10_000],
    ["compact", 100, 100_000],
    ["full", 3, 20_000],
  ] as const)(
    "sends verbosity %s, full %i and max_chars %i under their wire names",
    async (verbosity, full, maxChars) => {
      const { server, client } = wired();
      await client.recall({ contextId: CTX, query: "deploy", verbosity, full, maxChars });
      expect(toolCalls(server)).toEqual([
        [
          "recall",
          { query: "deploy", k: 5, context_id: CTX, verbosity, full, max_chars: maxChars },
        ],
      ]);
    },
  );

  it("sends full: 0 — summaries only is a value, not unset", async () => {
    const { server, client } = wired();
    await client.recall({ contextId: CTX, query: "deploy", full: 0 });
    expect(toolCalls(server)[0]![1]).toHaveProperty("full", 0);
  });

  it("treats null as unset, as Python treats None", async () => {
    const { server, client } = wired();
    const unset = { verbosity: null, full: null, maxChars: null } as unknown as Record<string, never>;
    await client.recall({ contextId: CTX, query: "deploy", ...unset });
    expect(toolCalls(server)).toEqual([["recall", { query: "deploy", k: 5, context_id: CTX }]]);
  });

  it("reads a bigint as Python's int", async () => {
    const { server, client } = wired();
    const big = { full: 3n, maxChars: 40_000n } as unknown as Record<string, number>;
    await client.recall({ contextId: CTX, query: "deploy", ...big });
    expect(toolCalls(server)[0]![1]).toMatchObject({ full: 3, max_chars: 40_000 });
  });

  it.each([
    [{ verbosity: "verbose" }, "verbosity must be 'compact' or 'full', got 'verbose'"],
    [{ verbosity: "FULL" }, "verbosity must be 'compact' or 'full', got 'FULL'"],
    [{ full: -1 }, "full must be an integer between 0 and 100, got -1"],
    [{ full: 101 }, "full must be an integer between 0 and 100, got 101"],
    // A boolean is not an integer here, as on the server (`type(x) is int`).
    [{ full: true }, "full must be an integer between 0 and 100, got True"],
    [{ full: 1.5 }, "full must be an integer between 0 and 100, got 1.5"],
    [{ full: "3" }, "full must be an integer between 0 and 100, got '3'"],
    [{ full: Number.NaN }, "full must be an integer between 0 and 100, got nan"],
    [{ maxChars: 9_999 }, "maxChars must be an integer between 10000 and 100000, got 9999"],
    [{ maxChars: 100_001 }, "maxChars must be an integer between 10000 and 100000, got 100001"],
    [{ maxChars: true }, "maxChars must be an integer between 10000 and 100000, got True"],
    [{ maxChars: "20000" }, "maxChars must be an integer between 10000 and 100000, got '20000'"],
    [{ maxChars: Infinity }, "maxChars must be an integer between 10000 and 100000, got inf"],
  ])("refuses %o before any request", async (shape, message) => {
    const { server, client } = wired();
    const options = { contextId: CTX, query: "deploy", ...(shape as Record<string, unknown>) };
    await expect(client.recall(options as never)).rejects.toThrow(message);
    expect(server.requests).toHaveLength(0);
  });

  it("returns a compact v0.143.0 reply as sent: no tags, context_summary or scope", async () => {
    const { server, client } = wired(COMPACT_REPLY);
    const result = await client.recall({ contextId: CTX, query: "deploy", includeExploreHints: true });

    expect(result).toEqual(COMPACT_REPLY);
    expect(toolCalls(server)[0]![1]).not.toHaveProperty("verbosity");
    // The verdict is read before the hits, and content sits right after
    // the summary it belongs to.
    expect(Object.keys(result)[0]).toBe("confidence");
    const [first, second] = result.results;
    expect(Object.keys(first!).slice(0, 4)).toEqual(["memory_id", "summary", "summary_cut", "content"]);
    expect(first!.summary_cut).toBe(true);
    expect(first!.content_next_offset).toBe(1500);
    expect(first!.folded).toEqual({ count: 1, memory_ids: [MEM_C] });
    expect(first!.supersede_candidate?.verified).toBe(true);
    expect(first!.supersede_candidate).not.toHaveProperty("detected_at");
    for (const key of ["tags", "context_summary", "scope"]) {
      expect(first).not.toHaveProperty(key);
    }
    expect(second!.content).toBeUndefined();
    expect(second!.observed_at).toBe("2026-08-30");
    expect(result.full_applied).toBe(1);
    expect(result.explore_hints).toBeUndefined();
    expect(result.explore_hints_omitted).toContain("add_tools=explore");
    expect(result.confidence?.level).toBe("high");
  });

  it("returns a full v0.143.0 reply as sent", async () => {
    const { server, client } = wired(FULL_REPLY);
    const result = await client.recall({
      contextId: CTX,
      query: "deploy",
      verbosity: "full",
      full: 1,
      maxChars: 10_000,
    });

    expect(result).toEqual(FULL_REPLY);
    expect(toolCalls(server)[0]![1]).toMatchObject({ verbosity: "full", full: 1, max_chars: 10_000 });
    const [hit] = result.results;
    expect(hit!.tags).toEqual(["deploy", "aws"]);
    expect(hit!.scope).toBe("persistent");
    expect(hit!.version).toBe(3);
    expect(hit).not.toHaveProperty("summary_cut");
    expect(hit!.spans?.[0]).toEqual({ start: 0, end: 18 });
    expect(result.selector?.dropped_memory_ids).toEqual([MEM_C]);
    expect(result.truncated).toBe(true);
    expect(result.context_summary_omitted).toBe(true);
    expect(result.related_tags).toBeUndefined();
  });

  it("still fits a ToolResult, the type recall returned before", async () => {
    const { client } = wired(COMPACT_REPLY);
    const result: ToolResult = await client.recall({ contextId: CTX, query: "deploy" });
    const typed: RecallResponse = await client.recall({ contextId: CTX, query: "deploy" });
    expect(result).toEqual(typed);
  });
});

describe("recallNearby({ includeDetails })", () => {
  it("omits include_details by default and when false", async () => {
    const { server, client } = wired();
    await client.recallNearby({ contextId: CTX, lat: 35.68, lon: 139.76 });
    await client.recallNearby({ contextId: CTX, lat: 35.68, lon: 139.76, includeDetails: false });
    for (const [, args] of toolCalls(server)) {
      expect(args).toEqual({ context_id: CTX, lat: 35.68, lon: 139.76, radius_m: 1000, k: 20 });
    }
  });

  it("sends include_details and passes the omitted markers through", async () => {
    const reply = {
      status: "success",
      results: [
        {
          memory_id: MEM_A,
          summary: "Coffee with Sato",
          type: "note",
          details: { location: { lat: 35.68, lon: 139.76 } },
          distance_m: 12.5,
        },
        {
          memory_id: MEM_B,
          summary: "Site visit",
          type: "note",
          distance_m: 80.5,
          details_omitted: true,
          details_total_chars: 25_000,
        },
      ],
      ...CONTEXT_FIELDS,
    };
    const { server, client } = wired(reply);
    const result = await client.recallNearby({ contextId: CTX, lat: 35.68, lon: 139.76, includeDetails: true });
    expect(toolCalls(server)[0]![1]).toHaveProperty("include_details", true);
    expect(result).toEqual(reply);
    expect(result.results[1]!.details_omitted).toBe(true);
    expect(result.results[1]!.details_total_chars).toBe(25_000);
  });

  it("reads the location a v0.82.0+ item carries in place of details", async () => {
    const reply = {
      status: "success",
      results: [
        {
          memory_id: MEM_A,
          summary: "Coffee with Sato",
          type: "note",
          location: { lat: 35.68, lon: 139.76, label: "Tokyo HQ" },
          distance_m: 12.5,
        },
      ],
      ...CONTEXT_FIELDS,
    };
    const { client } = wired(reply);
    const result = await client.recallNearby({ contextId: CTX, lat: 35.68, lon: 139.76 });
    expect(result.results[0]!.location?.label).toBe("Tokyo HQ");
    expect(result.results[0]).not.toHaveProperty("details");
  });
});

describe("maxChars on loadPinned / loadGuardrails / getAgentBootstrap", () => {
  it("loadPinned sends max_chars only when set", async () => {
    const { server, client } = wired();
    await client.loadPinned({ contextId: CTX });
    await client.loadPinned({ contextId: CTX, cap: 500, maxChars: 50_000 });
    expect(toolCalls(server)).toEqual([
      ["load_pinned", { context_id: CTX }],
      ["load_pinned", { context_id: CTX, cap: 500, max_chars: 50_000 }],
    ]);
  });

  it("loadPinned returns the budget markers as sent", async () => {
    const reply = {
      status: "success",
      memories: [
        {
          memory_id: MEM_A,
          summary: "Goal: ship the importer",
          type: "goal",
          importance: 0.9,
          delivery_mode: "always",
        },
      ],
      total_available: 40,
      truncated: true,
      cap: 100,
      ...CONTEXT_FIELDS,
      context_summary_omitted: true,
    };
    const { client } = wired(reply);
    expect(await client.loadPinned({ contextId: CTX, maxChars: 10_000 })).toEqual(reply);
  });

  it("loadGuardrails sends max_chars only when set", async () => {
    const { server, client } = wired();
    await client.loadGuardrails({ contextId: CTX });
    await client.loadGuardrails({ contextId: CTX, cap: 200, maxChars: 30_000 });
    expect(toolCalls(server)).toEqual([
      ["load_guardrails", { context_id: CTX }],
      ["load_guardrails", { context_id: CTX, cap: 200, max_chars: 30_000 }],
    ]);
  });

  it("getAgentBootstrap sends max_chars only when set", async () => {
    const envelope = {
      status: "success",
      degraded: false,
      agent: { agent_id: AGENT, name: "ci-agent" },
      components: { pinned: { status: "ok", memories: [], truncated: true } },
      context_summary_omitted: true,
    };
    const { server, client } = wired(envelope);
    await client.getAgentBootstrap({ agentId: AGENT });
    const bootstrap = await client.getAgentBootstrap({ agentId: AGENT, maxChars: 10_000 });
    expect(toolCalls(server)).toEqual([
      ["get_agent_bootstrap", { agent_id: AGENT }],
      ["get_agent_bootstrap", { agent_id: AGENT, max_chars: 10_000 }],
    ]);
    expect(bootstrap.context_summary_omitted).toBe(true);
    expect(bootstrap.components?.pinned?.truncated).toBe(true);
  });

  it.each([0, 9_999, 100_001, true, 20_000.5, "20000"])(
    "refuses maxChars %o on each of them before any request",
    async (maxChars) => {
      const { server, client } = wired();
      const message = /^maxChars must be an integer between 10000 and 100000, got /;
      const bad = { maxChars } as unknown as { maxChars: number };
      await expect(client.loadPinned({ contextId: CTX, ...bad })).rejects.toThrow(message);
      await expect(client.loadGuardrails({ contextId: CTX, ...bad })).rejects.toThrow(message);
      await expect(client.getAgentBootstrap({ agentId: AGENT, ...bad })).rejects.toThrow(message);
      expect(server.requests).toHaveLength(0);
    },
  );
});

describe("AgentsClient.bootstrap({ maxChars })", () => {
  function rest() {
    const server = new FakeRest();
    server.body = JSON.stringify({
      status: "success",
      agent: { agent_id: AGENT, name: "ci-agent" },
      context_summary_omitted: true,
    });
    const client = new AgentsClient({ apiKey: "kagura_test", baseUrl: "https://x.test", fetch: server.fetch });
    return { server, client };
  }

  it("puts max_chars in the JSON body only when set", async () => {
    const { server, client } = rest();
    await client.bootstrap({ agentId: AGENT });
    const bootstrap = await client.bootstrap({ agentId: AGENT, maxChars: 40_000 });
    expect(server.requests.map((r) => JSON.parse(r.body ?? "null"))).toEqual([{}, { max_chars: 40_000 }]);
    expect(bootstrap.context_summary_omitted).toBe(true);
  });

  it("refuses an out-of-range maxChars before any request", async () => {
    const { server, client } = rest();
    await expect(client.bootstrap({ agentId: AGENT, maxChars: 100_001 })).rejects.toThrow(
      "maxChars must be an integer between 10000 and 100000, got 100001",
    );
    expect(server.requests).toHaveLength(0);
  });
});
