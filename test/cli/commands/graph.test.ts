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

  it("sends both ids for a report", async () => {
    const h = harness();
    h.server.toolResults.get_sleep_report = { status: "success", report: { id: "r-1" } };
    expect(await runCli(["sleep", "report", "ctx-1", "r-1"], h.deps)).toBe(0);
    expect(h.server.toolCallArgs(0)).toMatchObject({ context_id: "ctx-1", report_id: "r-1" });
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
