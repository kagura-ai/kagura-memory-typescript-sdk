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
  it.each([false, true])("observes a wrapper's edits to an SDK reply (malformed=%s)", async (malformed) => {
    const h = harness();
    h.server.toolResults.list = { memories: [], total: 0, has_more: false };
    const client = makeClient(h.server);
    const list = client.listMatching.bind(client);
    client.listMatching = async (options) => {
      const reply = await list(options);
      reply.total = malformed ? "bad" as unknown as number : 99;
      return reply;
    };
    h.deps.makeClient = () => client;
    expect(await runCli(["list"], h.deps)).toBe(malformed ? 1 : 0);
    if (malformed) {
      expect(h.err.join("\n")).toContain("unexpected server response for ListMatchingResponse");
      expect(h.out).toEqual([]);
    } else expect(JSON.parse(h.out[0]!).total).toBe(99);
  });
  it.each([false, true])("validates an uncached custom client's reply (malformed=%s)", async (malformed) => {
    const h = harness();
    const client = makeClient(h.server);
    const reply = malformed ? { memories: "bad", total: 0 } : { memories: [], total: 0, has_more: false };
    client.listMatching = async () => reply as unknown as Awaited<ReturnType<typeof client.listMatching>>;
    h.deps.makeClient = () => client;
    expect(await runCli(["list"], h.deps)).toBe(malformed ? 1 : 0);
    if (malformed) {
      expect(h.err.join("\n")).toContain("unexpected server response for ListMatchingResponse");
      expect(h.out).toEqual([]);
    } else {
      expect(JSON.parse(h.out[0]!)).toMatchObject({ memories: [], total: 0, has_more: false, next_cursor: null });
    }
  });
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
    expect(await runCli(["forget", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/--ids TEXT\s+Comma-separated memory IDs to delete in one call, 1-50 \(server v0\.117\.0\+\)/);
    expect(text).toMatch(/-k INTEGER\s+Max memories to delete in query mode \(default 10\)$/m);
    expect(text).not.toContain("[default: 10]");
  });
});
