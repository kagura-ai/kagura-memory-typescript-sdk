/**
 * The measurement lane (`recordMeasurement` / `recallSeries`) and the
 * `listMemories` bounding box (#57, server v0.54.0+) — Python SDK #254,
 * with its test tables (tests/test_client.py, test_response_parsing.py).
 */

import { describe, expect, it } from "vitest";

import {
  KaguraError,
  KaguraNotFoundError,
  KaguraPermissionError,
  KaguraResponseError,
} from "../src/errors.js";
import * as sdk from "../src/index.js";
import type {
  MeasurementAggregate,
  MeasurementPeriod,
  MeasurementResult,
  MeasurementSeries,
  MemoryListItemLocation,
  RecallSeriesOptions,
  RecordMeasurementOptions,
  SeriesBucket,
} from "../src/index.js";
import { FakeServer, makeClient } from "./fakeServer.js";

const HINT = "The server may be newer than this SDK; upgrading kagura-memory may help.";

/** A server-shaped `record_measurement` success (memory-cloud measurement.py). */
function measurement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "success",
    measurement_id: "cccccccc-dddd-eeee-ffff-000000000000",
    metric: "weight_kg",
    measured_at: "2026-09-01T07:30:00Z",
    value: 71.5,
    unit: "kg",
    ...overrides,
  };
}

/** A server-shaped `recall_series` success: `count` is buckets, not observations. */
function measurementSeries(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "success",
    metric: "weight_kg",
    period: "week",
    agg: "avg",
    series: [
      { bucket: "2026-08-24T00:00:00Z", value: 72.0, count: 3 },
      { bucket: "2026-08-31T00:00:00Z", value: 71.25, count: 2 },
    ],
    count: 2,
    ...overrides,
  };
}

function toolCalls(server: FakeServer) {
  return server.requests.filter((r) => r.body?.method === "tools/call");
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
}

describe("public surface (#57)", () => {
  it("exports the methods, their option types and the models from the entry point", () => {
    // Compile-time half: these annotations fail typecheck if index.ts
    // stops re-exporting the types.
    const period: MeasurementPeriod = "week";
    const agg: MeasurementAggregate = "last";
    const record: RecordMeasurementOptions = { contextId: "c", metric: "m", value: 1 };
    const read: RecallSeriesOptions = { contextId: "c", metric: "m", period, agg };
    const bucket: SeriesBucket = { bucket: "2026-01-01T00:00:00Z", value: 1, count: 1 };
    const location: MemoryListItemLocation = { lat: 0, lon: 0 };
    expect([record.metric, read.period, bucket.count, location.lat]).toEqual(["m", "week", 1, 0]);
    expect(typeof sdk.KaguraClient.prototype.recordMeasurement).toBe("function");
    expect(typeof sdk.KaguraClient.prototype.recallSeries).toBe("function");
  });
});

describe("recordMeasurement (#57)", () => {
  it("sends only context_id, metric and value when nothing else is given", async () => {
    const server = new FakeServer();
    const { unit: _unit, ...noUnit } = measurement();
    server.toolResults.record_measurement = noUnit;
    const client = makeClient(server);

    const result = await client.recordMeasurement({ contextId: "ctx", metric: "weight_kg", value: 71.5 });

    const call = toolCalls(server)[0]!.body!.params as { name: string };
    expect(call.name).toBe("record_measurement");
    expect(server.toolCallArgs()).toEqual({ context_id: "ctx", metric: "weight_kg", value: 71.5 });
    expect(result).toEqual<MeasurementResult>({
      status: "success",
      measurement_id: "cccccccc-dddd-eeee-ffff-000000000000",
      metric: "weight_kg",
      measured_at: "2026-09-01T07:30:00Z",
      value: 71.5,
      unit: null,
    });
  });

  it("forwards measuredAt as given, unit and details", async () => {
    const server = new FakeServer();
    server.toolResults.record_measurement = measurement();
    const client = makeClient(server);

    const result = await client.recordMeasurement({
      contextId: "ctx",
      metric: "weight_kg",
      value: 71.5,
      measuredAt: "2026-09-01T07:30:00Z",
      unit: "kg",
      details: { device: "scale-1" },
    });

    expect(server.toolCallArgs()).toEqual({
      context_id: "ctx",
      metric: "weight_kg",
      value: 71.5,
      measured_at: "2026-09-01T07:30:00Z",
      unit: "kg",
      details: { device: "scale-1" },
    });
    expect(result.unit).toBe("kg");
  });

  it("sends a Date measuredAt as its UTC instant", async () => {
    // Python sends a naive datetime without an offset; a Date has no naive
    // form, and the server reads the Z-tagged instant as the same moment.
    const server = new FakeServer();
    server.toolResults.record_measurement = measurement();
    await makeClient(server).recordMeasurement({
      contextId: "ctx",
      metric: "weight_kg",
      value: 71.5,
      measuredAt: new Date(Date.UTC(2026, 8, 1, 7, 30)),
    });
    expect(server.toolCallArgs().measured_at).toBe("2026-09-01T07:30:00.000Z");
  });

  it("sends an empty measuredAt, as Python's `is not None` does, for the server to refuse", async () => {
    const server = new FakeServer();
    server.toolResults.record_measurement = measurement();
    await makeClient(server).recordMeasurement({ contextId: "ctx", metric: "m", value: 1, measuredAt: "" });
    expect(server.toolCallArgs()).toMatchObject({ measured_at: "" });
  });

  it("treats null options as unset, as Python treats None", async () => {
    const server = new FakeServer();
    server.toolResults.record_measurement = measurement();
    await makeClient(server).recordMeasurement({
      contextId: "ctx",
      metric: "m",
      value: 1,
      measuredAt: null,
      unit: null,
      details: null,
    } as unknown as Parameters<ReturnType<typeof makeClient>["recordMeasurement"]>[0]);
    expect(server.toolCallArgs()).toEqual({ context_id: "ctx", metric: "m", value: 1 });
  });

  it("takes an integer value as the number it is", async () => {
    const server = new FakeServer();
    server.toolResults.record_measurement = measurement({ metric: "reps", value: 12.0, unit: null });
    await makeClient(server).recordMeasurement({ contextId: "ctx", metric: "reps", value: 12 });
    expect(server.toolCallArgs().value).toBe(12);
  });

  it("accepts the server's limits: a 64-character metric and a 32-character unit", async () => {
    const server = new FakeServer();
    server.toolResults.record_measurement = measurement();
    await makeClient(server).recordMeasurement({
      contextId: "ctx",
      metric: "m".repeat(64),
      value: 1,
      unit: "u".repeat(32),
    });
    expect(server.toolCallArgs()).toMatchObject({ metric: "m".repeat(64), unit: "u".repeat(32) });
  });

  it("counts the metric and unit in code points, as Python's len() does", async () => {
    const server = new FakeServer();
    server.toolResults.record_measurement = measurement();
    // 64 emoji are 128 UTF-16 units.
    await makeClient(server).recordMeasurement({
      contextId: "ctx",
      metric: "😀".repeat(64),
      value: 1,
      unit: "😀".repeat(32),
    });
    expect(toolCalls(server)).toHaveLength(1);
  });

  it.each([
    ["empty metric", { metric: "" }, "metric must be a non-empty string, got ''"],
    ["long metric", { metric: "m".repeat(65) }, "metric must be at most 64 characters, got 65"],
    ["long emoji metric", { metric: "😀".repeat(65) }, "metric must be at most 64 characters, got 65"],
    ["non-string metric", { metric: 42 }, "metric must be a non-empty string, got 42"],
    ["null metric", { metric: null }, "metric must be a non-empty string, got None"],
    ["NaN", { value: Number.NaN }, "value must be finite (NaN and infinity are rejected)"],
    ["Infinity", { value: Number.POSITIVE_INFINITY }, "value must be finite (NaN and infinity are rejected)"],
    ["-Infinity", { value: Number.NEGATIVE_INFINITY }, "value must be finite (NaN and infinity are rejected)"],
    // A bigint is Python's int: refused only past the float range.
    ["overflowing bigint", { value: 10n ** 400n }, "value must be finite (NaN and infinity are rejected)"],
    // A boolean is never a measurement; a string is refused, not coerced.
    ["boolean", { value: true }, "value must be a number, got bool"],
    ["string", { value: "71.5" }, "value must be a number, got str"],
    ["null value", { value: null }, "value must be a number, got NoneType"],
    ["missing value", { value: undefined }, "value must be a number, got NoneType"],
    ["empty unit", { unit: "" }, "unit must be a non-empty string of at most 32 characters, got ''"],
    [
      "long unit",
      { unit: "u".repeat(33) },
      `unit must be a non-empty string of at most 32 characters, got '${"u".repeat(33)}'`,
    ],
    // Python's repr switches to double quotes around an apostrophe.
    ["apostrophe", { unit: `it's${"x".repeat(30)}` }, `unit must be a non-empty string of at most 32 characters, got "it's${"x".repeat(30)}"`],
    ["non-string unit", { unit: 5 }, "unit must be a non-empty string of at most 32 characters, got 5"],
    ["invalid Date", { measuredAt: new Date(Number.NaN) }, "measuredAt must be a valid Date"],
  ])("refuses %s before any request", async (_name, override, message) => {
    const server = new FakeServer();
    const client = makeClient(server);
    const options = { contextId: "ctx", metric: "weight_kg", value: 71.5, ...override };
    const err = await failure(
      client.recordMeasurement(options as Parameters<typeof client.recordMeasurement>[0]),
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(KaguraError);
    expect((err as Error).message).toBe(message);
    expect(server.requests).toEqual([]);
  });

  it("sends a bigint within the float range as a number", async () => {
    const server = new FakeServer();
    server.toolResults.record_measurement = measurement();
    const client = makeClient(server);
    await client.recordMeasurement({ contextId: "ctx", metric: "m", value: 12n as unknown as number });
    expect(server.toolCallArgs().value).toBe(12);
  });

  it.each([
    ["validation_error", KaguraError, "record_measurement failed (validation_error): 'details' must be an object when provided"],
    ["context_not_found", KaguraNotFoundError, "record_measurement: 'details' must be an object when provided"],
    ["permission_denied", KaguraPermissionError, "record_measurement failed (permission_denied): 'details' must be an object when provided"],
  ])("translates the server's %s", async (code, cls, message) => {
    const server = new FakeServer();
    server.toolResults.record_measurement = {
      status: "error",
      error: code,
      message: "'details' must be an object when provided",
    };
    const err = await failure(makeClient(server).recordMeasurement({ contextId: "c", metric: "m", value: 1 }));
    expect(err).toBeInstanceOf(cls);
    expect((err as Error).message).toBe(message);
  });

  it("names an older server's missing tool", async () => {
    const server = new FakeServer();
    server.toolResults.record_measurement = {
      status: "error",
      error: "unknown_tool",
      message: "Unknown tool: record_measurement",
    };
    await expect(
      makeClient(server).recordMeasurement({ contextId: "c", metric: "m", value: 1 }),
    ).rejects.toThrow("record_measurement failed (unknown_tool): Unknown tool: record_measurement");
  });

  it("returns Python's model: its keys in its order, defaults filled, extras dropped", async () => {
    const server = new FakeServer();
    // Out of order, no status, an extra key: the result is the model's.
    server.toolResults.record_measurement = {
      extra: "dropped",
      unit: "kg",
      value: 71.5,
      measured_at: "2026-09-01T07:30:00Z",
      metric: "weight_kg",
      measurement_id: "m-1",
    };
    const result = await makeClient(server).recordMeasurement({ contextId: "c", metric: "m", value: 1 });
    expect(Object.keys(result)).toEqual(["status", "measurement_id", "metric", "measured_at", "value", "unit"]);
    expect(result.status).toBe("success");
    expect(result).not.toHaveProperty("extra");
  });

  it("reads the value in pydantic's lax mode and keeps the datetime verbatim", async () => {
    const server = new FakeServer();
    server.toolResults.record_measurement = measurement({
      value: "12",
      measured_at: "2026-09-25T10:11:12.345678Z",
    });
    const result = await makeClient(server).recordMeasurement({ contextId: "c", metric: "m", value: 12 });
    expect(result.value).toBe(12);
    expect(result.measured_at).toBe("2026-09-25T10:11:12.345678Z");
  });

  // The cases the Python SDK's parse_response was checked against.
  it.each([
    [
      "a missing measured_at",
      { measurement_id: "m", metric: "weight_kg", value: 71.5 },
      "measured_at: Field required",
    ],
    ["an empty payload", {}, "measurement_id: Field required; metric: Field required; measured_at: Field required (+1 more)"],
    ["a null measured_at", measurement({ measured_at: null }), "measured_at: Input should be a valid datetime"],
    ["a boolean measured_at", measurement({ measured_at: true }), "measured_at: Input should be a valid datetime"],
    [
      "an unreadable value",
      measurement({ value: "abc" }),
      "value: Input should be a valid number, unable to parse string as a number",
    ],
    ["a null value", measurement({ value: null }), "value: Input should be a valid number"],
    ["a numeric unit", measurement({ unit: 5 }), "unit: Input should be a valid string"],
    ["a null status", measurement({ status: null }), "status: Input should be a valid string"],
    ["a numeric id", measurement({ measurement_id: 5 }), "measurement_id: Input should be a valid string"],
  ])("refuses %s as a KaguraResponseError in Python's words", async (_name, payload, problems) => {
    const server = new FakeServer();
    server.toolResults.record_measurement = payload;
    const err = await failure(makeClient(server).recordMeasurement({ contextId: "c", metric: "m", value: 1 }));
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as KaguraResponseError).operation).toBe("record_measurement");
    expect((err as Error).message).toBe(
      `record_measurement: unexpected server response for MeasurementResult (${problems}). ${HINT}`,
    );
  });

  it("refuses a payload that is no object", async () => {
    // Before the model reads it, where Python's `_raise_for_mcp_error`
    // fails on it with an AttributeError (#66).
    const server = new FakeServer();
    server.toolResults.record_measurement = ["not", "an", "object"];
    const err = await failure(makeClient(server).recordMeasurement({ contextId: "c", metric: "m", value: 1 }));
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as Error).message).toBe(
      "record_measurement: unexpected server response " +
        `(tool reply: expected a JSON object, got list). ${HINT}`,
    );
  });

  it("refuses a lone surrogate in measured_at and value, as pydantic does (#69)", async () => {
    const server = new FakeServer();
    server.toolResults.record_measurement = {
      measurement_id: "m",
      metric: "w",
      measured_at: "2026-06-01T00:00:00Z\u{dc00}",
      value: "1\u{d800}",
    };
    const error = await makeClient(server)
      .recordMeasurement({ contextId: "ctx", metric: "w", value: 1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraResponseError);
    // Recorded from the Python SDK 0.42.0's parse_response (pydantic 2.13.4).
    expect((error as Error).message).toBe(
      "record_measurement: unexpected server response for MeasurementResult (measured_at: Input should be " +
        "a valid string, unable to parse raw data as a unicode string; value: Input should be a valid string, " +
        "unable to parse raw data as a unicode string). The server may be newer than this SDK; upgrading " +
        "kagura-memory may help.",
    );
  });
});

describe("recallSeries (#57)", () => {
  it("sends only context_id and metric when nothing else is given", async () => {
    const server = new FakeServer();
    server.toolResults.recall_series = measurementSeries({ period: "day" });
    const result = await makeClient(server).recallSeries({ contextId: "ctx", metric: "weight_kg" });

    const call = toolCalls(server)[0]!.body!.params as { name: string };
    expect(call.name).toBe("recall_series");
    expect(server.toolCallArgs()).toEqual({ context_id: "ctx", metric: "weight_kg" });
    expect(result).toEqual<MeasurementSeries>({
      status: "success",
      metric: "weight_kg",
      period: "day",
      agg: "avg",
      series: [
        { bucket: "2026-08-24T00:00:00Z", value: 72, count: 3 },
        { bucket: "2026-08-31T00:00:00Z", value: 71.25, count: 2 },
      ],
      count: 2,
    });
  });

  it("forwards period and agg, a string bound as given and a Date as its instant", async () => {
    const server = new FakeServer();
    server.toolResults.recall_series = measurementSeries({ agg: "max" });
    await makeClient(server).recallSeries({
      contextId: "ctx",
      metric: "weight_kg",
      period: "week",
      agg: "max",
      start: new Date(Date.UTC(2026, 7, 1)),
      end: "2026-09-01T00:00:00Z",
    });
    expect(server.toolCallArgs()).toEqual({
      context_id: "ctx",
      metric: "weight_kg",
      period: "week",
      agg: "max",
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-09-01T00:00:00Z",
    });
  });

  it("sends empty bounds, for the server to refuse", async () => {
    const server = new FakeServer();
    server.toolResults.recall_series = measurementSeries();
    await makeClient(server).recallSeries({ contextId: "ctx", metric: "m", start: "", end: "" });
    expect(server.toolCallArgs()).toMatchObject({ start: "", end: "" });
  });

  it("returns an empty window as an empty series, not an error", async () => {
    const server = new FakeServer();
    server.toolResults.recall_series = measurementSeries({ series: [], count: 0 });
    const result = await makeClient(server).recallSeries({ contextId: "ctx", metric: "weight_kg" });
    expect(result.series).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("reads a missing series as empty, as Python's default does", async () => {
    const server = new FakeServer();
    const { series: _series, ...noSeries } = measurementSeries({ count: 0 });
    server.toolResults.recall_series = noSeries;
    const result = await makeClient(server).recallSeries({ contextId: "ctx", metric: "m" });
    expect(result.series).toEqual([]);
  });

  it("echoes an unknown period and agg, and drops fields the model does not name", async () => {
    const server = new FakeServer();
    server.toolResults.recall_series = measurementSeries({
      period: "quarter",
      agg: "p95",
      window: { days: 90 },
      series: [{ bucket: "2026-07-01T00:00:00Z", value: 1.5, count: 4, extra: true }],
      count: 1,
    });
    const result = await makeClient(server).recallSeries({ contextId: "ctx", metric: "weight_kg" });
    expect([result.period, result.agg]).toEqual(["quarter", "p95"]);
    expect(Object.keys(result)).toEqual(["status", "metric", "period", "agg", "series", "count"]);
    expect(result.series).toEqual([{ bucket: "2026-07-01T00:00:00Z", value: 1.5, count: 4 }]);
  });

  it("reads counts and values in pydantic's lax mode", async () => {
    const server = new FakeServer();
    server.toolResults.recall_series = measurementSeries({
      count: "1",
      series: [{ bucket: "2026-01-01T00:00:00Z", value: "1.5", count: 2.0 }],
    });
    const result = await makeClient(server).recallSeries({ contextId: "ctx", metric: "m" });
    expect(result.count).toBe(1);
    expect(result.series).toEqual([{ bucket: "2026-01-01T00:00:00Z", value: 1.5, count: 2 }]);
  });

  it.each([
    ["empty", "", "metric must be a non-empty string, got ''"],
    ["long", "m".repeat(65), "metric must be at most 64 characters, got 65"],
    ["null", null, "metric must be a non-empty string, got None"],
  ])("refuses a %s metric before any request", async (_name, metric, message) => {
    const server = new FakeServer();
    const client = makeClient(server);
    await expect(
      client.recallSeries({ contextId: "ctx", metric: metric as string }),
    ).rejects.toThrow(message);
    expect(server.requests).toEqual([]);
  });

  it("refuses an invalid Date bound before any request", async () => {
    const server = new FakeServer();
    await expect(
      makeClient(server).recallSeries({ contextId: "ctx", metric: "m", end: new Date("nope") }),
    ).rejects.toThrow("end must be a valid Date");
    expect(server.requests).toEqual([]);
  });

  it("surfaces the server's window cap as a KaguraError", async () => {
    const server = new FakeServer();
    server.toolResults.recall_series = {
      status: "error",
      error: "validation_error",
      message: "Window too wide: maximum lookback is 365 days",
    };
    const err = await failure(
      makeClient(server).recallSeries({
        contextId: "ctx",
        metric: "weight_kg",
        start: "2024-01-01T00:00:00",
        end: "2026-01-01T00:00:00",
      }),
    );
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as Error).message).toBe(
      "recall_series failed (validation_error): Window too wide: maximum lookback is 365 days",
    );
  });

  it("throws KaguraNotFoundError for a missing context", async () => {
    const server = new FakeServer();
    server.toolResults.recall_series = {
      status: "error",
      error: "context_not_found",
      message: "Context not found.",
    };
    await expect(
      makeClient(server).recallSeries({ contextId: "c", metric: "m" }),
    ).rejects.toBeInstanceOf(KaguraNotFoundError);
  });

  it.each([
    ["a null series", measurementSeries({ series: null }), "series: Input should be a valid list"],
    ["an object series", measurementSeries({ series: {} }), "series: Input should be a valid list"],
    [
      "an empty payload",
      {},
      "metric: Field required; period: Field required; agg: Field required (+1 more)",
    ],
    // Buckets are read before the top-level count, in the model's order.
    [
      "an empty bucket beside missing fields",
      { series: [{}] },
      "metric: Field required; period: Field required; agg: Field required (+4 more)",
    ],
    [
      "a bucket missing fields",
      measurementSeries({ series: [{ value: 1 }] }),
      "series.0.bucket: Field required; series.0.count: Field required",
    ],
    [
      "a bucket that is no object",
      measurementSeries({ series: [5] }),
      "series.0: Input should be a valid dictionary or instance of SeriesBucket",
    ],
    [
      "a fractional count",
      measurementSeries({ count: 3.5 }),
      "count: Input should be a valid integer, got a number with a fractional part",
    ],
    ["a numeric period", measurementSeries({ period: 1 }), "period: Input should be a valid string"],
    [
      "a null bucket time",
      measurementSeries({ series: [{ bucket: null, value: 1, count: 1 }] }),
      "series.0.bucket: Input should be a valid datetime",
    ],
  ])("refuses %s as a KaguraResponseError in Python's words", async (_name, payload, problems) => {
    const server = new FakeServer();
    server.toolResults.recall_series = payload;
    const err = await failure(makeClient(server).recallSeries({ contextId: "c", metric: "m" }));
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as KaguraResponseError).operation).toBe("recall_series");
    expect((err as Error).message).toBe(
      `recall_series: unexpected server response for MeasurementSeries (${problems}). ${HINT}`,
    );
  });
});

describe("listMemories bounding box (#57)", () => {
  const PATH = "/api/v1/memory/list";

  function listServer(memories: unknown[] = []): FakeServer {
    const server = new FakeServer();
    server.restResults[PATH] = { memories, total: memories.length, has_more: false };
    return server;
  }

  function query(server: FakeServer, n = 0): URLSearchParams {
    return new URL(server.requests[n]!.url).searchParams;
  }

  it("forwards all four bounds after the other filters, in Python's order", async () => {
    const server = listServer();
    await makeClient(server).listMemories({
      contextId: "ctx-1",
      orderBy: "created_at",
      latMin: 35,
      latMax: 36,
      lonMin: 139,
      lonMax: 140.5,
    });
    expect([...query(server).keys()]).toEqual([
      "limit",
      "offset",
      "context_id",
      "order_by",
      "lat_min",
      "lat_max",
      "lon_min",
      "lon_max",
    ]);
    expect(Object.fromEntries(query(server))).toMatchObject({
      lat_min: "35",
      lat_max: "36",
      lon_min: "139",
      lon_max: "140.5",
    });
  });

  it("forwards a one-sided bound alone", async () => {
    const server = listServer();
    await makeClient(server).listMemories({ latMin: 35 });
    const params = query(server);
    expect(params.get("lat_min")).toBe("35");
    expect(["lat_max", "lon_min", "lon_max"].filter((k) => params.has(k))).toEqual([]);
  });

  it("sends 0, the equator and the prime meridian, as a bound", async () => {
    const server = listServer();
    await makeClient(server).listMemories({ latMin: 0, lonMax: -0 });
    expect(query(server).get("lat_min")).toBe("0");
    expect(query(server).get("lon_max")).toBe("0");
  });

  it("passes lonMin > lonMax through: it is the box across the antimeridian", async () => {
    const server = listServer();
    await makeClient(server).listMemories({ lonMin: 170, lonMax: -170 });
    expect(query(server).get("lon_min")).toBe("170");
    expect(query(server).get("lon_max")).toBe("-170");
  });

  it("accepts the range edges: the whole globe is a valid box", async () => {
    const server = listServer();
    await makeClient(server).listMemories({ latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 });
    expect(Object.fromEntries(query(server))).toMatchObject({
      lat_min: "-90",
      lat_max: "90",
      lon_min: "-180",
      lon_max: "180",
    });
  });

  it.each([
    [{ latMin: -90.5 }, "latMin must be between -90 and 90, got -90.5"],
    [{ latMax: 91 }, "latMax must be between -90 and 90, got 91"],
    [{ lonMin: -181 }, "lonMin must be between -180 and 180, got -181"],
    [{ lonMax: 180.1 }, "lonMax must be between -180 and 180, got 180.1"],
    [{ latMin: Number.NaN }, "latMin must be between -90 and 90, got nan"],
    [{ lonMin: Number.POSITIVE_INFINITY }, "lonMin must be between -180 and 180, got inf"],
    [
      { lonMax: "140" },
      "lonMax must be a number, got str ('140'). The server rejects string-typed coordinates.",
    ],
    [
      { latMax: true },
      "latMax must be a number, got bool (True). The server rejects string-typed coordinates.",
    ],
  ])("refuses %o before any request", async (bound, message) => {
    const server = listServer();
    const client = makeClient(server);
    await expect(
      client.listMemories(bound as Parameters<typeof client.listMemories>[0]),
    ).rejects.toThrow(message);
    expect(server.requests).toEqual([]);
  });

  it("sends no bound when none is set, so existing calls are unchanged", async () => {
    const server = listServer();
    await makeClient(server).listMemories({ contextId: "ctx-1" });
    expect(["lat_min", "lat_max", "lon_min", "lon_max"].filter((k) => query(server).has(k))).toEqual([]);
  });

  it("returns each item's location as the server sends it", async () => {
    const base = {
      summary: "s",
      type: "note",
      scope: "persistent",
      importance: 0.5,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    };
    const server = listServer([
      { ...base, id: "with-loc", location: { lat: 35.68, lon: 139.76 } },
      { ...base, id: "null-loc", location: null },
      { ...base, id: "no-loc" },
    ]);
    const result = await makeClient(server).listMemories({ latMin: 35 });
    const [withLoc, nullLoc, noLoc] = result.memories!;
    expect(withLoc!.location).toEqual({ lat: 35.68, lon: 139.76 });
    expect(nullLoc!.location).toBeNull();
    expect(noLoc!.location ?? null).toBeNull();
  });
});
