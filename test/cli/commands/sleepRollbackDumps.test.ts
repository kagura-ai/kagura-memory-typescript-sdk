import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { FakeServer, makeClient } from "../../fakeServer.js";
const cases: Array<{
  name: string; argv: string[]; toolTexts: Record<string, string>;
  confirm: boolean | null; prompts: string[]; calls: unknown[];
  code: number; stdout: string; stderr: string;
}> = JSON.parse(readFileSync(new URL("./sleepRollback110.json", import.meta.url), "utf8"));

// Recorded with kagura-memory 0.44.0, click 8.3.3, pydantic 2.13.4.
// CliRunner invokes the real CLI and SDK; only _call_tool and click.confirm
// are replaced to capture requests/prompts without network or terminal I/O.
describe("sleep rollback, byte for byte Python 0.44.0 (#110)", () => {
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
    expect(stdout).toBe(c.stdout);
    expect(err.map(line => `${line}\n`).join("")).toBe(c.stderr);
    expect(prompts).toEqual(c.prompts);
    expect(server.requests.filter(r => r.body?.method === "tools/call").map(r => {
      const p = r.body!.params as { name: string; arguments: unknown };
      return [p.name, p.arguments];
    })).toEqual(c.calls);
    expect(closed).toBe(c.name !== "help");
  });
});
