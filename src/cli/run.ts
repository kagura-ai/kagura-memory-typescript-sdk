/**
 * `kagura-memory auth …` — the subcommands, with every side effect
 * injected so they can be exercised without a terminal or a network.
 *
 * Deliberately only `auth`. Memory operations stay library-only: the
 * credentials file is the artifact both SDKs share, so converging there is
 * the point, whereas duplicating the whole Python CLI surface would just
 * multiply the parity drift this repo has already spent several PRs
 * fixing.
 *
 * Flag names match `kagura auth …` exactly so documentation and muscle
 * memory transfer.
 */

import {
  DEFAULT_SCOPE,
  READ_ONLY_SCOPE,
  login,
  type LoginOptions,
} from "../auth/login.js";
import { refresh, type RefreshOptions } from "../auth/refresh.js";
import {
  deleteCredentialsFile,
  deleteProfile,
  isExpired,
  loadCredentialsFile,
  setDefaultProfile,
  type OAuthCredentials,
} from "../auth/credentials.js";
import type { DeviceAuthorizationResponse } from "../auth/deviceFlow.js";
import { excMessage } from "../errors.js";
import { SDK_VERSION } from "../version.js";
import {
  isGroup,
  renderGroupHelp,
  renderHelp,
  type Command,
  type CommandDeps,
  type CommandGroup,
} from "./command.js";
import {
  CONFIG_GROUP,
  CONTEXTS_ALIAS,
  CONTEXT_GROUP,
} from "./commands/context.js";
import { EDGE_GROUP, SLEEP_GROUP } from "./commands/graph.js";
import { MEMORY_COMMANDS } from "./commands/memory.js";
import { CliUsageError } from "./parse.js";
import { parseArgs, type ParseSpec, type ParsedArgs } from "./parseArgs.js";

/**
 * Every option the `auth` subcommands accept, pooled.
 *
 * Pooled rather than per-subcommand because the pool is small and entirely
 * unambiguous — no two `auth` subcommands give the same flag different
 * meanings — and because `cmdLogin`/`cmdLogout` already reject the
 * combinations that are individually valid but mutually exclusive.
 */
const AUTH_SPEC: ParseSpec = {
  flags: [
    { name: "profile", type: "value", help: "Profile to act on (default: the file's default)" },
    { name: "server", type: "value", metavar: "URL", help: "MCP server URL to authenticate against" },
    { name: "scope", type: "value", help: 'Space-separated scopes, e.g. "memory:read memory:write"' },
    { name: "read-only", type: "switch", help: "Request memory:read only" },
    { name: "no-browser", type: "switch", help: "Print the code and URL without opening a browser" },
    { name: "all", type: "switch", help: "logout: remove every stored profile" },
    { name: "yes", type: "switch", help: "logout: skip the confirmation prompt" },
  ],
};

export interface CliDeps extends CommandDeps {
  /** Best-effort browser launch; returns false when it could not open. */
  openBrowser: (url: string) => Promise<boolean>;
  login: typeof login;
  refresh: typeof refresh;
  /** Overrides for tests; production passes nothing. */
  credentialsPath?: string;
}

const ROOT_SUMMARY = "Kagura Memory Cloud CLI - AI-driven memory management.";

const ROOT_EPILOG = `
Credentials live in ~/.kagura/credentials.json and are shared with the
Python CLI, so either tool can create or use a profile. The context id
comes from --context-id, or from "context_id" in .kagura.json.

Scopes:
  memory:read   read memories, contexts, files
  memory:write  create/update/delete memories, contexts, files

Default scope is "${DEFAULT_SCOPE}"; --read-only requests "${READ_ONLY_SCOPE}".
Narrowing a scope on refresh is silent; widening needs consent, so it
re-runs the device flow.`;

/** Print the code and URL, then optionally try to open a browser. */
function devicePrompt(deps: CliDeps, openBrowserFlag: boolean) {
  return async (auth: DeviceAuthorizationResponse): Promise<void> => {
    const url = auth.verificationUriComplete || auth.verificationUri;
    // Unconditionally, and before any launch attempt: if the browser opens
    // silently or fails, the operator can still copy the code by eye.
    deps.write("");
    deps.write(`  First copy your one-time code: ${auth.userCode}`);
    deps.write("  Then approve at:");
    deps.write(`    ${url}`);
    deps.write("");

    if (!openBrowserFlag) {
      deps.write("  (--no-browser: not opening a browser; still polling here.)");
      return;
    }
    if (!(await deps.openBrowser(url))) {
      deps.write("  (Could not open a browser — use the URL above.)");
    }
  };
}

/**
 * A human label for the workspace.
 *
 * `workspace_name` is optional in the token response and parses to `""`
 * when absent, so printing it bare yields "workspace ." — fall back to the
 * id, which the response does carry.
 */
function workspaceLabel(creds: OAuthCredentials): string {
  return creds.workspaceName || creds.workspaceId || "(unknown)";
}

function describeProfile(name: string, creds: OAuthCredentials, isDefault: boolean): string[] {
  const expired = isExpired(creds);
  const refreshable = Boolean(creds.refreshToken);
  // A profile whose access token has expired is still usable when it can
  // refresh; only one that cannot is genuinely dead.
  const state = !expired ? "active" : refreshable ? "expired (refreshable)" : "expired";
  return [
    `${isDefault ? "*" : " "} ${name}`,
    `    account:    ${creds.userEmail || "(unknown)"}`,
    `    workspace:  ${workspaceLabel(creds)}`,
    `    server:     ${creds.server}`,
    `    scope:      ${creds.scope || "(unknown)"}`,
    `    expires:    ${creds.expiresAt.toISOString()}`,
    `    state:      ${state}`,
    `    refreshable: ${refreshable}`,
  ];
}

async function cmdLogin(deps: CliDeps, args: ReturnType<typeof parseArgs>): Promise<number> {
  const readOnly = args.flags.has("read-only");
  const scope = args.values.scope;
  if (readOnly && scope !== undefined) {
    deps.writeError("--read-only and --scope are mutually exclusive; pick one.");
    return 2;
  }

  const options: LoginOptions = {
    onUserCode: devicePrompt(deps, !args.flags.has("no-browser")),
  };
  if (args.values.profile !== undefined) options.profile = args.values.profile;
  if (args.values.server !== undefined) options.mcpUrl = args.values.server;
  if (readOnly) options.scope = READ_ONLY_SCOPE;
  else if (scope !== undefined) options.scope = scope;
  if (deps.credentialsPath !== undefined) options.credentialsPath = deps.credentialsPath;

  const creds = await deps.login(options);
  deps.write(
    `Logged in as ${creds.userEmail || "(unknown)"} — workspace ${workspaceLabel(creds)}.`,
  );
  deps.write(`Profile '${args.values.profile ?? "default"}' saved. Scope: ${creds.scope}`);
  return 0;
}

async function cmdRefresh(deps: CliDeps, args: ReturnType<typeof parseArgs>): Promise<number> {
  const options: RefreshOptions = {
    onUserCode: devicePrompt(deps, !args.flags.has("no-browser")),
  };
  if (args.values.profile !== undefined) options.profile = args.values.profile;
  if (args.values.scope !== undefined) options.scope = args.values.scope;
  if (deps.credentialsPath !== undefined) options.credentialsPath = deps.credentialsPath;

  const creds = await deps.refresh(options);
  deps.write(`Refreshed. Expires ${creds.expiresAt.toISOString()}. Scope: ${creds.scope}`);
  return 0;
}

function cmdStatus(deps: CliDeps, args: ReturnType<typeof parseArgs>): number {
  const cf = loadCredentialsFile(deps.credentialsPath);
  const names = Object.keys(cf.profiles);
  if (names.length === 0) {
    deps.write("No profiles. Run: kagura-memory auth login");
    return 0;
  }

  const only = args.values.profile;
  if (only !== undefined) {
    const creds = cf.profiles[only];
    if (creds === undefined) {
      deps.writeError(`No profile named '${only}'.`);
      return 1;
    }
    for (const line of describeProfile(only, creds, cf.defaultProfile === only)) {
      deps.write(line);
    }
    return 0;
  }

  for (const name of names) {
    for (const line of describeProfile(name, cf.profiles[name]!, cf.defaultProfile === name)) {
      deps.write(line);
    }
  }
  return 0;
}

async function cmdUse(deps: CliDeps, args: ReturnType<typeof parseArgs>): Promise<number> {
  const name = args.positionals[0];
  if (name === undefined) {
    deps.writeError("Usage: kagura-memory auth use <profile>");
    return 2;
  }
  // setDefaultProfile rejects an unknown name under the lock, so a typo
  // cannot leave the file pointing at a profile that does not exist.
  await setDefaultProfile(name, deps.credentialsPath);
  deps.write(`Default profile is now '${name}'.`);
  return 0;
}

async function cmdLogout(deps: CliDeps, args: ReturnType<typeof parseArgs>): Promise<number> {
  const all = args.flags.has("all");
  const target = args.values.profile;
  if (all && target !== undefined) {
    deps.writeError("--all and --profile are mutually exclusive; pick one.");
    return 2;
  }

  const cf = loadCredentialsFile(deps.credentialsPath);

  // emptyCredentialsFile() names a default profile even when none are
  // stored, so an untargeted logout would otherwise report "No profile
  // named 'default'" and exit 1 on a fresh machine — breaking
  // `logout --yes` in idempotent setup scripts. Nothing to remove is the
  // desired end state, not a failure. An explicitly named profile is
  // still a real mismatch and reported below.
  if (!all && target === undefined && Object.keys(cf.profiles).length === 0) {
    deps.write("No profiles stored; nothing to do.");
    return 0;
  }

  const name = target ?? cf.defaultProfile;
  const question = all
    ? "Remove ALL stored profiles?"
    : `Remove profile '${name}'?`;
  if (!args.flags.has("yes") && !(await deps.confirm(question))) {
    deps.write("Cancelled.");
    return 1;
  }

  if (all) {
    deleteCredentialsFile(deps.credentialsPath);
    deps.write("All profiles removed.");
    return 0;
  }
  // deleteProfile is a no-op on an absent profile; say so rather than
  // reporting a removal that did not happen.
  const existed = cf.profiles[name] !== undefined;
  await deleteProfile(name, deps.credentialsPath);
  deps.write(existed ? `Profile '${name}' removed.` : `No profile named '${name}'.`);
  return existed ? 0 : 1;
}

/** The `auth` subcommands, as registry entries. */
const AUTH_GROUP: CommandGroup = {
  summary: "OAuth2 device-flow authentication for Kagura Memory.",
  commands: {
    login: {
      summary: "Authenticate via OAuth2 device flow.",
      spec: AUTH_SPEC,
      run: (deps, args) => cmdLogin(deps as CliDeps, args),
    },
    refresh: {
      summary: "Rotate access_token (optionally requesting a new scope).",
      spec: AUTH_SPEC,
      run: (deps, args) => cmdRefresh(deps as CliDeps, args),
    },
    status: {
      summary: "Show the current profile, server, scope, expiry, and workspace.",
      spec: AUTH_SPEC,
      run: async (deps, args) => cmdStatus(deps as CliDeps, args),
    },
    use: {
      summary: "Set the default profile used when none is selected.",
      args: "PROFILE",
      spec: AUTH_SPEC,
      run: (deps, args) => cmdUse(deps as CliDeps, args),
    },
    logout: {
      summary: "Delete a stored profile (or all of them).",
      spec: AUTH_SPEC,
      run: (deps, args) => cmdLogout(deps as CliDeps, args),
    },
  },
};

/** Everything reachable as `kagura-memory <name> …`. */
export const ROOT_COMMANDS: Record<string, Command | CommandGroup> = {
  auth: AUTH_GROUP,
  config: CONFIG_GROUP,
  context: CONTEXT_GROUP,
  contexts: CONTEXTS_ALIAS,
  edge: EDGE_GROUP,
  sleep: SLEEP_GROUP,
  ...MEMORY_COMMANDS,
};

/**
 * `kagura-memory login` — accepted because v0.7.0 shipped the bin with
 * only `auth`, and both spellings worked. Not listed in the root help;
 * `auth login` is canonical and matches the Python CLI.
 */
const BARE_AUTH_ALIASES = new Set(Object.keys(AUTH_GROUP.commands));

interface Resolved {
  command: Command;
  /** Display path for help and errors, e.g. `kagura-memory auth login`. */
  path: string;
  /** argv with the command tokens removed. */
  rest: string[];
}

/**
 * Find the command argv names, without a spec.
 *
 * Resolution has to happen before parsing — the parser needs the command's
 * own flag spec to know which tokens are values — so it reads only leading
 * non-flag tokens and walks the registry with them.
 */
function resolve(argv: string[], deps: CliDeps): Resolved | { help: string; code: number } {
  const head = argv[0];
  if (head === undefined || head.startsWith("-")) {
    // No command: `--help` is a request, a bare invocation is a mistake.
    const wantsHelp = head === "--help" || head === "-h";
    return { help: renderRootHelp(), code: wantsHelp ? 0 : 2 };
  }
  if (head === "help") {
    return { help: renderRootHelp(), code: 0 };
  }

  const entry = BARE_AUTH_ALIASES.has(head) ? AUTH_GROUP.commands[head] : ROOT_COMMANDS[head];
  if (entry === undefined) {
    deps.writeError(`Error: No such command '${head}'.`);
    return { help: renderRootHelp(), code: 2 };
  }

  if (!isGroup(entry)) {
    const path = BARE_AUTH_ALIASES.has(head) ? `kagura-memory auth ${head}` : `kagura-memory ${head}`;
    return { command: entry, path, rest: argv.slice(1) };
  }

  const sub = argv[1];
  if (sub === undefined || sub.startsWith("-")) {
    const wantsHelp = sub === "--help" || sub === "-h";
    return {
      help: renderGroupHelp(`kagura-memory ${head}`, entry.summary, entry.commands),
      code: wantsHelp ? 0 : 2,
    };
  }
  const command = entry.commands[sub];
  if (command === undefined) {
    deps.writeError(`Error: No such command '${sub}'.`);
    return {
      help: renderGroupHelp(`kagura-memory ${head}`, entry.summary, entry.commands),
      code: 2,
    };
  }
  return { command, path: `kagura-memory ${head} ${sub}`, rest: argv.slice(2) };
}

function renderRootHelp(): string {
  return `${renderGroupHelp("kagura-memory", ROOT_SUMMARY, ROOT_COMMANDS)}\n${ROOT_EPILOG}`;
}

/**
 * Run one CLI invocation.
 *
 * @returns the process exit code. Never throws for expected failures —
 *   Kagura errors carry their own next-step guidance and are reported with
 *   it intact rather than as a stack trace.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  if (argv[0] === "--version") {
    deps.write(`kagura-memory, version ${SDK_VERSION}`);
    return 0;
  }

  const resolved = resolve(argv, deps);
  if ("help" in resolved) {
    if (resolved.code === 0) deps.write(resolved.help);
    else deps.writeError(resolved.help);
    return resolved.code;
  }

  const { command, path, rest } = resolved;
  const parsed = parseArgs(rest, command.spec);

  if (parsed.flags.has("help")) {
    deps.write(renderHelp(path, command));
    return 0;
  }

  // An empty value is almost always a typo (`--profile=`), and it is not
  // harmless: "" is a usable profile name, so it would create a nameless
  // profile, and an empty scope would be sent to the server verbatim.
  const empty = Object.entries(parsed.values)
    .filter(([, value]) => value !== undefined && value.trim() === "")
    .map(([name]) => `--${name}`);

  if (parsed.unknown.length > 0 || parsed.missingValue.length > 0 || empty.length > 0) {
    for (const flag of parsed.unknown) {
      deps.writeError(`Unknown option: ${flag}`);
    }
    for (const flag of parsed.missingValue) {
      deps.writeError(`Option ${flag} needs a value.`);
    }
    for (const flag of empty) {
      deps.writeError(`Option ${flag} needs a non-empty value.`);
    }
    deps.writeError(renderHelp(path, command));
    return 2;
  }

  // The parser lifts the first positional into `command`; commands read
  // their arguments positionally, so put it back.
  const args: ParsedArgs = {
    ...parsed,
    positionals: parsed.command === "" ? parsed.positionals : [parsed.command, ...parsed.positionals],
  };

  try {
    return await command.run(deps, args);
  } catch (e) {
    // Click prefixes both UsageError (exit 2) and ClickException (exit 1)
    // with "Error: "; the exit code is what tells a script which it was.
    deps.writeError(`Error: ${excMessage(e)}`);
    return e instanceof CliUsageError ? 2 : 1;
  }
}
