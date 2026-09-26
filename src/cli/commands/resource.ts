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

import { excMessage } from "../../errors.js";
import { emitProgress } from "../../progress.js";
import { pyBigInt, pyRepr } from "../../python.js";
import {
  examples,
  requireArg,
  rejectExtraArgs,
  type Command,
  type CommandDeps,
  type CommandGroup,
} from "../command.js";
import { resolveCliAuth } from "../credentialSource.js";
import { cliErrorMessage, formatJson } from "../output.js";
import {
  CliError,
  CliUsageError,
  paramLabel,
  parseChoice,
  parseFloatOption,
  parseIdArg,
  parseIntOption,
  parseRanged,
  pathIdParam,
  quote,
} from "../parse.js";
import type { FlagSpec, ParsedArgs } from "../parseArgs.js";
import { parseProgress, PROGRESS_FLAG, resolveProgress, VERBOSE_FLAG } from "../progress.js";
import type { ResourceEventInput } from "../../resourceClient.js";
import {
  INDEXER_STATUS_RESPONSE,
  PAGINATED_RESOURCE_TOKENS_RESPONSE,
  readModel,
  RESOURCE_EVENT_BATCH_RESPONSE,
  RESOURCE_EVENT_RESPONSE,
  RESOURCE_EVENTS_LIST_RESPONSE,
  RESOURCE_IMPACT_RESPONSE,
  RESOURCE_LIST_RESPONSE,
  RESOURCE_SCHEMA_RESPONSE,
  RESOURCE_SETUP_RESPONSE,
  RESOURCE_TOKEN_CREATE_RESPONSE,
  RESOURCE_TOKEN_RESPONSE,
  type Model,
} from "../../pyModels.js";
import { formatModelJson } from "../modelDump.js";
import { resolveConfig } from "../runClientCommand.js";
import {
  detectFormat,
  EXTRA_CELLS,
  openImportInput,
  parseImportRows,
  pyStrAt,
  refuseNonFinite,
  type ImportInput,
} from "./importFormats.js";

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

/**
 * `-r/--resource-id` of a command that puts it in the REST path: refused
 * (exit 2) when it is `.`, `..` or empty (see {@link pathIdParam}).
 */
function resourceIdInPath(args: ParsedArgs): string {
  return pathIdParam(RESOURCE_ID, requiredValue(args, RESOURCE_ID), "resource id");
}

function optionalInt(args: ParsedArgs, flag: FlagSpec): number | undefined {
  const raw = args.values[flag.name];
  return raw === undefined ? undefined : parseIntOption(flag, raw);
}

/**
 * {@link runAndPrint} for a command whose Python counterpart echoes a line
 * of text rather than a JSON document (`Token revoked.`), with the same
 * failure mapping.
 */
async function runAndEcho(deps: CommandDeps, operation: () => Promise<string>): Promise<number> {
  let text: string;
  try {
    text = await operation();
  } catch (e) {
    throw e instanceof CliError || e instanceof CliUsageError ? e : new CliError(cliErrorMessage(e));
  }
  deps.write(text);
  return 0;
}

/**
 * Run a `ResourceClient` call and print its result as the Python CLI
 * prints it, `result.model_dump_json(indent=2)`: read through `model`,
 * whose refusal is Python's `KaguraResponseError` labelled `operation`
 * (`ResourceClient.list_tokens`), exit 1.
 */
async function runAndDump(
  deps: CommandDeps,
  model: Model,
  operation: string,
  call: () => Promise<unknown>,
): Promise<number> {
  return runAndEcho(deps, async () => formatModelJson(readModel(await call(), model, operation)));
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
  description: examples("resource tokens list", "resource tokens list --resource-id products"),
  spec: { flags: [{ ...RESOURCE_ID, required: false, help: "Filter by resource ID" }, LIMIT] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = args.values["resource-id"];
    const limit = optionalInt(args, LIMIT) ?? 50;
    const { config } = resolveConfig(deps, undefined, false);
    return runAndDump(deps, PAGINATED_RESOURCE_TOKENS_RESPONSE, "ResourceClient.list_tokens", () =>
      deps
        .makeResourceClient()
        .listTokens({ ...(resourceId !== undefined ? { resourceId } : {}), limit }),
    );
  },
};

const tokensCreate: Command = {
  summary: "Create a resource token.",
  description: examples(
    "resource tokens create -r products",
    'resource tokens create -r slack-messages -d "Slack integration" -q 5000',
  ),
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
    return runAndDump(deps, RESOURCE_TOKEN_CREATE_RESPONSE, "ResourceClient.create_token", () =>
      deps.makeResourceClient().createToken({
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
  description: examples('resource tokens update 42 -d "New description"', "resource tokens update 42 -q 2000"),
  spec: { flags: [DESCRIPTION, QUOTA] },
  run: async (deps, args) => {
    const tokenId = parseIdArg("TOKEN_ID", requireArg(args, 0, "TOKEN_ID"));
    rejectExtraArgs(args, 1);
    const description = args.values.description;
    const quotaEventsPerHour = optionalInt(args, QUOTA);
    if (description === undefined && quotaEventsPerHour === undefined) {
      // Python guards this; without it a shell typo that eats --quota sends
      // an empty PATCH and exits 0, so a script reads "updated".
      throw new CliError("At least --description or --quota is required");
    }
    const { config } = resolveConfig(deps, undefined, false);
    return runAndDump(deps, RESOURCE_TOKEN_RESPONSE, "ResourceClient.update_token", () =>
      deps.makeResourceClient().updateToken(tokenId, {
        ...(description !== undefined ? { description } : {}),
        ...(quotaEventsPerHour !== undefined ? { quotaEventsPerHour } : {}),
      }),
    );
  },
};

const tokensRevoke: Command = {
  summary: "Revoke (soft-delete) a resource token.",
  args: "TOKEN_ID",
  description: examples("resource tokens revoke 42"),
  spec: { flags: [] },
  run: async (deps, args) => {
    // `@click.argument("token_id", type=int)`: a usage error, not a 422,
    // and the id typed, however large, never a rounded neighbour.
    const tokenId = parseIdArg("TOKEN_ID", requireArg(args, 0, "TOKEN_ID"));
    rejectExtraArgs(args, 1);
    const { config } = resolveConfig(deps, undefined, false);
    // Python's line; revokeToken returns nothing to print.
    return runAndEcho(deps, async () => {
      await deps.makeResourceClient().revokeToken(tokenId);
      return "Token revoked.";
    });
  },
};

const TOKENS_GROUP: CommandGroup = {
  summary: "Manage resource tokens (CRUD).",
  commands: { list: tokensList, create: tokensCreate, update: tokensUpdate, revoke: tokensRevoke },
};

// ---------------------------------------------------------------------
// read-only inspection
// ---------------------------------------------------------------------

const resourceList: Command = {
  summary: "List all resources in the workspace (owner only).",
  description: examples("resource list"),
  spec: { flags: [] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const { config } = resolveConfig(deps, undefined, false);
    return runAndDump(deps, RESOURCE_LIST_RESPONSE, "ResourceClient.list_resources", () =>
      deps.makeResourceClient().listResources(),
    );
  },
};

const stats: Command = {
  summary: "Show resource impact statistics.",
  description: examples("resource stats -r products"),
  spec: { flags: [RESOURCE_ID] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = resourceIdInPath(args);
    const { config } = resolveConfig(deps, undefined, false);
    return runAndDump(deps, RESOURCE_IMPACT_RESPONSE, "ResourceClient.get_resource_impact", () =>
      deps.makeResourceClient().getResourceImpact(resourceId),
    );
  },
};

const indexerStatus: Command = {
  summary: "Show indexer state and recent ingest events for a resource.",
  description: examples("resource indexer-status -r products"),
  spec: { flags: [RESOURCE_ID] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = resourceIdInPath(args);
    const { config } = resolveConfig(deps, undefined, false);
    return runAndDump(deps, INDEXER_STATUS_RESPONSE, "ResourceClient.get_indexer_status", () =>
      deps.makeResourceClient().getIndexerStatus(resourceId),
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
  description: examples("resource schema -r products", "resource schema -r products -v 2"),
  spec: { flags: [RESOURCE_ID, SCHEMA_VERSION] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = resourceIdInPath(args);
    const version = optionalInt(args, SCHEMA_VERSION);
    const { config } = resolveConfig(deps, undefined, false);
    // getResourceSchema reads the route's 404 as "none registered": Python
    // prints this line for it, not `null`.
    return runAndEcho(deps, async () => {
      const result = await deps.makeResourceClient().getResourceSchema(resourceId, version);
      if (result === null) return "No schema registered for this resource.";
      return formatModelJson(readModel(result, RESOURCE_SCHEMA_RESPONSE, "ResourceClient.get_resource_schema"));
    });
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
  description: examples(
    "resource events products",
    "resource events products --op upsert --limit 20",
    "resource events products --since 2026-06-01T00:00:00Z",
    'resource events products --cursor "eyJ..."',
  ),
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
    const resourceId = pathIdParam("RESOURCE_ID", requireArg(args, 0, "RESOURCE_ID"), "resource id");
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
    return runAndDump(deps, RESOURCE_EVENTS_LIST_RESPONSE, "ResourceClient.list_resource_events", () =>
      deps.makeResourceClient().listResourceEvents(resourceId, {
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

/**
 * Printed to stderr when `resource setup` is given `--summary`. The flag is
 * still accepted so existing scripts keep working, but the server's
 * `setup_resource` has no summary and never had one, so it is not sent
 * (#47). Only the context's owner can set it afterwards.
 */
export const SETUP_SUMMARY_IGNORED_NOTE =
  "Note: --summary is ignored, since the server's setup_resource has no summary. " +
  "Set it after setup with `kagura-memory context update <context_id> --summary ...` " +
  "(context owner only).";

const SETUP_NAME: FlagSpec = {
  name: "name",
  short: "n",
  type: "value",
  help:
    "Context name (default: the resource id; lowercase letters, digits, hyphens, " +
    "underscores; max 100). Needed when a context of that name already exists",
};

const setup: Command = {
  summary: "One-shot resource setup: create context + set resource_id + create token.",
  description:
    "  Examples:\n" +
    "    kagura-memory resource setup -r products\n" +
    "    kagura-memory resource setup -r products -n product-catalog\n" +
    '    kagura-memory resource setup -r slack-messages -d "Slack sync" -q 5000',
  spec: {
    flags: [
      { ...RESOURCE_ID, help: "Resource identifier" },
      SETUP_NAME,
      {
        name: "summary",
        short: "s",
        type: "value",
        help: "Deprecated and ignored by the server; use `kagura-memory context update` after setup",
      },
      { ...DESCRIPTION, help: "Token description" },
      { ...QUOTA, help: "Events/hour (1-10000)", defaultLabel: "1000" },
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = requiredValue(args, RESOURCE_ID);
    // Sent as given, "" included, which the server refuses as it does in
    // Python; absent, setupResource names the context after the resource.
    const name = args.values.name;
    const description = args.values.description;
    const raw = args.values.quota;
    // Unlike `tokens create`, this one IS range-checked locally in Python.
    const quotaEventsPerHour =
      raw === undefined
        ? 1000
        : parseRanged(QUOTA, raw, { min: 1, max: 10000, rangeLabel: "1<=x<=10000", integer: true });
    // Once every option has been read, as click reads them before the
    // command runs, and before any config or client work, as in Python:
    // the note is printed even when that work then fails.
    if (args.values.summary !== undefined) {
      deps.writeError(SETUP_SUMMARY_IGNORED_NOTE);
    }
    const { config } = resolveConfig(deps, undefined, false);
    // Python's `ResourceSetupResponse` dump: its six fields, `warning` null
    // when the server leaves it out, and the tool result's `status` and
    // `message` dropped.
    return runAndDump(deps, RESOURCE_SETUP_RESPONSE, "ResourceClient.setup_resource", () =>
      deps.makeResourceClient().setupResource({
        resourceId,
        ...(name !== undefined ? { contextName: name } : {}),
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
  description: examples(
    "resource ingest -r products -k KEY --doc-id SKU-001 -p '{\"name\":\"Widget\",\"price\":9.99}'",
    "resource ingest -r products -k KEY --doc-id SKU-999 --op delete",
  ),
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
    const resourceId = resourceIdInPath(args);
    const apiKey = requiredValue(args, API_KEY);
    const docId = requiredValue(args, DOC_ID);
    const rawOp = args.values.op;
    const op = rawOp === undefined ? "upsert" : parseChoice(OP, rawOp, OPS);
    const version = optionalInt(args, VERSION);
    const payload = parsePayload(args.values.payload);
    const rawImportance = args.values.importance;
    // parseFloatOption, not Number.parseFloat: the latter yields NaN for
    // "abc", the NaN survives the `!== undefined` guard, and JSON.stringify
    // serializes it as null — so a typo would silently clear importance.
    const importance =
      rawImportance === undefined ? undefined : parseFloatOption(IMPORTANCE, rawImportance);

    const { config } = resolveConfig(deps, undefined, false);
    return runAndDump(deps, RESOURCE_EVENT_RESPONSE, "ResourceClient.ingest_event", () =>
      deps.makeResourceClient().ingestEvent(resourceId, apiKey, {
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
  description: examples("resource ingest-batch -r products -k KEY -f events.json"),
  spec: { flags: [RESOURCE_ID, API_KEY, { ...FILE, required: true }] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const resourceId = resourceIdInPath(args);
    const apiKey = requiredValue(args, API_KEY);
    const file = requiredValue(args, FILE);
    // `click.File("r")`, opened as `resource import --file` opens it: a
    // path that cannot be opened is click's `'<path>': <strerror>`.
    const input = openImportInput(file, deps.readStdin);
    let text: string;
    try {
      text = input.read();
    } finally {
      input.close();
    }
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
    return runAndDump(deps, RESOURCE_EVENT_BATCH_RESPONSE, "ResourceClient.ingest_events", () =>
      deps
        .makeResourceClient()
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

/** The server's per-request event cap; Python chunks at the same size. */
const BATCH_SIZE = 100;

const IMPORT_FORMATS = ["auto", "csv", "json", "jsonl"] as const;

/** Python declares `--file` and `--format` with no help, and shows no defaults. */
const IMPORT_FILE: FlagSpec = { name: "file", short: "f", type: "value", metavar: "FILENAME" };
const FORMAT: FlagSpec = { name: "format", type: "value", metavar: "[auto|csv|json|jsonl]" };
const IMPORT_VERSION: FlagSpec = { ...VERSION, help: "Version (>=1)" };

const importCmd: Command = {
  summary: "Import data from CSV, JSON, or JSONL file.",
  description:
    "  Auto-detects format from file extension, or specify --format.\n" +
    "  Each row/object becomes a resource event with op=upsert.\n\n" +
    "  Examples:\n" +
    "    kagura-memory resource import -r products -k TOKEN -f products.csv\n" +
    "    kagura-memory resource import -r products -k TOKEN -f data.jsonl\n" +
    "    cat items.json | kagura-memory resource import -r products -k TOKEN --format json",
  spec: {
    flags: [
      RESOURCE_ID,
      API_KEY,
      IMPORT_FILE,
      FORMAT,
      { name: "id-column", type: "value", help: "Column name to use as doc_id (default: row number)" },
      IMPORT_VERSION,
      VERBOSE_FLAG,
      PROGRESS_FLAG,
    ],
  },
  run: async (deps, args) => {
    // Click converts the options given first, then reports a required one
    // that is missing. `--file` is a `click.File("r")`, opened as it is
    // converted: a path that cannot be opened is a usage error even
    // before the format is looked at.
    const input = openImportInput(args.values.file ?? "-", deps.readStdin);
    try {
      return await importRows(deps, args, input);
    } finally {
      input.close();
    }
  },
};

/**
 * `-V`, click's `IntRange(min=1)`, which has no upper bound. A version past
 * 2^53 cannot be sent as the number it is (a JS number would round it), so
 * it is refused as too large, rather than as outside a range it is in.
 */
function parseImportVersion(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const version = parseRanged(IMPORT_VERSION, raw, {
    min: 1,
    max: Number.POSITIVE_INFINITY,
    rangeLabel: "x>=1",
    integer: true,
  });
  if (version > Number.MAX_SAFE_INTEGER) {
    const digits = String(pyBigInt(raw));
    throw new CliUsageError(
      `Invalid value for ${paramLabel(IMPORT_VERSION)}: ${digits} is too large for this CLI ` +
        `to send exactly (at most ${Number.MAX_SAFE_INTEGER}).`,
    );
  }
  return version;
}

async function importRows(deps: CommandDeps, args: ParsedArgs, input: ImportInput): Promise<number> {
  const format = parseChoice(FORMAT, args.values.format ?? "auto", IMPORT_FORMATS);
  const version = parseImportVersion(args.values.version);
  const progress = parseProgress(args);
  const resourceId = resourceIdInPath(args);
  const apiKey = requiredValue(args, API_KEY);
  rejectExtraArgs(args);

  // From here on every failure is Python's ClickException (exit 1). The
  // format first: stdin is not read when it cannot be detected.
  const resolved = format === "auto" ? detectFormat(input.name) : format;
  const rows = parseImportRows(input.read(), resolved);
  if (rows.length === 0) throw new CliError("No data found in input");

  // Python tests `if id_column:`, so `--id-column=` numbers the rows, as an
  // unset shell variable should.
  const idColumn = args.values["id-column"];
  const events_ = rows.map((row, index) => {
    // A CSV row's cells past the header, under Python's `None` key, which
    // a Keys listing shows.
    const extra = row[EXTRA_CELLS];
    let docId = String(index + 1);
    if (idColumn) {
      if (!Object.prototype.hasOwnProperty.call(row, idColumn)) {
        // In the order read: the rows list their keys as Python's dict does.
        const keys = [...Object.keys(row), ...(extra === undefined ? [] : [null])];
        throw new CliError(`Row ${index + 1}: column '${idColumn}' not found. Keys: ${pyRepr(keys)}`);
      }
      // Python's str() of the value, a number's from the digits read: two
      // ids past 2^53 would otherwise round to one doc_id and upsert one
      // row over the other.
      docId = pyStrAt(row, idColumn);
    }
    // The event model's bounds, which Python's pydantic enforces with a
    // traceback: refused here, before anything is sent.
    const length = Array.from(docId).length;
    if (length < 1 || length > 255) {
      throw new CliError(
        `Row ${index + 1}: doc_id from column '${idColumn}' must be 1-255 characters, got ${length}.`,
      );
    }
    if (extra !== undefined) {
      throw new CliError(`Row ${index + 1}: more fields than the header has columns.`);
    }
    return { docId, op: "upsert" as const, version, payload: row };
  });

  // The config, the credential and the client come before the first
  // progress event, as Python 0.41.1 emits `import_start` inside its
  // `op(client)` (python-sdk #285): a failure there is a plain error with no
  // stream at all, and from the start event on the stream ends with exactly
  // one success or error.
  const { config } = resolveConfig(deps, undefined, false);
  const onProgress = resolveProgress(args.counts.verbose ?? 0, progress, deps.writeError);
  const client = (() => {
    try {
      return deps.makeResourceClient(resolveCliAuth(deps, config));
    } catch (e) {
      throw e instanceof CliError || e instanceof CliUsageError ? e : new CliError(cliErrorMessage(e));
    }
  })();
  emitProgress(onProgress, {
    stage: "import_start",
    kind: "action",
    msg: "Importing events",
    detail: { desc: `${events_.length} event(s)` },
  });

  let created = 0;
  let failed = 0;
  const errors: unknown[] = [];
  try {
    // The endpoint takes 1-100 events; Python chunks at 100 and this must
    // too, or any import over 100 rows is rejected wholesale.
    const batchCount = Math.ceil(events_.length / BATCH_SIZE);
    for (let i = 0, n = 1; i < events_.length; i += BATCH_SIZE, n++) {
      const batch = events_.slice(i, i + BATCH_SIZE);
      emitProgress(onProgress, {
        stage: "import_batch",
        kind: "action",
        msg: "Ingesting batch",
        detail: { desc: `${n}/${batchCount} (${batch.length} event(s))` },
      });
      // Where Python's request encoding fails: after this batch's event,
      // and after the batches before it were sent.
      refuseNonFinite(batch.map((event) => event.payload));
      // No onProgress here: each call would end the stream with its own
      // terminal event, and the import is one operation with one.
      // Read as the Python SDK's model reads it: `failed_count` and `errors`
      // default, and a count sent as `"3"` adds 3, not the text "3".
      const result = readModel(
        await client.ingestEvents(resourceId, apiKey, batch),
        RESOURCE_EVENT_BATCH_RESPONSE,
        "ResourceClient.ingest_events",
      );
      created += Number(result.created_count);
      failed += Number(result.failed_count);
      // Python keeps the first five errors per batch and prints ten in
      // total; a full dump of a bad 10k-row file is unreadable.
      errors.push(...(result.errors as unknown[]).slice(0, 5));
    }
  } catch (e) {
    emitProgress(onProgress, {
      stage: "complete",
      kind: "error",
      msg: `Import failed: ${excMessage(e)}`,
      detail: { created_so_far: created, failed_so_far: failed, total_events: events_.length },
    });
    throw e instanceof CliError || e instanceof CliUsageError ? e : new CliError(cliErrorMessage(e));
  }
  emitProgress(onProgress, {
    stage: "complete",
    kind: "success",
    msg: "Import complete",
    detail: { created, failed, total: events_.length },
  });
  // One aggregate for the whole import, matching Python's shape — a
  // per-batch array would make a script parse a different result for 99
  // rows than for 101.
  const output: Record<string, unknown> = { created, failed, total: events_.length };
  if (errors.length > 0) output.errors = errors.slice(0, 10);
  deps.write(formatJson(output));
  return 0;
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
