import { pythonHelp } from "../helpAssertions.js";
/**
 * The session commands' routing and `--help` (#86); their output is pinned
 * against the Python CLI in `sessionDumps.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { FakeServer, makeClient } from "../../fakeServer.js";

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const server = new FakeServer();
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    loadConfig: () => ({ api_key: "k", context_id: "ctx-default" }),
    makeClient: (o: Record<string, unknown>) => makeClient(server, o),
  } as unknown as CliDeps;
  return { out, err, server, deps };
}

describe("session commands", () => {
  it("are listed in the root help with the Python CLI's summaries", async () => {
    const h = harness();
    expect(await runCli(["--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/^ {2}bootstrap\s+Open a session on one context in one call \(server v0\.93\.0\+\)\.$/m);
    expect(text).toMatch(/^ {2}changes\s+List what changed in a context since SINCE, oldest first/m);
    expect(text).toMatch(/^ {2}list\s+List every memory of a context that matches exact filters/m);
  });

  it("route `list` to the MCP list tool, not to `auth list`", async () => {
    const h = harness();
    h.server.toolResults.list = { status: "success", memories: [], total: 0, has_more: false };
    expect(await runCli(["list"], h.deps)).toBe(0);
    const call = h.server.requests.find((r) => r.body?.method === "tools/call");
    expect(call?.body?.params).toEqual({ name: "list", arguments: { context_id: "ctx-default" } });
  });

  it.each([
    ["bootstrap", ["--since TEXT", "--include TEXT", "--format [full|index]", "--max-chars INTEGER"]],
    [
      "changes",
      ["Usage: kagura-memory changes [OPTIONS] SINCE", "--until TEXT", "--kinds TEXT", "--cursor TEXT", "--limit INTEGER", "--session-id TEXT", "--by-me", "--max-chars INTEGER"],
    ],
    [
      "list",
      ["--filters TEXT", "--order-by [updated_at|created_at|importance|observed_at]", "--direction [asc|desc]", "--details", "--max-chars INTEGER"],
    ],
  ])("%s --help shows its options", async (command, options) => {
    const h = harness();
    expect(await runCli([command, "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    for (const option of options) expect(text).toContain(option);
  });

  it("forget --help shows --ids and -k without a default of its own (Python CLI 0.44.0)", async () => {
    const h = harness();
    expect(await runCli(["forget","--help"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toBe(pythonHelp("forget"));
  });
});
