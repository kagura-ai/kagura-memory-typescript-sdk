import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { FakeServer, makeClient } from "../../fakeServer.js";
const cases: Array<{
  name: string; argv: string[]; toolTexts: Record<string, string>;
  confirm: boolean | null; prompts: string[]; calls: unknown[];
  code: number; stdout: string; stderr: string;
}> = JSON.parse(readFileSync(new URL("./sleepRollback110.json", import.meta.url), "utf8"));

/**
 * The recorded 0.44.0 stdout as the Python CLI 0.46.0 prints it: its
 * `RollbackSummary` gained `related_indexes_reverted` (default 0) right
 * after `points_requeued` (python-sdk#335, memory-cloud v0.153.0), so every
 * summary dump has that one more line. Order and default were read from the
 * published kagura-memory 0.46.0 model.
 */
function asPython046(stdout: string): string {
  return stdout.replace(
    /^( *)"points_requeued": \d+,\n/gm,
    (line: string, indent: string) => `${line}${indent}"related_indexes_reverted": 0,\n`,
  );
}

async function runRollback(c: {
  argv: string[]; toolTexts: Record<string, string>; confirm: boolean | null;
}): Promise<{ code: number; stdout: string; stderr: string; prompts: string[]; server: FakeServer; closed: boolean }> {
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
    prompts, server, closed,
  };
}

// memory-cloud v0.153.0 counts the undone `index_related` actions of the
// opt-in Sleep related index in the summary, only when at least one was
// undone (#144).
describe("sleep rollback prints related_indexes_reverted (#144)", () => {
  const argv = ["sleep", "rollback", "ctx-1", "r-1", "--yes"];

  it("keeps the count of a complete rollback", async () => {
    const run = await runRollback({
      argv,
      confirm: null,
      toolTexts: {
        rollback_sleep_run: JSON.stringify({
          report_id: "r-1", status: "rolled_back",
          rollback_summary: { edges_deleted: 1, related_indexes_reverted: 2 },
        }),
      },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('    "points_requeued": 0,\n    "related_indexes_reverted": 2,\n    "errors": []\n');
  });

  it("keeps the count of a partial rollback", async () => {
    const run = await runRollback({
      argv,
      confirm: null,
      toolTexts: {
        rollback_sleep_run: JSON.stringify({
          status: "error", error: "partial_rollback", report_id: "r-1", message: "Some actions failed",
          rollback_summary: { related_indexes_reverted: 3, errors: ["cannot undo merge"] },
        }),
      },
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('    "points_requeued": 0,\n    "related_indexes_reverted": 3,\n    "errors": [\n');
  });

  it("refuses a count that is not an integer, as the other counters are refused", async () => {
    const run = await runRollback({
      argv,
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

// Recorded with kagura-memory 0.44.0, click 8.3.3, pydantic 2.13.4.
// CliRunner invokes the real CLI and SDK; only _call_tool and click.confirm
// are replaced to capture requests/prompts without network or terminal I/O.
// The expected stdout is that record with the one line 0.46.0 adds.
describe("sleep rollback, byte for byte Python 0.44.0 plus 0.46.0's related_indexes_reverted (#110, #144)", () => {
  it("adds exactly one line to each recorded summary", () => {
    const recorded = cases.filter(c => c.stdout.includes('"points_requeued"'));
    expect(recorded.length).toBeGreaterThan(0);
    for (const c of recorded) {
      const lines = asPython046(c.stdout).split("\n").length - c.stdout.split("\n").length;
      expect(lines).toBe(1);
    }
  });

  it.each(cases)("$name", async (c) => {
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
    expect(await runCli(c.argv, deps)).toBe(c.code);
    const stdout = out.map(line => `${line}\n`).join("");
    expect(stdout).toBe(asPython046(c.stdout));
    expect(err.map(line => `${line}\n`).join("")).toBe(c.stderr);
    expect(prompts).toEqual(c.prompts);
    expect(server.requests.filter(r => r.body?.method === "tools/call").map(r => {
      const p = r.body!.params as { name: string; arguments: unknown };
      return [p.name, p.arguments];
    })).toEqual(c.calls);
    expect(closed).toBe(c.name !== "help");
  });
});
