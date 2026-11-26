/**
 * memory-cloud v0.184.0 (memory-cloud#3014): the user facts lane.
 *
 * - A context's search config gains `user_facts_lane` (boolean, default
 *   `false`): echoed in `update_search_config`'s `config` and in
 *   `get_context_info`'s `search_config`, set by `update_search_config`
 *   only when sent.
 * - With the lane on, `recall` replies carry `user_facts`: rows of the
 *   `results` shape (content only under `full` >= 1), never also in
 *   `results`, not counted in `count`. Present (possibly empty) when the
 *   lane ran, absent (never `null`) when it did not.
 */

import { describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../src/cli/run.js";
import type {
  RecallResponse,
  RecallResult,
  SearchConfig,
} from "../src/index.js";
import { readModel, SEARCH_CONFIG } from "../src/pyModels.js";
import { FakeServer, makeClient } from "./fakeServer.js";

const CTX = "c0ffee00-0000-4000-8000-000000000001";
const MEM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const MEM_FACT = "aaaaaaaa-0000-4000-8000-000000000009";
const MEM_FACT_2 = "aaaaaaaa-0000-4000-8000-00000000000a";

/** The `config` of a v0.184.0 `update_search_config` success (search_config.py). */
const CONFIG_0184 = {
  semantic_weight: 0.6,
  bm25_weight: 0.4,
  fetch_factor: 3,
  use_rerank: false,
  reranker_provider: null,
  reranker_model: null,
  reinforce_enabled: true,
  reinforce_max_boost: 0.15,
  reinforce_require_host_arbitration: false,
  routing_mode: "off",
  fusion: "auto",
  fusion_effective: "weighted",
  content_chunks_enabled: false,
  content_chunks_effective: false,
  llm_selector_enabled: false,
  llm_selector_effective: false,
  user_facts_lane: true,
};

const RESULT_ROW = {
  memory_id: MEM_A,
  summary: "How to carry heavy bags up the stairs",
  type: "note",
  importance: 0.5,
  score: 0.71,
  created_at: "2026-11-20T00:00:00Z",
  updated_at: null,
};

const FACT_ROW = {
  memory_id: MEM_FACT,
  summary: "The user injured a knee and avoids stairs",
  content: "Knee injury in October; stairs and heavy loads are hard for now.",
  type: "fact",
  importance: 0.7,
  score: 0.42,
  created_at: "2026-11-02T00:00:00Z",
  updated_at: null,
  observed_at: "2026-10-28",
};

const FACT_ROW_NO_CONTENT = {
  memory_id: MEM_FACT_2,
  summary: "The user lives on the fourth floor without a lift",
  type: "fact",
  importance: 0.6,
  score: 0.38,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: null,
};

/** A v0.184.0 recall envelope of a context with the lane on. */
const LANE_REPLY = {
  confidence: {
    level: "medium",
    top_score: 0.71,
    result_count: 1,
    rationale: "",
  },
  status: "success",
  results: [RESULT_ROW],
  count: 1,
  user_facts: [FACT_ROW, FACT_ROW_NO_CONTENT],
  context_id: CTX,
  context_name: "dev",
};

/** The same envelope with the lane off, skipped, or from an older server. */
const NO_LANE_REPLY = {
  confidence: {
    level: "medium",
    top_score: 0.71,
    result_count: 1,
    rationale: "",
  },
  status: "success",
  results: [RESULT_ROW],
  count: 1,
  context_id: CTX,
  context_name: "dev",
};

function wired(reply: unknown) {
  const server = new FakeServer();
  server.toolResults = { recall: reply };
  return { server, client: makeClient(server) };
}

describe("recall reply's user_facts (memory-cloud v0.184.0, #3014)", () => {
  it("returns the lane's rows under user_facts, apart from results", async () => {
    const { client } = wired(LANE_REPLY);
    const reply: RecallResponse = await client.recall({
      contextId: CTX,
      query: "carry bags upstairs",
    });
    const facts: RecallResult[] | undefined = reply.user_facts;
    expect(facts?.map((r) => r.memory_id)).toEqual([MEM_FACT, MEM_FACT_2]);
    expect(reply.results.map((r) => r.memory_id)).toEqual([MEM_A]);
    expect(reply.count).toBe(1);
    // Content is the full rule's: on a row that carries it, absent otherwise.
    expect(facts?.[0]?.content).toBe(FACT_ROW.content);
    expect(facts?.[1]).not.toHaveProperty("content");
    expect(facts?.[0]?.observed_at).toBe("2026-10-28");
  });

  it("leaves user_facts absent, not an empty list, when the lane did not run", async () => {
    const { client } = wired(NO_LANE_REPLY);
    const reply = await client.recall({
      contextId: CTX,
      query: "carry bags upstairs",
    });
    expect(reply).not.toHaveProperty("user_facts");
    expect(reply.user_facts).toBeUndefined();
  });

  it("keeps an empty user_facts: the lane ran and found nothing", async () => {
    const { client } = wired({ ...NO_LANE_REPLY, user_facts: [] });
    const reply = await client.recall({
      contextId: CTX,
      query: "carry bags upstairs",
    });
    expect(reply.user_facts).toEqual([]);
  });

  it("sends nothing new: the lane is the context's setting, not a recall argument", async () => {
    const { server, client } = wired(LANE_REPLY);
    await client.recall({ contextId: CTX, query: "q" });
    expect(server.toolCallArgs(0)).toEqual({
      query: "q",
      k: 5,
      context_id: CTX,
    });
  });
});

describe("updateSearchConfig({ userFactsLane }) (v0.184.0)", () => {
  it.each([true, false])(
    "sends user_facts_lane: %s when set",
    async (userFactsLane) => {
      const server = new FakeServer();
      server.toolResults.update_search_config = {
        status: "success",
        context_id: CTX,
        config: { ...CONFIG_0184, user_facts_lane: userFactsLane },
      };
      const result = await makeClient(server).updateSearchConfig({
        contextId: CTX,
        userFactsLane,
      });
      expect(server.toolCallArgs(0)).toEqual({
        context_id: CTX,
        user_facts_lane: userFactsLane,
      });
      const lane: boolean | null | undefined = result.config.user_facts_lane;
      expect(lane).toBe(userFactsLane);
    },
  );

  it("does not send it when unset or null, so an older server sees the call it knew", async () => {
    const server = new FakeServer();
    server.toolResults.update_search_config = {
      status: "success",
      context_id: CTX,
      config: CONFIG_0184,
    };
    const client = makeClient(server);
    await client.updateSearchConfig({ contextId: CTX, fetchFactor: 4 });
    await client.updateSearchConfig({
      contextId: CTX,
      fetchFactor: 4,
      userFactsLane: null as unknown as boolean,
    });
    expect(server.toolCallArgs(0)).toEqual({
      context_id: CTX,
      fetch_factor: 4,
    });
    expect(server.toolCallArgs(1)).toEqual({
      context_id: CTX,
      fetch_factor: 4,
    });
  });
});

describe("SearchConfig.user_facts_lane (v0.184.0)", () => {
  it("the model keeps it when sent, after the fusion fields", () => {
    const read = readModel(
      { fusion: "auto", fusion_effective: "rrf", user_facts_lane: true },
      SEARCH_CONFIG,
      "get_context_info",
    );
    expect(read.user_facts_lane).toBe(true);
    expect(Object.keys(read).slice(-3)).toEqual([
      "fusion",
      "fusion_effective",
      "user_facts_lane",
    ]);
    expect(
      readModel({ user_facts_lane: false }, SEARCH_CONFIG, "get_context_info")
        .user_facts_lane,
    ).toBe(false);
  });

  it("leaves it out for a server that does not send it, so its reply reads and dumps as before", () => {
    const read = readModel(
      { semantic_weight: 0.6 },
      SEARCH_CONFIG,
      "get_context_info",
    );
    expect(read).not.toHaveProperty("user_facts_lane");
  });

  it("getContextInfo returns search_config.user_facts_lane as sent, and none from an older server", async () => {
    const server = new FakeServer();
    server.toolResults.get_context_info = {
      status: "success",
      context: {
        id: CTX,
        name: "n",
        search_config: { semantic_weight: 0.6, user_facts_lane: true },
      },
    };
    const info = await makeClient(server).getContextInfo({ contextId: CTX });
    const config: SearchConfig | undefined = info.context?.search_config;
    expect(config?.user_facts_lane).toBe(true);

    server.toolResults.get_context_info = {
      status: "success",
      context: { id: CTX, name: "n", search_config: { semantic_weight: 0.6 } },
    };
    const old = await makeClient(server).getContextInfo({ contextId: CTX });
    expect(old.context?.search_config).not.toHaveProperty("user_facts_lane");
  });
});

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  server: FakeServer;
}

function harness(): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const server = new FakeServer();
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => true,
    openBrowser: async () => true,
    login: (() => {}) as unknown as CliDeps["login"],
    refresh: (() => {}) as unknown as CliDeps["refresh"],
    loadConfig: () => ({ api_key: "k", context_id: CTX }),
    makeClient: (o: Record<string, unknown>) => makeClient(server, o),
  } as unknown as CliDeps;
  return { deps, out, err, server };
}

describe("CLI", () => {
  it.each([
    ["--user-facts-lane", true],
    ["--no-user-facts-lane", false],
  ] as const)(
    "context search-config %s sends user_facts_lane: %s",
    async (flag, value) => {
      const h = harness();
      h.server.toolResults.update_search_config = {
        status: "success",
        context_id: CTX,
        config: { ...CONFIG_0184, user_facts_lane: value },
      };
      expect(
        await runCli(["context", "search-config", CTX, flag], h.deps),
      ).toBe(0);
      expect(h.server.toolCallArgs(0)).toEqual({
        context_id: CTX,
        user_facts_lane: value,
      });
      expect(h.out.join("\n")).toContain(`"user_facts_lane": ${value}`);
    },
  );

  it("context search-config refuses both lane switches with exit 2, before anything is sent", async () => {
    const h = harness();
    expect(
      await runCli(
        [
          "context",
          "search-config",
          CTX,
          "--user-facts-lane",
          "--no-user-facts-lane",
        ],
        h.deps,
      ),
    ).toBe(2);
    expect(h.err.join("\n")).toContain(
      "--user-facts-lane and --no-user-facts-lane are mutually exclusive",
    );
    expect(h.server.requests).toEqual([]);
  });

  it("context search-config without the lane switches does not send user_facts_lane", async () => {
    const h = harness();
    h.server.toolResults.update_search_config = {
      status: "success",
      context_id: CTX,
      config: CONFIG_0184,
    };
    expect(
      await runCli(
        ["context", "search-config", CTX, "--fusion", "rrf"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.server.toolCallArgs(0)).toEqual({
      context_id: CTX,
      fusion: "rrf",
    });
  });

  it("context search-config --help names both lane switches", async () => {
    const h = harness();
    expect(await runCli(["context", "search-config", "--help"], h.deps)).toBe(
      0,
    );
    const help = h.out.join("\n");
    expect(help).toContain("--user-facts-lane");
    expect(help).toContain("--no-user-facts-lane");
  });

  it("recall prints user_facts as the server sent it, after results", async () => {
    const h = harness();
    h.server.toolResults.recall = LANE_REPLY;
    expect(await runCli(["recall", "carry bags upstairs"], h.deps)).toBe(0);
    const out = h.out.join("\n");
    const printed = JSON.parse(out) as Record<string, unknown>;
    expect(printed.user_facts).toEqual(LANE_REPLY.user_facts);
    expect(out.indexOf('"user_facts"')).toBeGreaterThan(
      out.indexOf('"results"'),
    );
    expect(out.indexOf(MEM_FACT)).toBeGreaterThan(out.indexOf(MEM_A));
  });

  it("recall prints an empty user_facts as sent", async () => {
    const h = harness();
    h.server.toolResults.recall = { ...NO_LANE_REPLY, user_facts: [] };
    expect(await runCli(["recall", "q"], h.deps)).toBe(0);
    expect(
      (JSON.parse(h.out.join("\n")) as Record<string, unknown>).user_facts,
    ).toEqual([]);
  });

  it("recall prints no user_facts key when the server sent none", async () => {
    const h = harness();
    h.server.toolResults.recall = NO_LANE_REPLY;
    expect(await runCli(["recall", "q"], h.deps)).toBe(0);
    const out = h.out.join("\n");
    expect(out).not.toContain("user_facts");
    expect(JSON.parse(out)).not.toHaveProperty("user_facts");
  });
});
