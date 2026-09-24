/**
 * `kagura-memory measure record` and `kagura-memory measure series` — the
 * measurement lane (the HOW-MUCH axis, server v0.54.0+).
 *
 * Both take the context id as a **positional**, with no `.kagura.json`
 * fallback, as `edge` and `sleep` do: an observation recorded in the
 * wrong context cannot be deleted, so the context is always named.
 */

import { requireArg, rejectExtraArgs, type Command, type CommandGroup } from "../command.js";
import { CliUsageError, parseChoice, parseFloatOption } from "../parse.js";
import type { FlagSpec } from "../parseArgs.js";
import { runClientCommand } from "../runClientCommand.js";
import type { MeasurementAggregate, MeasurementPeriod } from "../../models.js";

/**
 * An unknown `--name=value` as `record`'s errors name it: `--name`, as the
 * parser names it for every other command, since the value may be a
 * credential (`--api-key=…`). Click names the whole token here. A value
 * given as its own argument cannot be told from one, in either CLI.
 */
function withoutValue(token: string): string {
  const eq = token.startsWith("--") ? token.indexOf("=") : -1;
  return eq === -1 ? token : token.slice(0, eq);
}

const UNIT: FlagSpec = { name: "unit", type: "value", help: "Display unit, e.g. 'kg' (max 32 chars)." };
const AT: FlagSpec = {
  name: "at",
  type: "value",
  help: "ISO 8601 observation time (naive = UTC). Default: now.",
};

const record: Command = {
  summary: "Append one numeric observation to METRIC's series in a context.",
  args: "CONTEXT_ID METRIC VALUE",
  description:
    "  Append-only: recording the same point twice stores two rows, and there is no\n" +
    "  delete. Measurements are never embedded, never returned by recall, and never\n" +
    "  merged or rewritten by Sleep consolidation; use `kagura-memory remember` for\n" +
    '  prose such as "hit goal weight".\n\n' +
    "  Examples:\n" +
    "    kagura-memory measure record <context-id> weight_kg 71.5 --unit kg\n" +
    "    kagura-memory measure record <context-id> pnl_usd -120 --at 2026-09-01T00:00:00Z",
  // A negative VALUE such as -3.5 is a value, not the unknown option -3,
  // and needs no `--`. The catch, as in click: every option this command
  // does not declare arrives as a positional too. After the three
  // arguments it is an extra argument, refused below, and in the VALUE
  // slot the float conversion refuses it; the CONTEXT_ID and METRIC slots
  // are checked by hand.
  ignoreUnknownOptions: true,
  spec: { flags: [UNIT, AT] },
  run: async (deps, args) => {
    // Click's order: the missing arguments, the VALUE conversion, the
    // extra arguments, then the command's own check.
    const contextId = requireArg(args, 0, "CONTEXT_ID");
    const metric = requireArg(args, 1, "METRIC");
    // No `--…` token is a float, so only the message changes.
    const value = parseFloatOption("VALUE", withoutValue(requireArg(args, 2, "VALUE")));
    rejectExtraArgs({ ...args, positionals: args.positionals.map(withoutValue) }, 3);
    // A mistyped option (`ctx --weight 71.5`, `-c dev 71.5`) lands here as
    // an argument. Sent, it would append a junk series the append-only
    // lane cannot delete, so it is refused as the option it almost
    // certainly is — after `--` too, as the Python CLI refuses it there:
    // no context id begins with `-`, and the SDK still takes such a metric
    // from a caller who means one.
    for (const token of [contextId, metric]) {
      if (token.startsWith("-")) throw new CliUsageError(`No such option: ${withoutValue(token)}`);
    }
    const { unit, at } = args.values;
    return runClientCommand(
      deps,
      undefined,
      // NaN, infinity and a bad metric or unit are the client's to refuse
      // (exit 1), with the Python SDK's messages, as the Python CLI does.
      (client) =>
        client.recordMeasurement({
          contextId,
          metric,
          value,
          ...(at !== undefined ? { measuredAt: at } : {}),
          ...(unit !== undefined ? { unit } : {}),
        }),
      { needsContext: false },
    );
  },
};

const PERIODS: readonly MeasurementPeriod[] = ["day", "week", "month"];
const AGGREGATES: readonly MeasurementAggregate[] = ["avg", "min", "max", "sum", "count", "last"];

const PERIOD: FlagSpec = {
  name: "period",
  type: "value",
  metavar: `[${PERIODS.join("|")}]`,
  help: "Bucket size (server default: day).",
};
const AGG: FlagSpec = {
  name: "agg",
  type: "value",
  metavar: `[${AGGREGATES.join("|")}]`,
  help: "Per-bucket aggregate (server default: avg; 'last' = most recent value).",
};
const START: FlagSpec = {
  name: "start",
  type: "value",
  help: "ISO 8601 window start, inclusive (naive = UTC). Default: end minus 30 days.",
};
const END: FlagSpec = {
  name: "end",
  type: "value",
  help: "ISO 8601 window end, exclusive (naive = UTC). Default: now. Max window: 365 days.",
};

const series: Command = {
  summary: "Read METRIC's series in a context, bucketed and aggregated.",
  args: "CONTEXT_ID METRIC",
  description:
    "  Empty buckets are omitted, and buckets align to UTC boundaries.\n\n" +
    "  Examples:\n" +
    "    kagura-memory measure series <context-id> weight_kg --period week\n" +
    "    kagura-memory measure series <context-id> pnl_usd --agg sum --start 2026-01-01T00:00:00",
  spec: { flags: [PERIOD, AGG, START, END] },
  run: async (deps, args) => {
    // Click converts the options before it looks at the arguments, so a
    // bad choice is reported ahead of a missing or extra argument. Both
    // choices match exactly (click's default), in declaration order where
    // click would take argv order.
    const { period: rawPeriod, agg: rawAgg, start, end } = args.values;
    const period = rawPeriod === undefined ? undefined : parseChoice(PERIOD, rawPeriod, PERIODS);
    const agg = rawAgg === undefined ? undefined : parseChoice(AGG, rawAgg, AGGREGATES);
    const contextId = requireArg(args, 0, "CONTEXT_ID");
    const metric = requireArg(args, 1, "METRIC");
    rejectExtraArgs(args, 2);
    return runClientCommand(
      deps,
      undefined,
      // An empty --start= / --end= is sent, for the server to refuse, as
      // the Python CLI sends it.
      (client) =>
        client.recallSeries({
          contextId,
          metric,
          ...(period !== undefined ? { period } : {}),
          ...(agg !== undefined ? { agg } : {}),
          ...(start !== undefined ? { start } : {}),
          ...(end !== undefined ? { end } : {}),
        }),
      { needsContext: false },
    );
  },
};

export const MEASURE_GROUP: CommandGroup = {
  summary: "Record and read numeric measurement series (never recalled as memories).",
  commands: { record, series },
};
