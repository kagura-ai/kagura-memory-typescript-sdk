/**
 * `kagura-memory setup <harness>` — connect a coding agent to Kagura Memory.
 *
 * Every subcommand writes `.kagura.json` in the project directory, merged
 * with whatever is already there and gitignored, plus a `kagura-memory`
 * MCP entry for its harness: the URL and a Bearer header.
 *
 *   claude    `.mcp.json` (project scope) or `claude mcp add-json` (user)
 *   codex     `codex mcp add`, reading the key from KAGURA_API_KEY
 *   hermes    the key in its `.env`; the `config.yaml` block printed
 *   openclaw  `openclaw mcp add`; the key in its `.env`
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
  upsertEnvLine,
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
const PROFILE: FlagSpec = { name: "profile", type: "value", help: "OAuth profile name" };
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
  metavar: "CONTEXT_ID|off",
  help: "Set the URL's guardrails parameter: a context id, or off",
};
// Hermes and OpenClaw take the flag so a script can pass it to every
// harness alike, but nothing it sets reaches their entry.
const GUARDRAILS_NOT_WRITTEN: FlagSpec = {
  ...GUARDRAILS,
  help: "Validated, not written: off is refused and a context id dropped",
};
const TOOL_PROFILE: FlagSpec = {
  name: "tool-profile",
  type: "value",
  metavar: "NAME",
  help: "Set the URL's profile parameter (e.g. core); a ?tools= allowlist wins",
};
const SCOPE: FlagSpec = {
  name: "scope",
  type: "value",
  metavar: "[project|user]",
  help: "project (.mcp.json) or user (claude mcp add-json)",
  defaultLabel: "project",
};
const NAME: FlagSpec = {
  name: "name",
  type: "value",
  help: "Server name for the entry",
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
  help: "Print what would be configured; write and run nothing",
};

const COMMON_FLAGS = [API_KEY, MCP_URL, CONTEXT_ID, PROFILE, PROJECT_DIR, NON_INTERACTIVE];
const HARNESS_FLAGS = [NAME, FORCE, DRY_RUN];

const GUARDRAILS_ADVICE =
  "  Pass --guardrails a context id only for a context whose editor list you\n" +
  "  control. The server ignores any value but a UUID or off, so anything\n" +
  "  else is refused here.";

type Harness = "claude" | "codex" | "hermes" | "openclaw";

const LABEL: Record<Harness, string> = {
  claude: "Claude Code",
  codex: "Codex",
  hermes: "Hermes",
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
 * Harnesses that do not pass the server's `instructions` to the model.
 *
 * There, `guardrails=<context>` changes nothing, and `off` would also
 * remove the `get_context_info` block — the one guardrail lane left.
 */
const NO_INSTRUCTIONS: ReadonlySet<Harness> = new Set(["hermes", "openclaw"]);

/** The refusal of `off`, however it was asked for, on a NO_INSTRUCTIONS harness. */
function refuseGuardrailsOff(harness: Harness, what: string): CliUsageError {
  return new CliUsageError(
    `${what} is not available for ${LABEL[harness]}: it does not pass the server's\n` +
      "  instructions to the model, and off would also remove the get_context_info block,\n" +
      "  the only guardrail lane it has.",
  );
}

/**
 * Why a harness CLI was not run.
 *
 * `which` passes over a Windows `.cmd` shim, which Node runs only through
 * a shell that would re-parse the argv; an npm-installed CLI there is one,
 * so a bare "not on PATH" would be untrue.
 */
function notFound(program: string): string {
  return `\`${program}\` was not found on PATH (a Windows .cmd shim is not run: it needs a shell)`;
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
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    // Overwriting a file we could not understand would discard whatever
    // the operator had configured there.
    throw new CliError(
      `refusing to rewrite ${target}: it is not a JSON object (${e instanceof Error ? e.message : String(e)})`,
    );
  }
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

/** A harness config's text, or "" when it does not exist yet. */
function readText(target: string): string {
  try {
    return fs.readFileSync(target, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new CliError(`cannot read ${target}: ${e instanceof Error ? e.message : String(e)}`);
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
 * Set the key's line in a harness `.env`.
 *
 * The file is line-based, so unlike the harness configs it is written
 * here: one line replaced or appended, and every other line kept.
 */
function writeEnvFile(target: string, name: string, value: string): void {
  const text = upsertEnvLine(readText(target), name, value);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writePrivate(target, text);
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
 * Validate `--name`.
 *
 * Codex accepts nothing else, and keeping to these characters lets the
 * name go bare into the printed TOML and YAML and into the variable
 * Hermes derives from it. The first one is a letter or digit because the
 * name is also a bare positional in the `codex` and `openclaw` argv: there
 * `--name=--help` would be read as an option, and the harness CLI would
 * print its help and exit 0 with nothing configured.
 */
function parseName(args: ParsedArgs): string {
  const name = args.values.name ?? SERVER_NAME;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new CliUsageError(
      `Invalid value for '--name': ${quote(name)} must start with a letter or digit and contain ` +
        "only letters, digits, '-' and '_'.",
    );
  }
  return name;
}

interface SetupInput {
  harness: Harness;
  projectDir: string;
  apiKey: string;
  /** `--api-key` was passed, rather than the key found in config. */
  keyFlag: boolean;
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
}

/** What every `setup` subcommand resolves before touching anything. */
function resolveInput(deps: CommandDeps, args: ParsedArgs, harness: Harness): SetupInput {
  rejectExtraArgs(args);
  // First, as click runs Python's option callbacks while it parses.
  const guardrails = parseGuardrails(args.values.guardrails);
  const toolProfile = parseToolProfile(args.values["tool-profile"]);
  const apiKey = args.values["api-key"];
  const profile = args.values.profile;

  if (profile !== undefined && apiKey !== undefined) {
    throw new CliUsageError(
      "--profile (OAuth) and --api-key (static token) are mutually exclusive; pick one.",
    );
  }
  if (profile !== undefined) {
    // Writing the stdio form would name `kagura-mcp`, a Python console
    // script this package does not install — the config would look right
    // and fail at launch.
    // Only `kagura setup claude --profile` exists in the Python CLI today
    // (python-sdk#260 adds the other harnesses), so name it for claude alone.
    const pythonRoute =
      harness === "claude"
        ? `  Use \`pip install kagura-memory && kagura setup claude --profile ${profile}\`, ` +
          "or set up the static-token form here with --api-key."
        : "  Set up the static-token form here with --api-key.";
    throw new CliError(
      `the OAuth (--profile) setup writes ${OAUTH_TARGET[harness]} that launches the \`kagura-mcp\` stdio\n` +
        "  proxy, which ships with the Python package, not this one.\n" +
        pythonRoute,
    );
  }

  if (guardrails === "off" && NO_INSTRUCTIONS.has(harness)) {
    throw refuseGuardrailsOff(harness, "--guardrails off");
  }

  const projectDir = path.resolve(args.values["project-dir"] ?? ".");
  if (!fs.existsSync(projectDir)) {
    throw new CliUsageError(`Invalid value for '--project-dir': ${projectDir} does not exist.`);
  }

  // Fall back to whatever is already configured, so re-running with no
  // flags refreshes the files rather than blanking them.
  const { config } = resolveConfig(deps, undefined, false);
  // Then to KAGURA_API_KEY: the loader reads it only when no .kagura.json
  // exists, and setup codex writes one without the key when the key came
  // from that variable — its own re-run would otherwise find none.
  const configKey = typeof config.api_key === "string" ? config.api_key : "";
  const resolvedKey = apiKey ?? (configKey || process.env[KEY_ENV_VAR] || "");
  const baseUrl =
    args.values["mcp-url"] ??
    (typeof config.mcp_url === "string" && config.mcp_url ? config.mcp_url : DEFAULT_MCP_URL);
  const contextFlag = Boolean(args.values["context-id"]);
  const contextId = args.values["context-id"] || config.context_id || "";

  // The flag's off, carried in the URL instead — given with --mcp-url, or
  // left in .kagura.json — would remove that one lane just the same.
  if (NO_INSTRUCTIONS.has(harness) && queryParam(baseUrl, "guardrails")?.toLowerCase() === "off") {
    throw refuseGuardrailsOff(harness, `guardrails=off in the MCP URL (${baseUrl})`);
  }

  if (!resolvedKey) {
    // No word of `auth login`: setup writes an API-key entry, and an OAuth
    // profile does not give it one.
    throw new CliError(
      `no API key: pass --api-key, set api_key in .kagura.json, or export ${KEY_ENV_VAR}.`,
    );
  }
  return {
    harness,
    projectDir,
    apiKey: resolvedKey,
    keyFlag: apiKey !== undefined,
    baseUrl,
    contextId,
    contextFlag,
    guardrails,
    toolProfile,
    kagura: readJsonSafe(path.join(projectDir, ".kagura.json")),
  };
}

/**
 * Merge the URL, context and (unless `withKey` is false) the key into
 * `.kagura.json`; returns its path.
 */
function writeKaguraJson(input: SetupInput, withKey = true): string {
  const target = path.join(input.projectDir, ".kagura.json");
  const kagura = { ...input.kagura };
  if (withKey) kagura.api_key = input.apiKey;
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

function report(deps: CommandDeps, input: SetupInput, outcome: Outcome): number {
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
 * Run a harness CLI, failing with its own message.
 *
 * `claude mcp add-json` carries the key in its argv, and a CLI may echo
 * its argv back in an error, so the key is cut out of whatever is shown.
 */
async function runHarnessCli(
  deps: CliDeps,
  file: string,
  argv: string[],
  display: string,
  apiKey: string,
  options?: ExecOptions,
): Promise<void> {
  const result = await deps.execFile(file, argv, options);
  if (result.code === 0) return;
  const detail = (result.stderr.trim() || result.stdout.trim()).split(apiKey).join("<redacted>");
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

function claudeEntry(url: string, apiKey: string): Record<string, unknown> {
  // `http`: Claude Code's transports are stdio, sse, http and ws. Earlier
  // releases wrote `url`, which is none of them.
  return { type: "http", url, headers: { Authorization: `Bearer ${apiKey}` } };
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

/**
 * The user-scope `claude mcp add-json` command, runnable, with the key as
 * `"$KAGURA_API_KEY"` spliced between two single-quoted halves — the one
 * POSIX spelling that expands the variable and nothing else.
 */
function claudeAddJsonDisplay(url: string): string {
  const marker = "@@KEY@@";
  const [before, after] = JSON.stringify(claudeEntry(url, marker)).split(marker) as [string, string];
  return `${claudeCommand([...CLAUDE_ADD_JSON])} ${shellQuote(before)}"$${KEY_ENV_VAR}"${shellQuote(after)}`;
}

/** One `kagura-memory` definition Claude Code sees for a project. */
export interface ClaudeEntry {
  scope: ClaudeScope;
  /**
   * Where it lives, for messages: `~/.claude.json`, `.mcp.json` for the
   * project's own file, or a parent directory's `.mcp.json` by its path.
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
  const stateDir = process.env.CLAUDE_CONFIG_DIR || os.homedir();
  const statePath = path.join(stateDir, ".claude.json");
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
    ["local", "~/.claude.json", statePath, local],
    ["project", mcpJsonLabel, mcpJson.file, mcpJson.servers],
    ["user", "~/.claude.json", statePath, state.mcpServers],
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

/** The `kagura-mcp` proxy's names, as a command or a launcher's argument. */
const PROXY_NAMES: ReadonlySet<string> = new Set(["kagura-mcp", "kagura-mcp.exe"]);

/**
 * Whether an entry is the `kagura-mcp` stdio proxy — Python's
 * `classify_mcp_entry(...) == "stdio"`: no type or `stdio`, and the
 * command, or an argument of a launcher such as `uvx`, named `kagura-mcp`.
 */
function runsProxy(entry: Record<string, unknown>): boolean {
  if (entry.type !== undefined && entry.type !== null && entry.type !== "stdio") return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return [entry.command, ...args].some(
    (a) => typeof a === "string" && PROXY_NAMES.has(a.split(/[\\/]/).pop()!),
  );
}

/**
 * The `--guardrails` / `--tool-profile` values an entry puts on the MCP
 * URL — Python's `_query_flags`: from the `kagura-mcp` arguments of a
 * stdio entry (which the Python CLI's `--profile` setup writes), or from
 * the first value of each parameter in an http entry's URL. An empty value
 * does not count, as `parse_qsl` drops it.
 */
function queryFlags(entry: Record<string, unknown>): Map<string, string> {
  const found = new Map<string, string>();
  if (runsProxy(entry)) {
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
 * identity — and put back if the add then fails.
 */
async function writeUserEntry(
  deps: CliDeps,
  claude: string,
  input: SetupInput,
  url: string,
  replaces: Record<string, unknown> | null,
): Promise<void> {
  const run = (argv: string[], display: string) =>
    runHarnessCli(deps, claude, argv, display, input.apiKey, CLAUDE_EXEC);
  const addDisplay = `${claudeCommand([...CLAUDE_ADD_JSON])} '<entry>'`;
  if (replaces !== null) await run(claudeRemoveArgs("user"), claudeCommand(claudeRemoveArgs("user")));
  try {
    await run(claudeAddJsonArgs(claudeEntry(url, input.apiKey)), addDisplay);
  } catch (e) {
    if (replaces === null || !(e instanceof CliError)) throw e;
    try {
      // Its output is never shown: the old entry may carry an older key.
      await run(claudeAddJsonArgs(replaces), addDisplay);
    } catch {
      // Neither entry is configured now, and the failure alone would not
      // say so.
      throw new CliError(
        `${e.message}\n` +
          `  The previous user-scope '${SERVER_NAME}' entry was removed before this, so none is\n` +
          `  configured now. With ${KEY_ENV_VAR} exported, add the new one with:\n` +
          `    ${claudeAddJsonDisplay(url)}`,
      );
    }
    throw new CliError(`${e.message}\n  The previous user-scope '${SERVER_NAME}' entry was put back.`);
  }
}

async function runClaude(deps: CliDeps, args: ParsedArgs): Promise<number> {
  const input = resolveInput(deps, args, "claude");
  const scope = parseChoice(SCOPE, args.values.scope ?? "project", CLAUDE_TARGET_SCOPES);
  const notes = toolsAllowlistWarning(input.baseUrl, input.toolProfile);
  const url = mcpUrlWithQuery(input.baseUrl, { guardrails: input.guardrails, profile: input.toolProfile });
  const entry = claudeEntry(url, input.apiKey);
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
    // This bin never edits ~/.claude.json itself: Claude Code owns it.
    deps.writeError("  Add the user-scope entry yourself, then re-run this setup:");
    if (replaces !== null) deps.writeError(`    ${claudeCommand(claudeRemoveArgs("user"))}`);
    deps.writeError(`    ${claudeAddJsonDisplay(url)}`);
    throw new CliError(
      "The Claude Code CLI (`claude`) was not found on PATH (a Windows .cmd shim is not run: it " +
        "needs a shell). A user-scope entry lives in ~/.claude.json, which Claude Code owns, so " +
        "setup writes it only through `claude mcp add-json`. Nothing was written.",
    );
  }

  const pluginId = await detectClaudePlugin(deps, claude, input.projectDir);

  const wrote: string[] = [];
  const secretFiles = [".kagura.json"];
  let appliedWith: string | null = null;

  if (scope === "user") {
    if (unchanged) {
      notes.push(`User-scope ${SERVER_NAME} entry already up to date (~/.claude.json)`);
    } else {
      // `claude` first, so one that refuses the entry leaves every file as
      // it was.
      await writeUserEntry(deps, claude!, input, url, replaces);
      appliedWith = claudeAddJsonDisplay(url);
      if (replaces !== null) notes.push("replaced the existing user-scope entry");
    }
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
    notes.push(
      "Plugin settings (/plugin > kagura-memory > Configure; the API key is yours): " +
        `server_url = ${pluginServerUrl(url)}, ` +
        `context_id = ${input.contextId || "(none; pass -c)"}`,
    );
  }

  const gitignoreAdded = protectSecrets(input.projectDir, secretFiles);
  return report(deps, input, { status: "success", wrote, gitignoreAdded, url, appliedWith, notes });
}

// --- codex, hermes, openclaw ----------------------------------------------

interface HarnessPlan {
  input: SetupInput;
  name: string;
  /** The URL in the entry, query included. */
  url: string;
  /** The harness config file the entry belongs in. */
  configPath: string;
  /** Whether configPath already has an entry of this name. */
  exists: boolean;
  force: boolean;
  dryRun: boolean;
  /** The entry as the user would add it to configPath. */
  block: string;
  /** Where in configPath the block goes, for messages; configPath itself when absent. */
  blockTarget?: string;
  /**
   * The harness CLI that applies the entry without prompting, or null
   * with the reason it is not used.
   */
  cli: { program: string; argv: string[] } | { program: null; reason: string };
  /** Where the key goes, for a harness that reads it from a file. */
  envFile: { path: string; name: string } | null;
  /** Whether `.kagura.json` gets the key as well. */
  keyInKaguraJson: boolean;
  notes: string[];
}

/** Carry out a plan: apply the entry or print it, then write the local files. */
async function applyPlan(deps: CliDeps, plan: HarnessPlan): Promise<number> {
  const { input, notes } = plan;

  if (plan.exists && !plan.force) {
    if (!plan.dryRun) {
      throw new CliError(
        `${plan.configPath} already has an MCP server named '${plan.name}'.\n` +
          "  Re-run with --force to replace it.",
      );
    }
    notes.push(`${plan.configPath} already has '${plan.name}'; a real run needs --force`);
  }

  const cli = plan.cli.program === null ? null : plan.cli;
  const file = cli === null ? null : deps.which(cli.program);
  const display = cli === null ? null : shellCommand([cli.program, ...cli.argv]);
  const manual = plan.cli.program === null ? plan.cli.reason : notFound(plan.cli.program);

  if (plan.dryRun) {
    printBlock(deps, `Would configure ${plan.configPath}:`, plan.block);
    notes.unshift("dry run: nothing was written or run");
    notes.push(file !== null ? `would run: ${display}` : `${manual}; a real run prints this block too`);
    if (plan.envFile !== null) notes.push(`would set ${plan.envFile.name} in ${plan.envFile.path}`);
    return report(deps, input, {
      status: "dry_run",
      wrote: [],
      gitignoreAdded: [],
      url: plan.url,
      appliedWith: null,
      notes,
    });
  }

  let appliedWith: string | null = null;
  if (cli !== null && file !== null && display !== null) {
    // First, so a harness that refuses the entry leaves every file as it was.
    await runHarnessCli(deps, file, cli.argv, display, input.apiKey);
    appliedWith = display;
  } else {
    const target = plan.blockTarget ?? plan.configPath;
    printBlock(deps, `Add this to ${target}:`, plan.block);
    notes.push(`${manual}; add the block printed on stderr to ${target}`);
    if (plan.exists) notes.push(`replace the existing '${plan.name}' entry there with it`);
  }

  const wrote: string[] = [];
  if (plan.envFile !== null) {
    writeEnvFile(plan.envFile.path, plan.envFile.name, input.apiKey);
    wrote.push(plan.envFile.path);
  }
  const kaguraPath = writeKaguraJson(input, plan.keyInKaguraJson);
  wrote.push(kaguraPath);
  if (!plan.keyInKaguraJson) {
    notes.push(
      `the key came from ${KEY_ENV_VAR}, where ${LABEL[input.harness]} reads it, so it was not ` +
        `copied into ${kaguraPath}`,
    );
  }
  const gitignoreAdded = protectSecrets(input.projectDir, [".kagura.json"]);
  return report(deps, input, {
    status: "success",
    wrote,
    gitignoreAdded,
    url: plan.url,
    appliedWith,
    notes,
  });
}

/** Whether the Kagura plugin's Codex hooks have been turned on. */
function codexHooksOn(codexHome: string): boolean {
  const dataDir = path.join(codexHome, "plugins", "data");
  let entries: string[];
  try {
    entries = fs.readdirSync(dataDir);
  } catch {
    return false;
  }
  return entries.some(
    (entry) =>
      entry.startsWith(`${SERVER_NAME}-`) && fs.existsSync(path.join(dataDir, entry, "config.json")),
  );
}

async function runCodex(deps: CliDeps, args: ParsedArgs): Promise<number> {
  // The name first: a usage error, as click reports before it runs anything.
  const name = parseName(args);
  const input = resolveInput(deps, args, "codex");
  const notes = toolsAllowlistWarning(input.baseUrl, input.toolProfile);
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");

  // Codex hands the server's instructions to the model, so guardrails
  // take effect here. A value already in --mcp-url is kept as written.
  let guardrails = input.guardrails;
  if (guardrails === undefined && queryParam(input.baseUrl, "guardrails") === undefined) {
    if (codexHooksOn(codexHome)) {
      // The plugin's hooks read this same table and deliver the
      // guardrails themselves; the server need not repeat them.
      guardrails = "off";
      notes.push("the Kagura plugin's Codex hooks are on, so guardrails defaults to off");
    } else if (input.contextFlag) {
      if (isUuid(input.contextId)) {
        guardrails = parseUuid(input.contextId);
        notes.push("guardrails defaults to the -c context; pass --guardrails off to turn them off");
      } else {
        notes.push(`-c ${quote(input.contextId)} is not a UUID, so it was not used for guardrails`);
      }
    }
  }
  const url = mcpUrlWithQuery(input.baseUrl, { guardrails, profile: input.toolProfile });

  // The key cannot be stored for Codex: it reads the variable from the
  // environment of the shell that starts it.
  notes.push(
    `Codex reads the key from its environment: export ${KEY_ENV_VAR} in the shell that ` +
      "starts it, or in that shell's profile",
  );

  return applyPlan(deps, {
    input,
    name,
    url,
    configPath,
    exists: tomlHasServer(readText(configPath), name),
    force: args.flags.has("force"),
    dryRun: args.flags.has("dry-run"),
    block: codexTomlBlock(name, url),
    // Naming an env var also makes Codex skip its OAuth probe. `add`
    // overwrites an entry of the same name, so --force needs no other
    // form; the existence check is what makes that overwrite opt-in.
    cli: {
      program: "codex",
      argv: ["mcp", "add", name, "--url", url, "--bearer-token-env-var", KEY_ENV_VAR],
    },
    envFile: null,
    // A key already in KAGURA_API_KEY stays only there: that is where the
    // user chose to keep it, and this bin reads it from there too.
    keyInKaguraJson: input.keyFlag || process.env[KEY_ENV_VAR] !== input.apiKey,
    notes,
  });
}

/**
 * The entry URL for a harness that does not pass the server's
 * instructions to the model: without `guardrails`, whether that came from
 * the flag or the URL, and a note saying so. `off` never gets here;
 * `resolveInput` refuses it.
 */
function urlWithoutGuardrails(input: SetupInput, notes: string[]): string {
  const value = input.guardrails ?? queryParam(input.baseUrl, "guardrails");
  if (value === undefined) return input.baseUrl;
  const label = LABEL[input.harness];
  notes.push(
    `guardrails=${value} was not written: ${label} does not pass the server's ` +
      `instructions to the model. On ${label}, guardrails arrive through ` +
      "get_context_info(context_id) at session start",
  );
  return withoutQueryParam(input.baseUrl, "guardrails");
}

async function runHermes(deps: CliDeps, args: ParsedArgs): Promise<number> {
  const name = parseName(args);
  const input = resolveInput(deps, args, "hermes");
  const notes: string[] = [];
  const url = urlWithoutGuardrails(input, notes);

  const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  const configPath = path.join(hermesHome, "config.yaml");
  const envVar = hermesEnvVar(name);
  const text = readText(configPath);

  // With a top-level mcp_servers key already there, the whole block pasted
  // in as printed would be a second one, and YAML keeps only the last: the
  // servers under the first would be gone without an error.
  const indent = yamlServersIndent(text);
  if (indent !== null) {
    notes.push(
      `${configPath} already has a top-level mcp_servers: key, so only the ${name} entry is ` +
        "printed: a second mcp_servers: key would replace the first, and the servers under it with it",
    );
    if (yamlServersInline(text)) {
      notes.push(
        `${configPath} writes its mcp_servers value inline (flow style or null); rewrite it as a ` +
          `block mapping, one server per indented key, before adding the ${name} entry under it`,
      );
    }
  }

  return applyPlan(deps, {
    input,
    name,
    url,
    configPath,
    exists: yamlHasServer(text, name),
    force: args.flags.has("force"),
    dryRun: args.flags.has("dry-run"),
    block: hermesYamlBlock(name, url, envVar, indent ?? undefined),
    blockTarget: indent === null ? undefined : `the mcp_servers: mapping in ${configPath}`,
    cli: {
      program: null,
      reason:
        "`hermes mcp add` always prompts (for authentication, the key and the tools to enable), " +
        "so it is not run",
    },
    // Hermes resolves ${VAR} in config.yaml from its environment and from
    // this file.
    envFile: { path: path.join(hermesHome, ".env"), name: envVar },
    keyInKaguraJson: true,
    notes,
  });
}

async function runOpenclaw(deps: CliDeps, args: ParsedArgs): Promise<number> {
  const name = parseName(args);
  const input = resolveInput(deps, args, "openclaw");
  const force = args.flags.has("force");
  const notes: string[] = [];
  const url = urlWithoutGuardrails(input, notes);

  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");

  // `add` refuses a name that exists, so --force goes through `set`.
  // --no-probe: the docs do not say whether the probe reads the .env the
  // key is written to, so a probe could fail an entry that works.
  const argv = force
    ? ["mcp", "set", name, JSON.stringify(openclawEntry(url))]
    : [
        "mcp",
        "add",
        name,
        "--url",
        url,
        "--transport",
        "streamable-http",
        "--header",
        `Authorization=Bearer \${${KEY_ENV_VAR}}`,
        "--no-probe",
      ];
  notes.push(`check it with: openclaw mcp doctor ${name} --probe`);

  return applyPlan(deps, {
    input,
    name,
    url,
    configPath,
    exists: json5HasServer(readText(configPath), name),
    force,
    dryRun: args.flags.has("dry-run"),
    block: openclawBlock(name, url),
    cli: { program: "openclaw", argv },
    envFile: { path: path.join(stateDir, ".env"), name: KEY_ENV_VAR },
    keyInKaguraJson: true,
    notes,
  });
}

const claude: Command = {
  summary: "Set up Kagura Memory integration for Claude Code.",
  description:
    '  Writes .kagura.json and a type "http" kagura-memory entry carrying the\n' +
    "  key. --scope project writes .mcp.json (0600, gitignored); --scope user\n" +
    "  runs `claude mcp add-json --scope user kagura-memory '<entry>'`, which\n" +
    "  takes the entry as an argument, so the key is in that process's\n" +
    "  argument list while it runs. A different user-scope entry is replaced\n" +
    "  (`claude mcp remove` runs first, and the old entry is put back if the\n" +
    "  add fails); an identical one is left as it is. ~/.claude.json is read,\n" +
    "  never written: an entry in a stronger scope (local > project > user)\n" +
    "  would hide the new one, so it stops the command. Local scope is the git\n" +
    "  repository's (a linked worktree's main working tree), and project scope\n" +
    "  the closest .mcp.json defining kagura-memory, here or in a parent\n" +
    "  directory, as Claude Code reads them. A re-run without --guardrails or\n" +
    "  --tool-profile drops an earlier value, and says so.\n\n" +
    GUARDRAILS_ADVICE,
  spec: { flags: [...COMMON_FLAGS, GUARDRAILS, SCOPE, TOOL_PROFILE] },
  run: (deps, args) => runClaude(deps as CliDeps, args),
};

const codex: Command = {
  summary: "Set up Kagura Memory integration for OpenAI Codex.",
  description:
    "  Runs `codex mcp add NAME --url URL --bearer-token-env-var KAGURA_API_KEY`,\n" +
    "  or prints the table for $CODEX_HOME/config.toml (default\n" +
    "  ~/.codex/config.toml) when codex is not on PATH. Codex reads the key\n" +
    "  from KAGURA_API_KEY in the shell that starts it; a key found there is\n" +
    "  not copied into .kagura.json, and a re-run reads it from there again.\n\n" +
    "  --guardrails, when neither it nor the URL sets one, defaults to off\n" +
    "  when the Kagura plugin's Codex hooks are on, and otherwise to the -c\n" +
    "  context when that is a UUID.\n\n" +
    GUARDRAILS_ADVICE,
  spec: { flags: [...COMMON_FLAGS, GUARDRAILS, TOOL_PROFILE, ...HARNESS_FLAGS] },
  run: (deps, args) => runCodex(deps as CliDeps, args),
};

const hermes: Command = {
  summary: "Set up Kagura Memory integration for Hermes Agent.",
  description:
    "  Writes the key to $HERMES_HOME/.env (default ~/.hermes/.env) as\n" +
    "  MCP_<NAME>_API_KEY (MCP_KAGURA_MEMORY_API_KEY by default), the name\n" +
    "  `hermes mcp add` derives from --name, and prints the config.yaml block\n" +
    "  that refers to it: the entry alone when config.yaml already has an\n" +
    "  mcp_servers key. `hermes mcp add` always prompts, so it is not run.\n" +
    "  Guardrails arrive through get_context_info at session start, so from\n" +
    "  the --guardrails flag or the URL, guardrails=off is refused and a\n" +
    "  context id is not written.",
  spec: { flags: [...COMMON_FLAGS, GUARDRAILS_NOT_WRITTEN, ...HARNESS_FLAGS] },
  run: (deps, args) => runHermes(deps as CliDeps, args),
};

const openclaw: Command = {
  summary: "Set up Kagura Memory integration for OpenClaw.",
  description:
    "  Writes the key to $OPENCLAW_STATE_DIR/.env (default ~/.openclaw/.env)\n" +
    "  as KAGURA_API_KEY and runs `openclaw mcp add ... --transport\n" +
    "  streamable-http --no-probe` (with --force, `openclaw mcp set`), or\n" +
    "  prints the block for $OPENCLAW_CONFIG_PATH (default openclaw.json in\n" +
    "  that directory) when openclaw is not on PATH. As on Hermes, from\n" +
    "  the --guardrails flag or the URL, guardrails=off is refused and a\n" +
    "  context id is not written.",
  spec: { flags: [...COMMON_FLAGS, GUARDRAILS_NOT_WRITTEN, ...HARNESS_FLAGS] },
  run: (deps, args) => runOpenclaw(deps as CliDeps, args),
};

export const SETUP_GROUP: CommandGroup = {
  summary: "Set up Kagura integrations for AI coding tools.",
  commands: { claude, codex, hermes, openclaw },
};
