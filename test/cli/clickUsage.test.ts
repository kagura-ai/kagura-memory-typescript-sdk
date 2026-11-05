import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCli, type CliDeps } from "../../src/cli/run.js";
import { terminalText } from "../pythonDumpHarness.js";
const cases: Array<{ argv: string[]; code: number; stdout: string; stderr: string }> =
  JSON.parse(readFileSync(new URL("./pythonUsage044.json", import.meta.url), "utf8"));
// Python SDK0.44.0 + Click8.3.3, using the same executable name and width80.
describe("Click usage errors (#111)", () => {
  it.each(cases)("$argv", async (c) => {
    const out: string[] = [], err: string[] = [];
    const deps = {
      write: (line: string) => void out.push(line),
      writeError: (line: string) => void err.push(line),
      loadConfig: () => ({ api_key: "test", context_id: "ctx" }),
    } as unknown as CliDeps;
    expect(await runCli(c.argv, deps)).toBe(c.code);
    expect(terminalText(out)).toBe(c.stdout.replaceAll("kagura ", "kagura-memory "));
    expect(terminalText(err)).toBe(c.stderr);
  });
});
