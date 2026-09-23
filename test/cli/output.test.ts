import { describe, expect, it } from "vitest";

import { formatJson, formatJsonAscii } from "../../src/cli/output.js";

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

  it("marks only a real cycle, an object inside itself, as [Circular]", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { a };
    a.b = b;
    expect(JSON.parse(formatJson({ list: [a] }))).toEqual({ list: [{ name: "a", b: { a: "[Circular]" } }] });
  });

  it("prints an object shared by two places both times", () => {
    // doctor's checks once shared a details object, and the second printed
    // as "[Circular]" though nothing contained itself.
    const details = { scope: "project", source: ".mcp.json" };
    const nested = { deep: { details } };
    expect(JSON.parse(formatJson({ checks: [{ details }, { details }], nested, again: nested }))).toEqual({
      checks: [{ details }, { details }],
      nested,
      again: nested,
    });
  });
});

describe("formatJsonAscii", () => {
  it("escapes what Python's json.dumps escapes by default (ensure_ascii=True)", () => {
    // json.dumps({"s": "神楽 WS — 📌\x7f\x01"}, indent=2)
    expect(formatJsonAscii({ s: "神楽 WS — 📌\x7f\x01" })).toBe(
      '{\n  "s": "\\u795e\\u697d WS \\u2014 \\ud83d\\udccc\\u007f\\u0001"\n}',
    );
  });

  it("leaves ASCII as formatJson prints it", () => {
    const value = { a: [1, "x\ny"], b: null, c: true };
    expect(formatJsonAscii(value)).toBe(formatJson(value));
  });
});
