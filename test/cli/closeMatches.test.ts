/**
 * The `difflib` port behind click's option suggestions, pinned against
 * CPython 3.12's `difflib` (every expected value below was printed by it).
 */

import { describe, expect, it } from "vitest";

import { getCloseMatches, sequenceRatio } from "../../src/cli/closeMatches.js";

describe("sequenceRatio", () => {
  it.each([
    ["abcd", "bcde", 0.75],
    ["--progress", "--profile", 0.631578947368421],
    ["", "", 1],
    ["", "a", 0],
    // By code point, as Python iterates a str.
    ["é😀x", "😀x", 0.8],
    // autojunk: in a second sequence of 200 or more, an element making up
    // more than 1% of it is left out of the index.
    ["a".repeat(250) + "b", "b" + "a".repeat(250), 0.00398406374501992],
    ["ab".repeat(120), "ba".repeat(130), 0],
    ["x" + "abc".repeat(70), "abc".repeat(70) + "y", 0],
  ])("SequenceMatcher(None, %j, %j).ratio() is %s", (a, b, expected) => {
    expect(sequenceRatio(a, b)).toBe(expected);
  });
});

describe("getCloseMatches", () => {
  const UPLOAD = ["--help", "--progress", "--remember", "--summary", "--tags", "--importance", "--context-id", "--verbose"];
  const IMPORT = ["--help", "--resource-id", "--api-key", "--file", "--format", "--id-column", "--version", "--verbose", "--progress"];
  const SERIES = ["--help", "--start", "--end", "--period", "--agg"];
  const DIGEST = ["--help", "--out", "--target", "--profile", "--tools"];

  it.each([
    ["--profile", UPLOAD, ["--progress"]],
    ["--profile", IMPORT, ["--file", "--progress"]],
    ["--per", SERIES, ["--period", "--end"]],
    ["--tar", DIGEST, ["--target", "--out"]],
    ["--js", ["--help", "--workspace", "--json"], ["--json"]],
    ["--verison", IMPORT, ["--version", "--verbose"]],
    ["--p", UPLOAD, ["--help"]],
    ["--x", UPLOAD, []],
  ])("get_close_matches(%j, …) is %j", (word, possibilities, expected) => {
    expect(getCloseMatches(word, possibilities)).toEqual(expected);
  });

  it("keeps the best n, the greater string first among equal scores, as heapq.nlargest does", () => {
    expect(getCloseMatches("ab", ["ba", "ab_", "_ab", "xab", "aby"], 2, 0.5)).toEqual(["xab", "aby"]);
  });
});
