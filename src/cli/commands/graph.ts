/**
 * `kagura-memory edge …` and `kagura-memory sleep …`.
 *
 * Both take the context id as a **positional**, with no `.kagura.json`
 * fallback — these commands name every id they touch explicitly, because
 * an edge or a rollback aimed at the wrong context is not recoverable by
 * re-running with the right one.
 */

import { requireArg, rejectExtraArgs, type Command, type CommandGroup } from "../command.js";
import { CliError, parseFloatOption, parseIntOption, parseRanged, parseTags } from "../parse.js";
import type { FlagSpec, ParsedArgs } from "../parseArgs.js";
import { runClientCommand } from "../runClientCommand.js";

const YES: FlagSpec = { name: "yes", short: "y", type: "switch", help: "Skip confirmation prompt" };

const MIN_WEIGHT: FlagSpec = {
  name: "min-weight",
  type: "value",
  metavar: "FLOAT",
  help: "Minimum edge weight (0.0-3.0)",
  defaultLabel: "0.0",
};
const EDGE_TYPES: FlagSpec = {
  name: "type",
  type: "value",
  help: "Comma-separated edge types to filter (e.g. 'related_to,depends_on')",
};
const LIMIT: FlagSpec = {
  name: "limit",
  type: "value",
  metavar: "INTEGER",
  help: "Max edges per direction (effective max: 2x limit, dedup'd)",
};

function optionalFloat(args: ParsedArgs, flag: FlagSpec): number | undefined {
  const raw = args.values[flag.name];
  return raw === undefined ? undefined : parseFloatOption(flag, raw);
}

const edgeList: Command = {
  summary: "List edges connected to a memory.",
  args: "CONTEXT_ID MEMORY_ID",
  spec: { flags: [MIN_WEIGHT, EDGE_TYPES, LIMIT] },
  run: async (deps, args) => {
    const contextId = requireArg(args, 0, "CONTEXT_ID");
    const memoryId = requireArg(args, 1, "MEMORY_ID");
    rejectExtraArgs(args, 2);
    // Click's default is 0.0, not None, so this is always on the wire.
    const minWeight = optionalFloat(args, MIN_WEIGHT) ?? 0;
    const edgeTypes = parseTags(args.values.type);
    const rawLimit = args.values.limit;
    const limit = rawLimit === undefined ? undefined : parseIntOption(LIMIT, rawLimit);
    return runClientCommand(
      deps,
      undefined,
      (client) =>
        client.listEdges({
          contextId,
          memoryId,
          minWeight,
          ...(edgeTypes ? { edgeTypes } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      { needsContext: false },
    );
  },
};

const EDGE_TYPE: FlagSpec = { name: "type", type: "value", help: "Edge type", defaultLabel: "related_to" };
const WEIGHT: FlagSpec = {
  name: "weight",
  type: "value",
  metavar: "FLOAT",
  help: "Edge weight 0.0-3.0",
  defaultLabel: "0.5",
};
const CONFIDENCE: FlagSpec = {
  name: "confidence",
  type: "value",
  metavar: "FLOAT",
  help: "Edge confidence 0.0-1.0",
  defaultLabel: "1.0",
};

const edgeCreate: Command = {
  summary: "Create or upsert an edge from SOURCE_ID to TARGET_ID.",
  args: "CONTEXT_ID SOURCE_ID TARGET_ID",
  spec: { flags: [EDGE_TYPE, WEIGHT, CONFIDENCE] },
  run: async (deps, args) => {
    const contextId = requireArg(args, 0, "CONTEXT_ID");
    const sourceId = requireArg(args, 1, "SOURCE_ID");
    const targetId = requireArg(args, 2, "TARGET_ID");
    rejectExtraArgs(args, 3);
    const edgeType = args.values.type ?? "related_to";
    const weight = optionalFloat(args, WEIGHT) ?? 0.5;
    const confidence = optionalFloat(args, CONFIDENCE) ?? 1;
    return runClientCommand(
      deps,
      undefined,
      (client) => client.createEdge({ contextId, sourceId, targetId, edgeType, weight, confidence }),
      { needsContext: false },
    );
  },
};

const edgeUpdate: Command = {
  summary: "Update an existing edge's weight and/or type.",
  args: "CONTEXT_ID SOURCE_ID TARGET_ID",
  spec: {
    flags: [
      { ...WEIGHT, help: "New edge weight 0.0-3.0", defaultLabel: undefined },
      { ...EDGE_TYPE, help: "New edge type", defaultLabel: undefined },
    ],
  },
  run: async (deps, args) => {
    const contextId = requireArg(args, 0, "CONTEXT_ID");
    const sourceId = requireArg(args, 1, "SOURCE_ID");
    const targetId = requireArg(args, 2, "TARGET_ID");
    rejectExtraArgs(args, 3);
    const weight = optionalFloat(args, WEIGHT);
    const edgeType = args.values.type;
    if (weight === undefined && edgeType === undefined) {
      // ClickException, so exit 1 rather than the usage code — pinned by
      // the Python suite.
      throw new CliError("At least one of --weight or --type must be provided");
    }
    return runClientCommand(
      deps,
      undefined,
      (client) =>
        client.updateEdge({
          contextId,
          sourceId,
          targetId,
          ...(weight !== undefined ? { weight } : {}),
          ...(edgeType !== undefined ? { edgeType } : {}),
        }),
      { needsContext: false },
    );
  },
};

const edgeDelete: Command = {
  summary: "Delete the edge between SOURCE_ID and TARGET_ID.",
  args: "CONTEXT_ID SOURCE_ID TARGET_ID",
  spec: { flags: [YES] },
  run: async (deps, args) => {
    const contextId = requireArg(args, 0, "CONTEXT_ID");
    const sourceId = requireArg(args, 1, "SOURCE_ID");
    const targetId = requireArg(args, 2, "TARGET_ID");
    rejectExtraArgs(args, 3);
    if (
      !args.flags.has("yes") &&
      !(await deps.confirm(`Delete edge ${sourceId} -> ${targetId}?`))
    ) {
      throw new CliError("Aborted!");
    }
    return runClientCommand(
      deps,
      undefined,
      (client) => client.deleteEdge({ contextId, sourceId, targetId }),
      { needsContext: false },
    );
  },
};

export const EDGE_GROUP: CommandGroup = {
  summary: "Manage neural memory edges (list, create, update, delete).",
  commands: { list: edgeList, create: edgeCreate, update: edgeUpdate, delete: edgeDelete },
};

const SLEEP_LIMIT: FlagSpec = {
  name: "limit",
  type: "value",
  metavar: "INTEGER",
  help: "Max runs to return (1-50)",
  defaultLabel: "10",
};

const sleepHistory: Command = {
  summary: "List recent Sleep Maintenance runs for a context.",
  args: "CONTEXT_ID",
  spec: { flags: [SLEEP_LIMIT] },
  run: async (deps, args) => {
    const contextId = requireArg(args, 0, "CONTEXT_ID");
    rejectExtraArgs(args, 1);
    const raw = args.values.limit;
    const limit =
      raw === undefined
        ? 10
        : parseRanged(SLEEP_LIMIT, raw, { min: 1, max: 50, rangeLabel: "1<=x<=50", integer: true });
    return runClientCommand(
      deps,
      undefined,
      (client) => client.getSleepHistory({ contextId, limit }),
      { needsContext: false },
    );
  },
};

const sleepReport: Command = {
  summary: "Get a detailed Sleep Maintenance report including audit log.",
  args: "CONTEXT_ID REPORT_ID",
  spec: { flags: [] },
  run: async (deps, args) => {
    const contextId = requireArg(args, 0, "CONTEXT_ID");
    const reportId = requireArg(args, 1, "REPORT_ID");
    rejectExtraArgs(args, 2);
    return runClientCommand(
      deps,
      undefined,
      (client) => client.getSleepReport({ contextId, reportId }),
      { needsContext: false },
    );
  },
};

const sleepRollback: Command = {
  summary: "Roll back a completed Sleep Maintenance run.",
  args: "CONTEXT_ID REPORT_ID",
  description:
    "  Reverses edge creation, memory merges and importance updates made by\n" +
    "  the run. Without --yes the report is fetched first so the prompt can\n" +
    "  say what is about to be undone.",
  spec: { flags: [{ ...YES, help: "Skip confirmation prompt." }] },
  run: async (deps, args) => {
    const contextId = requireArg(args, 0, "CONTEXT_ID");
    const reportId = requireArg(args, 1, "REPORT_ID");
    rejectExtraArgs(args, 2);
    const skipPrompt = args.flags.has("yes");
    return runClientCommand(
      deps,
      undefined,
      async (client) => {
        if (!skipPrompt) {
          // Python pre-fetches only when it is going to prompt, so `--yes`
          // is exactly one round trip.
          const report = await client.getSleepReport({ contextId, reportId });
          const actions = (report as { action_count?: number }).action_count;
          const detail = actions === undefined ? "" : ` (${actions} actions)`;
          if (!(await deps.confirm(`Roll back sleep run ${reportId}${detail}?`))) {
            throw new CliError("Aborted!");
          }
        }
        return client.rollbackSleepRun({ contextId, reportId });
      },
      { needsContext: false },
    );
  },
};

export const SLEEP_GROUP: CommandGroup = {
  summary: "Inspect and roll back Sleep Maintenance runs.",
  commands: { history: sleepHistory, report: sleepReport, rollback: sleepRollback },
};
