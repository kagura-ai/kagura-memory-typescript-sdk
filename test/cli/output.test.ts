import { describe, expect, it } from "vitest";

import {
  cliErrorMessage,
  formatJson,
  formatJsonAscii,
  formatJsonLine,
  pythonIsoformat,
} from "../../src/cli/output.js";
import {
  KaguraError,
  KaguraFeatureNotAvailableError,
  KaguraQuotaError,
  KaguraRateLimitError,
} from "../../src/errors.js";

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

describe("formatJsonLine", () => {
  // json.dumps(value, ensure_ascii=False) and json.dumps(value), printed by
  // CPython 3.12 and stored JSON-encoded so the escapes stay exact.
  const VALUE = {
    v: 1,
    stage: "upload",
    a: [1, { b: "日本 — 📌" }],
    c: null,
    d: true,
    e: {},
    f: [],
    s: "x\t\"y\"\u0001\u007f\u2028",
  };
  const PY_UTF8 = JSON.parse(
    String.raw`"{\"v\": 1, \"stage\": \"upload\", \"a\": [1, {\"b\": \"\u65e5\u672c \u2014 \ud83d\udccc\"}], \"c\": null, \"d\": true, \"e\": {}, \"f\": [], \"s\": \"x\\t\\\"y\\\"\\u0001\u007f\u2028\"}"`,
  ) as string;
  const PY_ASCII = JSON.parse(
    String.raw`"{\"v\": 1, \"stage\": \"upload\", \"a\": [1, {\"b\": \"\\u65e5\\u672c \\u2014 \\ud83d\\udccc\"}], \"c\": null, \"d\": true, \"e\": {}, \"f\": [], \"s\": \"x\\t\\\"y\\\"\\u0001\\u007f\\u2028\"}"`,
  ) as string;

  it("matches json.dumps(value, ensure_ascii=False)", () => {
    expect(formatJsonLine(VALUE, { ensureAscii: false })).toBe(PY_UTF8);
  });

  it("matches json.dumps(value), whose default escapes non-ASCII", () => {
    expect(formatJsonLine(VALUE, { ensureAscii: true })).toBe(PY_ASCII);
  });

  it("prints the guardrails digest --out line as Python does, ensure_ascii=False", () => {
    // cli.py's `guardrails digest --out` echoes json.dumps({...},
    // ensure_ascii=False): a non-ASCII path stays literal. CPython 3.12.
    const line = { path: "日本語/AGENTS.md", status: "written", tool_triggered_version: null };
    expect(formatJsonLine(line, { ensureAscii: false })).toBe(
      '{"path": "日本語/AGENTS.md", "status": "written", "tool_triggered_version": null}',
    );
  });

  it("is one line with Python's separators, never JSON.stringify's", () => {
    expect(formatJsonLine({ a: [1, 2], b: "c" }, { ensureAscii: false })).toBe('{"a": [1, 2], "b": "c"}');
    expect(formatJsonLine({ text: "a, b: c" }, { ensureAscii: false })).toBe('{"text": "a, b: c"}');
  });

  it("is total, as formatJson is", () => {
    const a: Record<string, unknown> = { n: 10n, gone: undefined };
    a.self = a;
    expect(formatJsonLine(a, { ensureAscii: false })).toBe('{"n": 10, "self": "[Circular]"}');
    expect(formatJsonLine(undefined, { ensureAscii: false })).toBe("null");
    expect(formatJsonLine("s", { ensureAscii: false })).toBe('"s"');
  });
});

describe("pythonIsoformat", () => {
  // datetime.fromisoformat(text), made UTC when naive, then .isoformat():
  // CPython 3.12's output for each row.
  it.each([
    ["2026-09-26T00:00:00Z", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00:00:00+00:00", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00:00:00.000Z", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00:00:00.123Z", "2026-09-26T00:00:00.123000+00:00"],
    ["2026-09-26T00:00:00.1234567Z", "2026-09-26T00:00:00.123456+00:00"],
    ["2026-09-26T00:00:00.9999999Z", "2026-09-26T00:00:00.999999+00:00"],
    ["2026-09-26T00:00:00.1+09:00", "2026-09-26T00:00:00.100000+09:00"],
    ["2026-09-26T00:00:00,5Z", "2026-09-26T00:00:00.500000+00:00"],
    ["2026-09-26T00:00:00.Z", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00:00:00-00:00", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00:00:00+0900", "2026-09-26T00:00:00+09:00"],
    ["2026-09-26T00:00:00+09", "2026-09-26T00:00:00+09:00"],
    ["2026-09-26T00:00:00+05:30:15", "2026-09-26T00:00:00+05:30:15"],
    ["2026-09-26T01:02:03+01:30:00", "2026-09-26T01:02:03+01:30"],
    ["2026-09-26T01:02:03.5-0130", "2026-09-26T01:02:03.500000-01:30"],
    ["2026-09-26T00:00:00+23:59", "2026-09-26T00:00:00+23:59"],
    ["2026-09-26T00:00", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T0102", "2026-09-26T01:02:00+00:00"],
    ["2026-09-26T010203Z", "2026-09-26T01:02:03+00:00"],
    ["2026-09-26T000000.5", "2026-09-26T00:00:00.500000+00:00"],
    ["2026-09-26T01Z", "2026-09-26T01:00:00+00:00"],
    ["2026-09-26T01:02:03.000001", "2026-09-26T01:02:03.000001+00:00"],
    ["2026-09-26", "2026-09-26T00:00:00+00:00"],
    ["20260926", "2026-09-26T00:00:00+00:00"],
    ["20260926T000000Z", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26 00:00:00", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26x00:00:00", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26\u304200:00:00", "2026-09-26T00:00:00+00:00"],
    ["2024-02-29T00:00:00Z", "2024-02-29T00:00:00+00:00"],
    ["0001-01-01T00:00:00Z", "0001-01-01T00:00:00+00:00"],
    ["2026-09-26T00:00:00+05:30:15.5", "2026-09-26T00:00:00+05:30:15.500000"],
    ["2026-09-26T00:00:00-01:00:00.5", "2026-09-26T00:00:00-01:00:00.500000"],
  ])("renders %j as %j", (input, expected) => {
    expect(pythonIsoformat(input)).toBe(expected);
  });

  it.each([
    // CPython's C parser lets one byte of anything, a space included, sit
    // between the clock and the offset — and a `.` or `,` with no digits
    // only there, never at the end. Identical on CPython 3.11–3.14.
    ["2026-09-26T00:00:00 Z", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00:00:00 +01:00", "2026-09-26T00:00:00+01:00"],
    ["2026-09-26T00:00:00 -00:00", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00:00:00 +0100", "2026-09-26T00:00:00+01:00"],
    ["2026-09-26 00:00:00 Z", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00:00 Z", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00 Z", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00:00:00\tZ", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00:00:00xZ", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00:00:00:Z", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00:00:00.+01:00", "2026-09-26T00:00:00+01:00"],
    ["2026-09-26T00:00:00.1234567 Z", "2026-09-26T00:00:00.123456+00:00"],
    ["2026-09-26T00:00:00.123456éZ", "2026-09-26T00:00:00.123456+00:00"],
    ["2026-09-26T00:00:00Z\u0000", "2026-09-26T00:00:00+00:00"],
    ["2026-09-26T00000012", "2026-09-26T00:00:00.120000+00:00"],
    // Offsets are normalized as a timedelta, and a zero one is UTC.
    ["2026-09-26T00:00:00+00:60", "2026-09-26T00:00:00+01:00"],
    ["2026-09-26T00:00:00-00:00:00.000001", "2026-09-26T00:00:00+00:00"],
  ])("reads %j as CPython's parser does: %j", (input, expected) => {
    expect(pythonIsoformat(input)).toBe(expected);
  });

  it.each([
    // An empty fraction at the end, with no offset after it.
    ["2026-09-26T00:00:00."],
    ["2026-09-26T00:00:00,"],
    // Two bytes before the offset, a multi-byte character included.
    ["2026-09-26T00:00:00  Z"],
    ["2026-09-26T00:00:00  +01:00"],
    ["2026-09-26T00:00:00éZ"],
    ["2026-09-26T00:00:00. Z"],
    ["2026-09-26T00:00:00.5 Z"],
    ["2026-09-26T00:00:00x"],
    ["2026-09-26T00:00:00+23:99"],
    ["2026-09-26T00:00:00\ud800Z"],
  ])("refuses %j as CPython's parser does", (input) => {
    expect(pythonIsoformat(input)).toBeNull();
  });

  it.each([
    // CPython 3.11–3.13 read these; 3.14 refuses a decimal mark on the
    // hour or minute and a fourth field, and reads hour 24 as the next
    // midnight, which 3.11–3.13 refuse. Where the versions disagree, the
    // line is left out.
    ["2026-09-26T00:00.5"],
    ["2026-09-26T00,5Z"],
    ["2026-09-26T00:00:00:00"],
    ["2026-09-26T00:00:00+01.5"],
    ["2026-09-26T24:00:00"],
    ["2026-09-26T24:00:00Z"],
  ])("reads %j, which CPython versions disagree on, as unparseable", (input) => {
    expect(pythonIsoformat(input)).toBeNull();
  });

  it.each([
    // Each one fromisoformat refuses.
    ["2026-09-26T00:00:00z"],
    ["2026-09-26\u3042 00:00:00"],
    ["2026-02-29T00:00:00Z"],
    ["2026-13-01T00:00:00Z"],
    ["2026-09-26T23:59:60Z"],
    ["2026-09-26T00:00:00+24:00"],
    ["2026-09-26T00:00:00 "],
    [" 2026-09-26T00:00:00"],
    ["garbage"],
    [""],
    ["2026-9-26"],
    ["0000-01-01T00:00:00Z"],
    ["2026-09-26T1:02:03"],
    ["2026-09-26T01:02:03Z+01:00"],
    ["2026-09-26T01:0203"],
    ["2026-0926"],
    ["+2026-09-26"],
  ])("reads %j as unparseable", (input) => {
    expect(pythonIsoformat(input)).toBeNull();
  });

  it.each([["2026-W39-5"]])(
    "does not read %j, which Python does and the server never sends",
    (input) => {
      expect(pythonIsoformat(input)).toBeNull();
    },
  );
});

describe("cliErrorMessage", () => {
  // Each expected text is the Python CLI's `_cli_error_message` for the
  // same error (kagura-memory 0.40.1).
  it("adds when a quota resets and the plan that lifts it", () => {
    const e = new KaguraQuotaError("Daily limit.", null, {
      resetsAt: "2026-09-26T00:00:00Z",
      requiredPlan: "pro",
      requiredPlanDisplay: "Pro",
    });
    expect(cliErrorMessage(e)).toBe(
      "Daily limit.\n  Resets at: 2026-09-26T00:00:00+00:00\n  Required plan: Pro (pro)",
    );
  });

  it.each([
    ["2026-09-26T00:00:00.120Z", "q\n  Resets at: 2026-09-26T00:00:00.120000+00:00"],
    ["2026-09-26T00:00:00", "q\n  Resets at: 2026-09-26T00:00:00+00:00"],
    ["2026-09-26T09:00:00+09:00", "q\n  Resets at: 2026-09-26T09:00:00+09:00"],
    ["garbage", "q"],
  ])("renders resetsAt %j as Python's isoformat()", (resetsAt, expected) => {
    expect(cliErrorMessage(new KaguraQuotaError("q", null, { resetsAt }))).toBe(expected);
  });

  it.each([
    [{ requiredPlan: "pro", requiredPlanDisplay: "pro" }, "q\n  Required plan: pro"],
    [{ requiredPlan: "pro" }, "q\n  Required plan: pro"],
    [{ requiredPlanDisplay: "Pro" }, "q\n  Required plan: Pro"],
    [{ requiredPlan: "pro", requiredPlanDisplay: "" }, "q\n  Required plan: pro"],
  ])("names the plan once when only one is useful (%j)", (plan, expected) => {
    expect(cliErrorMessage(new KaguraQuotaError("q", null, plan))).toBe(expected);
  });

  it("adds the plan to a feature refusal", () => {
    const e = new KaguraFeatureNotAvailableError("Feature not available.", {
      requiredPlan: "promax",
      requiredPlanDisplay: "XL",
    });
    expect(cliErrorMessage(e)).toBe("Feature not available.\n  Required plan: XL (promax)");
    expect(cliErrorMessage(new KaguraFeatureNotAvailableError("Feature not available."))).toBe(
      "Feature not available.",
    );
  });

  it("adds nothing to a rate limit, as Python's KaguraRateLimitError carries none of it", () => {
    const e = new KaguraRateLimitError("Rate limit exceeded (HTTP 429): slow", 5, {
      resetsAt: "2026-09-26T00:00:00Z",
      requiredPlan: "pro",
    });
    expect(cliErrorMessage(e)).toBe("Rate limit exceeded (HTTP 429): slow");
  });

  it("falls back to the class name for an empty message, as _exc_message does", () => {
    expect(cliErrorMessage(new KaguraError("boom"))).toBe("boom");
    expect(cliErrorMessage(new KaguraError(""))).toBe("KaguraError");
    expect(cliErrorMessage("plain string")).toBe("plain string");
  });

  it("replaces the first line when a command words the failure, keeping the gate lines", () => {
    const e = new KaguraQuotaError("q", null, { requiredPlan: "pro", requiredPlanDisplay: "Pro" });
    expect(
      cliErrorMessage(e, "File uploaded (file_id=f1), but creating the linked memory failed: q"),
    ).toBe("File uploaded (file_id=f1), but creating the linked memory failed: q\n  Required plan: Pro (pro)");
  });
});
