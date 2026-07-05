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
 * detail-carrying 429 quota mapping.
 */

import { SOURCE_LABEL } from "./auth/types.js";
import { KaguraConnectionError, KaguraError, KaguraQuotaError } from "./errors.js";
import { extractDetail, retryAfterSeconds, sanitizeServerDetail } from "./http.js";
import type { MemberAPIKey, WorkspaceInvitation, WorkspaceMember } from "./models.js";
import { KaguraRestClient } from "./restBase.js";
import type { RequestContext, RestResponse } from "./restBase.js";

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

const UUID_HEX_RE = /^[0-9a-f]{32}$/i;

/**
 * Return the canonical UUID string, rejecting non-UUIDs before the URL.
 *
 * Python's `uuid.UUID` tolerates non-canonical spellings (`{braces}`,
 * `urn:uuid:` prefix, dashless 32-hex, uppercase); interpolating the RAW
 * input would send those to the server and surface as a misleading uniform
 * 404 — normalize instead of just validating.
 */
function normalizeWorkspaceId(workspaceId: string): string {
  const stripped = String(workspaceId)
    .replace(/^urn:/, "")
    .replace(/^uuid:/, "")
    .replace(/^[{}]+|[{}]+$/g, "")
    .replace(/-/g, "");
  if (!UUID_HEX_RE.test(stripped)) {
    throw new Error(`workspaceId must be a UUID, got ${JSON.stringify(workspaceId)}`);
  }
  const hex = stripped.toLowerCase();
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/**
 * Strictly require an integer — no float truncation, no string parse.
 *
 * Truncating `7.9` would silently target a DIFFERENT resource id on a
 * destructive endpoint (the TS signature says `number`, which admits
 * floats), so fail loudly instead.
 */
function requireInt(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Options for {@link WorkspaceClient.createInvitation}. */
export interface CreateInvitationOptions {
  /** `member` | `admin` | `viewer` (default: `"member"`). */
  role?: string;
  /**
   * Context grant — required (min 1) for member/viewer invitations,
   * ignored for admin. Sent on the wire as `allowed_context_ids`.
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

/**
 * REST API client for workspace member / invitation management.
 *
 * Requires the workspace OWNER's API key when called programmatically
 * (memory-cloud v0.42.0+). OAuth profiles are rejected by the server on
 * this surface — resolve a static owner key (`KAGURA_API_KEY` env or
 * `.kagura.json`) instead.
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
 * - `KaguraQuotaError` — member quota or rate limit exceeded (429)
 */
export class WorkspaceClient extends KaguraRestClient {
  // -------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------

  /**
   * List workspace members (owner key required).
   *
   * Rows are ordered owner→viewer then by join date and include
   * `user_name`/`user_email` when the member has logged in.
   */
  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const ws = normalizeWorkspaceId(workspaceId);
    const resp = await this.request("GET", `/api/v1/workspaces/${ws}/members`);
    return this.expectList(resp) as unknown as WorkspaceMember[];
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
  async addMember(workspaceId: string, userId: string, role = "member"): Promise<WorkspaceMember> {
    const ws = normalizeWorkspaceId(workspaceId);
    this.validateRole(role);
    const resp = await this.request("POST", `/api/v1/workspaces/${ws}/members`, {
      json: { user_id: userId, role },
    });
    return this.json(resp) as unknown as WorkspaceMember;
  }

  /** Change a member's role (member/admin/viewer only). */
  async updateMemberRole(
    workspaceId: string,
    userId: string,
    role: string,
  ): Promise<WorkspaceMember> {
    const ws = normalizeWorkspaceId(workspaceId);
    this.validateRole(role);
    const resp = await this.request(
      "PUT",
      `/api/v1/workspaces/${ws}/members/${encodeURIComponent(userId)}`,
      { json: { role } },
    );
    return this.json(resp) as unknown as WorkspaceMember;
  }

  /** Remove a member from the workspace (server returns 204). */
  async removeMember(workspaceId: string, userId: string): Promise<void> {
    const ws = normalizeWorkspaceId(workspaceId);
    await this.request("DELETE", `/api/v1/workspaces/${ws}/members/${encodeURIComponent(userId)}`);
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
      body.allowed_context_ids = allowedContextIds;
    }
    if (expiresInDays !== undefined) {
      body.expires_in_days = expiresInDays;
    }
    const resp = await this.request("POST", `/api/v1/workspaces/${ws}/invitations`, {
      json: body,
    });
    return this.json(resp) as unknown as WorkspaceInvitation;
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
    return this.expectList(resp) as unknown as WorkspaceInvitation[];
  }

  /** Revoke a pending invitation (server returns 200 `{"success": true}`). */
  async revokeInvitation(workspaceId: string, invitationId: number): Promise<void> {
    const ws = normalizeWorkspaceId(workspaceId);
    await this.request(
      "DELETE",
      `/api/v1/workspaces/${ws}/invitations/${requireInt(invitationId, "invitationId")}`,
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
    const resp = await this.request(
      "POST",
      `/api/v1/workspaces/${ws}/members/${encodeURIComponent(userId)}/credentials/api-keys`,
      { json: { name, expires_days: days } },
    );
    const payload = this.json(resp);
    if (isMintShape(payload)) {
      return payload as unknown as MemberAPIKey;
    }
    // The key already exists server-side and is force-hidden — a shape
    // mismatch must not swallow the ONE chance to see the plaintext.
    const plaintext =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).plaintext_key
        : undefined;
    if (typeof plaintext === "string" && plaintext) {
      throw new KaguraError(
        "Server returned an unexpected mint response shape, but the " +
          `key WAS created. Save the plaintext now: ${plaintext}`,
      );
    }
    throw new KaguraError(
      "Server returned an unexpected mint response shape; the key may " +
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
    const resp = await this.request(
      "GET",
      `/api/v1/workspaces/${ws}/members/${encodeURIComponent(userId)}/credentials`,
    );
    const payload = this.json(resp);
    const rows =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).api_keys
        : undefined;
    if (!Array.isArray(rows)) {
      // Guard the FIELD, not just the envelope: api_keys=null would
      // produce garbage rows and api_keys={} is not iterable as rows
      // (Copilot review, PR #228 on the Python port).
      throw new KaguraConnectionError(
        "Unexpected response shape from the member-credentials endpoint " +
          "(expected an object carrying an 'api_keys' array).",
      );
    }
    return rows as unknown as MemberAPIKey[];
  }

  /**
   * Revoke a member's API key.
   *
   * Owner-provisioned revocations are SOFT server-side (`revoked_at`
   * set, row retained for forensics); success is 200 with a status body,
   * and an already-revoked key surfaces as a uniform 404.
   */
  async revokeMemberKey(workspaceId: string, userId: string, keyId: number): Promise<void> {
    const ws = normalizeWorkspaceId(workspaceId);
    await this.request(
      "DELETE",
      `/api/v1/workspaces/${ws}/members/${encodeURIComponent(userId)}` +
        `/credentials/api-keys/${requireInt(keyId, "keyId")}`,
    );
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

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
   * the one a non-owner static key actually hits.
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

  protected override error403(response: RestResponse, _context: RequestContext): KaguraError {
    return new KaguraConnectionError(this.format403(extractDetail(response.text)));
  }

  protected override error429(response: RestResponse): KaguraError {
    // Invite-create quota exhaustion ("Member limit reached ...") and
    // generic rate limiting both surface as 429 — keep the server
    // message, it names the cause and the fix.
    return new KaguraQuotaError(
      extractDetail(response.text) || "Quota exceeded. Try again later.",
      retryAfterSeconds(response.headers),
    );
  }
}

/**
 * Minimal structural check standing in for pydantic's required-field
 * validation on the mint response — the fields `MemberAPIKey` requires.
 * Everything else is trusted per the SDK's no-runtime-validation policy;
 * this one endpoint gets a guard because a mis-shaped 201 would otherwise
 * silently discard the only copy of the plaintext key.
 */
function isMintShape(payload: unknown): payload is Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  const rec = payload as Record<string, unknown>;
  return (
    typeof rec.id === "number" && typeof rec.name === "string" && typeof rec.key_prefix === "string"
  );
}
