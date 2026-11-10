/**
 * REST client for workspace member & invitation management (#225) —
 * port of workspace_client.py.
 *
 * Owner-key operational tooling: memory-cloud v0.42.0 gates every endpoint
 * here at workspace-OWNER role for programmatic principals and rejects
 * OAuth Bearer tokens outright ("Use a workspace-owner API key"). The web
 * UI (session auth) keeps its own per-endpoint role semantics — this
 * client only ever sees the programmatic contract.
 *
 * Construction, credential resolution, lifecycle, and the base error
 * mapping live in {@link KaguraRestClient} (#229); this module keeps only
 * the workspace-specific wire contract: the owner-key 403 hint and the
 * detail-carrying 429 quota mapping. Plan and quota refusals take the
 * base's typed mapping before either.
 */

import { SOURCE_LABEL } from "./auth/types.js";
import { KaguraAuthError, KaguraContextNotInAccessListError, KaguraPermissionError, KaguraConnectionError, KaguraError, KaguraQuotaError, KaguraResponseError } from "./errors.js";
import { responseRetryAfter, sanitizeServerDetail } from "./http.js";
import type { MemberAPIKey, OperationHistoryPage, WorkspaceInvitation, WorkspaceMember } from "./models.js";
import { pydanticDatetime } from "./pydanticDatetime.js";
import { isSet, pyRepr, pyTypeName } from "./python.js";
import { responseShapeError } from "./responseShape.js";
import { WORKSPACE_MEMBER_ACCESS_FIELDS, CONTEXT_MEMBER, MEMBER_CONTEXT_ACCESS, MEMBER_CONTEXT_ACCESS_UPDATE, MEMBER_API_KEY, OPERATION_HISTORY_PAGE, WORKSPACE_INVITATION, readModel, type Model } from "./pyModels.js";
import { pathSegment } from "./pathSegment.js";
import { normalizeUuid } from "./pyCompat.js";
import { KaguraRestClient, requireInt, requirePublicId } from "./restBase.js";
import type { KaguraRestClientOptions, RequestContext, RestResponse } from "./restBase.js";

export const VALID_ASSIGNABLE_ROLES = ["member", "admin", "viewer"] as const;
// "owner" is excluded: the server 422s programmatic role=owner on member
// add/set-role (memory-cloud#1164 — "use the ownership transfer flow") and
// rejects owner invitations for every principal (memory-cloud#1166).

export const VALID_INVITE_EXPIRES = [7, 30, 90, 365] as const;
// Server-side preset list: any other value in the otherwise-valid 1-365
// range still 400s at the service layer, so fail fast client-side.
// Omitted = never expires.

const UNIFORM_403 = "Insufficient permissions";
// The deliberately uniform authorization denial (CWE-639). Every other 403 on
// this surface carries a purpose-built message (OAuth rejection, deployment
// kill-switch, plan gate, self-role-change, key/workspace mismatch) that is
// already actionable and must pass through untouched.

/**
 * A workspace id in canonical form: every spelling Python's `uuid.UUID`
 * takes (`{braces}`, `urn:uuid:`, dashless, uppercase), through the same
 * port the CLI and `MemoryClient` use, so one id cannot pass one client
 * and fail another. Sending the RAW input would surface as a misleading
 * uniform 404 — normalize instead of just validating.
 */
function normalizeWorkspaceId(workspaceId: string): string {
  return normalizeUuid(workspaceId, "workspaceId");
}

/**
 * `userId` as a path segment, percent-encoded: refused when it is `.`,
 * `..` or empty, which no user id is (see {@link pathSegment}).
 * `removeMember(ws, "..")` would otherwise send
 * `DELETE /api/v1/workspaces/{ws}`, the workspace itself. The Python SDK
 * sends them. `addMember`, whose id goes in the body, refuses them too:
 * such a member could never be addressed afterwards.
 */
function userIdSegment(userId: string): string {
  return pathSegment(userId, "userId", "a user id");
}

/** `/api/v1/workspaces/{ws}/members/{userId}`, the id checked and percent-encoded. */
function memberPath(workspaceId: string, userId: string): string {
  return `/api/v1/workspaces/${workspaceId}/members/${userIdSegment(userId)}`;
}

/** Read one Python model while preserving the SDK's number/string ID API. */
function readWorkspaceRow(raw: unknown, model: Model, operation: string): Record<string, unknown> {
  const row = readModel(raw, model, operation);
  if (typeof row.id === "bigint") row.id = Number(row.id);
  return row;
}

/** @internal Shared validation for the mint and list key responses. */
export function readMemberKey(raw: unknown, operation: string): MemberAPIKey {
  return readWorkspaceRow(raw, MEMBER_API_KEY, operation) as unknown as MemberAPIKey;
}

/** The add and role-change routes always expose the access list, including on older servers. */
export type WorkspaceMemberResult = WorkspaceMember & { allowed_context_ids: string[] | null };

/** Use an existing web session. Node callers supply a fetch with their session cookie/CSRF handling. */
export interface WorkspaceSessionOptions extends Pick<KaguraRestClientOptions, "timeoutMs" | "fetch"> {
  baseUrl: string;
  session: true;
  apiKey?: never;
  oauth?: never;
}

export interface AddMemberOptions {
  role?: string;
  allowedContextIds?: readonly string[] | null;
}

export interface MemberContextAccessUpdate {
  status: "ok";
  user_id: string;
  allowed_context_ids: string[] | null;
}

export interface MemberContextAccess {
  user_id: string;
  role: string;
  allowed_context_ids: string[] | null;
  contexts: {
    id: string;
    name: string;
    display_name: string | null;
    summary: string | null;
    is_private: boolean;
    is_own_private: boolean;
  }[];
}

export interface ContextMember {
  user_id: string;
  role: string;
  added_at: string | null;
  user_name: string | null;
  user_email: string | null;
  is_workspace_admin: boolean;
  access_list_extended: boolean;
}

function isSessionOptions(options: KaguraRestClientOptions | WorkspaceSessionOptions): options is WorkspaceSessionOptions {
  return "session" in options && Boolean(options.session);
}

function contextIds(ids: readonly string[] | null): string[] | null {
  return ids === null ? null : ids.map(id => normalizeUuid(id, "allowedContextIds"));
}

/** Options for {@link WorkspaceClient.createInvitation}. */
export interface CreateInvitationOptions {
  /** `member` | `admin` | `viewer` (default: `"member"`). */
  role?: string;
  /**
   * Context grant — required (min 1) for member/viewer invitations,
   * ignored for admin. Each must be a UUID (an `Error` otherwise, before
   * any request); sent as `allowed_context_ids` in canonical form.
   */
  allowedContextIds?: string[];
  /**
   * One of 7/30/90/365 (sent as `expires_in_days`), or omit for a
   * never-expiring invitation.
   */
  expiresInDays?: number;
}

/** Options for {@link WorkspaceClient.listInvitations}. */
export interface ListInvitationsOptions {
  /** Include already-accepted invitations (default: false). */
  includeAccepted?: boolean;
}

/** An operation-history `target_type` filter: the values memory-cloud v0.154.0 knows, or any other string. */
export type OperationHistoryTargetType =
  | "memory"
  | "context"
  | "member"
  | "credential"
  | "integration"
  | "sleep"
  | (string & {});

/** An operation-history `outcome` filter: the values memory-cloud v0.154.0 knows, or any other string. */
export type OperationHistoryOutcome = "success" | "failure" | "denied" | (string & {});

/**
 * Options for {@link WorkspaceClient.listOperationHistory}. Each is sent
 * only when set, under the server's wire name; the filters combine.
 * `targetType`, `outcome` and `operation` are not checked against a list
 * here: the server is the authority, and refuses a value it does not know
 * with a 422.
 */
export interface ListOperationHistoryOptions {
  /**
   * Text search over actor names and ids, target, context, agent and
   * credential/client ids, operation names and changed-field names
   * (`query`, at most 120 characters).
   */
  query?: string;
  /** Only events in this context (`context_id`, a UUID). */
  contextId?: string;
  /** Only events by this actor user id (`actor`, at most 255 characters). */
  actor?: string;
  /** Only events attributed to this agent (`agent_id`, a UUID). */
  agentId?: string;
  /**
   * One of the server's operation names, such as `memory.created`,
   * `context.updated`, `member.access_changed`, `credential.revoked` or
   * `sleep.undo` (`operation`, at most 40 characters).
   */
  operation?: string;
  /** `memory`, `context`, `member`, `credential`, `integration` or `sleep` (`target_type`). */
  targetType?: OperationHistoryTargetType;
  /** `success`, `failure` or `denied` (`outcome`). */
  outcome?: OperationHistoryOutcome;
  /**
   * Window start, inclusive (`since`): a `Date`, sent as its UTC instant
   * (`toISOString()`), or an ISO 8601 datetime string with an explicit
   * offset (`Z` or `±HH:MM`), sent as written. A string without an offset
   * is refused, as the server refuses it.
   */
  since?: string | Date;
  /** Window end, inclusive (`until`), in the form {@link since} takes; not before `since`. */
  until?: string | Date;
  /** Page size, an integer in 1-100 (`limit`); the server's default is 30. */
  limit?: number;
  /**
   * A previous page's `next_cursor`, passed back unchanged (`cursor`, at
   * most 512 characters). It is opaque: never build or edit one.
   */
  cursor?: string;
}

/** The operation-history route's text bounds, in characters (code points) as pydantic's `max_length` counts. */
const HISTORY_QUERY_MAX = 120;
const HISTORY_ACTOR_MAX = 255;
const HISTORY_OPERATION_MAX = 40;
const HISTORY_CURSOR_MAX = 512;
const HISTORY_LIMIT_MIN = 1;
const HISTORY_LIMIT_MAX = 100;

const SESSION_ONLY_HISTORY =
  "WorkspaceClient.listOperationHistory: the operation-history route accepts a signed-in web session only, " +
  "not an API key, OAuth or resource token. Build a session client with " +
  "new WorkspaceClient({ baseUrl, session: true, fetch }), where fetch carries the session cookie.";

/** `value` as a string of at most `max` code points, or an `Error` naming the option. */
function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string, got ${pyTypeName(value)}`);
  }
  const length = [...value].length;
  if (length > max) {
    throw new Error(`${name} must be at most ${max} characters, got ${length}`);
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string, got ${pyTypeName(value)}`);
  }
  return value;
}

/** pydantic's JSON form of an aware datetime, which {@link pydanticDatetime} writes. */
const AWARE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{6}))?(Z|([+-])(\d{2}):(\d{2}))$/;

/** A `since` / `until` value: the text sent, and its instant in microseconds since the epoch. */
interface HistoryTime {
  text: string;
  micros: bigint;
}

/**
 * A time filter as the server reads it. A `Date` is its UTC instant. A
 * string is sent as written once the server's own parser (pydantic's
 * `datetime`, {@link pydanticDatetime}) reads it as an ISO 8601 datetime
 * with an offset: a naive datetime, a date alone and a Unix time are
 * refused, as the route refuses a naive value.
 */
function historyTime(value: unknown, name: string): HistoryTime {
  if (value instanceof Date) {
    const time = value.getTime();
    const year = value.getUTCFullYear();
    if (Number.isNaN(time) || year < 1 || year > 9999) {
      throw new Error(`${name} must be a valid Date in years 1-9999`);
    }
    return { text: value.toISOString(), micros: BigInt(time) * 1000n };
  }
  const read = typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? pydanticDatetime(value) : null;
  const parts = read?.ok ? AWARE_DATETIME.exec(read.value) : null;
  if (parts === null || parts === undefined) {
    const shown = typeof value === "string" ? pyRepr(value) : pyTypeName(value);
    throw new Error(
      `${name} must be an ISO 8601 datetime with a timezone offset or a Date ` +
        `(2026-11-09T10:00:00Z, 2026-11-09T19:00:00+09:00), got ${shown}`,
    );
  }
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [
    number, number, number, number, number, number,
  ];
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, 0);
  let micros = BigInt(at.getTime()) * 1000n + BigInt(parts[7] ?? 0);
  if (parts[8] !== "Z") {
    const offset = (Number(parts[10]) * 60 + Number(parts[11])) * (parts[9] === "-" ? -1 : 1);
    micros -= BigInt(offset) * 60_000_000n;
  }
  return { text: value as string, micros };
}

function historyLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < HISTORY_LIMIT_MIN || value > HISTORY_LIMIT_MAX) {
    throw new Error(
      `limit must be an integer between ${HISTORY_LIMIT_MIN} and ${HISTORY_LIMIT_MAX}, got ` +
        (typeof value === "string" ? pyRepr(value) : String(value)),
    );
  }
  return value;
}

/**
 * REST API client for workspace member / invitation management.
 *
 * Requires the workspace OWNER's API key when called programmatically
 * (memory-cloud v0.42.0+). OAuth profiles are rejected by the server on
 * this surface — resolve a static owner key (`KAGURA_API_KEY` env or
 * `.kagura.json`) instead. {@link addContextMember} and
 * {@link listOperationHistory} use a signed-in web session instead: build
 * the client with `session: true` for them.
 *
 * All methods may reject with:
 * - `KaguraAuthError` — authentication failed (401)
 * - `KaguraConnectionError` — access denied (403 — non-owner key, OAuth
 *   token, or deployment kill-switch; the message says which) or any
 *   other HTTP/connection error
 * - `KaguraNotFoundError` — workspace/member/invitation not found (404).
 *   Also returned for a workspace-scoped key used against a different
 *   workspace (uniform 404, memory-cloud #963) — a 404 here does NOT
 *   prove the resource is absent.
 * - `KaguraFeatureNotAvailableError` — the plan lacks the feature (403 `FEAT-001`):
 *   a public-bound member key, or team invitations (server v0.75.0+;
 *   older servers answer 403 `HTTP-403`, a `KaguraConnectionError`)
 * - `KaguraQuotaError` — member seat cap or rate limit exceeded (429);
 *   from server v0.75.0 the seat cap carries `quotaType: "members"` and
 *   its counts
 */
export class WorkspaceClient extends KaguraRestClient {
  /** Whether this client was built with `session: true`; it then carries no bearer credential. */
  private readonly sessionMode: boolean;

  constructor(options: KaguraRestClientOptions | WorkspaceSessionOptions = {}) {
    super(options, isSessionOptions(options) ? "session" : "bearer");
    this.sessionMode = isSessionOptions(options);
  }

  // -------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------

  private readMember(raw: unknown, operation: string): WorkspaceMemberResult {
    const fields = readModel(raw, WORKSPACE_MEMBER_ACCESS_FIELDS, operation);
    return { ...(raw as WorkspaceMember), allowed_context_ids: fields.allowed_context_ids as string[] | null };
  }

  /**
   * List workspace members (owner key required).
   *
   * Rows are ordered owner→viewer then by join date and include
   * `user_name`/`user_email` when the member has logged in.
   */
  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const ws = normalizeWorkspaceId(workspaceId);
    const resp = await this.request("GET", `/api/v1/workspaces/${ws}/members`);
    return this.expectRows(resp, "list_members") as unknown as WorkspaceMember[];
  }

  /**
   * Add an already-registered user to the workspace.
   *
   * The server does NOT validate that `userId` exists (v0.42.0) — a typo
   * creates a dangling membership row that lists with null name/email.
   * Prefer {@link createInvitation} for onboarding; use this only with a
   * user_id copied from a trusted source. Duplicate members are rejected
   * with 422.
   */
  async addMember(
    workspaceId: string,
    userId: string,
    roleOrOptions: string | AddMemberOptions = "member",
  ): Promise<WorkspaceMemberResult> {
    const options = typeof roleOrOptions === "string" ? { role: roleOrOptions } : roleOrOptions;
    const role = options.role ?? "member";
    const ws = normalizeWorkspaceId(workspaceId);
    this.validateRole(role);
    // Checked as the member's path will be, though the id goes in the body.
    userIdSegment(userId);
    const resp = await this.request("POST", `/api/v1/workspaces/${ws}/members`, {
      json: {
        user_id: userId, role,
        ...(options.allowedContextIds === undefined ? {} : { allowed_context_ids: contextIds(options.allowedContextIds) }),
      },
    });
    return this.readMember(this.json(resp), "WorkspaceClient.add_member");
  }

  /** Read the access list and assignable contexts (memory-cloud v0.144.0+). */
  async getMemberContextAccess(workspaceId: string, userId: string): Promise<MemberContextAccess> {
    const path = memberPath(normalizeWorkspaceId(workspaceId), userId);
    const resp = await this.request("GET", path + "/context-access", { typedPermissionErrors: true });
    return readModel(this.json(resp), MEMBER_CONTEXT_ACCESS, "WorkspaceClient.get_member_context_access") as unknown as MemberContextAccess;
  }

  /** Replace the list. null restores role defaults. [] grants members/viewers no shared contexts. */
  async setMemberContextAccess(workspaceId: string, userId: string, ids: readonly string[] | null): Promise<MemberContextAccessUpdate> {
    const path = memberPath(normalizeWorkspaceId(workspaceId), userId);
    const resp = await this.request("PUT", path + "/context-access", {
      typedPermissionErrors: true,
      json: { allowed_context_ids: contextIds(ids) },
    });
    return readModel(this.json(resp), MEMBER_CONTEXT_ACCESS_UPDATE, "WorkspaceClient.set_member_context_access") as unknown as MemberContextAccessUpdate;
  }

  /** Requires a signed-in web session. On Node, provide a fetch that carries the session cookie. */
  async addContextMember(
    contextId: string, userId: string, role: "owner" | "editor" | "viewer",
    options: { extendAccessList?: boolean } = {},
  ): Promise<ContextMember> {
    const id = normalizeUuid(contextId, "contextId");
    userIdSegment(userId);
    const resp = await this.request("POST", `/api/v1/contexts/${id}/members`, {
      session: true,
      json: {
        user_id: userId, role,
        ...(options.extendAccessList === undefined ? {} : { extend_access_list: options.extendAccessList }),
      },
    });
    return readModel(this.json(resp), CONTEXT_MEMBER, "WorkspaceClient.add_context_member") as unknown as ContextMember;
  }

  // -------------------------------------------------------------------
  // Operation history (memory-cloud v0.154.0+, #136)
  // -------------------------------------------------------------------

  /**
   * Read one page of the workspace's operation history, newest first:
   * `GET /api/v1/workspaces/{workspaceId}/operation-history`
   * (memory-cloud v0.154.0+).
   *
   * **Web session only.** Build the client with
   * `new WorkspaceClient({ baseUrl, session: true, fetch })`; on Node the
   * fetch must carry the signed-in user's session cookie. The server
   * refuses every API key, OAuth token and resource token on this route,
   * so a client built with one throws before any request is made, and
   * never falls back to another credential.
   *
   * The caller must be an owner or admin of the workspace, and the
   * workspace's plan must include `operation_history` (Pro and Max).
   * History is recorded from server v0.154.0 on, with no backfill, and is
   * kept for `retention_days` (90 days plus any add-on). It holds who
   * changed what — ids, operation, outcome, count and changed-field names
   * — never contents or before/after values; reads and searches are not
   * recorded, and it is not a full audit ledger. A private context's
   * history is shown only to its creator. A shared credential identifies
   * the credential and its account, not the person who used it.
   *
   * Refused locally, with an `Error` and before any request, as the server
   * would refuse them: a `workspaceId`, `contextId` or `agentId` that is no
   * UUID; a `limit` that is no integer in 1-100; a `query` over 120,
   * `actor` over 255, `operation` over 40 or `cursor` over 512 characters
   * (code points); a `since` / `until` string without a timezone offset,
   * an invalid `Date`, or `since` after `until`. `cursor` is sent as given.
   *
   * @throws Error when the client was not built with `session: true`, or an
   *   option is refused, before any request.
   * @throws KaguraAuthError when the session is missing or expired (401).
   * @throws KaguraPermissionError when the caller is not a workspace owner
   *   or admin (403), with `requiredRole` when the server names one.
   * @throws KaguraFeatureNotAvailableError when the workspace's plan lacks
   *   `operation_history` (403 `FEAT-001`).
   * @throws KaguraNotFoundError for a workspace that is not found (404).
   * @throws KaguraConnectionError for a 422 the server answers (an unknown
   *   `operation`, a malformed `cursor`), keeping its `code` and `details`,
   *   or a transport failure.
   * @throws KaguraResponseError when the reply is not an operation-history
   *   page (`operation` `"WorkspaceClient.list_operation_history"`).
   */
  async listOperationHistory(
    workspaceId: string,
    options: ListOperationHistoryOptions = {},
  ): Promise<OperationHistoryPage> {
    if (!this.sessionMode) {
      throw new Error(SESSION_ONLY_HISTORY);
    }
    const ws = normalizeWorkspaceId(workspaceId);
    const params: Record<string, string | number> = {};
    if (isSet(options.query)) params.query = boundedText(options.query, "query", HISTORY_QUERY_MAX);
    if (isSet(options.contextId)) params.context_id = normalizeUuid(options.contextId, "contextId");
    if (isSet(options.actor)) params.actor = boundedText(options.actor, "actor", HISTORY_ACTOR_MAX);
    if (isSet(options.agentId)) params.agent_id = normalizeUuid(options.agentId, "agentId");
    if (isSet(options.operation)) params.operation = boundedText(options.operation, "operation", HISTORY_OPERATION_MAX);
    if (isSet(options.targetType)) params.target_type = requireString(options.targetType, "targetType");
    if (isSet(options.outcome)) params.outcome = requireString(options.outcome, "outcome");
    const since = isSet(options.since) ? historyTime(options.since, "since") : null;
    const until = isSet(options.until) ? historyTime(options.until, "until") : null;
    if (since !== null && until !== null && since.micros > until.micros) {
      throw new Error(`since must not be after until, got since=${since.text} and until=${until.text}`);
    }
    if (since !== null) params.since = since.text;
    if (until !== null) params.until = until.text;
    if (isSet(options.limit)) params.limit = historyLimit(options.limit);
    if (isSet(options.cursor)) params.cursor = boundedText(options.cursor, "cursor", HISTORY_CURSOR_MAX);

    const resp = await this.request("GET", `/api/v1/workspaces/${ws}/operation-history`, {
      session: true,
      typedPermissionErrors: true,
      params,
    });
    const body = this.json(resp);
    readModel(body, OPERATION_HISTORY_PAGE, "WorkspaceClient.list_operation_history");
    // Returned as sent once the model accepts it, unknown keys kept, with
    // the one default the model fills.
    const page = body as Record<string, unknown>;
    return (page.total_capped === undefined ? { ...page, total_capped: false } : page) as unknown as OperationHistoryPage;
  }

  /** Change a member's role (member/admin/viewer only). */
  async updateMemberRole(
    workspaceId: string,
    userId: string,
    role: string,
  ): Promise<WorkspaceMemberResult> {
    const ws = normalizeWorkspaceId(workspaceId);
    this.validateRole(role);
    const resp = await this.request("PUT", memberPath(ws, userId), { json: { role } });
    return this.readMember(this.json(resp), "WorkspaceClient.update_member_role");
  }

  /** Remove a member from the workspace (server returns 204). */
  async removeMember(workspaceId: string, userId: string): Promise<void> {
    const ws = normalizeWorkspaceId(workspaceId);
    await this.request("DELETE", memberPath(ws, userId));
  }

  // -------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------

  /**
   * Invite a not-yet-registered user by email.
   *
   * The returned invitation carries `token`/`invitation_url` — the only
   * response that ever exposes them to programmatic callers; treat them
   * as join credentials.
   *
   * @param workspaceId Target workspace UUID.
   * @param email Invitee email (must match their Google account).
   * @param options Role, context grant, and expiry preset.
   */
  async createInvitation(
    workspaceId: string,
    email: string,
    options: CreateInvitationOptions = {},
  ): Promise<WorkspaceInvitation> {
    const ws = normalizeWorkspaceId(workspaceId);
    const role = options.role ?? "member";
    this.validateRole(role);
    const { allowedContextIds, expiresInDays } = options;
    if (
      (role === "member" || role === "viewer") &&
      (allowedContextIds === undefined || allowedContextIds.length === 0)
    ) {
      throw new Error(
        "allowedContextIds is required (min 1) for member/viewer " +
          "invitations — the server rejects them without a context grant.",
      );
    }
    if (
      expiresInDays !== undefined &&
      !(VALID_INVITE_EXPIRES as readonly number[]).includes(expiresInDays)
    ) {
      throw new Error(
        `expiresInDays must be one of ${VALID_INVITE_EXPIRES.join(", ")} ` +
          "or omitted (server-side preset list).",
      );
    }
    const body: Record<string, unknown> = { email, role };
    if (allowedContextIds !== undefined) {
      // Port of create_invitation's normalize_uuid (python-sdk #285): the
      // server answers a non-UUID here with an HTTP 500.
      body.allowed_context_ids = allowedContextIds.map((c) => normalizeUuid(c, "allowedContextIds"));
    }
    if (expiresInDays !== undefined) {
      body.expires_in_days = expiresInDays;
    }
    const resp = await this.request("POST", `/api/v1/workspaces/${ws}/invitations`, {
      json: body,
    });
    return readWorkspaceRow(this.json(resp), WORKSPACE_INVITATION, "WorkspaceClient.create_invitation") as unknown as WorkspaceInvitation;
  }

  /**
   * List invitations. `token`/`invitation_url` arrive as null for
   * programmatic callers (server-side token hygiene, #1164).
   */
  async listInvitations(
    workspaceId: string,
    options: ListInvitationsOptions = {},
  ): Promise<WorkspaceInvitation[]> {
    const ws = normalizeWorkspaceId(workspaceId);
    const resp = await this.request(
      "GET",
      `/api/v1/workspaces/${ws}/invitations`,
      options.includeAccepted ? { params: { include_accepted: "true" } } : {},
    );
    return this.expectRows(resp, "list_invitations").map((row) =>
      readWorkspaceRow(row, WORKSPACE_INVITATION, "WorkspaceClient.list_invitations") as unknown as WorkspaceInvitation,
    );
  }

  /**
   * Revoke a pending invitation (server returns 200 `{"success": true}`).
   *
   * @param invitationId The invitation's id: an integer on servers before
   *   memory-cloud v0.89.0, an opaque `winv_…` string from v0.89.0 on.
   *   Pass a `bigint` for an integer past `Number.MAX_SAFE_INTEGER`: a
   *   `number` that large may already be rounded to a different id, and is
   *   refused, as is an empty string.
   */
  async revokeInvitation(workspaceId: string, invitationId: number | bigint | string): Promise<void> {
    const ws = normalizeWorkspaceId(workspaceId);
    await this.request(
      "DELETE",
      `/api/v1/workspaces/${ws}/invitations/${requirePublicId(invitationId, "invitationId")}`,
    );
  }

  // -------------------------------------------------------------------
  // Member API keys (#201, memory-cloud#1165)
  // -------------------------------------------------------------------

  /**
   * Mint an API key for ANOTHER member (owner key required).
   *
   * Privilege-downgrade provisioning only: the server 403s self-targets
   * ("An owner key cannot mint keys for itself") and owner/admin targets
   * — mint for member/viewer service identities. `expiresDays` is
   * required by the server for owner-provisioned mints (never-expiring
   * CI keys are not allowed). The returned `plaintext_key` is shown
   * exactly once — owner-provisioned keys are force-hidden at creation,
   * so no later call returns it.
   *
   * The response is read as the Python SDK's `MemberAPIKey` model reads
   * it, leniently as pydantic does: the key comes back with the model's
   * fields only, its `id` an `akey_…` string from memory-cloud v0.89.0 on
   * and an integer before. A response that model refuses throws a
   * `KaguraError` carrying the plaintext when there is one.
   */
  async mintMemberKey(
    workspaceId: string,
    userId: string,
    name: string,
    expiresDays: number,
  ): Promise<MemberAPIKey> {
    const ws = normalizeWorkspaceId(workspaceId);
    const days = requireInt(expiresDays, "expiresDays");
    if (days < 1 || days > 3650) {
      throw new Error(`expiresDays must be 1-3650, got ${JSON.stringify(days)}`);
    }
    const resp = await this.request("POST", `${memberPath(ws, userId)}/credentials/api-keys`, {
      json: { name, expires_days: days },
    });
    const payload = this.json(resp);
    const operation = "WorkspaceClient.mint_member_key";
    try {
      // As `MemberAPIKey.model_validate` reads it: lax, so `"false"` is
      // false and an `akey_…` id stays the string, and whole, so a
      // `plaintext_key` that is no string is refused.
      return readMemberKey(payload, operation);
    } catch (e) {
      if (!(e instanceof KaguraResponseError)) throw e;
    }
    // The key already exists server-side and is force-hidden — a shape
    // mismatch must not swallow the ONE chance to see the plaintext. The
    // Python SDK's words, which the CLI prints; the class stays the one
    // this method has always thrown.
    const plaintext =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).plaintext_key
        : undefined;
    if (typeof plaintext === "string" && plaintext) {
      throw new KaguraError(
        `${operation}: server returned an unexpected mint response shape, but the ` +
          `key WAS created. Save the plaintext now: ${plaintext}`,
      );
    }
    throw new KaguraError(
      `${operation}: server returned an unexpected mint response shape; the key may ` +
        "have been created without displaying its plaintext — check " +
        "`kagura auth list-keys` and revoke/re-mint if present.",
    );
  }

  /**
   * List a member's API keys — metadata only.
   *
   * The server wraps the rows in a `MemberCredentialsResponse` envelope
   * (`api_keys` + `target_user_role`) and always nulls `plaintext_key`
   * for programmatic callers.
   */
  async listMemberKeys(workspaceId: string, userId: string): Promise<MemberAPIKey[]> {
    const ws = normalizeWorkspaceId(workspaceId);
    const resp = await this.request("GET", `${memberPath(ws, userId)}/credentials`);
    const payload = this.json(resp);
    const rows =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).api_keys
        : undefined;
    if (!Array.isArray(rows)) {
      // Guard the FIELD, not just the envelope: api_keys=null would
      // produce garbage rows and api_keys={} is not iterable as rows
      // (Copilot review, PR #228 on the Python port).
      throw this.shapeError(
        "list_member_keys",
        `${resp.method} ${resp.path}: expected an object carrying a 'api_keys' array`,
      );
    }
    return rows.map((row) => readMemberKey(row, "WorkspaceClient.list_member_keys"));
  }

  /**
   * Revoke a member's API key.
   *
   * Owner-provisioned revocations are SOFT server-side (`revoked_at`
   * set, row retained for forensics); success is 200 with a status body,
   * and an already-revoked key surfaces as a uniform 404.
   *
   * @param keyId The key's id: an integer on servers before memory-cloud
   *   v0.89.0, an opaque `akey_…` string from v0.89.0 on. Pass a `bigint`
   *   for an integer past `Number.MAX_SAFE_INTEGER`: a `number` that large
   *   may already be rounded to a different id, and is refused, as is an
   *   empty string.
   */
  async revokeMemberKey(
    workspaceId: string,
    userId: string,
    keyId: number | bigint | string,
  ): Promise<void> {
    const ws = normalizeWorkspaceId(workspaceId);
    await this.request(
      "DELETE",
      `${memberPath(ws, userId)}/credentials/api-keys/${requirePublicId(keyId, "keyId")}`,
    );
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  /**
   * A mis-shaped envelope, in the Python SDK's words, which the CLI prints
   * (`WorkspaceClient.list_members: unexpected server response (GET …:
   * expected a JSON array, got dict). …`). A `KaguraConnectionError`
   * still, the class these methods have always thrown; Python's is a
   * `KaguraResponseError`.
   */
  private shapeError(method: string, problem: string): KaguraConnectionError {
    return new KaguraConnectionError(responseShapeError(`WorkspaceClient.${method}`, problem).message);
  }

  /** `expectList`, failing in {@link shapeError}'s words (Python's `_expect_list`). */
  private expectRows(response: RestResponse, method: string): unknown[] {
    const payload = this.json(response);
    if (!Array.isArray(payload)) {
      throw this.shapeError(
        method,
        `${response.method} ${response.path}: expected a JSON array, got ${pyTypeName(payload)}`,
      );
    }
    return payload;
  }

  private validateRole(role: string): void {
    if (!(VALID_ASSIGNABLE_ROLES as readonly string[]).includes(role)) {
      throw new Error(
        `role must be one of ${VALID_ASSIGNABLE_ROLES.join(", ")}, got ` +
          `${JSON.stringify(role)}. Assigning 'owner' is not supported ` +
          "programmatically — the server directs owner changes to the " +
          "ownership transfer flow.",
      );
    }
  }

  /**
   * Build the 403 message, appending the owner-key hint only when useful.
   *
   * v0.42.0 sends purpose-built 403 messages on this surface (OAuth
   * rejection, deployment kill-switch, plan gate, self-role-change,
   * key/workspace mismatch) — those pass through untouched. Only the
   * deliberately uniform denial gets the owner-key hint, because that is
   * the one a non-owner static key actually hits. A `FEAT-001` plan gate
   * never gets here (it becomes a {@link KaguraFeatureNotAvailableError}); a pre-v0.75
   * `HTTP-403` one does, and passes through as text.
   */
  private format403(serverDetail: string): string {
    const safeDetail = sanitizeServerDetail(serverDetail);
    if (safeDetail && safeDetail !== UNIFORM_403) {
      return safeDetail;
    }
    const parts = [
      "Access denied (HTTP 403): workspace member/invitation/credential " +
        "management requires the workspace OWNER's API key when called " +
        "programmatically (OAuth tokens are not accepted).",
    ];
    if (this.authSource !== null) {
      let hint = `credential source: ${SOURCE_LABEL[this.authSource]}`;
      if (this.workspaceIdHint) {
        hint += ` (workspace=${this.workspaceIdHint.slice(0, 8)}…)`;
      }
      parts.push(hint + " — is this key the workspace owner's?");
    }
    return parts.join(" ");
  }

  // ---- KaguraRestClient hooks -----------------------------------------

  protected override error401(response: RestResponse): KaguraError {
    if (response.session === true) {
      return new KaguraAuthError(
        response.path.endsWith("/operation-history")
          ? "A signed-in session is required to read workspace operation history."
          : "A signed-in session is required to add a context member.",
      );
    }
    return super.error401(response);
  }

  protected override genericError(response: RestResponse): KaguraError {
    const body = this.errorBody(response);
    if (response.session && response.status === 409 && body.envelope?.code === "RES-002" &&
        body.envelope.details.reason === "context_not_in_access_list") {
      return new KaguraContextNotInAccessListError(sanitizeServerDetail(body.detail) ?? "Context is outside the member's access list");
    }
    return super.genericError(response);
  }

  protected override error403(response: RestResponse, context: RequestContext): KaguraError {
    // A plan or quota refusal is not an ownership problem: type it rather
    // than pass it through as a connection error.
    const gated = this.gateRefusal(response);
    if (gated !== null) return gated;
    const body = this.errorBody(response);
    const requiredRole = body.fields?.[1].required_role;
    if (context.typedPermissionErrors || response.session) {
      return new KaguraPermissionError(
        sanitizeServerDetail(body.detail) ?? "Insufficient permissions",
        typeof requiredRole === "string" ? requiredRole : null,
      );
    }
    return new KaguraConnectionError(this.format403(body.detail));
  }

  protected override error429(response: RestResponse): KaguraError {
    // Invite-create quota exhaustion ("Member limit reached ...") and
    // generic rate limiting both surface as 429 — keep the server
    // message, it names the cause and the fix. From v0.75.0 the seat cap
    // is a typed `QUOTA-001` (`quota_type: "members"`) and carries its
    // counts too. A body that reads as a plan refusal is still a quota
    // here: a 429 has always been one.
    const gated = this.gateRefusal(response);
    if (gated instanceof KaguraQuotaError) {
      return gated;
    }
    const body = this.errorBody(response);
    return new KaguraQuotaError(
      sanitizeServerDetail(body.detail) ?? "Quota exceeded. Try again later.",
      responseRetryAfter(response.headers, body),
    );
  }
}
