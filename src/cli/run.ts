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
import { parseArgs } from "./parseArgs.js";

export interface CliDeps {
  write: (line: string) => void;
  writeError: (line: string) => void;
  /** Ask a yes/no question; resolves true to proceed. */
  confirm: (question: string) => Promise<boolean>;
  /** Best-effort browser launch; returns false when it could not open. */
  openBrowser: (url: string) => Promise<boolean>;
  login: typeof login;
  refresh: typeof refresh;
  /** Overrides for tests; production passes nothing. */
  credentialsPath?: string;
}

const USAGE = `kagura-memory auth — manage Kagura Memory credentials

Usage:
  kagura-memory auth login   [--profile <name>] [--server <url>]
                             [--scope "<scopes>" | --read-only] [--no-browser]
  kagura-memory auth refresh [--profile <name>] [--scope "<scopes>"] [--no-browser]
  kagura-memory auth status  [--profile <name>]
  kagura-memory auth use     <profile>
  kagura-memory auth logout  [--profile <name>] [--all] [--yes]

Credentials live in ~/.kagura/credentials.json and are shared with the
Python CLI, so either tool can create or use a profile.

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

function describeProfile(name: string, creds: OAuthCredentials, isDefault: boolean): string[] {
  const expired = isExpired(creds);
  const refreshable = Boolean(creds.refreshToken);
  // A profile whose access token has expired is still usable when it can
  // refresh; only one that cannot is genuinely dead.
  const state = !expired ? "active" : refreshable ? "expired (refreshable)" : "expired";
  return [
    `${isDefault ? "*" : " "} ${name}`,
    `    account:    ${creds.userEmail || "(unknown)"}`,
    `    workspace:  ${creds.workspaceName || creds.workspaceId || "(unknown)"}`,
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
  deps.write(`Logged in as ${creds.userEmail || "(unknown)"} — workspace ${creds.workspaceName}.`);
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

/**
 * Run one CLI invocation.
 *
 * @returns the process exit code. Never throws for expected failures —
 *   auth errors are reported on stderr with their guidance intact.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv);

  // An empty value is almost always a typo (`--profile=`), and it is not
  // harmless: "" is a usable profile name, so it would create a nameless
  // profile, and an empty scope would be sent to the server verbatim.
  const empty = Object.entries(args.values)
    .filter(([, value]) => value !== undefined && value.trim() === "")
    .map(([name]) => `--${name}`);

  if (args.unknown.length > 0 || args.missingValue.length > 0 || empty.length > 0) {
    for (const flag of args.unknown) {
      deps.writeError(`Unknown option: ${flag}`);
    }
    for (const flag of args.missingValue) {
      deps.writeError(`Option ${flag} needs a value.`);
    }
    for (const flag of empty) {
      deps.writeError(`Option ${flag} needs a non-empty value.`);
    }
    deps.writeError(USAGE);
    return 2;
  }

  if (args.flags.has("help") || args.command === "" || args.command === "help") {
    deps.write(USAGE);
    return args.command === "" && !args.flags.has("help") ? 2 : 0;
  }

  // The bin exists only for auth, but accept the `auth` prefix so the
  // command reads the same as its Python counterpart.
  let args2 = args;
  if (args.command === "auth") {
    const next = args.positionals[0];
    args2 = { ...args, command: next ?? "", positionals: args.positionals.slice(1) };
    if (args2.command === "") {
      deps.write(USAGE);
      return 2;
    }
  }

  try {
    switch (args2.command) {
      case "login":
        return await cmdLogin(deps, args2);
      case "refresh":
        return await cmdRefresh(deps, args2);
      case "status":
        return cmdStatus(deps, args2);
      case "use":
        return await cmdUse(deps, args2);
      case "logout":
        return await cmdLogout(deps, args2);
      default:
        deps.writeError(`Unknown command: ${args2.command}`);
        deps.writeError(USAGE);
        return 2;
    }
  } catch (e) {
    // Kagura auth errors carry their own next-step guidance ("Run: kagura
    // auth login", …); surface the message rather than a stack trace.
    deps.writeError(excMessage(e));
    return 1;
  }
}
