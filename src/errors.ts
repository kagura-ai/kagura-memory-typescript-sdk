/** Custom errors for the Kagura Memory SDK (port of exceptions.py). */

import type { RollbackSummary, SessionRollbackSummary } from "./models.js";

/**
 * Subset of the standard DOM/Node `ErrorOptions`. Declared locally so the
 * published `.d.ts` does not force consumers onto an ES2022 `lib` just to
 * reference our error constructors.
 */
export interface KaguraErrorOptions {
  cause?: unknown;
  /**
   * The server's error code, kept as {@link KaguraError.code}: the MCP
   * envelope's `error`, the REST body's `error` or the OAuth `error`.
   */
  code?: string;
  /**
   * The other fields the server sent with the error, kept as
   * {@link KaguraError.details}.
   */
  details?: Record<string, unknown> | null;
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

/**
 * {@link KaguraGateOptions} plus the counts a quota refusal carries.
 *
 * `current` and `limit` are the canonical names memory-cloud v0.75.0
 * added. When the SDK builds these from an older server's refusal, it
 * reads each cap's legacy names instead: `used_today` / `limit_today`,
 * `owned_count` / `cap`, `active_connectors` / `max_connectors`.
 */
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

/** `details[key]` when it is a string, else `null`. */
function strDetail(details: Record<string, unknown> | undefined, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * Base error for the Kagura SDK.
 *
 * An error the server reported keeps what it sent. Branch on {@link code}
 * (and on the subclass), never on the message: memory-cloud words its
 * messages for people and may change them.
 */
export class KaguraError extends Error {
  /**
   * The server's error code — the MCP envelope's `error`
   * (`"payload_too_large"`, `"capacity_locked"` …), the REST `error`
   * (`"FEAT-001"`, `"CAPACITY-001"`, `"DB-002"` …), the OAuth `error`
   * (`"invalid_client"`, `"insufficient_scope"` …) or a JSON-RPC error's
   * `data.error` — when the SDK read one, else `undefined` (the SDK raised
   * the error itself, or the server named no code).
   */
  readonly code: string | undefined;
  /**
   * The other fields the server sent with the error, as sent — the MCP
   * envelope without `status` / `error` / `message`, the REST `details`
   * whole, a JSON-RPC error's `data` without its `error` (the code) or an
   * OAuth body without its `error`. `{}` when the SDK raised the error
   * itself or the server sent nothing more. The getters below read the MCP
   * error-envelope fields from it.
   */
  readonly details: Record<string, unknown>;

  constructor(message: string, options?: KaguraErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = options?.code ?? undefined;
    this.details = { ...(options?.details ?? {}) };
  }

  /** The server's next step for the caller (memory-cloud v0.78.0+, #1684). */
  get help(): string | null {
    return strDetail(this.details, "help");
  }

  /**
   * Why a server failure happened: `"timeout"`, `"service_unavailable"` or
   * `"internal_error"`; `null` on a refusal, which is the caller's to fix.
   * A failed MCP tool sends it from memory-cloud v0.78.0 (#1684), the
   * `/mcp` transport's own JSON-RPC errors from v0.82.0 (#1742); the same
   * holds for {@link correlationId}, {@link retryable} and {@link outcome}.
   *
   * The Python SDK's `cause` property. JavaScript's `Error.cause` already
   * holds the chained error (the `fetch` failure, the parse error), so the
   * server's `cause` is read here instead; `details.cause` holds it too.
   */
  get serverCause(): string | null {
    return strDetail(this.details, "cause");
  }

  /** The id the server logged a failure under — quote it in a report (v0.78.0+). */
  get correlationId(): string | null {
    return strDetail(this.details, "correlation_id");
  }

  /**
   * Whether repeating the call is safe, on a server failure (v0.78.0+).
   * `false` for a write whose {@link outcome} is `"unknown"`: check with the
   * read {@link help} names before calling it again.
   */
  get retryable(): boolean | null {
    const value = this.details.retryable;
    return typeof value === "boolean" ? value : null;
  }

  /** `"unknown"` when a failed write may or may not have been applied (v0.78.0+). */
  get outcome(): string | null {
    return strDetail(this.details, "outcome");
  }
}

/**
 * Authentication failed.
 *
 * Also raised for an OAuth token that lacks the scope a call needs (HTTP
 * 403 `insufficient_scope`, memory-cloud v0.79.0+, #1686): `code` is then
 * `"insufficient_scope"` and `details.required_scope` names the scope
 * (`"memory:read"` or `"memory:write"`) when the server sent it. A
 * `kagura-memory auth login --read-only` profile gets this on every tool
 * that writes; sign in again without `--read-only`.
 */
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

/** {@link KaguraErrorOptions} plus what a 503 says about waiting. */
export interface KaguraServiceUnavailableErrorOptions extends KaguraErrorOptions {
  /** Seconds to wait; see {@link KaguraServiceUnavailableError.retryAfter}. */
  retryAfter?: number | null;
  /** Why; see {@link KaguraServiceUnavailableError.reason}. */
  reason?: string | null;
}

/**
 * The server answered HTTP 503: it could not serve the request right now.
 *
 * A {@link KaguraConnectionError}, so existing handlers still catch it.
 * Raised for `/mcp`'s `temporarily_unavailable` (the credential could not
 * be verified, memory-cloud v0.82.0+, #1742) and its JSON-RPC transport
 * failures (a dependency down or timed out), and for REST `DB-002` (the
 * database is unavailable, `details.reason` from v0.104.0). `details` keeps
 * what the server sent — on `/mcp` the JSON-RPC `data` with `cause`,
 * `correlation_id`, `help`, `retryable` and, for a write, `outcome`.
 */
export class KaguraServiceUnavailableError extends KaguraConnectionError {
  /**
   * Seconds to wait, from the `Retry-After` header (else the JSON-RPC
   * `data.retry_after_seconds`); `null` when the server named no wait — on
   * `/mcp` that means the request was a write whose `outcome` is unknown,
   * so check before repeating it.
   */
  readonly retryAfter: number | null;
  /**
   * Why: REST `details.reason` (`pool_exhausted`, `connection_refused`,
   * `deadlock`, `database_error`), the MCP `cause` (`timeout`,
   * `service_unavailable`), or the error code (`temporarily_unavailable`)
   * when nothing finer was sent.
   */
  readonly reason: string | null;

  constructor(message: string, options: KaguraServiceUnavailableErrorOptions = {}) {
    super(message, options);
    this.retryAfter = options.retryAfter ?? null;
    this.reason = options.reason ?? null;
  }
}

/** {@link KaguraErrorOptions} plus how long a held download says to wait. */
export interface KaguraFileScanPendingErrorOptions extends KaguraErrorOptions {
  /** Seconds to wait; see {@link KaguraFileScanPendingError.retryAfter}. */
  retryAfter?: number | null;
}

/**
 * The file's malware scan has not finished (memory-cloud v0.160.0+, #565).
 *
 * `FilesClient.downloadUrl` got `409 SCAN-001`: upload scanning is on and
 * the file is still `pending`. The same request succeeds once the scan
 * says clean, so wait {@link retryAfter} seconds and call again; the SDK
 * does not retry by itself. A file that was downloadable before can come
 * back to this when its stored object no longer matches the scanned
 * version: the server queues it for a new scan.
 *
 * A {@link KaguraConnectionError}, the class a 409 had before, so existing
 * `instanceof KaguraConnectionError` handlers still catch it (the Python
 * SDK's class of the same name makes the same choice). `code` is
 * `"SCAN-001"` and `details` the server's `{file_id, scan_status:
 * "pending"}`, read by the getters below (`null` when a field is missing
 * or is no string).
 */
export class KaguraFileScanPendingError extends KaguraConnectionError {
  /**
   * Seconds to wait, from the `Retry-After` header (memory-cloud sends 30);
   * `null` when it is absent or is not a whole number of seconds.
   */
  readonly retryAfter: number | null;

  constructor(message: string, options: KaguraFileScanPendingErrorOptions = {}) {
    super(message, options);
    this.retryAfter = options.retryAfter ?? null;
  }

  /** The file the scan holds (`details.file_id`). */
  get fileId(): string | null {
    return strDetail(this.details, "file_id");
  }

  /** The file's scan state (`details.scan_status`, `"pending"`). */
  get scanStatus(): string | null {
    return strDetail(this.details, "scan_status");
  }

  /** `true`: the same call succeeds once the scan finishes. */
  override get retryable(): boolean | null {
    return true;
  }
}

/**
 * The malware scan blocked the file; it cannot be downloaded (memory-cloud
 * v0.160.0+, #565).
 *
 * `FilesClient.downloadUrl` got `409 SCAN-002`. {@link scanStatus} is
 * `"infected"` (a finding; refused even after scanning is turned off) or,
 * while scanning is on, `"error"` (the scanner could not check the file)
 * or any other value the server does not allow: its download gate is an
 * allow-list. Waiting does not help, so it is not retryable. The finding's
 * name is never part of the response.
 *
 * A {@link KaguraConnectionError}, the class a 409 had before, so existing
 * handlers still catch it, as in the Python SDK. `code` is `"SCAN-002"` and
 * `details` the server's `{file_id, scan_status}`, read by the getters
 * below (`null` when a field is missing or is no string).
 */
export class KaguraFileBlockedError extends KaguraConnectionError {
  /** The blocked file (`details.file_id`). */
  get fileId(): string | null {
    return strDetail(this.details, "file_id");
  }

  /** The file's scan state (`details.scan_status`), e.g. `"infected"` or `"error"`. */
  get scanStatus(): string | null {
    return strDetail(this.details, "scan_status");
  }

  /** `false`: a blocked file does not become downloadable by waiting. */
  override get retryable(): boolean | null {
    return false;
  }
}

/** Requested resource not found (HTTP 404). */
export class KaguraNotFoundError extends KaguraError {}

/** `details[key]` when it is a whole number (a JSON integer), else `null`. */
function intDetail(details: Record<string, unknown>, key: string): number | null {
  const value = details[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * An edit's `expectedVersion` no longer matched the memory (memory-cloud
 * v0.113.0+, #2043; the Python SDK's class of the same name, its #302).
 *
 * `updateMemory({ expectedVersion })` found the memory at another version
 * because another edit landed first, and wrote nothing: MCP
 * `version_conflict`, or a REST `409 RES-002` whose `details.reason` is
 * `"version_conflict"` (`PATCH /api/v1/memory/{id}`). It is not retryable
 * as is: read the memory again (`KaguraClient.reference` returns its
 * `version`), then resend with that version, or without `expectedVersion`
 * to overwrite.
 *
 * `code` and `details` keep what the server sent — `code` is
 * `"version_conflict"` from MCP and `"RES-002"` from REST — and the
 * getters below read `details`, `null` when a field is missing or is not
 * of its type.
 */
export class KaguraVersionConflictError extends KaguraError {
  /** The memory's version now, when the server sent it. */
  get currentVersion(): number | null {
    return intDetail(this.details, "current_version");
  }

  /** The `expectedVersion` the refused edit carried. */
  get expectedVersion(): number | null {
    return intDetail(this.details, "expected_version");
  }

  /** The memory's id (the MCP envelope sends it; REST names it in the URL). */
  get memoryId(): string | null {
    return strDetail(this.details, "memory_id");
  }
}

/**
 * A successful server response did not match what the SDK expects of it
 * (the Python SDK's class of the same name, from its #250).
 *
 * Usually the server is newer than this SDK and returns a value or a
 * shape the SDK does not know yet; upgrading `kagura-memory` is the likely
 * fix, and the message says so. `operation` names the call whose response
 * failed — the MCP tool name, or `<Client>.<method>` on the REST clients —
 * and prefixes the message, which names the failing fields or the
 * envelope's shape, never payload values.
 *
 * Not a {@link KaguraConnectionError}: the call reached the server and
 * succeeded, so a retry will fail the same way.
 */
export class KaguraResponseError extends KaguraError {
  readonly operation?: string;

  constructor(message: string, operation?: string, options?: KaguraErrorOptions) {
    super(message, options);
    this.operation = operation;
  }
}

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

/** Adding this context role requires a change to the member's workspace access list. */
export class KaguraContextNotInAccessListError extends KaguraContextError {}

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
 * with a `gate`, an upgrade helps only when `requiredPlan` is non-null.
 * With no `gate` — a server older than v0.75.0, or the SDK's own
 * context-limit pre-check, which knows only `quotaType`, `current` and
 * `limit` — a `null` `requiredPlan` means the plan is unknown, not that no
 * plan lifts the cap. An untyped limit, such as the REST 1 MB memory-size
 * guard, arrives with no gate either. On MCP that guard is no quota: from
 * memory-cloud v0.108.0 (#2003) it is a plain {@link KaguraError} with
 * `code` `"payload_too_large"` and `limit` / `actual` in `details`.
 *
 * `retryAfter` is the `Retry-After` header when there was one, else the
 * retry hint the body carried (REST `details.retry_after`, MCP
 * `retry_after_seconds`; the resource events-per-hour quota sends only
 * that), else it is derived from `resetsAt` on a time-windowed quota such
 * as `memories_per_day`. A fixed cap has none of them, because waiting
 * will not lift it.
 */
export class KaguraQuotaError extends KaguraError {
  readonly retryAfter: number | null;
  readonly gate: string | null;
  readonly quotaType: string | null;
  /**
   * Count already used. A server older than v0.75.0 sent no `current`, so
   * the SDK reads the refusal's legacy count instead: `used_today`,
   * `owned_count` or `active_connectors`. An error built by hand falls back
   * to `usedToday`.
   */
  readonly current: number | null;
  /**
   * The cap that was hit. When the refusal has no `limit`, the SDK reads
   * its legacy name instead: `limit_today`, `cap` or `max_connectors`.
   */
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
 * Show `requiredPlanDisplay`; decide with `requiredPlan`. With a `gate`
 * (server v0.75.0+), both are `null` when no tier lifts the refusal, and
 * `gate` says why: `"allowlist"` or `"deployment"` mean an upgrade will
 * not help. An older server sends no `gate` and not always the plan, so
 * there a `null` `requiredPlan` means the plan is unknown.
 *
 * Named after the server's MCP `feature_not_available` code and the Python
 * SDK's class of the same name: not every refusal here is about the plan.
 */
export class KaguraFeatureNotAvailableError extends KaguraError {
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
 * {@link KaguraErrorOptions} plus the overage figures of a capacity lock,
 * camelCased from the server's key names.
 */
export interface KaguraCapacityLockedErrorOptions extends KaguraErrorOptions {
  cleanupUrl?: string | null;
  memoryCount?: number | null;
  memoryLimit?: number | null;
  overMemories?: number | null;
  usedBytes?: number | null;
  storageLimitBytes?: number | null;
  overBytes?: number | null;
}

/**
 * The workspace is over its Free plan capacity and locked (memory-cloud
 * v0.99.0+, #1941).
 *
 * A workspace back on Free from a subscription that still holds more
 * memories or file bytes than Free allows: search and saving (recall,
 * reference, explore, remember, uploads, context creation …) are refused
 * until it is cleaned up or re-subscribed; listing, deleting, export and
 * usage keep working. REST answers `403 CAPACITY-001` with `details.gate
 * === "capacity"`, MCP `capacity_locked`; since v0.126.0 (#1954) a context
 * the caller cannot read answers `context_not_found` instead. Neither a
 * quota nor a plan gate — waiting does not lift it and an upgrade is only
 * one way out — so it extends neither {@link KaguraQuotaError} nor
 * {@link KaguraFeatureNotAvailableError}.
 *
 * The figures are the server's, `null` when it did not send them or sent
 * something that is no whole number. A caller who is not a member of the
 * locked workspace (reading a public context) gets every figure and
 * `cleanupUrl` as `null`. `details` keeps every field the server sent (on
 * MCP also `help`, which names how much to remove).
 */
export class KaguraCapacityLockedError extends KaguraError {
  /** Always `"capacity"`. */
  readonly gate = "capacity" as const;
  /** The web page where the owner cleans up or re-subscribes. */
  readonly cleanupUrl: string | null;
  /** Live memories in the workspace. */
  readonly memoryCount: number | null;
  /** The effective memory limit. */
  readonly memoryLimit: number | null;
  /** Memories to remove to unlock (0 when within the limit). */
  readonly overMemories: number | null;
  /** File bytes the owner can still delete. */
  readonly usedBytes: number | null;
  /** The effective storage limit. */
  readonly storageLimitBytes: number | null;
  /** File bytes to remove to unlock (0 when within the limit). */
  readonly overBytes: number | null;

  constructor(message: string, options: KaguraCapacityLockedErrorOptions = {}) {
    super(message, options);
    this.cleanupUrl = options.cleanupUrl ?? null;
    this.memoryCount = options.memoryCount ?? null;
    this.memoryLimit = options.memoryLimit ?? null;
    this.overMemories = options.overMemories ?? null;
    this.usedBytes = options.usedBytes ?? null;
    this.storageLimitBytes = options.storageLimitBytes ?? null;
    this.overBytes = options.overBytes ?? null;
  }
}

/**
 * `rollbackSleepRun` reversed some of a run's actions but not all.
 *
 * The server commits each step, so what was reversed stays reversed, and
 * the report is marked `failed`. `summary` is the same
 * {@link RollbackSummary} a clean rollback returns: its counts say what
 * was undone, and `summary.errors` names each action that was not. It is
 * the summary as the server sent it, so `related_indexes_reverted`
 * (memory-cloud v0.153.0+) is `undefined` unless an entry of the opt-in
 * Sleep related index was undone.
 *
 * The server will not roll back a `failed` report again, so there is no
 * retry; the actions in `summary.errors` need handling some other way.
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

export interface KaguraPartialSessionRollbackErrorOptions extends KaguraErrorOptions {
  /** What this call forgot, restored, skipped and failed; `null` when unreadable. */
  sessionSummary?: SessionRollbackSummary | null;
  /** The counters of every call of this rollback so far, as sent. */
  totals?: Record<string, unknown> | null;
  /** The rollback record's id. */
  rollbackId?: number | null;
  /** Events still to handle, the failed items' included. */
  remaining?: number | null;
}

/**
 * `rollbackSession` failed some items of this call (memory-cloud
 * v0.113.0+, #2044).
 *
 * The server answers `partial_rollback` after a real run (`dryRun:
 * false`) in which some items failed. Every other item of the call was
 * handled and saved, so nothing is half-reverted; call `rollbackSession`
 * again with the same arguments to retry the failed items (they are
 * planned again from the memory as it is then). A sibling of
 * {@link KaguraPartialRollbackError}, which is the Sleep run rollback's.
 *
 * The rest of the envelope stays in `details` (`rollback_status`,
 * `events`, the `session_id` or `since` / `until` echo); quote
 * `correlationId` when reporting a failure. The fields below are `null`
 * when the server did not send them or sent something this SDK cannot
 * read: the partial rollback is already committed, so an unreadable field
 * never hides it behind a second error.
 */
export class KaguraPartialSessionRollbackError extends KaguraError {
  /**
   * What this call forgot, restored, skipped and failed, with one line per
   * failed item in `sessionSummary.errors`.
   */
  readonly sessionSummary: SessionRollbackSummary | null;
  /** The counters of every call of this rollback so far (`calls` included), as sent. */
  readonly totals: Record<string, unknown> | null;
  /** The rollback record's id. */
  readonly rollbackId: number | null;
  /** Events still to handle (the failed items' included). */
  readonly remaining: number | null;

  constructor(message: string, options: KaguraPartialSessionRollbackErrorOptions = {}) {
    super(message, options);
    this.sessionSummary = options.sessionSummary ?? null;
    this.totals = options.totals ?? null;
    this.rollbackId = options.rollbackId ?? null;
    this.remaining = options.remaining ?? null;
  }
}

/**
 * The server refused the call with MCP `permission_denied`: usually because
 * the caller's role does not allow the operation.
 *
 * Not always, though. `updateSearchConfig` also answers
 * `permission_denied` for a context that does not exist or that the caller
 * cannot see, so there a missing context is this class, not
 * {@link KaguraNotFoundError}. Only some tools send `required_role`:
 * `updateSearchConfig`, `updateContext`, `deleteContext`, the file tools
 * and the analysis tools (reached through `callRawTool`) do not, so
 * `requiredRole` is `null` on those calls whatever the cause, and on
 * `updateSearchConfig` it cannot tell a missing context from a role
 * denial.
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
