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
  openclawBlock,
  openclawEntry,
  pluginServerUrl,
  queryParam,
  shellCommand,
  shellQuote,
  tomlHasServer,
  upsertEnvLine,
  withQueryParam,
  withoutQuery,
  withoutQueryParam,
  yamlHasServer,
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
// An empty value is unset, as Python's `or` treats it: `--tool-profile=`
// does nothing rather than damage, so it is not rejected.
const TOOL_PROFILE: FlagSpec = {
  name: "tool-profile",
  type: "value",
  metavar: "NAME",
  help: "Set the URL's profile parameter (e.g. core)",
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
  // success here and change nothing there.
  throw new CliUsageError(
    `Invalid value for '--guardrails': ${quote(raw)} is neither a context id (UUID) nor 'off'.`,
  );
}

/**
 * Validate `--name`.
 *
 * Codex accepts nothing else, and keeping to these characters lets the
 * name go bare into the printed TOML and YAML and into the variable
 * Hermes derives from it.
 */
function parseName(args: ParsedArgs): string {
  const name = args.values.name ?? SERVER_NAME;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new CliUsageError(
      `Invalid value for '--name': ${quote(name)} may contain only letters, digits, '-' and '_'.`,
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
  /** As given or configured; `.kagura.json` keeps it without its query. */
  baseUrl: string;
  contextId: string;
  /** `-c` was passed, rather than read from `.kagura.json`. */
  contextFlag: boolean;
  /** `--guardrails`, validated and normalised; undefined when absent. */
  guardrails: string | undefined;
  /**
   * The project's `.kagura.json`, read before anything is written or run,
   * so one this cannot parse stops the command with nothing changed.
   */
  kagura: Record<string, unknown>;
}

/** What every `setup` subcommand resolves before touching anything. */
function resolveInput(deps: CommandDeps, args: ParsedArgs, harness: Harness): SetupInput {
  rejectExtraArgs(args);
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
    throw new CliError(
      `the OAuth (--profile) setup writes ${OAUTH_TARGET[harness]} that launches the \`kagura-mcp\` stdio\n` +
        "  proxy, which ships with the Python package, not this one.\n" +
        `  Use \`pip install kagura-memory && kagura setup ${harness} --profile ` +
        `${profile}\`, or set up the static-token form here with --api-key.`,
    );
  }

  const guardrails = parseGuardrails(args.values.guardrails);
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
  const resolvedKey = apiKey ?? (typeof config.api_key === "string" ? config.api_key : "");
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
    throw new CliError(
      "no API key: pass --api-key, or set one in .kagura.json.\n" +
        "  For OAuth instead, run: kagura-memory auth login",
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
  // Without its query: the SDK finds its REST base by stripping a trailing
  // `/mcp`, which any query after it defeats, and a tool profile or
  // guardrails value belongs to the harness entry, not to this bin.
  kagura.mcp_url = withoutQuery(input.baseUrl);
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
): Promise<void> {
  const result = await deps.execFile(file, argv);
  if (result.code === 0) return;
  const detail = (result.stderr.trim() || result.stdout.trim()).split(apiKey).join("<redacted>");
  throw new CliError(`\`${display}\` failed (exit ${result.code})${detail ? `:\n  ${detail}` : ""}`);
}

// --- claude ---------------------------------------------------------------

type ClaudeScope = "local" | "project" | "user";

/** Claude Code resolves a server name strongest first. */
const CLAUDE_SCOPE_ORDER: readonly ClaudeScope[] = ["local", "project", "user"];
const CLAUDE_TARGET_SCOPES = ["project", "user"] as const;

function claudeEntry(url: string, apiKey: string): Record<string, unknown> {
  // `http`: Claude Code's transports are stdio, sse, http and ws. Earlier
  // releases wrote `url`, which is none of them.
  return { type: "http", url, headers: { Authorization: `Bearer ${apiKey}` } };
}

/**
 * The user-scope `claude mcp add-json` command, runnable, with the key as
 * `"$KAGURA_API_KEY"` spliced between two single-quoted halves — the one
 * POSIX spelling that expands the variable and nothing else.
 */
function claudeAddJsonDisplay(url: string): string {
  const marker = "@@KEY@@";
  const [before, after] = JSON.stringify(claudeEntry(url, marker)).split(marker) as [string, string];
  return (
    `claude mcp add-json ${SERVER_NAME} ${shellQuote(before)}"$${KEY_ENV_VAR}"${shellQuote(after)} ` +
    "--scope user"
  );
}

/**
 * The Claude Code scopes that already define `kagura-memory`.
 *
 * `~/.claude.json` (under `$CLAUDE_CONFIG_DIR` when that is set) holds
 * user scope (top-level `mcpServers`) and local scope
 * (`projects[<path>].mcpServers`) — and the rest of Claude Code's state,
 * so it is read here and never written.
 */
function claudeScopesDefining(projectDir: string): Set<ClaudeScope> {
  const found = new Set<ClaudeScope>();
  const defines = (servers: unknown): boolean =>
    typeof servers === "object" && servers !== null && Object.hasOwn(servers, SERVER_NAME);

  const stateDir = process.env.CLAUDE_CONFIG_DIR || os.homedir();
  const state = readJsonLenient(path.join(stateDir, ".claude.json"));
  if (state !== null) {
    if (defines(state.mcpServers)) found.add("user");
    const projects = state.projects as Record<string, { mcpServers?: unknown } | undefined> | undefined;
    // Tried with both separators: how the key is spelled on Windows is
    // Claude Code's business, not something to guess wrong about.
    for (const key of new Set([projectDir, projectDir.replace(/\\/g, "/")])) {
      if (defines(projects?.[key]?.mcpServers)) found.add("local");
    }
  }
  const mcp = readJsonLenient(path.join(projectDir, ".mcp.json"));
  if (mcp !== null && defines(mcp.mcpServers)) found.add("project");
  return found;
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
  const result = await deps.execFile(claude, ["plugin", "list", "--json"], { cwd: projectDir });
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
    if (typeof id === "string" && id.startsWith(`${SERVER_NAME}@`) && enabled === true) return id;
  }
  return null;
}

async function runClaude(deps: CliDeps, args: ParsedArgs): Promise<number> {
  const input = resolveInput(deps, args, "claude");
  const scope = parseChoice(SCOPE, args.values.scope ?? "project", CLAUDE_TARGET_SCOPES);

  let url = input.baseUrl;
  const toolProfile = args.values["tool-profile"];
  if (toolProfile) url = withQueryParam(url, "profile", toolProfile);
  if (input.guardrails !== undefined) url = withQueryParam(url, "guardrails", input.guardrails);

  const notes: string[] = [];
  const claude = deps.which("claude");

  const pluginId = await detectClaudePlugin(deps, claude, input.projectDir);
  if (pluginId !== null) {
    // Not set on the user's behalf: off also removes the get_context_info
    // block, and the plugin's hooks deliver guardrails only once the user
    // has configured them.
    if (queryParam(url, "guardrails")?.toLowerCase() !== "off") {
      notes.push(
        `the Kagura Memory plugin (${pluginId}) is enabled: once it is configured, re-run with ` +
          "--guardrails off so the server stops sending its own digest of the memories the " +
          "plugin's hooks deliver",
      );
    }
    notes.push(
      "plugin settings (/plugin → kagura-memory → Configure): " +
        `server_url = ${pluginServerUrl(url)}, ` +
        `context_id = ${input.contextId || "(none; pass -c)"}, ` +
        "api_key = your API key (not printed)",
    );
  }

  // A stronger scope silently shadows the entry written here, and the
  // command would report a success that never takes effect.
  const defined = claudeScopesDefining(input.projectDir);
  const rank = CLAUDE_SCOPE_ORDER.indexOf(scope);
  const stronger = CLAUDE_SCOPE_ORDER.slice(0, rank).filter((s) => defined.has(s));
  if (stronger.length > 0) {
    throw new CliError(
      `a ${stronger.join(" and ")}-scope '${SERVER_NAME}' entry takes precedence over ${scope} ` +
        "scope, so the entry written here would never be used.\n" +
        "  Remove it, then re-run:\n" +
        stronger.map((s) => `    claude mcp remove ${SERVER_NAME} -s ${s}`).join("\n"),
    );
  }
  for (const s of CLAUDE_SCOPE_ORDER.slice(rank + 1).filter((w) => defined.has(w))) {
    notes.push(
      `a ${s}-scope '${SERVER_NAME}' entry also exists; the ${scope}-scope entry written here ` +
        "takes precedence over it",
    );
  }

  const wrote: string[] = [];
  const secretFiles = [".kagura.json"];
  let appliedWith: string | null = null;

  if (scope === "user") {
    if (claude === null) {
      throw new CliError(
        `${notFound("claude")}, and this bin never edits ~/.claude.json itself.\n` +
          `  With ${KEY_ENV_VAR} exported, run:\n` +
          `    ${claudeAddJsonDisplay(url)}`,
      );
    }
    const replacing = defined.has("user");
    if (replacing) {
      // `add-json` refuses a name user scope already has. Removed first
      // rather than kept: as with the .mcp.json entry, a stale header from
      // a previous key would keep authenticating as the old identity.
      const argv = ["mcp", "remove", SERVER_NAME, "-s", "user"];
      await runHarnessCli(deps, claude, argv, shellCommand(["claude", ...argv]), input.apiKey);
      notes.push("replaced the existing user-scope entry");
    }
    const entry = JSON.stringify(claudeEntry(url, input.apiKey));
    try {
      await runHarnessCli(
        deps,
        claude,
        ["mcp", "add-json", SERVER_NAME, entry, "--scope", "user"],
        `claude mcp add-json ${SERVER_NAME} '<entry>' --scope user`,
        input.apiKey,
      );
    } catch (e) {
      // The old entry is already gone, and the failure alone would not
      // say so: the user would be left with neither, unaware.
      if (!replacing || !(e instanceof CliError)) throw e;
      throw new CliError(
        `${e.message}\n` +
          `  The previous user-scope '${SERVER_NAME}' entry was removed before this, so none is\n` +
          `  configured now. With ${KEY_ENV_VAR} exported, add the new one with:\n` +
          `    ${claudeAddJsonDisplay(url)}`,
      );
    }
    appliedWith = claudeAddJsonDisplay(url);
    wrote.push(writeKaguraJson(input));
  } else {
    // Read before anything is written, so an .mcp.json this cannot parse
    // stops the command with nothing changed.
    const mcpPath = path.join(input.projectDir, ".mcp.json");
    const mcp = readJsonSafe(mcpPath);
    wrote.push(writeKaguraJson(input));
    const servers = (mcp.mcpServers as Record<string, unknown> | undefined) ?? {};
    // The entry is replaced wholesale rather than merged: a stale header
    // from a previous key would keep authenticating as the old identity.
    servers[SERVER_NAME] = claudeEntry(url, input.apiKey);
    mcp.mcpServers = servers;
    writeJson(mcpPath, mcp);
    wrote.push(mcpPath);
    secretFiles.push(".mcp.json");
    notes.push(
      "Claude Code asks once to approve a project .mcp.json server; then check: " +
        `claude mcp get ${SERVER_NAME}`,
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
    printBlock(deps, `Add this to ${plan.configPath}:`, plan.block);
    notes.push(`${manual}; add the block printed on stderr to ${plan.configPath}`);
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
  const input = resolveInput(deps, args, "codex");
  const name = parseName(args);
  const notes: string[] = [];
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");

  let url = input.baseUrl;
  const toolProfile = args.values["tool-profile"];
  if (toolProfile) url = withQueryParam(url, "profile", toolProfile);

  // Codex hands the server's instructions to the model, so guardrails
  // take effect here. A value already in --mcp-url is kept as written.
  let guardrails = input.guardrails;
  if (guardrails === undefined && queryParam(url, "guardrails") === undefined) {
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
  if (guardrails !== undefined) url = withQueryParam(url, "guardrails", guardrails);

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
  const input = resolveInput(deps, args, "hermes");
  const name = parseName(args);
  const notes: string[] = [];
  const url = urlWithoutGuardrails(input, notes);

  const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  const configPath = path.join(hermesHome, "config.yaml");
  const envVar = hermesEnvVar(name);

  return applyPlan(deps, {
    input,
    name,
    url,
    configPath,
    exists: yamlHasServer(readText(configPath), name),
    force: args.flags.has("force"),
    dryRun: args.flags.has("dry-run"),
    block: hermesYamlBlock(name, url, envVar),
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
  const input = resolveInput(deps, args, "openclaw");
  const name = parseName(args);
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
    "  runs `claude mcp add-json kagura-memory '<entry>' --scope user`, which\n" +
    "  takes the entry as an argument, so the key is in that process's\n" +
    "  argument list while it runs. An existing user-scope entry is replaced:\n" +
    "  `claude mcp remove` runs first. ~/.claude.json is read to find an\n" +
    "  entry in a stronger scope, and never written.\n\n" +
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
    "  not copied into .kagura.json.\n\n" +
    "  --guardrails defaults to off when the Kagura plugin's Codex hooks are\n" +
    "  on, and otherwise to the -c context.\n\n" +
    GUARDRAILS_ADVICE,
  spec: { flags: [...COMMON_FLAGS, GUARDRAILS, TOOL_PROFILE, ...HARNESS_FLAGS] },
  run: (deps, args) => runCodex(deps as CliDeps, args),
};

const hermes: Command = {
  summary: "Set up Kagura Memory integration for Hermes Agent.",
  description:
    "  Writes the key to $HERMES_HOME/.env (default ~/.hermes/.env) as\n" +
    "  MCP_KAGURA_MEMORY_API_KEY and prints the config.yaml block that refers\n" +
    "  to it; `hermes mcp add` always prompts, so it is not run. Guardrails\n" +
    "  arrive through get_context_info at session start, so guardrails=off is\n" +
    "  refused and a context id is not written, from --guardrails or the URL.",
  spec: { flags: [...COMMON_FLAGS, GUARDRAILS_NOT_WRITTEN, ...HARNESS_FLAGS] },
  run: (deps, args) => runHermes(deps as CliDeps, args),
};

const openclaw: Command = {
  summary: "Set up Kagura Memory integration for OpenClaw.",
  description:
    "  Writes the key to ~/.openclaw/.env as KAGURA_API_KEY and runs\n" +
    "  `openclaw mcp add ... --transport streamable-http --no-probe` (with\n" +
    "  --force, `openclaw mcp set`), or prints the openclaw.json block when\n" +
    "  openclaw is not on PATH. As on Hermes, guardrails=off is refused and a\n" +
    "  context id is not written, from --guardrails or the URL.",
  spec: { flags: [...COMMON_FLAGS, GUARDRAILS_NOT_WRITTEN, ...HARNESS_FLAGS] },
  run: (deps, args) => runOpenclaw(deps as CliDeps, args),
};

export const SETUP_GROUP: CommandGroup = {
  summary: "Set up Kagura integrations for AI coding tools.",
  commands: { claude, codex, hermes, openclaw },
};
