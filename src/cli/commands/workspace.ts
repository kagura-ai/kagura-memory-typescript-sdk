/**
 * `kagura-memory workspace …` and the owner-provisioned key commands
 * `kagura-memory auth create-key|list-keys|revoke-key` — ports of the
 * Python CLI's `workspace` group and of the three commands `cli.py`
 * attaches to its `auth` group.
 *
 * Every one of them runs through {@link runWorkspaceCommand}, the port of
 * `_run_workspace_command`: the workspace comes from the same credential
 * source as the key (#115), and the client is built from exactly that
 * credential. The server accepts only the workspace OWNER's static API key
 * here (memory-cloud v0.42.0+); the client's access-denied error names the
 * credential source a refused call used.
 *
 * Each record is read as the Python SDK's model reads it before anything
 * is printed: the model's keys in its order, defaults filled, unknown keys
 * dropped, the fields `--json` must never show (a join credential, a
 * key's plaintext) excluded, and a record missing a required field
 * refused with `KaguraResponseError` in Python's words. Timestamps pass
 * through as the server wrote them.
 */

import type { MemberAPIKey, WorkspaceInvitation, WorkspaceMember } from "../../models.js";
import { normalizeUuid } from "../../pyCompat.js";
import {
  ResponseReader,
  laxBool,
  laxInt,
  laxStr,
  nullable,
} from "../../responseShape.js";
import { VALID_ASSIGNABLE_ROLES, readMemberKey, type WorkspaceClient } from "../../workspaceClient.js";
import {
  rejectExtraArgs,
  requireArg,
  requireChoice,
  requireOption,
  type Command,
  type CommandDeps,
  type CommandGroup,
} from "../command.js";
import { pairWorkspaceCredential } from "../credentialSource.js";
import { formatJson } from "../output.js";
import {
  CliError,
  CliUsageError,
  paramLabel,
  parseChoice,
  parseIdArg,
  parseRanged,
  pyRepr,
  type Param,
} from "../parse.js";
import type { FlagSpec } from "../parseArgs.js";

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * Run one workspace operation — the port of `_run_workspace_command`, in
 * its order:
 *
 * 1. an empty or `auto` `--workspace` is refused before anything is read,
 *    rather than falling back to the source's workspace: fatal for a
 *    destructive command run with `--yes` from a script whose `$WS` was
 *    unset;
 * 2. the config is loaded and the credential resolved, once;
 * 3. the workspace is taken from that credential's source unless
 *    `--workspace` names one;
 * 4. the workspace must be a UUID;
 * 5. a destructive command asks, naming the workspace it will act on;
 * 6. the client is built from the same credential, with the workspace the
 *    source is bound to for its 403 hint;
 * 7. the operation's text is printed, on stdout.
 *
 * Step 4 comes before the prompt here. Python checks the UUID inside the
 * client, after the prompt, so its user confirms "Remove X from workspace
 * not-a-uuid?" and only then hears the id was never valid.
 *
 * @param question The confirmation to ask, given the workspace as
 *   resolved; none for a command that does not ask, or under `--yes`.
 */
async function runWorkspaceCommand(
  deps: CommandDeps,
  workspaceFlag: string | undefined,
  operation: (client: WorkspaceClient, workspaceId: string) => Promise<string>,
  question?: (workspaceId: string) => string,
): Promise<number> {
  const { auth, workspaceId, workspaceIdHint } = pairWorkspaceCredential(deps, workspaceFlag, {
    flag: "--workspace",
    refuseBlankOverride: true,
  });
  // Python's `workspace_id must be a UUID, got 'x'`. The prompt shows the
  // workspace as resolved (stripped), the request the canonical form.
  const canonical = normalizeUuid(workspaceId, "workspace_id");

  if (question !== undefined && !(await deps.confirm(question(workspaceId)))) {
    throw new CliError("Aborted!");
  }

  const client = deps.makeWorkspaceClient(auth, workspaceIdHint);
  try {
    deps.write(await operation(client, canonical));
    return 0;
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Reading the records as the Python models do
// ---------------------------------------------------------------------------

/** `raw` as the object a model reads, or that model's own error for anything else. */
function modelInput(r: ResponseReader, raw: unknown): Record<string, unknown> {
  const obj = r.object(raw);
  if (obj === null) r.check();
  return obj ?? {};
}

/** `obj[key]` when `obj` has it as its own key, else `undefined`. */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/**
 * A timestamp field, as the server sent it and `null` when it sent none:
 * the server's spelling is kept (no normalizer), which pydantic's round
 * trip leaves unchanged for every form the server writes.
 */
function passThrough(obj: Record<string, unknown>, key: string): unknown {
  const value = own(obj, key);
  return value === undefined ? null : value;
}

/**
 * A `list[str] | None` field: `null` when absent or null, else a list of
 * strings, each item that is none recorded at its index
 * (`allowed_context_ids.0: Input should be a valid string`).
 */
function stringList(r: ResponseReader, obj: Record<string, unknown>, key: string): string[] | null {
  const value = own(obj, key);
  if (value === undefined || value === null) return null;
  return r.list(obj, key, (item, at) => {
    const coerced = laxStr(item);
    if (!coerced.ok) r.issue(at, coerced.msg);
    return item as string;
  });
}

/** A `dict[str, Any] | None` field: `null` when absent or null, else an object. */
function mapping(r: ResponseReader, obj: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = own(obj, key);
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  r.issue([key], "Input should be a valid dictionary");
  return null;
}

/**
 * A `WorkspaceMember` row: `user_id, role, user_name, user_email,
 * joined_at, last_login_at, allowed_context_ids, credentials_status`.
 */
function readMember(raw: unknown, operation: string): WorkspaceMember {
  const r = new ResponseReader(operation, "WorkspaceMember");
  const obj = modelInput(r, raw);
  const member: WorkspaceMember = {
    user_id: r.field(obj, "user_id", laxStr),
    role: r.field(obj, "role", laxStr),
    user_name: r.field(obj, "user_name", nullable(laxStr), { default: null }),
    user_email: r.field(obj, "user_email", nullable(laxStr), { default: null }),
    joined_at: passThrough(obj, "joined_at") as string | null,
    last_login_at: passThrough(obj, "last_login_at") as string | null,
    allowed_context_ids: stringList(r, obj, "allowed_context_ids"),
    credentials_status: mapping(r, obj, "credentials_status"),
  };
  r.check();
  return member;
}

/**
 * A `WorkspaceInvitation` row, `token` and `invitation_url` included:
 * {@link invitationJson} drops them.
 */
function readInvitation(raw: unknown, operation: string): WorkspaceInvitation {
  const r = new ResponseReader(operation, "WorkspaceInvitation");
  const obj = modelInput(r, raw);
  const invitation: WorkspaceInvitation = {
    id: r.field(obj, "id", laxInt),
    email: r.field(obj, "email", nullable(laxStr), { default: null }),
    role: r.field(obj, "role", laxStr),
    token: r.field(obj, "token", nullable(laxStr), { default: null }),
    invitation_url: r.field(obj, "invitation_url", nullable(laxStr), { default: null }),
    is_accepted: r.field(obj, "is_accepted", laxBool, { default: false }),
    is_expired: r.field(obj, "is_expired", laxBool, { default: false }),
    created_at: passThrough(obj, "created_at") as string | null,
    expires_at: passThrough(obj, "expires_at") as string | null,
    allowed_context_ids: stringList(r, obj, "allowed_context_ids"),
  };
  r.check();
  return invitation;
}

/** `model_dump(exclude={"token", "invitation_url"})`: never a join credential. */
function invitationJson(invitation: WorkspaceInvitation): Record<string, unknown> {
  const { token: _token, invitation_url: _url, ...rest } = invitation;
  return rest;
}

/**
 * `model_dump(exclude={"plaintext_key"})` of a key read by
 * `readMemberKey`: never the secret, even if a server sent one.
 */
function keyJson(key: MemberAPIKey): Record<string, unknown> {
  const { plaintext_key: _plaintext, ...rest } = key;
  return rest;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Python's `f"{value:<width}"`: padded to `width` code points and never
 * cut, so a long value pushes the rest of its line right.
 */
function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - [...value].length));
}

/**
 * `dt.date().isoformat()` of a server timestamp — its first ten
 * characters, the date in the offset it was written in, as `.date()`
 * gives it — or `fallback` when there is none.
 */
function dateOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value.slice(0, 10) : fallback;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * `-w/--workspace`, the same on all ten commands. No `rejectEmpty`: an
 * explicitly empty value must reach the runner, which refuses it with
 * exit 1 as Python does.
 */
const WORKSPACE: FlagSpec = {
  name: "workspace",
  short: "w",
  type: "value",
  help: "Workspace UUID (default: the credential source's workspace)",
};

const JSON_OUTPUT: FlagSpec = { name: "json", type: "switch", help: "Raw JSON output" };
const YES: FlagSpec = { name: "yes", short: "y", type: "switch", help: "Skip confirmation" };

const ROLES = VALID_ASSIGNABLE_ROLES;
const ROLE_METAVAR = `[${ROLES.join("|")}]`;

/** Python's example lines, one per line, naming this bin. */
function example(command: string): string {
  return `  Example:\n    kagura-memory ${command}`;
}

/**
 * A user id, refused as click refuses a bad value (exit 2) when it is `.`
 * or `..`, before anything is read or asked. Percent-encoding leaves both
 * as they are and URL resolution then drops or climbs the segment:
 * `member remove ..` would send `DELETE /api/v1/workspaces/{ws}`, the
 * workspace itself. Python sends them (a PYBUG); the SDK refuses them
 * too, this check only words it as click would.
 */
function userIdParam(param: Param, value: string): string {
  if (value === "." || value === "..") {
    throw new CliUsageError(`Invalid value for ${paramLabel(param)}: ${pyRepr(value)} is not a valid user id.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// workspace member …
// ---------------------------------------------------------------------------

const memberList: Command = {
  summary: "List workspace members with role, email, and join date.",
  description: example("workspace member list -w <workspace-uuid>"),
  spec: { flags: [WORKSPACE, JSON_OUTPUT] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    return runWorkspaceCommand(deps, args.values.workspace, async (client, ws) => {
      const members = (await client.listMembers(ws)).map((m) =>
        readMember(m, "WorkspaceClient.list_members"),
      );
      if (args.flags.has("json")) return formatJson(members);
      const lines = [`${pad("USER", 28)} ${pad("ROLE", 8)} ${pad("EMAIL", 30)} JOINED`];
      for (const m of members) {
        lines.push(
          `${pad(m.user_id, 28)} ${pad(m.role, 8)} ${pad(m.user_email || "-", 30)} ${dateOr(m.joined_at, "-")}`,
        );
      }
      return lines.join("\n");
    });
  },
};

const ADD_ROLE: FlagSpec = {
  name: "role",
  type: "value",
  metavar: ROLE_METAVAR,
  required: true,
  help: "Role for the new member (owner cannot be assigned programmatically)",
};

const memberAdd: Command = {
  summary: "Add an ALREADY-REGISTERED user to the workspace by user id.",
  args: "USER_ID",
  description:
    "  The server does not validate that USER_ID exists (v0.42.0) — a typo creates\n" +
    "  a dangling membership row. Prefer `kagura-memory workspace invite create\n" +
    "  <email>` for onboarding.\n\n" +
    example("workspace member add google_1234 --role member"),
  spec: { flags: [ADD_ROLE, WORKSPACE] },
  run: async (deps, args) => {
    const userId = userIdParam("USER_ID", requireArg(args, 0, "USER_ID"));
    const role = requireChoice(args, ADD_ROLE, ROLES);
    rejectExtraArgs(args, 1);
    return runWorkspaceCommand(deps, args.values.workspace, async (client, ws) => {
      const m = readMember(await client.addMember(ws, userId, role), "WorkspaceClient.add_member");
      // The response's values, as Python prints them.
      return `Added ${m.user_id} as ${m.role}`;
    });
  },
};

const SET_ROLE: FlagSpec = {
  ...ADD_ROLE,
  help: "New role (owner changes go through the ownership transfer flow)",
};

const memberSetRole: Command = {
  summary: "Change a member's role.",
  args: "USER_ID",
  description: example("workspace member set-role google_1234 --role admin"),
  spec: { flags: [SET_ROLE, WORKSPACE] },
  run: async (deps, args) => {
    const userId = userIdParam("USER_ID", requireArg(args, 0, "USER_ID"));
    const role = requireChoice(args, SET_ROLE, ROLES);
    rejectExtraArgs(args, 1);
    return runWorkspaceCommand(deps, args.values.workspace, async (client, ws) => {
      const m = readMember(
        await client.updateMemberRole(ws, userId, role),
        "WorkspaceClient.update_member_role",
      );
      return `${m.user_id} is now ${m.role}`;
    });
  },
};

const memberRemove: Command = {
  summary: "Remove a member from the workspace.",
  args: "USER_ID",
  description:
    "  Prompts for confirmation unless --yes is passed.\n\n" +
    example("workspace member remove google_1234 --yes"),
  spec: { flags: [YES, WORKSPACE] },
  run: async (deps, args) => {
    const userId = userIdParam("USER_ID", requireArg(args, 0, "USER_ID"));
    rejectExtraArgs(args, 1);
    return runWorkspaceCommand(
      deps,
      args.values.workspace,
      async (client, ws) => {
        await client.removeMember(ws, userId);
        return `Removed ${userId}`;
      },
      args.flags.has("yes") ? undefined : (ws) => `Remove ${userId} from workspace ${ws}?`,
    );
  },
};

/** The group's second paragraph in Python, on both subgroups. */
const OWNER_KEY_NOTE =
  "  Requires the workspace OWNER's static API key — OAuth tokens are\n" +
  "  rejected by the server on this surface.";

const MEMBER_GROUP: CommandGroup = {
  summary: "Manage workspace members.",
  description: OWNER_KEY_NOTE,
  commands: { list: memberList, add: memberAdd, "set-role": memberSetRole, remove: memberRemove },
};

// ---------------------------------------------------------------------------
// workspace invite …
// ---------------------------------------------------------------------------

const INVITE_ROLE: FlagSpec = {
  name: "role",
  type: "value",
  metavar: ROLE_METAVAR,
  defaultLabel: "member",
  help: "Role granted on accept (owner invitations are not supported)",
};

const CONTEXT: FlagSpec = {
  name: "context",
  short: "c",
  type: "multiple",
  help: "Context UUID the invitee may access (repeatable; required for member/viewer)",
};

/** Strings, as Python's `click.Choice(["7", "30", "90", "365"])` matches them: `07` is none. */
const INVITE_EXPIRES = ["7", "30", "90", "365"] as const;

const INVITE_EXPIRES_DAYS: FlagSpec = {
  name: "expires-days",
  type: "value",
  metavar: `[${INVITE_EXPIRES.join("|")}]`,
  help: "Expiry preset (server accepts only these; omit = never expires)",
};

const inviteCreate: Command = {
  summary: "Invite a not-yet-registered user by EMAIL.",
  args: "EMAIL",
  description:
    "  The invitation URL is printed ONCE — it is a join credential and is never\n" +
    "  shown again (invite list returns metadata only).\n\n" +
    example("workspace invite create new@example.com --role member -c <context-uuid>"),
  spec: { flags: [INVITE_ROLE, CONTEXT, INVITE_EXPIRES_DAYS, WORKSPACE] },
  run: async (deps, args) => {
    const email = requireArg(args, 0, "EMAIL");
    const rawRole = args.values.role;
    const role = rawRole === undefined ? "member" : parseChoice(INVITE_ROLE, rawRole, ROLES);
    const contexts = args.many.context ?? [];
    const rawExpires = args.values["expires-days"];
    const expiresInDays =
      rawExpires === undefined ? undefined : Number(parseChoice(INVITE_EXPIRES_DAYS, rawExpires, INVITE_EXPIRES));
    rejectExtraArgs(args, 1);

    if ((role === "member" || role === "viewer") && contexts.length === 0) {
      // Before any credential is read, and naming the flag: the SDK's own
      // guard would name `allowedContextIds`, which is no option here.
      throw new CliUsageError(
        `--role ${role} requires at least one --context/-c <uuid> (the invitee's context grant).`,
      );
    }

    return runWorkspaceCommand(deps, args.values.workspace, async (client, ws) => {
      // Checked here, where Python's SDK checks its UUIDs, rather than
      // sent as typed: the server answers a non-UUID with an HTTP 500.
      const allowedContextIds = contexts.map((c) => normalizeUuid(c, "context_id"));
      const invitation = readInvitation(
        await client.createInvitation(ws, email, {
          role,
          ...(allowedContextIds.length > 0 ? { allowedContextIds } : {}),
          ...(expiresInDays !== undefined ? { expiresInDays } : {}),
        }),
        "WorkspaceClient.create_invitation",
      );
      deps.writeError("⚠ The invitation URL below is shown once — treat it as a join credential.");
      // A missing email reads `-`, as in `invite list`; Python prints `None`.
      return (
        `Invitation #${invitation.id} → ${invitation.email || "-"} ` +
        `(role=${invitation.role}, expires=${dateOr(invitation.expires_at, "never")})\n` +
        `${invitation.invitation_url || invitation.token || "(no url returned)"}`
      );
    });
  },
};

const inviteList: Command = {
  summary: "List invitations (pending by default).",
  description:
    "  Tokens/URLs are never shown here — the server nulls them for API-key\n" +
    "  callers, and the JSON output drops the fields entirely.\n\n" +
    example("workspace invite list"),
  spec: {
    flags: [
      { name: "include-accepted", type: "switch", help: "Include accepted rows" },
      JSON_OUTPUT,
      WORKSPACE,
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const includeAccepted = args.flags.has("include-accepted");
    return runWorkspaceCommand(deps, args.values.workspace, async (client, ws) => {
      const invitations = (await client.listInvitations(ws, { includeAccepted })).map((i) =>
        readInvitation(i, "WorkspaceClient.list_invitations"),
      );
      if (args.flags.has("json")) return formatJson(invitations.map(invitationJson));
      const lines = [`${pad("ID", 6)} ${pad("EMAIL", 30)} ${pad("ROLE", 8)} ${pad("STATE", 9)} EXPIRES`];
      for (const i of invitations) {
        const state = i.is_accepted ? "accepted" : i.is_expired ? "expired" : "pending";
        lines.push(
          `${pad(String(i.id), 6)} ${pad(i.email || "-", 30)} ${pad(i.role, 8)} ${pad(state, 9)} ` +
            dateOr(i.expires_at, "never"),
        );
      }
      return lines.join("\n");
    });
  },
};

const inviteRevoke: Command = {
  summary: "Revoke a pending invitation by its integer id (see `invite list`).",
  args: "INVITATION_ID",
  description: example("workspace invite revoke 7"),
  spec: { flags: [WORKSPACE] },
  run: async (deps, args) => {
    const invitationId = parseIdArg("INVITATION_ID", requireArg(args, 0, "INVITATION_ID"));
    rejectExtraArgs(args, 1);
    return runWorkspaceCommand(deps, args.values.workspace, async (client, ws) => {
      await client.revokeInvitation(ws, invitationId);
      // The parsed int, exact: `+7` reads `#7`.
      return `Revoked invitation #${invitationId}`;
    });
  },
};

const INVITE_GROUP: CommandGroup = {
  summary: "Manage workspace invitations.",
  description: OWNER_KEY_NOTE,
  commands: { create: inviteCreate, list: inviteList, revoke: inviteRevoke },
};

export const WORKSPACE_GROUP: CommandGroup = {
  summary: "Workspace administration (owner API key required, server v0.42.0+).",
  commands: { member: MEMBER_GROUP, invite: INVITE_GROUP },
};

// ---------------------------------------------------------------------------
// auth create-key | list-keys | revoke-key
// ---------------------------------------------------------------------------

const KEY_EXPIRES_DAYS: FlagSpec = {
  name: "expires-days",
  type: "value",
  metavar: "INTEGER",
  required: true,
  help: "Key lifetime in days (required — never-expiring provisioned keys are not allowed)",
};

const CREATE_USER: FlagSpec = {
  name: "user",
  short: "u",
  type: "value",
  required: true,
  help: "Target member's user id (must hold member/viewer role; not yourself)",
};

const KEY_NAME: FlagSpec = {
  name: "name",
  short: "n",
  type: "value",
  required: true,
  help: "Key name (unique per workspace)",
};

const createKey: Command = {
  summary: "Mint an API key for another workspace member (owner API key required).",
  description:
    "  The key is printed ONCE and never persisted — save it immediately.\n" +
    "  Owner-provisioned keys are privilege-downgrade provisioning for\n" +
    "  member/viewer service identities: the server rejects self-targets and\n" +
    "  owner/admin targets. For your own key, use the web dashboard.\n\n" +
    example("auth create-key --user google_1234 --name ci-bot --expires-days 90"),
  spec: { flags: [CREATE_USER, KEY_NAME, KEY_EXPIRES_DAYS, WORKSPACE] },
  run: async (deps, args) => {
    const userId = userIdParam(CREATE_USER, requireOption(args, CREATE_USER));
    const keyName = requireOption(args, KEY_NAME);
    const expiresDays = parseRanged(KEY_EXPIRES_DAYS, requireOption(args, KEY_EXPIRES_DAYS), {
      min: 1,
      max: 3650,
      rangeLabel: "1<=x<=3650",
      integer: true,
    });
    rejectExtraArgs(args);
    return runWorkspaceCommand(deps, args.values.workspace, async (client, ws) => {
      // The key as the SDK read it, as Python's `MemberAPIKey` does (an id
      // of "42" is 42). A response that model refuses throws with the
      // plaintext in the message (the only chance to save it), and without
      // this line: nothing below is printed.
      const key = await client.mintMemberKey(ws, userId, keyName, expiresDays);
      deps.writeError("⚠ Save this key now — it cannot be shown again.");
      // The user as given, the rest as the server answered.
      return (
        `Key #${key.id} '${key.name}' for ${userId} ` +
        `(prefix=${key.key_prefix}, expires=${dateOr(key.expires_at, "never")})\n` +
        `${key.plaintext_key || "(no plaintext returned)"}`
      );
    });
  },
};

const listKeys: Command = {
  summary: "List a member's API keys — metadata only, never the plaintext.",
  description: example("auth list-keys --user google_1234"),
  spec: {
    flags: [{ ...CREATE_USER, help: "Target member's user id" }, JSON_OUTPUT, WORKSPACE],
  },
  run: async (deps, args) => {
    const userId = userIdParam(CREATE_USER, requireOption(args, CREATE_USER));
    rejectExtraArgs(args);
    return runWorkspaceCommand(deps, args.values.workspace, async (client, ws) => {
      const keys = (await client.listMemberKeys(ws, userId)).map((k) =>
        readMemberKey(k, "WorkspaceClient.list_member_keys"),
      );
      if (args.flags.has("json")) return formatJson(keys.map(keyJson));
      const lines = [
        `${pad("ID", 6)} ${pad("NAME", 24)} ${pad("PREFIX", 18)} ${pad("CREATED", 12)} ${pad("EXPIRES", 12)} REVOKED`,
      ];
      for (const k of keys) {
        lines.push(
          `${pad(String(k.id), 6)} ${pad(k.name, 24)} ${pad(k.key_prefix, 18)} ` +
            `${pad(dateOr(k.created_at, "-"), 12)} ${pad(dateOr(k.expires_at, "never"), 12)} ` +
            dateOr(k.revoked_at, "-"),
        );
      }
      return lines.join("\n");
    });
  },
};

const revokeKey: Command = {
  summary: "Revoke a member's API key by its integer id (see `list-keys`).",
  args: "KEY_ID",
  description:
    "  Server-side this is a soft revoke — the row is kept for audit.\n\n" +
    example("auth revoke-key 42 --user google_1234 --yes"),
  spec: {
    flags: [{ ...CREATE_USER, help: "The member the key belongs to" }, YES, WORKSPACE],
  },
  run: async (deps, args) => {
    const keyId = parseIdArg("KEY_ID", requireArg(args, 0, "KEY_ID"));
    const userId = userIdParam(CREATE_USER, requireOption(args, CREATE_USER));
    rejectExtraArgs(args, 1);
    return runWorkspaceCommand(
      deps,
      args.values.workspace,
      async (client, ws) => {
        await client.revokeMemberKey(ws, userId, keyId);
        return `Revoked key #${keyId} of ${userId}`;
      },
      args.flags.has("yes") ? undefined : (ws) => `Revoke key #${keyId} of ${userId} in workspace ${ws}?`,
    );
  },
};

/**
 * The key commands `auth` lists beside `login`, `status` and the rest.
 * `run.ts` registers them there, refusing `--invite` as it does on every
 * `auth` subcommand but `login`; they are no bare `kagura-memory
 * create-key` aliases, which only the seven original subcommands have.
 */
export const AUTH_KEY_COMMANDS = {
  "create-key": createKey,
  "list-keys": listKeys,
  "revoke-key": revokeKey,
} satisfies Record<string, Command>;
