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

  // Recorded from the Python CLI 0.44.0 (click 8.3.3): click converts every
  // option before it checks for leftover positionals, so a bad option value
  // wins over an extra argument; the extra argument alone is reported as such.
  it.each([
    [["sleep", "history", "ctx-1", "extra", "--source", "nope"], "Error: Invalid value for '--source': 'nope' is not one of 'sleep', 'analysis', 'all'."],
    [["sleep", "history", "ctx-1", "extra", "--limit", "0"], "Error: Invalid value for '--limit': 0 is not in the range 1<=x<=50."],
    [["sleep", "report", "ctx-1", "r-1", "extra", "--actions-limit", "0"], "Error: Invalid value for '--actions-limit': 0 is not in the range 1<=x<=200."],
    [["sleep", "history", "ctx-1", "extra"], "Error: Got unexpected extra argument (extra)"],
  ])("%j reports what the Python CLI reports first", async (argv, message) => {
    const { code, h } = await wire(argv);
    expect(code).toBe(2);
    expect(h.err).toEqual([message]);
    expect(h.server.requests).toEqual([]);
  });

  it("sends REPORT_ID only; CONTEXT_ID is required and not sent (#79)", async () => {
    // memory-cloud v0.82.0+ refuses the context_id 0.14.1 sent here. The
    // reply is a whole report: since #85 `sleep report` reads it through
    // the Python SDK's SleepReportDetail model, as the Python CLI does.
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

  it("still requires CONTEXT_ID, as the Python CLI 0.42.2 does", async () => {
    const { code, h } = await wire(["sleep", "report", "r-1"]);
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("Missing argument 'REPORT_ID'.");
    expect(h.server.requests).toEqual([]);
  });

  it("says in --help that CONTEXT_ID is not sent", async () => {
    // `kagura sleep report --help` of the Python CLI 0.44.0 in a terminal
    // (click wraps at 78 columns); its paragraph goes on, on the same line,
    // with the sentence about --actions-cursor (#85).
    const h = harness();
    expect(await runCli(["sleep", "report", "--help"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain(
      "\n\n" +
        "  CONTEXT_ID is kept for backwards compatibility and not sent: the server\n" +
        "  finds the run by REPORT_ID (memory-cloud 0.126.0+ checks read access on the\n" +
        "  run's own context). From memory-cloud 0.82.0 the audit log comes a page at a\n" +
        "  time: while actions_has_more is true, pass actions_next_cursor as --actions-\n" +
        "  cursor.\n\n",
    );
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
    // Neither call sends CONTEXT_ID: memory-cloud v0.82.0+ refuses it (#79).
    const toolCalls = h.server.requests
      .filter((r) => r.body?.method === "tools/call")
      .map((r) => r.body?.params);
    expect(toolCalls).toEqual([
      { name: "get_sleep_report", arguments: { report_id: "r-1" } },
      { name: "rollback_sleep_run", arguments: { report_id: "r-1" } },
    ]);
  });

  it("makes exactly one round trip with --yes", async () => {
    // Python pins this: `-y` skips the prompt AND the pre-fetch.
    const h = harness();
    expect(await runCli(["sleep", "rollback", "ctx-1", "r-1", "--yes"], h.deps)).toBe(0);
    const toolCalls = h.server.requests.filter((r) => r.body?.method === "tools/call");
    expect(toolCalls).toHaveLength(1);
    expect(h.server.toolCallArgs(0)).toEqual({ report_id: "r-1" });
  });

  it("says in --help that CONTEXT_ID is not sent", async () => {
    const h = harness();
    // Byte for byte the paragraph of the Python CLI 0.44.0's
    // `kagura sleep rollback --help` in a terminal (click wraps at 78 columns).
    expect(await runCli(["sleep", "rollback", "--help"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain(
      "\n\n" +
        "  CONTEXT_ID is kept for backwards compatibility and not sent: the server\n" +
        "  finds the run by REPORT_ID (memory-cloud 0.126.0+ needs the editor or owner\n" +
        "  role on the run's own context).\n\n",
    );
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

/**
 * `sleep report` / `sleep rollback` print what the Python CLI 0.42.2 prints
 * for the same tool reply (#79): each case is the reply, the arguments the
 * Python CLI sent, and its stdout, stderr and exit code, recorded from the
 * Python CLI 0.42.2 (click 8.3.3, pydantic 2.13.4) with `KaguraClient._call_tool`
 * answering these exact objects. The success replies carry the Python
 * model's keys in its order: this bin prints the reply as the server sent
 * it, where Python prints the model (`model_dump`), so only such a reply
 * prints the same in both.
 *
 * The Python CLI 0.44.0, given the same replies, prints the two
 * `report_not_found` cases identically and the others differently, for
 * gaps this fix leaves alone: its dumps add the model fields of 0.43.0
 * (`source`, `details_omitted`, `details_total_chars`, `actions_has_more`,
 * `actions_next_cursor`, `note`; `chunks_requeued`, `points_requeued`;
 * #85), and its stderr adds a `  Help: <help>` line for an envelope that
 * carries `help` (python-sdk#299). #85 closed the `sleep report` part:
 * the first case's stdout is the Python CLI 0.44.0's dump.
 */
interface SleepCase {
  name: string;
  argv: string[];
  /** Tool name → the reply object. */
  results: Record<string, unknown>;
  /** `[tool, arguments]` of every tool call the Python CLI made. */
  calls: Array<[string, Record<string, unknown>]>;
  code: number;
  stdout: string;
  stderr: string;
}

const PYTHON_SLEEP_CASES: SleepCase[] = [
  {
    name: "report: a reply with the model's keys in its order",
    argv: ["sleep","report","ctx-1","11111111-2222-4333-8444-555555555555"],
    results: {"get_sleep_report":{"status":"success","report":{"report_id":"11111111-2222-4333-8444-555555555555","context_id":"c0ffee00-0000-4000-8000-000000000001","status":"completed","started_at":"2026-06-01T00:00:00Z","completed_at":"2026-06-01T00:05:00Z","memories_processed":12,"edges_created":3,"memories_merged":1,"memories_promoted":0,"llm_calls_made":4,"llm_tokens_used":900,"llm_call_failures":null,"memories_flagged":0,"embedding_calls_made":2,"error_message":null,"edge_discovery_result":{"edges":3},"dedup_result":null,"merge_retention_result":null,"importance_result":null,"consolidation_result":null,"reindex_result":null},"actions":[{"id":"a1","phase":"edge_discovery","action_type":"create_edge","memory_id":"m1","target_id":"m2","details":{"similarity":0.91},"created_at":"2026-06-01T00:01:00Z"}],"action_count":1}},
    calls: [["get_sleep_report",{"report_id":"11111111-2222-4333-8444-555555555555"}]],
    code: 0,
    // Since #85 `sleep report` prints the Python SDK's SleepReportDetail
    // dump, so this is the Python CLI 0.44.0's stdout for the reply (0.42.2
    // printed it without the 0.43.0 model fields); recorded in
    // sleepDumps.test.ts ("report: #79 reply, the 0.43.0 model fields filled").
    stdout: "{\n  \"report_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_id\": \"c0ffee00-0000-4000-8000-000000000001\",\n  \"status\": \"completed\",\n  \"started_at\": \"2026-06-01T00:00:00Z\",\n  \"completed_at\": \"2026-06-01T00:05:00Z\",\n  \"memories_processed\": 12,\n  \"edges_created\": 3,\n  \"memories_merged\": 1,\n  \"memories_promoted\": 0,\n  \"llm_calls_made\": 4,\n  \"llm_tokens_used\": 900,\n  \"llm_call_failures\": null,\n  \"source\": null,\n  \"memories_flagged\": 0,\n  \"embedding_calls_made\": 2,\n  \"error_message\": null,\n  \"edge_discovery_result\": {\n    \"edges\": 3\n  },\n  \"dedup_result\": null,\n  \"merge_retention_result\": null,\n  \"importance_result\": null,\n  \"consolidation_result\": null,\n  \"reindex_result\": null,\n  \"actions\": [\n    {\n      \"id\": \"a1\",\n      \"phase\": \"edge_discovery\",\n      \"action_type\": \"create_edge\",\n      \"memory_id\": \"m1\",\n      \"target_id\": \"m2\",\n      \"details\": {\n        \"similarity\": 0.91\n      },\n      \"created_at\": \"2026-06-01T00:01:00Z\",\n      \"details_omitted\": false,\n      \"details_total_chars\": null\n    }\n  ],\n  \"action_count\": 1,\n  \"actions_has_more\": false,\n  \"actions_next_cursor\": null,\n  \"note\": null\n}\n",
    stderr: "",
  },
  {
    name: "report: report_not_found",
    argv: ["sleep","report","ctx-1","11111111-2222-4333-8444-555555555555"],
    results: {"get_sleep_report":{"status":"error","error":"report_not_found","message":"Sleep report 11111111-2222-4333-8444-555555555555 not found or not owned by you."}},
    calls: [["get_sleep_report",{"report_id":"11111111-2222-4333-8444-555555555555"}]],
    code: 1,
    stdout: "",
    stderr: "Error: get_sleep_report: Sleep report 11111111-2222-4333-8444-555555555555 not found or not owned by you.\n",
  },
  {
    name: "rollback --yes: a reply with the model's keys in its order",
    argv: ["sleep","rollback","ctx-1","11111111-2222-4333-8444-555555555555","--yes"],
    results: {"rollback_sleep_run":{"report_id":"11111111-2222-4333-8444-555555555555","status":"rolled_back","rollback_summary":{"edges_deleted":3,"merges_reversed":1,"merges_unreversible":0,"importance_restored":0,"promotions_reversed":0,"importance_kept":0,"promotions_kept":0,"archives_restored":0,"errors":[]}}},
    calls: [["rollback_sleep_run",{"report_id":"11111111-2222-4333-8444-555555555555"}]],
    code: 0,
    stdout: "{\n  \"report_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"status\": \"rolled_back\",\n  \"rollback_summary\": {\n    \"edges_deleted\": 3,\n    \"merges_reversed\": 1,\n    \"merges_unreversible\": 0,\n    \"importance_restored\": 0,\n    \"promotions_reversed\": 0,\n    \"importance_kept\": 0,\n    \"promotions_kept\": 0,\n    \"archives_restored\": 0,\n    \"errors\": []\n  }\n}\n",
    stderr: "",
  },
  {
    name: "rollback --yes: report_not_found",
    argv: ["sleep","rollback","ctx-1","11111111-2222-4333-8444-555555555555","-y"],
    results: {"rollback_sleep_run":{"status":"error","error":"report_not_found","message":"Sleep report 11111111-2222-4333-8444-555555555555 not found or not owned by you."}},
    calls: [["rollback_sleep_run",{"report_id":"11111111-2222-4333-8444-555555555555"}]],
    code: 1,
    stdout: "",
    stderr: "Error: rollback_sleep_run: Sleep report 11111111-2222-4333-8444-555555555555 not found or not owned by you.\n",
  },
  {
    name: "rollback --yes: analysis_report",
    argv: ["sleep","rollback","ctx-1","11111111-2222-4333-8444-555555555555","--yes"],
    results: {"rollback_sleep_run":{"status":"error","error":"analysis_report","message":"Report 11111111-2222-4333-8444-555555555555 is an analysis report: it records the LLM spend of a Memory Analysis run and has no Sleep actions, so there is nothing to roll back.","help":"get_sleep_history lists the context's Sleep runs (source 'sleep', its default); roll back one of those."}},
    calls: [["rollback_sleep_run",{"report_id":"11111111-2222-4333-8444-555555555555"}]],
    code: 1,
    stdout: "",
    stderr: "Error: rollback_sleep_run failed (analysis_report): Report 11111111-2222-4333-8444-555555555555 is an analysis report: it records the LLM spend of a Memory Analysis run and has no Sleep actions, so there is nothing to roll back.\n",
  },
  {
    name: "rollback --yes: permission_denied",
    argv: ["sleep","rollback","ctx-1","11111111-2222-4333-8444-555555555555","--yes"],
    results: {"rollback_sleep_run":{"status":"error","error":"permission_denied","message":"Cannot roll back sleep runs: you need the editor or owner role on this context.","your_role":"viewer","required_role":"editor","help":"Ask a context owner for the editor role."}},
    calls: [["rollback_sleep_run",{"report_id":"11111111-2222-4333-8444-555555555555"}]],
    code: 1,
    stdout: "",
    stderr: "Error: rollback_sleep_run failed (permission_denied): Cannot roll back sleep runs: you need the editor or owner role on this context.\n",
  },
];

describe("kagura-memory sleep report|rollback, byte for byte the Python CLI 0.42.2's (#79)", () => {
  it.each(PYTHON_SLEEP_CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const h = harness();
    h.server.toolResults = { ...c.results };
    expect(await runCli(c.argv, h.deps)).toBe(c.code);
    expect(h.out.map((line) => `${line}\n`).join("")).toBe(c.stdout);
    expect(h.err.map((line) => `${line}\n`).join("")).toBe(c.stderr);
    const calls = h.server.requests
      .filter((r) => r.body?.method === "tools/call")
      .map((r) => {
        const params = r.body?.params as { name: string; arguments: Record<string, unknown> };
        return [params.name, params.arguments];
      });
    expect(calls).toEqual(c.calls);
  });
});
