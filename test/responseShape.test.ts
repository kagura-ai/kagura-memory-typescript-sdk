/**
 * The response-drift error, pinned against the Python SDK's
 * `parse_response` / `response_shape_error` (kagura-memory 0.40.1,
 * pydantic 2.13): the expected texts below are its output.
 */

import { describe, expect, it } from "vitest";

import { KaguraError, KaguraResponseError } from "../src/errors.js";
import {
  ResponseReader,
  UPGRADE_HINT,
  formatResponseIssues,
  laxBool,
  laxFloat,
  laxInt,
  laxStr,
  nullable,
  responseModelError,
  responseShapeError,
  type Coercer,
} from "../src/responseShape.js";

const HINT = "The server may be newer than this SDK; upgrading kagura-memory may help.";

/** Read a MeasurementSeries the way a slice would: fields in model order. */
function readSeries(raw: unknown) {
  const r = new ResponseReader("recall_series", "MeasurementSeries");
  const obj = r.object(raw);
  if (obj !== null) {
    r.field(obj, "status", laxStr, { default: "success" });
    r.field(obj, "metric", laxStr);
    r.field(obj, "period", laxStr);
    r.field(obj, "agg", laxStr);
    r.list(
      obj,
      "series",
      (item, at) => {
        const bucket = r.object(item, at, "SeriesBucket");
        if (bucket === null) return null;
        return {
          bucket: r.field(bucket, "bucket", laxStr, { at }),
          value: r.field(bucket, "value", laxFloat, { at }),
          count: r.field(bucket, "count", laxInt, { at }),
        };
      },
      { default: [] },
    );
    r.field(obj, "count", laxInt);
  }
  r.check();
}

function messageOf(run: () => void): string {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(KaguraResponseError);
    return (e as Error).message;
  }
  throw new Error("expected a KaguraResponseError");
}

describe("KaguraResponseError messages", () => {
  it("uses Python's upgrade hint verbatim", () => {
    expect(UPGRADE_HINT).toBe(HINT);
  });

  it("lists at most three problems, then counts the rest", () => {
    expect(messageOf(() => readSeries({}))).toBe(
      "recall_series: unexpected server response for MeasurementSeries (metric: Field required; " +
        `period: Field required; agg: Field required (+1 more)). ${HINT}`,
    );
  });

  it("names a null list as pydantic does", () => {
    const raw = { metric: "m", period: "day", agg: "avg", series: null, count: 0 };
    expect(messageOf(() => readSeries(raw))).toBe(
      `recall_series: unexpected server response for MeasurementSeries (series: Input should be a valid list). ${HINT}`,
    );
  });

  it("dots the location of a nested problem and names the nested model", () => {
    const raw = {
      metric: "m",
      period: "day",
      agg: "avg",
      series: [{ bucket: "b", value: "x", count: 1 }, 5],
      count: "3",
    };
    expect(messageOf(() => readSeries(raw))).toBe(
      "recall_series: unexpected server response for MeasurementSeries (series.0.value: Input should " +
        "be a valid number, unable to parse string as a number; series.1: Input should be a valid " +
        `dictionary or instance of SeriesBucket). ${HINT}`,
    );
  });

  it("gives the message alone for a payload that is not an object", () => {
    expect(messageOf(() => readSeries(null))).toBe(
      "recall_series: unexpected server response for MeasurementSeries (Input should be a valid " +
        `dictionary or instance of MeasurementSeries). ${HINT}`,
    );
  });

  it("passes a payload that reads cleanly, with defaults filled", () => {
    expect(() => readSeries({ metric: "m", period: "day", agg: "avg", count: 0 })).not.toThrow();
  });

  it("carries the operation, and is a KaguraError but not a connection error", () => {
    const e = responseModelError("record_measurement", "MeasurementResult", [
      { loc: ["measured_at"], msg: "Field required" },
    ]);
    expect(e.message).toBe(
      `record_measurement: unexpected server response for MeasurementResult (measured_at: Field required). ${HINT}`,
    );
    expect(e.operation).toBe("record_measurement");
    expect(e).toBeInstanceOf(KaguraError);
    expect(e.name).toBe("KaguraResponseError");
  });

  it("words a shape error as response_shape_error does", () => {
    const e = responseShapeError(
      "WorkspaceClient.list_members",
      "GET /api/v1/workspaces/w/members: expected a JSON array, got dict",
    );
    expect(e.message).toBe(
      "WorkspaceClient.list_members: unexpected server response (GET /api/v1/workspaces/w/members: " +
        `expected a JSON array, got dict). ${HINT}`,
    );
    expect(e.operation).toBe("WorkspaceClient.list_members");
  });

  it("formats an issue list on its own", () => {
    expect(
      formatResponseIssues([
        { loc: ["pinned", 0, "importance"], msg: "Input should be a valid number" },
        { loc: [], msg: "top" },
      ]),
    ).toBe("pinned.0.importance: Input should be a valid number; top");
  });

  it("records an extra problem through issue()", () => {
    const r = new ResponseReader("op", "Model");
    r.issue(["a"], "custom");
    expect(() => r.check()).toThrow(`op: unexpected server response for Model (a: custom). ${HINT}`);
  });
});

/** Run a coercer on each input and return the value or the message. */
function coerce<T>(c: Coercer<T>, value: unknown): T | string {
  const result = c(value);
  return result.ok ? result.value : `ERR ${result.msg}`;
}

describe("lax coercion, as pydantic 2 applies it", () => {
  it.each([
    ["50", 50],
    [50.0, 50],
    ["50.0", 50],
    ["50.00", 50],
    ["1_0.0", 10],
    [" 7 ", 7],
    ["1_000", 1000],
    ["+5", 5],
    ["-0", 0],
    ["05", 5],
    [true, 1],
    [false, 0],
    [50.5, "ERR Input should be a valid integer, got a number with a fractional part"],
    ["50.5", "ERR Input should be a valid integer, unable to parse string as an integer"],
    ["1e3", "ERR Input should be a valid integer, unable to parse string as an integer"],
    ["50.", "ERR Input should be a valid integer, unable to parse string as an integer"],
    ["abc", "ERR Input should be a valid integer, unable to parse string as an integer"],
    ["", "ERR Input should be a valid integer, unable to parse string as an integer"],
    ["1__0", "ERR Input should be a valid integer, unable to parse string as an integer"],
    ["True", "ERR Input should be a valid integer, unable to parse string as an integer"],
    // Stripped as pydantic strips (NEL, no-break and ideographic spaces),
    // a BOM and ASCII digits only as pydantic reads them.
    ["\u{85}5", 5],
    ["\u{3000}5\u{a0}", 5],
    ["\u{feff}5", "ERR Input should be a valid integer, unable to parse string as an integer"],
    ["\u{1c}5", "ERR Input should be a valid integer, unable to parse string as an integer"],
    ["\u{661}", "ERR Input should be a valid integer, unable to parse string as an integer"],
    [Infinity, "ERR Input should be a finite number"],
    [NaN, "ERR Input should be a finite number"],
    [null, "ERR Input should be a valid integer"],
    [[], "ERR Input should be a valid integer"],
    [{}, "ERR Input should be a valid integer"],
  ])("int field: %j -> %j", (input, expected) => {
    expect(coerce(laxInt, input)).toBe(expected);
  });

  it.each([
    ["1.5", 1.5],
    [5, 5],
    [" 2 ", 2],
    ["1_0.5", 10.5],
    ["1e3", 1000],
    ["inf", Infinity],
    ["-Infinity", -Infinity],
    [true, 1],
    ["abc", "ERR Input should be a valid number, unable to parse string as a number"],
    ["", "ERR Input should be a valid number, unable to parse string as a number"],
    ["True", "ERR Input should be a valid number, unable to parse string as a number"],
    ["\u{85}5", 5],
    ["\u{feff}5", "ERR Input should be a valid number, unable to parse string as a number"],
    ["\u{661}", "ERR Input should be a valid number, unable to parse string as a number"],
    [null, "ERR Input should be a valid number"],
    [[], "ERR Input should be a valid number"],
  ])("float field: %j -> %j", (input, expected) => {
    expect(coerce(laxFloat, input)).toBe(expected);
  });

  it.each([
    ["true", true],
    ["TRUE", true],
    ["Yes", true],
    ["on", true],
    ["1", true],
    ["y", true],
    ["t", true],
    ["false", false],
    ["no", false],
    ["OFF", false],
    ["0", false],
    ["n", false],
    ["f", false],
    [0, false],
    [1, true],
    [true, true],
    [2, "ERR Input should be a valid boolean, unable to interpret input"],
    [-1, "ERR Input should be a valid boolean, unable to interpret input"],
    [1.5, "ERR Input should be a valid boolean"],
    ["", "ERR Input should be a valid boolean, unable to interpret input"],
    [" true", "ERR Input should be a valid boolean, unable to interpret input"],
    ["2", "ERR Input should be a valid boolean, unable to interpret input"],
    ["1.0", "ERR Input should be a valid boolean, unable to interpret input"],
    [null, "ERR Input should be a valid boolean"],
    [[], "ERR Input should be a valid boolean"],
  ])("bool field: %j -> %j", (input, expected) => {
    expect(coerce(laxBool, input)).toBe(expected);
  });

  it.each([
    ["x", "x"],
    ["", ""],
    [5, "ERR Input should be a valid string"],
    [5.5, "ERR Input should be a valid string"],
    [true, "ERR Input should be a valid string"],
    [null, "ERR Input should be a valid string"],
    [{}, "ERR Input should be a valid string"],
  ])("str field: %j -> %j", (input, expected) => {
    expect(coerce(laxStr, input)).toBe(expected);
  });

  it("lets null through a nullable field and checks anything else", () => {
    expect(coerce(nullable(laxStr), null)).toBeNull();
    expect(coerce(nullable(laxStr), 5)).toBe("ERR Input should be a valid string");
  });
});

describe("ResponseReader", () => {
  it("prints what it coerced: a field sent as '50' reads as 50", () => {
    const r = new ResponseReader("load_guardrails", "GuardrailSet");
    const obj = r.object({ cap: "50" })!;
    expect(r.field(obj, "cap", laxInt)).toBe(50);
    r.check();
  });

  it("treats a key inherited from the prototype as absent", () => {
    const r = new ResponseReader("op", "M");
    const obj = r.object(JSON.parse('{"a": 1}'))!;
    r.field(obj, "toString", laxStr);
    expect(() => r.check()).toThrow("(toString: Field required)");
  });

  it("uses the default only for an absent key, not for null", () => {
    const r = new ResponseReader("op", "M");
    const obj = r.object({ status: null })!;
    r.field(obj, "status", laxStr, { default: "success" });
    expect(() => r.check()).toThrow("(status: Input should be a valid string)");
  });

  it("reports a missing list without a default as required", () => {
    const r = new ResponseReader("op", "M");
    expect(r.list(r.object({})!, "rows", (v) => v)).toEqual([]);
    expect(() => r.check()).toThrow("(rows: Field required)");
  });
});
