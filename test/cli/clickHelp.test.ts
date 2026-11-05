import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatParagraphs, formatTable, formatUsage, wrapText } from "../../src/cli/clickHelp.js";

type Case = { kind: "table"; rows: [string, string][]; expected: string } |
  { kind: "usage"; path: string; args: string; expected: string } |
  { kind: "wrap"; text: string; width: number; expected: string };
// Recorded from click==8.3.3 HelpFormatter(width=80) / wrap_text.
const cases: Case[] = JSON.parse(readFileSync(new URL("./helpLayout111.json", import.meta.url), "utf8"));
describe("Click 8.3.3 help layout (#111)", () => {
  it("preserves indentation inside a Click raw paragraph", () => {
    expect(formatParagraphs("\b\ncode\n  more")).toBe("  code\n    more");
  });
  it.each(cases)("$kind $expected", (c) => {
    const actual = c.kind === "table" ? formatTable(c.rows) : c.kind === "usage"
      ? formatUsage(c.path, c.args) : wrapText(c.text, c.width);
    expect(actual).toBe(c.expected);
  });
});
