/**
 * The session-tool commands — `bootstrap`, `changes` and `list`
 * (memory-cloud v0.93.0+, SDK issue #86).
 *
 * Ported from the Python CLI 0.44.0's `cli.py`, flags, help and output:
 * each prints the Python SDK model's `model_dump(mode="json")` as the
 * Python CLI's `json.dumps(…, indent=2, ensure_ascii=False)` writes it
 * (`formatDumpsJson` of the model's read), so a field the server left out
 * prints with its default and a timestamp in pydantic's form; a
 * `plan_headroom` notice prints with its defaults filled, an unreadable one
 * dropped (#88). `forget --ids` lives with `forget` in `memory.ts`.
 */

import { pythonOptionNames } from "../../client.js";
import { KaguraError } from "../../errors.js";
import { isRecord } from "../../http.js";
import type { BootstrapComponentName, BootstrapFormat, ListOrderBy } from "../../models.js";
import { pyStr, pyTruthy } from "../../python.js";
import {
  BOOTSTRAP_RESPONSE,
  CHANGES_SINCE_RESPONSE,
  FORGET_BATCH_RESULT,
  LIST_MATCHING_RESPONSE,
  readModel,
  type Model,
} from "../../pyModels.js";
import { MAX_CHARS_MAX, MAX_CHARS_MIN } from "../../responseBudget.js";
import { examples, rejectExtraArgs, requireArg, type Command, type CommandDeps } from "../command.js";
import { formatDumpsJson } from "../modelDump.js";
import { optionalRanged, parseChoice, parseJsonObject, parseTags, refuseNonFinite } from "../parse.js";
import type { FlagSpec, ParsedArgs } from "../parseArgs.js";
import { runClientCommand } from "../runClientCommand.js";

const CONTEXT_ID: FlagSpec = {
  name: "context-id",
  short: "c",
  type: "value",
  help: "Context ID (or set in .kagura.json)",
};

const CURSOR: FlagSpec = { name: "cursor", type: "value", help: "next_cursor of the previous page" };

/** `--max-chars` of `changes` / `list`: `click.IntRange(10000, 100000)`. */
const MAX_CHARS: FlagSpec = {
  range: { min: MAX_CHARS_MIN, max: MAX_CHARS_MAX, rangeLabel: `${MAX_CHARS_MIN}<=x<=${MAX_CHARS_MAX}`, integer: true },
  name: "max-chars",
  type: "value",
  metavar: "INTEGER",
  help: "Response budget in characters, 10000-100000 (default 20000)",
};

/** `bootstrap`'s own floor (server `BOOTSTRAP_INDEX_MIN_CHARS`, v0.115.0+). */
const BOOTSTRAP_MIN_CHARS = 2_000;

/** A `click.Choice` option, or `undefined` when it was not given. */
function choice<T extends string>(args: ParsedArgs, flag: FlagSpec, choices: readonly T[]): T | undefined {
  const raw = args.values[flag.name];
  return raw === undefined ? undefined : parseChoice(flag, raw, choices);
}

/**
 * Print a reply as the Python CLI prints `model.model_dump(mode="json")`.
 *
 * The client checked the reply against the same model and returned it as
 * sent; this reads it once more for the dump's defaults and key order.
 */
function dump(model: Model, operation: string): (result: unknown) => string {
  return (result) => formatDumpsJson(readModel(result, model, operation));
}

const BOOTSTRAP_FORMATS: readonly BootstrapFormat[] = ["full", "index"];

const SINCE: FlagSpec = {
  name: "since",
  type: "value",
  help: "Start of the changes window: ISO 8601 (naive = UTC) or '<N>d' days back (default: the server's 7d)",
};
const INCLUDE: FlagSpec = {
  name: "include",
  type: "value",
  help: "Comma-separated lanes: pinned,upcoming,changes (default: all)",
};
const FORMAT: FlagSpec = {
  name: "format",
  type: "value",
  metavar: "[full|index]",
  help:
    "index: one short row per memory (server v0.115.0+); full: the whole shape. " +
    "Default: index below --max-chars 10000, else full",
};
const BOOTSTRAP_MAX_CHARS: FlagSpec = {
  range: { min: BOOTSTRAP_MIN_CHARS, max: MAX_CHARS_MAX, rangeLabel: `${BOOTSTRAP_MIN_CHARS}<=x<=${MAX_CHARS_MAX}`, integer: true },
  name: "max-chars",
  type: "value",
  metavar: "INTEGER",
  help: "Response budget in characters, 2000-100000 (below 10000 needs server v0.115.0+; default 20000)",
};

const bootstrap: Command = {
  summary: "Open a session on one context in one call (server v0.93.0+).",
  description:
    "  Prints the context block, its tool guardrails, the pinned memories, the\n" +
    "  upcoming Time Memories and what changed since --since, each lane fail-soft\n" +
    "  (degraded: true when one failed). No search runs: use `kagura-memory recall`\n" +
    "  for a topic.\n\n" +
    examples(
      "bootstrap",
      "bootstrap --since 7d --format index --max-chars 5000",
      "bootstrap -c dev --include pinned,changes --since 2026-11-01",
    ),
  spec: { flags: [CONTEXT_ID, SINCE, INCLUDE, FORMAT, BOOTSTRAP_MAX_CHARS] },
  run: async (deps, args) => {
    const format = choice(args, FORMAT, BOOTSTRAP_FORMATS);
    const maxChars = optionalRanged(args, BOOTSTRAP_MAX_CHARS);
    rejectExtraArgs(args);
    const since = args.values.since;
    // The client checks the lane names, as in Python.
    const include = parseTags(args.values.include) as BootstrapComponentName[] | undefined;
    return runClientCommand(
      deps,
      args.values["context-id"],
      (client, contextId) =>
        // The client's own checks, in its order; their messages name
        // `max_chars` as the Python CLI's do.
        client.bootstrap(
          pythonOptionNames({
            contextId,
            ...(since !== undefined ? { since } : {}),
            ...(include !== undefined ? { include } : {}),
            ...(maxChars !== undefined ? { maxChars } : {}),
            ...(format !== undefined ? { format } : {}),
          }),
        ),
      // Python dumps it by alias, which only `components.upcoming.from` has.
      { format: dump(BOOTSTRAP_RESPONSE, "bootstrap") },
    );
  },
};

const CHANGES_LIMIT: FlagSpec = {
  range: { min: 1, max: 100, rangeLabel: `${1}<=x<=${100}`, integer: true }, name: "limit", type: "value", metavar: "INTEGER", help: "Changes per page (default 50)" };

const changes: Command = {
  summary: "List what changed in a context since SINCE, oldest first (server v0.93.0+).",
  args: "SINCE",
  description:
    "  SINCE is ISO 8601 (naive = UTC). Events are created, updated, superseded\n" +
    "  (with superseded_by) and forgotten; a forgotten memory's events carry no\n" +
    "  summary. Page on with --cursor while has_more is true.\n\n" +
    examples(
      "changes 2026-11-01T00:00:00Z",
      "changes 2026-11-01 --kinds created,forgotten --limit 20",
      "changes 2026-11-04T09:00:00Z --by-me",
    ),
  spec: {
    flags: [
      CONTEXT_ID,
      { name: "until", type: "value", help: "Window end, exclusive (ISO 8601; default: now)" },
      {
        name: "kinds",
        type: "value",
        help:
          "Comma-separated kinds: created,updated,superseded,forgotten " +
          "(with --session-id/--by-me: created,updated,forgotten,restored). Default: all",
      },
      CURSOR,
      CHANGES_LIMIT,
      {
        name: "session-id",
        type: "value",
        help: "Only that session's writes (a session_id a write returned; server v0.113.0+)",
      },
      { name: "by-me", type: "switch", help: "Only your own writes, in any session (server v0.114.0+)" },
      MAX_CHARS,
    ],
  },
  run: async (deps, args) => {
    // click checks a given option before it reports a SINCE not given.
    const limit = optionalRanged(args, CHANGES_LIMIT);
    const maxChars = optionalRanged(args, MAX_CHARS);
    const since = requireArg(args, 0, "SINCE");
    rejectExtraArgs(args, 1);
    const { until, cursor } = args.values;
    const sessionId = args.values["session-id"];
    const kinds = parseTags(args.values.kinds);
    // Python sends by_me only when the flag is given (`True if by_me else None`).
    const byMe = args.flags.has("by-me");
    return runClientCommand(
      deps,
      args.values["context-id"],
      (client, contextId) =>
        client.changesSince({
          contextId,
          since,
          ...(until !== undefined ? { until } : {}),
          ...(kinds !== undefined ? { kinds } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(byMe ? { byMe } : {}),
          ...(maxChars !== undefined ? { maxChars } : {}),
        }),
      { format: dump(CHANGES_SINCE_RESPONSE, "changes_since") },
    );
  },
};

const ORDER_BYS: readonly ListOrderBy[] = ["updated_at", "created_at", "importance", "observed_at"];
const DIRECTIONS = ["asc", "desc"] as const;

const ORDER_BY: FlagSpec = {
  name: "order-by",
  type: "value",
  metavar: "[updated_at|created_at|importance|observed_at]",
  help: "Sort key (default updated_at; observed_at needs server v0.127.0+)",
};
const DIRECTION: FlagSpec = { name: "direction", type: "value", metavar: "[asc|desc]", help: "Default desc" };

const LIST_LIMIT: FlagSpec = {
  range: { min: 1, max: 100, rangeLabel: `${1}<=x<=${100}`, integer: true }, name: "limit", type: "value", metavar: "INTEGER", help: "Memories per page (default 50)" };

const list: Command = {
  summary: "List every memory of a context that matches exact filters (server v0.93.0+).",
  description:
    "  No ranking: a stable order and a total. Use `kagura-memory recall` to search\n" +
    "  by meaning. Page on with --cursor while has_more is true.\n\n" +
    examples(
      "list --filters '{\"type\": [\"tech-debt\"], \"tags\": [\"status:open\"]}'",
      "list --filters '{\"details.status\": \"open\"}' --order-by created_at",
      "list --order-by observed_at --direction asc --details",
    ),
  spec: {
    flags: [
      CONTEXT_ID,
      {
        name: "filters",
        type: "value",
        help: "Exact-match filters as a JSON object, e.g. '{\"type\": \"task\", \"details.status\": \"open\"}'",
      },
      ORDER_BY,
      DIRECTION,
      CURSOR,
      LIST_LIMIT,
      { name: "details", type: "switch", help: "Add each memory's details" },
      MAX_CHARS,
    ],
  },
  run: async (deps, args) => {
    const orderBy = choice(args, ORDER_BY, ORDER_BYS);
    const direction = choice(args, DIRECTION, DIRECTIONS);
    const limit = optionalRanged(args, LIST_LIMIT);
    const maxChars = optionalRanged(args, MAX_CHARS);
    rejectExtraArgs(args);
    const filters = parseJsonObject(args.values.filters, "--filters", "'{\"type\": \"task\"}'");
    const { cursor } = args.values;
    const includeDetails = args.flags.has("details");
    return runClientCommand(
      deps,
      args.values["context-id"],
      (client, contextId) => {
        // What Python's httpx refuses to encode, after the context is
        // resolved, rather than sent as `null`.
        if (filters !== undefined) refuseNonFinite([filters]);
        return client.listMatching({
          contextId,
          ...(filters !== undefined ? { filters } : {}),
          ...(orderBy !== undefined ? { orderBy } : {}),
          ...(direction !== undefined ? { direction } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(includeDetails ? { includeDetails } : {}),
          ...(maxChars !== undefined ? { maxChars } : {}),
        });
      },
      { format: dump(LIST_MATCHING_RESPONSE, "list") },
    );
  },
};

export const SESSION_COMMANDS: Record<string, Command> = { bootstrap, changes, list };

/**
 * Print one `<memory_id> <status> [<error>]` line per row on stderr — the
 * Python CLI's `_echo_forget_rows`, for a `forget --ids` that threw with
 * the per-id rows in its details (`batch_failed`), so the ids whose error
 * is `not_attempted` can be resent. Anything that is not a list of rows
 * prints nothing.
 */
function echoForgetRows(writeError: (line: string) => void, rows: unknown): void {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    // Python's `row.get(key)`: a missing key is None.
    let line = `${pyStr(row.memory_id ?? null)} ${pyStr(row.status ?? null)}`;
    if (pyTruthy(row.error)) line += ` ${pyStr(row.error)}`;
    writeError(line);
  }
}

/**
 * `forget --ids` once its flags are checked (`memory.ts`): one
 * `forget({ memoryIds })` call, its `ForgetBatchResult` printed as the
 * Python CLI prints it, and on a refusal that carries the per-id rows
 * (`batch_failed`) those rows on stderr before the error.
 */
export function runForgetByIds(deps: CommandDeps, contextIdFlag: string | undefined, ids: string[]): Promise<number> {
  return runClientCommand(
    deps,
    contextIdFlag,
    async (client, contextId) => {
      try {
        // The client checks the ids; its messages name `memory_ids` as the
        // Python CLI's do.
        return await client.forget(pythonOptionNames({ contextId, memoryIds: ids }));
      } catch (e) {
        // batch_failed: every id failed, and the rows say which to resend.
        if (e instanceof KaguraError) echoForgetRows(deps.writeError, e.details.results);
        throw e;
      }
    },
    { format: dump(FORGET_BATCH_RESULT, "forget") },
  );
}
