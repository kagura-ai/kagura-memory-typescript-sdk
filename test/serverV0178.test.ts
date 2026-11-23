/**
 * memory-cloud v0.162.0 - v0.178.0 (#154; the Python SDK 0.48.0 / 0.49.0).
 *
 * - v0.178.0 (memory-cloud#2980): per-context hybrid fusion.
 *   `update_search_config` takes `fusion` (`auto` / `rrf` / `weighted`) and
 *   both `update_search_config`'s `config` and `get_context_info`'s
 *   `search_config` carry `fusion` (stored) and `fusion_effective`.
 * - v0.177.0 (memory-cloud#2972): the `list_workspaces` tool and
 *   `list_contexts(workspace_id)`, whose reply may carry `other_workspaces`
 *   and `workspaces_hint`.
 * - v0.170.0 (memory-cloud#2891): `createContext`'s pre-check error for a
 *   full workspace whose visible count is below its limit, in the Python
 *   SDK 0.48.0's words.
 * - v0.161.0 (memory-cloud#2762): `?notices=off`, written by
 *   `mcpUrlWithQuery({ notices })` (the proxy's and setup's `--notices off`).
 */

import { describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../src/cli/run.js";
import {
  KaguraError,
  KaguraFeatureNotAvailableError,
  KaguraPermissionError,
  KaguraQuotaError,
  KaguraResponseError,
} from "../src/errors.js";
import {
  mcpUrlNoticesOff,
  mcpUrlWithQuery,
  normalizeNotices,
} from "../src/http.js";
import type { AccountWorkspaceList, SearchConfig } from "../src/index.js";
import {
  ACCOUNT_WORKSPACE_LIST,
  readModel,
  SEARCH_CONFIG,
} from "../src/pyModels.js";
import {
  FakeServer,
  makeClient,
  undeclaredArgumentRefusal,
} from "./fakeServer.js";

const CTX = "c0ffee00-0000-4000-8000-000000000001";
const WS = "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c";
const WS2 = "22222222-3333-4444-8555-666666666666";

/** `update_search_config`'s declared arguments at memory-cloud v0.176.0 (before `fusion`). */
const SEARCH_CONFIG_ARGS_0176 = [
  "context_id",
  "semantic_weight",
  "bm25_weight",
  "fetch_factor",
  "use_rerank",
  "reranker_provider",
  "reranker_model",
  "reinforce_enabled",
  "reinforce_max_boost",
  "reinforce_require_host_arbitration",
  "routing_mode",
  "content_chunks_enabled",
  "llm_selector_enabled",
];

/** `list_contexts`' declared arguments before v0.177.0. */
const LIST_CONTEXTS_ARGS_0176 = [
  "include_stats",
  "name_contains",
  "include_summary",
  "include_details",
  "limit",
  "cursor",
];

/** The `config` of a v0.178.0 `update_search_config` success (search_config.py). */
const CONFIG_0178 = {
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
  fusion: "rrf",
  fusion_effective: "rrf",
  content_chunks_enabled: false,
  content_chunks_effective: false,
  llm_selector_enabled: false,
  llm_selector_effective: false,
};

describe("updateSearchConfig({ fusion }) (memory-cloud v0.178.0, #2980)", () => {
  it("sends fusion as given, only when set", async () => {
    const server = new FakeServer();
    server.toolResults.update_search_config = {
      status: "success",
      context_id: CTX,
      config: CONFIG_0178,
    };
    const client = makeClient(server);
    const result = await client.updateSearchConfig({
      contextId: CTX,
      fusion: "rrf",
    });
    expect(server.toolCallArgs(0)).toEqual({ context_id: CTX, fusion: "rrf" });
    const fusion: string | null | undefined = result.config.fusion;
    const effective: string | null | undefined = result.config.fusion_effective;
    expect([fusion, effective]).toEqual(["rrf", "rrf"]);

    await client.updateSearchConfig({
      contextId: CTX,
      semanticWeight: 0.8,
      bm25Weight: 0.2,
    });
    expect(server.toolCallArgs(1)).toEqual({
      context_id: CTX,
      semantic_weight: 0.8,
      bm25_weight: 0.2,
    });
    expect(server.toolCallArgs(1)).not.toHaveProperty("fusion");

    // null is unset, as for every other option.
    await client.updateSearchConfig({
      contextId: CTX,
      fusion: null as unknown as string,
    });
    expect(server.toolCallArgs(2)).toEqual({ context_id: CTX });
  });

  it("leaves the value to the server: a newer or unknown one is sent unchecked", async () => {
    const server = new FakeServer();
    server.toolResults.update_search_config = {
      status: "error",
      error: "invalid_search_config",
      message: "fusion: Input should be 'auto', 'rrf' or 'weighted'",
    };
    const err = await makeClient(server)
      .updateSearchConfig({ contextId: CTX, fusion: "keyword_floor" })
      .catch((e: unknown) => e);
    expect(server.toolCallArgs(0)).toEqual({
      context_id: CTX,
      fusion: "keyword_floor",
    });
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).code).toBe("invalid_search_config");
  });

  it("a server before v0.178.0 refuses fusion as an unknown argument, and is sent nothing new without it", async () => {
    const server = new FakeServer();
    server.declaredArguments.update_search_config = SEARCH_CONFIG_ARGS_0176;
    server.toolResults.update_search_config = {
      status: "success",
      context_id: CTX,
      config: {},
    };
    const client = makeClient(server);
    await expect(
      client.updateSearchConfig({ contextId: CTX, useRerank: true }),
    ).resolves.toBeDefined();
    const err = await client
      .updateSearchConfig({ contextId: CTX, fusion: "rrf" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).code).toBe("invalid_argument");
    expect(
      undeclaredArgumentRefusal(
        "update_search_config",
        { fusion: "rrf" },
        SEARCH_CONFIG_ARGS_0176,
      ),
    ).not.toBe(null);
  });
});

describe("SearchConfig.fusion / fusion_effective (v0.178.0)", () => {
  it("the model keeps both when sent, as plain strings, after llm_selector_can_change", () => {
    const read = readModel(
      { fusion: "auto", fusion_effective: "keyword_floor" },
      SEARCH_CONFIG,
      "get_context_info",
    );
    expect(read.fusion).toBe("auto");
    // A value newer than the server's v0.178.0 enum still reads.
    expect(read.fusion_effective).toBe("keyword_floor");
    const keys = Object.keys(read);
    expect(keys.slice(-2)).toEqual(["fusion", "fusion_effective"]);
  });

  it("leaves both out for a server that sends neither, so its reply reads and dumps as before", () => {
    const read = readModel({ semantic_weight: 0.6 }, SEARCH_CONFIG, "get_context_info");
    expect(read).not.toHaveProperty("fusion");
    expect(read).not.toHaveProperty("fusion_effective");
  });

  it("getContextInfo returns the search_config's fusion fields as sent, and none from an older server", async () => {
    const server = new FakeServer();
    server.toolResults.get_context_info = {
      status: "success",
      context: {
        id: CTX,
        name: "n",
        search_config: {
          semantic_weight: 0.6,
          fusion: "weighted",
          fusion_effective: "weighted",
        },
      },
    };
    const info = await makeClient(server).getContextInfo({ contextId: CTX });
    const config: SearchConfig | undefined = info.context?.search_config;
    expect(config?.fusion).toBe("weighted");
    expect(config?.fusion_effective).toBe("weighted");

    server.toolResults.get_context_info = {
      status: "success",
      context: { id: CTX, name: "n", search_config: { semantic_weight: 0.6 } },
    };
    const old = await makeClient(server).getContextInfo({ contextId: CTX });
    expect(old.context?.search_config).not.toHaveProperty("fusion");
  });
});

const WORKSPACES_REPLY = {
  status: "success",
  workspaces: [
    { id: WS, name: "Home", role: "owner", current: true, usable: true },
    {
      id: "11111111-2222-4333-8444-555555555555",
      name: "Team",
      role: "viewer",
      current: false,
      usable: false,
      reason: "workspace_suspended",
    },
  ],
  total: 2,
};

describe("listWorkspaces (memory-cloud v0.177.0, #2972)", () => {
  it("calls list_workspaces with no arguments and returns the reply typed", async () => {
    const server = new FakeServer();
    server.toolResults.list_workspaces = WORKSPACES_REPLY;
    const result: AccountWorkspaceList =
      await makeClient(server).listWorkspaces();
    expect(server.toolCallArgs(0)).toEqual({});
    const call = server.requests.find((r) => r.body?.method === "tools/call")!;
    expect((call.body!.params as { name: string }).name).toBe(
      "list_workspaces",
    );
    expect(result.total).toBe(2);
    expect(result.workspaces[0]!.current).toBe(true);
    expect(result.workspaces[0]).not.toHaveProperty("reason");
    expect(result.workspaces[1]!.reason).toBe("workspace_suspended");
  });

  it("refuses a reply the model cannot read", async () => {
    const server = new FakeServer();
    server.toolResults.list_workspaces = {
      status: "success",
      workspaces: [{ id: WS, name: "Home" }],
      total: 1,
    };
    const err = await makeClient(server)
      .listWorkspaces()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as Error).message).toContain("workspaces.0.role");
  });

  it("the model reads reason as null when absent, and keeps an unknown role or reason as a string", () => {
    const read = readModel(
      {
        workspaces: [
          {
            id: WS,
            name: "Home",
            role: "guest",
            current: false,
            usable: false,
            reason: "new_gate",
          },
        ],
        total: 1,
      },
      ACCOUNT_WORKSPACE_LIST,
      "list_workspaces",
    );
    const item = (read.workspaces as Record<string, unknown>[])[0]!;
    expect([item.role, item.reason]).toEqual(["guest", "new_gate"]);
    const bare = readModel(
      {
        workspaces: [
          { id: WS, name: "Home", role: "owner", current: true, usable: true },
        ],
        total: 1,
      },
      ACCOUNT_WORKSPACE_LIST,
      "list_workspaces",
    );
    expect(
      (bare.workspaces as Record<string, unknown>[])[0]!.reason,
    ).toBeNull();
    expect(bare.status).toBe("success");
  });

  it("reads a reply with keys a newer server adds, top level and per item", async () => {
    const server = new FakeServer();
    server.toolResults.list_workspaces = {
      ...WORKSPACES_REPLY,
      next_cursor: null,
      workspaces: [{ ...WORKSPACES_REPLY.workspaces[0], plan: "pro" }],
      total: 1,
    };
    const result = await makeClient(server).listWorkspaces();
    expect(result.workspaces[0]!.id).toBe(WS);
    expect(result.total).toBe(1);
  });

  it("a connector key is refused with permission_denied (AUTH-204, v0.173.0+)", async () => {
    const server = new FakeServer();
    server.toolResults.list_workspaces = {
      status: "error",
      error: "permission_denied",
      message: "This connector key cannot call list_workspaces.",
      error_code: "AUTH-204",
      help: "This connection authenticates with a connector key, ...",
    };
    const err = await makeClient(server)
      .listWorkspaces()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraPermissionError);
    expect((err as KaguraError).details.error_code).toBe("AUTH-204");
  });

  it("a server before v0.177.0 answers unknown_tool", async () => {
    const server = new FakeServer();
    server.toolResults.list_workspaces = {
      status: "error",
      error: "unknown_tool",
      message: "Unknown tool: list_workspaces",
    };
    const err = await makeClient(server)
      .listWorkspaces()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).code).toBe("unknown_tool");
  });
});

describe("listContexts({ workspaceId }) (memory-cloud v0.177.0, #2972)", () => {
  it("sends workspace_id only when set", async () => {
    const server = new FakeServer();
    server.declaredArguments.list_contexts = LIST_CONTEXTS_ARGS_0176;
    server.toolResults.list_contexts = {
      status: "success",
      contexts: [],
      count: 0,
      total: 0,
    };
    const client = makeClient(server);
    // Unchanged for an older server when it is not set.
    await client.listContexts({});
    expect(server.toolCallArgs(0)).toEqual({});

    server.declaredArguments.list_contexts = [
      ...LIST_CONTEXTS_ARGS_0176,
      "workspace_id",
    ];
    await client.listContexts({ workspaceId: WS, nameContains: "dev" });
    expect(server.toolCallArgs(1)).toEqual({
      name_contains: "dev",
      workspace_id: WS,
    });
  });

  it("throws on a blank workspaceId before any request: the server would list the connection's workspace", async () => {
    const server = new FakeServer();
    const client = makeClient(server);
    for (const blank of ["", "   "]) {
      await expect(client.listContexts({ workspaceId: blank })).rejects.toThrow(
        "workspaceId is blank: the server would list the connection's workspace; pass a " +
          "workspace id from listWorkspaces() or omit it",
      );
    }
    expect(server.requests.filter((r) => r.body?.method === "tools/call")).toEqual([]);
  });

  it("types other_workspaces and workspaces_hint", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = {
      status: "success",
      contexts: [],
      count: 3,
      total: 0,
      limit: 25,
      can_create: true,
      has_more: false,
      next_cursor: null,
      other_workspaces: 2,
      workspaces_hint: "You are a member of 2 other workspaces: ...",
    };
    const result = await makeClient(server).listContexts();
    const other: number | undefined = result.other_workspaces;
    const hint: string | undefined = result.workspaces_hint;
    expect(other).toBe(2);
    expect(hint).toContain("2 other workspaces");
  });

  it("a workspace the caller is not a member of is permission_denied", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = {
      status: "error",
      error: "permission_denied",
      message: "Cannot list contexts: workspace not accessible.",
      your_role: "not_a_member",
      required_role: "viewer",
    };
    const err = await makeClient(server)
      .listContexts({ workspaceId: WS })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraPermissionError);
    expect((err as KaguraPermissionError).requiredRole).toBe("viewer");
  });

  it("another workspace's reply passes through: no limit / can_create, its own empty hint", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = {
      status: "success",
      contexts: [],
      count: 0,
      total: 0,
      has_more: false,
      next_cursor: null,
      hint: `No contexts of that workspace are visible to you. ... (/mcp/w/${WS}) ...`,
      other_workspaces: 1,
    };
    const result = await makeClient(server).listContexts({ workspaceId: WS });
    expect(server.toolCallArgs(0)).toEqual({ workspace_id: WS });
    expect(result).not.toHaveProperty("limit");
    expect(result).not.toHaveProperty("can_create");
    expect(result.hint).toContain(`/mcp/w/${WS}`);
    expect(result.other_workspaces).toBe(1);
  });

  it("the google / microsoft views send other_workspaces without workspaces_hint", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = {
      status: "success",
      contexts: [],
      count: 0,
      total: 0,
      limit: 25,
      can_create: true,
      other_workspaces: 1,
    };
    const result = await makeClient(server).listContexts();
    expect(result.other_workspaces).toBe(1);
    expect(result).not.toHaveProperty("workspaces_hint");
  });

  it("a suspended workspace is workspace_suspended, one without a seat feature_not_available", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = {
      status: "error",
      error: "workspace_suspended",
      message: "This workspace is suspended.",
      help: "...",
    };
    const client = makeClient(server);
    const suspended = await client.listContexts({ workspaceId: WS }).catch((e: unknown) => e);
    expect(suspended).toBeInstanceOf(KaguraError);
    expect((suspended as KaguraError).code).toBe("workspace_suspended");

    server.toolResults.list_contexts = {
      status: "error",
      error: "feature_not_available",
      message: "You have no seat on this workspace's plan.",
    };
    const unseated = await client.listContexts({ workspaceId: WS }).catch((e: unknown) => e);
    expect(unseated).toBeInstanceOf(KaguraFeatureNotAvailableError);
  });
});

describe("createContext's pre-check for a full workspace with unseen contexts (v0.170.0)", () => {
  it("says so in the Python SDK 0.48.0's words, with current null", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = {
      status: "success",
      contexts: [],
      count: 3,
      limit: 25,
      can_create: false,
    };
    const err = await makeClient(server)
      .createContext({ name: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect((err as Error).message).toBe(
      "This workspace is at its limit of 25 contexts; contexts you cannot see (for example ones " +
        "private to other members) count toward it. Delete unused contexts or upgrade the plan.",
    );
    expect((err as KaguraQuotaError).current).toBeNull();
    expect((err as KaguraQuotaError).limit).toBe(25);
  });

  it("keeps today's message when count is at the limit", async () => {
    const server = new FakeServer();
    server.toolResults.list_contexts = {
      status: "success",
      contexts: [],
      count: 25,
      limit: 25,
      can_create: false,
    };
    const err = await makeClient(server)
      .createContext({ name: "x" })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      "Context limit reached (25/25). Delete unused contexts or upgrade your plan.",
    );
    expect((err as KaguraQuotaError).current).toBe(25);
  });
});

describe("?notices=off (memory-cloud v0.161.0, #2762)", () => {
  it("normalizeNotices takes off in any case, trimmed, and nothing else", () => {
    expect(normalizeNotices(" OFF ")).toBe("off");
    expect(() => normalizeNotices("on")).toThrow(
      "notices must be 'off', got 'on'",
    );
    expect(() => normalizeNotices("")).toThrow("notices must be 'off', got ''");
  });

  it("mcpUrlWithQuery writes notices=off last, replacing every earlier value", () => {
    expect(
      mcpUrlWithQuery("https://x.test/mcp?notices=on&keep=1&notices=x", {
        notices: "Off",
        context: CTX,
      }),
    ).toBe(`https://x.test/mcp?keep=1&context=${CTX}&notices=off`);
    expect(mcpUrlWithQuery("https://x.test/mcp?notices=off", {})).toBe(
      "https://x.test/mcp?notices=off",
    );
    expect(() =>
      mcpUrlWithQuery("https://x.test/mcp", { notices: "no" }),
    ).toThrow("notices must be 'off'");
  });

  it("mcpUrlNoticesOff reads the first notices value as the server does", () => {
    expect(mcpUrlNoticesOff("https://x.test/mcp?notices=%20OFF")).toBe(true);
    expect(mcpUrlNoticesOff("https://x.test/mcp?notices=on&notices=off")).toBe(
      false,
    );
    expect(mcpUrlNoticesOff("https://x.test/mcp")).toBe(false);
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
    loadConfig: () => ({ api_key: "k" }),
    makeClient: (o: Record<string, unknown>) => makeClient(server, o),
  } as unknown as CliDeps;
  return { deps, out, err, server };
}

describe("CLI", () => {
  it("context search-config --fusion sends fusion", async () => {
    const h = harness();
    h.server.toolResults.update_search_config = {
      status: "success",
      context_id: CTX,
      config: CONFIG_0178,
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
    expect(h.out.join("\n")).toContain('"fusion_effective": "rrf"');
  });

  it("context search-config refuses a --fusion outside auto|rrf|weighted with exit 2", async () => {
    const h = harness();
    expect(
      await runCli(
        ["context", "search-config", CTX, "--fusion", "fast"],
        h.deps,
      ),
    ).toBe(2);
    expect(h.err.join("\n")).toContain(
      "'fast' is not one of 'auto', 'rrf', 'weighted'",
    );
    expect(h.server.requests).toEqual([]);
  });

  it("context search-config --help names --fusion", async () => {
    const h = harness();
    expect(await runCli(["context", "search-config", "--help"], h.deps)).toBe(
      0,
    );
    expect(h.out.join("\n")).toContain("--fusion [auto|rrf|weighted]");
  });

  it("context list --workspace-id sends workspace_id", async () => {
    const h = harness();
    h.server.toolResults.list_contexts = {
      status: "success",
      contexts: [],
      count: 0,
      total: 0,
    };
    expect(
      await runCli(["context", "list", "--workspace-id", WS], h.deps),
    ).toBe(0);
    expect(h.server.toolCallArgs(0)).toEqual({ workspace_id: WS });
    expect(await runCli(["context", "list"], h.deps)).toBe(0);
    expect(h.server.toolCallArgs(1)).toEqual({});
    // Sent canonically, as setup claude --context writes its UUID.
    expect(
      await runCli(["context", "list", "--workspace-id", ` ${WS.toUpperCase()} `], h.deps),
    ).toBe(0);
    expect(h.server.toolCallArgs(2)).toEqual({ workspace_id: WS });
  });

  it.each([[""], ["  "], ["not-a-uuid"]])(
    "context list --workspace-id %j is a usage error (exit 2), with no request",
    async (value) => {
      const h = harness();
      expect(await runCli(["context", "list", "--workspace-id", value], h.deps)).toBe(2);
      expect(h.err.join("\n")).toContain(
        `Invalid value for '--workspace-id': '${value}' is not a valid workspace UUID.`,
      );
      expect(h.server.requests).toEqual([]);
    },
  );

  it("workspace list sizes NAME by display width, a CJK character or an emoji two columns", async () => {
    const h = harness();
    const long = "A workspace name longer than the column";
    h.server.toolResults.list_workspaces = {
      status: "success",
      workspaces: [
        { id: WS, name: long, role: "owner", current: true, usable: true },
        { id: CTX, name: "開発チーム", role: "member", current: false, usable: true },
        // U+1F680 (W) and U+00E9 (neutral, one column).
        { id: WS2, name: "\u{1F680}Launch é", role: "viewer", current: false, usable: true },
      ],
      total: 3,
    };
    expect(await runCli(["workspace", "list"], h.deps)).toBe(0);
    const width = long.length; // 39 columns
    expect(h.out.join("\n")).toBe(
      [
        `${"ID".padEnd(36)} ${"NAME".padEnd(width)} ROLE    CURRENT USABLE`,
        `${WS} ${long} owner   yes     yes`,
        // 5 wide characters take 10 columns.
        `${CTX} 開発チーム${" ".repeat(width - 10)} member  -       yes`,
        // The rocket takes 2 columns, "Launch é" 8.
        `${WS2} \u{1F680}Launch é${" ".repeat(width - 10)} viewer  -       yes`,
      ].join("\n"),
    );
  });

  it("workspace list's NAME column is as wide as its widest name, at least the header, as Python's", async () => {
    const h = harness();
    h.server.toolResults.list_workspaces = {
      status: "success",
      workspaces: [{ id: WS, name: "A", role: "owner", current: true, usable: true }],
      total: 1,
    };
    expect(await runCli(["workspace", "list"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toBe(
      [`${"ID".padEnd(36)} NAME ROLE    CURRENT USABLE`, `${WS} A    owner   yes     yes`].join("\n"),
    );
  });

  it("workspace list calls list_workspaces and prints a table, as the Python CLI 0.49.0 does", async () => {
    const h = harness();
    h.server.toolResults.list_workspaces = WORKSPACES_REPLY;
    expect(await runCli(["workspace", "list"], h.deps)).toBe(0);
    expect(h.server.toolCallArgs(0)).toEqual({});
    expect(h.out.join("\n")).toBe(
      [
        `${"ID".padEnd(36)} NAME ROLE    CURRENT USABLE`,
        `${WS} Home owner   yes     yes`,
        `11111111-2222-4333-8444-555555555555 Team viewer  -       no (workspace_suspended)`,
      ].join("\n"),
    );
  });

  it("workspace list --json prints the model dump", async () => {
    const h = harness();
    h.server.toolResults.list_workspaces = WORKSPACES_REPLY;
    expect(await runCli(["workspace", "list", "--json"], h.deps)).toBe(0);
    const printed = JSON.parse(h.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(printed)).toEqual(["status", "workspaces", "total"]);
    const rows = printed.workspaces as Record<string, unknown>[];
    expect(rows[0]).toEqual({ id: WS, name: "Home", role: "owner", current: true, usable: true, reason: null });
    expect(rows[1]!.reason).toBe("workspace_suspended");
  });
});
