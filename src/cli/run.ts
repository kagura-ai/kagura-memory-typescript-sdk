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
  resolveLoginMcpUrl,
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
import {
  buildInviteLink,
  checkInviteOrigin,
  inviteBaseUrl,
  parseInvite,
  revokeToken,
  type DeviceAuthorizationResponse,
  type ParsedInvite,
} from "../auth/deviceFlow.js";
import { KaguraAuthError, excMessage } from "../errors.js";
import { baseUrlFromMcp } from "../http.js";
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
import { DOCTOR } from "./commands/doctor.js";
import { FILES_GROUP } from "./commands/files.js";
import { EDGE_GROUP, SLEEP_GROUP } from "./commands/graph.js";
import { MEMORY_COMMANDS } from "./commands/memory.js";
import { RESOURCE_GROUP } from "./commands/resource.js";
import { SECRET_GROUP } from "./commands/secret.js";
import { SETUP_GROUP, classifyMcpEntry, findClaudeEntries } from "./commands/setup.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import { checkInviteSupport, type InviteSupport } from "./invite.js";
import { formatJsonAscii } from "./output.js";
import { CliError, CliUsageError } from "./parse.js";
import { parseArgs, type FlagSpec, type ParseSpec, type ParsedArgs } from "./parseArgs.js";

/**
 * The `auth` options, one spec per subcommand, holding only the flags it
 * reads — as Python declares them per command, so click refuses the rest.
 * A flag another subcommand takes is an unknown option here (exit 2),
 * rather than one that parses and then does nothing. Help texts are
 * Python's, where the behaviour is the same.
 */
function profileFlag(help: string): FlagSpec {
  return { name: "profile", type: "value", rejectEmpty: true, help };
}

const NO_BROWSER: FlagSpec = {
  name: "no-browser",
  type: "switch",
  help: "Don't try to open a browser — just print the URL and code.",
};

const INVITE: FlagSpec = {
  name: "invite",
  type: "value",
  metavar: "LINK_OR_TOKEN",
  // A token may begin with "-"; see FlagSpec.dashValue.
  dashValue: true,
  help:
    "Sign up with an invite: the https://<host>/join/<token> link you were sent, or its bare " +
    "token. Checked locally; never stored.",
};

/**
 * `--invite` where it is not read: declared, so its value — a sign-up
 * credential — is consumed rather than read as options when it begins
 * with `-`, and hidden from `--help`; {@link refuseInvite} then refuses it.
 */
const INVITE_REFUSED: FlagSpec = { ...INVITE, hidden: true };

const LOGIN_SPEC: ParseSpec = {
  flags: [
    profileFlag("Profile name to store credentials under (default: 'default')."),
    // The MCP URL, not Python's API URL: this bin derives the API from it.
    { name: "server", type: "value", rejectEmpty: true, metavar: "URL", help: "MCP server URL to authenticate against" },
    {
      name: "scope",
      type: "value",
      rejectEmpty: true,
      help: `OAuth scope (default: '${DEFAULT_SCOPE}'). Override only if you need a custom scope set.`,
    },
    {
      name: "read-only",
      type: "switch",
      help: `Request read-only scope ('${READ_ONLY_SCOPE}') instead of the default read+write.`,
    },
    NO_BROWSER,
    INVITE,
  ],
};

const REFRESH_SPEC: ParseSpec = {
  flags: [
    profileFlag("Profile to refresh (default: default profile)."),
    {
      name: "scope",
      type: "value",
      rejectEmpty: true,
      help:
        "Request this scope (default: keep the current grant unchanged). Pass space-separated " +
        "values to ask for multiple (e.g. 'memory:read memory:write'). If wider than the current " +
        "grant, re-runs the device flow.",
    },
    // Not in Python: a widening refresh re-runs the device flow here too,
    // and this is how that run's prompt is told not to open a browser.
    NO_BROWSER,
    INVITE_REFUSED,
  ],
};

const STATUS_SPEC: ParseSpec = {
  flags: [profileFlag("Profile to inspect (default: default profile)."), INVITE_REFUSED],
};

const USE_SPEC: ParseSpec = { flags: [INVITE_REFUSED] };

const LOGOUT_SPEC: ParseSpec = {
  flags: [
    profileFlag("Profile to log out (default: default profile)."),
    { name: "all", type: "switch", help: "Delete every profile and remove the credentials file." },
    { name: "yes", short: "y", type: "switch", help: "Skip the confirmation prompt." },
    INVITE_REFUSED,
  ],
};

const LIST_SPEC: ParseSpec = {
  flags: [
    {
      name: "json",
      type: "switch",
      help: "Emit machine-readable JSON (for scripting / CI) instead of one line per profile.",
    },
    INVITE_REFUSED,
  ],
};

const TOKEN_SPEC: ParseSpec = {
  flags: [profileFlag("Profile to use (default: default profile)."), INVITE_REFUSED],
};

export interface CliDeps extends CommandDeps {
  /** Best-effort browser launch; returns false when it could not open. */
  openBrowser: (url: string) => Promise<boolean>;
  /**
   * Find a program on PATH; null when it is not there.
   *
   * `setup` uses this and {@link CliDeps.execFile} to apply an entry with
   * the harness's own CLI. Both are injected so its tests never read the
   * real PATH or start a process.
   */
  which: (name: string) => string | null;
  /** Run a program with no shell and no stdin; never rejects. */
  execFile: (file: string, argv: readonly string[], options?: ExecOptions) => Promise<ExecResult>;
  login: typeof login;
  refresh: typeof refresh;
  /** Overrides for tests; production passes nothing. */
  credentialsPath?: string;
  /** Overrides for tests; production passes nothing (global fetch). */
  fetch?: typeof globalThis.fetch;
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

/** `--invite`, parsed; how the server takes it is asked once the code is issued. */
interface InviteHandoff {
  /** The token appears only inside a printed `/join` link, never bare. */
  invite: ParsedInvite;
  /** The API base the device flow runs against, where `/system/info` is asked. */
  server: string;
}

/**
 * The approval URL with the code in it, for the one link's `return_to`.
 *
 * RFC 8628 makes `verification_uri_complete` optional, and
 * `authorizeDevice` fills a missing one with the bare `verificationUri`.
 * Built on that, the link would land on an empty code form, so the code is
 * put back: `verificationUri`'s path plus `?user_code=`, the shape
 * memory-cloud itself builds. The Python CLI passes the bare URI on; this
 * is deliberately one step better.
 */
function approvalWithCode(auth: DeviceAuthorizationResponse): string {
  if (auth.verificationUriComplete && auth.verificationUriComplete !== auth.verificationUri) {
    return auth.verificationUriComplete;
  }
  try {
    const url = new URL(auth.verificationUri);
    url.search = new URLSearchParams({ user_code: auth.userCode }).toString();
    url.hash = "";
    return url.toString();
  } catch {
    // Not a URL: buildInviteLink returns null for it, and the prompt
    // falls back to two steps.
    return auth.verificationUri;
  }
}

/**
 * Open `url` unless `--no-browser`; say so when that, or the opener, fails.
 * `what` names the link above to open by hand. The Python CLI's lines.
 */
async function openBrowserOrExplain(
  deps: CliDeps,
  url: string,
  openBrowserFlag: boolean,
  what = "the URL",
): Promise<void> {
  if (!openBrowserFlag) {
    deps.write("  (--no-browser: not opening a browser; polling will continue here.)");
    return;
  }
  if (!(await deps.openBrowser(url))) {
    deps.write(
      `  Could not auto-open the browser. Open ${what} above manually. ` +
        "Polling will continue here.",
    );
  }
}

/**
 * Print the code and URL first, then optionally try to open a browser.
 *
 * Unconditionally, and before any launch attempt: if the browser opens
 * silently or fails, the operator can still copy the code by eye.
 */
async function printDevicePrompt(
  deps: CliDeps,
  auth: DeviceAuthorizationResponse,
  openBrowserFlag: boolean,
): Promise<void> {
  const approveUrl = auth.verificationUriComplete || auth.verificationUri;
  deps.write("");
  deps.write(`! First copy your one-time code: ${auth.userCode}`);
  deps.write("  Open this URL in your browser to approve:");
  deps.write(`    ${approveUrl}`);
  deps.write("");
  await openBrowserOrExplain(deps, approveUrl, openBrowserFlag);
}

/**
 * The `--invite` prompt: the code first, then the link or links in order.
 *
 * The Python CLI's (kagura-memory-python-sdk#259). `hand_off` prints the
 * one link when `/join` can be placed beside `/device` and would keep
 * `return_to`, then the approval URL for a user already signed in;
 * otherwise two steps, the `/join` link and then the approval URL.
 * `disabled` prints a note and the ordinary prompt. The browser opens the
 * invite link, never the approval URL ahead of it.
 */
async function printInvitePrompt(
  deps: CliDeps,
  auth: DeviceAuthorizationResponse,
  invite: ParsedInvite,
  support: InviteSupport,
  openBrowserFlag: boolean,
): Promise<void> {
  if (support === "disabled") {
    deps.write("");
    deps.write("  Note: this server does not accept invites, so --invite has no effect.");
    await printDevicePrompt(deps, auth, openBrowserFlag);
    return;
  }

  const approveUrl = auth.verificationUriComplete || auth.verificationUri;
  const link =
    support === "hand_off"
      ? buildInviteLink(auth.verificationUri, approvalWithCode(auth), invite.token)
      : null;

  deps.write("");
  deps.write(`! First copy your one-time code: ${auth.userCode}`);
  if (link !== null) {
    deps.write("  Open this link to accept your invite and sign in:");
    deps.write(`    ${link}`);
    deps.write("  After sign-up you land on the approval page with the code filled in.");
    // An already-signed-in user, or a /join that still ends on the
    // dashboard, leaves the code pending; this approves it directly.
    deps.write("  If you land on the dashboard instead, approve here:");
    deps.write(`    ${approveUrl}`);
    deps.write("");
    await openBrowserOrExplain(deps, link, openBrowserFlag, "the invite link");
    return;
  }

  // return_to would be ignored or dropped, so step 1 is /join alone,
  // placed beside /device. Where it cannot be, step 1 is the link the user
  // gave (never a guessed host), and for a bare token no link at all.
  const base = inviteBaseUrl(auth.verificationUri);
  const joinLink = base !== null ? `${base}/join/${invite.token}` : invite.link;
  const minutes = Math.max(1, Math.round(auth.expiresIn / 60));
  // Worded to hold on every server, including one with the hand-off whose
  // /join could not be placed, or whose /system/info could not be read.
  deps.write("  Accept your invite before you approve the code, in this order:");
  deps.write(
    joinLink !== null
      ? `    1. Open your invite link and sign up:   ${joinLink}`
      : "    1. Open the invite link you were sent and sign up.",
  );
  deps.write(`    2. Then open this URL and approve:       ${approveUrl}`);
  deps.write(`  Polling continues here until the code expires (in ${minutes} min).`);
  deps.write("");
  // Nothing to open for a bare token: approval first would send a
  // signed-out user to a login that drops the invite.
  if (joinLink !== null) {
    await openBrowserOrExplain(deps, joinLink, openBrowserFlag, "step 1");
  }
}

/**
 * `onUserCode` for the device flow: the prompt, and with `--invite`, the
 * checks that choose it.
 *
 * login() awaits this callback, so a throw here stops it before it polls
 * or writes a profile. The Python CLI's order: the invite's origin against
 * the device response first, so a link for another server aborts without
 * asking that server anything more; then `/system/info`.
 */
function devicePrompt(deps: CliDeps, openBrowserFlag: boolean, handoff?: InviteHandoff) {
  return async (auth: DeviceAuthorizationResponse): Promise<void> => {
    if (handoff === undefined) {
      await printDevicePrompt(deps, auth, openBrowserFlag);
      return;
    }
    try {
      checkInviteOrigin(handoff.invite, auth.verificationUri);
    } catch (e) {
      // "<its MCP URL>" where Python says "<its API URL>": this CLI's
      // --server takes the MCP URL and derives the API from it.
      throw new KaguraAuthError(
        `${excMessage(e)}\n  Log in to the invite's server instead: ` +
          "kagura-memory auth login --server <its MCP URL> --invite <link>",
        { cause: e },
      );
    }
    const support = await checkInviteSupport(handoff.server, deps.fetch);
    await printInvitePrompt(deps, auth, handoff.invite, support, openBrowserFlag);
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
  // First, and before any request, as click validates an option while it
  // parses. The reason never quotes the value: an invite is a sign-up
  // credential, and stderr ends up in CI logs.
  let invite: ParsedInvite | undefined;
  if (args.values.invite !== undefined) {
    try {
      invite = parseInvite(args.values.invite);
    } catch (e) {
      throw new CliUsageError(`Invalid value for '--invite': ${excMessage(e)}`);
    }
  }

  const readOnly = args.flags.has("read-only");
  const scope = args.values.scope;
  if (readOnly && scope !== undefined) {
    // Exit 1: Python raises a ClickException here, not a UsageError.
    throw new CliError("--read-only and --scope are mutually exclusive; pick one.");
  }

  // The server is asked how it takes the invite only once the device code
  // is issued (devicePrompt), as in the Python CLI.
  const handoff: InviteHandoff | undefined =
    invite === undefined
      ? undefined
      : { invite, server: baseUrlFromMcp(resolveLoginMcpUrl(args.values.server)) };

  const options: LoginOptions = {
    onUserCode: devicePrompt(deps, !args.flags.has("no-browser"), handoff),
  };
  if (args.values.profile !== undefined) options.profile = args.values.profile;
  if (args.values.server !== undefined) options.mcpUrl = args.values.server;
  if (readOnly) options.scope = READ_ONLY_SCOPE;
  else if (scope !== undefined) options.scope = scope;
  if (deps.credentialsPath !== undefined) options.credentialsPath = deps.credentialsPath;
  if (deps.fetch !== undefined) options.fetch = deps.fetch;

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

/**
 * The Claude Code entry in use in the current directory, and each one it
 * hides — Python's `_print_mcp_json_mode`, its lines.
 *
 * Nothing when no scope defines one, or when the one in use is no form
 * this recognises (its hidden ones then go unlisted too), so `auth status`
 * stays quiet outside a project set up for Claude Code.
 */
function claudeCodeLines(): string[] {
  const entries = findClaudeEntries(process.cwd());
  const used = entries[0];
  if (used === undefined) return [];
  const label = `Claude Code (${used.source}, ${used.scope} scope)`;
  const lines: string[] = [];
  switch (classifyMcpEntry(used.config)) {
    case "stdio":
      lines.push(`${label}: refresh-aware (kagura-mcp stdio proxy)`);
      break;
    case "static-token":
      lines.push(
        `${label}: legacy static API-key token (no auto-refresh)`,
        // Python points at its own `setup claude --profile`; this bin has
        // no such setup, since the kagura-mcp proxy ships with Python.
        "  Migrate to refresh-aware with the Python CLI: kagura setup claude --profile <name>",
      );
      break;
    case "url":
      lines.push(`${label}: url form (no Authorization header)`);
      break;
    default:
      return [];
  }
  for (const hidden of entries.slice(1)) {
    lines.push(`  (hides the ${hidden.scope}-scope entry in ${hidden.source})`);
  }
  return lines;
}

function cmdStatus(deps: CliDeps, args: ReturnType<typeof parseArgs>): number {
  const cf = loadCredentialsFile(deps.credentialsPath);
  const names = Object.keys(cf.profiles);
  if (names.length === 0) {
    // Exit 1, as Python's ClickException ("No credentials found for
    // profile …") and `auth list`.
    throw new CliError("No profiles. Run: kagura-memory auth login");
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
  } else {
    for (const name of names) {
      for (const line of describeProfile(name, cf.profiles[name]!, cf.defaultProfile === name)) {
        deps.write(line);
      }
    }
  }
  // Once, after the profile block or blocks, where Python prints it.
  for (const line of claudeCodeLines()) deps.write(line);
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

/** Python's `make_oauth_client` timeout, for the revocation. */
const REVOKE_TIMEOUT_MS = 30_000;

/**
 * Revoke a profile's access token on its server, best effort, as the
 * Python CLI does before it deletes the profile. Never throws: false when
 * the server could not be reached, timed out, or refused.
 */
function revokeProfile(deps: CliDeps, creds: OAuthCredentials): Promise<boolean> {
  const base = deps.fetch ?? globalThis.fetch;
  // Bounded as Python's client is: a dead server must not hang logout.
  const fetch: typeof globalThis.fetch = (input, init) =>
    base(input, { ...init, signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS) });
  return revokeToken(creds.server, { token: creds.accessToken, clientId: creds.clientId, fetch });
}

/** Python's `_warn_if_api_key_env`: the variable outlives every profile. */
function noteApiKeyEnv(deps: CliDeps): void {
  if (process.env.KAGURA_API_KEY) {
    deps.write(
      "  Note: KAGURA_API_KEY is set in your environment — the env var will still authenticate " +
        "kagura-memory commands until you unset it.",
    );
  }
}

/**
 * `kagura auth logout` — revoke on the server, best effort, then delete
 * the profile.
 *
 * Three deliberate differences from Python remain: this asks before it
 * removes anything (`--yes`/`-y` skips it) where Python refuses `--all`
 * without `--yes`; an untargeted logout with nothing stored succeeds (see
 * below) where Python exits 1; and `--all` with `--profile` is a usage
 * error where Python ignores `--profile` and removes every profile.
 */
async function cmdLogout(deps: CliDeps, args: ReturnType<typeof parseArgs>): Promise<number> {
  const all = args.flags.has("all");
  const target = args.values.profile;
  // Naming one profile says the rest should stay; removing them all
  // anyway, as Python does, cannot be undone.
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
    // Python revokes each and says nothing of a failure here.
    for (const creds of Object.values(cf.profiles)) await revokeProfile(deps, creds);
    deleteCredentialsFile(deps.credentialsPath);
    deps.write("All profiles removed.");
    noteApiKeyEnv(deps);
    return 0;
  }
  const creds = cf.profiles[name];
  if (creds === undefined) {
    // Nothing to revoke or remove; say so rather than report a removal
    // that did not happen.
    deps.write(`No profile named '${name}'.`);
    return 1;
  }
  // Local logout succeeds whatever the server says, as in Python.
  if (!(await revokeProfile(deps, creds))) {
    deps.write(
      "  Warning: server-side revoke failed (network or 5xx). The local profile was still deleted. " +
        "The refresh_token may remain valid until it expires naturally.",
    );
  }
  await deleteProfile(name, deps.credentialsPath);
  deps.write(`Profile '${name}' removed.`);
  noteApiKeyEnv(deps);
  return 0;
}

/**
 * A UTC instant as Python's `datetime.isoformat()` writes it: `+00:00`,
 * and a fraction only when there is one.
 */
function pythonIsoUtc(date: Date): string {
  const iso = date.toISOString();
  const millis = iso.slice(20, 23);
  return `${iso.slice(0, 19)}${millis === "000" ? "" : `.${millis}000`}+00:00`;
}

/**
 * `kagura auth list` — one line per profile, default marked with `*`.
 *
 * `status` prints the full block; this is the version you can eyeball or
 * pipe into a picker. `--json` is Python's payload.
 */
function cmdList(deps: CliDeps, args: ReturnType<typeof parseArgs>): number {
  const cf = loadCredentialsFile(deps.credentialsPath);
  if (args.flags.has("json")) {
    // Python's `_profiles_as_json`: file order, no token, and `[]` (exit 0)
    // when there is no profile. `expired` is the access token's state;
    // `refreshable` says whether the profile is still usable. Printed with
    // json.dumps's default, as Python prints it: non-ASCII escaped.
    const payload = Object.entries(cf.profiles).map(([name, creds]) => ({
      profile: name,
      default: name === cf.defaultProfile,
      user_email: creds.userEmail,
      workspace_name: creds.workspaceName,
      workspace_id: creds.workspaceId,
      server: creds.server,
      scope: creds.scope,
      expired: isExpired(creds),
      refreshable: Boolean(creds.refreshToken),
      expires_at: pythonIsoUtc(creds.expiresAt),
    }));
    deps.write(formatJsonAscii(payload));
    return 0;
  }
  const names = Object.keys(cf.profiles).sort();
  if (names.length === 0) {
    // Exit 1, as Python's ClickException.
    throw new CliError("No profiles. Run: kagura-memory auth login");
  }
  for (const name of names) {
    const creds = cf.profiles[name]!;
    const marker = cf.defaultProfile === name ? "*" : " ";
    const state = !isExpired(creds) ? "active" : creds.refreshToken ? "expired (refreshable)" : "expired";
    deps.write(`${marker} ${name}\t${creds.userEmail || "(unknown)"}\t${workspaceLabel(creds)}\t${state}`);
  }
  return 0;
}

/**
 * `kagura auth token` — the raw access token on stdout, for CI.
 *
 * Refreshes first when the stored token has expired, so a script does not
 * have to distinguish "no token" from "stale token". The value is printed
 * bare, with no trailing decoration, so `$(… auth token)` is exact.
 */
async function cmdToken(deps: CliDeps, args: ReturnType<typeof parseArgs>): Promise<number> {
  const cf = loadCredentialsFile(deps.credentialsPath);
  const name = args.values.profile ?? cf.defaultProfile;
  const creds = cf.profiles[name];
  if (creds === undefined) {
    deps.writeError(`No profile named '${name}'.\n  Run: kagura-memory auth login`);
    return 1;
  }
  if (!isExpired(creds)) {
    deps.write(creds.accessToken);
    return 0;
  }
  if (!creds.refreshToken) {
    deps.writeError(`Profile '${name}' has expired and cannot refresh.\n  Run: kagura-memory auth login`);
    return 1;
  }
  const options: RefreshOptions = {};
  if (args.values.profile !== undefined) options.profile = args.values.profile;
  if (deps.credentialsPath !== undefined) options.credentialsPath = deps.credentialsPath;
  const refreshed = await deps.refresh(options);
  deps.write(refreshed.accessToken);
  return 0;
}

/**
 * Refuse `--invite` on an `auth` subcommand that does not read it.
 *
 * Every other flag a subcommand does not read is an unknown option. This
 * one is declared, hidden, on each of them ({@link INVITE_REFUSED}) so its
 * value, a sign-up credential, is consumed: a token that begins with `-`
 * would otherwise be read as short options, a letter at a time, and its
 * first letter that is no option named in the error. Ignored, it would
 * read as though the invite had been used, plausibly so on `refresh`,
 * which can re-run the device flow.
 * The message names the flag, never its value. Click, whose subcommands do
 * not declare it, says "No such option: --invite" with the same exit 2;
 * this wording also says where the flag belongs.
 */
function refuseInvite(run: Command["run"]): Command["run"] {
  return async (deps, args) => {
    if (args.values.invite !== undefined) {
      deps.writeError("--invite applies only to 'auth login'.");
      return 2;
    }
    return run(deps, args);
  };
}

/** The `auth` subcommands, as registry entries. */
const AUTH_GROUP: CommandGroup = {
  summary: "OAuth2 device-flow authentication for Kagura Memory.",
  commands: {
    login: {
      summary: "Authenticate via OAuth2 device flow.",
      description:
        "  --invite signs a new account up with a beta invite and approves this\n" +
        "  login from one link, on a server that supports it. An older server\n" +
        "  gets two steps instead, and one that takes no invites a notice. The\n" +
        "  invite is never saved, and is printed only inside a link.",
      spec: LOGIN_SPEC,
      run: (deps, args) => cmdLogin(deps as CliDeps, args),
    },
    refresh: {
      summary: "Rotate access_token (optionally requesting a new scope).",
      spec: REFRESH_SPEC,
      run: refuseInvite((deps, args) => cmdRefresh(deps as CliDeps, args)),
    },
    status: {
      summary: "Show the current profile, server, scope, expiry, and workspace.",
      description:
        "  Then the kagura-memory entry Claude Code uses in the current directory,\n" +
        "  and each one it hides, when a scope defines one.",
      spec: STATUS_SPEC,
      run: refuseInvite(async (deps, args) => cmdStatus(deps as CliDeps, args)),
    },
    use: {
      summary: "Set the default profile used when none is selected.",
      args: "PROFILE",
      spec: USE_SPEC,
      run: refuseInvite((deps, args) => cmdUse(deps as CliDeps, args)),
    },
    logout: {
      summary: "Revoke server-side and delete the local profile (or all of them).",
      description:
        "  The server-side revoke is best effort: the profile is deleted even when\n" +
        "  it fails. Asks first unless --yes; with nothing stored, a logout that\n" +
        "  names no profile succeeds. --all does not take --profile.",
      spec: LOGOUT_SPEC,
      run: refuseInvite((deps, args) => cmdLogout(deps as CliDeps, args)),
    },
    list: {
      summary: "List every stored profile; the default is marked with `*`.",
      spec: LIST_SPEC,
      run: refuseInvite(async (deps, args) => cmdList(deps as CliDeps, args)),
    },
    token: {
      summary: "Emit the raw access_token to stdout (for CI / scripts).",
      spec: TOKEN_SPEC,
      run: refuseInvite((deps, args) => cmdToken(deps as CliDeps, args)),
    },
  },
};

/** Everything reachable as `kagura-memory <name> …`. */
export const ROOT_COMMANDS: Record<string, Command | CommandGroup> = {
  auth: AUTH_GROUP,
  config: CONFIG_GROUP,
  context: CONTEXT_GROUP,
  doctor: DOCTOR,
  contexts: CONTEXTS_ALIAS,
  edge: EDGE_GROUP,
  files: FILES_GROUP,
  resource: RESOURCE_GROUP,
  secret: SECRET_GROUP,
  setup: SETUP_GROUP,
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
 * Click's errors for options a command or group does not take, in the
 * words of click 8.3, which the Python CLI's lockfile pins: `No such
 * option: --x`, naming the option without any value written into the
 * token, and `Option '--json' does not take a value.` Click 8.4 and later
 * word the first `No such option '--x'.`. Click also suggests a close
 * match (`Did you mean --json?`), which this bin does not.
 */
function reportBadOptions(deps: CliDeps, parsed: Pick<ParsedArgs, "unknown" | "noValue">): void {
  for (const name of parsed.unknown) deps.writeError(`Error: No such option: ${name}`);
  for (const name of parsed.noValue) deps.writeError(`Error: Option '${name}' does not take a value.`);
}

/** The options the root takes, beside `--help`; `--version` is answered before a command is looked up. */
const ROOT_SPEC: ParseSpec = { flags: [{ name: "version", type: "switch" }] };
/** A group takes no option but `--help`. */
const GROUP_SPEC: ParseSpec = { flags: [] };

/**
 * An option given to the root or a group, where a command name was due:
 * `--help` / `-h` asks for the help (exit 0); anything else is click's
 * error, then the help (exit 2).
 */
function groupOption(deps: CliDeps, token: string, spec: ParseSpec, help: string): { help: string; code: number } {
  if (token === "--help" || token === "-h") return { help, code: 0 };
  reportBadOptions(deps, parseArgs([token], spec));
  return { help, code: 2 };
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
  // No command: a bare invocation is a mistake.
  if (head === undefined) return { help: renderRootHelp(), code: 2 };
  if (head.startsWith("-")) return groupOption(deps, head, ROOT_SPEC, renderRootHelp());
  if (head === "help") {
    return { help: renderRootHelp(), code: 0 };
  }

  const found: Command | CommandGroup | undefined = BARE_AUTH_ALIASES.has(head)
    ? AUTH_GROUP.commands[head]
    : ROOT_COMMANDS[head];
  if (found === undefined) {
    deps.writeError(`Error: No such command '${head}'.`);
    return { help: renderRootHelp(), code: 2 };
  }
  let entry: Command | CommandGroup = found;

  // Groups nest — `resource tokens list` is three levels — so walk until a
  // leaf, taking one non-flag token per level.
  const path = BARE_AUTH_ALIASES.has(head) ? ["auth", head] : [head];
  let index = 1;
  while (isGroup(entry)) {
    const groupPath = `kagura-memory ${path.join(" ")}`;
    const next = argv[index];
    if (next === undefined) return { help: renderGroupHelp(groupPath, entry.summary, entry.commands), code: 2 };
    if (next.startsWith("-")) {
      return groupOption(deps, next, GROUP_SPEC, renderGroupHelp(groupPath, entry.summary, entry.commands));
    }
    const child: Command | CommandGroup | undefined = entry.commands[next];
    if (child === undefined) {
      deps.writeError(`Error: No such command '${next}'.`);
      return { help: renderGroupHelp(groupPath, entry.summary, entry.commands), code: 2 };
    }
    entry = child;
    path.push(next);
    index += 1;
  }

  return { command: entry, path: `kagura-memory ${path.join(" ")}`, rest: argv.slice(index) };
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
  const parsed = parseArgs(
    rest,
    command.spec,
    command.passthrough === true ? { stopAtPositional: true } : {},
  );

  if (parsed.flags.has("help")) {
    deps.write(renderHelp(path, command));
    return 0;
  }

  // Only the flags that declare `rejectEmpty`. Python accepts an empty
  // value everywhere, and three behaviours here depend on that:
  // `--context-id=` falls through to the config via its `or` chain, and
  // `--tags=` / `--details=` treat blank as unset so an unset shell
  // variable is not a hard error. Rejecting every empty value globally
  // contradicted all three — the guard belongs on `--profile` and
  // `--scope`, where "" does damage rather than nothing.
  const empty = command.spec.flags
    .filter((flag) => flag.rejectEmpty === true)
    .filter((flag) => {
      const value = parsed.values[flag.name];
      return value !== undefined && value.trim() === "";
    })
    .map((flag) => `--${flag.name}`);

  if (parsed.unknown.length > 0 || parsed.noValue.length > 0 || parsed.missingValue.length > 0 || empty.length > 0) {
    reportBadOptions(deps, parsed);
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
    positionals: [
      ...(parsed.command === "" ? [] : [parsed.command]),
      ...parsed.positionals,
      // For a passthrough command the remainder was never parsed; it is
      // the child's argv and must arrive byte-for-byte.
      ...parsed.rest,
    ],
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
