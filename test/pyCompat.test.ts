/**
 * The Python string semantics in `src/pyCompat.ts`. Every expected value
 * was produced by CPython 3.12 (`repr(s)`, `str(uuid.UUID(s))`,
 * `s.strip()`), so these pin the port to the real behaviour rather than to
 * a reading of it.
 */

import { describe, expect, it } from "vitest";

import { normalizeUuid, pyRepr, pyStrip } from "../src/pyCompat.js";

const CTX = "11111111-2222-3333-4444-555555555555";

describe("pyStrip", () => {
  it("strips Python's whitespace set, not JavaScript's", () => {
    expect(pyStrip(" \t\n x \r\v\f")).toBe("x");
    // Python strips the information separators and NEL; trim() does not.
    expect(pyStrip("\x1cx\x1f\x85")).toBe("x");
    // trim() strips a BOM; Python keeps it.
    expect(pyStrip("\ufeffx")).toBe("\ufeffx");
    expect(pyStrip("\u3000\u2028x\u00a0")).toBe("x");
    expect(pyStrip("   ")).toBe("");
  });
});

describe("pyRepr", () => {
  it.each([
    ["plain", "'plain'"],
    ["it's", `"it's"`],
    [`both ' and "`, `'both \\' and "'`],
    ["a\nb\tc\rd", "'a\\nb\\tc\\rd'"],
    ["C:\\Users", "'C:\\\\Users'"],
    ["\x00\x1f\x7f", "'\\x00\\x1f\\x7f'"],
    ["\x85\xa0", "'\\x85\\xa0'"],
    ["\u2028\ufeff", "'\\u2028\\ufeff'"],
    ["caf\u00e9 \u65e5\u672c", "'caf\u00e9 \u65e5\u672c'"],
    ["\u{1F600}", "'\u{1F600}'"],
    ["\ud800", "'\\ud800'"],
    ["\u{E0001}", "'\\U000e0001'"],
    ["\u3000", "'\\u3000'"],
    [" ", "' '"],
  ])("repr(%j) is %s", (value, expected) => {
    expect(pyRepr(value)).toBe(expected);
  });
});

describe("normalizeUuid", () => {
  it.each([
    [CTX, CTX],
    [CTX.toUpperCase(), CTX],
    [`{${CTX}}`, CTX],
    [`{{${CTX}}}`, CTX],
    [`urn:uuid:${CTX}`, CTX],
    [`uuid:${CTX}`, CTX],
    ["11111111222233334444555555555555", CTX],
    // uuid.UUID drops every `urn:` and every dash, wherever they are.
    ["11111111urn:-2222-3333-4444-555555555555", CTX],
    // Then int(hex, 16) takes a sign, a 0x prefix, whitespace and
    // underscores within the 32 characters left.
    ["+1111111222233334444555555555555", "01111111-2222-3333-4444-555555555555"],
    ["0x111111222233334444555555555555", "00111111-2222-3333-4444-555555555555"],
    ["0x_11111122223333444455555555555", "00011111-1222-2333-3444-455555555555"],
    [" 1111111222233334444555555555555", "01111111-2222-3333-4444-555555555555"],
    ["1111111_222233334444555555555555", "01111111-2222-3333-4444-555555555555"],
  ])("normalizes %j like uuid.UUID", (value, expected) => {
    expect(normalizeUuid(value, "context_id")).toBe(expected);
  });

  it.each([
    // No trimming first: a padded UUID is 33 characters, so it is refused.
    [` ${CTX}`, `' ${CTX}'`],
    [`${CTX} `, `'${CTX} '`],
    ["not-a-uuid", "'not-a-uuid'"],
    ["", "''"],
    ["11111111-2222-3333-4444-55555555555g", "'11111111-2222-3333-4444-55555555555g'"],
    ["1111111__222233334444555555555555", "'1111111__222233334444555555555555'"],
    ["_1111111222233334444555555555555", "'_1111111222233334444555555555555'"],
    ["1111111222233334444555555555555_", "'1111111222233334444555555555555_'"],
    ["++111111222233334444555555555555", "'++111111222233334444555555555555'"],
    ["0x+11111222233334444555555555555", "'0x+11111222233334444555555555555'"],
    ["it's", `"it's"`],
  ])("refuses %j with Python's message", (value, shown) => {
    expect(() => normalizeUuid(value, "context_id")).toThrow(
      new Error(`context_id must be a UUID, got ${shown}`),
    );
  });

  it("names the parameter it was given", () => {
    expect(() => normalizeUuid("x", "workspace_id")).toThrow(
      "workspace_id must be a UUID, got 'x'",
    );
  });

  it("refuses a non-string from an untyped caller", () => {
    expect(() => normalizeUuid(42, "context_id")).toThrow("context_id must be a UUID, got 42");
  });
});
