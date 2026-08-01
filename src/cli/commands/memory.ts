/**
 * The direct MCP tool commands — `remember`, `recall`, `reference`,
 * `forget`, `update-memory` and `explore`.
 *
 * Ported flag-for-flag from the Python CLI's `cli.py`. Two details are
 * easy to get wrong and are pinned by tests:
 *
 *   - `-k` has no `--k` long form, and its default differs between
 *     `recall` (5) and `forget` (10);
 *   - `remember` always sends `type` and `importance` (they have
 *     defaults) while `update-memory` sends neither unless asked, because
 *     an omitted field there means "leave unchanged".
 */

import type { SourceType } from "../../client.js";
import { requireArg, requireOption, rejectExtraArgs, type Command } from "../command.js";
import {
  CliError,
  CliUsageError,
  buildDetails,
  parseFloatOption,
  parseIntOption,
  parseTags,
  quote,
} from "../parse.js";
import type { FlagSpec, ParsedArgs } from "../parseArgs.js";
import { runClientCommand } from "../runClientCommand.js";

const CONTEXT_ID: FlagSpec = {
  name: "context-id",
  short: "c",
  type: "value",
  help: "Context ID (or set in .kagura.json)",
};

const SUMMARY: FlagSpec = {
  name: "summary",
  short: "s",
  type: "value",
  help: "Memory summary (for search)",
};
const CONTENT: FlagSpec = { name: "content", type: "value", help: "Memory content (full text)" };
const TYPE: FlagSpec = { name: "type", short: "t", type: "value", help: "Memory type" };
const IMPORTANCE: FlagSpec = {
  name: "importance",
  short: "i",
  type: "value",
  metavar: "FLOAT",
  help: "Importance 0.0-1.0",
};
const TAGS: FlagSpec = {
  name: "tags",
  type: "value",
  help: "Comma-separated tags (e.g., 'python,fastapi')",
};
const MEMORY_ID: FlagSpec = { name: "memory-id", short: "m", type: "value" };

/** `-k` is short-only in Python; see FlagSpec.shortOnly. */
const kFlag = (help: string, defaultLabel: string): FlagSpec => ({
  name: "k",
  short: "k",
  shortOnly: true,
  type: "value",
  metavar: "INTEGER",
  help,
  defaultLabel,
});

const SOURCE_TYPES: readonly SourceType[] = ["file", "url", "vault", "api", "manual"];

/**
 * `click.Choice(..., case_sensitive=False)` — match case-insensitively but
 * send the canonical lowercase value.
 */
function parseSourceType(raw: string | undefined): SourceType | undefined {
  if (raw === undefined) return undefined;
  const match = SOURCE_TYPES.find((t) => t === raw.toLowerCase());
  if (match === undefined) {
    throw new CliUsageError(
      `Invalid value for '--source-type': ${quote(raw)} is not one of ${SOURCE_TYPES.map(quote).join(", ")}.`,
    );
  }
  return match;
}

/** Read a `type=float` option, or undefined when it was not passed. */
function optionalFloat(args: ParsedArgs, flag: FlagSpec): number | undefined {
  const raw = args.values[flag.name];
  return raw === undefined ? undefined : parseFloatOption(flag, raw);
}

/** Read a `type=int` option, falling back to the Python default. */
function intOr(args: ParsedArgs, flag: FlagSpec, fallback: number): number {
  const raw = args.values[flag.name];
  return raw === undefined ? fallback : parseIntOption(flag, raw);
}

const remember: Command = {
  summary: "Store a memory directly (without AI analysis).",
  spec: {
    flags: [
      CONTEXT_ID,
      { ...SUMMARY, required: true },
      { ...CONTENT, required: true },
      { ...TYPE, defaultLabel: "note" },
      { ...IMPORTANCE, defaultLabel: "0.5" },
      TAGS,
      {
        name: "source-uri",
        type: "value",
        help: "Origin URI (e.g., file:///path/to/note.md, vault://my-vault/note)",
      },
      {
        name: "source-type",
        type: "value",
        metavar: "[file|url|vault|api|manual]",
        help: "Origin classification. Opt-in: omitted means no provenance is stamped.",
      },
      {
        name: "linked-memory-ids",
        type: "value",
        help: "Comma-separated memory UUIDs to link via declared_link edges",
      },
      {
        name: "linked-source-uris",
        type: "value",
        help: "Comma-separated source URIs to resolve to memories and link",
      },
      {
        name: "details",
        type: "value",
        help: "Structured details as an inline JSON object",
      },
      {
        name: "location",
        type: "value",
        help: "Shorthand for details.location: 'lat,lon' or 'lat,lon,label'",
      },
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const summary = requireOption(args, SUMMARY);
    const content = requireOption(args, CONTENT);
    const details = buildDetails(args.values.details, args.values.location);
    const tags = parseTags(args.values.tags);
    const linkedMemoryIds = parseTags(args.values["linked-memory-ids"]);
    const linkedSourceUris = parseTags(args.values["linked-source-uris"]);
    const sourceType = parseSourceType(args.values["source-type"]);
    const sourceUri = args.values["source-uri"];
    // Defaults are applied here, not left to the client, because Python
    // declares them on the option and therefore always sends them.
    const type = args.values.type ?? "note";
    const importance = optionalFloat(args, IMPORTANCE) ?? 0.5;

    return runClientCommand(deps, args.values["context-id"], (client, contextId) =>
      client.remember({
        contextId,
        summary,
        content,
        type,
        importance,
        ...(tags ? { tags } : {}),
        ...(sourceUri !== undefined ? { sourceUri } : {}),
        ...(sourceType !== undefined ? { sourceType } : {}),
        ...(linkedMemoryIds ? { linkedMemoryIds } : {}),
        ...(linkedSourceUris ? { linkedSourceUris } : {}),
        ...(details !== undefined ? { details } : {}),
      }),
    );
  },
};

const RECALL_K = kFlag("Number of results", "5");

const recall: Command = {
  summary: "Search memories directly (without AI analysis).",
  args: "QUERY",
  spec: { flags: [CONTEXT_ID, RECALL_K] },
  run: async (deps, args) => {
    const query = requireArg(args, 0, "QUERY");
    rejectExtraArgs(args, 1);
    const k = intOr(args, RECALL_K, 5);
    return runClientCommand(deps, args.values["context-id"], (client, contextId) =>
      client.recall({ contextId, query, k }),
    );
  },
};

const reference: Command = {
  summary: "Get full details of a specific memory.",
  spec: {
    flags: [CONTEXT_ID, { ...MEMORY_ID, required: true, help: "Memory ID to get full details" }],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const memoryId = requireOption(args, MEMORY_ID);
    return runClientCommand(deps, args.values["context-id"], (client, contextId) =>
      client.reference({ contextId, memoryId }),
    );
  },
};

const FORGET_K = kFlag("Max memories to delete in query mode", "10");

const forget: Command = {
  summary: "Delete memories (soft delete, recoverable for 30 days).",
  spec: {
    flags: [
      CONTEXT_ID,
      { ...MEMORY_ID, help: "Memory ID to delete (specific deletion)" },
      { name: "query", short: "q", type: "value", help: "Query to find memories to delete (bulk deletion)" },
      FORGET_K,
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const memoryId = args.values["memory-id"];
    const query = args.values.query;
    if (!memoryId && !query) {
      // ClickException, not UsageError: exit 1, matching Python.
      throw new CliError("Either --memory-id or --query is required");
    }
    const k = intOr(args, FORGET_K, 10);
    return runClientCommand(deps, args.values["context-id"], (client, contextId) =>
      client.forget({
        contextId,
        ...(memoryId !== undefined ? { memoryId } : {}),
        ...(query !== undefined ? { query } : {}),
        k,
      }),
    );
  },
};

const updateMemory: Command = {
  summary: "Update an existing memory or upsert by external ID.",
  spec: {
    flags: [
      CONTEXT_ID,
      { ...MEMORY_ID, help: "Memory UUID to update in-place" },
      { name: "external-id", type: "value", help: "External ID for upsert lookup" },
      { ...SUMMARY, help: "Updated summary" },
      { ...CONTENT, help: "Updated content" },
      { ...TYPE, help: "Updated memory type" },
      { ...IMPORTANCE, help: "Updated importance 0.0-1.0" },
      { ...TAGS, help: "Comma-separated tags" },
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const memoryId = args.values["memory-id"];
    const externalId = args.values["external-id"];
    if (!memoryId && !externalId) {
      throw new CliError("Either --memory-id or --external-id is required");
    }
    if (memoryId && externalId) {
      throw new CliError("Provide only one of --memory-id or --external-id");
    }
    const summary = args.values.summary;
    const content = args.values.content;
    const type = args.values.type;
    const importance = optionalFloat(args, IMPORTANCE);
    const tags = parseTags(args.values.tags);

    return runClientCommand(deps, args.values["context-id"], (client, contextId) =>
      client.updateMemory({
        contextId,
        // Every field is omitted unless given: an absent key means "leave
        // unchanged", so forwarding undefined defaults would silently
        // overwrite the stored value.
        ...(memoryId !== undefined ? { memoryId } : {}),
        ...(externalId !== undefined ? { externalId } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(importance !== undefined ? { importance } : {}),
        ...(tags ? { tags } : {}),
      }),
    );
  },
};

const DEPTH: FlagSpec = {
  name: "depth",
  short: "d",
  type: "value",
  metavar: "INTEGER",
  help: "Traversal depth 1-5",
  defaultLabel: "2",
};
const MIN_WEIGHT: FlagSpec = {
  name: "min-weight",
  short: "w",
  type: "value",
  metavar: "FLOAT",
  help: "Min edge weight",
  defaultLabel: "0.05",
};

const explore: Command = {
  summary: "Explore related memories via Neural Memory graph.",
  spec: {
    flags: [
      CONTEXT_ID,
      { ...MEMORY_ID, required: true, help: "Seed memory ID to explore from" },
      DEPTH,
      MIN_WEIGHT,
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const memoryId = requireOption(args, MEMORY_ID);
    // The documented 1-5 range is not enforced locally in Python either —
    // plain `type=int`, so the server is what rejects an absurd depth.
    const depth = intOr(args, DEPTH, 2);
    const minWeight = optionalFloat(args, MIN_WEIGHT) ?? 0.05;
    return runClientCommand(deps, args.values["context-id"], (client, contextId) =>
      client.explore({ contextId, memoryId, depth, minWeight }),
    );
  },
};

export const MEMORY_COMMANDS: Record<string, Command> = {
  remember,
  recall,
  reference,
  forget,
  "update-memory": updateMemory,
  explore,
};
