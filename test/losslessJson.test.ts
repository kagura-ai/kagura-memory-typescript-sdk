/**
 * The response reader reads a body as Python's `json.loads` does (#69).
 * The messages below were recorded from CPython 3.11.9's `json.loads`
 * (the C scanner the Python SDK runs on), the depth from the Python CLI
 * 0.42.0 (click 8.3.3, pydantic 2.13.4).
 */

import { describe, expect, it } from "vitest";

import { KaguraError } from "../src/errors.js";
import {
  INT_MAX_STR_DIGITS,
  JsonDecodeError,
  JsonNestingError,
  JsonNumber,
  jsonValue,
  MAX_JSON_DEPTH,
  orderedEntries,
  parseJsonLossless,
  valueAt,
} from "../src/losslessJson.js";

/** Python's `str(JSONDecodeError)` for each body, `json.loads(body.encode())`. */
const DECODE_ERRORS: ReadonlyArray<[body: string, message: string]> = [
  ["", "Expecting value: line 1 column 1 (char 0)"],
  [" ", "Expecting value: line 1 column 2 (char 1)"],
  ["[", "Expecting value: line 1 column 2 (char 1)"],
  ["[1", "Expecting ',' delimiter: line 1 column 3 (char 2)"],
  ["[1,", "Expecting value: line 1 column 4 (char 3)"],
  ["[1,]", "Expecting value: line 1 column 4 (char 3)"],
  ["[1 2]", "Expecting ',' delimiter: line 1 column 4 (char 3)"],
  ["{", "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"],
  ["{\"a\"", "Expecting ':' delimiter: line 1 column 5 (char 4)"],
  ["{\"a\":", "Expecting value: line 1 column 6 (char 5)"],
  ["{\"a\":1", "Expecting ',' delimiter: line 1 column 7 (char 6)"],
  ["{\"a\":1,", "Expecting property name enclosed in double quotes: line 1 column 8 (char 7)"],
  ["{\"a\":1,}", "Expecting property name enclosed in double quotes: line 1 column 8 (char 7)"],
  ["{\"a\" 1}", "Expecting ':' delimiter: line 1 column 6 (char 5)"],
  ["{1:2}", "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"],
  ["{\"a\":1 \"b\":2}", "Expecting ',' delimiter: line 1 column 8 (char 7)"],
  ["\"abc", "Unterminated string starting at: line 1 column 1 (char 0)"],
  ["\"a\\", "Unterminated string starting at: line 1 column 1 (char 0)"],
  ["\"a\\x\"", "Invalid \\escape: line 1 column 3 (char 2)"],
  ["\"\\u12\"", "Invalid \\uXXXX escape: line 1 column 3 (char 2)"],
  ["\"\\u12G4\"", "Invalid \\uXXXX escape: line 1 column 3 (char 2)"],
  ["\"\\uX123\"", "Invalid \\uXXXX escape: line 1 column 3 (char 2)"],
  ["\"\\u1234", "Invalid \\uXXXX escape: line 1 column 3 (char 2)"],
  ["\"\\ud800\\uZZZZ\"", "Invalid \\uXXXX escape: line 1 column 9 (char 8)"],
  ["\"a\u0001b\"", "Invalid control character at: line 1 column 3 (char 2)"],
  ["\"a\nb\"", "Invalid control character at: line 1 column 3 (char 2)"],
  ["01", "Extra data: line 1 column 2 (char 1)"],
  ["1.", "Extra data: line 1 column 2 (char 1)"],
  ["-", "Expecting value: line 1 column 1 (char 0)"],
  ["-a", "Expecting value: line 1 column 1 (char 0)"],
  ["1e", "Extra data: line 1 column 2 (char 1)"],
  ["1e+", "Extra data: line 1 column 2 (char 1)"],
  ["1e-", "Extra data: line 1 column 2 (char 1)"],
  [".5", "Expecting value: line 1 column 1 (char 0)"],
  ["+1", "Expecting value: line 1 column 1 (char 0)"],
  ["1_0", "Extra data: line 1 column 2 (char 1)"],
  ["-01", "Extra data: line 1 column 3 (char 2)"],
  ["[1.e2]", "Expecting ',' delimiter: line 1 column 3 (char 2)"],
  ["[01]", "Expecting ',' delimiter: line 1 column 3 (char 2)"],
  ["nul", "Expecting value: line 1 column 1 (char 0)"],
  ["tru", "Expecting value: line 1 column 1 (char 0)"],
  ["NaN1", "Extra data: line 1 column 4 (char 3)"],
  ["-NaN", "Expecting value: line 1 column 1 (char 0)"],
  ["+Infinity", "Expecting value: line 1 column 1 (char 0)"],
  ["Infinityx", "Extra data: line 1 column 9 (char 8)"],
  ["[-Inf]", "Expecting value: line 1 column 2 (char 1)"],
  ["[1]x", "Extra data: line 1 column 4 (char 3)"],
  ["true false", "Extra data: line 1 column 6 (char 5)"],
  ["{\"a\":}", "Expecting value: line 1 column 6 (char 5)"],
  ["[,]", "Expecting value: line 1 column 2 (char 1)"],
  ["{,}", "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"],
  ["{\"a\":1,,}", "Expecting property name enclosed in double quotes: line 1 column 8 (char 7)"],
  ["[1,,2]", "Expecting value: line 1 column 4 (char 3)"],
  ["\n\n  x", "Expecting value: line 3 column 3 (char 4)"],
  ["{\"a\":1}\n  {", "Extra data: line 2 column 3 (char 10)"],
  ["{\n  \"name\": \"k\\x\"\n}", "Invalid \\escape: line 2 column 13 (char 14)"],
  // Positions count code points, as a Python str index does.
  ["\"\u65e5\u672c\"x", "Extra data: line 1 column 5 (char 4)"],
  ["\"\ud83d\ude00\" x", "Extra data: line 1 column 5 (char 4)"],
  // fetch's text() drops one UTF-8 BOM, as json.loads(bytes) does; a second is text.
  ["\ufeff[]", "Expecting value: line 1 column 1 (char 0)"],
  ["<html>maintenance</html>", "Expecting value: line 1 column 1 (char 0)"],
];

function nested(depth: number, open: string, close: string, inner = ""): string {
  return open.repeat(depth) + inner + close.repeat(depth);
}

describe("parseJsonLossless: Python's json.loads", () => {
  it("returns what JSON.parse returns, keys in the same order", () => {
    const body =
      '{"s": "a\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\ud83d\\ude00\\ud800", "n": [0, -0, 1.5e3, -2E-2, 9007199254740993], ' +
      '"t": true, "f": false, "z": null, "o": {"2": 1, "b": {}, "1": []}, " spaced " : [ ] }';
    const parsed = parseJsonLossless(body);
    expect(parsed).toEqual(JSON.parse(body));
    expect(Object.keys((parsed as { o: object }).o)).toEqual(["1", "2", "b"]);
    expect(Object.is((parsed as { n: number[] }).n[1], -0)).toBe(true);
  });

  it("reads a large body in one pass, to JSON.parse's values", () => {
    const events = Array.from({ length: 20000 }, (_, i) => ({
      id: i,
      doc_id: `SKU-${i}`,
      importance: i / 7,
      payload: { name: 'Widget \u65e5\u672c "q"', "2": i, tags: ["a", "b"] },
    }));
    const body = JSON.stringify({ events });
    expect(body.length).toBeGreaterThan(2_000_000);
    expect(parseJsonLossless(body)).toEqual(JSON.parse(body));
  });

  it.each(DECODE_ERRORS)("refuses %j as Python does", (body, message) => {
    let error: unknown;
    try {
      parseJsonLossless(body);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(JsonDecodeError);
    expect(error).toBeInstanceOf(SyntaxError);
    expect((error as Error).message).toBe(message);
  });

  it("reads NaN, Infinity and -Infinity as those floats", () => {
    const parsed = parseJsonLossless('{"a": NaN, "b": Infinity, "c": [-Infinity]}') as {
      a: number;
      b: number;
      c: number[];
    };
    expect(parsed.a).toBeNaN();
    expect(parsed.b).toBe(Infinity);
    expect(parsed.c[0]).toBe(-Infinity);
    expect((valueAt(parsed, "a") as JsonNumber).text).toBe("NaN");
    expect((valueAt(parsed.c, 0) as JsonNumber).isInt).toBe(false);
  });

  it("reads a top-level number as a plain number", () => {
    expect(parseJsonLossless(" 12 ")).toBe(12);
    expect(parseJsonLossless("NaN")).toBeNaN();
  });

  it("refuses an int literal past 4,300 digits with Python's int() message", () => {
    expect(INT_MAX_STR_DIGITS).toBe(4300);
    expect(parseJsonLossless(`[${"1".repeat(4300)}]`)).toHaveLength(1);
    expect(() => parseJsonLossless(`[${"1".repeat(4301)}]`)).toThrow(
      new JsonDecodeError(
        "Exceeds the limit (4300 digits) for integer string conversion: value has 4301 digits; " +
          "use sys.set_int_max_str_digits() to increase the limit",
      ),
    );
    // The sign is no digit, and a float literal has no limit.
    expect(parseJsonLossless(`-${"1".repeat(4300)}`)).toBe(-Infinity);
    expect(() => parseJsonLossless(`-${"1".repeat(4301)}`)).toThrow("value has 4301 digits");
    expect(parseJsonLossless(`${"1".repeat(5000)}.0`)).toBe(Infinity);
  });

  it("stops past 973 containers with Python's RecursionError message", () => {
    expect(MAX_JSON_DEPTH).toBe(973);
    expect(() => parseJsonLossless(nested(973, "[", "]"))).not.toThrow();
    expect(() => parseJsonLossless(nested(972, '{"a": ', "}", "[]"))).not.toThrow();
    const arrays = (() => {
      try {
        parseJsonLossless(nested(974, "[", "]"));
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(arrays).toBeInstanceOf(JsonNestingError);
    expect(arrays).toBeInstanceOf(KaguraError);
    expect((arrays as Error).message).toBe(
      "maximum recursion depth exceeded while decoding a JSON array from a unicode string",
    );
    expect(() => parseJsonLossless(nested(973, "[", "]", "{}"))).toThrow(
      "maximum recursion depth exceeded while decoding a JSON object from a unicode string",
    );
    expect(() => parseJsonLossless(nested(10000, "[", "]"))).toThrow(JsonNestingError);
  });
});

describe("the number literals and key order it keeps", () => {
  it("keeps each number literal as written, int or float", () => {
    const parsed = parseJsonLossless(
      '{"big": 9007199254740993, "neg0": -0, "negf": -0.0, "e": 1e20, "E": 1E5, "list": [2.50, 7]}',
    ) as Record<string, unknown> & { list: unknown[] };
    const big = valueAt(parsed, "big") as JsonNumber;
    expect(big).toBeInstanceOf(JsonNumber);
    expect([big.text, big.isInt, big.value, big.bigint()]).toEqual([
      "9007199254740993",
      true,
      9007199254740992,
      9007199254740993n,
    ]);
    const neg0 = valueAt(parsed, "neg0") as JsonNumber;
    expect([neg0.isInt, Object.is(neg0.value, -0), neg0.bigint()]).toEqual([true, true, 0n]);
    expect((valueAt(parsed, "negf") as JsonNumber).isInt).toBe(false);
    expect((valueAt(parsed, "e") as JsonNumber).isInt).toBe(false);
    expect(() => (valueAt(parsed, "e") as JsonNumber).bigint()).toThrow(RangeError);
    expect((valueAt(parsed, "E") as JsonNumber).text).toBe("1E5");
    expect((valueAt(parsed.list, 0) as JsonNumber).text).toBe("2.50");
    expect((valueAt(parsed.list, 1) as JsonNumber).text).toBe("7");
    // The plain value is JSON.parse's.
    expect(parsed.big).toBe(9007199254740992);
    expect(jsonValue(big)).toBe(9007199254740992);
    expect(jsonValue("x")).toBe("x");
  });

  it("gives a value changed since it was read as it now is, and nothing for a missing key", () => {
    const parsed = parseJsonLossless('{"a": 1.0, "b": "x"}') as Record<string, unknown>;
    parsed.a = 2;
    expect(valueAt(parsed, "a")).toBe(2);
    expect(valueAt(parsed, "b")).toBe("x");
    expect(valueAt(parsed, "missing")).toBeUndefined();
    expect(valueAt(parsed, "toString")).toBeUndefined();
    expect(valueAt({ plain: 1 }, "plain")).toBe(1);
  });

  it("keeps the key order written, where JSON.parse lists index keys first", () => {
    const parsed = parseJsonLossless('{"b": 1, "2": 2, "10": 3, "id": "x", "2024": 1}') as object;
    expect(orderedEntries(parsed)).toEqual([
      ["b", 1],
      ["2", 2],
      ["10", 3],
      ["id", "x"],
      ["2024", 1],
    ]);
    // Not an array index: listed where written by V8 too.
    const other = parseJsonLossless('{"b": 1, "4294967295": 2, "01": 3, "-1": 4}') as object;
    expect(orderedEntries(other).map(([k]) => k)).toEqual(["b", "4294967295", "01", "-1"]);
  });

  it("keeps a duplicate key at its first place with its last value, as a Python dict does", () => {
    const parsed = parseJsonLossless('{"k": 1, "3": "a", "k": 2.50, "__proto__": {"x": 1}}') as Record<
      string,
      unknown
    >;
    expect(orderedEntries(parsed)).toEqual([
      ["k", 2.5],
      ["3", "a"],
      ["__proto__", { x: 1 }],
    ]);
    expect((valueAt(parsed, "k") as JsonNumber).text).toBe("2.50");
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    const replaced = parseJsonLossless('{"k": 1, "k": "s"}') as Record<string, unknown>;
    expect(valueAt(replaced, "k")).toBe("s");
  });

  it("lists keys removed since it was read no more, and keys added after the rest", () => {
    const parsed = parseJsonLossless('{"b": 1, "2": 2, "c": 3}') as Record<string, unknown>;
    delete parsed.c;
    parsed.a = 4;
    parsed["1"] = 5;
    expect(orderedEntries(parsed)).toEqual([
      ["b", 1],
      ["2", 2],
      ["1", 5],
      ["a", 4],
    ]);
    expect(orderedEntries({ 2: "x", a: "y" })).toEqual([
      ["2", "x"],
      ["a", "y"],
    ]);
  });
});
