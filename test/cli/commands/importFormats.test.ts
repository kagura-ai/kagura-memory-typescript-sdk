/**
 * The `resource import` readers. The CSV and JSON tables were produced by
 * CPython itself (`csv.reader` / `csv.DictReader` over `io.StringIO`, and
 * `json.loads`, on 3.13; 3.11 and 3.12 agree except where noted), so a
 * row here is what the Python CLI reads from the same text.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectFormat,
  EXTRA_CELLS,
  openImportInput,
  parseCsv,
  parseCsvRows,
  parseImportRows,
  parseJsonl,
  parseJsonRows,
  parsePyJson,
  PyJsonError,
  pyStrAt,
  pyTypeNameAt,
  refuseNonFinite,
} from "../../../src/cli/commands/importFormats.js";
import { CliError, CliUsageError } from "../../../src/cli/parse.js";

describe("parseCsvRows: csv.reader", () => {
  it.each<[string, string[][]]>([
    ["a,b\n1,2", [["a", "b"], ["1", "2"]]],
    ["a,b\n1,2\n", [["a", "b"], ["1", "2"]]],
    ["a,b\r\n1,2\r\n", [["a", "b"], ["1", "2"]]],
    // A blank line is a record of no fields (DictReader skips it).
    ["a,b\n\n1,2\n\n", [["a", "b"], [], ["1", "2"], []]],
    ["a,b\n1\n", [["a", "b"], ["1"]]],
    ["a,b\n1,2,3\n", [["a", "b"], ["1", "2", "3"]]],
    // The reason this is hand-written: `line.split(",")` corrupts a quoted
    // comma, and quoted commas are in most real exports.
    ['a,b\n"x,y",2', [["a", "b"], ["x,y", "2"]]],
    ['a\n"say ""hi"""', [["a"], ['say "hi"']]],
    ['a,b\n"line1\nline2",2', [["a", "b"], ["line1\nline2", "2"]]],
    ['a,b\n"",2', [["a", "b"], ["", "2"]]],
    // Not strict: text after a closing quote joins the field, and a quote
    // inside an unquoted field is a character.
    ['a\n"ab"cd', [["a"], ["abcd"]]],
    ['a\na"b', [["a"], ['a"b']]],
    // A quote still open at the end keeps what it read.
    ['a,b\n"open,2\n3,4', [["a", "b"], ["open,2\n3,4"]]],
    ["\na,b\n1,2", [[], ["a", "b"], ["1", "2"]]],
    ["a\n \n", [["a"], [" "]]],
    ["\ufeffid,name\n1,x", [["\ufeffid", "name"], ["1", "x"]]],
    ["a,b\n,\n", [["a", "b"], ["", ""]]],
    ["", []],
    ["a,b\n", [["a", "b"]]],
    ["a;b\n1;2", [["a;b"], ["1;2"]]],
    ['a\n"x"\n', [["a"], ["x"]]],
    ['a,b\n1,"2"\n', [["a", "b"], ["1", "2"]]],
    // Universal newlines: a lone CR ends a line, and a CRLF inside quotes
    // is read as LF, as Python's text mode reads the file.
    ["a\r1\r", [["a"], ["1"]]],
    ['a\n"x\r\ny"', [["a"], ["x\ny"]]],
  ])("reads %j as Python does", (text, rows) => {
    expect(parseCsvRows(text)).toEqual(rows);
  });
});

describe("parseCsv: csv.DictReader", () => {
  it.each<[string, Record<string, string | null>[]]>([
    ["a,b\n1,2", [{ a: "1", b: "2" }]],
    ["a,b\n\n1,2\n\n", [{ a: "1", b: "2" }]],
    // A short row's missing cells are None, not "".
    ["a,b\n1\n", [{ a: "1", b: null }]],
    ['a,b\n"open,2\n3,4', [{ a: "open,2\n3,4", b: null }]],
    ["a,a\n1,2", [{ a: "2" }]],
    ["a,b,a\n1", [{ a: null, b: null }]],
    ["a\n \n", [{ a: " " }]],
    ["\ufeffid,name\n1,x", [{ "\ufeffid": "1", name: "x" }]],
    ["a,b\n,\n", [{ a: "", b: "" }]],
    ["", []],
    ["a,b\n", []],
  ])("reads %j as Python does", (text, rows) => {
    expect(parseCsv(text)).toEqual(rows);
  });

  it("files the cells past the last column under the restkey, out of the payload", () => {
    const [row] = parseCsv("a,b\n1,2,3\n");
    expect(Object.entries(row!)).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(row![EXTRA_CELLS]).toEqual(["3"]);
    expect(JSON.stringify(row)).toBe('{"a":"1","b":"2"}');
  });

  it("makes __proto__ a column like any other", () => {
    const [row] = parseCsv("__proto__,b\n1,2");
    expect(Object.keys(row!)).toEqual(["__proto__", "b"]);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });
});

describe("parsePyJson: json.loads", () => {
  it.each<[string, unknown]>([
    ["[1, 2]", [1, 2]],
    ['{"a": 1, "a": 2}', { a: 2 }],
    ["[1]\n\n", [1]],
    ["  {} ", {}],
    ['"\\u00e9"', "\u00e9"],
    ['"\\uD83D\\uDE00"', "\ud83d\ude00"],
    ['"\\ud800"', "\ud800"],
    ['"a\\/b"', "a/b"],
    ["[1,\t2]", [1, 2]],
    ['"\u007f"', "\u007f"],
    ["[1e400]", [Number.POSITIVE_INFINITY]],
    ["[-0]", [-0]],
    ["[1e5]", [100000]],
    ["[1E-2]", [0.01]],
    ["[-1.25e3]", [-1250]],
    // Python reads what JSON.parse refuses.
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("reads %j", (text, value) => {
    expect(parsePyJson(text)).toEqual(value);
  });

  it.each<[string, string]>([
    ["", "Expecting value: line 1 column 1 (char 0)"],
    [" ", "Expecting value: line 1 column 2 (char 1)"],
    ["oops", "Expecting value: line 1 column 1 (char 0)"],
    ["{oops", "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"],
    // 3.11 and 3.12 read these two as "Expecting value" / "Expecting
    // property name …" one character later.
    ["[1,]", "Illegal trailing comma before end of array: line 1 column 3 (char 2)"],
    ['{"a":1,}', "Illegal trailing comma before end of object: line 1 column 7 (char 6)"],
    ['{"a":[1,{"b":2,}]}', "Illegal trailing comma before end of object: line 1 column 15 (char 14)"],
    ['{"a" 1}', "Expecting ':' delimiter: line 1 column 6 (char 5)"],
    ['{"a":1 "b":2}', "Expecting ',' delimiter: line 1 column 8 (char 7)"],
    ["[1 2]", "Expecting ',' delimiter: line 1 column 4 (char 3)"],
    ['{"a":}', "Expecting value: line 1 column 6 (char 5)"],
    ['"abc', "Unterminated string starting at: line 1 column 1 (char 0)"],
    ['"a\\qb"', "Invalid \\escape: line 1 column 3 (char 2)"],
    ['"a\\u12"', "Invalid \\uXXXX escape: line 1 column 4 (char 3)"],
    ['"a\\u12zz"', "Invalid \\uXXXX escape: line 1 column 4 (char 3)"],
    ['"a\nb"', "Invalid control character at: line 1 column 3 (char 2)"],
    ['"a\tb"', "Invalid control character at: line 1 column 3 (char 2)"],
    ['"\u0000"', "Invalid control character at: line 1 column 2 (char 1)"],
    ["[1,2", "Expecting ',' delimiter: line 1 column 5 (char 4)"],
    ["{", "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"],
    ["[", "Expecting value: line 1 column 2 (char 1)"],
    ["1 2", "Extra data: line 1 column 3 (char 2)"],
    ["{}x", "Extra data: line 1 column 3 (char 2)"],
    ["\ufeff[]", "Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)"],
    ["-", "Expecting value: line 1 column 1 (char 0)"],
    ["-x", "Expecting value: line 1 column 1 (char 0)"],
    ["1.", "Extra data: line 1 column 2 (char 1)"],
    ["1e", "Extra data: line 1 column 2 (char 1)"],
    ["01", "Extra data: line 1 column 2 (char 1)"],
    ["[01]", "Expecting ',' delimiter: line 1 column 3 (char 2)"],
    ["tru", "Expecting value: line 1 column 1 (char 0)"],
    ["日本語", "Expecting value: line 1 column 1 (char 0)"],
    ['["日本", x]', "Expecting value: line 1 column 8 (char 7)"],
    // Positions count code points: the emoji is one character to Python.
    ['["\ud83d\ude00", x]', "Expecting value: line 1 column 7 (char 6)"],
    ["\n\n  [1,\n  ,2]", "Expecting value: line 4 column 3 (char 10)"],
    ["[1,\r\n x]", "Expecting value: line 2 column 2 (char 6)"],
    ['{"a":1}{', "Extra data: line 1 column 8 (char 7)"],
    ["[-]", "Expecting value: line 1 column 2 (char 1)"],
    ["[1.5e+]", "Expecting ',' delimiter: line 1 column 5 (char 4)"],
    ['"\\', "Unterminated string starting at: line 1 column 1 (char 0)"],
    ['"\\u', "Invalid \\uXXXX escape: line 1 column 3 (char 2)"],
    ['{"a"', "Expecting ':' delimiter: line 1 column 5 (char 4)"],
    ['{"a":1', "Expecting ',' delimiter: line 1 column 7 (char 6)"],
    ["{1:2}", "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"],
    ["{,}", "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"],
    ["[,]", "Expecting value: line 1 column 2 (char 1)"],
    ["1.5.6", "Extra data: line 1 column 4 (char 3)"],
    ["-01", "Extra data: line 1 column 3 (char 2)"],
    ["0x10", "Extra data: line 1 column 2 (char 1)"],
    ['[""', "Expecting ',' delimiter: line 1 column 4 (char 3)"],
    ["[.5]", "Expecting value: line 1 column 2 (char 1)"],
    ["[+1]", "Expecting value: line 1 column 2 (char 1)"],
    ["[1\u00a0]", "Expecting ',' delimiter: line 1 column 3 (char 2)"],
    ["[1,,2]", "Expecting value: line 1 column 4 (char 3)"],
    ['{"a":1,,}', "Expecting property name enclosed in double quotes: line 1 column 8 (char 7)"],
    ['{"a"::1}', "Expecting value: line 1 column 6 (char 5)"],
    ["[1]]", "Extra data: line 1 column 4 (char 3)"],
    ['["a\\u12"]', "Invalid \\uXXXX escape: line 1 column 5 (char 4)"],
    ['"\\u12G4"', "Invalid \\uXXXX escape: line 1 column 3 (char 2)"],
    ["[1, 2, ", "Expecting value: line 1 column 8 (char 7)"],
    ['{"a": 1, ', "Expecting property name enclosed in double quotes: line 1 column 10 (char 9)"],
    ['{"a": 1, "b"', "Expecting ':' delimiter: line 1 column 13 (char 12)"],
    ["[true", "Expecting ',' delimiter: line 1 column 6 (char 5)"],
    ["[-Infinit]", "Expecting value: line 1 column 2 (char 1)"],
    ["[Infinityx]", "Expecting ',' delimiter: line 1 column 10 (char 9)"],
  ])("refuses %j in Python's words", (text, message) => {
    let error: unknown;
    try {
      parsePyJson(text);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PyJsonError);
    expect((error as Error).message).toBe(message);
  });

  it("keeps __proto__ an own key, as JSON.parse does", () => {
    const value = parsePyJson('{"__proto__": {"x": 1}}') as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
});

describe("parseJsonRows: --format json", () => {
  it("reads an array of objects", () => {
    expect(parseJsonRows('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it.each<[string, string]>([
    ["not json", "Invalid JSON: Expecting value: line 1 column 1 (char 0)"],
    ['{"not": "array"}', "JSON must be an array of objects"],
    ["[1, 2, 3]", "JSON item 0 is not an object: int"],
    ['[{}, "x"]', "JSON item 1 is not an object: str"],
    ["[{}, [1]]", "JSON item 1 is not an object: list"],
    ["[null]", "JSON item 0 is not an object: NoneType"],
    ["[true]", "JSON item 0 is not an object: bool"],
    ["[1.5]", "JSON item 0 is not an object: float"],
  ])("refuses %j with a ClickException's exit 1", (text, message) => {
    expect(() => parseJsonRows(text)).toThrow(CliError);
    expect(() => parseJsonRows(text)).toThrow(message);
  });

  it("never quotes the input in the error", () => {
    // V8's own message would read `Unexpected token 's', "sk-secret" is not valid JSON`.
    expect(() => parseJsonRows("sk-secret")).toThrow(
      /^Invalid JSON: Expecting value: line 1 column 1 \(char 0\)$/,
    );
  });
});

describe("parseJsonl: --format jsonl", () => {
  it("reads one object per line and skips blank ones", () => {
    expect(parseJsonl('{"a":1}\n\n  \n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("splits lines as str.splitlines() does", () => {
    expect(parseJsonl('{"a":1}\u2028{"a":2}\x0b{"a":3}')).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it("names the line, and the position within it", () => {
    expect(() => parseJsonl('{"ok":1}\nnot json\n{"ok":2}')).toThrow(
      "Invalid JSONL at line 2: Expecting value: line 1 column 1 (char 0)",
    );
  });

  it("strips each line first, as Python does", () => {
    expect(() => parseJsonl('  {"a" 1}')).toThrow(
      "Invalid JSONL at line 1: Expecting ':' delimiter: line 1 column 6 (char 5)",
    );
  });

  it("refuses a line that is not an object", () => {
    expect(() => parseJsonl('{"a":1}\n[1,2]')).toThrow("JSONL line 2 is not an object");
  });

  it("reads a BOM on the first line as Python does: an error", () => {
    expect(() => parseJsonl('\ufeff{"a":1}')).toThrow(
      "Invalid JSONL at line 1: Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)",
    );
  });
});

describe("parseImportRows", () => {
  it("honours the format it is given", () => {
    // A CSV whose first cell happens to start with `{` is still CSV.
    expect(parseImportRows('a\n"{x}"', "csv")).toEqual([{ a: "{x}" }]);
    expect(parseImportRows('{"a":1}', "jsonl")).toEqual([{ a: 1 }]);
    expect(() => parseImportRows('{"a":1}', "json")).toThrow("JSON must be an array of objects");
  });
});

describe("detectFormat: by extension, as Python decides it", () => {
  it.each([
    ["products.csv", "csv"],
    ["data.jsonl", "jsonl"],
    ["items.json", "json"],
    ["dir.json/items.csv", "csv"],
  ])("reads %j as %s", (name, format) => {
    expect(detectFormat(name)).toBe(format);
  });

  it.each(["<stdin>", "DATA.CSV", "notes.txt", "csv"])("refuses %j (exit 1)", (name) => {
    expect(() => detectFormat(name)).toThrow(CliError);
    expect(() => detectFormat(name)).toThrow("Cannot detect format. Use --format csv|json|jsonl");
  });
});

describe("openImportInput: click.File('r')", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-import-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("names a file that cannot be opened in click's words (exit 2)", () => {
    const missing = path.join(dir, "missing.csv");
    expect(() => openImportInput(missing, () => null)).toThrow(CliUsageError);
    expect(() => openImportInput(missing, () => null)).toThrow(
      `Invalid value for '--file' / '-f': '${missing}': No such file or directory`,
    );
  });

  it("refuses a directory, as Python's open() does", () => {
    expect(() => openImportInput(dir, () => null)).toThrow(
      `Invalid value for '--file' / '-f': '${dir}': Is a directory`,
    );
  });

  it("reads a file with universal newlines and its BOM kept", () => {
    const file = path.join(dir, "rows.csv");
    fs.writeFileSync(file, "\ufeffa,b\r\n1,2\r3,4");
    const input = openImportInput(file, () => null);
    try {
      expect(input.name).toBe(file);
      expect(input.read()).toBe("\ufeffa,b\n1,2\n3,4");
    } finally {
      input.close();
    }
  });

  it("fails the read of bytes that are not UTF-8, never quoting them (exit 1)", () => {
    const file = path.join(dir, "bad.csv");
    fs.writeFileSync(file, Buffer.from([0x61, 0x0a, 0xff, 0xfe]));
    const input = openImportInput(file, () => null);
    let error: unknown;
    try {
      input.read();
    } catch (e) {
      error = e;
    } finally {
      input.close();
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as Error).message).toMatch(/^Failed to read input: /);
    expect((error as Error).message).not.toMatch(/�|\xff/);
  });

  it("names stdin <stdin> and reads it only when asked", () => {
    let reads = 0;
    const input = openImportInput("-", () => {
      reads++;
      return "a\r\nb";
    });
    expect(input.name).toBe("<stdin>");
    expect(reads).toBe(0);
    expect(input.read()).toBe("a\nb");
    expect(reads).toBe(1);
  });

  it("reads a terminal stdin as empty", () => {
    expect(openImportInput("-", () => null).read()).toBe("");
  });

  it("names a failed read of stdin, as Python's Failed to read input does (exit 1)", () => {
    const asked: unknown[] = [];
    const input = openImportInput("-", (options) => {
      asked.push(options);
      // What readFileSync(0) throws for a non-blocking pipe with nothing in it yet.
      throw Object.assign(new Error("EAGAIN: resource temporarily unavailable, read"), { code: "EAGAIN" });
    });
    expect(() => input.read()).toThrow(CliError);
    expect(() => input.read()).toThrow(/^Failed to read input: EAGAIN: resource temporarily unavailable, read$/);
    // Asked to throw: the bin's reader otherwise reads a failure as no input.
    expect(asked[0]).toEqual({ throwOnError: true });
  });
});

describe("the order a row lists its keys in: Python's dict order", () => {
  it.each<[string, unknown]>([
    ["csv", "name,2024,1\nx,a,b\n"],
    ["json", '[{"name": "x", "2024": "a", "1": "b"}]'],
    ["jsonl", '{"name": "x", "2024": "a", "1": "b"}'],
  ])("keeps integer-like %s keys where they were read", (format, text) => {
    const [row] = parseImportRows(text as string, format as "csv" | "json" | "jsonl");
    // A plain object would list them 1, 2024, name.
    expect(Object.keys(row!)).toEqual(["name", "2024", "1"]);
    expect(JSON.stringify(row)).toBe('{"name":"x","2024":"a","1":"b"}');
    expect(row).toEqual({ name: "x", 2024: "a", 1: "b" });
  });

  it("gives a repeated key its first place and its last value, as a dict does", () => {
    const [csv] = parseCsv("b,2,b\n1,2,3\n");
    expect(Object.entries(csv!)).toEqual([
      ["b", "3"],
      ["2", "2"],
    ]);
    const json = parsePyJson('{"b": 1, "2": 2, "b": 3}') as Record<string, unknown>;
    expect(Object.entries(json)).toEqual([
      ["b", 3],
      ["2", 2],
    ]);
  });

  it("orders nested objects too, and keeps a CSV row's extra cells out of the listing", () => {
    const value = parsePyJson('{"z": {"9": 1, "a": 2}, "1": 0}') as Record<string, Record<string, unknown>>;
    expect(JSON.stringify(value)).toBe('{"z":{"9":1,"a":2},"1":0}');
    const [row] = parseCsv("n,1\nx,y,extra\n");
    expect(Object.keys(row!)).toEqual(["n", "1"]);
    expect(row![EXTRA_CELLS]).toEqual(["extra"]);
    expect(JSON.stringify(row)).toBe('{"n":"x","1":"y"}');
  });

  it("leaves a row whose order a plain object keeps as a plain object", () => {
    const [row] = parseCsv("a,b\n1,2\n");
    expect(Object.keys(row!)).toEqual(["a", "b"]);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });
});

describe("pyStrAt / pyTypeNameAt: what Python makes of a number's token", () => {
  // Each pair was printed by CPython 3.12: str(json.loads(text)["v"]).
  it.each<[string, string]>([
    ["1234567890123456789", "1234567890123456789"],
    ["1234567890123456788", "1234567890123456788"],
    ["-99999999999999999999999", "-99999999999999999999999"],
    ["-0", "0"],
    ["10.0", "10.0"],
    ["1e20", "1e+20"],
    ["1E2", "100.0"],
    ["-0.0", "-0.0"],
    ["1.5e-7", "1.5e-07"],
    ["1e16", "1e+16"],
    ["1e400", "inf"],
    ["NaN", "nan"],
    ["-Infinity", "-inf"],
    ['[1.0, {"2": 3, "a": 1.5e-7}]', "[1.0, {'2': 3, 'a': 1.5e-07}]"],
    ['{"z": 10, "1": [2.50, "s"]}', "{'z': 10, '1': [2.5, 's']}"],
    ['"text"', "text"],
    ["true", "True"],
    ["null", "None"],
  ])("str(%s) is %j", (text, expected) => {
    const row = parsePyJson(`{"v": ${text}}`) as Record<string, unknown>;
    expect(pyStrAt(row, "v")).toBe(expected);
  });

  it("keeps apart two ids a JS number would round to one", () => {
    const rows = parseJsonl('{"id": 1234567890123456789}\n{"id": 1234567890123456788}');
    expect(rows.map((row) => pyStrAt(row, "id"))).toEqual(["1234567890123456789", "1234567890123456788"]);
  });

  it("takes the last token of a repeated key, and none for a value that is no number", () => {
    const row = parsePyJson('{"v": 1.0, "v": 2}') as Record<string, unknown>;
    expect(pyStrAt(row, "v")).toBe("2");
    const replaced = parsePyJson('{"v": 1.0, "v": "x"}') as Record<string, unknown>;
    expect(pyStrAt(replaced, "v")).toBe("x");
    expect(pyTypeNameAt(replaced, "v")).toBe("str");
  });

  it.each<[string, string]>([
    ["[{}, 1.0]", "float"],
    ["[{}, 1e2]", "float"],
    ["[{}, -0]", "int"],
    ["[{}, 12345678901234567890]", "int"],
    ["[{}, NaN]", "float"],
  ])("names the type of the item in %s as %s", (text, name) => {
    expect(pyTypeNameAt(parsePyJson(text) as unknown[], 1)).toBe(name);
    expect(() => parseJsonRows(text)).toThrow(`JSON item 1 is not an object: ${name}`);
  });

  it("reads a CSV cell as the str it is, and a short row's missing cell as None", () => {
    const [row] = parseCsv("a,b\n1.0\n");
    expect(pyStrAt(row!, "a")).toBe("1.0");
    expect(pyStrAt(row!, "b")).toBe("None");
  });
});

describe("refuseNonFinite: httpx's allow_nan=False", () => {
  it.each<[string, string]>([
    ['[{"a": NaN}]', "nan"],
    ['[{"a": Infinity}]', "inf"],
    ['[{"a": [1, {"b": -Infinity}]}]', "-inf"],
    ['[{"a": 1e400}]', "inf"],
    // The first in the order Python encodes the body: z before the integer-like 2.
    ['[{"z": [1, {"k": -Infinity}], "2": NaN}]', "-inf"],
    ['[{"a": 1}, {"b": NaN}]', "nan"],
  ])("refuses %s, naming %s as CPython 3.12 does (exit 1)", (text, shown) => {
    const payloads = parseJsonRows(text);
    expect(() => refuseNonFinite(payloads)).toThrow(CliError);
    expect(() => refuseNonFinite(payloads)).toThrow(
      new RegExp(`^Out of range float values are not JSON compliant: ${shown.replace("-", "\\-")}$`),
    );
  });

  it("passes finite numbers, big ones and -0 included", () => {
    expect(() =>
      refuseNonFinite(parseJsonRows('[{"a": 1e308, "b": -0.0, "c": 12345678901234567890, "d": null}]')),
    ).not.toThrow();
  });
});
