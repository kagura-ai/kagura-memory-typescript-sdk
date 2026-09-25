import { describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../../../src/cli/run.js";
import type { KaguraConfig } from "../../../src/config.js";
import { FakeServer, makeClient } from "../../fakeServer.js";

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  server: FakeServer;
  prompts: string[];
}

function harness(options: { config?: KaguraConfig; confirm?: boolean } = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const server = new FakeServer();
  const config = options.config ?? { api_key: "k" };
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async (question: string) => {
      prompts.push(question);
      return options.confirm ?? true;
    },
    openBrowser: async () => true,
    login: (() => {}) as unknown as CliDeps["login"],
    refresh: (() => {}) as unknown as CliDeps["refresh"],
    loadConfig: () => config,
    makeClient: (o: Record<string, unknown>) => makeClient(server, o),
  } as unknown as CliDeps;
  return { deps, out, err, server, prompts };
}

async function wire(argv: string[], options?: Parameters<typeof harness>[0]) {
  const h = harness(options);
  const code = await runCli(argv, h.deps);
  return { code, args: code === 0 ? h.server.toolCallArgs(0) : undefined, h };
}

/**
 * `createContext` pre-checks the workspace quota with `list_contexts`, so
 * the create itself is the *second* tool call.
 */
async function createArgs(argv: string[]) {
  const h = harness();
  const code = await runCli(argv, h.deps);
  return { code, args: h.server.toolCallArgs(1), h };
}

describe("kagura-memory context create", () => {
  it("inverts --public into is_private", async () => {
    // Omitting --public must create a PRIVATE context; the flag name and
    // the wire field are opposites.
    const a = await createArgs(["context", "create", "-n", "dev"]);
    expect(a.code).toBe(0);
    expect(a.args).toMatchObject({ name: "dev", is_private: true });

    const b = await createArgs(["context", "create", "-n", "dev", "--public"]);
    expect(b.args).toMatchObject({ is_private: false });
  });

  it("requires --name", async () => {
    const { code, h } = await wire(["context", "create"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("Missing option '--name' / '-n'.");
  });

  it("omits optional fields that were not given", async () => {
    const { args } = await createArgs(["context", "create", "-n", "dev"]);
    for (const key of ["display_name", "description", "summary", "usage_guide"]) {
      expect(args).not.toHaveProperty(key);
    }
  });

  it("needs no context id from config", async () => {
    // needs_context=False: `context create` names nothing to resolve.
    const { code } = await wire(["context", "create", "-n", "dev"], { config: {} });
    expect(code).toBe(0);
  });
});

describe("kagura-memory context update", () => {
  it("refuses an empty update with exit 1", async () => {
    const { code, h } = await wire(["context", "update", "ctx-1"]);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toBe("Error: At least one update option is required");
  });

  it("maps --lock / --unlock to a tri-state", async () => {
    const a = await wire(["context", "update", "ctx-1", "--lock"]);
    expect(a.args).toMatchObject({ context_id: "ctx-1", is_locked: true });

    const b = await wire(["context", "update", "ctx-1", "--unlock"]);
    expect(b.args).toMatchObject({ is_locked: false });

    const c = await wire(["context", "update", "ctx-1", "-d", "desc"]);
    expect(c.args).not.toHaveProperty("is_locked");
  });

  it("rejects --lock together with --unlock", async () => {
    const { code, h } = await wire(["context", "update", "ctx-1", "--lock", "--unlock"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("--lock and --unlock are mutually exclusive");
  });

  it("takes the context id positionally, not from --context-id", async () => {
    const { code, h } = await wire(["context", "update", "--context-id", "ctx-1", "-d", "x"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("Error: No such option: --context-id");
  });
});

describe("kagura-memory context delete", () => {
  it("prompts before deleting and aborts on a decline", async () => {
    const { code, h } = await wire(["context", "delete", "ctx-1"], { confirm: false });
    expect(code).toBe(1);
    expect(h.prompts).toEqual(["Delete context ctx-1?"]);
    expect(h.err.join("\n")).toBe("Error: Aborted!");
    // Nothing must reach the server after a decline.
    expect(h.server.requests).toEqual([]);
  });

  it("skips the prompt with --yes", async () => {
    const { code, h } = await wire(["context", "delete", "ctx-1", "--yes"]);
    expect(code).toBe(0);
    expect(h.prompts).toEqual([]);
  });

  it("accepts the short -y", async () => {
    const { h } = await wire(["context", "delete", "ctx-1", "-y"]);
    expect(h.prompts).toEqual([]);
  });
});

describe("kagura-memory context search-config", () => {
  it("refuses an empty update with exit 1", async () => {
    const { code, h } = await wire(["context", "search-config", "ctx-1"]);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toBe("Error: At least one option is required");
  });

  it.each([
    ["--semantic", "1.5", "'--semantic'", "0.0<=x<=1.0"],
    ["--bm25", "-0.1", "'--bm25'", "0.0<=x<=1.0"],
    ["--fetch-factor", "11", "'--fetch-factor'", "1<=x<=10"],
  ])("rejects %s %s as out of range", async (flag, value, label, range) => {
    const { code, h } = await wire(["context", "search-config", "ctx-1", flag, value]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain(
      `Invalid value for ${label}: ${value} is not in the range ${range}.`,
    );
  });

  it("rejects weights that do not sum to 1.0", async () => {
    const { code, h } = await wire([
      "context",
      "search-config",
      "ctx-1",
      "--semantic",
      "0.5",
      "--bm25",
      "0.2",
    ]);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("Weights must sum to 1.0");
  });

  it("accepts weights that do sum to 1.0", async () => {
    const { code, args } = await wire([
      "context",
      "search-config",
      "ctx-1",
      "--semantic",
      "0.6",
      "--bm25",
      "0.4",
    ]);
    expect(code).toBe(0);
    expect(args).toMatchObject({ semantic_weight: 0.6, bm25_weight: 0.4 });
  });

  it("validates --reranker against the choice list", async () => {
    const { code, h } = await wire(["context", "search-config", "ctx-1", "--reranker", "ollama"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain(
      "Invalid value for '--reranker': 'ollama' is not one of 'voyage', 'cohere', 'self_hosted'.",
    );
  });

  it("matches --reranker case-sensitively, as Python's click.Choice declares it", async () => {
    const { code, h } = await wire(["context", "search-config", "ctx-1", "--reranker", "Voyage"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain(
      "Invalid value for '--reranker': 'Voyage' is not one of 'voyage', 'cohere', 'self_hosted'.",
    );
    expect(h.server.requests).toEqual([]);
  });

  it("accepts --reranker self_hosted, which the server takes since v0.42.0", async () => {
    const { code, args } = await wire([
      "context",
      "search-config",
      "ctx-1",
      "--reranker",
      "self_hosted",
    ]);
    expect(code).toBe(0);
    expect(args).toMatchObject({ context_id: "ctx-1", reranker_provider: "self_hosted" });
  });

  it("names every reranker in the --reranker metavar", async () => {
    const h = harness();
    expect(await runCli(["context", "search-config", "--help"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("--reranker [voyage|cohere|self_hosted]");
  });
});

describe("kagura-memory context list", () => {
  it("sends no list_contexts options by default", async () => {
    const { code, args } = await wire(["context", "list"]);
    expect(code).toBe(0);
    expect(args).toEqual({});
  });

  it("forwards --name-contains, --summary, --details and --stats", async () => {
    const { code, args } = await wire([
      "context",
      "list",
      "--name-contains",
      "auth",
      "--summary",
      "--details",
      "--stats",
    ]);
    expect(code).toBe(0);
    expect(args).toEqual({
      name_contains: "auth",
      include_summary: true,
      include_details: true,
      include_stats: true,
    });
  });

  it("omits an empty --name-contains=, as Python's truthiness check does", async () => {
    // `if name_contains:` in Python, where the client would send "" as given.
    const { code, args } = await wire(["context", "list", "--name-contains=", "--stats"]);
    expect(code).toBe(0);
    expect(args).toEqual({ include_stats: true });
  });

  it("describes its options in the Python CLI's words", async () => {
    const h = harness();
    expect(await runCli(["context", "list", "--help"], h.deps)).toBe(0);
    const help = h.out.join("\n");
    const line = (flag: string) =>
      help.split("\n").find((l) => l.trimStart().startsWith(`${flag} `)) ?? "";
    expect(line("--name-contains")).toContain(
      "Only contexts whose name or display name contains this text (case-insensitive, max 100 chars)",
    );
    expect(line("--summary")).toContain("Add summaries (300-char preview)");
    expect(line("--details")).toContain("Add full summaries and embedding_model");
    expect(line("--stats")).toContain("Add memory_count per context");
    expect(help.replace(/\s+/g, " ")).toContain(
      "Rows are slim by default (id, name, is_private, is_locked, last_used_at); " +
        "memory-cloud v0.73.0+ is needed for --name-contains/--summary/--details.",
    );
    expect(help).toContain("kagura-memory context list --name-contains auth --summary");
  });
});

describe("kagura-memory contexts (alias)", () => {
  it("behaves like `context list`", async () => {
    const h = harness();
    h.server.toolResults.list_contexts = { status: "success", contexts: [] };
    expect(await runCli(["contexts"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toBe('{\n  "status": "success",\n  "contexts": []\n}');
  });

  it("does not require a context id", async () => {
    expect(await runCli(["contexts"], harness({ config: {} }).deps)).toBe(0);
  });

  it.each(["--name-contains=auth", "--summary", "--details", "--stats"])(
    "rejects %s with exit 2: Python's alias takes none of context list's options",
    async (flag) => {
      const { code, h } = await wire(["contexts", flag]);
      expect(code).toBe(2);
      expect(h.err.join("\n")).toContain(flag.split("=")[0]!);
      expect(h.server.requests).toHaveLength(0);
    },
  );

  it("points at `context list` for the options, in the Python CLI's words", async () => {
    const h = harness();
    expect(await runCli(["contexts", "--help"], h.deps)).toBe(0);
    const help = h.out.join("\n");
    expect(help).toContain(
      "List available contexts (short form of 'context list', without its options).",
    );
    expect(help).toContain(
      "For --name-contains/--summary/--details/--stats use 'kagura-memory context list'.",
    );
  });
});

describe("kagura-memory config show", () => {
  it("masks the api key", async () => {
    const h = harness({ config: { api_key: "kagura_12345678abcdef", mcp_url: "https://x/mcp" } });
    expect(await runCli(["config", "show"], h.deps)).toBe(0);
    const shown = JSON.parse(h.out.join("\n")) as Record<string, string>;
    expect(shown.api_key).toBe("kagura_1...cdef");
    expect(shown.mcp_url).toBe("https://x/mcp");
  });

  it("does not echo a key too short to mask", async () => {
    // Python's slice arithmetic overlaps below 12 chars and prints the key
    // twice ("abc" -> "abc...abc"); a mask that echoes its input is not a
    // mask, so this deliberately diverges.
    const h = harness({ config: { api_key: "abc" } });
    await runCli(["config", "show"], h.deps);
    const shown = JSON.parse(h.out.join("\n")) as Record<string, string>;
    expect(shown.api_key).toBe("***");
    expect(h.out.join("\n")).not.toContain("abc");
  });

  it("leaves an absent key alone and makes no network call", async () => {
    const h = harness({ config: { mcp_url: "https://x/mcp" } });
    expect(await runCli(["config", "show"], h.deps)).toBe(0);
    expect(h.server.requests).toEqual([]);
    expect(JSON.parse(h.out.join("\n"))).toEqual({ mcp_url: "https://x/mcp" });
  });
});
