import { describe, it, expect } from "vitest";
import { ROOT_COMMANDS, runCli, type CliDeps } from "../../src/cli/run.js";
import { isGroup, type Command, type CommandGroup } from "../../src/cli/command.js";
import { terminalText } from "../pythonDumpHarness.js";
import oracle from "./pythonHelp044.json" with { type: "json" };
import exceptions from "./typescriptHelp111.json" with { type: "json" };

function registered(): Map<string, Command | CommandGroup> {
  const root: CommandGroup = { summary: "", commands: ROOT_COMMANDS };
  const result = new Map<string, Command | CommandGroup>();
  function walk(entry: Command | CommandGroup, path: string) {
    result.set(path, entry);
    if (isGroup(entry)) for (const [name, child] of Object.entries(entry.commands)) walk(child, `${path} ${name}`.trim());
  }
  walk(root, "");
  return result;
}

describe("every CLI help page against Python 0.44.0 / Click 8.3.3 (#111)", () => {
  const commands = registered();
  it("covers every registered command and every documented exception", () => {
    const supported = oracle.filter(page => page.path !== "ingest").map(page => page.path);
    expect([...commands.keys()].sort()).toEqual(supported.sort());
    expect(Object.keys(exceptions).every(path => commands.has(path))).toBe(true);
  });

  it.each(oracle.filter(page => page.path !== "ingest"))("$path --help", async page => {
    const out: string[] = [], err: string[] = [];
    const code = await runCli([...page.path.split(" ").filter(Boolean), "--help"], {
      write: (s: string) => out.push(s), writeError: (s: string) => err.push(s),
    } as unknown as CliDeps);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    // Remaining command-surface differences are enumerated in docs/cli-help-differences.md.
    const exception = (exceptions as Record<string, string>)[page.path];
    if (exception !== undefined) expect(exception).not.toBe(page.binStdout);
    expect(terminalText(out)).toBe(exception ?? page.binStdout);

    const entry = commands.get(page.path)!;
    if (isGroup(entry)) return;
    for (const option of page.options.filter(option => option.range !== null)) {
      const flag = entry.spec.flags.find(flag => option.forms.includes(`--${flag.name}`) ||
        (flag.short !== undefined && option.forms.includes(`-${flag.short}`)));
      expect(flag, option.name).toBeDefined();
      // Click uses an implicit IntRange for count, but hides it in help.
      if (flag?.type === "count") continue;
      expect(flag?.range, option.name).toMatchObject({
        min: option.range!.min ?? Number.NEGATIVE_INFINITY,
        max: option.range!.max ?? Number.POSITIVE_INFINITY,
      });
      expect(flag?.range?.integer === true).toBe(option.range!.integer);
    }
  });
});
