/** Custom errors for the Kagura Memory SDK (port of exceptions.py). */

import type { RollbackSummary } from "./models.js";

/**
 * Subset of the standard DOM/Node `ErrorOptions`. Declared locally so the
 * published `.d.ts` does not force consumers onto an ES2022 `lib` just to
 * reference our error constructors.
 */
export interface KaguraErrorOptions {
  cause?: unknown;
}

/**
 * The machine-readable block the server attaches to a plan or quota
 * refusal: top-level fields of an MCP error envelope, `details` of a REST
 * one. Every field is optional because only memory-cloud v0.75.0+ sends
 * the full block; older servers send some of it or none.
 */
export interface KaguraGateOptions extends KaguraErrorOptions {
  /**
   * Why the call was refused: `"plan"`, `"quota"`, `"allowlist"` (a
   * rollout switch) or `"deployment"` (the operator turned it off).
   * Absent before server v0.75.0.
   */
  gate?: string | null;
  /** Feature registry key, e.g. `"resources"` or `"team_invitations"`. */
  feature?: string | null;
  /** Plan key that lifts the refusal; `null` when no tier does. */
  requiredPlan?: string | null;
  /** Display label of `requiredPlan` (e.g. `"XL"`) — the one to show a user. */
  requiredPlanDisplay?: string | null;
  /** The workspace's current plan key. */
  currentPlan?: string | null;
}

/** {@link KaguraGateOptions} plus the counts a quota refusal carries. */
export interface KaguraQuotaErrorOptions extends KaguraGateOptions {
  /** Which cap, e.g. `"memories_per_day"`, `"resource_tokens"`, `"members"`. */
  quotaType?: string | null;
  /** Count already used. */
  current?: number | null;
  /** The cap that was hit. */
  limit?: number | null;
  /** Legacy daily count some refusals still send beside `current`. */
  usedToday?: number | null;
  /** ISO-8601 instant a time-windowed quota resets at. */
  resetsAt?: string | null;
}

/** Whole seconds until `iso`, never negative; `null` if it does not parse. */
function secondsUntil(iso: string | null): number | null {
  if (iso === null) {
    return null;
  }
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return null;
  }
  // Round up: retrying after a floored wait would land just before the reset.
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * Return `String(e)` when non-empty, otherwise the constructor name.
 *
 * Defensive fallback so an unmessaged error still produces a non-empty
 * diagnostic when interpolated into a user-facing error string.
 */
export function excMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message || e.constructor.name;
  }
  const s = String(e);
  return s || (typeof e === "object" && e !== null ? e.constructor.name : "unknown error");
}

/** Base error for the Kagura SDK. */
export class KaguraError extends Error {
  constructor(message: string, options?: KaguraErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Authentication failed. */
export class KaguraAuthError extends KaguraError {}

/**
 * OAuth refresh token expired or invalid.
 *
 * Raised when an attempted refresh returns `invalid_grant` (or the server
 * otherwise indicates that the stored refresh token can no longer be used).
 * The caller must re-authenticate via `kagura auth login`.
 */
export class KaguraAuthExpiredError extends KaguraAuthError {
  readonly expiresAt: Date | null;

  constructor(message: string, expiresAt: Date | null = null, options?: KaguraErrorOptions) {
    super(message, options);
    this.expiresAt = expiresAt;
  }
}

/** User denied authorization at the device-flow consent screen. */
export class KaguraAuthDeniedError extends KaguraAuthError {}

/** Connection to Kagura server failed. */
export class KaguraConnectionError extends KaguraError {}

/** Requested resource not found (HTTP 404). */
export class KaguraNotFoundError extends KaguraError {}

/**
 * Rate limit exceeded: an HTTP 429 on `KaguraClient`'s own transport.
 *
 * That covers the per-minute rate limit and the daily call quotas alike,
 * and the class is the same for both, so existing handlers keep catching
 * it. From server v0.75.0 a daily quota carries the gate payload a
 * {@link KaguraQuotaError} does (`quotaType: "api_mcp_daily"` or
 * `"api_rest_daily"`); on a per-minute limit every one of those fields is
 * `null`.
 */
export class KaguraRateLimitError extends KaguraError {
  readonly retryAfter: number | null;
  readonly gate: string | null;
  readonly quotaType: string | null;
  readonly current: number | null;
  readonly limit: number | null;
  readonly usedToday: number | null;
  readonly resetsAt: string | null;
  readonly feature: string | null;
  readonly requiredPlan: string | null;
  readonly requiredPlanDisplay: string | null;
  readonly currentPlan: string | null;

  constructor(
    message: string,
    retryAfter: number | null = null,
    options: KaguraQuotaErrorOptions = {},
  ) {
    super(message, options);
    this.gate = options.gate ?? null;
    this.quotaType = options.quotaType ?? null;
    this.usedToday = options.usedToday ?? null;
    this.current = options.current ?? this.usedToday;
    this.limit = options.limit ?? null;
    this.resetsAt = options.resetsAt ?? null;
    this.feature = options.feature ?? null;
    this.requiredPlan = options.requiredPlan ?? null;
    this.requiredPlanDisplay = options.requiredPlanDisplay ?? null;
    this.currentPlan = options.currentPlan ?? null;
    this.retryAfter = retryAfter ?? secondsUntil(this.resetsAt);
  }
}

/** LLM call failed. */
export class KaguraLLMError extends KaguraError {}

/** Context not found or invalid. */
export class KaguraContextError extends KaguraError {}

/**
 * A quota or cap was reached.
 *
 * Raised for a REST client's 429s (the resource-token events-per-hour
 * quota among them; `SecretClient` keeps 429 generic, and `KaguraClient`'s
 * own transport raises {@link KaguraRateLimitError}), for the SDK's own
 * context-limit pre-check, and for every typed quota refusal: MCP
 * `quota_exceeded` and REST `QUOTA-001` / `QUOTA-002` / `CONNECTOR-001`,
 * including the resource-token cap, which answers 403 rather than 429.
 *
 * The gate fields are `null` unless the server sent them. `gate` is
 * `"quota"` on every typed cap, whether or not a higher tier raises it:
 * an upgrade helps only when `requiredPlan` is non-null. An untyped
 * limit, such as the 1 MB memory-size guard, arrives with no gate.
 * `retryAfter` is the `Retry-After` header when there was one, else it is
 * derived from `resetsAt` on a time-windowed quota such as
 * `memories_per_day`; a fixed cap has neither, because waiting will not
 * lift it.
 */
export class KaguraQuotaError extends KaguraError {
  readonly retryAfter: number | null;
  readonly gate: string | null;
  readonly quotaType: string | null;
  /**
   * Count already used. Falls back to `usedToday` for servers older than
   * v0.75.0, which sent only the legacy name.
   */
  readonly current: number | null;
  readonly limit: number | null;
  readonly usedToday: number | null;
  readonly resetsAt: string | null;
  readonly feature: string | null;
  readonly requiredPlan: string | null;
  readonly requiredPlanDisplay: string | null;
  readonly currentPlan: string | null;

  constructor(
    message: string,
    retryAfter: number | null = null,
    options: KaguraQuotaErrorOptions = {},
  ) {
    super(message, options);
    this.gate = options.gate ?? null;
    this.quotaType = options.quotaType ?? null;
    this.usedToday = options.usedToday ?? null;
    this.current = options.current ?? this.usedToday;
    this.limit = options.limit ?? null;
    this.resetsAt = options.resetsAt ?? null;
    this.feature = options.feature ?? null;
    this.requiredPlan = options.requiredPlan ?? null;
    this.requiredPlanDisplay = options.requiredPlanDisplay ?? null;
    this.currentPlan = options.currentPlan ?? null;
    this.retryAfter = retryAfter ?? secondsUntil(this.resetsAt);
  }
}

/**
 * The workspace may not use a feature — its plan lacks it, or it is
 * switched off.
 *
 * Raised for MCP `plan_required` (`setupResource`, `updateContext` with
 * `isPublic: true`, and from server v0.75.0 a shared `createContext`) and
 * `feature_not_available`, and for a REST 403 `FEAT-001` such as
 * `ResourceClient.createToken` or a public-bound
 * `WorkspaceClient.mintMemberKey`.
 *
 * Show `requiredPlanDisplay`; decide with `requiredPlan`. Both are `null`
 * when no tier lifts the refusal, and a v0.75.0+ server says why in
 * `gate`: `"allowlist"` or `"deployment"` mean an upgrade will not help.
 */
export class KaguraPlanError extends KaguraError {
  readonly gate: string | null;
  readonly feature: string | null;
  readonly requiredPlan: string | null;
  readonly requiredPlanDisplay: string | null;
  readonly currentPlan: string | null;

  constructor(message: string, options: KaguraGateOptions = {}) {
    super(message, options);
    this.gate = options.gate ?? null;
    this.feature = options.feature ?? null;
    this.requiredPlan = options.requiredPlan ?? null;
    this.requiredPlanDisplay = options.requiredPlanDisplay ?? null;
    this.currentPlan = options.currentPlan ?? null;
  }
}

/**
 * `rollbackSleepRun` reversed some of a run's actions but not all.
 *
 * The server commits each step, so what was reversed stays reversed, and
 * the report is marked `failed`. `summary` is the same
 * {@link RollbackSummary} a clean rollback returns: its counts say what
 * was undone, and `summary.errors` names each action that was not.
 */
export class KaguraPartialRollbackError extends KaguraError {
  readonly reportId: string | null;
  readonly summary: RollbackSummary;

  constructor(
    message: string,
    reportId: string | null = null,
    summary: RollbackSummary = {},
    options?: KaguraErrorOptions,
  ) {
    super(message, options);
    this.reportId = reportId;
    this.summary = summary;
  }
}

/**
 * The caller's role does not allow the operation (MCP `permission_denied`).
 *
 * `requiredRole` is the server's own wording — a role such as `"editor"`
 * or a phrase such as `"owner or admin"` — so display it rather than
 * compare it.
 */
export class KaguraPermissionError extends KaguraError {
  readonly requiredRole: string | null;

  constructor(message: string, requiredRole: string | null = null, options?: KaguraErrorOptions) {
    super(message, options);
    this.requiredRole = requiredRole;
  }
}

/**
 * Object store rejected an upload with HTTP 400.
 *
 * Raised for any HTTP 400 response from the object store on a presigned
 * PUT — most commonly R2 `BadDigest` (the body's sha256 did not match the
 * value bound into the presigned PUT URL), but also covers other 400
 * causes such as a malformed presigned URL or a Content-Length mismatch.
 */
export class KaguraIntegrityError extends KaguraError {}

/**
 * URL or file fetch failed (SSRF guard, byte cap, redirect loop, etc.).
 *
 * The original URL/path is exposed via the `url` property so callers can
 * present it without re-parsing the message.
 */
export class KaguraFetchError extends KaguraError {
  readonly url: string | null;

  constructor(message: string, url: string | null = null, options?: KaguraErrorOptions) {
    super(message, options);
    this.url = url;
  }
}

/** File ingestion orchestration failed for a non-fetch reason. */
export class KaguraIngestError extends KaguraError {}

/**
 * Secret-store operation failed for a non-HTTP reason (#28).
 *
 * The base of the secret hierarchy: a client-side contract violation, such
 * as putting a secret with no recipients or with a recipient whose
 * advertised fingerprint does not match its pubkey.
 */
export class KaguraSecretError extends KaguraError {}

/**
 * age encryption/decryption failed, or its input was malformed.
 *
 * Also raised when the optional `age-encryption` peer dependency is not
 * installed — the message names the install command, since the base SDK
 * deliberately ships with no runtime dependencies.
 */
export class KaguraCryptoError extends KaguraSecretError {}

/**
 * The age private key could not be stored or retrieved.
 *
 * Custody is fail-closed: refusing to hold the key is an error, never a
 * silent fallback to a less secure location.
 */
export class KaguraKeyCustodyError extends KaguraSecretError {}
