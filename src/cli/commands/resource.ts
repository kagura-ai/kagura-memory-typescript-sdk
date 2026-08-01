/**
 * `kagura-memory resource …` — resource tokens and external-data ingest.
 *
 * The largest group, and the one with the most flag traps. Three worth
 * naming, all of them pinned by tests:
 *
 *   - `-V` (capital) is `--version` on `ingest`, `events` and `import`,
 *     while `-v` (lowercase) is `--version` on `schema` but `--verbose`
 *     on `import`. Same letter, three meanings.
 *   - `-c` is `--cursor` on `events`, NOT `--context-id`.
 *   - `events` takes RESOURCE_ID positionally; every other command in the
 *     group takes `-r/--resource-id`.
 */

import * as fs from "node:fs";

import { requireArg, rejectExtraArgs, type Command, type CommandGroup } from "../command.js";
import { CliUsageError, parseChoice, parseIntOption, parseRanged, quote } from "../parse.js";
import type { FlagSpec, ParsedArgs } from "../parseArgs.js";
import type { ResourceEventInput } from "../../resourceClient.js";
import { resolveConfig, restOptions, runAndPrint } from "../runClientCommand.js";
import { parseRecords } from "./importFormats.js";

const RESOURCE_ID: FlagSpec = {
  name: "resource-id",
  short: "r",
  type: "value",
  required: true,
  help: "Resource ID",
};
const API_KEY: FlagSpec = {
  name: "api-key",
  short: "k",
  type: "value",
  required: true,
  help: "Resource API key",
};
/** Capital V. Lowercase `-v` means something else on these commands. */
const VERSION: FlagSpec = {
  name: "version",
  short: "V",
  type: "value",
  metavar: "INTEGER",
  help: "Document version",
};
const OP: FlagSpec = { name: "op", type: "value", metavar: "[upsert|delete]", help: "Operation" };

const OPS = ["upsert", "delete"] as const;

function requiredValue(args: ParsedArgs, flag: FlagSpec): string {
  const value = args.values[flag.name];
  if (value === undefined) {
    throw new CliUsageError(
      `Missing option '--${flag.name}'${flag.short === undefined ? "" : ` / '-${flag.short}'`}.`,
    );
  }
  return value;
}

function optionalInt(args: ParsedArgs, flag: FlagSpec): number | undefined {
  const raw = args.values[flag.name];
  return raw === undefined ? undefined : parseIntOption(flag, raw);
}

// ---------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------

const DESCRIPTION: FlagSpec = { name: "description", short: "d", type: "value", help: "Description" };
const QUOTA: FlagSpec = {
  name: "quota",
  short: "q",
  type: "value",
  metavar: "INTEGER",
  help: "Events per hour (1-10000)",
};
const LIMIT: FlagSpec = {
  name: "limit",
  short: "l",
  type: "value",
  metavar: "INTEGER",
  help: "Results per page (max 100)",
  defaultLabel: "50",
};

const tokensList: Command = {
  summary: "List resource tokens.",
  spec: { flags: [{ ...RESOURCE_ID, required: false, help: "Filter by resource ID" }, LIMIT] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = args.values["resource-id"];
    const limit = optionalInt(args, LIMIT) ?? 50;
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () =>
      deps
        .makeResourceClient(restOptions(config))
        .listTokens({ ...(resourceId !== undefined ? { resourceId } : {}), limit }),
    );
  },
};

const tokensCreate: Command = {
  summary: "Create a resource token.",
  spec: {
    flags: [
      { ...RESOURCE_ID, help: "Resource ID to scope the token to" },
      DESCRIPTION,
      { ...QUOTA, defaultLabel: "1000" },
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = requiredValue(args, RESOURCE_ID);
    const description = args.values.description;
    // Plain `type=int` in Python — the 1-10000 bound is pydantic's, on the
    // server side, so an out-of-range value must still be sent.
    const quotaEventsPerHour = optionalInt(args, QUOTA) ?? 1000;
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () =>
      deps.makeResourceClient(restOptions(config)).createToken({
        resourceId,
        ...(description !== undefined ? { description } : {}),
        quotaEventsPerHour,
      }),
    );
  },
};

const tokensUpdate: Command = {
  summary: "Update a resource token.",
  args: "TOKEN_ID",
  spec: { flags: [DESCRIPTION, QUOTA] },
  run: async (deps, args) => {
    const tokenId = parseTokenId(requireArg(args, 0, "TOKEN_ID"));
    rejectExtraArgs(args, 1);
    const description = args.values.description;
    const quotaEventsPerHour = optionalInt(args, QUOTA);
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () =>
      deps.makeResourceClient(restOptions(config)).updateToken(tokenId, {
        ...(description !== undefined ? { description } : {}),
        ...(quotaEventsPerHour !== undefined ? { quotaEventsPerHour } : {}),
      }),
    );
  },
};

const tokensRevoke: Command = {
  summary: "Revoke (soft-delete) a resource token.",
  args: "TOKEN_ID",
  spec: { flags: [] },
  run: async (deps, args) => {
    const tokenId = parseTokenId(requireArg(args, 0, "TOKEN_ID"));
    rejectExtraArgs(args, 1);
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, async () => {
      await deps.makeResourceClient(restOptions(config)).revokeToken(tokenId);
      return { status: "success", token_id: tokenId };
    });
  },
};

/** `@click.argument("token_id", type=int)` — a usage error, not a 422. */
function parseTokenId(raw: string): number {
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    throw new CliUsageError(`Invalid value for 'TOKEN_ID': ${quote(raw)} is not a valid integer.`);
  }
  return Number(raw.trim());
}

const TOKENS_GROUP: CommandGroup = {
  summary: "Manage resource tokens (CRUD).",
  commands: { list: tokensList, create: tokensCreate, update: tokensUpdate, revoke: tokensRevoke },
};

// ---------------------------------------------------------------------
// read-only inspection
// ---------------------------------------------------------------------

const resourceList: Command = {
  summary: "List all resources in the workspace (owner only).",
  spec: { flags: [] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () => deps.makeResourceClient(restOptions(config)).listResources());
  },
};

const stats: Command = {
  summary: "Show resource impact statistics.",
  spec: { flags: [RESOURCE_ID] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = requiredValue(args, RESOURCE_ID);
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () =>
      deps.makeResourceClient(restOptions(config)).getResourceImpact(resourceId),
    );
  },
};

const indexerStatus: Command = {
  summary: "Show indexer state and recent ingest events for a resource.",
  spec: { flags: [RESOURCE_ID] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = requiredValue(args, RESOURCE_ID);
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () =>
      deps.makeResourceClient(restOptions(config)).getIndexerStatus(resourceId),
    );
  },
};

/** Lowercase `-v` here means the *schema* version, not verbosity. */
const SCHEMA_VERSION: FlagSpec = {
  name: "version",
  short: "v",
  type: "value",
  metavar: "INTEGER",
  help: "Schema version",
};

const schema: Command = {
  summary: "Show resource field definitions (schema).",
  spec: { flags: [RESOURCE_ID, SCHEMA_VERSION] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = requiredValue(args, RESOURCE_ID);
    const version = optionalInt(args, SCHEMA_VERSION);
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () =>
      deps.makeResourceClient(restOptions(config)).getResourceSchema(resourceId, version),
    );
  },
};

const EVENTS_LIMIT: FlagSpec = {
  name: "limit",
  short: "l",
  type: "value",
  metavar: "INTEGER",
  help: "Max events (1-100)",
  defaultLabel: "50",
};

const events: Command = {
  summary: "List ingested events for a resource (cursor-paginated).",
  args: "RESOURCE_ID",
  spec: {
    flags: [
      EVENTS_LIMIT,
      // `-c` is the CURSOR here, not a context id.
      { name: "cursor", short: "c", type: "value", help: "Pagination cursor from a prior next_cursor" },
      OP,
      { name: "doc-id", type: "value", help: "Filter by document ID" },
      VERSION,
      { name: "since", type: "value", help: "ISO 8601 instant, e.g. 2026-06-01T00:00:00Z" },
    ],
  },
  run: async (deps, args) => {
    const resourceId = requireArg(args, 0, "RESOURCE_ID");
    rejectExtraArgs(args, 1);
    const raw = args.values.limit;
    const limit =
      raw === undefined
        ? 50
        : parseRanged(EVENTS_LIMIT, raw, { min: 1, max: 100, rangeLabel: "1<=x<=100", integer: true });
    const cursor = args.values.cursor;
    const rawOp = args.values.op;
    const op = rawOp === undefined ? undefined : parseChoice(OP, rawOp, OPS);
    const docId = args.values["doc-id"];
    const version = optionalInt(args, VERSION);
    const since = parseSince(args.values.since);

    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () =>
      deps.makeResourceClient(restOptions(config)).listResourceEvents(resourceId, {
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(op !== undefined ? { op } : {}),
        ...(docId !== undefined ? { docId } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(since !== undefined ? { since } : {}),
      }),
    );
  },
};

/**
 * Validate `--since` locally.
 *
 * Python parses it with `datetime.fromisoformat` at command scope, so a
 * malformed value fails before any request. `new Date("garbage")` yields
 * an Invalid Date that would serialize to null and silently drop the
 * filter — returning everything instead of erroring.
 */
function parseSince(raw: string | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new CliUsageError(`Invalid value for '--since': ${quote(raw)} is not a valid ISO 8601 instant.`);
  }
  return parsed;
}

// ---------------------------------------------------------------------
// setup + ingest
// ---------------------------------------------------------------------

const setup: Command = {
  summary: "One-shot resource setup: create context + token.",
  spec: {
    flags: [
      { ...RESOURCE_ID, help: "Resource identifier" },
      { name: "summary", short: "s", type: "value", help: "Context summary" },
      { ...DESCRIPTION, help: "Token description" },
      { ...QUOTA, help: "Events/hour (1-10000)", defaultLabel: "1000" },
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = requiredValue(args, RESOURCE_ID);
    const summary = args.values.summary;
    const description = args.values.description;
    const raw = args.values.quota;
    // Unlike `tokens create`, this one IS range-checked locally in Python.
    const quotaEventsPerHour =
      raw === undefined
        ? 1000
        : parseRanged(QUOTA, raw, { min: 1, max: 10000, rangeLabel: "1<=x<=10000", integer: true });
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () =>
      deps.makeResourceClient(restOptions(config)).setupResource({
        resourceId,
        ...(summary !== undefined ? { summary } : {}),
        ...(description !== undefined ? { description } : {}),
        quotaEventsPerHour,
      }),
    );
  },
};

const DOC_ID: FlagSpec = { name: "doc-id", type: "value", required: true, help: "Document ID" };
const PAYLOAD: FlagSpec = { name: "payload", short: "p", type: "value", help: "JSON payload object" };
const IMPORTANCE: FlagSpec = {
  name: "importance",
  short: "i",
  type: "value",
  metavar: "FLOAT",
  help: "Importance 0.0-1.0",
};

const ingest: Command = {
  summary: "Ingest a single resource event.",
  spec: {
    flags: [
      RESOURCE_ID,
      API_KEY,
      DOC_ID,
      { ...OP, defaultLabel: "upsert" },
      VERSION,
      PAYLOAD,
      IMPORTANCE,
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = requiredValue(args, RESOURCE_ID);
    const apiKey = requiredValue(args, API_KEY);
    const docId = requiredValue(args, DOC_ID);
    const rawOp = args.values.op;
    const op = rawOp === undefined ? "upsert" : parseChoice(OP, rawOp, OPS);
    const version = optionalInt(args, VERSION);
    const payload = parsePayload(args.values.payload);
    const rawImportance = args.values.importance;
    const importance =
      rawImportance === undefined ? undefined : Number.parseFloat(rawImportance);

    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () =>
      deps.makeResourceClient(restOptions(config)).ingestEvent(resourceId, apiKey, {
        docId,
        op,
        ...(version !== undefined ? { version } : {}),
        ...(payload !== undefined ? { payload } : {}),
        ...(importance !== undefined ? { importance } : {}),
      }),
    );
  },
};

/** `-p` must parse to a JSON *object*; an array is a usage error. */
function parsePayload(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CliUsageError(
      `Invalid value for '--payload' / '-p': ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError("--payload must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

const FILE: FlagSpec = {
  name: "file",
  short: "f",
  type: "value",
  metavar: "FILENAME",
  help: "File containing a JSON array of event objects",
};

const ingestBatch: Command = {
  summary: "Ingest a batch of resource events from a JSON file.",
  spec: { flags: [RESOURCE_ID, API_KEY, { ...FILE, required: true }] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = requiredValue(args, RESOURCE_ID);
    const apiKey = requiredValue(args, API_KEY);
    const file = requiredValue(args, FILE);
    const text = readInput(file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new CliUsageError(`Invalid JSON in ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new CliUsageError(`${file} must contain a JSON array of event objects.`);
    }
    const events_ = parsed as Record<string, unknown>[];
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () =>
      deps
        .makeResourceClient(restOptions(config))
        .ingestEvents(resourceId, apiKey, events_.map(toEventInput)),
    );
  },
};

/** Accept the wire (snake_case) shape a batch file naturally carries. */
function toEventInput(row: Record<string, unknown>): ResourceEventInput {
  const docId = (row.doc_id ?? row.docId) as string;
  const op = (row.op ?? "upsert") as "upsert" | "delete";
  const version = (row.version ?? undefined) as number | undefined;
  const payload = (row.payload ?? undefined) as Record<string, unknown> | undefined;
  const importance = (row.importance ?? undefined) as number | undefined;
  return {
    docId,
    op,
    ...(version !== undefined ? { version } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(importance !== undefined ? { importance } : {}),
  };
}

const FORMAT: FlagSpec = {
  name: "format",
  type: "value",
  metavar: "[auto|csv|json|jsonl]",
  help: "Input format",
  defaultLabel: "auto",
};

const importCmd: Command = {
  summary: "Import data from CSV, JSON, or JSONL file.",
  spec: {
    flags: [
      RESOURCE_ID,
      API_KEY,
      { ...FILE, help: "Input file, or - for stdin", defaultLabel: "-" },
      FORMAT,
      { name: "id-column", type: "value", help: "Column whose value becomes doc_id" },
      { ...VERSION, help: "Document version (>=1)", defaultLabel: "1" },
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = requiredValue(args, RESOURCE_ID);
    const apiKey = requiredValue(args, API_KEY);
    const file = args.values.file ?? "-";
    const rawFormat = args.values.format ?? "auto";
    // click.Choice here is case-SENSITIVE, unlike --progress elsewhere.
    if (!["auto", "csv", "json", "jsonl"].includes(rawFormat)) {
      throw new CliUsageError(
        `Invalid value for '--format': ${quote(rawFormat)} is not one of 'auto', 'csv', 'json', 'jsonl'.`,
      );
    }
    const idColumn = args.values["id-column"];
    const rawVersion = args.values.version;
    const version =
      rawVersion === undefined
        ? 1
        : parseRanged(VERSION, rawVersion, {
            min: 1,
            max: Number.MAX_SAFE_INTEGER,
            rangeLabel: "x>=1",
            integer: true,
          });

    const text = readInput(file);
    const rows = parseRecords(text, rawFormat as "auto" | "csv" | "json" | "jsonl", file);
    const events_ = rows.map((row, index) => ({
      // Python falls back to the 1-based row number as a string.
      docId: idColumn === undefined ? String(index + 1) : String(row[idColumn] ?? index + 1),
      op: "upsert" as const,
      version,
      payload: row,
    }));

    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () =>
      deps.makeResourceClient(restOptions(config)).ingestEvents(resourceId, apiKey, events_),
    );
  },
};

/** Read a `click.File("r")` argument, where `-` means stdin. */
function readInput(file: string): string {
  try {
    return fs.readFileSync(file === "-" ? 0 : file, "utf-8");
  } catch (e) {
    throw new CliUsageError(
      `Invalid value for '--file' / '-f': ${quote(file)}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export const RESOURCE_GROUP: CommandGroup = {
  summary: "Manage resource tokens and ingest external data.",
  commands: {
    tokens: TOKENS_GROUP,
    list: resourceList,
    stats,
    "indexer-status": indexerStatus,
    schema,
    events,
    setup,
    ingest,
    "ingest-batch": ingestBatch,
    import: importCmd,
  },
};
