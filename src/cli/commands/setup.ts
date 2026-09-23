/**
 * `kagura-memory setup <harness>` — connect a coding agent to Kagura Memory.
 *
 * Every subcommand sets up a `kagura-memory` MCP entry for its harness: the
 * URL and a Bearer header.
 *
 *   claude    `.mcp.json` (project scope), or `claude mcp add-json` (user
 *             scope), reading the key from KAGURA_MCP_API_KEY; it also
 *             writes `.kagura.json` in the project, merged with whatever
 *             is already there and gitignored
 *   codex     `codex mcp add`, reading the key from KAGURA_API_KEY
 *   hermes    the `config.yaml` block printed, reading the key from
 *             MCP_<NAME>_API_KEY in Hermes's `.env`
 *   openclaw  `openclaw mcp add`, reading the key from KAGURA_API_KEY in
 *             OpenClaw's `.env`
 *
 * The last three never see, write, print or pass the key, as in the Python
 * CLI (python-sdk#260): the entry names the variable, and the notes say
 * where the user puts the key. They write no file themselves either.
 *
 * Python has a second, OAuth path that writes a *stdio* entry launching
 * its `kagura-mcp` proxy so no API key is ever written to disk. That proxy
 * is a Python console script with no counterpart in this package, so
 * `--profile` reports that rather than writing a config that would name a
 * binary the user does not have.
 *
 * Only JSON is ever rewritten here. TOML, YAML and JSON5 would each need a
 * parser, and the package takes no runtime dependencies: those configs are
 * changed by the harness's own CLI when it is on PATH and can set the
 * whole entry without prompting, and otherwise the block is printed for
 * the user to add.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_MCP_URL } from "../../auth/resolve.js";
import { jsonErrorWhere, type KaguraConfig } from "../../config.js";
import { validateHttpsUrl } from "../../http.js";
import { isUuid, parseUuid } from "../../uuid.js";
import { rejectExtraArgs, type Command, type CommandDeps, type CommandGroup } from "../command.js";
import type { ExecOptions } from "../exec.js";
import { formatJson } from "../output.js";
import { CliError, CliUsageError, parseChoice, quote } from "../parse.js";
import type { FlagSpec, ParsedArgs } from "../parseArgs.js";
import type { CliDeps } from "../run.js";
import { resolveConfig } from "../runClientCommand.js";
import {
  KEY_ENV_VAR,
  codexTomlBlock,
  hermesEnvVar,
  hermesYamlBlock,
  json5HasServer,
  mcpUrlWithQuery,
  openclawBlock,
  openclawEntry,
  pluginServerUrl,
  queryParam,
  shellCommand,
  shellQuote,
  tomlHasServer,
  withoutQueryParam,
  yamlHasServer,
  yamlServersIndent,
  yamlServersInline,
} from "./harnessConfig.js";

/**
 * The entry's name on every harness. The Codex plugin's hooks look it up
 * by this name and `doctor` checks `.mcp.json` for it, so only the
 * harness subcommands let `--name` change it.
 */
const SERVER_NAME = "kagura-memory";

const API_KEY: FlagSpec = { name: "api-key", type: "value", help: "Kagura API key (skip prompt)" };
const MCP_URL: FlagSpec = { name: "mcp-url", type: "value", metavar: "URL", help: "MCP URL" };
const CONTEXT_ID: FlagSpec = { name: "context-id", short: "c", type: "value", help: "Context ID" };
// Python's OAuth setup, which writes the kagura-mcp entry: refused here,
// and the help says so, as the harness subcommands' does.
const PROFILE: FlagSpec = {
  name: "profile",
  type: "value",
  help:
    "OAuth profile (from `kagura auth login`) for the Python CLI's kagura-mcp entry, which this " +
    "port cannot write: refused",
};
const PROJECT_DIR: FlagSpec = {
  name: "project-dir",
  type: "value",
  metavar: "DIR",
  help: "Project directory",
  defaultLabel: ".",
};
// Accepted so a script written for the Python CLI still runs, but inert:
// this port never prompts, so it is already what the flag asks for. Said
// in the help rather than silently ignored — a flag that reads as changing
// behaviour and does not is worse than one that is rejected.
const NON_INTERACTIVE: FlagSpec = {
  name: "non-interactive",
  short: "y",
  type: "switch",
  help: "Accepted for compatibility; this port never prompts",
};
const GUARDRAILS: FlagSpec = {
  name: "guardrails",
  type: "value",
  metavar: "off|CONTEXT_ID",
  help: "Set the URL's guardrails parameter (server v0.74.0+): a context id, or off",
};
// Python's floor and names (memory-cloud's PROFILES); worded to hold for
// codex, which shares the flag.
const TOOL_PROFILE: FlagSpec = {
  name: "tool-profile",
  type: "value",
  metavar: "NAME",
  help:
    "Set the URL's profile parameter (server v0.73.0+): the server knows 'full' and 'core' " +
    "(case-sensitive) and fails tools/list for any other name, leaving no Kagura tools; " +
    "a ?tools= allowlist wins",
};
const SCOPE: FlagSpec = {
  name: "scope",
  type: "value",
  metavar: "[project|user]",
  help:
    "project (.mcp.json) or user (claude mcp add-json); a user entry sends $KAGURA_MCP_API_KEY: " +
    "set it where Claude Code starts",
  defaultLabel: "project",
};
// The Python CLI's hook, command and context-selection flags. This port
// installs no hooks or slash commands and never picks or creates a
// context, so they are accepted — a script written for `kagura setup
// claude` still runs — and change nothing; the help says so, as for -y.
const NO_HOOKS = "Accepted for compatibility; this port installs no hooks";
const NO_COMMANDS = "Accepted for compatibility; this port installs no commands";
/** The ones that ask for something this port does not do, so a run notes it. */
const ASKS_FOR_HOOKS = ["session-hook", "sync-hook", "commands"] as const;
const PYTHON_ONLY_FLAGS: FlagSpec[] = [
  { name: "session-hook", type: "switch", help: NO_HOOKS },
  { name: "no-session-hook", type: "switch", help: NO_HOOKS },
  { name: "sync-hook", type: "switch", help: NO_HOOKS },
  { name: "no-sync-hook", type: "switch", help: NO_HOOKS },
  { name: "commands", type: "switch", help: NO_COMMANDS },
  { name: "no-commands", type: "switch", help: NO_COMMANDS },
  { name: "no-auto-context", type: "switch", help: "Accepted for compatibility; this port never prompts" },
];
const COMMON_FLAGS = [API_KEY, MCP_URL, CONTEXT_ID, PROFILE, PROJECT_DIR, NON_INTERACTIVE];

// `setup codex | hermes | openclaw` take the Python CLI's option set and
// help (python-sdk#260), less what needs the kagura-mcp proxy or the
// AGENTS.md export, plus the two options v0.10 took, kept inert so its
// scripts still run.
const NAME: FlagSpec = {
  name: "name",
  type: "value",
  help: "MCP server name in the harness config",
  defaultLabel: SERVER_NAME,
};
const FORCE: FlagSpec = {
  name: "force",
  type: "switch",
  help: "Replace an existing entry of the same name",
};
const DRY_RUN: FlagSpec = {
  name: "dry-run",
  type: "switch",
  help: "Show the command or block and the entry; change nothing",
};
const HARNESS_PROFILE: FlagSpec = { ...PROFILE, help: `${PROFILE.help}, and ignored with --url-form` };
const URL_FORM: FlagSpec = {
  name: "url-form",
  type: "switch",
  help:
    "Accepted for compatibility; every entry this port writes is the URL form, which sends a " +
    "long-lived API key from an environment variable",
};
const HARNESS_MCP_URL: FlagSpec = {
  ...MCP_URL,
  help:
    "The MCP URL your API key works with (…/mcp/w/<workspace>); default: the configured " +
    `mcp_url, else ${DEFAULT_MCP_URL}`,
};
const INERT_API_KEY: FlagSpec = {
  ...API_KEY,
  help: "Accepted for compatibility; not stored or used: the entry reads the key from an environment variable",
};
const INERT_PROJECT_DIR: FlagSpec = {
  name: "project-dir",
  type: "value",
  metavar: "DIR",
  help: "Accepted for compatibility; not used: the entry is per user, and no project file is written",
};
const CODEX_CONTEXT_ID: FlagSpec = {
  ...CONTEXT_ID,
  help: "Context ID, for the guardrails lane only: a UUID, since this port looks up no context names",
};
const UNUSED_CONTEXT_ID: FlagSpec = {
  ...CONTEXT_ID,
  help: "Context ID; not used here (the Python CLI's AGENTS.md export takes it)",
};
const CODEX_GUARDRAILS: FlagSpec = {
  name: "guardrails",
  type: "value",
  metavar: "off|CONTEXT_ID",
  help:
    "Set the URL's ?guardrails= (server v0.74.0+). Codex reads the MCP instructions, which then " +
    "carry that context's tool guardrail digest. Defaults to --context-id, or to 'off' while the " +
    "kagura-memory plugin's guardrail hooks are on, unless the MCP URL (--mcp-url or the " +
    "configured mcp_url) already sets it. Use a context whose editor list you control. 'off' " +
    "also removes the guardrails block from get_context_info.",
};
/** Hermes and OpenClaw take the flag so a script can pass it to every harness alike. */
function guardrailsNotWritten(title: string): FlagSpec {
  return {
    name: "guardrails",
    type: "value",
    metavar: "off|CONTEXT_ID",
    help:
      `Never written: ${title} does not read MCP instructions. 'off' is refused (it would remove ` +
      `the get_context_info guardrails block, ${title}'s only guardrail lane)`,
  };
}
function apiKeyEnv(help: string): FlagSpec {
  return { name: "api-key-env", type: "value", metavar: "VAR", help };
}

/** The ones after the harness's own, in the Python CLI's order. */
const HARNESS_TAIL = [URL_FORM, HARNESS_MCP_URL];
const HARNESS_END = [FORCE, NON_INTERACTIVE, DRY_RUN, INERT_API_KEY, INERT_PROJECT_DIR];

const GUARDRAILS_ADVICE =
  "  Pass --guardrails a context id only for a context whose editor list you\n" +
  "  control. The server ignores any value but a UUID or off, so anything\n" +
  "  else is refused here.";

type Harness = "claude" | "codex" | "hermes" | "openclaw";

/** Python's harness titles. */
const LABEL: Record<Harness, string> = {
  claude: "Claude Code",
  codex: "Codex",
  hermes: "Hermes Agent",
  openclaw: "OpenClaw",
};

/** What the OAuth path would have written, for the `--profile` refusal. */
const OAUTH_TARGET: Record<Harness, string> = {
  claude: "an .mcp.json",
  codex: "a Codex config.toml entry",
  hermes: "a Hermes config.yaml entry",
  openclaw: "an OpenClaw openclaw.json entry",
};

/**
 * Harnesses that do not read the server's MCP `instructions`.
 *
 * There, `guardrails=<context>` changes nothing, and `off` would also
 * remove the `get_context_info` block — the one guardrail lane left.
 */
const NO_INSTRUCTIONS: ReadonlySet<Harness> = new Set(["hermes", "openclaw"]);

/** The refusal of `--guardrails off` on a NO_INSTRUCTIONS harness — Python's. */
function refuseGuardrailsOff(harness: Harness): CliUsageError {
  return new CliUsageError(
    `${LABEL[harness]} does not read MCP instructions: its guardrails come only from the ` +
      "guardrails block of get_context_info, which --guardrails off removes.",
  );
}

/**
 * The refusal of `--profile` where it would need the `kagura-mcp` proxy:
 * writing that entry would name a Python console script this package does
 * not install — the config would look right and fail at launch.
 */
function refuseProfile(harness: Harness, profile: string): CliError {
  const here =
    harness === "claude"
      ? "or set up the static-token form here with --api-key."
      : "or set up the URL form here with --url-form.";
  return new CliError(
    `the OAuth (--profile) setup writes ${OAUTH_TARGET[harness]} that launches the \`kagura-mcp\` stdio\n` +
      "  proxy, which ships with the Python package, not this one.\n" +
      `  Use \`pip install kagura-memory && kagura setup ${harness} --profile ${profile}\`, ${here}`,
  );
}

/**
 * Python's reason for printing the block, `` `codex` is not on PATH ``.
 *
 * `which` also passes over a Windows `.cmd` shim, which Node runs only
 * through a shell that would re-parse the argv; an npm-installed CLI there
 * is one, so the bare reason would be untrue.
 */
function notOnPath(program: string): string {
  return `\`${program}\` is not on PATH, or only as a Windows .cmd shim, which needs a shell`;
}

/** Parse a JSON file, treating "absent" and "empty" as `{}`. */
function readJsonSafe(target: string): Record<string, unknown> {
  if (!fs.existsSync(target)) return {};
  let text: string;
  try {
    text = fs.readFileSync(target, "utf-8");
  } catch (e) {
    throw new CliError(`cannot read ${target}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!text.trim()) return {};
  // Overwriting a file we could not understand would discard whatever the
  // operator had configured there. The reason never quotes the file, which
  // holds the key (see jsonErrorWhere).
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const where = jsonErrorWhere(e, text);
    throw new CliError(`refusing to rewrite ${target}: it is not valid JSON${where ? ` (${where})` : ""}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`refusing to rewrite ${target}: it is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Parse a JSON file only to look inside it; null when absent or unusable.
 *
 * For files this command never writes: an unreadable one defines nothing,
 * since the harness that owns it cannot read it either.
 */
function readJsonLenient(target: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf-8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Codex's config.toml text, or "" when it does not exist yet; Python's
 * words when it cannot be read. Python reads that file itself to find an
 * entry, and stops there.
 */
function readText(target: string): string {
  try {
    return fs.readFileSync(target, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    const reason = e instanceof Error ? e.message : String(e);
    throw new CliError(`Cannot read ${pathLabel(target)} (${reason}); fix it and re-run.`);
  }
}

/**
 * A Hermes or OpenClaw config's text, only to scan it: "" when it does not
 * exist or cannot be read. Python finds their entries through the harness
 * CLI alone and never reads these files, so one that cannot be read stops
 * nothing here either; a note says the scan could not look.
 */
function readTextToScan(target: string, name: string, notes: string[]): string {
  try {
    return fs.readFileSync(target, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      const reason = e instanceof Error ? e.message : String(e);
      notes.push(
        `Note: setup could not read ${pathLabel(target)} (${reason}), so it did not look there for a ` +
          `${name} entry.`,
      );
    }
    return "";
  }
}

/**
 * Write a file that carries credentials.
 *
 * Every file this command writes holds the API key, so each is created
 * 0600 and tightened even when it already existed — `writeFileSync`
 * applies `mode` only on creation, and the default 0644 under the common
 * umask lets any other local account read the key out of a shared build
 * host's workspace.
 */
function writePrivate(target: string, text: string): void {
  fs.writeFileSync(target, text, { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows has no POSIX mode bits; chmod there only toggles read-only.
    // The write above is what matters, and the tests skip the assertion.
  }
}

function writeJson(target: string, data: Record<string, unknown>): void {
  writePrivate(target, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Ensure `.gitignore` lists the files that now hold credentials.
 *
 * `.kagura.json` and the static-token `.mcp.json` both carry the API key;
 * committing either publishes it.
 */
function protectSecrets(projectDir: string, files: string[]): string[] {
  const target = path.join(projectDir, ".gitignore");
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : "";
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = files.filter((f) => !lines.has(f) && !lines.has(`/${f}`));
  if (missing.length === 0) return [];
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(
    target,
    `${prefix}\n# Kagura Memory — these carry credentials\n${missing.join("\n")}\n`,
    "utf-8",
  );
  return missing;
}

/**
 * Validate `--guardrails`: `off` in any case, or a UUID in any spelling
 * `isUuid` accepts, written canonically.
 */
function parseGuardrails(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.toLowerCase() === "off") return "off";
  if (value && isUuid(value)) return parseUuid(value);
  // The server silently ignores any other value, so a typo would read as
  // success here and change nothing there. Python's normalize_guardrails
  // message, as click reports it.
  throw new CliUsageError(
    `Invalid value for '--guardrails': guardrails must be 'off' or a context UUID, got ${quote(raw)}`,
  );
}

/**
 * Validate `--tool-profile`, trimmed; an empty one is refused as Python
 * refuses it, since `profile=` would ask the server for no profile.
 */
function parseToolProfile(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) throw new CliUsageError("Invalid value for '--tool-profile': must not be empty");
  return value;
}

/**
 * Validate `--name`: Python's 1-64 letters, digits, `-` or `_`.
 *
 * Codex accepts nothing else, and keeping to these characters lets the
 * name go bare into the printed TOML and YAML and into the variable
 * Hermes derives from it. The first one is also a letter or digit, which
 * Python does not require: the name is a bare positional in the `codex`
 * and `openclaw` argv, where `--name=--help` would be read as an option,
 * and the harness CLI would print its help and exit 0 with nothing
 * configured.
 */
function parseName(args: ParsedArgs): string {
  const name = args.values.name ?? SERVER_NAME;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new CliUsageError(
      "Invalid value for '--name': use 1-64 letters, digits, '-' or '_', starting with a letter or digit",
    );
  }
  return name;
}

/** What `setup claude` resolves before touching anything. */
interface SetupInput {
  harness: "claude";
  projectDir: string;
  apiKey: string;
  /**
   * As given or configured, and so written to `.kagura.json`; the flags'
   * query parameters go on the entry's URL only.
   */
  baseUrl: string;
  contextId: string;
  /** `-c` was passed, rather than read from `.kagura.json`. */
  contextFlag: boolean;
  /** `--guardrails`, validated and normalised; undefined when absent. */
  guardrails: string | undefined;
  /** `--tool-profile`, trimmed; undefined when absent or not taken. */
  toolProfile: string | undefined;
  /**
   * The project's `.kagura.json`, read before anything is written or run,
   * so one this cannot parse stops the command with nothing changed.
   */
  kagura: Record<string, unknown>;
  /** Every key this process knows of, cut out of whatever `claude` prints. */
  secrets: string[];
}

/**
 * `--profile` beside `--api-key`, refused as Python's `setup claude`
 * refuses it.
 */
function refuseProfileWithKey(args: ParsedArgs): void {
  if (args.values.profile !== undefined && args.values["api-key"] !== undefined) {
    throw new CliUsageError(
      "--profile (OAuth) and --api-key (static token) are mutually exclusive; pick one.",
    );
  }
}

/** What `setup claude` resolves before touching anything. */
function resolveInput(args: ParsedArgs): SetupInput {
  rejectExtraArgs(args);
  // First, as click runs Python's option callbacks while it parses.
  const guardrails = parseGuardrails(args.values.guardrails);
  const toolProfile = parseToolProfile(args.values["tool-profile"]);
  const apiKey = args.values["api-key"];
  const profile = args.values.profile;

  refuseProfileWithKey(args);
  if (profile !== undefined) throw refuseProfile("claude", profile);

  const projectDir = path.resolve(args.values["project-dir"] ?? ".");
  if (!fs.existsSync(projectDir)) {
    throw new CliUsageError(`Invalid value for '--project-dir': ${projectDir} does not exist.`);
  }

  // Fall back to what the project already has, so re-running with no flags
  // refreshes its files rather than blanking them: its own .kagura.json,
  // as Python reads `project / ".kagura.json"`. Never the one this bin's
  // loader would find (the current directory's, then ~/.kagura.json):
  // with --project-dir that is another project's, and its key would be
  // written into this one and sent by its Claude Code. Read before
  // anything is written or run, so one that cannot be parsed stops the
  // command with nothing changed.
  const kagura = readJsonSafe(path.join(projectDir, ".kagura.json"));
  const own = (key: string): string => (typeof kagura[key] === "string" ? (kagura[key] as string) : "");
  // Then the environment, as the loader reads it when no file exists:
  // KAGURA_API_KEY, since setup codex before 0.11.0 wrote a .kagura.json
  // without the key when the key came from that variable.
  const resolvedKey = apiKey ?? (own("api_key") || process.env[KEY_ENV_VAR] || "");
  const baseUrl = args.values["mcp-url"] ?? (own("mcp_url") || process.env.KAGURA_MCP_URL || DEFAULT_MCP_URL);
  const contextFlag = Boolean(args.values["context-id"]);
  const contextId = args.values["context-id"] || own("context_id") || process.env.KAGURA_CONTEXT_ID || "";

  if (!resolvedKey) {
    // No word of `auth login`: setup writes an API-key entry, and an OAuth
    // profile does not give it one.
    throw new CliError(
      `no API key: pass --api-key, set api_key in the project's .kagura.json, or export ${KEY_ENV_VAR}.`,
    );
  }
  return {
    harness: "claude",
    projectDir,
    apiKey: resolvedKey,
    baseUrl,
    contextId,
    contextFlag,
    guardrails,
    toolProfile,
    kagura,
    secrets: knownKeys(apiKey, own("api_key")),
  };
}

/** Merge the key, URL and context into `.kagura.json`; returns its path. */
function writeKaguraJson(input: SetupInput): string {
  const target = path.join(input.projectDir, ".kagura.json");
  const kagura = { ...input.kagura };
  kagura.api_key = input.apiKey;
  // As given, as Python writes it: --guardrails and --tool-profile belong
  // to the harness entry, not to this bin, and baseUrlFromMcp finds the
  // REST base in the path, so a query the user gave does no harm here.
  kagura.mcp_url = input.baseUrl;
  if (input.contextId) kagura.context_id = input.contextId;
  writeJson(target, kagura);
  return target;
}

interface Outcome {
  status: "success" | "dry_run";
  wrote: string[];
  gitignoreAdded: string[];
  /** The URL in the entry, query included. */
  url: string;
  /** The harness command that applied the entry, or null. */
  appliedWith: string | null;
  notes: string[];
}

/** What the report says about the run besides its outcome. */
interface ReportSubject {
  harness: Harness;
  projectDir: string;
  contextId: string;
}

function report(deps: CommandDeps, input: ReportSubject, outcome: Outcome): number {
  deps.write(
    formatJson({
      status: outcome.status,
      project_dir: input.projectDir,
      wrote: outcome.wrote,
      gitignore_added: outcome.gitignoreAdded,
      // Never echo the key itself back.
      mcp_url: outcome.url,
      context_id: input.contextId || null,
      harness: input.harness,
      applied_with: outcome.appliedWith,
      guardrails: queryParam(outcome.url, "guardrails") ?? null,
      notes: outcome.notes,
    }),
  );
  return 0;
}

/**
 * Show a block for the user to add by hand.
 *
 * On stderr, so stdout stays one JSON document that `| jq` can read; the
 * JSON's notes say where the block goes.
 */
function printBlock(deps: CommandDeps, heading: string, block: string): void {
  deps.writeError(heading);
  deps.writeError("");
  deps.writeError(block);
  deps.writeError("");
}

/**
 * Every API key this process knows of, for {@link redactKeys}: the ones
 * given (`--api-key`, a configured `api_key`, the variable `--api-key-env`
 * names), then `$KAGURA_API_KEY` and `$KAGURA_MCP_API_KEY` — the variables
 * the entries reference and a harness CLI inherits. Non-empty, each once,
 * longest first, so a key that contains another is cut whole.
 */
export function knownKeys(...given: unknown[]): string[] {
  const keys = [...given, process.env[KEY_ENV_VAR], process.env[CLAUDE_KEY_ENV_VAR]].filter(
    (k): k is string => typeof k === "string" && k !== "",
  );
  return [...new Set(keys)].sort((a, b) => b.length - a.length);
}

/**
 * `text` with every one of `keys` ({@link knownKeys}) cut out. No argv this
 * command runs carries a key, but a harness CLI may echo whatever it read,
 * its environment or config included, and its output is shown on failure.
 */
export function redactKeys(text: string, keys: readonly string[]): string {
  let out = text;
  for (const key of keys) out = out.split(key).join("<redacted>");
  return out;
}

/** Run a harness CLI, failing with its own message, every known key cut out. */
async function runHarnessCli(
  deps: CliDeps,
  file: string,
  argv: string[],
  display: string,
  secrets: readonly string[],
  options?: ExecOptions,
): Promise<void> {
  const result = await deps.execFile(file, argv, options);
  if (result.code === 0) return;
  const detail = redactKeys(result.stderr.trim() || result.stdout.trim(), secrets);
  throw new CliError(`\`${display}\` failed (exit ${result.code})${detail ? `:\n  ${detail}` : ""}`);
}

// --- claude ---------------------------------------------------------------

export type ClaudeScope = "local" | "project" | "user";

/** Claude Code resolves a server name strongest first. */
const CLAUDE_SCOPE_ORDER: readonly ClaudeScope[] = ["local", "project", "user"];
const CLAUDE_TARGET_SCOPES = ["project", "user"] as const;

/** The memory-cloud Claude Code plugin, listed as `kagura-memory@<marketplace>`. */
const CLAUDE_PLUGIN_NAME = "kagura-memory";

/** Python's `_CLAUDE_TIMEOUT_SEC`, for every `claude` run. */
const CLAUDE_EXEC: ExecOptions = { timeoutMs: 30_000 };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The variable a user-scope entry takes the key from — Python's
 * `MCP_API_KEY_ENV`.
 *
 * Claude Code expands `${VAR}` in an entry's headers from its own
 * environment each time it connects, so the key goes neither on the
 * `claude mcp add-json` command line, where every local user can read it
 * in the process list, nor into `~/.claude.json`. Not {@link KEY_ENV_VAR}:
 * the SDK ranks `KAGURA_API_KEY` above `.kagura.json` and OAuth profiles,
 * so exporting it for Claude Code would change the credentials of every
 * command of this bin too.
 */
export const CLAUDE_KEY_ENV_VAR = "KAGURA_MCP_API_KEY";

/** What a user-scope entry carries in place of the key — Python's `_API_KEY_REF`. */
const API_KEY_REF = `\${${CLAUDE_KEY_ENV_VAR}}`;

/**
 * Python's note on where a user-scope entry gets the key, as it wraps it;
 * without its `--profile` aside, since this port has no OAuth setup.
 */
const KEY_ENV_NOTE: readonly string[] = [
  `The entry sends the API key from $${CLAUDE_KEY_ENV_VAR}, which Claude Code reads when it`,
  "connects, so the key is neither in the entry nor on a command line. Set it in",
  `the environment that starts Claude Code, e.g. \`export ${CLAUDE_KEY_ENV_VAR}=<your-api-key>\``,
  "in your shell profile.",
];

/**
 * Whether this shell has {@link CLAUDE_KEY_ENV_VAR}, and what it holds —
 * Python's lines, which never print the key. Empty counts as unset.
 */
function keyEnvState(apiKey: string): string {
  const current = process.env[CLAUDE_KEY_ENV_VAR];
  if (!current) return `$${CLAUDE_KEY_ENV_VAR} is not set in this shell.`;
  if (current === apiKey) return `$${CLAUDE_KEY_ENV_VAR} is already set to this key in this shell.`;
  return (
    `Warning: $${CLAUDE_KEY_ENV_VAR} in this shell holds a different key, which Claude Code ` +
    "started from here would send."
  );
}

/**
 * The API-key entry — Python's `_static_token_entry`. At user scope
 * `token` is {@link API_KEY_REF}, never the key itself.
 */
function claudeEntry(url: string, token: string): Record<string, unknown> {
  // `http`: Claude Code's transports are stdio, sse, http and ws. Earlier
  // releases wrote `url`, which is none of them.
  return { type: "http", url, headers: { Authorization: `Bearer ${token}` } };
}

/** Claude Code's `${VAR}` / `${VAR:-default}` expansion in MCP config values. */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;
/** An Authorization value that is only a reference: `${VAR}` after an optional scheme. */
const AUTH_REF_ONLY = /^(?:[A-Za-z][A-Za-z0-9-]*\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * Whether an `Authorization` header of `entry` holds a credential itself —
 * Python's `holds_credential`.
 *
 * `Bearer ${VAR}` (a scheme, then one variable without a default) does
 * not: Claude Code fills it in when it connects. Anything else does,
 * including a `${VAR:-default}`, whose default may be a key. Such an entry
 * never goes on a command line.
 */
export function holdsCredential(entry: unknown): boolean {
  const headers = isObject(entry) ? entry.headers : undefined;
  if (!isObject(headers)) return false;
  return Object.entries(headers).some(
    ([key, value]) =>
      key.toLowerCase() === "authorization" && !(typeof value === "string" && AUTH_REF_ONLY.test(value.trim())),
  );
}

/**
 * The variables `entry`'s headers reference without a default and that
 * are unset (or empty) here, in order of appearance, each once — Python's
 * `unset_header_vars`. Claude Code sends such a reference as literal text,
 * so the server rejects the request. Only meaningful when this
 * environment is the one Claude Code starts from.
 */
export function unsetHeaderVars(entry: unknown): string[] {
  const headers = isObject(entry) ? entry.headers : undefined;
  if (!isObject(headers)) return [];
  const names: string[] = [];
  for (const value of Object.values(headers)) {
    if (typeof value !== "string") continue;
    for (const [, name, fallback] of value.matchAll(ENV_REF)) {
      if (!fallback && !process.env[name!] && !names.includes(name!)) names.push(name!);
    }
  }
  return names;
}

/**
 * `entry` with a baked key replaced by a placeholder, for printing —
 * Python's `_redact_entry`. A `${VAR}` reference is kept: it is what the
 * user should run.
 */
function redactEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const headers = entry.headers;
  if (!isObject(headers) || !holdsCredential(entry)) return entry;
  const masked = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, k.toLowerCase() === "authorization" ? "Bearer <your-api-key>" : v]),
  );
  return { ...entry, headers: masked };
}

/** `claude mcp add-json --scope user kagura-memory`, in Python's argv order; the JSON follows. */
const CLAUDE_ADD_JSON: readonly string[] = ["mcp", "add-json", "--scope", "user", SERVER_NAME];

function claudeAddJsonArgs(entry: Record<string, unknown>): string[] {
  return [...CLAUDE_ADD_JSON, JSON.stringify(entry)];
}

/** `claude mcp remove --scope <scope> kagura-memory`. */
function claudeRemoveArgs(scope: ClaudeScope): string[] {
  return ["mcp", "remove", "--scope", scope, SERVER_NAME];
}

/** A `claude` argv as a line to paste. */
function claudeCommand(argv: string[]): string {
  return shellCommand(["claude", ...argv]);
}

/**
 * A `claude` argv as a line to paste, run in `dir` — Python's
 * `_claude_command(args, cwd=…)`. `claude mcp` resolves local and project
 * scope from the directory it runs in, so a `cd` leads when that is not
 * the current one.
 */
function claudeCommandIn(argv: string[], dir: string | null): string {
  const command = claudeCommand(argv);
  if (dir === null || dir === realProjectPath(process.cwd())) return command;
  return `cd ${shellQuote(dir)} && ${command}`;
}

/** One `kagura-memory` definition Claude Code sees for a project. */
export interface ClaudeEntry {
  scope: ClaudeScope;
  /**
   * Where it lives, for messages: {@link claudeJsonLabel}, `.mcp.json` for
   * the project's own file, or a parent directory's `.mcp.json` by its path.
   */
  source: string;
  config: Record<string, unknown>;
  /** The file it lives in: `~/.claude.json` or a `.mcp.json`, in full. */
  path: string;
}

/** The real path, as Python's `Path.resolve()` gives it, when there is one. */
export function realProjectPath(projectDir: string): string {
  try {
    return fs.realpathSync(projectDir);
  } catch {
    return path.resolve(projectDir);
  }
}

/** `target` for messages, with the home directory written `~` — Python's `_path_label`. */
function pathLabel(target: string): string {
  const rel = path.relative(os.homedir(), target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return target;
  return `~/${rel.split(path.sep).join("/")}`;
}

/**
 * Claude Code's global config — Python's `claude_json_path`:
 * `$CLAUDE_CONFIG_DIR` or the home directory, then `.claude.json`.
 */
function claudeJsonPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json");
}

/**
 * {@link claudeJsonPath} for messages — Python's `claude_json_label`:
 * `~/.claude.json` by default, the full path when `$CLAUDE_CONFIG_DIR`
 * points outside the home directory.
 */
export function claudeJsonLabel(): string {
  return pathLabel(claudeJsonPath());
}

/** How a `kagura-memory` entry authenticates; see {@link classifyMcpEntry}. */
export type McpMode = "stdio" | "static-token" | "url" | "absent";

/**
 * Remote types Claude Code accepts (`streamable-http` is an alias of
 * `http`), plus `url`, which `setup claude` wrote before and Claude Code
 * does not accept: recognised alike, so an old entry is still classified.
 */
const HTTP_TYPES: ReadonlySet<unknown> = new Set(["http", "streamable-http", "url"]);

/** The `kagura-mcp` proxy's names, as a command or a launcher's argument. */
const PROXY_NAMES: ReadonlySet<string> = new Set(["kagura-mcp", "kagura-mcp.exe"]);

/**
 * Whether the command, or an argument of a launcher, is `kagura-mcp` —
 * Python's `_runs_proxy`: by name or by path (`/venv/bin/kagura-mcp`, as a
 * `claude mcp add` entry often has, split on `/` and `\` alike), and
 * `uvx … kagura-mcp …`. An `args` that is not an array counts as absent.
 */
function runsProxy(entry: Record<string, unknown>): boolean {
  const args = Array.isArray(entry.args) ? entry.args : [];
  return [entry.command, ...args].some(
    (a) => typeof a === "string" && PROXY_NAMES.has(a.split(/[\\/]/).pop()!),
  );
}

/**
 * Classify a `kagura-memory` entry — Python's `classify_mcp_entry`, shared
 * by `setup claude`, `doctor` and `auth status`.
 *
 * - `stdio`: the refresh-aware `kagura-mcp` proxy (no type or `stdio`).
 * - `static-token`: the http form with an `Authorization` header.
 * - `url`: the http form without one (e.g. Claude Code's own OAuth).
 * - `absent`: anything else, a non-object included.
 */
export function classifyMcpEntry(entry: unknown): McpMode {
  if (!isObject(entry)) return "absent";
  const kind = entry.type;
  // Claude Code reads an entry without a type as stdio.
  if ((kind === undefined || kind === null || kind === "stdio") && runsProxy(entry)) return "stdio";
  if (HTTP_TYPES.has(kind)) {
    const headers = entry.headers;
    return isObject(headers) && Object.keys(headers).some((k) => k.toLowerCase() === "authorization")
      ? "static-token"
      : "url";
  }
  return "absent";
}

/** `directory` and each of its parents, up to the filesystem root. */
function* selfAndParents(directory: string): Generator<string> {
  for (let dir = directory; ; dir = path.dirname(dir)) {
    yield dir;
    if (path.dirname(dir) === dir) return;
  }
}

/**
 * The main working tree of the linked worktree at `directory`, else
 * `directory` — Python's `_main_worktree`. A linked worktree's `.git` file
 * names its git dir, whose `commondir` leads to the main repository's
 * `.git`; a submodule's git dir has no `commondir`.
 */
function mainWorktree(directory: string, dotGit: string): string {
  try {
    const text = fs.readFileSync(dotGit, "utf-8").trim();
    const gitdir = (text.startsWith("gitdir:") ? text.slice("gitdir:".length) : text).trim();
    const gitPath = realProjectPath(path.resolve(directory, gitdir));
    const commondir = fs.readFileSync(path.join(gitPath, "commondir"), "utf-8").trim();
    const common = realProjectPath(path.resolve(gitPath, commondir));
    return path.basename(common) === ".git" ? path.dirname(common) : directory;
  } catch {
    return directory;
  }
}

/**
 * The path Claude Code keys the project's local-scope block by — Python's
 * `_local_scope_key`. Inside a git repository that is the repository root
 * (for a linked worktree, the main working tree), whichever subdirectory
 * Claude Code runs in; elsewhere it is the project itself.
 */
function localScopeKey(project: string): string {
  for (const dir of selfAndParents(project)) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      continue;
    }
    if (stat.isDirectory()) return dir;
    if (stat.isFile()) return mainWorktree(dir, dotGit);
  }
  return project;
}

/**
 * The `.mcp.json` Claude Code takes `kagura-memory` from, and its
 * `mcpServers` — Python's `_closest_mcp_json`. Claude Code reads one in
 * every directory from the one it runs in up to the filesystem root, past
 * the repository root too, and for each server name the closest file
 * wins. `<project>/.mcp.json` when none defines `kagura-memory`.
 */
function closestMcpJson(project: string): { file: string; servers: unknown } {
  for (const dir of selfAndParents(project)) {
    const file = path.join(dir, ".mcp.json");
    const servers = readJsonLenient(file)?.mcpServers;
    if (isObject(servers) && Object.hasOwn(servers, SERVER_NAME) && isObject(servers[SERVER_NAME])) {
      return { file, servers };
    }
  }
  return { file: path.join(project, ".mcp.json"), servers: undefined };
}

/**
 * Every scope that defines `kagura-memory` for the project, strongest
 * first — the port of Python's `find_kagura_mcp_entries`. The first is the
 * entry Claude Code uses; the rest are hidden by it.
 *
 * `~/.claude.json` (under `$CLAUDE_CONFIG_DIR` when that is set) holds
 * user scope (top-level `mcpServers`) and local scope
 * (`projects[<git root or project>].mcpServers`) — and the rest of Claude
 * Code's state, so it is read here and never written. Project scope is the
 * closest `.mcp.json` that defines one, in the project or a parent; a
 * farther one is hidden by it and not listed. An entry counts only when it
 * is a JSON object: Claude Code can use nothing else.
 */
export function findClaudeEntries(projectDir: string): ClaudeEntry[] {
  const project = realProjectPath(projectDir);
  const statePath = claudeJsonPath();
  const stateLabel = claudeJsonLabel();
  const state = readJsonLenient(statePath) ?? {};

  let local: unknown;
  const projects = state.projects;
  const root = localScopeKey(project);
  // Tried with both separators: how the key is spelled on Windows is
  // Claude Code's business, not something to guess wrong about.
  for (const key of new Set([root, root.replace(/\\/g, "/")])) {
    const block = isObject(projects) && Object.hasOwn(projects, key) ? projects[key] : undefined;
    if (isObject(block)) {
      local = block.mcpServers;
      break;
    }
  }

  const mcpJson = closestMcpJson(project);
  const mcpJsonLabel = path.dirname(mcpJson.file) === project ? ".mcp.json" : pathLabel(mcpJson.file);
  const candidates: [ClaudeScope, string, string, unknown][] = [
    ["local", stateLabel, statePath, local],
    ["project", mcpJsonLabel, mcpJson.file, mcpJson.servers],
    ["user", stateLabel, statePath, state.mcpServers],
  ];
  const entries: ClaudeEntry[] = [];
  for (const [scope, source, file, servers] of candidates) {
    const config = isObject(servers) && Object.hasOwn(servers, SERVER_NAME) ? servers[SERVER_NAME] : undefined;
    if (isObject(config)) entries.push({ scope, source, config, path: file });
  }
  return entries;
}

/** Deep equality of two parsed JSON values; object key order does not count. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]))
    );
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]))
    );
  }
  return a === b;
}

/**
 * Whether two entries configure the same server — Python's
 * `same_mcp_entry`: a key with an empty value (`"env": {}`, as `claude mcp
 * add` stores it) counts as absent.
 */
function sameMcpEntry(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const significant = (entry: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(entry).filter(
        ([, v]) =>
          v !== null && !(Array.isArray(v) && v.length === 0) && !(isObject(v) && Object.keys(v).length === 0),
      ),
    );
  return sameJson(significant(a), significant(b));
}

/**
 * The id of the enabled Kagura Memory Claude plugin, or null.
 *
 * Asked of `claude plugin list --json` rather than read from Claude Code's
 * files, whose layout is its own business. No `claude`, a failed run, and
 * output that is not the expected JSON array all mean "not detected": the
 * plugin refines the setup and is never a precondition for it.
 */
async function detectClaudePlugin(
  deps: CliDeps,
  claude: string | null,
  projectDir: string,
): Promise<string | null> {
  if (claude === null) return null;
  // Run in the project: the list includes the project- and local-scope
  // plugins of the directory it runs in.
  const result = await deps.execFile(claude, ["plugin", "list", "--json"], { ...CLAUDE_EXEC, cwd: projectDir });
  if (result.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const plugin of parsed) {
    const { id, enabled } = (plugin ?? {}) as { id?: unknown; enabled?: unknown };
    // Any marketplace, or none: Python matches the name before the `@`.
    if (typeof id === "string" && id.split("@")[0] === CLAUDE_PLUGIN_NAME && enabled === true) return id;
  }
  return null;
}

/**
 * Stop before anything is written when a stronger scope would hide the
 * entry: the command would otherwise report a success that never takes
 * effect. Python's text; there `-y` refuses where a prompt would ask, and
 * this port never prompts.
 */
function refuseShadowedEntry(
  deps: CommandDeps,
  scope: ClaudeScope,
  stronger: ClaudeEntry[],
  project: string,
): never {
  deps.writeError(`  Warning: Claude Code uses the ${SERVER_NAME} entry from the strongest scope,`);
  deps.writeError(`  so in this project a ${scope}-scope entry would be hidden by:`);
  for (const e of stronger) {
    // `claude mcp remove` finds a local entry from anywhere in the
    // project, a project one only in the directory whose .mcp.json holds it.
    const dir = { local: project, project: path.dirname(e.path), user: null }[e.scope];
    deps.writeError(`    ${e.scope} scope (${e.source}) — remove it with:`);
    deps.writeError(`      ${claudeCommandIn(claudeRemoveArgs(e.scope), dir)}`);
  }
  throw new CliError(
    `Nothing was written: the ${stronger[0]!.scope}-scope ${SERVER_NAME} entry ` +
      `would hide the ${scope}-scope one. Remove it (command above) and re-run.`,
  );
}

/** Python's `_QUERY_FLAGS`: each flag and the URL parameter it sets. */
const QUERY_FLAGS = [
  ["--guardrails", "guardrails"],
  ["--tool-profile", "profile"],
] as const;

/**
 * The `--guardrails` / `--tool-profile` values an entry puts on the MCP
 * URL — Python's `_query_flags`: from the `kagura-mcp` arguments of a
 * stdio entry (which the Python CLI's `--profile` setup writes), or from
 * the first value of each parameter in an http entry's URL. An empty value
 * does not count, as `parse_qsl` drops it.
 */
function queryFlags(entry: Record<string, unknown>): Map<string, string> {
  const found = new Map<string, string>();
  if (classifyMcpEntry(entry) === "stdio") {
    const args: unknown[] = Array.isArray(entry.args) ? entry.args : [];
    const argv = args.filter((a): a is string => typeof a === "string");
    for (const [flag] of QUERY_FLAGS) {
      argv.forEach((arg, i) => {
        if (arg === flag && i + 1 < argv.length) found.set(flag, argv[i + 1]!);
        else if (arg.startsWith(`${flag}=`)) found.set(flag, arg.slice(flag.length + 1));
      });
    }
    return found;
  }
  if (typeof entry.url !== "string") return found;
  for (const [flag, key] of QUERY_FLAGS) {
    const value = queryParam(entry.url, key);
    if (value) found.set(flag, value);
  }
  return found;
}

/**
 * The note for the `--guardrails` / `--tool-profile` settings the replaced
 * entry had and the new one leaves out — Python's `_dropped_query_flags`
 * and its text. `.kagura.json` keeps `--mcp-url` as given, so a re-run
 * rebuilds the URL from its own flags alone.
 */
function droppedFlagsNote(
  scope: ClaudeScope,
  old: Record<string, unknown>,
  entry: Record<string, unknown>,
): string[] {
  const kept = queryFlags(entry);
  const dropped = [...queryFlags(old)]
    .filter(([flag]) => !kept.has(flag))
    .map(([flag, value]) => `${flag} ${value}`);
  if (dropped.length === 0) return [];
  const them = dropped.length > 1 ? "them" : "it";
  return [
    `Note: the previous ${scope}-scope entry also had ${dropped.join(" and ")}, which this run left out; ` +
      `re-run with ${them} to keep ${them}.`,
  ];
}

/**
 * Python's `_warn_tools_allowlist`: memory-cloud applies a `?tools=`
 * allowlist before it reads `profile`, so `--tool-profile` on such a URL
 * does nothing.
 */
function toolsAllowlistWarning(url: string, toolProfile: string | undefined): string[] {
  if (toolProfile === undefined || queryParam(url, "tools") === undefined) return [];
  return [
    "Warning: the MCP URL has a ?tools= allowlist, which the server applies instead of " +
      `--tool-profile ${toolProfile}.`,
  ];
}

/**
 * Write the user-scope entry through `claude`, replacing `replaces`.
 *
 * `add-json` refuses a name user scope already has, so the old entry is
 * removed first rather than kept — as with the .mcp.json entry, a stale
 * header from a previous key would keep authenticating as the old
 * identity — and put back if the add then fails. Python's
 * `_write_mcp_entry` and `_restore_user_entry`.
 */
async function writeUserEntry(
  deps: CliDeps,
  claude: string,
  input: SetupInput,
  entry: Record<string, unknown>,
  replaces: Record<string, unknown> | null,
): Promise<void> {
  const run = (argv: string[], display: string) =>
    runHarnessCli(deps, claude, argv, display, input.secrets, CLAUDE_EXEC);
  // Python's _add_user_entry: the entry goes on claude's command line,
  // which every local user can read in the process list while it runs, so
  // one that holds a credential is never passed — the new entry never
  // does, and an old one with a baked key is not put back.
  const add = async (e: Record<string, unknown>) => {
    if (holdsCredential(e)) {
      throw new CliError("the entry holds an API key, which setup never passes on a command line");
    }
    await run(claudeAddJsonArgs(e), `${claudeCommand([...CLAUDE_ADD_JSON])} '<entry>'`);
  };
  if (replaces !== null) await run(claudeRemoveArgs("user"), claudeCommand(claudeRemoveArgs("user")));
  try {
    await add(entry);
  } catch (e) {
    if (replaces === null || !(e instanceof CliError)) throw e;
    try {
      await add(replaces);
    } catch (restore) {
      // Neither entry is configured now, and the failure alone would not
      // say so. The command re-adds the old one, a baked key masked.
      deps.writeError(`  Re-add the previous user-scope ${SERVER_NAME} entry yourself:`);
      deps.writeError(`    ${claudeCommand(claudeAddJsonArgs(redactEntry(replaces)))}`);
      const reason = (restore instanceof Error ? restore.message : String(restore)).replace(/\s*\n\s*/g, " ");
      throw new CliError(
        `${e.message}\n  The previous user-scope ${SERVER_NAME} entry was removed and could not be ` +
          `restored (${reason}); the command above re-adds it.`,
      );
    }
    throw new CliError(`${e.message}\n  The previous user-scope '${SERVER_NAME}' entry was put back.`);
  }
}

async function runClaude(deps: CliDeps, args: ParsedArgs): Promise<number> {
  const input = resolveInput(args);
  const scope = parseChoice(SCOPE, args.values.scope ?? "project", CLAUDE_TARGET_SCOPES);
  const notes = toolsAllowlistWarning(input.baseUrl, input.toolProfile);
  const asked = ASKS_FOR_HOOKS.filter((name) => args.flags.has(name)).map((name) => `--${name}`);
  if (asked.length > 0) {
    notes.push(
      `${asked.join(" and ")} ${asked.length > 1 ? "do" : "does"} nothing here: ` +
        "this port installs no hooks or slash commands",
    );
  }
  const url = mcpUrlWithQuery(input.baseUrl, { guardrails: input.guardrails, profile: input.toolProfile });
  // At user scope the entry goes on `claude mcp add-json`'s command line,
  // so it names the variable Claude Code reads the key from instead; a
  // project .mcp.json is a file, 0600 and gitignored, as in Python.
  const entry = claudeEntry(url, scope === "user" ? API_KEY_REF : input.apiKey);
  const claude = deps.which("claude");

  // Where the entry lands, settled before anything is run or written —
  // Python's _plan_mcp_entry.
  const project = realProjectPath(input.projectDir);
  const entries = findClaudeEntries(input.projectDir);
  const rank = (e: ClaudeEntry) => CLAUDE_SCOPE_ORDER.indexOf(e.scope);
  const target = CLAUDE_SCOPE_ORDER.indexOf(scope);
  const stronger = entries.filter((e) => rank(e) < target);
  if (stronger.length > 0) refuseShadowedEntry(deps, scope, stronger, project);

  // The entry this write replaces. A project-scope one in a parent
  // directory's .mcp.json stays where it is: the new, closer file hides it.
  const mcpPath = path.join(input.projectDir, ".mcp.json");
  const targetFile = scope === "project" ? path.join(project, ".mcp.json") : null;
  const current = entries.find((e) => e.scope === scope && (targetFile === null || e.path === targetFile));
  const hidden = entries.filter((e) => rank(e) >= target && e !== current);
  const unchanged = scope === "user" && current !== undefined && sameMcpEntry(current.config, entry);
  const replaces = scope !== "user" || unchanged ? null : (current?.config ?? null);

  // Read before anything is run or written, so an .mcp.json this cannot
  // parse or extend stops the command with nothing changed.
  let mcp: Record<string, unknown> | null = null;
  if (scope === "project") {
    mcp = readJsonSafe(mcpPath);
    if (mcp.mcpServers !== undefined && !isObject(mcp.mcpServers)) {
      // Set on an array, the entry would vanish in JSON.stringify.
      throw new CliError(`refusing to rewrite ${mcpPath}: its mcpServers is not a JSON object`);
    }
  }
  if (scope === "user" && !unchanged && claude === null) {
    // This bin never edits ~/.claude.json itself: Claude Code owns it. The
    // command is ready to run as printed: single-quoted, the reference
    // reaches add-json as written, and no key is in it.
    deps.writeError("  Add the user-scope entry yourself, then re-run this setup:");
    if (replaces !== null) deps.writeError(`    ${claudeCommand(claudeRemoveArgs("user"))}`);
    deps.writeError(`    ${claudeCommand(claudeAddJsonArgs(redactEntry(entry)))}`);
    // Python's note, less the line on this shell: what matters is the
    // environment the pasted command's Claude Code starts from.
    for (const line of KEY_ENV_NOTE) deps.writeError(`  ${line}`);
    throw new CliError(
      "The Claude Code CLI (`claude`) was not found on PATH (a Windows .cmd shim is not run: it " +
        `needs a shell). A user-scope entry lives in ${claudeJsonLabel()}, which Claude Code owns, so ` +
        "setup writes it only through `claude mcp add-json`. Nothing was written.",
    );
  }

  const pluginId = await detectClaudePlugin(deps, claude, input.projectDir);

  const wrote: string[] = [];
  const secretFiles = [".kagura.json"];
  let appliedWith: string | null = null;

  if (scope === "user") {
    const label = claudeJsonLabel();
    if (unchanged) {
      notes.push(`User-scope ${SERVER_NAME} entry already up to date (${label})`);
    } else {
      // `claude` first, so one that refuses the entry leaves every file as
      // it was. (Python writes .kagura.json before it runs claude.)
      await writeUserEntry(deps, claude!, input, entry, replaces);
      // The argv holds no secret, so it is shown as it ran.
      appliedWith = claudeCommand(claudeAddJsonArgs(entry));
      notes.push(
        replaces !== null
          ? `Replaced the existing user-scope ${SERVER_NAME} entry (${label})`
          : `Added ${SERVER_NAME} at user scope (${label})`,
      );
    }
    // After an add, a replace or an unchanged entry alike, as in Python.
    notes.push(KEY_ENV_NOTE.join(" "), keyEnvState(input.apiKey));
    // .kagura.json keeps the key at both scopes: this bin reads it there.
    wrote.push(writeKaguraJson(input));
  } else {
    wrote.push(writeKaguraJson(input));
    const servers = isObject(mcp!.mcpServers) ? mcp!.mcpServers : {};
    // The entry is replaced wholesale rather than merged: a stale header
    // from a previous key would keep authenticating as the old identity.
    servers[SERVER_NAME] = entry;
    mcp!.mcpServers = servers;
    writeJson(mcpPath, mcp!);
    wrote.push(mcpPath);
    secretFiles.push(".mcp.json");
    notes.push(
      "Claude Code asks once to approve a project .mcp.json server; then check: " +
        `claude mcp get ${SERVER_NAME}`,
    );
  }

  for (const e of hidden) {
    notes.push(
      `Note: in this project it hides the ${SERVER_NAME} entry in ${e.scope} scope (${e.source}); ` +
        "editing that entry has no effect here.",
    );
  }
  if (current !== undefined) notes.push(...droppedFlagsNote(scope, current.config, entry));

  if (pluginId !== null) {
    // Python's notes, one per paragraph. Never set on the user's behalf:
    // off also removes the get_context_info block.
    notes.push(
      `${pluginId} delivers tool guardrails through its own hooks once you configure them ` +
        "(/kagura-memory:setup).",
    );
    // The URL decides, not the flag alone as in Python: a guardrails=off
    // already in --mcp-url needs no re-run either.
    if (queryParam(url, "guardrails")?.trim().toLowerCase() !== "off") {
      notes.push(
        "Then re-run this setup with --guardrails off so the server does not also send a guardrail " +
          "digest. 'off' also removes the guardrails block from get_context_info, so set it only " +
          "once the hooks deliver guardrails.",
      );
    }
    // Python resolves a context always; this bin makes no call to pick one.
    notes.push(
      "Plugin settings (/plugin > kagura-memory > Configure): " +
        `server_url = ${pluginServerUrl(url)}, ` +
        `context_id = ${input.contextId || "(none; pass -c)"}`,
      "The plugin has ONE guardrail context for every project: use this one only if it holds the " +
        "guardrails you want everywhere.",
      // The hooks' own requirement, whichever entry this setup wrote.
      "api_key: enter it yourself, a user API key (kagura_...). The plugin's hooks authenticate only with one.",
    );
  }

  const gitignoreAdded = protectSecrets(input.projectDir, secretFiles);
  return report(deps, input, { status: "success", wrote, gitignoreAdded, url, appliedWith, notes });
}

// --- codex, hermes, openclaw ----------------------------------------------

type HarnessName = Exclude<Harness, "claude">;

/**
 * Python's `_HARNESS_TIMEOUT_SEC`, for every `codex` and `openclaw` run:
 * `openclaw mcp add` can start the server to probe it before it saves.
 */
const HARNESS_TIMEOUT_S = 120;
const HARNESS_EXEC: ExecOptions = { timeoutMs: HARNESS_TIMEOUT_S * 1000 };

/** Python's `_ENV_NAME_RE`: OpenClaw substitutes only upper-case `${VAR}` names. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** What `setup codex | hermes | openclaw` resolve before touching anything. */
interface HarnessInput {
  harness: HarnessName;
  name: string;
  /** `--project-dir`, resolved, for the report alone: nothing is read or written there. */
  projectDir: string;
  /** As given or configured; the flags' query parameters go on top. */
  baseUrl: string;
  /** Whether baseUrl came from `--mcp-url`, rather than the configuration. */
  urlFlag: boolean;
  contextId: string;
  /** `-c` was passed, rather than read from the configuration. */
  contextFlag: boolean;
  /** `--guardrails`, validated and normalised; undefined when absent. */
  guardrails: string | undefined;
  /** `--tool-profile`, trimmed; undefined when absent or not taken. */
  toolProfile: string | undefined;
  /** The variable the entry reads the key from. */
  keyEnv: string;
  /** Every key this process knows of ({@link knownKeys}), cut out of whatever a harness CLI prints. */
  secrets: string[];
  force: boolean;
  dryRun: boolean;
  /** Notes on the flags that change nothing here. */
  notes: string[];
}

/**
 * Refuse a plain-HTTP MCP URL other than localhost — Python's check of
 * `--mcp-url`, whose entry sends the key there with every request.
 */
function requireHttps(url: string, fromFlag: boolean): void {
  try {
    validateHttpsUrl(url, "MCP URL");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (fromFlag) throw new CliUsageError(`Invalid value for '--mcp-url': ${reason}`);
    // Python takes the URL from the flag alone; this port falls back to
    // the configured one, which is no usage error.
    throw new CliError(`the configured mcp_url is refused: ${reason} Pass --mcp-url for another.`);
  }
}

/**
 * The variable the entry reads the key from: `--api-key-env` (Codex and
 * OpenClaw), the one Hermes derives from the name, or KAGURA_API_KEY —
 * Python's `key_env`, validated as Python does.
 */
function parseKeyEnv(raw: string | undefined, harness: HarnessName, name: string): string {
  if (harness === "hermes") {
    const own = hermesEnvVar(name);
    if (raw !== undefined) {
      throw new CliUsageError(`${LABEL.hermes} names the variable itself (${own}); drop --api-key-env.`);
    }
    return own;
  }
  if (raw === undefined) return KEY_ENV_VAR;
  if (!ENV_NAME.test(raw)) {
    throw new CliUsageError(
      "Invalid value for '--api-key-env': use an upper-case variable name, e.g. KAGURA_API_KEY",
    );
  }
  return raw;
}

function resolveHarnessInput(deps: CommandDeps, args: ParsedArgs, harness: HarnessName): HarnessInput {
  // The name first: a usage error, as click reports before it runs anything.
  const name = parseName(args);
  rejectExtraArgs(args);
  const guardrails = parseGuardrails(args.values.guardrails);
  const toolProfile = parseToolProfile(args.values["tool-profile"]);
  // Then Python's _check_flags, in its order, each a usage error. The
  // --profile refusal (exit 1) comes last, so that `--profile p
  // --guardrails off` is the usage error it is in Python.
  const urlArg = args.values["mcp-url"];
  if (urlArg !== undefined) requireHttps(urlArg, true);
  const keyEnv = parseKeyEnv(args.values["api-key-env"], harness, name);
  refuseProfileWithKey(args);
  if (guardrails === "off" && NO_INSTRUCTIONS.has(harness)) throw refuseGuardrailsOff(harness);
  const profile = args.values.profile;
  if (profile !== undefined && !args.flags.has("url-form")) throw refuseProfile(harness, profile);

  // For the URL and context fallbacks alone: no key is taken from it.
  // Python never reads it, so with --mcp-url one that cannot be loaded
  // stops nothing; the context fallback only fills in the report. Without
  // --mcp-url the loader's error stops the run: it names the file and
  // never quotes it, which can hold a key.
  const notes: string[] = [];
  let config: KaguraConfig = {};
  try {
    ({ config } = resolveConfig(deps, undefined, false));
  } catch (e) {
    if (urlArg === undefined) throw e;
    notes.push(
      "Note: the configuration (.kagura.json) could not be loaded, so setup went on without it: " +
        "--mcp-url gives the URL.",
    );
  }
  const baseUrl =
    urlArg ?? (typeof config.mcp_url === "string" && config.mcp_url ? config.mcp_url : DEFAULT_MCP_URL);
  if (urlArg === undefined) requireHttps(baseUrl, false);
  const contextFlag = Boolean(args.values["context-id"]);
  const contextId = args.values["context-id"] || config.context_id || "";

  // The options v0.10 took, and the Python CLI's that need what this port
  // lacks: accepted, so a script still runs, and said to change nothing.
  const label = LABEL[harness];
  const apiKey = args.values["api-key"];
  if (apiKey !== undefined) {
    notes.push(
      `Note: --api-key is not stored or used: the ${label} entry reads the key from $${keyEnv}, ` +
        "and setup never handles the key.",
    );
  }
  if (args.values["project-dir"] !== undefined) {
    notes.push(
      `Note: --project-dir is not used: the ${label} entry is per user, and harness setups write no ` +
        ".kagura.json or .gitignore.",
    );
  }
  // Python's URL form uses the profile to list contexts and fetch the
  // AGENTS.md export, and checks it against the server; this port does
  // neither, and never contacts the server.
  if (profile !== undefined) {
    notes.push("Note: --profile is not used: this port lists no contexts and writes no AGENTS.md export.");
  }
  if (contextFlag && NO_INSTRUCTIONS.has(harness)) {
    notes.push(
      `Note: --context-id is not used: ${label} does not read MCP instructions, and this port writes ` +
        "no AGENTS.md export.",
    );
  }

  return {
    harness,
    name,
    projectDir: path.resolve(args.values["project-dir"] ?? "."),
    baseUrl,
    urlFlag: urlArg !== undefined,
    contextId,
    contextFlag,
    guardrails,
    toolProfile,
    keyEnv,
    secrets: knownKeys(apiKey, config.api_key, process.env[keyEnv]),
    force: args.flags.has("force"),
    dryRun: args.flags.has("dry-run"),
    notes,
  };
}

interface HarnessPlan {
  input: HarnessInput;
  /** The URL in the entry, query included. */
  url: string;
  /** The harness config file the entry belongs in. */
  configPath: string;
  /** Whether this bin's scan of configPath found an entry of this name. */
  found: boolean;
  /**
   * Whether that entry stops a run without --force. Python reads a Codex
   * entry from config.toml itself, but finds a Hermes or OpenClaw one only
   * through their CLI, and without it prints the block; so does this port,
   * the scan then only saying to put the block in place of the old entry.
   */
  stops: boolean;
  /** The entry as the user would add it to configPath. */
  block: string;
  /** Where in configPath the block goes: "it", or a part of it. */
  blockTarget: string;
  /** The harness CLI that applies the entry, or why setup prints the block instead. */
  cli: { program: string; file: string; argv: string[] } | { program: null; reason: string };
  /** Notes for before the command, where Python prints them. */
  notes: string[];
  /** Python's closing notes: after a real run or the printed block, not a dry run. */
  after: string[];
}

/**
 * Run `codex` or `openclaw` with Python's timeout, failing in Python's
 * words: `` `codex mcp add` failed: `` and what it printed, every known key
 * cut out ({@link redactKeys}), its exit code when it printed nothing, or
 * the timeout.
 */
async function runHarnessCommand(
  deps: CliDeps,
  file: string,
  program: string,
  argv: string[],
  secrets: string[],
): Promise<void> {
  const result = await deps.execFile(file, argv, HARNESS_EXEC);
  const command = `\`${[program, ...argv.slice(0, 2)].join(" ")}\``;
  // Before the exit code: a run killed at the timeout failed, as in
  // Python, whatever code it reported.
  if (result.timedOut) throw new CliError(`${command} failed: timed out after ${HARNESS_TIMEOUT_S}s`);
  if (result.code === 0) return;
  const detail = redactKeys(result.stderr.trim() || result.stdout.trim(), secrets);
  throw new CliError(`${command} failed: ${detail || `exit code ${result.code}`}`);
}

/**
 * Carry out a plan: apply the entry through the harness CLI or print it,
 * then report. Nothing is written here; Python's messages go in `notes`.
 */
async function applyPlan(deps: CliDeps, plan: HarnessPlan): Promise<number> {
  const { input } = plan;
  const where = pathLabel(plan.configPath);
  const notes = input.dryRun ? ["Dry run: nothing is written, run or fetched."] : [];
  notes.push(...input.notes);

  const stops = plan.found && plan.stops && !input.force;
  if (stops) {
    const stop = `a ${input.name} entry already exists in ${where}; re-run with --force to replace it`;
    if (!input.dryRun) throw new CliError(`Nothing was written: ${stop}.`);
    notes.push(`Setup would stop here: ${stop}.`);
  }
  notes.push(...plan.notes);

  let appliedWith: string | null = null;
  if (plan.cli.program !== null) {
    const { program, file, argv } = plan.cli;
    const display = shellCommand([program, ...argv]);
    if (input.dryRun) {
      notes.push(`${stops ? "With --force, would run" : "Would run"}: ${display}`);
      printBlock(deps, `Would configure ${where}:`, plan.block);
    } else {
      await runHarnessCommand(deps, file, program, argv, input.secrets);
      appliedWith = display;
      notes.push(`Done: ${program} wrote ${input.name} to ${where}.`);
    }
  } else {
    const replace = plan.found ? " in place of the existing one" : "";
    const edits = `Setup does not edit ${where} itself (${plan.cli.reason}).`;
    printBlock(deps, `${edits}\nAdd this ${input.name} entry to ${plan.blockTarget}${replace}:`, plan.block);
    notes.push(`${edits} Add the ${input.name} entry printed on stderr to ${plan.blockTarget}${replace}.`);
  }
  if (!input.dryRun) notes.push(...plan.after);

  return report(deps, input, {
    status: input.dryRun ? "dry_run" : "success",
    wrote: [],
    gitignoreAdded: [],
    url: plan.url,
    appliedWith,
    notes,
  });
}

/** The prefix of the Kagura plugin's Codex data directories. */
const CODEX_PLUGIN_DATA_PREFIX = "kagura-memory-";
/** The table the plugin's hooks read when their config.json names none. */
const CODEX_HOOKS_DEFAULT_SERVER = "kagura-memory";
/** The hooks treat a larger config.json as unreadable. */
const CODEX_HOOKS_CONFIG_CAP = 64 * 1024;

/**
 * Whether the Kagura plugin's Codex hooks read the `name` entry — Python's
 * `codex_hooks_enabled`.
 *
 * Turning them on writes a `config.json` into the plugin's data directory,
 * and its `mcp_server` names the table they take their credential from
 * (`kagura-memory` when absent). A file the hooks cannot use — unreadable,
 * over 64 KiB, not a JSON object — leaves them idle, here as in the hooks.
 * Nothing read from it is echoed.
 */
function codexHooksEnabled(codexHome: string, name: string): boolean {
  const dataDir = path.join(codexHome, "plugins", "data");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(dataDir);
  } catch {
    return false;
  }
  return dirs.some((dir) => {
    if (!dir.startsWith(CODEX_PLUGIN_DATA_PREFIX)) return false;
    const file = path.join(dataDir, dir, "config.json");
    let settings: unknown;
    try {
      if (fs.statSync(file).size > CODEX_HOOKS_CONFIG_CAP) return false;
      // Python decodes the bytes itself, a UTF-8 BOM included.
      settings = JSON.parse(fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, ""));
    } catch {
      return false;
    }
    if (!isObject(settings)) return false;
    const server = settings.mcp_server ?? CODEX_HOOKS_DEFAULT_SERVER;
    return server === name;
  });
}

/**
 * Python's closing notes on a Codex entry whose URL names a guardrails
 * context. Its preview command is the Python CLI's: this port has no
 * `guardrails digest` yet.
 */
function codexDigestNotes(context: string, url: string, keyEnv: string): string[] {
  // On the entry's own credential: its key variable, on its server.
  const env = keyEnv === KEY_ENV_VAR ? [] : [`KAGURA_API_KEY="\${${keyEnv}}"`];
  env.push(`KAGURA_MCP_URL=${shellQuote(url)}`);
  const preview = [...env, shellCommand(["kagura", "guardrails", "digest", context, "--target", "instructions"])];
  return [
    `Codex should get the tool guardrail digest of context ${context} in the MCP instructions when ` +
      "it connects. The server sends only its base text instead when the entry's credential cannot " +
      "read that context, the context has no guardrails, or the deployment turns the digest off. " +
      `Preview what it sends with the Python CLI: ${preview.join(" ")}`,
    "Use a context whose editor list you control: every editor's guardrail summaries reach the model.",
  ];
}

async function runCodex(deps: CliDeps, args: ParsedArgs): Promise<number> {
  const input = resolveHarnessInput(deps, args, "codex");
  const { name, keyEnv } = input;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");
  const found = tomlHasServer(readText(configPath), name);

  // Codex reads the server's instructions, so guardrails take effect
  // here. A value already in the URL, from --mcp-url or the configured
  // mcp_url, is kept as written.
  const notes: string[] = [];
  let guardrails = input.guardrails;
  if (guardrails === undefined && queryParam(input.baseUrl, "guardrails") === undefined) {
    if (codexHooksEnabled(codexHome, name)) {
      // The plugin's hooks read this same table and deliver the
      // guardrails themselves; the server need not repeat them.
      guardrails = "off";
      notes.push(
        "The plugin's hooks deliver guardrails, so the URL gets ?guardrails=off (the hooks' own " +
          "setup asks for it; --guardrails overrides).",
      );
    } else if (input.contextFlag) {
      if (isUuid(input.contextId)) {
        guardrails = parseUuid(input.contextId);
      } else {
        // Python lists the profile's contexts to resolve a name; this port
        // makes no call to do so.
        notes.push(
          `Note: --context-id ${quote(input.contextId)} is not a UUID, so it was not used for ` +
            "guardrails: this port looks up no context names.",
        );
      }
    }
  }
  notes.push(...toolsAllowlistWarning(input.baseUrl, input.toolProfile));
  const url = mcpUrlWithQuery(input.baseUrl, { guardrails, profile: input.toolProfile });

  const after = [
    `Codex reads the API key from $${keyEnv} when it connects: set it in the environment that ` +
      `starts Codex, e.g. \`export ${keyEnv}=<your-api-key>\` in your shell profile. ` +
      "(Codex refuses an inline bearer_token on a URL entry.)",
  ];
  const lane = queryParam(url, "guardrails");
  if (lane !== undefined && isUuid(lane)) after.push(...codexDigestNotes(parseUuid(lane), url, keyEnv));
  after.push(
    "Restart Codex (or start a new session) to load the entry.",
    `Check it with: ${shellCommand(["codex", "mcp", "get", name])}`,
  );

  const codex = deps.which("codex");
  return applyPlan(deps, {
    input,
    url,
    configPath,
    found,
    stops: true,
    block: codexTomlBlock(name, url, keyEnv),
    blockTarget: "it",
    // Naming an env var also makes Codex skip its OAuth probe. `add`
    // overwrites an entry of the same name, so --force needs no `codex mcp
    // remove` first, as Python runs; the existence check is what makes
    // that overwrite opt-in.
    cli:
      codex === null
        ? { program: null, reason: notOnPath("codex") }
        : {
            program: "codex",
            file: codex,
            argv: ["mcp", "add", name, "--url", url, "--bearer-token-env-var", keyEnv],
          },
    notes,
    after,
  });
}

/**
 * The entry URL for a harness that does not read the server's
 * instructions, with Python's warnings: a `--guardrails` context and one
 * in the URL are not written, and a `guardrails=off` in the URL is kept,
 * though it takes away the one lane left. The flag's `off` never gets
 * here: it is refused.
 */
function urlForNoInstructions(input: HarnessInput, notes: string[]): string {
  const title = LABEL[input.harness];
  const reach = `Guardrails reach ${title} through get_context_info (on by default).`;
  if (input.guardrails !== undefined) {
    notes.push(
      `Warning: ${title} does not read MCP instructions, so --guardrails has no effect there and is ` +
        `not written. ${reach}`,
    );
  }
  const value = queryParam(input.baseUrl, "guardrails");
  if (value === undefined) return input.baseUrl;
  if (value.trim().toLowerCase() === "off") {
    notes.push(
      `Warning: ${input.urlFlag ? "--mcp-url" : "the MCP URL"} has ?guardrails=off, which removes the ` +
        `guardrails block from get_context_info: ${title} then gets no guardrails from Kagura.`,
    );
    return input.baseUrl;
  }
  // Python keeps it; its own README says a context id is never written
  // into their entry.
  notes.push(
    `Warning: ${title} does not read MCP instructions, so the MCP URL's ?guardrails=${value} has no ` +
      `effect there and is not written. ${reach}`,
  );
  return withoutQueryParam(input.baseUrl, "guardrails");
}

/** Python's `str.strip()` whitespace, which unlike `trim` leaves a BOM. */
const PY_SPACE = "[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, "g");
/** The full case folds `toLowerCase` lacks that yield ASCII: ß, long s and the Latin ligatures. */
const FOLDS: Record<string, string> = {
  "\u00df": "ss",
  "\u017f": "s",
  "\ufb00": "ff",
  "\ufb01": "fi",
  "\ufb02": "fl",
  "\ufb03": "ffi",
  "\ufb04": "ffl",
  "\ufb05": "st",
  "\ufb06": "st",
};

/**
 * Python's `str.casefold()`, as far as an ASCII-only check of the result
 * can tell: every other fold that yields ASCII is `toLowerCase`'s too.
 */
function casefold(text: string): string {
  return text.toLowerCase().replace(/[\u00df\u017f\ufb00-\ufb06]/g, (c) => FOLDS[c]!);
}

/**
 * Where Hermes keeps `config.yaml` and `.env` for its active profile —
 * Python's `hermes_home`: `$HERMES_HOME`, else the sticky profile
 * `~/.hermes/active_profile` names (`~/.hermes/profiles/<name>`), else
 * `~/.hermes`. An unreadable file names none, and neither does `default`.
 */
function hermesHome(): string {
  const env = process.env.HERMES_HOME;
  if (env) return env;
  const root = path.join(os.homedir(), ".hermes");
  let active = "";
  try {
    active = casefold(fs.readFileSync(path.join(root, "active_profile"), "utf-8").replace(PY_STRIP, ""));
  } catch {
    active = "";
  }
  if (active !== "default" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(active)) {
    return path.join(root, "profiles", active);
  }
  return root;
}

async function runHermes(deps: CliDeps, args: ParsedArgs): Promise<number> {
  const input = resolveHarnessInput(deps, args, "hermes");
  const { name, keyEnv } = input;
  const home = hermesHome();
  const configPath = path.join(home, "config.yaml");
  const where = pathLabel(configPath);
  const notes: string[] = [];
  const text = readTextToScan(configPath, name, notes);
  const url = urlForNoInstructions(input, notes);

  // With a top-level mcp_servers key already there, the whole block pasted
  // in as printed would be a second one, and YAML keeps only the last: the
  // servers under the first would be gone without an error.
  const indent = yamlServersIndent(text);
  if (indent !== null) {
    notes.push(
      `${where} already has a top-level mcp_servers: key, so only the ${name} entry is printed: a ` +
        "second mcp_servers: key would replace the first, and the servers under it with it",
    );
    if (yamlServersInline(text)) {
      notes.push(
        `${where} writes its mcp_servers value inline (flow style or null); rewrite it as a block ` +
          `mapping, one server per indented key, before adding the ${name} entry under it`,
      );
    }
  }

  const hermes = deps.which("hermes");
  return applyPlan(deps, {
    input,
    url,
    configPath,
    found: yamlHasServer(text, name),
    stops: hermes !== null,
    block: hermesYamlBlock(name, url, keyEnv, indent ?? undefined),
    blockTarget: indent === null ? "it" : "its mcp_servers: mapping",
    // Never run: `hermes mcp add` prompts for the key and the tools to
    // enable, and this port never hands a CLI the terminal. Python's -y.
    cli: {
      program: null,
      reason: hermes === null ? notOnPath("hermes") : "`hermes mcp add` is interactive and this port never prompts",
    },
    notes,
    // Hermes resolves ${VAR} in config.yaml from its environment and from
    // the .env beside it.
    after: [
      `Add \`${keyEnv}=<your-api-key>\` to ${pathLabel(path.join(home, ".env"))} with an editor: the ` +
        "entry reads it from there, and setup never sees the key.",
      `Check it with: ${shellCommand(["hermes", "mcp", "test", name])}`,
    ],
  });
}

async function runOpenclaw(deps: CliDeps, args: ParsedArgs): Promise<number> {
  const input = resolveHarnessInput(deps, args, "openclaw");
  const { name, keyEnv } = input;
  // $OPENCLAW_STATE_DIR too, which Python's paths leave out.
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
  const notes: string[] = [];
  const found = json5HasServer(readTextToScan(configPath, name, notes), name);
  const url = urlForNoInstructions(input, notes);

  // `add` refuses a name that exists, so replacing one goes through `set`,
  // as in Python; so does any --force run, since the scan could miss an
  // entry OpenClaw has, and `set` adds one too. --no-probe: the key is not
  // in the .env yet.
  const argv =
    found || input.force
      ? ["mcp", "set", name, JSON.stringify(openclawEntry(url, keyEnv))]
      : [
          "mcp",
          "add",
          name,
          "--url",
          url,
          "--transport",
          "streamable-http",
          "--header",
          `Authorization=Bearer \${${keyEnv}}`,
          "--no-probe",
        ];

  const openclaw = deps.which("openclaw");
  return applyPlan(deps, {
    input,
    url,
    configPath,
    found,
    stops: openclaw !== null,
    block: openclawBlock(name, url, keyEnv),
    blockTarget: "it",
    cli:
      openclaw === null
        ? { program: null, reason: notOnPath("openclaw") }
        : { program: "openclaw", file: openclaw, argv },
    notes,
    after: [
      `Add \`${keyEnv}=<your-api-key>\` to ${pathLabel(path.join(stateDir, ".env"))} with an editor: ` +
        `the entry sends \${${keyEnv}} (mcp.servers headers take no SecretRef), and setup never sees ` +
        "the key.",
      "The Gateway hot-reloads the file. MCP tools appear in OpenClaw's coding and messaging tool " +
        "profiles, not in minimal.",
      `Check it with: ${shellCommand(["openclaw", "mcp", "doctor", name, "--probe"])}`,
    ],
  });
}

const claude: Command = {
  summary: "Set up Kagura Memory integration for Claude Code.",
  description:
    '  Writes .kagura.json and a type "http" kagura-memory entry. --scope\n' +
    "  project puts the key in .mcp.json (0600, gitignored). --scope user runs\n" +
    "  `claude mcp add-json --scope user kagura-memory '<entry>'` with an entry\n" +
    "  that sends Bearer ${KAGURA_MCP_API_KEY}, which Claude Code reads from\n" +
    "  its environment when it connects: the key is on no command line and\n" +
    "  not in ~/.claude.json, and setup says whether this shell has the\n" +
    "  variable. A different user-scope entry is replaced (`claude mcp remove`\n" +
    "  runs first, and the old entry is put back if the add fails, unless it\n" +
    "  holds a key: then its re-add command is printed, the key masked); an\n" +
    "  identical one is left as it is. ~/.claude.json ($CLAUDE_CONFIG_DIR's\n" +
    "  when set) is read, never written: an entry in a stronger scope (local >\n" +
    "  project > user) would hide the new one, so it stops the command. Local\n" +
    "  scope is the git repository's (a linked worktree's main working tree),\n" +
    "  and project scope the closest .mcp.json defining kagura-memory, here or\n" +
    "  in a parent directory, as Claude Code reads them. A re-run without\n" +
    "  --guardrails or --tool-profile drops an earlier value, and says so.\n\n" +
    "  This port installs no hooks or slash commands: the Python CLI's flags\n" +
    "  for them, and --no-auto-context, are accepted and change nothing.\n\n" +
    GUARDRAILS_ADVICE,
  spec: { flags: [...COMMON_FLAGS, GUARDRAILS, SCOPE, TOOL_PROFILE, ...PYTHON_ONLY_FLAGS] },
  run: (deps, args) => runClaude(deps as CliDeps, args),
};

const codex: Command = {
  summary: "Set up Kagura Memory for OpenAI Codex (CLI and IDE extension).",
  description:
    "  Adds the kagura-memory MCP server with `codex mcp add NAME --url URL\n" +
    "  --bearer-token-env-var KAGURA_API_KEY`, which writes ~/.codex/config.toml\n" +
    "  ($CODEX_HOME); with --force it replaces an entry of that name, which\n" +
    "  the add overwrites. Without codex on PATH, setup prints the\n" +
    "  [mcp_servers] table to add instead. The entry names the variable Codex\n" +
    "  reads the API key from when it connects (--api-key-env renames it):\n" +
    "  setup never sees the key, and writes no file itself. Check it with:\n" +
    "  codex mcp get kagura-memory.\n\n" +
    "  Codex reads the server's MCP instructions, so --context-id (a UUID) or\n" +
    "  --guardrails CONTEXT_ID puts that context's tool guardrail digest in\n" +
    "  them. While the kagura-memory Codex plugin's guardrail hooks are on for\n" +
    "  the entry, they deliver guardrails themselves, and the URL gets\n" +
    "  ?guardrails=off instead. A guardrails value already in the MCP URL\n" +
    "  (--mcp-url or the configured mcp_url) is kept.\n\n" +
    GUARDRAILS_ADVICE,
  spec: {
    flags: [
      HARNESS_PROFILE,
      NAME,
      CODEX_CONTEXT_ID,
      CODEX_GUARDRAILS,
      TOOL_PROFILE,
      ...HARNESS_TAIL,
      apiKeyEnv(
        "The variable Codex reads the API key from (bearer_token_env_var; default KAGURA_API_KEY, " +
          "which every kagura-memory command also ranks above OAuth profiles)",
      ),
      ...HARNESS_END,
    ],
  },
  run: (deps, args) => runCodex(deps as CliDeps, args),
};

const hermes: Command = {
  summary: "Set up Kagura Memory for Hermes Agent.",
  description:
    "  Prints the mcp_servers block and the config.yaml to add it to\n" +
    "  ($HERMES_HOME, or the active Hermes profile's:\n" +
    "  ~/.hermes/profiles/<name> when ~/.hermes/active_profile names one,\n" +
    "  else ~/.hermes), and changes nothing: `hermes mcp add` is interactive\n" +
    "  and this port never prompts. When config.yaml already has an\n" +
    "  mcp_servers key, the entry alone is printed, to go under it. The entry\n" +
    "  reads the API key from MCP_<NAME>_API_KEY (MCP_KAGURA_MEMORY_API_KEY by\n" +
    "  default), the variable `hermes mcp add` derives from --name, in the\n" +
    "  .env beside config.yaml: add the key there yourself; setup never sees\n" +
    "  it. Check it with: hermes mcp test kagura-memory.\n\n" +
    "  Hermes does not read MCP instructions: guardrails reach it through\n" +
    "  get_context_info (on by default). --guardrails off is refused, and a\n" +
    "  context id, from the flag or the URL, is not written; a ?guardrails=off\n" +
    "  already in the URL is kept, with a warning.",
  spec: {
    flags: [
      HARNESS_PROFILE,
      NAME,
      UNUSED_CONTEXT_ID,
      guardrailsNotWritten("Hermes"),
      ...HARNESS_TAIL,
      apiKeyEnv("Not accepted: Hermes names the variable MCP_<NAME>_API_KEY"),
      ...HARNESS_END,
    ],
  },
  run: (deps, args) => runHermes(deps as CliDeps, args),
};

const openclaw: Command = {
  summary: "Set up Kagura Memory for OpenClaw.",
  description:
    "  Adds the kagura-memory MCP server with `openclaw mcp add NAME --url URL\n" +
    "  --transport streamable-http --header 'Authorization=Bearer\n" +
    "  ${KAGURA_API_KEY}' --no-probe`; --force replaces an entry with\n" +
    "  `openclaw mcp set`. Both write $OPENCLAW_CONFIG_PATH (default\n" +
    "  openclaw.json in the state directory, $OPENCLAW_STATE_DIR or\n" +
    "  ~/.openclaw), which the Gateway hot-reloads. Without openclaw on PATH,\n" +
    "  setup prints the mcp.servers block instead. OpenClaw fills in\n" +
    "  ${KAGURA_API_KEY} (--api-key-env renames it) from the .env in its\n" +
    "  state directory: add the key there yourself; setup never sees it.\n" +
    "  Check it with: openclaw mcp doctor kagura-memory --probe.\n\n" +
    "  OpenClaw does not read MCP instructions: guardrails reach it through\n" +
    "  get_context_info (on by default). As on Hermes, --guardrails off is\n" +
    "  refused, and a context id, from the flag or the URL, is not written; a\n" +
    "  ?guardrails=off already in the URL is kept, with a warning.",
  spec: {
    flags: [
      HARNESS_PROFILE,
      NAME,
      UNUSED_CONTEXT_ID,
      guardrailsNotWritten("OpenClaw"),
      ...HARNESS_TAIL,
      apiKeyEnv(
        "The variable the Authorization header references, kept in ~/.openclaw/.env " +
          "($OPENCLAW_STATE_DIR/.env when set; default KAGURA_API_KEY)",
      ),
      ...HARNESS_END,
    ],
  },
  run: (deps, args) => runOpenclaw(deps as CliDeps, args),
};

export const SETUP_GROUP: CommandGroup = {
  summary: "Set up Kagura integrations for AI coding tools.",
  commands: { claude, codex, hermes, openclaw },
};
