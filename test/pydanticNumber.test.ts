/**
 * pydantic-core's `str_as_int` / `str_as_float`, pinned against the cases
 * recorded from pydantic 2.13.4 (pydantic-core 2.46.4) in pydanticCases.ts
 * (#69).
 */

import { describe, expect, it } from "vitest";

import {
  FLOAT_PARSING,
  hasLoneSurrogate,
  pydanticFloatText,
  pydanticIntText,
  STRING_UNICODE,
} from "../src/pydanticNumber.js";
import { pyFloatRepr } from "../src/python.js";
import { FLOAT_TEXT_CASES, INT_TEXT_CASES } from "./pydanticCases.js";

/** A readable name for a case: a long input by its length. */
function label(input: string): string {
  return input.length > 40 ? `${JSON.stringify(input.slice(0, 12))}... (${input.length} chars)` : JSON.stringify(input);
}

describe("pydanticIntText: a string in an int field (#69)", () => {
  it.each(INT_TEXT_CASES.map(([input, expected]) => [label(input), input, expected] as const))(
    "%s",
    (_label, input, expected) => {
      const got = pydanticIntText(input);
      expect(got.ok ? { ok: got.value.toString() } : { err: got.msg }).toEqual(expected);
    },
  );
});

describe("pydanticFloatText: a string in a float field (#69)", () => {
  it.each(FLOAT_TEXT_CASES.map(([input, expected]) => [label(input), input, expected] as const))(
    "%s",
    (_label, input, expected) => {
      let got: { ok: string } | { err: string };
      if (hasLoneSurrogate(input)) {
        got = { err: STRING_UNICODE };
      } else {
        const value = pydanticFloatText(input);
        got = value === undefined ? { err: FLOAT_PARSING } : { ok: pyFloatRepr(value) };
      }
      expect(got).toEqual(expected);
    },
  );
});

describe("pydanticFloatText: a long digit run is refused in linear time (#69)", () => {
  it("200k digits plus a trailing x return in well under a second", () => {
    const text = `${"9".repeat(200_000)}x`;
    const started = performance.now();
    expect(pydanticFloatText(text)).toBeUndefined();
    expect(pydanticFloatText(`1_${text}`)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("hasLoneSurrogate", () => {
  it("finds a surrogate with no partner, never a pair", () => {
    expect(hasLoneSurrogate("a\u{d800}")).toBe(true);
    expect(hasLoneSurrogate("\u{dc00}\u{d800}")).toBe(true);
    expect(hasLoneSurrogate("\u{1f600}")).toBe(false);
    expect(hasLoneSurrogate("")).toBe(false);
  });
});
