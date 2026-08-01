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

import { requireArg, requireOption, rejectExtraArgs, type Command, type CommandGroup } from "../command.js";
import { formatJson } from "../output.js";
import { CliError, pairedFlag, parseChoice, parseRanged } from "../parse.js";
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

const list: Command = {
  summary: "List available contexts.",
  spec: { flags: [] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    return runClientCommand(deps, undefined, (client) => client.listContexts(), {
      needsContext: false,
    });
  },
};

const create: Command = {
  summary: "Create a new context.",
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
  metavar: "[voyage|cohere]",
  help: "Reranker provider",
};

const searchConfig: Command = {
  summary: "Update search configuration for a context.",
  args: "CONTEXT_ID",
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
      rawReranker === undefined ? undefined : parseChoice(RERANKER, rawReranker, ["voyage", "cohere"]);
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

/** `kagura contexts` — the backward-compatible alias for `context list`. */
export const CONTEXTS_ALIAS: Command = {
  ...list,
  summary: "List available contexts (alias for 'context list').",
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
