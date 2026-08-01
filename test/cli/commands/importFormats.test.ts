import { describe, expect, it } from "vitest";

import {
  detectFormat,
  parseCsv,
  parseCsvRows,
  parseJsonl,
  parseRecords,
} from "../../../src/cli/commands/importFormats.js";
import { CliUsageError } from "../../../src/cli/parse.js";

describe("parseCsvRows (RFC 4180)", () => {
  it("splits plain rows", () => {
    expect(parseCsvRows("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps a comma inside quotes in one field", () => {
    // The reason this is hand-written: `line.split(",")` corrupts this,
    // and quoted commas are in most real exports.
    expect(parseCsvRows('a,b\n"x,y",2')).toEqual([
      ["a", "b"],
      ["x,y", "2"],
    ]);
  });

  it('treats "" inside quotes as one literal quote', () => {
    expect(parseCsvRows('a\n"say ""hi"""')).toEqual([["a"], ['say "hi"']]);
  });

  it("keeps a newline inside quotes in one field", () => {
    expect(parseCsvRows('a,b\n"line1\nline2",2')).toEqual([
      ["a", "b"],
      ["line1\nline2", "2"],
    ]);
  });

  it("normalizes CRLF without leaving a stray CR", () => {
    expect(parseCsvRows("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("does not invent a trailing empty row", () => {
    expect(parseCsvRows("a\n1\n")).toEqual([["a"], ["1"]]);
  });

  it("keeps a final row that has no trailing newline", () => {
    expect(parseCsvRows("a\n1")).toEqual([["a"], ["1"]]);
  });

  it("keeps empty fields", () => {
    expect(parseCsvRows("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });

  it("keeps a quoted empty field", () => {
    expect(parseCsvRows('a,b\n"",2')).toEqual([
      ["a", "b"],
      ["", "2"],
    ]);
  });
});

describe("parseCsv", () => {
  it("keys rows by the header", () => {
    expect(parseCsv("name,qty\nwidget,3")).toEqual([{ name: "widget", qty: "3" }]);
  });

  it("returns nothing for a header-only file", () => {
    expect(parseCsv("name,qty\n")).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("fills a missing trailing cell rather than dropping the key", () => {
    expect(parseCsv("a,b\n1")).toEqual([{ a: "1", b: "" }]);
  });
});

describe("parseJsonl", () => {
  it("reads one object per line and skips blanks", () => {
    expect(parseJsonl('{"a":1}\n\n{"a":2}\n', "f")).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("names the offending line number", () => {
    expect(() => parseJsonl('{"a":1}\nnot json', "f")).toThrow(/line 2 of f/);
  });

  it("rejects a non-object line", () => {
    expect(() => parseJsonl("[1,2]", "f")).toThrow(CliUsageError);
  });
});

describe("detectFormat", () => {
  it.each([
    ['[{"a":1}]', "json"],
    ['{"a":1}', "json"],
    ['{"a":1}\n{"a":2}', "jsonl"],
    ["name,qty\nwidget,3", "csv"],
    ["  \n[1]", "json"],
  ])("detects %j as %s", (text, expected) => {
    expect(detectFormat(text)).toBe(expected);
  });
});

describe("parseRecords", () => {
  it("honours an explicit format over detection", () => {
    // A CSV whose first cell happens to start with `{` must still be read
    // as CSV when asked.
    expect(parseRecords('a\n"{x}"', "csv", "f")).toEqual([{ a: "{x}" }]);
  });

  it("accepts a single JSON object as one record", () => {
    expect(parseRecords('{"a":1}', "json", "f")).toEqual([{ a: 1 }]);
  });

  it("accepts a JSON array", () => {
    expect(parseRecords('[{"a":1},{"a":2}]', "json", "f")).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("rejects a JSON array containing a non-object", () => {
    expect(() => parseRecords("[1]", "json", "f")).toThrow(/index 0 of f/);
  });

  it("reports malformed JSON as a usage error", () => {
    expect(() => parseRecords("{oops", "json", "f")).toThrow(CliUsageError);
  });
});
