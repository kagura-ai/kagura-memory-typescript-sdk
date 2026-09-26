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

import type { KaguraClient, SourceType } from "../../client.js";
import { pyTruthy } from "../../python.js";
import { requireArg, requireOption, rejectExtraArgs, type Command } from "../command.js";
import {
  CliError,
  buildDetails,
  pairedFlag,
  parseChoice,
  parseFloatOption,
  parseIntOption,
  parseTags,
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

const SOURCE_TYPE: FlagSpec = {
  name: "source-type",
  type: "value",
  metavar: "[file|url|vault|api|manual]",
  help: "Origin classification. Opt-in: omitted means no provenance is stamped.",
};

/**
 * `click.Choice(..., case_sensitive=False)`: matched as click matches it,
 * casefolded (`FILE`, and the `ﬁ` ligature of `ﬁle`), sending the
 * canonical lowercase value.
 */
function parseSourceType(raw: string | undefined): SourceType | undefined {
  if (raw === undefined) return undefined;
  return parseChoice(SOURCE_TYPE, raw, SOURCE_TYPES, { caseInsensitive: true });
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
  description:
    "  Coordinates in --details must be JSON numbers, not strings: the server\n" +
    "  rejects string-typed lat/lon with a 422 by design. Updating a memory\n" +
    "  replaces details wholesale; `kagura-memory update-memory --merge-details`\n" +
    "  revises location while keeping the other keys (or re-send them yourself).\n\n" +
    "  Examples:\n" +
    '    kagura-memory remember -s "FastAPI DI pattern" --content "Use Depends()..."\n' +
    '    kagura-memory remember -c dev -s "OAuth2 setup" --content "..." --tags "auth,oauth"\n' +
    '    kagura-memory remember -s "Spec" --content "$(cat spec.md)" \\\n' +
    "      --source-uri file:///spec.md --source-type file\n" +
    '    kagura-memory remember -s "Coffee with Sato" --content "..." \\\n' +
    '      --location "35.68,139.76,Tokyo HQ"',
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
      SOURCE_TYPE,
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
        help:
          "Structured details as an inline JSON object. Coordinates live under the 'location' key " +
          "and must be JSON numbers, not strings: '{\"location\": {\"lat\": 35.68, \"lon\": 139.76}}'",
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
  description:
    "  Without --rerank/--no-rerank the server follows the context's search\n" +
    "  config (memory-cloud v0.69.0+). --rerank applies only when the context\n" +
    "  enables reranking; --no-rerank always skips it.\n\n" +
    "  Examples:\n" +
    '    kagura-memory recall "FastAPI dependency injection"\n' +
    '    kagura-memory recall "OAuth2 implementation" -k 10\n' +
    '    kagura-memory recall -c dev "error handling pattern"\n' +
    '    kagura-memory recall "latency-sensitive lookup" --no-rerank\n' +
    '    kagura-memory recall "project context" --trusted-only',
  spec: {
    flags: [
      CONTEXT_ID,
      RECALL_K,
      // Python's `--rerank/--no-rerank` is one option with `default=None`;
      // here it is two switches resolved by `pairedFlag`, which keeps
      // "neither" (no use_rerank key) apart from an explicit false.
      {
        name: "rerank",
        type: "switch",
        help: "Request reranking for this call (default: follow the context's search config)",
      },
      { name: "no-rerank", type: "switch", help: "Skip reranking for this call" },
      // Python added this for its SessionStart hook. This bin installs no
      // hooks, but the flag is mirrored so the two CLIs take the same argv,
      // and its help is Python's: a hook of the user's own is the same case.
      {
        name: "trusted-only",
        type: "switch",
        help:
          "Exclude external / connector-ingested memories (filters.trust_tier=trusted; " +
          "server v0.24.0+). Use it for reads fed back to an agent, like the SessionStart hook.",
      },
    ],
  },
  run: async (deps, args) => {
    const query = requireArg(args, 0, "QUERY");
    rejectExtraArgs(args, 1);
    const k = intOr(args, RECALL_K, 5);
    // click takes the last of the pair; like `context search-config`, this
    // refuses both rather than depend on argv order.
    const useRerank = pairedFlag(args.flags.has("rerank"), args.flags.has("no-rerank"), [
      "--rerank",
      "--no-rerank",
    ]);
    const trustedOnly = args.flags.has("trusted-only");
    return runClientCommand(deps, args.values["context-id"], (client, contextId) =>
      client.recall({
        contextId,
        query,
        k,
        ...(useRerank !== undefined ? { useRerank } : {}),
        ...(trustedOnly ? { filters: { trust_tier: "trusted" } } : {}),
      }),
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
  summary: "Delete memories (soft delete; kept until the server's retention window passes, default 30 days).",
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
    // Converted first, as click does `type=int`: a bad -k exits 2 even
    // when neither --memory-id nor --query was given.
    const k = intOr(args, FORGET_K, 10);
    if (!memoryId && !query) {
      // ClickException, not UsageError: exit 1, matching Python.
      throw new CliError("Either --memory-id or --query is required");
    }
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

/**
 * `update-memory --details`, with Python 0.42.0's help (python-sdk #247):
 * without --merge-details the payload replaces the memory's details.
 */
const UPDATE_DETAILS: FlagSpec = {
  name: "details",
  type: "value",
  help:
    "Structured details as an inline JSON object. Coordinates live under the 'location' key and " +
    "must be JSON numbers, not strings: '{\"location\": {\"lat\": 35.68, \"lon\": 139.76}}'. " +
    "Without --merge-details this REPLACES the memory's details wholesale ('{}' clears them).",
};
const UPDATE_LOCATION: FlagSpec = {
  name: "location",
  type: "value",
  help:
    "Shorthand for details.location: 'lat,lon' or 'lat,lon,label'. Without --merge-details this " +
    "replaces the memory's details with just the location. The location object is always " +
    "replaced whole, label included: re-send 'lat,lon,label' to keep one.",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The memory's current `details` for `update-memory --merge-details`: the
 * port of `_current_details_for_merge` (src/kagura_memory/cli.py, 0.42.0).
 *
 * `null` or absent details are `{}`. Anything short of the whole object is
 * refused, because merging onto a partial read would drop the keys that
 * were not returned: memory-cloud 0.78.0+ bounds a reference reply and puts
 * `details_omitted` / `details_total_chars` markers in place of a large
 * `details` (a paging caller gets `details_json` slices instead). A truthy
 * `details_omitted`, a `details_json` page, or a size without the `details`
 * key itself can only mean a bounded read.
 *
 * An absent key with no marker is read as null details only because
 * `reference()` sends no `fields` selection; a future one must keep
 * "details" in it, or this would merge onto `{}`.
 *
 * `details_total_chars` is printed when it is an integer. JSON.parse cannot
 * tell `24000.0` from `24000`, which Python (an `int` check) leaves out.
 *
 * @throws CliError (exit 1) when the reply carries no memory object, its
 *   details were omitted or paged, or they are not a JSON object.
 */
export async function currentDetailsForMerge(
  client: KaguraClient,
  contextId: string,
  memoryId: string,
): Promise<Record<string, unknown>> {
  const result = await client.reference({ contextId, memoryId });
  const memory = isPlainObject(result) ? result.memory : undefined;
  if (!isPlainObject(memory)) {
    throw new CliError("--merge-details: the reference reply carried no memory object");
  }
  if (
    pyTruthy(memory.details_omitted) ||
    "details_json" in memory ||
    (!("details" in memory) && "details_total_chars" in memory)
  ) {
    const total = memory.details_total_chars;
    const size = typeof total === "number" && Number.isInteger(total) ? ` (${total} characters)` : "";
    throw new CliError(
      `--merge-details: the memory's current details could not be read in full${size}; ` +
        "the server bounds a reference reply and this CLI cannot page it yet. Send the " +
        "complete object with --details and without --merge-details (the MCP reference " +
        "tool returns the whole object with max_chars up to 100000 or details_offset " +
        "paging).",
    );
  }
  const current = memory.details;
  if (current === undefined || current === null) return {};
  if (!isPlainObject(current)) {
    throw new CliError("--merge-details: the memory's current details are not a JSON object");
  }
  return current;
}

const MERGE_DETAILS: FlagSpec = {
  name: "merge-details",
  type: "switch",
  help:
    "Read the memory first (reference) and merge --details/--location over its current details, " +
    "top-level keys only, so unmentioned keys are kept. Needs --memory-id and one of " +
    "--details/--location; two calls, not one atomic update.",
};

const updateMemory: Command = {
  summary: "Update an existing memory or upsert by external ID.",
  description:
    "  Use --memory-id for in-place update, or --external-id for upsert.\n\n" +
    "  --details REPLACES the memory's details wholesale — the server does not\n" +
    "  deep-merge — so a bare --location without --merge-details drops every other\n" +
    "  details key (including the resource_id an --external-id upsert stores there:\n" +
    "  without it the next upsert of that id creates a new memory instead of\n" +
    "  replacing this one), and '{}' clears them. --merge-details reads the memory\n" +
    "  first with reference() and merges the top-level keys of --details/--location\n" +
    "  over its current details, so unmentioned keys are kept, and it is two calls,\n" +
    "  not one atomic update (the read is a reference() of the memory and counts in\n" +
    "  its access stats). It cannot remove a key (for that, send the full object\n" +
    "  without --merge-details), except '\"tool_trigger\": null', which the server\n" +
    "  treats as unmark; '\"location\": null' is rejected by the server (422).\n" +
    "  Coordinates must be JSON numbers, not strings: the server rejects string-\n" +
    "  typed lat/lon with a 422 by design.\n\n" +
    "  Examples:\n" +
    '    kagura-memory update-memory -m MEM_UUID -s "updated summary"\n' +
    '    kagura-memory update-memory --external-id ext-key -s "summary" --content "..." -t note\n' +
    "    kagura-memory update-memory -m MEM_UUID --dismiss-supersede-candidate\n" +
    "    kagura-memory update-memory -m MEM_UUID \\\n" +
    "      --details '{\"location\": {\"lat\": 35.68, \"lon\": 139.76}, \"client\": \"acme\"}'\n" +
    "    kagura-memory update-memory -m MEM_UUID --merge-details \\\n" +
    '      --location "35.68,139.76,Tokyo HQ"',
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
      {
        name: "dismiss-supersede-candidate",
        type: "switch",
        help:
          "Reject this memory's supersede_candidate suggestion (needs --memory-id; " +
          "server v0.65.0+, older servers drop it silently)",
      },
      UPDATE_DETAILS,
      UPDATE_LOCATION,
      MERGE_DETAILS,
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const memoryId = args.values["memory-id"];
    const externalId = args.values["external-id"];
    const dismissSupersedeCandidate = args.flags.has("dismiss-supersede-candidate");
    const mergeDetails = args.flags.has("merge-details");
    // Click converts `type=float` before the function body runs, so a bad
    // -i is a usage error (exit 2) even when the checks below would fail.
    const importance = optionalFloat(args, IMPORTANCE);
    if (!memoryId && !externalId) {
      throw new CliError("Either --memory-id or --external-id is required");
    }
    if (memoryId && externalId) {
      throw new CliError("Provide only one of --memory-id or --external-id");
    }
    // Python tests `external_id` for truthiness; this tests for presence,
    // as `updateMemory` does, because an empty `--external-id=` still goes
    // out as external_id and the client would refuse the pair itself.
    if (dismissSupersedeCandidate && externalId !== undefined) {
      throw new CliError("--dismiss-supersede-candidate requires --memory-id (not --external-id)");
    }
    // Python tests `external_id` for truthiness here, and so does this: an
    // empty `--external-id=` beside -m goes out as Python sends it.
    if (mergeDetails && externalId) {
      throw new CliError("--merge-details requires --memory-id (not --external-id)");
    }
    const summary = args.values.summary;
    const content = args.values.content;
    const type = args.values.type;
    const tags = parseTags(args.values.tags);
    // Port of `_build_details` as update_memory calls it (cli.py): after the
    // id checks, a usage error (exit 2) before anything is sent; blank is
    // unset (leave details alone), '{}' clears them.
    const details = buildDetails(args.values.details, args.values.location);
    if (mergeDetails && details === undefined) {
      throw new CliError("--merge-details needs --details or --location");
    }

    return runClientCommand(deps, args.values["context-id"], async (client, contextId) => {
      let payload = details;
      if (mergeDetails && payload !== undefined) {
        // `{**current, **payload}` in Python: a shallow merge into a new
        // object. The checks above make memoryId a non-empty string here.
        payload = { ...(await currentDetailsForMerge(client, contextId, memoryId!)), ...payload };
      }
      return client.updateMemory({
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
        ...(payload !== undefined ? { details: payload } : {}),
        ...(dismissSupersedeCandidate ? { dismissSupersedeCandidate } : {}),
      });
    });
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
