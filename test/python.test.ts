/**
 * Python value semantics, pinned against CPython 3.12 (the vectors were
 * printed by `repr()`, `int()` and `float()` themselves).
 */

import { describe, expect, it } from "vitest";

import {
  PY_FLOAT,
  PY_INT,
  pyBigInt,
  pyFloat,
  pyFloatAscii,
  pyFloatRepr,
  pyInt,
  pyIsPrintable,
  pyRepr,
  pyTruthy,
  pyTypeName,
  reprlibRepr,
} from "../src/python.js";

describe("pyRepr of a string", () => {
  it.each([
    ["plain", "'plain'"],
    ["a\nb", "'a\\nb'"],
    ["tab\there", "'tab\\there'"],
    ["it's", `"it's"`],
    ['say "hi"', `'say "hi"'`],
    [`both ' and "`, `'both \\' and "'`],
    ["C:\\Users", "'C:\\\\Users'"],
    ["\u0000ctrl", "'\\x00ctrl'"],
    ["\u007fdel", "'\\x7fdel'"],
    [" space ", "' space '"],
    // Beyond ASCII: what str.isprintable() rejects is escaped, in the
    // shortest of \x, \u and \U.
    ["\u0085nel", "'\\x85nel'"],
    ["a\u00a0b", "'a\\xa0b'"],
    ["zero\u200bwidth", "'zero\\u200bwidth'"],
    ["\u2028line", "'\\u2028line'"],
    ["\u3000ideo", "'\\u3000ideo'"],
    ["\ufeffbom", "'\\ufeffbom'"],
    ["\ue000private", "'\\ue000private'"],
    ["\u0378unassigned", "'\\u0378unassigned'"],
    ["\ud800lone", "'\\ud800lone'"],
    ["tag\u{e0001}", "'tag\\U000e0001'"],
    // Printable non-ASCII stays as it is.
    ["é日本😀", "'é日本😀'"],
  ])("matches repr(%j)", (input, expected) => {
    expect(pyRepr(input)).toBe(expected);
  });
});

describe("pyRepr of other values", () => {
  it.each([
    [null, "None"],
    [undefined, "None"],
    [true, "True"],
    [false, "False"],
    [42, "42"],
    [-0, "0"],
    [1e21, "1000000000000000000000"],
    [1.5, "1.5"],
    [[1, "a", null], "[1, 'a', None]"],
    [{ k: "v", n: [true] }, "{'k': 'v', 'n': [True]}"],
    [[], "[]"],
    [{}, "{}"],
  ])("renders %j as Python would", (input, expected) => {
    expect(pyRepr(input)).toBe(expected);
  });

  it("renders a bigint as the int it is", () => {
    // Outside it.each: the runner cannot serialize a bigint into a title.
    expect(pyRepr(10n)).toBe("10");
    expect(pyTypeName(10n)).toBe("int");
  });

  it("marks a container that holds itself, as Python does, instead of recursing forever", () => {
    const list: unknown[] = [1];
    list.push(list);
    const dict: Record<string, unknown> = {};
    dict.self = dict;
    expect(pyRepr(list)).toBe("[1, [...]]");
    expect(pyRepr(dict)).toBe("{'self': {...}}");
  });
});

describe("pyFloatRepr", () => {
  it.each([
    [2, "2.0"],
    [10, "10.0"],
    [0.1, "0.1"],
    [1.5, "1.5"],
    [0.0001, "0.0001"],
    [1e-5, "1e-05"],
    [1e15, "1000000000000000.0"],
    [9999999999999998, "9999999999999998.0"],
    [1e16, "1e+16"],
    [1e21, "1e+21"],
    [1.2345678901234568e17, "1.2345678901234568e+17"],
    [123456789.123, "123456789.123"],
    [0.30000000000000004, "0.30000000000000004"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [-0, "-0.0"],
    [0, "0.0"],
    [NaN, "nan"],
    [Infinity, "inf"],
    [-Infinity, "-inf"],
  ])("repr(float(%s)) is %s", (input, expected) => {
    expect(pyFloatRepr(input)).toBe(expected);
  });
});

describe("pyTypeName", () => {
  it.each([
    ["s", "str"],
    [true, "bool"],
    [3, "int"],
    [3.5, "float"],
    [NaN, "float"],
    [null, "NoneType"],
    [undefined, "NoneType"],
    [[1], "list"],
    [{ a: 1 }, "dict"],
  ])("names %j %s", (input, expected) => {
    expect(pyTypeName(input)).toBe(expected);
  });
});

describe("int() grammar", () => {
  it.each([
    ["1_000", 1000],
    ["1_0_0", 100],
    ["+7", 7],
    [" 7 ", 7],
    ["\t5\n", 5],
    ["04000", 4000],
    ["-0", 0],
  ])("int(%j) is %s", (input, expected) => {
    expect(pyInt(input)).toBe(expected);
    expect(Object.is(pyInt(input), -0)).toBe(false);
  });

  it.each([["_1"], ["1_"], ["1__0"], ["-_1"], ["0x10"], ["1.0"], [""], ["+"]])(
    "int(%j) raises ValueError",
    (input) => {
      expect(pyInt(input)).toBeUndefined();
      expect(PY_INT.test(input.trim())).toBe(false);
    },
  );

  // Python strips what int() and float() skip, not what trim() does, and
  // reads any decimal digit (CPython 3.12, click 8.3.3's INT and FLOAT).
  it.each([
    ["\u{85}5", 5],
    ["\u{a0}5", 5],
    ["\u{3000}5\u{2028}", 5],
    ["\u{b}5", 5],
    ["\u{661}", 1],
    ["\u{ff11}\u{ff12}", 12],
    ["\u{661}_\u{662}", 12],
    ["+\u{661}", 1],
    ["\u{e53}", 3],
    ["\u{96b}", 5],
    // Mathematical digits, five sets back to back.
    ["\u{1d7d3}", 5],
    ["\u{1d7ce}_1", 1],
  ])("int(%j) is %s, as Python reads it", (input, expected) => {
    expect(pyInt(input)).toBe(expected);
    expect(pyFloat(input)).toBe(expected);
  });

  it.each([["\u{feff}5"], ["\u{1c}5"], ["5\u{1f}"], ["5\u{0}"], ["\u{7f}5"], ["\u{b2}"], ["\u{ff0b}5"], ["1\u{3000}2"]])(
    "int(%j) and float() raise ValueError, as in Python",
    (input) => {
      expect(pyInt(input)).toBeUndefined();
      expect(pyFloat(input)).toBeUndefined();
    },
  );

  it("strips the whitespace around a number in linear time, whatever lies between", () => {
    // A trailing-space alternative tried at every position was quadratic:
    // 80k spaces between two digits took seconds.
    const started = performance.now();
    expect(pyInt(`5${" ".repeat(300_000)}5`)).toBeUndefined();
    expect(pyInt(`${" ".repeat(300_000)}5${"\u{3000}".repeat(300_000)}`)).toBe(5);
    expect(pyFloat(`\u{85}${"\t".repeat(300_000)}x${"\t".repeat(300_000)}`)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("keeps an int past 2^53 exact as a bigint", () => {
    expect(pyBigInt("9007199254740993")).toBe(9007199254740993n);
    expect(pyBigInt(" 1_000_000_000_000_000_000_000 ")).toBe(10n ** 21n);
    expect(pyBigInt("\u{ff19}007199254740993")).toBe(9007199254740993n);
    expect(pyBigInt("-0")).toBe(0n);
    expect(pyBigInt("1.0")).toBeUndefined();
    // int("-０") is 0, float("-０") is -0.0.
    expect(Object.is(pyInt("-\u{ff10}"), 0)).toBe(true);
    expect(Object.is(pyFloat("-\u{ff10}"), -0)).toBe(true);
    // The number is the nearest double, as it was.
    expect(pyInt("9007199254740993")).toBe(9007199254740992);
  });
});

describe("float() grammar", () => {
  it.each([
    ["1_000.5", 1000.5],
    ["1e1_0", 1e10],
    ["1_0e1_0", 1e11],
    ["1_000_000.000_1", 1000000.0001],
    ["1.e5", 100000],
    [".5", 0.5],
    ["+.5", 0.5],
    ["5.", 5],
    [" 2.5 ", 2.5],
    ["inf", Infinity],
    ["iNf", Infinity],
    ["-Infinity", -Infinity],
  ])("float(%j) is %s", (input, expected) => {
    expect(pyFloat(input)).toBe(expected);
  });

  it.each([["nan"], ["-nan"], ["NaN"]])("float(%j) is nan", (input) => {
    expect(pyFloat(input)).toBeNaN();
  });

  it.each([["_1"], ["1_.5"], ["1._5"], ["1e_1"], ["1__0"], ["0x1"], ["1e"], ["e1"], ["."], [""], ["1,5"]])(
    "float(%j) raises ValueError",
    (input) => {
      expect(pyFloat(input)).toBeUndefined();
      expect(PY_FLOAT.test(input.trim())).toBe(false);
    },
  );

  it.each([
    ["\u{663}.\u{665}", 3.5],
    ["1e\u{ff11}", 10],
    ["\u{ff11}e1", 10],
    ["\u{85}-2.5\u{a0}", -2.5],
  ])("float(%j) is %s, as Python reads it", (input, expected) => {
    expect(pyFloat(input)).toBe(expected);
  });

  it("reads ASCII digits only for pydantic's lax float, stripped as float() strips", () => {
    expect(pyFloatAscii("\u{85}5 ")).toBe(5);
    expect(pyFloatAscii("\u{661}")).toBeUndefined();
    expect(pyFloatAscii("\u{feff}5")).toBeUndefined();
  });
});

describe("pyTruthy", () => {
  it.each([
    [null, false],
    [undefined, false],
    [false, false],
    [0, false],
    ["", false],
    [[], false],
    [{}, false],
    [true, true],
    [1, true],
    [-0.5, true],
    ["x", true],
    [[0], true],
    [{ a: null }, true],
  ])("reads %j as Python's bool() does", (value, expected) => {
    expect(pyTruthy(value)).toBe(expected);
  });
});

describe("pyIsPrintable", () => {
  it.each([
    ["0.77.0", true],
    ["a b", true],
    ["", true],
    ["\u001b[2J", false],
    ["a\nb", false],
    ["a\u00a0b", false],
  ])("%j -> %s, as str.isprintable()", (text, expected) => {
    expect(pyIsPrintable(text)).toBe(expected);
  });
});

/**
 * `reprlib.repr()` with the default `Repr` (CPython 3.11.9), recorded with
 * `kagura_memory.setup_harness._shown_version` on values it passes to it.
 * A JSON number that is whole (`1.0`, `1e300`) reads as an int in
 * JavaScript, so floats are only the non-whole ones here.
 */
describe("reprlibRepr", () => {
  it.each<[unknown, string]>([
    ["0.76.0\u001b[2J", "'0.76.0\\x1b[2J'"],
    ["9".repeat(65), "'999999999999...9999999999999'"],
    ["a\nb", "'a\\nb'"],
    ["é".repeat(70), "'éééééééééééé...ééééééééééééé'"],
    ["\u001b".repeat(10), "'\\x1b\\x1b\\x1b...b\\x1b\\x1b\\x1b'"],
    ["a".repeat(20) + "\u001b".repeat(20), "'aaaaaaaaaaaa...b\\x1b\\x1b\\x1b'"],
    ["\u001b".repeat(70), "'\\x1b\\x1b\\x1b...b\\x1b\\x1b\\x1b'"],
    [76, "76"],
    [-5, "-5"],
    [10n ** 45n, "100000000000000000...0000000000000000000"],
    [1.5, "1.5"],
    [true, "True"],
    [false, "False"],
    [null, "None"],
    [[1, 2, 3, 4, 5, 6, 7], "[1, 2, 3, 4, 5, 6, ...]"],
    [{ b: 1, a: 2, c: 3, d: 4, e: 5 }, "{'a': 2, 'b': 1, 'c': 3, 'd': 4, ...}"],
    [[[[[[[[1]]]]]]], "[[[[[[[...]]]]]]]"],
    [{ v: "x".repeat(40) }, "{'v': 'xxxxxxxxxxxx...xxxxxxxxxxxxx'}"],
    [["x".repeat(40)], "['xxxxxxxxxxxx...xxxxxxxxxxxxx']"],
    [[], "[]"],
    [{}, "{}"],
  ])("case %# -> %s", (value, expected) => {
    // %# (the index), not %j: JSON.stringify throws on the bigint case.
    expect(reprlibRepr(value)).toBe(expected);
  });
});
