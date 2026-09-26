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
 * where the user puts the key. They write no config file themselves
 * either; the one file they may write is the AGENTS.md export
 * (`--agents-md`), a context's tool guardrail block spliced into a file the
 * harness loads every session.
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

import { loadCredentialsFile, type CredentialsFile } from "../../auth/credentials.js";
import { DEFAULT_MCP_URL } from "../../auth/resolve.js";
import { SOURCE_LABEL, type ResolvedAuth } from "../../auth/types.js";
import { jsonErrorWhere, type KaguraConfig } from "../../config.js";
import { KaguraAuthError, KaguraNotFoundError, excMessage } from "../../errors.js";
import { hasGuardrailBlock, writeGuardrailBlock, type GuardrailBlockStatus } from "../../guardrailExport.js";
import { baseUrlFromMcp, validateHttpsUrl } from "../../http.js";
import type { GuardrailDigest } from "../../models.js";
import { normalizeUuid, pyStrip } from "../../pyCompat.js";
import { pyRepr, pyTruthy } from "../../python.js";
import { isUuid, parseUuid } from "../../uuid.js";
import { examples, rejectExtraArgs, type Command, type CommandDeps, type CommandGroup } from "../command.js";
import type { ExecOptions } from "../exec.js";
import { formatJson } from "../output.js";
import { pathlibString } from "../pathlib.js";
import { CliError, CliUsageError, parseChoice, quote } from "../parse.js";
import type { FlagSpec, ParsedArgs } from "../parseArgs.js";
import type { CliDeps } from "../run.js";
import { resolveConfig } from "../runClientCommand.js";
import {
  KEY_ENV_VAR,
  codexTomlBlock,
  codexTomlOauthBlock,
  hermesEnvVar,
  hermesYamlBlock,
  hermesYamlOauthBlock,
  isHttpUrl,
  json5HasServer,
  mcpUrlWithQuery,
  normalizeUrl,
  openclawBlock,
  openclawEntry,
  openclawOauthBlock,
  openclawOauthEntry,
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
import { HERMES_OAUTH_CONNECT_TIMEOUT_S, checkOauthServer, oauthLoginNote } from "./harnessOauth.js";
import { strerror } from "./importFormats.js";

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
// help (python-sdk#260, #279), less what needs the kagura-mcp proxy, plus
// the two options v0.10 took, kept inert so its scripts still run.
const NAME: FlagSpec = {
  name: "name",
  type: "value",
  help:
    "MCP server name in the harness config: 1-64 letters, digits, '-' or '_', starting with a " +
    "letter or digit",
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
  help: "Show the command or block, the entry and the AGENTS.md step; change nothing",
};
const HARNESS_PROFILE: FlagSpec = { ...PROFILE, help: `${PROFILE.help}, and ignored with --url-form` };
const URL_FORM: FlagSpec = {
  name: "url-form",
  type: "switch",
  help:
    "Every entry this port writes is the URL form, so this changes nothing alone; --oauth needs it. The entry " +
    "sends a long-lived API key from an environment variable, which setup never sees; with --oauth it holds no " +
    "key, and the harness signs in itself.",
};
const HARNESS_MCP_URL: FlagSpec = {
  ...MCP_URL,
  help:
    "The MCP URL your API key works with, or that the harness signs in to with --oauth (…/mcp/w/<workspace>); " +
    `default: the configured mcp_url, else ${DEFAULT_MCP_URL} (--oauth needs it given)`,
};
/** Python's `--oauth`, worded per harness (`_HARNESS_OAUTH_HELP`). */
function oauthFlag(help: string): FlagSpec {
  return { name: "oauth", type: "switch", help };
}

/** Python's two `--oauth` usage errors (`_check_flags`). */
const OAUTH_NEEDS_URL =
  "--oauth needs --url-form and --mcp-url: the URL the harness signs in to, e.g. " +
  "--url-form --oauth --mcp-url https://memory.kagura-ai.com/mcp/w/<workspace-id>.";
const OAUTH_EXCLUDES_KEY_ENV =
  "--oauth and --api-key-env exclude each other: an --oauth entry has no key variable, since the harness signs " +
  "in itself.";
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
// Python's "Context ID or name": a UUID here, since this port looks up no
// context names.
const HARNESS_CONTEXT_ID: FlagSpec = {
  ...CONTEXT_ID,
  help: "Context ID, for the guardrails lane and the AGENTS.md export only: a UUID",
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
    "also removes the guardrails block from get_context_info. With --oauth, changing it later means " +
    "`codex mcp login` again.",
};
/**
 * Hermes and OpenClaw take the flag so a script can pass it to every
 * harness alike; there a context UUID only picks the AGENTS.md export's
 * context.
 */
function guardrailsNotWritten(title: string): FlagSpec {
  return {
    name: "guardrails",
    type: "value",
    metavar: "off|CONTEXT_ID",
    help:
      `Never written: ${title} does not read MCP instructions. 'off' is refused (it would remove ` +
      `the get_context_info guardrails block, ${title}'s only guardrail lane); a context UUID only ` +
      "picks the AGENTS.md export's context. A ?guardrails= context in --mcp-url is dropped too.",
  };
}
function apiKeyEnv(help: string): FlagSpec {
  return { name: "api-key-env", type: "value", metavar: "VAR", help };
}
/**
 * `--agents-md [PATH]`: click's `is_flag=False, flag_value=""`, so the flag
 * alone means the harness's default file. Python's help, per harness.
 */
function agentsMd(help: string): FlagSpec {
  return { name: "agents-md", type: "optional", flagValue: "", metavar: "[PATH]", help };
}

/** The ones after the harness's own, in the Python CLI's order. */
const HARNESS_TAIL = [URL_FORM, HARNESS_MCP_URL];
const HARNESS_NON_INTERACTIVE: FlagSpec = {
  ...NON_INTERACTIVE,
  help: "Never hands the terminal to a harness CLI (--oauth); nothing else here prompts",
};
const HARNESS_END = [FORCE, HARNESS_NON_INTERACTIVE, DRY_RUN, INERT_API_KEY, INERT_PROJECT_DIR];

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
 * Python's `uuid.UUID` accepts, written canonically — Python's
 * `normalize_guardrails`, which strips the value first.
 */
function parseGuardrails(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = pyStrip(raw);
  if (value.toLowerCase() === "off") return "off";
  try {
    return normalizeUuid(value, "guardrails");
  } catch {
    // The server silently ignores any other value, so a typo would read
    // as success here and change nothing there. Python's message, as
    // click reports it.
    throw new CliUsageError(
      `Invalid value for '--guardrails': guardrails must be 'off' or a context UUID, got ${quote(raw)}`,
    );
  }
}

/**
 * Validate `--tool-profile`, stripped; an empty one is refused as Python
 * refuses it, since `profile=` would ask the server for no profile.
 */
function parseToolProfile(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = pyStrip(raw);
  if (!value) throw new CliUsageError("Invalid value for '--tool-profile': must not be empty");
  return value;
}

/**
 * Validate `--name`: Python's 1-64 letters, digits, `-` or `_`, the first
 * a letter or digit.
 *
 * Codex accepts nothing else, and keeping to these characters lets the
 * name go bare into the printed TOML and YAML and into the variable
 * Hermes derives from it. The name is a bare positional in the `codex`
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
  // `||`, as Python's `mcp_url or …`: an empty --mcp-url is no URL, and
  // taking it as one would write `"url": ""` and blank the project's own.
  const baseUrl = args.values["mcp-url"] || own("mcp_url") || process.env.KAGURA_MCP_URL || DEFAULT_MCP_URL;
  const contextFlag = Boolean(args.values["context-id"]);
  const contextId = args.values["context-id"] || own("context_id") || process.env.KAGURA_CONTEXT_ID || "";

  if (!resolvedKey) {
    // No word of `auth login`: setup writes an API-key entry, and an OAuth
    // profile does not give it one.
    throw new CliError(
      `no API key: pass --api-key, set api_key in the project's .kagura.json, or export ${KEY_ENV_VAR}.`,
    );
  }
  // The entry and .kagura.json give Claude Code the key for this URL, which
  // sends it with every request. Python's setup claude tests the connection
  // before it writes anything, with a client that refuses plain HTTP to a
  // host other than localhost; this port makes no connection, so it runs
  // that check alone, in Python's words and with its exit 1, whichever
  // source the URL came from.
  try {
    validateHttpsUrl(baseUrl, "MCP URL");
  } catch (e) {
    throw new CliError(`Connection failed: ${excMessage(e)}`);
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

/**
 * A path's segments as pathlib reads them: separators (either one on
 * Windows) and `.` segments dropped, and `..` kept as a name.
 */
function pathSegments(p: string): string[] {
  return p.split(process.platform === "win32" ? /[\\/]+/ : /\/+/).filter((s) => s !== "" && s !== ".");
}

/**
 * `target` for messages, with the home directory written `~` — Python's
 * `_path_label`, whose `relative_to(Path.home())` compares segments (on
 * Windows without case) and resolves nothing: `~/x/../y` and `~/..notes`
 * are named so, where `path.relative` would fold the first and read the
 * second as outside home. A relative path stays as given, as `relative_to`
 * refuses one.
 */
function pathLabel(target: string): string {
  if (!path.isAbsolute(target)) return target;
  const fold = (segment: string) => (process.platform === "win32" ? segment.toLowerCase() : segment);
  const home = pathSegments(os.homedir());
  const own = pathSegments(target);
  if (own.length <= home.length || home.some((segment, i) => fold(segment) !== fold(own[i]!))) return target;
  return `~/${own.slice(home.length).join("/")}`;
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
  /**
   * As given ({@link normalizeUrl}-ed, as Python writes it) or configured;
   * the flags' query parameters go on top.
   */
  baseUrl: string;
  /** Whether baseUrl came from `--mcp-url`, rather than the configuration. */
  urlFlag: boolean;
  /** `-c`, canonical, else the configuration's context (for the report alone). */
  contextId: string;
  /** `-c` was passed, rather than read from the configuration. */
  contextFlag: boolean;
  /** `--guardrails`, validated and normalised; undefined when absent. */
  guardrails: string | undefined;
  /** `--tool-profile`, trimmed; undefined when absent or not taken. */
  toolProfile: string | undefined;
  /**
   * `--agents-md`: undefined when absent, `""` for the harness's default
   * file, else the path as given.
   */
  agentsMd: string | undefined;
  /**
   * The AGENTS.md export's context: `-c`, else a `--guardrails` UUID.
   * Never the URL's `?guardrails=` and never `.kagura.json`, as in Python.
   */
  exportContext: string | undefined;
  /** The configuration, for the export's credential; null when it could not be loaded. */
  config: KaguraConfig | null;
  /** The variable the entry reads the key from. */
  keyEnv: string;
  /**
   * `--oauth`: the entry holds no key and the harness signs in itself
   * (python-sdk#282). Implies `--url-form` and `--mcp-url`, so `baseUrl`
   * is the flag's URL.
   */
  oauth: boolean;
  /**
   * Python's `interactive`: no -y, a terminal on stdin, and a way to hand
   * it over. Only an --oauth add ever uses it here.
   */
  interactive: boolean;
  /** Every key this process knows of ({@link knownKeys}), cut out of whatever a harness CLI prints. */
  secrets: string[];
  force: boolean;
  dryRun: boolean;
  /** `-y`, which only changes what the dry run says of the export offer. */
  nonInteractive: boolean;
  /** Notes on the flags that change nothing here. */
  notes: string[];
}

/** Python's example of the URL `--mcp-url` takes. */
const MCP_URL_SHAPE = "use an https:// URL, e.g. https://memory.kagura-ai.com/mcp/w/<workspace-id>";

/**
 * Refuse an MCP URL the entry cannot use — Python's checks of `--mcp-url`
 * (python-sdk#279): plain HTTP other than localhost, since the entry sends
 * the key there with every request, then anything but an http(s) URL with
 * a host, which would go on the harness argv after `--url` (where `--help`
 * reads as an option). `url` is already {@link normalizeUrl}-ed.
 */
function requireMcpUrl(url: string, fromFlag: boolean): void {
  try {
    validateHttpsUrl(url, "MCP URL");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (fromFlag) throw new CliUsageError(`Invalid value for '--mcp-url': ${reason}`);
    // Python takes the URL from the flag alone; this port falls back to
    // the configured one, which is no usage error.
    throw new CliError(`the configured mcp_url is refused: ${reason} Pass --mcp-url for another.`);
  }
  if (isHttpUrl(url)) return;
  if (fromFlag) throw new CliUsageError(`Invalid value for '--mcp-url': ${MCP_URL_SHAPE}`);
  throw new CliError(`the configured mcp_url is refused: ${MCP_URL_SHAPE}. Pass --mcp-url for another.`);
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

/**
 * Read `--agents-md`: undefined when absent, `""` for the harness's
 * default file, else the path. A path of only whitespace is refused in
 * the words of Python's `_agents_md_option` (0.41.1+, python-sdk #285).
 */
function parseAgentsMd(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return raw;
  if (!pyStrip(raw)) {
    throw new CliUsageError(
      "Invalid value for '--agents-md': the path is blank; name a file, or give --agents-md alone " +
        "for the default one",
    );
  }
  return raw;
}

/**
 * `-c`, canonical — Python's check that a URL form setup, with no profile
 * to list contexts with, gets a context UUID (exit 2): on every harness,
 * whether or not the export asks for it. A padded or empty value is
 * refused too, as `uuid.UUID` refuses it.
 *
 * With `--url-form`, `--profile` is inert here, so it resolves no name
 * either; that case is refused in its own words.
 */
function parseContextFlag(raw: string, profile: string | undefined): string {
  try {
    return normalizeUuid(raw, "--context-id");
  } catch {
    throw new CliUsageError(
      profile === undefined
        ? "Without --profile, --context-id must be a context UUID: setup cannot list contexts."
        : "--profile is not used here, so --context-id must be a context UUID: setup cannot list " +
            "contexts.",
    );
  }
}

function resolveHarnessInput(deps: CliDeps, args: ParsedArgs, harness: HarnessName): HarnessInput {
  // The name first: a usage error, as click reports before it runs anything.
  const name = parseName(args);
  rejectExtraArgs(args);
  const guardrails = parseGuardrails(args.values.guardrails);
  const toolProfile = parseToolProfile(args.values["tool-profile"]);
  const agentsMd = parseAgentsMd(args.values["agents-md"]);
  // Then Python's _check_flags, in its order, each a usage error. The
  // --profile refusal (exit 1) comes last, so that `--profile p
  // --guardrails off` is the usage error it is in Python. The entry gets
  // the URL the checks read, not one with padding or control characters a
  // harness might keep.
  const rawUrl = args.values["mcp-url"];
  const urlArg = rawUrl === undefined ? undefined : normalizeUrl(rawUrl);
  const oauth = args.flags.has("oauth");
  if (oauth && (!args.flags.has("url-form") || !urlArg)) throw new CliUsageError(OAUTH_NEEDS_URL);
  if (oauth && args.values["api-key-env"] !== undefined) throw new CliUsageError(OAUTH_EXCLUDES_KEY_ENV);
  if (urlArg !== undefined) requireMcpUrl(urlArg, true);
  const keyEnv = parseKeyEnv(args.values["api-key-env"], harness, name);
  refuseProfileWithKey(args);
  if (guardrails === "off" && NO_INSTRUCTIONS.has(harness)) throw refuseGuardrailsOff(harness);
  // Python's `context_id is not None`: `-c ''` counts as given, and is no UUID.
  const rawContext = args.values["context-id"];
  const contextFlag = rawContext !== undefined;
  if (agentsMd !== undefined && !contextFlag && (guardrails === undefined || guardrails === "off")) {
    // Python asks which context only with a terminal and without -y; this
    // port never asks.
    throw new CliUsageError(
      "--agents-md needs --context-id with -y or without a terminal: setup cannot ask which context.",
    );
  }
  const profile = args.values.profile;
  const urlForm = args.flags.has("url-form");
  // Without --url-form, --profile is refused just below instead.
  const flagContext =
    rawContext !== undefined && (profile === undefined || urlForm)
      ? parseContextFlag(rawContext, profile)
      : undefined;
  if (profile !== undefined && !urlForm) throw refuseProfile(harness, profile);

  // For the URL and context fallbacks, and the export's credential: no key
  // for the entry is taken from it. Python never reads it, so with
  // --mcp-url one that cannot be loaded stops nothing; the context
  // fallback only fills in the report. Without --mcp-url the loader's
  // error stops the run: it names the file and never quotes it, which can
  // hold a key.
  const notes: string[] = [];
  let config: KaguraConfig | null = null;
  try {
    ({ config } = resolveConfig(deps, undefined, false));
  } catch (e) {
    if (urlArg === undefined) throw e;
    notes.push(
      "Note: the configuration (.kagura.json) could not be loaded, so setup went on without it: " +
        "--mcp-url gives the URL.",
    );
  }
  const configured = config?.mcp_url;
  const baseUrl =
    urlArg ?? normalizeUrl(typeof configured === "string" && configured ? configured : DEFAULT_MCP_URL);
  if (urlArg === undefined) requireMcpUrl(baseUrl, false);
  const contextId = flagContext ?? (config?.context_id || "");

  // The options v0.10 took, and the Python CLI's that need what this port
  // lacks: accepted, so a script still runs, and said to change nothing.
  const label = LABEL[harness];
  const apiKey = args.values["api-key"];
  if (apiKey !== undefined) {
    notes.push(
      oauth
        ? `Note: --api-key is not stored or used: the ${label} entry holds no key, since ${label} signs in itself.`
        : `Note: --api-key is not stored or used: the ${label} entry reads the key from $${keyEnv}, ` +
            "and setup never handles the key.",
    );
  }
  if (args.values["project-dir"] !== undefined) {
    notes.push(
      `Note: --project-dir is not used: the ${label} entry is per user, and harness setups write no ` +
        ".kagura.json or .gitignore.",
    );
  }
  // Python's URL form uses the profile alone to list contexts and to fetch
  // the AGENTS.md export, and checks it against the server; this port
  // lists nothing, and fetches the export on the usual credential chain.
  if (profile !== undefined) {
    notes.push(
      "Note: --profile is not used: this port lists no contexts, and the AGENTS.md export " +
        "(--agents-md) fetches on the usual credential chain (KAGURA_API_KEY, the OAuth profile, " +
        ".kagura.json), as `kagura-memory guardrails digest` does.",
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
    agentsMd,
    exportContext: flagContext ?? (guardrails !== undefined && guardrails !== "off" ? guardrails : undefined),
    config,
    keyEnv,
    oauth,
    interactive:
      !args.flags.has("non-interactive") && deps.stdinIsTty?.() === true && deps.execAttached !== undefined,
    secrets: knownKeys(apiKey, config?.api_key, process.env[keyEnv]),
    force: args.flags.has("force"),
    dryRun: args.flags.has("dry-run"),
    nonInteractive: args.flags.has("non-interactive"),
    notes,
  };
}

/**
 * With `--oauth`, the server check before anything else runs — Python's
 * `_check_oauth_server`, called before detection. The note goes on
 * `input.notes`; a dry run sends no request and says so instead.
 *
 * @throws CliError (exit 1) when the server is older than 0.77.0 or its
 *   version cannot be confirmed; nothing has been detected, run or written
 *   (`.kagura.json` has been read by then, for the context fallback and
 *   the export credential, as in Python).
 */
async function checkOauthServerFirst(deps: CliDeps, input: HarnessInput): Promise<void> {
  if (!input.oauth) return;
  const server = deployment(input.baseUrl);
  if (input.dryRun) {
    input.notes.push(
      `The real run first checks that ${server} runs memory-cloud 0.77.0+ (GET /api/v1/system/info); this dry ` +
        "run sends no request.",
    );
    return;
  }
  input.notes.push(await checkOauthServer({ title: LABEL[input.harness], deployment: server, fetch: deps.fetch }));
}

// --- the AGENTS.md export (--agents-md) -----------------------------------

/**
 * How much of the export's file each harness reads — Python's
 * `agents_md_cap`: Codex counts bytes, OpenClaw characters; Hermes states
 * no limit.
 */
const AGENTS_MD_CAP: Record<HarnessName, { size: number; unit: "bytes" | "characters" } | null> = {
  codex: { size: 32 * 1024, unit: "bytes" },
  hermes: null,
  openclaw: { size: 20_000, unit: "characters" },
};

/**
 * `$CODEX_HOME`, else `~/.codex` — Python's `codex_home`. Files in it are
 * named with {@link pathlibJoin}, as Python's are.
 */
function codexHome(): string {
  return process.env.CODEX_HOME || pathlibJoin(os.homedir(), ".codex");
}

/** Whether `target` is a file, through a link too — `Path.is_file()`. */
function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** The names of each project context file type Hermes looks for, in its order. */
const HERMES_OWN_FILES = [".hermes.md", "HERMES.md"];
const HERMES_AGENTS_FILES = ["AGENTS.override.md", "AGENTS.md", "agents.md"];
const HERMES_CLAUDE_FILES = ["CLAUDE.md", "claude.md"];

/**
 * A file with something left after `strip()`, read as Hermes reads it —
 * Python's `_has_text`: UTF-8 with bad bytes replaced, a BOM kept (Python's
 * `strip()` keeps U+FEFF), and an unreadable file counted as empty.
 */
function hasText(target: string): boolean {
  try {
    if (!fs.statSync(target).isFile()) return false;
    return pyStrip(new TextDecoder("utf-8", { ignoreBOM: true }).decode(fs.readFileSync(target))) !== "";
  } catch {
    return false;
  }
}

/** The first of `names` in `directory` with text — Python's `_first_with_text`. */
function firstWithText(directory: string, names: readonly string[]): string | null {
  for (const name of names) {
    const target = path.join(directory, name);
    if (hasText(target)) return target;
  }
  return null;
}

/**
 * The Cursor rules file Hermes loads in `directory`: `.cursorrules`, else
 * the first `.cursor/rules/*.mdc` with text by name — Python's
 * `hermes_cursor_rules`. (Python sorts by code point, JavaScript by UTF-16
 * unit; they differ only for names past U+FFFF.)
 */
function hermesCursorRules(directory: string): string | null {
  const rulesDir = path.join(directory, ".cursor", "rules");
  let rules: string[] = [];
  try {
    rules = fs
      .readdirSync(rulesDir)
      .filter((name) => name.endsWith(".mdc"))
      .sort()
      .map((name) => path.join(rulesDir, name));
  } catch {
    rules = [];
  }
  return [path.join(directory, ".cursorrules"), ...rules].find(hasText) ?? null;
}

/**
 * The file the export goes into so that Hermes, run in `directory`, loads
 * it — port of Python's `hermes_context_file` (python-sdk #278). Hermes
 * loads only the first of these types that has a file with text:
 *
 * 1. `.hermes.md` / `HERMES.md`: the nearest that exists, from `directory`
 *    up to the git root (`directory` alone outside a repository); an empty
 *    one ends that search.
 * 2. `AGENTS.override.md` / `AGENTS.md` / `agents.md`, in every directory
 *    from the git root down to `directory`.
 * 3. `CLAUDE.md` / `claude.md` in `directory`.
 * 4. `.cursorrules` / `.cursor/rules/*.mdc` in `directory`.
 *
 * The export goes into the loaded `.hermes.md` / `HERMES.md` (even a
 * parent's), into `directory`'s AGENTS file that loads (a new `AGENTS.md`
 * there when only a parent's does), or into the loaded `CLAUDE.md`; with
 * nothing loaded, a new `AGENTS.md`. Null when only Cursor rules load,
 * which a new `AGENTS.md` would stop loading.
 */
function hermesContextFile(directory: string): string | null {
  const walk: string[] = [];
  for (let d = directory; ; d = path.dirname(d)) {
    walk.push(d);
    if (path.dirname(d) === d) break;
  }
  const root = walk.findIndex((d) => fs.existsSync(path.join(d, ".git")));
  const chain = root === -1 ? walk.slice(0, 1) : walk.slice(0, root + 1);
  for (const d of chain) {
    const own = HERMES_OWN_FILES.map((name) => path.join(d, name)).find(isFile);
    if (own !== undefined) {
      if (hasText(own)) return own;
      break; // an empty one ends the lookup: Hermes moves on to the next type
    }
  }
  const local = firstWithText(directory, HERMES_AGENTS_FILES);
  if (local !== null) return local;
  if (chain.slice(1).some((d) => firstWithText(d, HERMES_AGENTS_FILES) !== null)) {
    return path.join(directory, "AGENTS.md");
  }
  const claude = firstWithText(directory, HERMES_CLAUDE_FILES);
  if (claude !== null) return claude;
  if (hermesCursorRules(directory) !== null) return null;
  return path.join(directory, "AGENTS.md");
}

/**
 * Why Hermes has no default export file here, naming the file a new
 * `AGENTS.md` would displace — Python's `_Hermes.no_agents_md_reason`,
 * unwrapped (a note keeps it on one line; an error wraps it with {@link pyWrap}).
 */
function hermesNoDefaultReason(): string {
  const rules = hermesCursorRules(process.cwd());
  const label = rules !== null ? pathLabel(rules) : "Cursor rules";
  return (
    `Hermes loads only ${label} here, and it loads the first context file type it finds: a new ` +
    "AGENTS.md would stop it loading that file. Name the file with --agents-md PATH"
  );
}

/**
 * `text` wrapped to follow a two-space indent at 78 columns, never
 * breaking a `command` — port of Python's `_wrap` (`textwrap.wrap(held,
 * 78, break_on_hyphens=False, break_long_words=False)`): greedy, a word
 * longer than the width alone on its line, lengths in code points.
 */
function pyWrap(text: string): string {
  const held = text.replace(/`[^`]*`/g, (span) => span.replace(/ /g, "\0"));
  const lines: string[] = [];
  let line = "";
  for (const word of held.split(/\s+/).filter(Boolean)) {
    if (line && [...line].length + 1 + [...word].length > 78) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n  ").replace(/\0/g, " ");
}

/**
 * The file the export goes to without a PATH — Python's `agents_md_path`;
 * null only for Hermes when only Cursor rules load.
 */
function agentsMdDefault(harness: HarnessName): string | null {
  if (harness === "codex") {
    // Codex reads the global AGENTS.override.md in place of AGENTS.md.
    const override = pathlibJoin(codexHome(), "AGENTS.override.md");
    return isFile(override) ? override : pathlibJoin(codexHome(), "AGENTS.md");
  }
  if (harness === "hermes") return hermesContextFile(process.cwd());
  // The default agent workspace, which OpenClaw loads every session.
  return pathlibJoin(openclawWorkspaceDir(), "AGENTS.md");
}

/**
 * A leading `~` as the current user's home directory — `Path.expanduser()`
 * for `~` and `~/…` (and `~\…` on Windows). `~user/…` is left as written:
 * Python looks that user up, and fails the whole setup for one it cannot
 * find.
 */
function expandUser(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return os.homedir() + value.slice(1);
  }
  return value;
}

/**
 * `Path(base) / name / …`, named as pathlib names it ({@link pathlibString}):
 * a `..` in `base` is kept, where `path.join` folds it. The two name
 * different files when the directory before a `..` is a link, since the
 * system resolves `link/..` through the link, for Python's calls and for
 * these alike.
 */
function pathlibJoin(base: string, ...names: string[]): string {
  // A root (`/`, `//`, `C:\`) already ends in a separator: another would
  // make `/` a `//` root.
  const head = pathlibString(base);
  return pathlibString(`${head}${head.endsWith(path.sep) ? "" : path.sep}${names.join(path.sep)}`);
}

/**
 * `Path.absolute()`: `target` against the current directory, lexically as
 * {@link pathlibJoin} joins; on Windows, as `path.resolve` has it, which
 * also puts the drive on a rooted path.
 */
function absolutePath(target: string): string {
  if (process.platform === "win32") return path.resolve(target);
  return path.isAbsolute(target) ? target : pathlibJoin(process.cwd(), target);
}

/**
 * Where the export goes: `--agents-md PATH` (a leading `~` expanded), else
 * the harness's default file. With no default (Hermes with only Cursor
 * rules), setup stops before anything runs, as Python's
 * `run_setup_harness` does (python-sdk #278).
 *
 * @throws CliError (exit 1) with Python's wrapped reason.
 */
function agentsMdTarget(input: HarnessInput): string {
  if (input.agentsMd) return pathlibString(expandUser(input.agentsMd));
  const target = agentsMdDefault(input.harness);
  if (target === null) throw new CliError(`Nothing was written: ${pyWrap(hermesNoDefaultReason())}.`);
  return target;
}

/**
 * A file's text as Python's `Path.read_text(encoding="utf-8")` gives it:
 * strict UTF-8 with a BOM kept, and universal newlines (`\r\n` and a lone
 * `\r` read as `\n`).
 */
function readTextUniversal(target: string): string {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(target));
  return text.replace(/\r\n?/g, "\n");
}

/** What writing the block would do to `target`, for the dry run — Python's `_export_action`. */
function exportAction(target: string): string {
  let text: string;
  try {
    text = readTextUniversal(target);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "create" : "update";
  }
  return hasGuardrailBlock(text) ? "replace the block in" : "append the block to";
}

/**
 * The server an MCP URL belongs to: its REST base URL, scheme and host
 * lower-cased — Python's `_deployment`. Read as Python reads it: the
 * padding `urlsplit` drops goes ({@link normalizeUrl}), and so do trailing
 * slashes with or without a query after them, as `base_url_from_mcp`
 * strips them; so `http://h/` and `http://h/mcp/w/x` are one server.
 */
function deployment(mcpUrl: string): string {
  const url = normalizeUrl(mcpUrl);
  const end = url.search(/[?#]/);
  const beforeQuery = (end === -1 ? url : url.slice(0, end)).replace(/\/+$/, "");
  return baseUrlFromMcp(beforeQuery).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, (authority) =>
    authority.toLowerCase(),
  );
}

/**
 * The credential the export fetches with — Python's `_export_auth` for the
 * URL form without a profile: the usual CLI chain (KAGURA_API_KEY, the
 * OAuth profile, .kagura.json), as `kagura-memory guardrails digest` uses.
 * It only reads credentials, so a dry run settles it too. It must be for
 * the entry's own server: a context id belongs to one deployment, and
 * setup never sends a credential to another.
 *
 * @throws CliError (exit 1, nothing run) when there is no credential, or it
 *   is for another server.
 */
function exportCredential(deps: CliDeps, input: HarnessInput): ResolvedAuth {
  let auth: ResolvedAuth;
  try {
    // A configuration that could not be loaded is read again, so its own
    // error stops the run if the chain gets that far.
    auth = deps.resolveAuth({ apiKey: null, mcpUrl: null, profile: null, config: input.config });
  } catch (e) {
    if (!(e instanceof KaguraAuthError)) throw e;
    throw new CliError(`The AGENTS.md export has no credential: ${excMessage(e)}`);
  }
  const ours = deployment(auth.mcpUrl);
  const theirs = deployment(input.baseUrl);
  if (ours !== theirs) {
    const envKey = auth.kind === "static" && auth.source === "env";
    const source = SOURCE_LABEL[auth.kind === "oauth" ? "oauth" : auth.source];
    // Python says to pass --profile, whose profile alone its export then
    // uses. Here --profile is inert and the chain takes a profile from
    // KAGURA_PROFILE, which KAGURA_API_KEY outranks: while that key is set,
    // only KAGURA_MCP_URL moves the credential.
    const fix = envKey
      ? "  Set KAGURA_MCP_URL to that server for KAGURA_API_KEY, or unset\n" +
        "  KAGURA_API_KEY and set KAGURA_PROFILE to a login on it."
      : "  Set KAGURA_PROFILE to a login on that server, or KAGURA_MCP_URL to it for\n" +
        "  KAGURA_API_KEY.";
    throw new CliError(
      `Nothing was written: the AGENTS.md export would use the ${source} credential,\n` +
        `  which is for ${ours}, but ${input.urlFlag ? "--mcp-url" : "the MCP URL"} is on ${theirs}.\n` +
        fix,
    );
  }
  return auth;
}

/** The export setup settled before it runs anything. */
interface AgentsMdExport {
  target: string;
  /** Canonical. */
  contextId: string;
  auth: ResolvedAuth;
}

/**
 * Fetch the export block and splice it into its file, replacing only the
 * marked block — Python's `_write_export`. Python's lines go in `notes`,
 * one each; a file it changed goes in `wrote`.
 *
 * @param applied Whether a harness CLI applied the entry, rather than
 *   setup printing it for the user to add.
 * @throws CliError (exit 1) when the fetch or the write failed.
 */
async function writeExport(
  deps: CliDeps,
  harness: HarnessName,
  exp: AgentsMdExport,
  applied: boolean,
  notes: string[],
  wrote: string[],
): Promise<void> {
  const { target, contextId, auth } = exp;
  const label = pathLabel(target);
  // Python 0.41.1's words for both cases (python-sdk #285).
  const failed = applied
    ? "The MCP entry is set up, but the AGENTS.md export failed"
    : "The MCP entry is printed for you to add, but the AGENTS.md export failed";
  const refresh = shellCommand(["kagura-memory", "guardrails", "digest", contextId, "--out", target]);

  let digest: GuardrailDigest;
  try {
    digest = await deps.makeMemoryClient(auth).getGuardrailDigest(contextId);
  } catch (e) {
    if (e instanceof KaguraNotFoundError) {
      throw new CliError(
        `${failed}: context ${contextId} is not visible to this credential on\n` +
          `  ${deployment(auth.mcpUrl)} (404), or the server is older than v0.74.0.\n` +
          `  Nothing was written to ${label}.`,
      );
    }
    throw new CliError(`${failed}: ${excMessage(e)}`);
  }

  if (!pyStrip(digest.text)) {
    // Port of `_write_export`'s empty branch (python-sdk #278): as
    // `guardrails digest --out` does, an earlier block goes, so the harness
    // stops loading guardrails the server no longer serves. Without a
    // block, neither the file nor its directory is created.
    let removed: GuardrailBlockStatus;
    try {
      removed = writeGuardrailBlock(target, "");
    } catch (e) {
      throw new CliError(`${failed}: ${label}: ${excMessage(e)}; left unchanged`);
    }
    const none =
      `Context ${contextId} has no tool guardrails this credential can see (none marked, or the ` +
      "context is not trusted-tier)";
    if (removed === "removed") {
      notes.push(`${none}: removed the earlier guardrail block from ${label}.`);
      wrote.push(absolutePath(target));
    } else {
      notes.push(`${none}: nothing was written to ${label}.`);
    }
    return;
  }

  const cap = AGENTS_MD_CAP[harness];
  let status: GuardrailBlockStatus;
  let size = 0;
  try {
    // Unlike `guardrails digest --out`, setup creates the directory, as
    // Python does: a default such as OpenClaw's workspace may not exist yet.
    fs.mkdirSync(path.dirname(target), { recursive: true });
    status = writeGuardrailBlock(target, digest.text);
    // As written, as Python 0.41.1 measures it (python-sdk #285): the bytes
    // for Codex, and for OpenClaw the code points of
    // `read_bytes().decode("utf-8")`, where a CRLF is two and a BOM one.
    if (cap !== null) {
      const raw = fs.readFileSync(target);
      size =
        cap.unit === "bytes"
          ? raw.length
          : [...new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)].length;
    }
  } catch (e) {
    throw new CliError(`${failed}: ${label}: ${excMessage(e)}; left unchanged`);
  }

  const done = status === "unchanged" ? "Already up to date:" : "Wrote";
  notes.push(`${done} the guardrail block for context ${contextId} in ${label}`);
  if (cap !== null && size > cap.size) {
    notes.push(`Warning: ${label} is ${size} ${cap.unit}; ${LABEL[harness]} reads only the first ${cap.size}.`);
  }
  notes.push(`The block is a snapshot; refresh it with: ${refresh}`);
  if (harness === "hermes") {
    notes.push(
      "Hermes scans context files for prompt injection and skips a file it flags; if it reports " +
        `${path.basename(target)} as blocked, delete the block between the kagura-memory:guardrails markers.`,
    );
  }
  if (status !== "unchanged") wrote.push(absolutePath(target));
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
  cli:
    | {
        program: string;
        file: string;
        argv: string[];
        /** Run attached to the terminal (it signs in or prompts), with no timeout. */
        attached?: boolean;
        /** Appended to the failure message of an attached run (Python's `add_failure_note`). */
        failureNote?: string;
        /**
         * After the add exited 0: why the entry is not saved as asked, or
         * null — Python's `not_saved`. A harness that exits 0 on a cancel
         * (Hermes) can only be judged by the entry it has now.
         */
        notSaved?: () => Promise<string | null>;
      }
    | { program: null; reason: string };
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
 * Run a harness CLI attached to the terminal — Python's `_run_or_fail`
 * with `attached=True`: its output went to the terminal, so a failure
 * names only the exit code, then `note`.
 */
async function runAttachedHarness(
  deps: CliDeps,
  file: string,
  program: string,
  argv: string[],
  note: string,
): Promise<void> {
  const code = await deps.execAttached!(file, argv);
  if (code === 0) return;
  throw new CliError(`\`${[program, ...argv.slice(0, 2)].join(" ")}\` failed: exit code ${code}${note}`);
}

/**
 * Python's `_print_reason` for an add that runs attached: why setup prints
 * the block instead. `what`: `starts the sign-in` (Codex) or `is
 * interactive` (Hermes).
 */
function oauthPrintReason(input: HarnessInput, what: string): string {
  const why = input.nonInteractive ? "-y was given" : "stdin is not a terminal";
  return `\`${input.harness} mcp add\` ${what} and ${why}`;
}

/**
 * Carry out a plan: apply the entry through the harness CLI or print it,
 * write the AGENTS.md export when asked, then report. Only the export is
 * written here; Python's messages go in `notes`.
 *
 * An export that fails after the entry was applied or printed still gets
 * the report, then its error (exit 1): the entry is in place, and a script
 * should see that.
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

  // The export's file and credential, settled before anything is run or
  // written, as Python settles them: in a dry run too.
  const exp: AgentsMdExport | null =
    input.agentsMd === undefined
      ? null
      : { target: agentsMdTarget(input), contextId: input.exportContext!, auth: exportCredential(deps, input) };

  let appliedWith: string | null = null;
  if (plan.cli.program !== null) {
    const { program, file, argv } = plan.cli;
    const display = shellCommand([program, ...argv]);
    if (input.dryRun) {
      notes.push(`${stops ? "With --force, would run" : "Would run"}: ${display}`);
      printBlock(deps, `Would configure ${where}:`, plan.block);
    } else {
      if (plan.cli.attached === true) {
        await runAttachedHarness(deps, file, program, argv, plan.cli.failureNote ?? "");
      } else {
        await runHarnessCommand(deps, file, program, argv, input.secrets);
      }
      if (plan.cli.notSaved !== undefined) {
        const problem = await plan.cli.notSaved();
        if (problem !== null) {
          throw new CliError(`${problem}${exp !== null ? "; setup skipped the AGENTS.md export" : ""}.`);
        }
      }
      appliedWith = display;
      notes.push(`Done: ${program} wrote ${input.name} to ${where}.`);
    }
  } else {
    const replace = plan.found ? " in place of the existing one" : "";
    const edits = `Setup does not edit ${where} itself (${plan.cli.reason}).`;
    printBlock(deps, `${edits}\nAdd this ${input.name} entry to ${plan.blockTarget}${replace}:`, plan.block);
    notes.push(`${edits} Add the ${input.name} entry printed on stderr to ${plan.blockTarget}${replace}.`);
  }

  const noInstructions = NO_INSTRUCTIONS.has(input.harness);
  if (input.dryRun) {
    if (exp !== null) {
      notes.push(
        `AGENTS.md: would ${exportAction(exp.target)} ${pathLabel(exp.target)} ` +
          `(the guardrail block for context ${exp.contextId})`,
      );
    } else if (noInstructions) {
      const target = agentsMdDefault(input.harness);
      if (target === null) {
        // Python's `_echo_dry_run_export` for a harness with no default file.
        notes.push(`AGENTS.md: not offered. ${hermesNoDefaultReason()}.`);
      } else {
        // Python offers the export at a prompt; this port never prompts.
        const when = input.nonInteractive ? "not offered with -y" : "not offered: this port never prompts";
        notes.push(`AGENTS.md: ${pathLabel(target)} (${when}; --agents-md writes it)`);
      }
    }
  } else {
    notes.push(...plan.after);
    if (exp === null && noInstructions) {
      // No hint when no default file fits: a new one would displace the user's.
      const target = agentsMdDefault(input.harness);
      if (target !== null) {
        notes.push(
          "Re-run with --agents-md --context-id <id> to put a snapshot of a context's tool guardrails " +
            `into ${pathLabel(target)}, which ${LABEL[input.harness]} loads every session.`,
        );
      }
    }
  }

  const wrote: string[] = [];
  let failure: CliError | null = null;
  if (exp !== null && !input.dryRun) {
    try {
      await writeExport(deps, input.harness, exp, appliedWith !== null, notes, wrote);
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      failure = e;
    }
  }

  report(deps, input, {
    status: input.dryRun ? "dry_run" : "success",
    wrote,
    gitignoreAdded: [],
    url: plan.url,
    appliedWith,
    notes,
  });
  if (failure !== null) throw failure;
  return 0;
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
  const dataDir = pathlibJoin(codexHome, "plugins", "data");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(dataDir);
  } catch {
    return false;
  }
  return dirs.some((dir) => {
    if (!dir.startsWith(CODEX_PLUGIN_DATA_PREFIX)) return false;
    const file = pathlibJoin(dataDir, dir, "config.json");
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
 * context, with its preview command in this bin's name.
 */
function codexDigestNotes(context: string, url: string, keyEnv: string): string[] {
  // On the entry's own credential: its key variable, on its server.
  const env = keyEnv === KEY_ENV_VAR ? [] : [`KAGURA_API_KEY="\${${keyEnv}}"`];
  env.push(`KAGURA_MCP_URL=${shellQuote(url)}`);
  const preview = [
    ...env,
    shellCommand(["kagura-memory", "guardrails", "digest", context, "--target", "instructions"]),
  ];
  return [
    `Codex should get the tool guardrail digest of context ${context} in the MCP instructions when ` +
      "it connects. The server sends only its base text instead when the entry's credential cannot " +
      "read that context, the context has no guardrails, or the deployment turns the digest off. " +
      `Preview what it sends: ${preview.join(" ")}`,
    "Use a context whose editor list you control: every editor's guardrail summaries reach the model.",
  ];
}

/** Whether `mcpUrl` is on `server`; false when it cannot be read as a URL — Python's `_on_server`. */
function onServer(mcpUrl: string, server: string): boolean {
  try {
    return deployment(mcpUrl) === server;
  } catch {
    return false;
  }
}

/**
 * Whether this CLI's usual credential chain is on `server` — Python's
 * `_cli_chain_on`. It runs after the entry is written, so any failure to
 * resolve counts as no credential.
 */
function cliChainOn(deps: CliDeps, input: HarnessInput, server: string): boolean {
  try {
    const auth = deps.resolveAuth({ apiKey: null, mcpUrl: null, profile: null, config: input.config });
    return onServer(auth.mcpUrl, server);
  } catch {
    return false;
  }
}

/**
 * The stored profiles on `server`, by name — Python's `_profiles_on`. It
 * goes through this CLI's own loader, so it names only profiles that
 * `KAGURA_PROFILE=<name>` can load: the loader treats a file with any
 * malformed profile as empty, and it runs after the write, so a file that
 * cannot be read holds none.
 */
function profilesOn(deps: CliDeps, server: string): string[] {
  let profiles: CredentialsFile["profiles"];
  try {
    profiles = loadCredentialsFile(deps.credentialsPath).profiles;
  } catch {
    return [];
  }
  return Object.entries(profiles)
    .filter(([, creds]) => onServer(creds.mcpUrl, server))
    .map(([name]) => name)
    .sort();
}

/** `command` run on `profile`, even with KAGURA_API_KEY set here — Python's `_on_profile`. */
function onProfile(profile: string, command: string): string {
  const run = `KAGURA_PROFILE=${shellQuote(profile)} ${command}`;
  return pyStrip(process.env.KAGURA_API_KEY ?? "") ? `env -u KAGURA_API_KEY ${run}` : run;
}

/**
 * The `.kagura.json` every command of this bin loads first, when it cannot
 * be loaded — Python's `_broken_config`: its path and why, never its
 * contents. This bin's loader also refuses JSON that is not an object.
 */
function brokenConfig(deps: CliDeps): string | null {
  try {
    deps.loadConfig();
    return null;
  } catch {
    // Named below.
  }
  const local = path.join(process.cwd(), ".kagura.json");
  const isLocal = fs.existsSync(local);
  const target = isLocal ? local : path.join(os.homedir(), ".kagura.json");
  const label = isLocal ? pathLabel(absolutePath(".kagura.json")) : "~/.kagura.json";
  let text: string;
  try {
    // ignoreBOM keeps a leading U+FEFF in `text`, so JSON.parse refuses it as
    // the loader's did: Python's json.loads names "Unexpected UTF-8 BOM".
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(target));
  } catch (e) {
    return `${label} (${e instanceof TypeError ? "not UTF-8 JSON" : strerror(e)})`;
  }
  try {
    JSON.parse(text);
  } catch {
    return `${label} (not UTF-8 JSON)`;
  }
  return `${label} (not a JSON object)`;
}

/**
 * The closing notes on an --oauth Codex entry whose URL names a guardrails
 * context — Python's `_preview_command` for `entry.oauth` and its caller.
 * Codex's token stays with Codex, so the preview runs on this CLI's own
 * credential when that is on the entry's server; else on a stored profile
 * there; else after a login there. Pinning the server with KAGURA_MCP_URL
 * would send KAGURA_API_KEY, a key for another server, to it.
 */
function codexOauthDigestNotes(deps: CliDeps, input: HarnessInput, context: string, url: string): string[] {
  const server = deployment(url);
  const digest = shellCommand(["kagura-memory", "guardrails", "digest", context, "--target", "instructions"]);
  const reads = "(Codex gets what the account it signed in with can read):";
  let preview: string;
  let command: string;
  if (cliChainOn(deps, input, server)) {
    preview = `Preview it on the kagura-memory CLI's credential ${reads}`;
    command = digest;
  } else {
    const there = profilesOn(deps, server);
    preview =
      there.length > 0
        ? `The kagura-memory CLI's usual credential is not on ${server}; preview it on a profile there ` +
          `(${there.join(", ")}) ${reads}`
        : `The kagura-memory CLI's usual credential is not on ${server}, and no profile is: log in there with ` +
          `\`kagura-memory auth login --server ${server} --profile NAME\`, then preview it ${reads}`;
    command = onProfile(there[0] ?? "NAME", digest);
  }
  const notes = [
    `Codex should get the tool guardrail digest of context ${context} in the MCP instructions when it connects. ` +
      "The server sends only its base text instead when the entry's credential cannot read that context, the " +
      `context has no guardrails, or the deployment turns the digest off. ${preview} ${command}`,
  ];
  const broken = brokenConfig(deps);
  if (broken !== null) {
    notes.push(`The preview fails until ${broken} is fixed or removed: every kagura-memory command reads it first.`);
  }
  notes.push("Use a context whose editor list you control: every editor's guardrail summaries reach the model.");
  return notes;
}

async function runCodex(deps: CliDeps, args: ParsedArgs): Promise<number> {
  const input = resolveHarnessInput(deps, args, "codex");
  await checkOauthServerFirst(deps, input);
  const { name, keyEnv } = input;
  const home = codexHome();
  const configPath = pathlibJoin(home, "config.toml");
  const found = tomlHasServer(readText(configPath), name);
  const hooksOn = codexHooksEnabled(home, name);

  // Codex reads the server's instructions, so guardrails take effect
  // here. A value already in the URL, from --mcp-url or the configured
  // mcp_url, is kept as written.
  const notes: string[] = [];
  if (input.oauth && hooksOn) {
    notes.push(
      "Warning: the kagura-memory Codex plugin's guardrail hooks read their credential only from a URL entry " +
        "with a bearer (bearer_token_env_var, env_http_headers or http_headers), so with an --oauth entry they " +
        "do nothing.",
      `They are turned on here for the ${name} entry (a config.json under ` +
        `${pathLabel(pathlibJoin(home, "plugins", "data"))}/kagura-memory-*/): to keep them, re-run with ` +
        "--url-form and an API key (no --oauth).",
    );
  }
  let guardrails = input.guardrails;
  if (guardrails === undefined && queryParam(input.baseUrl, "guardrails") === undefined) {
    if (hooksOn && !input.oauth) {
      // The plugin's hooks read this same table and deliver the
      // guardrails themselves; the server need not repeat them.
      guardrails = "off";
      notes.push(
        "The plugin's hooks deliver guardrails, so the URL gets ?guardrails=off (the hooks' own " +
          "setup asks for it; --guardrails overrides).",
      );
    } else if (input.contextFlag) {
      // A UUID, canonical: resolveHarnessInput refused anything else.
      guardrails = input.contextId;
    }
  }
  notes.push(...toolsAllowlistWarning(input.baseUrl, input.toolProfile));
  const url = mcpUrlWithQuery(input.baseUrl, { guardrails, profile: input.toolProfile });

  const codex = deps.which("codex");
  if (input.oauth) {
    // `codex mcp add --url` with no bearer saves the entry and then starts
    // Codex's browser sign-in, so it runs attached, or not at all.
    const cli: HarnessPlan["cli"] =
      codex === null
        ? { program: null, reason: notOnPath("codex") }
        : !input.interactive
          ? { program: null, reason: oauthPrintReason(input, "starts the sign-in") }
          : {
              program: "codex",
              file: codex,
              argv: ["mcp", "add", name, "--url", url],
              attached: true,
              failureNote:
                "\n  Codex saves the entry before it signs in, so it may be saved already: check with\n" +
                `  \`codex mcp get ${name}\`, then sign in with \`codex mcp login ${name}\`.`,
            };
    const tokenStore =
      `the OS keyring ("Codex MCP Credentials"; on Windows, its encrypted secrets store in ${pathLabel(home)}), ` +
      `else in ${pathLabel(pathlibJoin(home, ".credentials.json"))}`;
    const lane = queryParam(url, "guardrails");
    const after = [oauthLoginNote("codex", name, cli.program !== null, tokenStore)];
    if (lane !== undefined && isUuid(lane)) after.push(...codexOauthDigestNotes(deps, input, parseUuid(lane), url));
    after.push(
      "Restart Codex (or start a new session) to load the entry.",
      `Check it with: ${shellCommand(["codex", "mcp", "get", name])}`,
    );
    return applyPlan(deps, {
      input,
      url,
      configPath,
      found,
      stops: true,
      block: codexTomlOauthBlock(name, url),
      blockTarget: "it",
      cli,
      notes,
      after,
    });
  }

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
    // remove` first, as Python does; the existence check is what makes
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
 * instructions — Python's `_drop_guardrails_context`. A context id is
 * never written into their entry: neither the `--guardrails` one nor any
 * `guardrails` value in the URL, and one warning names what was dropped.
 * A first `guardrails` value of `off`, the one the server reads, is kept
 * as asked, alone and with a warning of its own: it takes away the one
 * lane left. The flag's `off` never gets here: it is refused.
 */
function urlForNoInstructions(input: HarnessInput, notes: string[]): string {
  const title = LABEL[input.harness];
  // The configured mcp_url (a fallback only this port has) keeps its word.
  const source = input.urlFlag ? "--mcp-url" : "the MCP URL";
  const dropped = input.guardrails !== undefined ? ["--guardrails"] : [];
  let url = input.baseUrl;
  const first = queryParam(url, "guardrails");
  if (first !== undefined && pyStrip(first).toLowerCase() === "off") {
    notes.push(
      `Warning: ${source} has ?guardrails=off, which removes the guardrails block from ` +
        `get_context_info: ${title} then gets no guardrails from Kagura.`,
    );
    url = mcpUrlWithQuery(url, { guardrails: "off" });
  } else if (first !== undefined) {
    dropped.push(`the ?guardrails= value in ${source}`);
    url = withoutQueryParam(url, "guardrails");
  }
  if (dropped.length > 0) {
    const [has, is] = dropped.length > 1 ? ["have", "are"] : ["has", "is"];
    notes.push(
      `Warning: ${title} does not read MCP instructions, so ${dropped.join(" and ")} ${has} no effect ` +
        `there and ${is} not written. Guardrails reach ${title} through get_context_info (on by ` +
        "default) and the AGENTS.md export (--agents-md).",
    );
  }
  return url;
}

/** The full case folds `toLowerCase` lacks that yield ASCII: ß, long s and the Latin ligatures. */
const FOLDS: Record<string, string> = {
  "ß": "ss",
  "ſ": "s",
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "st",
  "ﬆ": "st",
};

/**
 * Python's `str.casefold()`, as far as an ASCII-only check of the result
 * can tell: every other fold that yields ASCII is `toLowerCase`'s too.
 */
function casefold(text: string): string {
  return text.toLowerCase().replace(/[ßſﬀ-ﬆ]/g, (c) => FOLDS[c]!);
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
  const root = pathlibJoin(os.homedir(), ".hermes");
  let active = "";
  try {
    active = casefold(pyStrip(fs.readFileSync(pathlibJoin(root, "active_profile"), "utf-8")));
  } catch {
    active = "";
  }
  if (active !== "default" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(active)) {
    return pathlibJoin(root, "profiles", active);
  }
  return root;
}

/**
 * Hermes's `config.yaml` as Python reads it (`read_text`: strict UTF-8,
 * universal newlines), only to scan it: "" when it does not exist, and why
 * it could not be read otherwise. Nothing read from it is echoed.
 */
function readHermesConfig(target: string): { text: string; unread: string | null } {
  try {
    return { text: readTextUniversal(target), unread: null };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { text: "", unread: null };
    return { text: "", unread: excMessage(e) };
  }
}

/**
 * What setup keeps of a Hermes `mcp_servers.<name>` entry — Python's
 * `_HermesEntry`: never a header value, the env or any other key, which
 * can hold a secret. Nothing here is echoed; {@link hermesEntryKind}
 * describes it.
 */
interface HermesEntry {
  command: string | null;
  args: string[];
  url: string | null;
  oauth: boolean;
  /** `headers` has an `Authorization` key, in any case. */
  authorization: boolean;
  enabled: boolean;
}

function hermesEntryFrom(value: unknown): HermesEntry {
  const entry = isObject(value) ? value : {};
  // As `hermes mcp list` reads it: a string counts only as true/1/yes.
  let enabled: unknown = Object.hasOwn(entry, "enabled") ? entry.enabled : true;
  if (typeof enabled === "string") enabled = ["true", "1", "yes"].includes(enabled.toLowerCase());
  const headers = entry.headers;
  return {
    command: typeof entry.command === "string" ? entry.command : null,
    args: Array.isArray(entry.args) ? entry.args.map((a) => (typeof a === "string" ? a : pyRepr(a))) : [],
    url: typeof entry.url === "string" ? entry.url : null,
    oauth: entry.auth === "oauth",
    authorization: isObject(headers) && Object.keys(headers).some((k) => k.toLowerCase() === "authorization"),
    enabled: pyTruthy(enabled),
  };
}

/** Python's `_HermesEntry.kind`: a url wins over a command, as in `hermes mcp list`. */
function hermesEntryKind(entry: HermesEntry): string {
  if (entry.url !== null) {
    if (entry.oauth) return "URL with OAuth";
    if (entry.authorization) return "URL with an Authorization header";
    return "URL with no credential";
  }
  if (entry.command !== null) {
    return runsProxy({ command: entry.command, args: entry.args }) ? "stdio (kagura-mcp)" : "stdio (another command)";
  }
  return "an entry setup does not recognise";
}

/**
 * `mcp_servers.<name>` from `hermes config get … --json` — Python's
 * `_config_get` + `_read_entry`. `entry` is null when Hermes has no such
 * entry ("Config key not set", exit 1, or a JSON null); `read` is false when
 * the command failed otherwise (an older Hermes).
 */
async function readHermesEntry(
  deps: CliDeps,
  file: string,
  name: string,
): Promise<{ read: boolean; entry: HermesEntry | null }> {
  const r = await deps.execFile(file, ["config", "get", `mcp_servers.${name}`, "--json"], HARNESS_EXEC);
  if (!r.timedOut && r.code === 1 && r.stderr.includes("Config key not set")) return { read: true, entry: null };
  const out = pyStrip(r.stdout);
  if (r.timedOut || r.code !== 0 || !out) return { read: false, entry: null };
  try {
    const value: unknown = JSON.parse(out.split(/\r\n|\r|\n/).pop()!);
    return { read: true, entry: value === null ? null : hermesEntryFrom(value) };
  } catch {
    return { read: false, entry: null };
  }
}

/** The form `hermes mcp list` shows for `name` — Python's `_list_detect`, for a Hermes whose `config get` failed. */
async function hermesListForm(deps: CliDeps, file: string, name: string): Promise<"URL" | "stdio" | null> {
  const r = await deps.execFile(file, ["mcp", "list"], HARNESS_EXEC);
  if (r.timedOut || r.code !== 0) return null;
  for (const line of r.stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/\r\n|\r|\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] === name) return /^https?:\/\//.test(parts[1]!) ? "URL" : "stdio";
  }
  return null;
}

/** Python's 0.41.3 message for an entry Hermes kept (python-sdk#287). */
function hermesKeptEntry(name: string, kind: string): string {
  return (
    `Hermes's ${name} entry is still the existing one (${kind}): Hermes keeps the existing entry when its ` +
    "overwrite prompt is declined, or when the add stops before saving, so nothing was saved. Re-run with " +
    "--force and accept Hermes's overwrite prompt"
  );
}

/**
 * After an --oauth `hermes mcp add` exited 0: why the entry is not saved as
 * asked, or null — Python's `_Hermes.not_saved` with `entry.oauth`. Hermes
 * exits 0 when the user cancels an overwrite, declines to save after a
 * failed probe, or continues without authentication; only the entry read
 * back tells.
 *
 * @param replaced An entry of this name existed before the add (--force).
 */
async function hermesOauthNotSaved(
  deps: CliDeps,
  file: string,
  name: string,
  url: string,
  replaced: boolean,
): Promise<string | null> {
  const { read, entry } = await readHermesEntry(deps, file, name);
  if (!read) {
    if ((await hermesListForm(deps, file, name)) !== "URL") {
      return (
        `\`hermes mcp list\` shows no new ${name} entry: \`hermes mcp add\` was\n` +
        "  cancelled or failed there, so nothing was saved"
      );
    }
    return (
      `Setup could not read back Hermes's ${name} entry (\`hermes config get mcp_servers.${name}\` failed), so ` +
      "it cannot tell whether Hermes saved an OAuth entry it can sign in with: check it with that command or " +
      "`hermes mcp list`"
    );
  }
  if (entry === null) {
    return `Hermes has no ${name} entry: \`hermes mcp add\` was cancelled or failed\n  there, so nothing was saved`;
  }
  // `--auth header` never writes `auth`, so for an OAuth entry the url alone tells.
  if (entry.url !== url) {
    return replaced
      ? hermesKeptEntry(name, hermesEntryKind(entry))
      : `Hermes's ${name} entry (${hermesEntryKind(entry)}) is not the one setup asked for, so nothing was saved`;
  }
  if (!entry.oauth) {
    // Hermes writes `auth` only as `oauth`. When it cannot set up OAuth it
    // asks "Continue without authentication?" (default yes) and saves no
    // `auth`; when its overwrite prompt is declined it keeps the old entry.
    const noOauth = `Hermes's ${name} entry has no auth: oauth, so it cannot sign in to Kagura: `;
    return replaced
      ? `${noOauth}Hermes keeps the existing entry when its overwrite prompt is declined, and continues without ` +
          "authentication when it cannot set up OAuth. Re-run with --force and accept Hermes's overwrite prompt"
      : `${noOauth}Hermes continues without authentication when it cannot set up OAuth. Re-run with --force to ` +
          "replace it";
  }
  if (!entry.enabled) {
    // "Save config anyway?" after a failed probe saves `enabled: false`,
    // which `hermes mcp login` does not turn back on.
    return (
      `Hermes saved ${name} disabled, since its sign-in or connection check did not finish, and it never ` +
      `connects to a disabled entry. Sign in with \`hermes mcp login ${name}\` (add --flow device on ` +
      "memory-cloud 0.78.0+ when the browser cannot reach this host), then turn the entry on with " +
      `\`hermes config set mcp_servers.${name}.enabled true\``
    );
  }
  return null;
}

async function runHermes(deps: CliDeps, args: ParsedArgs): Promise<number> {
  const input = resolveHarnessInput(deps, args, "hermes");
  await checkOauthServerFirst(deps, input);
  const { name, keyEnv } = input;
  const home = hermesHome();
  const configPath = pathlibJoin(home, "config.yaml");
  const where = pathLabel(configPath);
  const notes: string[] = [];
  const url = urlForNoInstructions(input, notes);

  // Python's block notes, after the guardrails warnings as Python prints
  // them. With a top-level mcp_servers key already there, the whole block
  // pasted in as printed would be a second one, and YAML keeps only the
  // last: the servers under the first would be gone without an error.
  const { text, unread } = readHermesConfig(configPath);
  const indent = yamlServersIndent(text);
  const hermes = deps.which("hermes");
  const found = yamlHasServer(text, name);
  // A function, so the closure gets a plain string rather than a narrowed `string | null`.
  const oauthAdd = (file: string): HarnessPlan["cli"] => ({
    program: "hermes",
    file,
    argv: [
      ...["mcp", "add", name, "--url", url, "--auth", "oauth"],
      ...["--connect-timeout", String(HERMES_OAUTH_CONNECT_TIMEOUT_S)],
    ],
    attached: true,
    notSaved: () => hermesOauthNotSaved(deps, file, name, url, found),
  });
  // The API-key form is never run: `hermes mcp add` prompts for the key and
  // the tools to enable, and this port never hands a CLI the terminal for
  // it (Python's -y). The --oauth add signs in at its probe, so it runs
  // attached with a terminal and without -y, as in Python.
  const cli: HarnessPlan["cli"] = !input.oauth
    ? {
        program: null,
        reason:
          hermes === null ? notOnPath("hermes") : "`hermes mcp add` is interactive and this port never prompts",
      }
    : hermes === null
      ? { program: null, reason: notOnPath("hermes") }
      : !input.interactive
        ? { program: null, reason: oauthPrintReason(input, "is interactive") }
        : oauthAdd(hermes);
  // The config.yaml notes only go with a printed block (Python's `show_block`).
  if (cli.program === null || input.dryRun) {
    if (unread !== null) {
      notes.push(
        `Setup could not read ${where} (${unread}): if it already has a top-level mcp_servers: key, ` +
          `put only the ${name} entry under it.`,
      );
    } else if (indent !== null) {
      notes.push(
        `${where} already has a top-level mcp_servers: key, so only the entry is printed: a second one ` +
          "would replace the first and every server under it.",
      );
      if (yamlServersInline(text)) {
        notes.push(
          "Its mcp_servers value is written inline (flow style or null): rewrite it as a block mapping, " +
            `one server per indented key, before adding ${name}.`,
        );
      }
    }
  }

  return applyPlan(deps, {
    input,
    url,
    configPath,
    found,
    stops: hermes !== null,
    block: input.oauth
      ? hermesYamlOauthBlock(name, url, indent ?? undefined)
      : hermesYamlBlock(name, url, keyEnv, indent ?? undefined),
    blockTarget: indent === null ? "it" : "its mcp_servers: mapping",
    cli,
    notes,
    after: [
      input.oauth
        ? oauthLoginNote(
            "hermes",
            name,
            cli.program !== null,
            pathLabel(pathlibJoin(home, "mcp-tokens", `${name}.json`)),
          )
        : // Hermes resolves ${VAR} in config.yaml from its environment and
          // from the .env beside it.
          `Add \`${keyEnv}=<your-api-key>\` to ${pathLabel(pathlibJoin(home, ".env"))} with an editor: the ` +
          "entry reads it from there, and setup never sees the key.",
      `Check it with: ${shellCommand(["hermes", "mcp", "test", name])}`,
    ],
  });
}

/**
 * An OpenClaw path variable as OpenClaw reads it: stripped, and a leading
 * `~` expanded — Python's `_openclaw_env_path`. Null when unset or blank.
 */
function openclawEnvPath(name: string): string | null {
  const value = pyStrip(process.env[name] ?? "");
  return value ? pathlibString(expandUser(value)) : null;
}

/** `$OPENCLAW_STATE_DIR`, else `~/.openclaw`: OpenClaw's config and `.env`. */
function openclawStateDir(): string {
  return openclawEnvPath("OPENCLAW_STATE_DIR") ?? pathlibJoin(os.homedir(), ".openclaw");
}

/**
 * OpenClaw's default agent workspace, as its `resolveDefaultAgentWorkspaceDir`
 * finds it: `$OPENCLAW_WORKSPACE_DIR`, else `workspace` in the state
 * directory. An `agents.defaults.workspace` in openclaw.json overrides both
 * there; setup has no JSON5 reader, so `--agents-md PATH` names such a
 * workspace.
 */
function openclawWorkspaceDir(): string {
  return openclawEnvPath("OPENCLAW_WORKSPACE_DIR") ?? pathlibJoin(openclawStateDir(), "workspace");
}

async function runOpenclaw(deps: CliDeps, args: ParsedArgs): Promise<number> {
  const input = resolveHarnessInput(deps, args, "openclaw");
  await checkOauthServerFirst(deps, input);
  const { name, keyEnv } = input;
  const stateDir = openclawStateDir();
  const configPath = openclawEnvPath("OPENCLAW_CONFIG_PATH") ?? pathlibJoin(stateDir, "openclaw.json");
  const notes: string[] = [];
  const url = urlForNoInstructions(input, notes);
  const found = json5HasServer(readTextToScan(configPath, name, notes), name);

  // `add` refuses a name that exists, so replacing one goes through `set`,
  // as in Python; so does any --force run, since the scan could miss an
  // entry OpenClaw has. An --oauth entry is never probed by `add` (it waits
  // for `openclaw mcp login`); the API-key form skips the probe with
  // --no-probe, since the key is not in the .env yet.
  const replace = found || input.force;
  const argv = input.oauth
    ? replace
      ? ["mcp", "set", name, JSON.stringify(openclawOauthEntry(url))]
      : ["mcp", "add", name, "--url", url, "--transport", "streamable-http", "--auth", "oauth"]
    : replace
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
  const keyNote = input.oauth
    ? oauthLoginNote(
        "openclaw",
        name,
        openclaw !== null,
        `its state database (${pathLabel(pathlibJoin(stateDir, "state", "openclaw.sqlite"))})`,
      )
    : // The .env is in the state directory, even when OPENCLAW_CONFIG_PATH
      // puts the config elsewhere.
      `Add \`${keyEnv}=<your-api-key>\` to ${pathLabel(pathlibJoin(stateDir, ".env"))} with an editor: ` +
      `the entry sends \${${keyEnv}} (mcp.servers headers take no SecretRef), and setup never sees ` +
      "the key.";
  return applyPlan(deps, {
    input,
    url,
    configPath,
    found,
    stops: openclaw !== null,
    block: input.oauth ? openclawOauthBlock(name, url) : openclawBlock(name, url, keyEnv),
    blockTarget: "it",
    cli:
      openclaw === null
        ? { program: null, reason: notOnPath("openclaw") }
        : { program: "openclaw", file: openclaw, argv },
    notes,
    after: [
      keyNote,
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
    GUARDRAILS_ADVICE +
    "\n\n" +
    examples(
      "setup claude",
      "setup claude --profile default        # OAuth via kagura-mcp (recommended)",
      "setup claude --profile default --scope user   # one entry for every project",
      "setup claude --profile default --guardrails off --tool-profile core",
      "setup claude --api-key kagura_xxx --mcp-url http://localhost:8080/mcp/w/{workspace_id}",
      "setup claude -y --api-key kagura_xxx --context-id my-project",
      "setup claude --no-commands      # plugin users: its /kagura-memory:* instead",
      "setup claude --no-auto-context  # always show full context list",
    ),
  spec: { flags: [...COMMON_FLAGS, GUARDRAILS, SCOPE, TOOL_PROFILE, ...PYTHON_ONLY_FLAGS] },
  run: (deps, args) => runClaude(deps as CliDeps, args),
};

/**
 * The rule the MCP URL of every harness setup follows (python-sdk#279), for
 * their help.
 */
const MCP_URL_RULE =
  "  The MCP URL must be an http(s) URL with a host. Padding, control\n" +
  "  characters and tabs or newlines inside it are dropped before the HTTPS\n" +
  "  check, and the entry gets the URL that check read.";

const codex: Command = {
  summary: "Set up Kagura Memory for OpenAI Codex (CLI and IDE extension).",
  description:
    "  Adds the kagura-memory MCP server with `codex mcp add NAME --url URL\n" +
    "  --bearer-token-env-var KAGURA_API_KEY`, which writes ~/.codex/config.toml\n" +
    "  ($CODEX_HOME); with --force the same command replaces an entry of the\n" +
    "  same name. Without codex on PATH, setup prints the [mcp_servers] table\n" +
    "  to add instead. The entry names the variable Codex reads the API key\n" +
    "  from when it connects (--api-key-env renames it): setup never sees the\n" +
    "  key. Check it with: codex mcp get kagura-memory.\n\n" +
    "  Codex reads the server's MCP instructions, so --context-id (a UUID) or\n" +
    "  --guardrails CONTEXT_ID puts that context's tool guardrail digest in\n" +
    "  them. While the kagura-memory Codex plugin's guardrail hooks are on for\n" +
    "  the entry, they deliver guardrails themselves, and the URL gets\n" +
    "  ?guardrails=off instead. A guardrails value already in the MCP URL\n" +
    "  (--mcp-url or the configured mcp_url) is kept. --agents-md also puts\n" +
    "  the context's export block into ~/.codex/AGENTS.md, fetched with the\n" +
    "  usual credential (KAGURA_API_KEY, the OAuth profile, .kagura.json),\n" +
    "  which must be for the entry's server.\n\n" +
    "  With --url-form --oauth (memory-cloud 0.77.0+, whose client registration\n" +
    "  accepts Codex; setup checks the version first), the entry is a bare URL\n" +
    "  and Codex then signs in itself: `codex mcp add` starts the browser\n" +
    "  sign-in, so setup runs it attached to this terminal (its output on\n" +
    "  stderr) only with a terminal on stdin and without -y, and otherwise\n" +
    "  prints the table for you to add and sign in with `codex mcp login\n" +
    "  NAME`. Codex keeps the token in its own store, keyed on the URL. The\n" +
    "  API-key URL form stays the default.\n\n" +
    `${MCP_URL_RULE}\n\n` +
    GUARDRAILS_ADVICE +
    "\n\n" +
    examples(
      "setup codex --profile default",
      "setup codex --profile default --context-id CTX_UUID",
      "setup codex --url-form --mcp-url https://memory.kagura-ai.com/mcp/w/WS_ID",
      "setup codex --url-form --oauth --mcp-url https://memory.kagura-ai.com/mcp/w/WS_ID",
      "setup codex --profile default --dry-run",
    ),
  spec: {
    flags: [
      HARNESS_PROFILE,
      NAME,
      HARNESS_CONTEXT_ID,
      CODEX_GUARDRAILS,
      agentsMd(
        "Also write the context's tool guardrail export block into PATH (default ~/.codex/AGENTS.md, " +
          "or AGENTS.override.md when it exists). Rarely needed: the digest already arrives in the MCP " +
          "instructions. Only the marked block changes.",
      ),
      TOOL_PROFILE,
      ...HARNESS_TAIL,
      apiKeyEnv(
        "The variable Codex reads the API key from (bearer_token_env_var; default KAGURA_API_KEY, " +
          "which every kagura-memory command also ranks above OAuth profiles). Not with --oauth.",
      ),
      oauthFlag(
        "With --url-form: a URL entry with no key. memory-cloud 0.77.0+ (setup checks first) accepts Codex's client " +
          "registration, and Codex then signs in itself: `codex mcp add` starts the browser sign-in, so it runs only " +
          "with a terminal and without -y; otherwise setup prints the table, and you sign in with `codex mcp login " +
          "NAME` (--no-browser when the browser cannot reach Codex's loopback callback).",
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
    "  else ~/.hermes) and, for the API-key form, changes nothing there:\n" +
    "  `hermes mcp add` asks for the key, and this port never prompts. When\n" +
    "  config.yaml already has an mcp_servers key, the entry alone is\n" +
    "  printed, to go under it. The\n" +
    "  entry reads the API key from MCP_<NAME>_API_KEY (MCP_KAGURA_MEMORY_API_KEY\n" +
    "  by default), the variable `hermes mcp add` derives from --name, in the\n" +
    "  .env beside config.yaml: add the key there yourself; setup never sees\n" +
    "  it. Check it with: hermes mcp test kagura-memory.\n\n" +
    "  Hermes does not read MCP instructions: guardrails reach it through\n" +
    "  get_context_info (on by default) and, if you choose, an export block\n" +
    "  (--agents-md with --context-id, or a --guardrails CONTEXT_ID) in the\n" +
    "  context file Hermes loads from this directory, so a user's own file\n" +
    "  keeps loading. Hermes loads only the first type it finds\n" +
    "  (.hermes.md/HERMES.md, AGENTS files, CLAUDE.md, Cursor rules); with\n" +
    "  only Cursor rules, name a file with --agents-md PATH. --guardrails off\n" +
    "  is refused, and a context id, from the flag or the URL, is not written;\n" +
    "  a first ?guardrails=off in the URL is kept, alone, with a warning.\n\n" +
    "  With --url-form --oauth (memory-cloud 0.77.0+, whose client registration\n" +
    "  accepts Hermes Agent; setup checks the version first), the entry is a\n" +
    "  URL with `auth: oauth`. With a terminal on stdin and without -y, setup\n" +
    "  runs `hermes mcp add NAME --url URL --auth oauth --connect-timeout 315`\n" +
    "  attached to this terminal (its output on stderr): Hermes signs in when\n" +
    "  it probes the server, within the bound `hermes mcp login` uses, which\n" +
    "  it keeps as the entry's connect_timeout. Setup then reads the entry\n" +
    "  back with `hermes config get` and stops (exit 1) when Hermes kept\n" +
    "  another entry, saved one without auth: oauth, or saved it disabled.\n" +
    "  With -y or without a terminal, it prints the block instead. Sign in\n" +
    "  later with `hermes mcp login NAME` (the browser flow), or on\n" +
    "  memory-cloud 0.78.0+ with `hermes mcp login NAME --flow device`, which\n" +
    "  needs no loopback callback. The API-key URL form stays the default.\n\n" +
    MCP_URL_RULE +
    "\n\n" +
    examples(
      "setup hermes --profile default",
      "setup hermes --profile default --context-id CTX_UUID --agents-md",
      "setup hermes --url-form --mcp-url https://memory.kagura-ai.com/mcp/w/WS_ID",
      "setup hermes --url-form --oauth --mcp-url https://memory.kagura-ai.com/mcp/w/WS_ID",
      "setup hermes --profile default -y     # print the block only",
    ),
  spec: {
    flags: [
      HARNESS_PROFILE,
      NAME,
      HARNESS_CONTEXT_ID,
      guardrailsNotWritten("Hermes"),
      agentsMd(
        "Write the context's tool guardrail export block into PATH (default: the context file Hermes loads " +
          "from here: the nearest .hermes.md or HERMES.md up to the git root, else this directory's AGENTS " +
          "file, else its CLAUDE.md, else a new AGENTS.md; none when only Cursor rules load, which a new " +
          "AGENTS.md would stop loading). Only the marked block changes; an empty set removes it.",
      ),
      ...HARNESS_TAIL,
      apiKeyEnv("Not accepted: Hermes names the variable MCP_<NAME>_API_KEY"),
      oauthFlag(
        "With --url-form: a URL entry with `auth: oauth` and no key. memory-cloud 0.77.0+ (setup checks first) " +
          "accepts Hermes's client registration, and Hermes then signs in itself when `hermes mcp add` probes it " +
          "(given --connect-timeout 315, which Hermes keeps), or later with `hermes mcp login NAME`; on memory-cloud " +
          "0.78.0+, `hermes mcp login NAME --flow device` signs in with a code and needs no loopback callback.",
      ),
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
    "  `openclaw mcp set`. Both write openclaw.json in $OPENCLAW_STATE_DIR\n" +
    "  (else ~/.openclaw), or $OPENCLAW_CONFIG_PATH, which the Gateway\n" +
    "  hot-reloads. Without openclaw on PATH, setup prints the mcp.servers\n" +
    "  block instead. OpenClaw fills in ${KAGURA_API_KEY} (--api-key-env\n" +
    "  renames it) from the .env in its state directory: add the key there\n" +
    "  yourself; setup never sees it. Check it with: openclaw mcp doctor\n" +
    "  kagura-memory --probe.\n\n" +
    "  OpenClaw does not read MCP instructions: guardrails reach it through\n" +
    "  get_context_info (on by default) and, if you choose, an export block in\n" +
    "  AGENTS.md in its default workspace, $OPENCLAW_WORKSPACE_DIR or else\n" +
    "  workspace/ in that state directory (--agents-md). As on Hermes,\n" +
    "  --guardrails off is refused, and a context id, from the flag or the\n" +
    "  URL, is not written; a first ?guardrails=off in the URL is kept, alone,\n" +
    "  with a warning.\n\n" +
    "  With --url-form --oauth (memory-cloud 0.77.0+, whose client registration\n" +
    "  accepts OpenClaw; setup checks the version first), the entry is a URL\n" +
    '  with `auth: "oauth"` and no header, which OpenClaw saves without\n' +
    "  probing: sign in with `openclaw mcp login NAME`, then check it with\n" +
    "  `openclaw mcp doctor NAME --probe`. The API-key URL form stays the\n" +
    "  default.\n\n" +
    MCP_URL_RULE +
    "\n\n" +
    examples(
      "setup openclaw --profile default",
      "setup openclaw --profile default --context-id CTX_UUID --agents-md",
      "setup openclaw --url-form --mcp-url https://memory.kagura-ai.com/mcp/w/WS_ID",
      "setup openclaw --url-form --oauth --mcp-url https://memory.kagura-ai.com/mcp/w/WS_ID",
      "setup openclaw --profile default --force",
    ),
  spec: {
    flags: [
      HARNESS_PROFILE,
      NAME,
      HARNESS_CONTEXT_ID,
      guardrailsNotWritten("OpenClaw"),
      agentsMd(
        "Write the context's tool guardrail export block into PATH (default AGENTS.md in the workspace " +
          "OpenClaw loads every session: $OPENCLAW_WORKSPACE_DIR, else workspace/ in $OPENCLAW_STATE_DIR " +
          "or ~/.openclaw). Only the marked block changes.",
      ),
      ...HARNESS_TAIL,
      apiKeyEnv(
        "The variable the Authorization header references, kept in OpenClaw's .env " +
          "($OPENCLAW_STATE_DIR, else ~/.openclaw; default KAGURA_API_KEY). Not with --oauth.",
      ),
      oauthFlag(
        "With --url-form: a URL entry with `auth: oauth` and no key. memory-cloud 0.77.0+ (setup checks first) " +
          "accepts OpenClaw's client registration. OpenClaw saves the entry without probing; sign in with `openclaw " +
          "mcp login NAME`, then run `openclaw mcp doctor NAME --probe`.",
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
