/**
 * `kagura-memory measure record|series` against the Python CLI (v0.40.1,
 * click 8.3.3). Each row of the argv tables was captured from `kagura
 * measure …` run against a fake server: exit code, the `Error:` line and
 * whether anything was sent.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { FakeServer, makeClient } from "../../fakeServer.js";

const C = "11111111-2222-3333-4444-555555555555";

const MEASUREMENT = {
  status: "success",
  measurement_id: "cccccccc-dddd-eeee-ffff-000000000000",
  metric: "weight_kg",
  measured_at: "2026-09-01T07:30:00Z",
  value: 71.5,
  unit: "kg",
};

const SERIES = {
  status: "success",
  metric: "weight_kg",
  period: "week",
  agg: "avg",
  series: [
    { bucket: "2026-08-24T00:00:00Z", value: 72.0, count: 3 },
    { bucket: "2026-08-31T00:00:00Z", value: 71.25, count: 2 },
  ],
  count: 2,
};

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  server: FakeServer;
  /** What `.kagura.json` holds; a setup callback may replace it. */
  config: Record<string, unknown>;
}

function harness(): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const server = new FakeServer();
  server.toolResults.record_measurement = MEASUREMENT;
  server.toolResults.recall_series = SERIES;
  const h = { out, err, server } as Harness;
  // A configured context_id that must never be used: both commands take
  // the context positionally, with no .kagura.json fallback.
  h.config = { api_key: "k", context_id: "ctx-from-config" };
  h.deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => true,
    loadConfig: () => h.config,
    makeClient: (o: Record<string, unknown>) => makeClient(server, o),
  } as unknown as CliDeps;
  return h;
}

async function run(argv: string[], setup?: (h: Harness) => void) {
  const h = harness();
  setup?.(h);
  const code = await runCli(argv, h.deps);
  const calls = h.server.requests.filter((r) => r.body?.method === "tools/call");
  return {
    code,
    out: h.out.join("\n"),
    err: h.err.join("\n"),
    sent: calls.length > 0 ? h.server.toolCallArgs(0) : undefined,
    h,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("kagura-memory measure (group)", () => {
  it("lists both commands under Python's summary", async () => {
    const { code, out } = await run(["measure", "--help"]);
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "Usage: kagura-memory measure [OPTIONS] COMMAND [ARGS]...",
        "",
        "  Record and read numeric measurement series (never recalled as memories).",
        "",
        "Commands:",
        "  record    Append one numeric observation to METRIC's series in a context.",
        "  series    Read METRIC's series in a context, bucketed and aggregated.",
      ].join("\n"),
    );
  });

  it("prints the group help on stderr with exit 2 when no command is given", async () => {
    const { code, out, err } = await run(["measure"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("Usage: kagura-memory measure [OPTIONS] COMMAND [ARGS]...");
  });

  it("refuses an unknown subcommand as click does", async () => {
    const { code, err } = await run(["measure", "bogus"]);
    expect(code).toBe(2);
    expect(err).toContain("Error: No such command 'bogus'.");
  });

  it("is listed in the root help", async () => {
    const { out } = await run(["--help"]);
    expect(out).toContain(
      "  measure        Record and read numeric measurement series (never recalled as memories).",
    );
  });

  it.each([
    [["record", C, "m", "5"]],
    [["series", C, "m"]],
  ])("runs %j with no context_id in .kagura.json: the argument is the context", async (argv) => {
    const { code, err, sent } = await run(["measure", ...argv], (h) => {
      h.config = { api_key: "k" };
    });
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(sent).toMatchObject({ context_id: C });
  });
});

describe("kagura-memory measure record", () => {
  it("renders --help from the Python declaration, examples one per line", async () => {
    const { code, out } = await run(["measure", "record", "--help"]);
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "Usage: kagura-memory measure record [OPTIONS] CONTEXT_ID METRIC VALUE",
        "",
        "  Append one numeric observation to METRIC's series in a context.",
        "",
        "  Append-only: recording the same point twice stores two rows, and there is no",
        "  delete. Measurements are never embedded, never returned by recall, and never",
        "  merged or rewritten by Sleep consolidation; use `kagura-memory remember` for",
        '  prose such as "hit goal weight".',
        "",
        "  Examples:",
        "    kagura-memory measure record <context-id> weight_kg 71.5 --unit kg",
        "    kagura-memory measure record <context-id> pnl_usd -120 --at 2026-09-01T00:00:00Z",
        "",
        "Options:",
        "      --unit TEXT         Display unit, e.g. 'kg' (max 32 chars).",
        "      --at TEXT           ISO 8601 observation time (naive = UTC). Default: now.",
        "  --help                  Show this message and exit.",
      ].join("\n"),
    );
  });

  it("sends every argument and prints Python's model, extra fields dropped", async () => {
    const { code, out, sent } = await run(
      ["measure", "record", C, "weight_kg", "71.5", "--unit", "kg", "--at", "2026-09-01T07:30:00Z"],
      (h) => {
        h.server.toolResults.record_measurement = { ...MEASUREMENT, extra: "dropped" };
      },
    );
    expect(code).toBe(0);
    expect(sent).toEqual({
      context_id: C,
      metric: "weight_kg",
      value: 71.5,
      measured_at: "2026-09-01T07:30:00Z",
      unit: "kg",
    });
    expect(out).toBe(
      [
        "{",
        '  "status": "success",',
        '  "measurement_id": "cccccccc-dddd-eeee-ffff-000000000000",',
        '  "metric": "weight_kg",',
        '  "measured_at": "2026-09-01T07:30:00Z",',
        '  "value": 71.5,',
        '  "unit": "kg"',
        "}",
      ].join("\n"),
    );
  });

  it("sends only the three arguments without options, and prints unit null", async () => {
    const { code, out, sent } = await run(["measure", "record", C, "reps", "12"], (h) => {
      const { unit: _unit, ...noUnit } = MEASUREMENT;
      h.server.toolResults.record_measurement = { ...noUnit, metric: "reps", value: 12.0 };
    });
    expect(code).toBe(0);
    expect(sent).toEqual({ context_id: C, metric: "reps", value: 12 });
    const printed = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(printed)).toEqual([
      "status",
      "measurement_id",
      "metric",
      "measured_at",
      "value",
      "unit",
    ]);
    expect(printed.unit).toBeNull();
  });

  it.each([
    ["-3.5", -3.5],
    ["-1e3", -1000],
    ["-120", -120],
    ["+5", 5],
    [" 5 ", 5],
    [".5", 0.5],
    ["5.", 5],
    ["1_000", 1000],
  ])("reads VALUE %j as click's float() does, a negative one without --", async (raw, value) => {
    const { code, sent } = await run(["measure", "record", C, "pnl", raw, "--unit", "USD"]);
    expect(code).toBe(0);
    expect(sent).toMatchObject({ metric: "pnl", value, unit: "USD" });
  });

  it("takes a value after --", async () => {
    const { code, sent } = await run(["measure", "record", C, "pnl", "--", "-5"]);
    expect(code).toBe(0);
    expect(sent).toMatchObject({ value: -5 });
  });

  it("takes options before the arguments", async () => {
    const { code, sent } = await run(["measure", "record", "--unit", "USD", C, "pnl", "-3.5"]);
    expect(code).toBe(0);
    expect(sent).toEqual({ context_id: C, metric: "pnl", value: -3.5, unit: "USD" });
  });

  it("keeps the last of a repeated option, as click does", async () => {
    const { sent } = await run(["measure", "record", C, "m", "5", "--unit=kg", "--unit=g"]);
    expect(sent).toMatchObject({ unit: "g" });
  });

  it("sends an empty --at= for the server to refuse, as Python does", async () => {
    const { code, err, sent } = await run(["measure", "record", C, "m", "5", "--at="], (h) => {
      h.server.toolResults.record_measurement = {
        status: "error",
        error: "validation_error",
        message: "'measured_at' is not a valid ISO 8601 datetime: ''",
      };
    });
    expect(sent).toMatchObject({ measured_at: "" });
    expect(code).toBe(1);
    expect(err).toBe(
      "Error: record_measurement failed (validation_error): 'measured_at' is not a valid ISO 8601 datetime: ''",
    );
  });

  it("sends an empty CONTEXT_ID for the server to refuse, as Python does", async () => {
    const { code, sent } = await run(["measure", "record", "", "m", "5"], (h) => {
      h.server.toolResults.record_measurement = {
        status: "error",
        error: "invalid_context_id_format",
        message: "Invalid context_id format: ''.",
      };
    });
    expect(sent).toMatchObject({ context_id: "" });
    expect(code).toBe(1);
  });

  it.each([
    [[], "Missing argument 'CONTEXT_ID'."],
    [[C], "Missing argument 'METRIC'."],
    [[C, "m"], "Missing argument 'VALUE'."],
    [["--weight"], "Missing argument 'METRIC'."],
    [[C, "--weight"], "Missing argument 'VALUE'."],
    [[C, "m", "heavy"], "Invalid value for 'VALUE': 'heavy' is not a valid float."],
    [[C, "m", "0x10"], "Invalid value for 'VALUE': '0x10' is not a valid float."],
    [[C, "m", "-0x10"], "Invalid value for 'VALUE': '-0x10' is not a valid float."],
    // The float conversion comes before the command's own dash check.
    [["-c", "dev", "heavy"], "Invalid value for 'VALUE': 'heavy' is not a valid float."],
    [[C, "--unti", "kg", "m", "5"], "Invalid value for 'VALUE': 'kg' is not a valid float."],
    [[C, "m", "1", "extra"], "Got unexpected extra argument (extra)"],
    [[C, "m", "1", "--unti", "kg"], "Got unexpected extra arguments (--unti kg)"],
    // The extra argument comes before the dash check too.
    [[C, "--weight", "5", "extra"], "Got unexpected extra argument (extra)"],
    [[C, "--weight", "71.5"], "No such option: --weight"],
    // Without its value, where click names the whole token: see the
    // `--name=value` rows below.
    [[C, "--metric=weight_kg", "71.5"], "No such option: --metric"],
    [[C, "-x", "5"], "No such option: -x"],
    [["-c", "dev", "71.5"], "No such option: -c"],
    [["--ctx", "--weight", "5"], "No such option: --ctx"],
    [["-", "m", "5"], "No such option: -"],
    // Refused after `--` too, as the Python CLI refuses it (PYBUG 1 of the
    // scout: kept for parity).
    [[C, "--", "-m", "5"], "No such option: -m"],
    [["--", "-ctx", "m", "5"], "No such option: -ctx"],
  ])("refuses %j with exit 2 and nothing sent", async (argv, message) => {
    const { code, err, sent } = await run(["measure", "record", ...argv]);
    expect(code).toBe(2);
    expect(err).toBe(`Error: ${message}`);
    expect(sent).toBeUndefined();
  });

  it.each([["nan"], ["inf"], ["-inf"], ["-nan"], ["1e400"], ["Infinity"]])(
    "refuses the non-finite VALUE %j with the SDK's message and exit 1, as Python does",
    async (raw) => {
      const { code, err, sent } = await run(["measure", "record", C, "m", raw]);
      expect(code).toBe(1);
      expect(err).toBe("Error: value must be finite (NaN and infinity are rejected)");
      expect(sent).toBeUndefined();
    },
  );

  it.each([
    [["", "5"], "metric must be a non-empty string, got ''"],
    [["m".repeat(65), "5"], "metric must be at most 64 characters, got 65"],
    [["m", "5", "--unit", ""], "unit must be a non-empty string of at most 32 characters, got ''"],
    [
      ["m", "5", "--unit", "u".repeat(33)],
      `unit must be a non-empty string of at most 32 characters, got '${"u".repeat(33)}'`,
    ],
    // Python's repr switches to double quotes around an apostrophe.
    [
      ["m", "5", "--unit", `it's${"x".repeat(30)}`],
      `unit must be a non-empty string of at most 32 characters, got "it's${"x".repeat(30)}"`,
    ],
  ])("refuses %j in the client, exit 1 and nothing sent", async (argv, message) => {
    const { code, err, sent } = await run(["measure", "record", C, ...argv]);
    expect(code).toBe(1);
    expect(err).toBe(`Error: ${message}`);
    expect(sent).toBeUndefined();
  });

  it.each([["体"], ["😀"]])("counts a 64-character metric of %j in code points", async (ch) => {
    const { code, sent } = await run(["measure", "record", C, ch.repeat(64), "5"]);
    expect(code).toBe(0);
    expect(sent).toMatchObject({ metric: ch.repeat(64) });
  });

  it.each([
    [
      { status: "error", error: "context_not_found", message: "Context not found or you don't have access to it." },
      "Error: record_measurement: Context not found or you don't have access to it.",
    ],
    [
      {
        status: "error",
        error: "permission_denied",
        message: "Viewers have read-only access. Cannot record measurement.",
      },
      "Error: record_measurement failed (permission_denied): Viewers have read-only access. Cannot record measurement.",
    ],
    [
      { status: "error", error: "unknown_tool", message: "Unknown tool: record_measurement" },
      "Error: record_measurement failed (unknown_tool): Unknown tool: record_measurement",
    ],
    [
      { status: "success", measurement_id: "m", metric: "weight_kg", value: 71.5 },
      "Error: record_measurement: unexpected server response for MeasurementResult " +
        "(measured_at: Field required). The server may be newer than this SDK; " +
        "upgrading kagura-memory may help.",
    ],
  ])("reports the server's %j with exit 1", async (payload, message) => {
    const { code, out, err } = await run(["measure", "record", C, "m", "5"], (h) => {
      h.server.toolResults.record_measurement = payload;
    });
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(message);
  });

  it("adds the Resets at: line to the daily MCP cap, as Python's CLI does", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T18:30:00Z"));
    const { code, err } = await run(["measure", "record", C, "m", "5"], (h) => {
      h.server.toolResults.record_measurement = {
        status: "error",
        error: "rate_limit_exceeded",
        message: "Daily MCP call limit reached (100/100). Resets at midnight UTC.",
        used_today: 100,
        daily_limit: 100,
      };
    });
    expect(code).toBe(1);
    expect(err).toBe(
      "Error: record_measurement failed (rate_limit_exceeded): Daily MCP call limit reached " +
        "(100/100). Resets at midnight UTC.\n  Resets at: 2026-09-25T00:00:00+00:00",
    );
  });

  describe("deliberate differences from the Python CLI", () => {
    // Click names an unknown `--name=value` token whole here, value and
    // all; the rest of the bin names it `--name`, since the value may be a
    // credential (`measure series` and `recall` print `--api-key` for the
    // same token).
    it.each([
      [[C, "--api-key=kg_SECRET123", "5"], "No such option: --api-key"],
      [["--api-key=kg_SECRET123", "m", "5"], "No such option: --api-key"],
      [[C, "--", "--api-key=kg_SECRET123", "5"], "No such option: --api-key"],
      [[C, "m", "5", "--api-key=kg_SECRET123"], "Got unexpected extra argument (--api-key)"],
      [[C, "m", "5", "extra", "--api-key=kg_SECRET123"], "Got unexpected extra arguments (extra --api-key)"],
      [[C, "m", "5", "--", "--api-key=kg_SECRET123"], "Got unexpected extra argument (--api-key)"],
      [[C, "m", "5", "--api-key=kg=SECRET123"], "Got unexpected extra argument (--api-key)"],
      [[C, "m", "5", "--=kg_SECRET123"], "Got unexpected extra argument (--)"],
      [[C, "m", "--api-key=kg_SECRET123"], "Invalid value for 'VALUE': '--api-key' is not a valid float."],
    ])("names %j without the value written into it", async (argv, message) => {
      const { code, out, err, sent } = await run(["measure", "record", ...argv]);
      expect(code).toBe(2);
      expect(err).toBe(`Error: ${message}`);
      expect(`${out}\n${err}`).not.toContain("SECRET");
      expect(sent).toBeUndefined();
    });

    it("reads -h as help everywhere, where Python reads it as CONTEXT_ID", async () => {
      for (const argv of [["-h"], [C, "m", "5", "-h"]]) {
        const { code, out, sent } = await run(["measure", "record", ...argv]);
        expect(code).toBe(0);
        expect(out).toContain("Usage: kagura-memory measure record");
        expect(sent).toBeUndefined();
      }
    });

    it("does not take a dash-led non-number as --unit's value, where click takes -kg", async () => {
      const { code, err, sent } = await run(["measure", "record", C, "m", "5", "--unit", "-kg"]);
      expect(code).toBe(2);
      expect(err).toContain("Error: Option '--unit' requires an argument.");
      expect(sent).toBeUndefined();
    });

    it("refuses an option given no value, exit 2 as in click", async () => {
      for (const flag of ["--unit", "--at"]) {
        const { code, err, sent } = await run(["measure", "record", C, "m", "5", flag]);
        expect(code).toBe(2);
        expect(err).toContain(`Error: Option '${flag}' requires an argument.`);
        expect(sent).toBeUndefined();
      }
    });
  });
});

describe("kagura-memory measure series", () => {
  it("renders --help from the Python declaration", async () => {
    const { code, out } = await run(["measure", "series", "--help"]);
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "Usage: kagura-memory measure series [OPTIONS] CONTEXT_ID METRIC",
        "",
        "  Read METRIC's series in a context, bucketed and aggregated.",
        "",
        "  Empty buckets are omitted, and buckets align to UTC boundaries.",
        "",
        "  Examples:",
        "    kagura-memory measure series <context-id> weight_kg --period week",
        "    kagura-memory measure series <context-id> pnl_usd --agg sum --start 2026-01-01T00:00:00",
        "",
        "Options:",
        "      --period [day|week|month]           Bucket size (server default: day).",
        "      --agg [avg|min|max|sum|count|last]  Per-bucket aggregate (server default: avg; 'last' = most recent value).",
        "      --start TEXT                        ISO 8601 window start, inclusive (naive = UTC). Default: end minus 30 days.",
        "      --end TEXT                          ISO 8601 window end, exclusive (naive = UTC). Default: now. Max window: 365 days.",
        "  --help                                  Show this message and exit.",
      ].join("\n"),
    );
  });

  it("sends every option and prints Python's model", async () => {
    const { code, out, sent } = await run(
      [
        "measure",
        "series",
        C,
        "weight_kg",
        "--period",
        "week",
        "--agg",
        "last",
        "--start",
        "2026-08-01T00:00:00",
        "--end",
        "2026-09-01T00:00:00",
      ],
      (h) => {
        h.server.toolResults.recall_series = { ...SERIES, window: { days: 31 } };
      },
    );
    expect(code).toBe(0);
    expect(sent).toEqual({
      context_id: C,
      metric: "weight_kg",
      period: "week",
      agg: "last",
      start: "2026-08-01T00:00:00",
      end: "2026-09-01T00:00:00",
    });
    // Python prints 72.0 for the float; JSON has no int/float distinction
    // (the documented divergence in output.ts), so this prints 72.
    expect(out).toBe(
      [
        "{",
        '  "status": "success",',
        '  "metric": "weight_kg",',
        '  "period": "week",',
        '  "agg": "avg",',
        '  "series": [',
        "    {",
        '      "bucket": "2026-08-24T00:00:00Z",',
        '      "value": 72,',
        '      "count": 3',
        "    },",
        "    {",
        '      "bucket": "2026-08-31T00:00:00Z",',
        '      "value": 71.25,',
        '      "count": 2',
        "    }",
        "  ],",
        '  "count": 2',
        "}",
      ].join("\n"),
    );
  });

  it("sends only the two arguments without options, so the server defaults apply", async () => {
    const { code, sent } = await run(["measure", "series", C, "weight_kg"]);
    expect(code).toBe(0);
    expect(sent).toEqual({ context_id: C, metric: "weight_kg" });
  });

  it("prints an empty window as an empty series, exit 0", async () => {
    const { code, out } = await run(["measure", "series", C, "weight_kg"], (h) => {
      h.server.toolResults.recall_series = { ...SERIES, series: [], count: 0 };
    });
    expect(code).toBe(0);
    expect(out).toContain('  "series": [],\n  "count": 0\n}');
  });

  it("keeps the last of a repeated choice", async () => {
    const { sent } = await run(["measure", "series", C, "m", "--period", "week", "--period", "month"]);
    expect(sent).toMatchObject({ period: "month" });
  });

  it("sends an empty --start= / --end= for the server to refuse, as Python does", async () => {
    const { sent } = await run(["measure", "series", C, "m", "--start=", "--end="]);
    expect(sent).toMatchObject({ start: "", end: "" });
  });

  it.each([
    [[], "Missing argument 'CONTEXT_ID'."],
    [[C], "Missing argument 'METRIC'."],
    [[C, "m", "extra"], "Got unexpected extra argument (extra)"],
    [[C, "m", "--period", "year"], "Invalid value for '--period': 'year' is not one of 'day', 'week', 'month'."],
    [
      [C, "m", "--agg", "median"],
      "Invalid value for '--agg': 'median' is not one of 'avg', 'min', 'max', 'sum', 'count', 'last'.",
    ],
    // click.Choice is case-sensitive here.
    [[C, "m", "--period", "Week"], "Invalid value for '--period': 'Week' is not one of 'day', 'week', 'month'."],
    [
      [C, "m", "--agg", "AVG"],
      "Invalid value for '--agg': 'AVG' is not one of 'avg', 'min', 'max', 'sum', 'count', 'last'.",
    ],
    [[C, "m", "--period="], "Invalid value for '--period': '' is not one of 'day', 'week', 'month'."],
    // Options are converted before the arguments are counted.
    [["--period", "year"], "Invalid value for '--period': 'year' is not one of 'day', 'week', 'month'."],
    [[C, "m", "extra", "--period", "year"], "Invalid value for '--period': 'year' is not one of 'day', 'week', 'month'."],
    [["--period", "year", "--agg", "median"], "Invalid value for '--period': 'year' is not one of 'day', 'week', 'month'."],
  ])("refuses %j with exit 2 and nothing sent", async (argv, message) => {
    const { code, err, sent } = await run(["measure", "series", ...argv]);
    expect(code).toBe(2);
    expect(err).toBe(`Error: ${message}`);
    expect(sent).toBeUndefined();
  });

  it("reports both bad choices in declaration order, where click takes argv order", async () => {
    // Click would name --agg here, the first in argv (decision Q5).
    const { code, err } = await run(["measure", "series", "--agg", "median", "--period", "year"]);
    expect(code).toBe(2);
    expect(err).toBe("Error: Invalid value for '--period': 'year' is not one of 'day', 'week', 'month'.");
  });

  it("refuses an unknown option: series takes no negative value", async () => {
    const { code, err, sent } = await run(["measure", "series", C, "-x"]);
    expect(code).toBe(2);
    expect(err).toContain("Error: No such option: -x");
    expect(sent).toBeUndefined();
  });

  it("refuses an empty METRIC in the client, exit 1", async () => {
    const { code, err, sent } = await run(["measure", "series", C, ""]);
    expect(code).toBe(1);
    expect(err).toBe("Error: metric must be a non-empty string, got ''");
    expect(sent).toBeUndefined();
  });

  it.each([
    [
      { status: "error", error: "validation_error", message: "Window too wide: maximum lookback is 365 days" },
      "Error: recall_series failed (validation_error): Window too wide: maximum lookback is 365 days",
    ],
    [
      { status: "error", error: "context_not_found", message: "Context not found or you don't have access to it." },
      "Error: recall_series: Context not found or you don't have access to it.",
    ],
    [
      { status: "error", error: "unknown_tool", message: "Unknown tool: recall_series" },
      "Error: recall_series failed (unknown_tool): Unknown tool: recall_series",
    ],
    [
      { ...SERIES, series: null },
      "Error: recall_series: unexpected server response for MeasurementSeries " +
        "(series: Input should be a valid list). The server may be newer than this SDK; " +
        "upgrading kagura-memory may help.",
    ],
    [
      {},
      "Error: recall_series: unexpected server response for MeasurementSeries " +
        "(metric: Field required; period: Field required; agg: Field required (+1 more)). " +
        "The server may be newer than this SDK; upgrading kagura-memory may help.",
    ],
  ])("reports the server's %j with exit 1", async (payload, message) => {
    const { code, out, err } = await run(["measure", "series", C, "m"], (h) => {
      h.server.toolResults.recall_series = payload;
    });
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(message);
  });
});
