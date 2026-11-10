import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { FakeServer, makeClient } from "../../fakeServer.js";

interface RecordedCase {
  name: string; argv: string[]; toolTexts: Record<string, string>;
  confirm: boolean | null; prompts: string[]; calls: unknown[];
  code: number; stdout: string; stderr: string;
}

// Recorded with kagura-memory 0.44.0, click 8.3.3, pydantic 2.13.4.
// CliRunner invokes the real CLI and SDK; only _call_tool and click.confirm
// are replaced to capture requests/prompts without network or terminal I/O.
const cases: RecordedCase[] = JSON.parse(readFileSync(new URL("./sleepRollback110.json", import.meta.url), "utf8"));

// What the published kagura-memory 0.46.0 models print for the same replies
// (recordRollbackSummary046.py; under 0.44.0 the same procedure reproduces
// the 0.44.0 record above byte for byte). 0.46.0's `RollbackSummary` has
// `related_indexes_reverted` (memory-cloud v0.153.0, python-sdk#335), so
// every summary it prints has that line. The last two cases carry a count.
const record046: {
  recorded_with: string;
  cases: Array<{ name: string; stdout: string; argv?: string[]; toolText?: string }>;
} = JSON.parse(readFileSync(new URL("./sleepRollback046.json", import.meta.url), "utf8"));
const stdout046 = new Map(record046.cases.filter(c => c.toolText === undefined).map(c => [c.name, c.stdout]));
const relatedIndexCases = record046.cases.filter(c => c.toolText !== undefined);

async function runRollback(c: {
  argv: string[]; toolTexts: Record<string, string>; confirm: boolean | null;
}): Promise<{ code: number; stdout: string; stderr: string; prompts: string[]; calls: unknown[]; closed: boolean }> {
  const server = new FakeServer();
  Object.assign(server.toolTexts, c.toolTexts);
  const out: string[] = [], err: string[] = [], prompts: string[] = [];
  let closed = false;
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async (text: string) => { prompts.push(text); return c.confirm; },
    loadConfig: () => ({ api_key: "k" }),
    makeClient: (options: Record<string, unknown>) => {
      const client = makeClient(server, options);
      const close = client.close.bind(client);
      client.close = async () => { closed = true; await close(); };
      return client;
    },
  } as unknown as CliDeps;
  const code = await runCli(c.argv, deps);
  return {
    code,
    stdout: out.map(line => `${line}\n`).join(""),
    stderr: err.map(line => `${line}\n`).join(""),
    prompts,
    calls: server.requests.filter(r => r.body?.method === "tools/call").map(r => {
      const p = r.body!.params as { name: string; arguments: unknown };
      return [p.name, p.arguments];
    }),
    closed,
  };
}

describe("the Python 0.46.0 record (#144)", () => {
  it("was made with kagura-memory 0.46.0 and covers every recorded summary", () => {
    expect(record046.recorded_with).toBe("kagura-memory 0.46.0");
    const withSummary = cases.filter(c => c.stdout.includes('"rollback_summary": {')).map(c => c.name);
    expect(withSummary.length).toBeGreaterThan(0);
    expect([...stdout046.keys()]).toEqual(withSummary);
    expect(relatedIndexCases).toHaveLength(2);
  });

  it("differs from the 0.44.0 record by the related_indexes_reverted line alone", () => {
    for (const c of cases) {
      const later = stdout046.get(c.name);
      if (later === undefined) continue;
      expect(later).not.toBe(c.stdout);
      expect(later.replace('    "related_indexes_reverted": 0,\n', "")).toBe(c.stdout);
    }
  });
});

// The stdout is the 0.46.0 record where a summary is printed, and the 0.44.0
// record everywhere else (errors, a declined prompt, help, the report). The
// prompts, stderr, calls and exit codes are the 0.44.0 CLI's.
describe("sleep rollback, byte for byte Python 0.44.0, its summary as 0.46.0 prints it (#110, #144)", () => {
  it.each(cases)("$name", async (c) => {
    const run = await runRollback(c);
    expect(run.code).toBe(c.code);
    expect(run.stdout).toBe(stdout046.get(c.name) ?? c.stdout);
    expect(run.stderr).toBe(c.stderr);
    expect(run.prompts).toEqual(c.prompts);
    expect(run.calls).toEqual(c.calls);
    expect(run.closed).toBe(c.name !== "help");
  });
});

// memory-cloud v0.153.0 counts the undone `index_related` actions of the
// opt-in Sleep related index in the summary, only when at least one was
// undone (#144).
describe("sleep rollback prints related_indexes_reverted as Python 0.46.0 does (#144)", () => {
  it.each(relatedIndexCases)("$name", async (c) => {
    const partial = (JSON.parse(c.toolText!) as { error?: string }).error === "partial_rollback";
    const run = await runRollback({ argv: c.argv!, confirm: null, toolTexts: { rollback_sleep_run: c.toolText! } });
    expect(run.stdout).toBe(c.stdout);
    expect(run.stdout).toMatch(/"related_indexes_reverted": [23],\n/);
    expect(run.code).toBe(partial ? 1 : 0);
  });

  it("refuses a count that is not an integer, as the other counters are refused", async () => {
    const run = await runRollback({
      argv: ["sleep", "rollback", "ctx-1", "r-1", "--yes"],
      confirm: null,
      toolTexts: {
        rollback_sleep_run: JSON.stringify({
          report_id: "r-1", status: "rolled_back",
          rollback_summary: { related_indexes_reverted: "many" },
        }),
      },
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
  });
});
