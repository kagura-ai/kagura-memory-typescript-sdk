import { describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { FakeServer, makeClient } from "../../fakeServer.js";

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  server: FakeServer;
  prompts: string[];
}

function harness(confirm = true): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const server = new FakeServer();
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async (q: string) => {
      prompts.push(q);
      return confirm;
    },
    openBrowser: async () => true,
    login: (() => {}) as unknown as CliDeps["login"],
    refresh: (() => {}) as unknown as CliDeps["refresh"],
    // No context_id: these commands take every id positionally, so a
    // config fallback must never be consulted.
    loadConfig: () => ({ api_key: "k" }),
    makeClient: (o: Record<string, unknown>) => makeClient(server, o),
  } as unknown as CliDeps;
  return { deps, out, err, server, prompts };
}

async function wire(argv: string[], confirm = true) {
  const h = harness(confirm);
  const code = await runCli(argv, h.deps);
  return { code, args: code === 0 ? h.server.toolCallArgs(0) : undefined, h };
}

describe("kagura-memory edge list", () => {
  it("takes both ids positionally and always sends min_weight", async () => {
    const { code, args } = await wire(["edge", "list", "ctx-1", "mem-1"]);
    expect(code).toBe(0);
    // Click's default is 0.0, not None, so it is on the wire even unasked.
    expect(args).toMatchObject({ context_id: "ctx-1", memory_id: "mem-1", min_weight: 0 });
    expect(args).not.toHaveProperty("limit");
  });

  it("splits --type into a list and passes --limit through", async () => {
    const { args } = await wire([
      "edge",
      "list",
      "ctx-1",
      "mem-1",
      "--type",
      "related_to, depends_on",
      "--limit",
      "5",
    ]);
    expect(args).toMatchObject({ edge_types: ["related_to", "depends_on"], limit: 5 });
  });

  it.each([
    [["edge", "list"], "CONTEXT_ID"],
    [["edge", "list", "ctx-1"], "MEMORY_ID"],
  ])("names the missing positional in %j", async (argv, missing) => {
    const { code, h } = await wire(argv);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain(`Missing argument '${missing}'.`);
  });

  it("accepts a negative --min-weight rather than reading it as a flag", async () => {
    const { code, args } = await wire(["edge", "list", "ctx-1", "mem-1", "--min-weight", "-1"]);
    expect(code).toBe(0);
    expect(args).toMatchObject({ min_weight: -1 });
  });
});

describe("kagura-memory edge create", () => {
  it("sends the three click defaults even when unasked", async () => {
    const { args } = await wire(["edge", "create", "ctx-1", "a", "b"]);
    expect(args).toMatchObject({
      context_id: "ctx-1",
      source_id: "a",
      target_id: "b",
      edge_type: "related_to",
      weight: 0.5,
      confidence: 1,
    });
  });

  it("rejects a self-loop before any network call", async () => {
    const { code, h } = await wire(["edge", "create", "ctx-1", "a", "a"]);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toMatch(/self-loops are not allowed/);
  });

  it("requires all three positionals", async () => {
    const { code, h } = await wire(["edge", "create", "ctx-1", "a"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("Missing argument 'TARGET_ID'.");
  });
});

describe("kagura-memory edge update", () => {
  it("refuses an empty update with exit 1", async () => {
    const { code, h } = await wire(["edge", "update", "ctx-1", "a", "b"]);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toBe("Error: At least one of --weight or --type must be provided");
  });

  it("omits the field that was not given", async () => {
    const { args } = await wire(["edge", "update", "ctx-1", "a", "b", "--weight", "1.5"]);
    expect(args).toMatchObject({ weight: 1.5 });
    expect(args).not.toHaveProperty("edge_type");
  });
});

describe("kagura-memory edge delete", () => {
  it("prompts and aborts on a decline without calling the server", async () => {
    const { code, h } = await wire(["edge", "delete", "ctx-1", "a", "b"], false);
    expect(code).toBe(1);
    expect(h.prompts).toEqual(["Delete edge a -> b?"]);
    expect(h.err.join("\n")).toBe("Error: Aborted!");
    expect(h.server.requests).toEqual([]);
  });

  it("skips the prompt with -y", async () => {
    const { code, h } = await wire(["edge", "delete", "ctx-1", "a", "b", "-y"]);
    expect(code).toBe(0);
    expect(h.prompts).toEqual([]);
  });
});

describe("kagura-memory sleep", () => {
  it("defaults history's limit to 10", async () => {
    const h = harness();
    h.server.toolResults.get_sleep_history = { status: "success", reports: [] };
    expect(await runCli(["sleep", "history", "ctx-1"], h.deps)).toBe(0);
    expect(h.server.toolCallArgs(0)).toMatchObject({ context_id: "ctx-1", limit: 10 });
  });

  it.each([["0"], ["51"], ["-5"]])("rejects an out-of-range limit %j", async (value) => {
    const { code, h } = await wire(["sleep", "history", "ctx-1", "--limit", value]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain(
      `Invalid value for '--limit': ${value} is not in the range 1<=x<=50.`,
    );
  });

  it("names the Range type when the limit is not a number at all", async () => {
    const { code, h } = await wire(["sleep", "history", "ctx-1", "--limit", "abc"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("'abc' is not a valid integer range.");
  });

  it("sends the report id only: the server declares no context_id on get_sleep_report", async () => {
    // Until #85 (and #79) this sent `context_id` too, which memory-cloud
    // v0.82.0+ refuses with invalid_argument; the positional stays.
    const h = harness();
    h.server.toolResults.get_sleep_report = {
      status: "success",
      report: {
        report_id: "r-1",
        status: "completed",
        memories_processed: 0,
        edges_created: 0,
        memories_merged: 0,
        memories_promoted: 0,
        llm_calls_made: 0,
        llm_tokens_used: 0,
        memories_flagged: 0,
        embedding_calls_made: 0,
      },
      actions: [],
      action_count: 0,
    };
    expect(await runCli(["sleep", "report", "ctx-1", "r-1"], h.deps)).toBe(0);
    expect(h.server.toolCallArgs(0)).toEqual({ report_id: "r-1" });
  });
});

/**
 * `COLUMNS=80 kagura sleep report --help` of the Python CLI 0.44.0 (click
 * 8.3.3), as recorded. Everything above `Options:` is click's wrap of the
 * docstring at 78 columns; the options are laid out by this bin's own help
 * renderer (no wrapping, for every command), so only their texts are
 * compared.
 */
const PYTHON_SLEEP_REPORT_HELP =
  "Usage: kagura sleep report [OPTIONS] CONTEXT_ID REPORT_ID\n" +
  "\n" +
  "  Get a detailed Sleep Maintenance report including audit log.\n" +
  "\n" +
  "  CONTEXT_ID is kept for backwards compatibility and not sent: the server\n" +
  "  finds the run by REPORT_ID (memory-cloud 0.126.0+ checks read access on the\n" +
  "  run's own context). From memory-cloud 0.82.0 the audit log comes a page at a\n" +
  "  time: while actions_has_more is true, pass actions_next_cursor as --actions-\n" +
  "  cursor.\n" +
  "\n" +
  "Options:\n" +
  "  --actions-cursor TEXT          actions_next_cursor of the previous page\n" +
  "                                 (memory-cloud 0.82.0+).\n" +
  "  --actions-limit INTEGER RANGE  Actions per page (1-200; the server's default\n" +
  "                                 is 50; memory-cloud 0.82.0+).  [1<=x<=200]\n" +
  "  --help                         Show this message and exit.\n";

describe("kagura-memory sleep report --help (#85)", () => {
  it("prints the Python CLI 0.44.0's text above Options byte for byte, under this bin's name", async () => {
    const h = harness();
    expect(await runCli(["sleep", "report", "--help"], h.deps)).toBe(0);
    const text = `${h.out.join("\n")}\n`;
    const head = (help: string) => help.slice(0, help.indexOf("Options:\n"));
    expect(head(text)).toBe(head(PYTHON_SLEEP_REPORT_HELP).replace("Usage: kagura ", "Usage: kagura-memory "));
  });

  it("lists both paging options with the Python CLI's help texts", async () => {
    const h = harness();
    expect(await runCli(["sleep", "report", "--help"], h.deps)).toBe(0);
    const options = h.out.join("\n").split("Options:\n")[1]!.split("\n");
    expect(options.map((line) => line.trim().split(/\s{2,}/))).toEqual([
      ["--actions-cursor TEXT", "actions_next_cursor of the previous page (memory-cloud 0.82.0+)."],
      ["--actions-limit INTEGER", "Actions per page (1-200; the server's default is 50; memory-cloud 0.82.0+)."],
      ["--help", "Show this message and exit."],
    ]);
  });
});

describe("kagura-memory sleep history --help (#85)", () => {
  it("lists --source with its choices and the Python CLI's help text", async () => {
    const h = harness();
    expect(await runCli(["sleep", "history", "--help"], h.deps)).toBe(0);
    const options = h.out.join("\n").split("Options:\n")[1]!.split("\n");
    expect(options.map((line) => line.trim().split(/\s{2,}/))).toContainEqual([
      "--source [sleep|analysis|all]",
      "Sleep runs (the server's default), Memory Analysis spend rows, or all (memory-cloud 0.138.0+).",
    ]);
  });
});

describe("kagura-memory sleep rollback", () => {
  it("pre-fetches the report so the prompt can say what is being undone", async () => {
    const h = harness(true);
    h.server.toolResults.get_sleep_report = {
      status: "success",
      report: { id: "r-1" },
      action_count: 7,
    };
    expect(await runCli(["sleep", "rollback", "ctx-1", "r-1"], h.deps)).toBe(0);
    expect(h.prompts).toEqual(["Roll back sleep run r-1 (7 actions)?"]);
  });

  it("makes exactly one round trip with --yes", async () => {
    // Python pins this: `-y` skips the prompt AND the pre-fetch.
    const h = harness();
    expect(await runCli(["sleep", "rollback", "ctx-1", "r-1", "--yes"], h.deps)).toBe(0);
    const toolCalls = h.server.requests.filter((r) => r.body?.method === "tools/call");
    expect(toolCalls).toHaveLength(1);
    expect(h.server.toolCallArgs(0)).toMatchObject({ context_id: "ctx-1", report_id: "r-1" });
  });

  it("does not roll back when the prompt is declined", async () => {
    const h = harness(false);
    h.server.toolResults.get_sleep_report = { status: "success", report: { id: "r-1" } };
    expect(await runCli(["sleep", "rollback", "ctx-1", "r-1"], h.deps)).toBe(1);
    const toolNames = h.server.requests
      .filter((r) => r.body?.method === "tools/call")
      .map((r) => (r.body?.params as { name: string }).name);
    expect(toolNames).toEqual(["get_sleep_report"]);
  });
});
