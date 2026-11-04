import { describe, expect, it } from "vitest";

import { contextsFooter, nextPageFooter } from "../../../src/cli/commands/context.js";
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
  // Recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4):
  // its _FloatRange refuses nan, which click's FloatRange let through (python-sdk #285).
  it.each([
    ["--semantic", "nan", "Error: Invalid value for '--semantic': nan is not in the range 0.0<=x<=1.0."],
    ["--bm25", "-NaN", "Error: Invalid value for '--bm25': nan is not in the range 0.0<=x<=1.0."],
    ["--semantic", "inf", "Error: Invalid value for '--semantic': inf is not in the range 0.0<=x<=1.0."],
  ])("refuses %s %s (exit 2)", async (flag, value, message) => {
    const { code, h } = await wire(["context", "search-config", "ctx-1", flag, value]);
    expect(code).toBe(2);
    expect(h.err).toEqual([message]);
  });

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

  it("describes --limit, --cursor and the paging in the Python CLI 0.44.0's words (#89)", async () => {
    const h = harness();
    expect(await runCli(["context", "list", "--help"], h.deps)).toBe(0);
    const help = h.out.join("\n").replace(/\s+/g, " ");
    expect(help).toContain(
      "--limit INTEGER Contexts per page, 1-200 (server default 100; with --details and no " +
        "--name-contains at most 20, the default there; memory-cloud 0.82.0+).",
    );
    expect(help).toContain(
      "--cursor TEXT next_cursor of the previous page, with the same other options; a blank " +
        "one is ignored (memory-cloud 0.82.0+).",
    );
    expect(help).toContain(
      "From memory-cloud 0.82.0 the list comes a page at a time (100 contexts by default, and " +
        "a page also stops at 20,000 characters). When a page was cut, has_more and next_cursor " +
        "follow the JSON on stderr: pass next_cursor as --cursor, with the same other options, " +
        "for the next page. Older servers return every context and ignore --limit and --cursor.",
    );
  });

  it("checks --limit before an extra argument, and the --details cap after it, as click does", async () => {
    // Recorded from the Python CLI 0.44.0: click converts the options, then
    // refuses an extra argument, then runs the command's own checks.
    const a = await wire(["context", "list", "extra", "--limit", "0"]);
    expect(a.code).toBe(2);
    expect(a.h.err).toEqual(["Error: Invalid value for '--limit': 0 is not in the range 1<=x<=200."]);
    const b = await wire(["context", "list", "extra", "--details", "--limit", "21"]);
    expect(b.code).toBe(2);
    expect(b.h.err).toEqual(["Error: Got unexpected extra argument (extra)"]);
    expect([...a.h.server.requests, ...b.h.server.requests]).toHaveLength(0);
  });

  it("passes the next page's cursor through as given, a padded one included", async () => {
    // Only a blank one is unset; the server refuses anything but digits.
    const { code, args } = await wire(["context", "list", "--cursor", " 100 "]);
    expect(code).toBe(0);
    expect(args).toEqual({ cursor: " 100 " });
  });
});

describe("the context list paging footer (#89)", () => {
  it.each([
    { has_more: false, next_cursor: null },
    { has_more: true, next_cursor: null }, // nothing to continue from
    { has_more: true, next_cursor: "" },
    { has_more: true, next_cursor: 2 }, // not a string
    { has_more: "true", next_cursor: "2" }, // not the JSON boolean
    { has_more: 1, next_cursor: "2" },
    { contexts: [] }, // a server before v0.82.0
    null,
  ])("prints nothing for %j", (result) => {
    expect(nextPageFooter(result)).toBeNull();
    expect(contextsFooter(result)).toBeNull();
  });

  it.each([
    "2\x1b[31m", // a terminal escape
    "$(touch pwned)", // expanded by a shell inside double quotes
    "`id`",
    "2\n3",
    "2\n",
    "\u0662", // an Arabic-Indic digit: Python's isdigit(), but not ASCII
    "\uff12", // a fullwidth digit
    "-1",
  ])("shows only a cursor the server takes back, not %j", (cursor) => {
    expect(nextPageFooter({ has_more: true, next_cursor: cursor })).toBe(
      "has_more: true. For the next page, run the command again with the same options and " +
        "--cursor set to next_cursor from the JSON.",
    );
    expect(contextsFooter({ has_more: true, next_cursor: cursor })).toBe(
      "has_more: true. For the next page, run kagura-memory context list --cursor set to " +
        "next_cursor from the JSON.",
    );
  });

  it("names an ASCII-digit cursor and the command for the next page", () => {
    expect(nextPageFooter({ has_more: true, next_cursor: "0100" })).toBe(
      'has_more: true; next_cursor: "0100". For the next page, run the command again with the ' +
        'same options and --cursor "0100".',
    );
    expect(contextsFooter({ has_more: true, next_cursor: "100" })).toBe(
      'has_more: true; next_cursor: "100". For the next page, run kagura-memory context list ' +
        '--cursor "100".',
    );
  });

  it("prints nothing on stderr when the command fails", async () => {
    const h = harness();
    h.server.toolResults.list_contexts = {
      status: "error",
      error: "validation_error",
      message: "'cursor' must be the next_cursor of a previous list_contexts response.",
      has_more: true,
      next_cursor: "2",
    };
    expect(await runCli(["context", "list", "--cursor", "abc"], h.deps)).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toMatch(/^Error: /);
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

  it.each(["--limit=5", "--cursor=100"])(
    "rejects %s with exit 2: the alias pages through `context list --cursor`",
    async (flag) => {
      const { code, h } = await wire(["contexts", flag]);
      expect(code).toBe(2);
      expect(h.err.join("\n")).toContain(flag.split("=")[0]!);
      expect(h.server.requests).toHaveLength(0);
    },
  );

  it("prints one page, and the `context list --cursor` call for the next on stderr", async () => {
    const h = harness();
    h.server.toolResults.list_contexts = {
      status: "success",
      contexts: [],
      has_more: true,
      next_cursor: "100",
    };
    expect(await runCli(["contexts"], h.deps)).toBe(0);
    expect(h.server.toolCallArgs(0)).toEqual({});
    expect(JSON.parse(h.out.join("\n"))).toMatchObject({ has_more: true, next_cursor: "100" });
    expect(h.err).toEqual([
      'has_more: true; next_cursor: "100". For the next page, run kagura-memory context list --cursor "100".',
    ]);
  });

  it("points at `context list` for the options, in the Python CLI's words", async () => {
    // The Python CLI 0.44.0's help (#89): it names --limit/--cursor too, and
    // says the alias prints one page, with `kagura ` written `kagura-memory `.
    const h = harness();
    expect(await runCli(["contexts", "--help"], h.deps)).toBe(0);
    const help = h.out.join("\n").replace(/\s+/g, " ");
    expect(help).toContain(
      "List available contexts (short form of 'context list', without its options).",
    );
    expect(help).toContain(
      "Prints one page: from memory-cloud 0.82.0 that is the 100 most recently used " +
        "contexts. When more follow, a line on stderr names the 'kagura-memory context " +
        "list --cursor' call for the next page.",
    );
    expect(help).toContain(
      "For --name-contains/--summary/--details/--stats/--limit/--cursor use " +
        "'kagura-memory context list'.",
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
