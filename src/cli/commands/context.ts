/**
 * `kagura-memory context …` plus the `contexts` and `config` groups.
 *
 * Two shapes here differ from every other group and are easy to get wrong:
 *
 *   - the context id is a **positional** argument, not `-c/--context-id`,
 *     and there is no `.kagura.json` fallback for it;
 *   - `context create --public` is inverted on the wire (`is_private = not
 *     public`), so omitting it creates a *private* context.
 */

import {
  examples,
  requireArg,
  requireOption,
  rejectExtraArgs,
  type Command,
  type CommandGroup,
} from "../command.js";
import { detailsPageOverCap } from "../../client.js";
import { pyStrip } from "../../pyCompat.js";
import { formatJson } from "../output.js";
import { CliError, CliUsageError, pairedFlag, parseChoice, parseRanged } from "../parse.js";
import type { FlagSpec } from "../parseArgs.js";
import { runClientCommand } from "../runClientCommand.js";

const NAME: FlagSpec = {
  name: "name",
  short: "n",
  type: "value",
  help: "Context name (lowercase, hyphens, underscores)",
};
const DISPLAY_NAME: FlagSpec = { name: "display-name", type: "value", help: "Human-readable display name" };
const DESCRIPTION: FlagSpec = { name: "description", short: "d", type: "value", help: "Context description" };
const SUMMARY: FlagSpec = {
  name: "summary",
  short: "s",
  type: "value",
  help: "LLM-oriented summary (200-500 chars)",
};
const USAGE_GUIDE: FlagSpec = { name: "usage-guide", type: "value", help: "LLM-oriented usage guidelines" };
const YES: FlagSpec = { name: "yes", short: "y", type: "switch", help: "Skip confirmation prompt" };

const NAME_CONTAINS: FlagSpec = {
  name: "name-contains",
  type: "value",
  help:
    "Only contexts whose name or display name contains this text " +
    "(case-insensitive, max 100 chars)",
};

const LIMIT: FlagSpec = {
  name: "limit",
  type: "value",
  metavar: "INTEGER",
  help:
    "Contexts per page, 1-200 (server default 100; with --details and no " +
    "--name-contains at most 20, the default there; memory-cloud 0.82.0+).",
};
const CURSOR: FlagSpec = {
  name: "cursor",
  type: "value",
  help:
    "next_cursor of the previous page, with the same other options; a blank one " +
    "is ignored (memory-cloud 0.82.0+).",
};

/**
 * The stderr line after a cut `list_contexts` page (memory-cloud v0.82.0+,
 * #1743) — the Python CLI 0.44.0's `_page_footer`, word for word.
 *
 * `rerun` is what to run for the next page, up to its `--cursor` flag.
 * `null` on the last page, and from a server before v0.82.0, which sends
 * no `has_more`. The line is a command to paste into a shell, so the
 * cursor is shown only in the form the server takes back as `cursor`
 * (ASCII digits): nothing a shell expands inside double quotes (`$`, a
 * backtick) and no control character reaches the terminal. Any other
 * `next_cursor` is left to the JSON on stdout.
 */
function pageFooter(result: unknown, rerun: string): string | null {
  if (typeof result !== "object" || result === null) return null;
  const { has_more: hasMore, next_cursor: cursor } = result as Record<string, unknown>;
  if (hasMore !== true || typeof cursor !== "string" || cursor === "") return null;
  if (!/^[0-9]+$/.test(cursor)) {
    return `has_more: true. For the next page, run ${rerun} --cursor set to next_cursor from the JSON.`;
  }
  return `has_more: true; next_cursor: "${cursor}". For the next page, run ${rerun} --cursor "${cursor}".`;
}

/** The `context list` footer: the same command, with the next cursor. */
export function nextPageFooter(result: unknown): string | null {
  return pageFooter(result, "the command again with the same options and");
}

/** The `contexts` footer: the shortcut takes no cursor, `context list` does. */
export function contextsFooter(result: unknown): string | null {
  return pageFooter(result, "kagura-memory context list");
}

const list: Command = {
  summary: "List available contexts.",
  description:
    "  Rows are slim by default (id, name, is_private, is_locked, last_used_at);\n" +
    "  memory-cloud v0.73.0+ is needed for --name-contains/--summary/--details.\n\n" +
    "  From memory-cloud 0.82.0 the list comes a page at a time (100 contexts by\n" +
    "  default, and a page also stops at 20,000 characters). When a page was cut,\n" +
    "  has_more and next_cursor follow the JSON on stderr: pass next_cursor as\n" +
    "  --cursor, with the same other options, for the next page. Older servers return\n" +
    "  every context and ignore --limit and --cursor.\n\n" +
    "  Examples:\n" +
    "    kagura-memory context list\n" +
    "    kagura-memory context list --name-contains auth --summary\n" +
    "    kagura-memory context list --stats\n" +
    "    kagura-memory context list --limit 50 --cursor 50",
  spec: {
    flags: [
      NAME_CONTAINS,
      { name: "summary", type: "switch", help: "Add summaries (300-char preview)" },
      { name: "details", type: "switch", help: "Add full summaries and embedding_model" },
      { name: "stats", type: "switch", help: "Add memory_count per context" },
      LIMIT,
      CURSOR,
    ],
  },
  run: async (deps, args) => {
    // click converts the options before it looks for extra arguments.
    const rawLimit = args.values.limit;
    const limit =
      rawLimit === undefined
        ? undefined
        : parseRanged(LIMIT, rawLimit, { min: 1, max: 200, rangeLabel: "1<=x<=200", integer: true });
    rejectExtraArgs(args);
    // Python forwards the filter only when truthy (`if name_contains:`), so
    // an empty `--name-contains=` lists everything; the client would send "".
    const nameContains = args.values["name-contains"] || undefined;
    const details = args.flags.has("details");
    // Blank is unset, as for --name-contains: a script feeding back the last
    // page's next_cursor (`jq -r '.next_cursor // empty'`) passes "".
    const rawCursor = args.values.cursor;
    const cursor = rawCursor !== undefined && pyStrip(rawCursor) !== "" ? rawCursor : undefined;
    if (detailsPageOverCap(details, nameContains, limit)) {
      // The SDK would refuse it too, naming its own option names; the CLI
      // names its flags, as the Python CLI does.
      throw new CliUsageError(
        "--details returns full summaries: pass --name-contains or " +
          `--limit 20 or less (got ${limit}).`,
      );
    }
    const options = {
      ...(nameContains !== undefined ? { nameContains } : {}),
      ...(args.flags.has("summary") ? { includeSummary: true } : {}),
      ...(details ? { includeDetails: true } : {}),
      ...(args.flags.has("stats") ? { includeStats: true } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    return runClientCommand(deps, undefined, (client) => client.listContexts(options), {
      needsContext: false,
      footer: nextPageFooter,
    });
  },
};

const create: Command = {
  summary: "Create a new context.",
  description: examples(
    "context create -n my-project",
    'context create -n dev -d "Development notes" -s "Project dev context"',
  ),
  spec: {
    flags: [
      { ...NAME, required: true },
      DISPLAY_NAME,
      DESCRIPTION,
      SUMMARY,
      USAGE_GUIDE,
      { name: "public", type: "switch", help: "Accessible to workspace members" },
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const name = requireOption(args, NAME);
    const displayName = args.values["display-name"];
    const description = args.values.description;
    const summary = args.values.summary;
    const usageGuide = args.values["usage-guide"];
    return runClientCommand(
      deps,
      undefined,
      (client) =>
        client.createContext({
          name,
          ...(displayName !== undefined ? { displayName } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(summary !== undefined ? { summary } : {}),
          ...(usageGuide !== undefined ? { usageGuide } : {}),
          // Inverted: the flag says "public", the wire field says private.
          isPrivate: !args.flags.has("public"),
        }),
      { needsContext: false },
    );
  },
};

const deleteContext: Command = {
  summary: "Soft-delete a context and all its memories.",
  args: "CONTEXT_ID",
  description: examples("context delete CTX_UUID", "context delete CTX_UUID -y"),
  spec: { flags: [YES] },
  run: async (deps, args) => {
    const contextId = requireArg(args, 0, "CONTEXT_ID");
    rejectExtraArgs(args, 1);
    if (!args.flags.has("yes") && !(await deps.confirm(`Delete context ${contextId}?`))) {
      throw new CliError("Aborted!");
    }
    return runClientCommand(deps, undefined, (client) => client.deleteContext(contextId), {
      needsContext: false,
    });
  },
};

const update: Command = {
  summary: "Update a context's settings.",
  args: "CONTEXT_ID",
  description: examples(
    'context update CTX_UUID -s "Updated summary"',
    "context update CTX_UUID --lock",
    "context update CTX_UUID --unlock",
  ),
  spec: {
    flags: [
      { ...DISPLAY_NAME, help: "Updated display name" },
      { ...DESCRIPTION, help: "Updated description" },
      { ...SUMMARY, help: "Updated LLM-oriented summary" },
      { ...USAGE_GUIDE, help: "Updated LLM-oriented usage guidelines" },
      { name: "lock", type: "switch", help: "Lock the context (no writes)" },
      { name: "unlock", type: "switch", help: "Unlock the context" },
    ],
  },
  run: async (deps, args) => {
    const contextId = requireArg(args, 0, "CONTEXT_ID");
    rejectExtraArgs(args, 1);
    const displayName = args.values["display-name"];
    const description = args.values.description;
    const summary = args.values.summary;
    const usageGuide = args.values["usage-guide"];
    const isLocked = pairedFlag(args.flags.has("lock"), args.flags.has("unlock"), [
      "--lock",
      "--unlock",
    ]);
    const patch = {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(usageGuide !== undefined ? { usageGuide } : {}),
      ...(isLocked !== undefined ? { isLocked } : {}),
    };
    if (Object.keys(patch).length === 0) {
      // ClickException in Python: exit 1, not the usage code.
      throw new CliError("At least one update option is required");
    }
    return runClientCommand(
      deps,
      undefined,
      (client) => client.updateContext({ contextId, ...patch }),
      { needsContext: false },
    );
  },
};

const SEMANTIC: FlagSpec = {
  name: "semantic",
  type: "value",
  metavar: "FLOAT",
  help: "Semantic weight (0.0-1.0)",
};
const BM25: FlagSpec = { name: "bm25", type: "value", metavar: "FLOAT", help: "BM25 weight (0.0-1.0)" };
const FETCH_FACTOR: FlagSpec = {
  name: "fetch-factor",
  type: "value",
  metavar: "INTEGER",
  help: "Fetch multiplier (1-10)",
};
const RERANKER: FlagSpec = {
  name: "reranker",
  type: "value",
  metavar: "[voyage|cohere|self_hosted]",
  help: "Reranker provider",
};

const searchConfig: Command = {
  summary: "Update search configuration for a context.",
  args: "CONTEXT_ID",
  description: examples(
    "context search-config CTX_UUID --semantic 0.5 --bm25 0.5",
    "context search-config CTX_UUID --rerank --reranker voyage",
    "context search-config CTX_UUID --rerank --reranker self_hosted",
  ),
  spec: {
    flags: [
      SEMANTIC,
      BM25,
      FETCH_FACTOR,
      { name: "rerank", type: "switch", help: "Enable reranking" },
      { name: "no-rerank", type: "switch", help: "Disable reranking" },
      RERANKER,
      { name: "reranker-model", type: "value", help: "Reranker model name" },
    ],
  },
  run: async (deps, args) => {
    const contextId = requireArg(args, 0, "CONTEXT_ID");
    rejectExtraArgs(args, 1);

    const ranged = (flag: FlagSpec, min: number, max: number, label: string, integer = false) => {
      const raw = args.values[flag.name];
      return raw === undefined
        ? undefined
        : parseRanged(flag, raw, { min, max, rangeLabel: label, integer });
    };
    const semanticWeight = ranged(SEMANTIC, 0, 1, "0.0<=x<=1.0");
    const bm25Weight = ranged(BM25, 0, 1, "0.0<=x<=1.0");
    const fetchFactor = ranged(FETCH_FACTOR, 1, 10, "1<=x<=10", true);
    const useRerank = pairedFlag(args.flags.has("rerank"), args.flags.has("no-rerank"), [
      "--rerank",
      "--no-rerank",
    ]);
    const rawReranker = args.values.reranker;
    const rerankerProvider =
      rawReranker === undefined
        ? undefined
        : parseChoice(RERANKER, rawReranker, ["voyage", "cohere", "self_hosted"]);
    const rerankerModel = args.values["reranker-model"];

    const patch = {
      ...(semanticWeight !== undefined ? { semanticWeight } : {}),
      ...(bm25Weight !== undefined ? { bm25Weight } : {}),
      ...(fetchFactor !== undefined ? { fetchFactor } : {}),
      ...(useRerank !== undefined ? { useRerank } : {}),
      ...(rerankerProvider !== undefined ? { rerankerProvider } : {}),
      ...(rerankerModel !== undefined ? { rerankerModel } : {}),
    };
    if (Object.keys(patch).length === 0) {
      throw new CliError("At least one option is required");
    }
    // Both weights given must sum to 1.0; the server rejects otherwise, but
    // saying so locally saves a round trip and names both numbers.
    if (semanticWeight !== undefined && bm25Weight !== undefined) {
      const sum = semanticWeight + bm25Weight;
      if (Math.abs(sum - 1) > 1e-9) {
        throw new CliError(
          `Weights must sum to 1.0 (got ${semanticWeight} + ${bm25Weight} = ${sum})`,
        );
      }
    }

    return runClientCommand(
      deps,
      undefined,
      (client) => client.updateSearchConfig({ contextId, ...patch }),
      { needsContext: false },
    );
  },
};

export const CONTEXT_GROUP: CommandGroup = {
  summary: "Manage contexts (list, create, update).",
  commands: {
    list,
    create,
    delete: deleteContext,
    update,
    "search-config": searchConfig,
  },
};

/**
 * `kagura contexts` — the backward-compatible short form of `context list`.
 *
 * Python declares it with no options, so it takes none here either: a
 * `contexts --stats` that worked only in this bin would break on `kagura`.
 */
export const CONTEXTS_ALIAS: Command = {
  summary: "List available contexts (short form of 'context list', without its options).",
  description:
    "  Prints one page: from memory-cloud 0.82.0 that is the 100 most recently used\n" +
    "  contexts. When more follow, a line on stderr names the 'kagura-memory context\n" +
    "  list --cursor' call for the next page.\n\n" +
    "  For --name-contains/--summary/--details/--stats/--limit/--cursor use\n" +
    "  'kagura-memory context list'.",
  spec: { flags: [] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    return runClientCommand(deps, undefined, (client) => client.listContexts(), {
      needsContext: false,
      footer: contextsFooter,
    });
  },
};

/**
 * `kagura config show`.
 *
 * The only command in the CLI that touches no network and no credentials.
 */
const configShow: Command = {
  summary: "Show current configuration.",
  spec: { flags: [] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    let config;
    try {
      config = deps.loadConfig();
    } catch (e) {
      // Python prints "Error loading config: …" here rather than click's
      // "Error: " — the one place in the CLI with its own prefix.
      throw new CliError(`loading config: ${e instanceof Error ? e.message : String(e)}`);
    }
    const shown: Record<string, unknown> = { ...config };
    if (typeof config.api_key === "string" && config.api_key) {
      shown.api_key = maskKey(config.api_key);
    }
    deps.write(formatJson(shown));
    return 0;
  },
};

/**
 * Mask an API key for display.
 *
 * Python slices `key[:8] + "..." + key[-4:]`, whose halves *overlap* for
 * anything shorter than 12 characters — `"abc"` renders as `"abc...abc"`,
 * printing the whole secret twice. That is not reproduced: a mask that
 * echoes its input is not a mask, and the divergence is only visible for
 * keys too short to be real.
 */
function maskKey(key: string): string {
  if (key.length < 12) return "***";
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

export const CONFIG_GROUP: CommandGroup = {
  summary: "Manage configuration.",
  commands: { show: configShow },
};
