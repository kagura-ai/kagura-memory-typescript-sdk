/**
 * The request-side range checks shared by recall's `full` and every
 * `maxChars` (#82) — the Python SDK's `_validate_int_range` /
 * `_validate_max_chars`, with their wording.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_CHARS_MAX,
  MAX_CHARS_MIN,
  RECALL_FULL_MAX,
  validateIntRange,
  validateMaxChars,
} from "../src/responseBudget.js";

describe("validateIntRange", () => {
  it("returns an integer in range as a number, a bigint included", () => {
    expect(validateIntRange("full", 0, 0, 100)).toBe(0);
    expect(validateIntRange("full", 100, 0, 100)).toBe(100);
    expect(validateIntRange("full", 7n, 0, 100)).toBe(7);
  });

  it.each([
    [101, "101"],
    [-1, "-1"],
    [2.5, "2.5"],
    [true, "True"],
    ["3", "'3'"],
    [null, "None"],
    [Number.NaN, "nan"],
  ])("refuses %o in the Python SDK's words", (value, shown) => {
    expect(() => validateIntRange("full", value, 0, 100)).toThrow(
      `full must be an integer between 0 and 100, got ${shown}`,
    );
  });

  it("words an open upper bound as Python does", () => {
    expect(validateIntRange("limit", 10 ** 9, 1)).toBe(10 ** 9);
    expect(() => validateIntRange("limit", 0, 1)).toThrow("limit must be an integer of at least 1, got 0");
  });
});

describe("validateMaxChars", () => {
  it("takes the server's range, 10,000-100,000", () => {
    expect([MAX_CHARS_MIN, MAX_CHARS_MAX, RECALL_FULL_MAX]).toEqual([10_000, 100_000, 100]);
    expect(validateMaxChars(10_000)).toBe(10_000);
    expect(validateMaxChars(100_000)).toBe(100_000);
    expect(() => validateMaxChars(9_999)).toThrow(
      "maxChars must be an integer between 10000 and 100000, got 9999",
    );
  });
});
