import { describe, expect, it } from "vitest";

import { formatJson } from "../../src/cli/output.js";

describe("formatJson", () => {
  it("matches Python's json.dumps(indent=2) layout", () => {
    expect(formatJson({ a: 1, b: [1, 2] })).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
  });

  it("leaves non-ASCII literal, as ensure_ascii=False does", () => {
    // Python's default (ensure_ascii=True) would emit 日本語;
    // the CLI passes ensure_ascii=False everywhere, and JSON.stringify
    // already behaves that way. Measured byte-identical.
    expect(formatJson({ s: "日本語 — 📌" })).toBe('{\n  "s": "日本語 — 📌"\n}');
  });

  it("renders undefined as null rather than returning undefined", () => {
    // JSON.stringify(undefined) returns the *value* undefined, not a
    // string — printing it writes the literal text "undefined", which is
    // not JSON and breaks any consumer piping the output to jq.
    expect(formatJson(undefined)).toBe("null");
  });

  it("renders null as null", () => {
    expect(formatJson(null)).toBe("null");
  });

  it.each([
    [{ a: undefined }, "{}"],
    [[undefined], "[\n  null\n]"],
  ])("drops an undefined property but keeps array holes as null (%j)", (input, expected) => {
    // Same asymmetry JSON.stringify has; pinned so a future refactor to a
    // hand-rolled serializer cannot change it silently.
    expect(formatJson(input)).toBe(expected);
  });

  it("does not throw on a bigint, which JSON.stringify refuses", () => {
    // A raw JSON.stringify(1n) throws TypeError and would crash the CLI
    // with a stack trace instead of printing a result.
    expect(() => formatJson({ n: 10n })).not.toThrow();
    expect(formatJson({ n: 10n })).toBe('{\n  "n": 10\n}');
  });

  it("does not throw on a circular structure", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => formatJson(a)).not.toThrow();
    expect(formatJson(a)).toContain('"name": "a"');
  });
});
