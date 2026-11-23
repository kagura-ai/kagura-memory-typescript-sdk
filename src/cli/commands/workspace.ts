/**
 * `kagura-memory workspace …` and the owner-provisioned key commands
 * `kagura-memory auth create-key|list-keys|revoke-key` — ports of the
 * Python CLI's `workspace` group and of the three commands `cli.py`
 * attaches to its `auth` group.
 *
 * `workspace list` (the Python CLI 0.49.0's, memory-cloud v0.177.0+) is the
 * one exception: it calls the MCP tool `list_workspaces` through the usual
 * client credential chain (no owner key; a connector key is refused).
 * Every other one runs through
 * {@link runWorkspaceCommand}, the port of
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
 * refused with `KaguraResponseError` in Python's words. Invitation and key
 * rows arrive validated by the SDK, including their timestamps.
 */

import type { MemberAPIKey, WorkspaceInvitation, WorkspaceMember } from "../../models.js";
import { modelDumpOf } from "../../modelDumpView.js";
import { ACCOUNT_WORKSPACE_LIST } from "../../pyModels.js";
import { normalizeUuid } from "../../pyCompat.js";
import {
  ResponseReader,
  laxBool,
  laxStr,
  nullable,
} from "../../responseShape.js";
import { VALID_ASSIGNABLE_ROLES, type WorkspaceClient } from "../../workspaceClient.js";
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
import { formatDumpsJson } from "../modelDump.js";
import { formatJson } from "../output.js";
import {
  CliError,
  CliUsageError,
  paramLabel,
  parseChoice,
  parseIdArg,
  parseRanged,
  pathIdParam,
  pyRepr,
  type Param,
} from "../parse.js";
import type { FlagSpec } from "../parseArgs.js";
import { runClientCommand } from "../runClientCommand.js";

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
 * Step 4 comes before the prompt, and the prompt names the workspace in
 * canonical form, as Python's `_run_workspace_command` does from 0.41.1
 * (python-sdk #285).
 *
 * @param question The confirmation to ask, given the workspace in
 *   canonical form; none for a command that does not ask, or under
 *   `--yes`.
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
  // Python's `workspace_id must be a UUID, got 'x'`.
  const canonical = normalizeUuid(workspaceId, "workspace_id");

  if (question !== undefined && !(await deps.confirm(question(canonical)))) {
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
    if (!coerced.ok) r.refuse(at, coerced);
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
 * joined_at, last_login_at, allowed_context_ids, credentials_status,
 * seat_paused`.
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
    // memory-cloud v0.100.0+ (#1943).
    seat_paused: r.field(obj, "seat_paused", laxBool, { default: false }),
  };
  r.check();
  return member;
}

/** `model_dump(exclude={"token", "invitation_url"})`: never a join credential. */
function invitationJson(invitation: WorkspaceInvitation): Record<string, unknown> {
  const { token: _token, invitation_url: _url, ...rest } = invitation;
  return rest;
}

/**
 * `model_dump(exclude={"plaintext_key"})` of an SDK-validated key:
 * never the secret, even if a server sent one.
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
 * Python's `_id_column_width`: the ID column 6 code points wide as
 * before, wider for an id that is longer — an opaque `akey_…` / `winv_…`
 * id (memory-cloud v0.89.0+, #1008) is 27 — so every row lines up. A
 * fold, not `Math.max(...ids)`: spreading a list of 150k ids or more as
 * arguments throws `RangeError`.
 *
 * @internal Exported for its tests.
 */
export function idColumnWidth(ids: readonly (number | string)[]): number {
  return ids.reduce<number>((width, id) => Math.max(width, [...String(id)].length), 6);
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
 * A user id, refused (exit 2) when it is `.`, `..` or empty: `member
 * remove ..` would send `DELETE /api/v1/workspaces/{ws}`, the workspace
 * itself. See {@link pathIdParam}.
 */
function userIdParam(param: Param, value: string): string {
  return pathIdParam(param, value, "user id");
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

/**
 * `-c/--context` values as canonical UUIDs, refused as click refuses a
 * value (exit 2) before anything is read — port of `_context_uuids_param`
 * (src/kagura_memory/cli.py, python-sdk #285): the server answers a
 * non-UUID with an HTTP 500.
 */
function contextUuids(values: readonly string[]): string[] {
  return values.map((c) => {
    try {
      return normalizeUuid(c, "--context");
    } catch {
      throw new CliUsageError(`Invalid value for ${paramLabel(CONTEXT)}: ${pyRepr(c)} is not a valid context UUID.`);
    }
  });
}

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
    const contexts = contextUuids(args.many.context ?? []);
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
      const invitation = await client.createInvitation(ws, email, {
        role,
        ...(contexts.length > 0 ? { allowedContextIds: contexts } : {}),
        ...(expiresInDays !== undefined ? { expiresInDays } : {}),
      });
      deps.writeError("⚠ The invitation URL below is shown once — treat it as a join credential.");
      // A missing email reads `-`, as in `invite list` (Python 0.41.1+ too).
      return (
        `Invitation ${invitation.id} → ${invitation.email || "-"} ` +
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
      const invitations = await client.listInvitations(ws, { includeAccepted });
      if (args.flags.has("json")) return formatJson(invitations.map(invitationJson));
      const w = idColumnWidth(invitations.map((i) => i.id));
      const lines = [`${pad("ID", w)} ${pad("EMAIL", 30)} ${pad("ROLE", 8)} ${pad("STATE", 9)} EXPIRES`];
      for (const i of invitations) {
        const state = i.is_accepted ? "accepted" : i.is_expired ? "expired" : "pending";
        lines.push(
          `${pad(String(i.id), w)} ${pad(i.email || "-", 30)} ${pad(i.role, 8)} ${pad(state, 9)} ` +
            dateOr(i.expires_at, "never"),
        );
      }
      return lines.join("\n");
    });
  },
};

const inviteRevoke: Command = {
  summary: "Revoke a pending invitation by its id (see `invite list`).",
  args: "INVITATION_ID",
  description: example("workspace invite revoke 7"),
  spec: { flags: [WORKSPACE] },
  run: async (deps, args) => {
    const invitationId = parseIdArg("INVITATION_ID", requireArg(args, 0, "INVITATION_ID"));
    rejectExtraArgs(args, 1);
    return runWorkspaceCommand(deps, args.values.workspace, async (client, ws) => {
      await client.revokeInvitation(ws, invitationId);
      // The parsed int, exact (`+7` reads `7`), or the string id as typed.
      return `Revoked invitation ${invitationId}`;
    });
  },
};

const INVITE_GROUP: CommandGroup = {
  summary: "Manage workspace invitations.",
  description: OWNER_KEY_NOTE,
  commands: { create: inviteCreate, list: inviteList, revoke: inviteRevoke },
};

// ---------------------------------------------------------------------------
// workspace list
// ---------------------------------------------------------------------------

/**
 * The East Asian Wide (W) and Fullwidth (F) code points, as inclusive
 * ranges in code point order: two terminal columns each, every other code
 * point one — what Python's `unicodedata.east_asian_width(ch) in ("W", "F")`
 * answers, which the Python CLI 0.49.0's `_display_width` counts. Generated
 * from Python 3.12's `unicodedata` (Unicode 15.0.0) by a one-off script
 * that walks U+0000-U+10FFFF and joins the runs.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x2e99], [0x2e9b, 0x2ef3], [0x2f00, 0x2fd5], [0x2ff0, 0x2ffb], [0x3000, 0x303e],
  [0x3041, 0x3096], [0x3099, 0x30ff], [0x3105, 0x312f], [0x3131, 0x318e], [0x3190, 0x31e3],
  [0x31f0, 0x321e], [0x3220, 0x3247], [0x3250, 0x4dbf], [0x4e00, 0xa48c], [0xa490, 0xa4c6],
  [0xa960, 0xa97c], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe52],
  [0xfe54, 0xfe66], [0xfe68, 0xfe6b], [0xff01, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff1], [0x17000, 0x187f7], [0x18800, 0x18cd5], [0x18d00, 0x18d08],
  [0x1aff0, 0x1aff3], [0x1aff5, 0x1affb], [0x1affd, 0x1affe], [0x1b000, 0x1b122],
  [0x1b132, 0x1b132], [0x1b150, 0x1b152], [0x1b155, 0x1b155], [0x1b164, 0x1b167],
  [0x1b170, 0x1b2fb], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248],
  [0x1f250, 0x1f251], [0x1f260, 0x1f265], [0x1f300, 0x1f320], [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c], [0x1fa80, 0x1fa88], [0x1fa90, 0x1fabd], [0x1fabf, 0x1fac5],
  [0x1face, 0x1fadb], [0x1fae0, 0x1fae8], [0x1faf0, 0x1faf8], [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

/** Whether `cp` is in {@link WIDE_RANGES}: a binary search. */
function isWide(cp: number): boolean {
  let lo = 0;
  let hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [first, last] = WIDE_RANGES[mid]!;
    if (cp < first) hi = mid - 1;
    else if (cp > last) lo = mid + 1;
    else return true;
  }
  return false;
}

/** The terminal columns `value` takes — Python's `_display_width`: a W or F code point counts 2, any other 1. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const ch of value) width += isWide(ch.codePointAt(0)!) ? 2 : 1;
  return width;
}

/** `value` padded with spaces to `width` terminal columns, never cut. */
function padDisplay(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - displayWidth(value)));
}

/**
 * The `workspace list` table — the Python CLI 0.49.0's `_workspaces_table`:
 * one row per workspace, `yes` / `-` under CURRENT, and under USABLE `yes`,
 * or `no` with the reason in parentheses. The NAME column is as wide as the
 * widest name in terminal columns, at least the header's four (a wide
 * character takes two), so no name is cut and every row lines up.
 */
export function workspacesTable(result: unknown): string {
  const rows = (result as { workspaces?: unknown }).workspaces;
  const items = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  let nameWidth = displayWidth("NAME");
  for (const ws of items) nameWidth = Math.max(nameWidth, displayWidth(text(ws.name)));
  const lines = [`${pad("ID", 36)} ${padDisplay("NAME", nameWidth)} ${pad("ROLE", 7)} ${pad("CURRENT", 7)} USABLE`];
  for (const ws of items) {
    let usable = ws.usable === true ? "yes" : "no";
    if (typeof ws.reason === "string" && ws.reason !== "") usable += ` (${ws.reason})`;
    lines.push(
      `${pad(text(ws.id), 36)} ${padDisplay(text(ws.name), nameWidth)} ${pad(text(ws.role), 7)} ` +
        `${pad(ws.current === true ? "yes" : "-", 7)} ${usable}`,
    );
  }
  return lines.join("\n");
}

/**
 * `workspace list`: the MCP tool `list_workspaces` (memory-cloud v0.177.0+,
 * #2972) through the usual client credential chain, not the owner-key
 * runner the rest of this group uses.
 */
const workspaceList: Command = {
  summary: "List the workspaces your account is a member of (memory-cloud 0.177.0+).",
  description:
    "  Calls the MCP tool list_workspaces with the configured credential (no owner\n" +
    "  key needed): your role in each, the connection's workspace (CURRENT), and\n" +
    "  whether 'kagura-memory context list --workspace-id ID' can list it now\n" +
    "  (USABLE, with the reason when not). A workspace-scoped API key sees only its\n" +
    "  own workspace.\n\n" +
    "  Examples:\n" +
    "    kagura-memory workspace list\n" +
    "    kagura-memory workspace list --json",
  spec: { flags: [JSON_OUTPUT] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const json = args.flags.has("json");
    return runClientCommand(deps, undefined, (client) => client.listWorkspaces(), {
      needsContext: false,
      format: json
        ? (result) => formatDumpsJson(modelDumpOf(result, ACCOUNT_WORKSPACE_LIST, "list_workspaces"))
        : workspacesTable,
    });
  },
};

export const WORKSPACE_GROUP: CommandGroup = {
  summary:
    "Workspaces: list yours (no owner key needed), and administer members and invitations (owner API key " +
    "required, server v0.42.0+).",
  commands: { list: workspaceList, member: MEMBER_GROUP, invite: INVITE_GROUP },
};

// ---------------------------------------------------------------------------
// auth create-key | list-keys | revoke-key
// ---------------------------------------------------------------------------

const KEY_EXPIRES_DAYS: FlagSpec = {
  range: { min: 1, max: 3650, rangeLabel: "1<=x<=3650", integer: true },
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
    const expiresDays = parseRanged(KEY_EXPIRES_DAYS, requireOption(args, KEY_EXPIRES_DAYS));
    rejectExtraArgs(args);
    return runWorkspaceCommand(deps, args.values.workspace, async (client, ws) => {
      // The key as the SDK read it, as Python's `MemberAPIKey` does (an
      // `akey_…` id stays the string). A response that model refuses
      // throws with the plaintext in the message (the only chance to save
      // it), and without this line: nothing below is printed.
      const key = await client.mintMemberKey(ws, userId, keyName, expiresDays);
      deps.writeError("⚠ Save this key now — it cannot be shown again.");
      // The user as given, the rest as the server answered.
      return (
        `Key ${key.id} '${key.name}' for ${userId} ` +
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
      const keys = await client.listMemberKeys(ws, userId);
      if (args.flags.has("json")) return formatJson(keys.map(keyJson));
      const w = idColumnWidth(keys.map((k) => k.id));
      const lines = [
        `${pad("ID", w)} ${pad("NAME", 24)} ${pad("PREFIX", 18)} ${pad("CREATED", 12)} ${pad("EXPIRES", 12)} REVOKED`,
      ];
      for (const k of keys) {
        lines.push(
          `${pad(String(k.id), w)} ${pad(k.name, 24)} ${pad(k.key_prefix, 18)} ` +
            `${pad(dateOr(k.created_at, "-"), 12)} ${pad(dateOr(k.expires_at, "never"), 12)} ` +
            dateOr(k.revoked_at, "-"),
        );
      }
      return lines.join("\n");
    });
  },
};

const revokeKey: Command = {
  summary: "Revoke a member's API key by its id (see `list-keys`).",
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
        return `Revoked key ${keyId} of ${userId}`;
      },
      args.flags.has("yes") ? undefined : (ws) => `Revoke key ${keyId} of ${userId} in workspace ${ws}?`,
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
