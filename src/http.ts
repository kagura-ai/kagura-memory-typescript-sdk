/** Shared HTTP utilities for Kagura Memory SDK clients (port of _http.py). */

import {
  KaguraAuthError,
  KaguraCapacityLockedError,
  KaguraConnectionError,
  KaguraError,
  KaguraFeatureNotAvailableError,
  KaguraQuotaError,
  KaguraRateLimitError,
  KaguraServiceUnavailableError,
} from "./errors.js";
import type { KaguraCapacityLockedErrorOptions, KaguraQuotaErrorOptions } from "./errors.js";
import { PY_SPACE_CLASS } from "./pyCompat.js";

export { SDK_VERSION } from "./version.js";

/**
 * Derive the REST API base URL from an MCP URL.
 *
 * Drops the query and fragment, then strips `/mcp` and everything after it
 * (e.g. `/mcp/w/{workspace}`). The query (`?profile=`, `?tools=`,
 * `?guardrails=`) configures the MCP endpoint alone, so it is dropped even
 * from a URL with no `/mcp` segment to strip.
 */
export function baseUrlFromMcp(mcpUrl: string): string {
  // `?` and `#` end the path. Callers strip trailing slashes from the raw
  // URL, which misses a slash sitting before the query (`/?profile=core`).
  const end = mcpUrl.search(/[?#]/);
  const path = end === -1 ? mcpUrl : mcpUrl.slice(0, end).replace(/\/+$/, "");
  // Search the path only: the `//` of `https://mcp/mcp` would otherwise
  // read as a `/mcp` segment and cut the URL down to `https:/`.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(path);
  const from = authority ? authority[0].length : 0;
  const m = /\/mcp(?=\/|$)/.exec(path.slice(from));
  return m ? path.slice(0, from + m.index) : path;
}

function formatValidationErrors(errors: unknown[]): string {
  // Silent-skip malformed entries so a single bad entry doesn't blank the line.
  const parts: string[] = [];
  for (const entry of errors) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const msg = rec.msg;
    if (typeof msg !== "string" || !msg) {
      continue;
    }
    const loc = rec.loc;
    if (Array.isArray(loc) && loc.length > 0) {
      parts.push(`${loc.map(String).join(".")}: ${msg}`);
    } else {
      parts.push(msg);
    }
  }
  return parts.join("; ");
}

/** The `error` object of a JSON-RPC error body, else `null`. */
function jsonRpcError(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const error = (body as Record<string, unknown>).error;
  return typeof error === "object" && error !== null && !Array.isArray(error)
    ? (error as Record<string, unknown>)
    : null;
}

/**
 * Return a useful server-supplied error string from a response body.
 *
 * Handles six response shapes:
 * - `{"detail": "string"}` — returned as-is (FastAPI HTTPException default).
 * - `{"detail": [{"loc": [...], "msg": "...", ...}, ...]}` — FastAPI's
 *   validation-error format; each entry becomes `"<loc.path>: <msg>"`.
 * - `{"error": "<CODE>", "message": "string", "details": {...}}` — the
 *   memory-cloud canonical envelope; returns `message`, appending
 *   `details.errors` validation entries when present.
 * - `{"jsonrpc": "2.0", "error": {"code": int, "message": "string"}}` — the
 *   MCP transport's 4xx for a request it rejects before dispatch; returns
 *   `error.message`, e.g. the expired-session 404's re-initialize hint.
 * - `{"error": "<code>", "error_description": "string"}` — the OAuth-style
 *   body of the MCP transport's workspace-URL 400/403 (and its 401), and of
 *   the OAuth endpoints; returns `error_description`, e.g. "You are not a
 *   member of this workspace."
 * - Anything else — returns an empty string so callers can fall back.
 */
export function extractDetail(bodyText: string): string {
  return detailOf(parseJsonBody(bodyText));
}

/**
 * {@link extractDetail} of a body already decoded ({@link parseJsonBody}).
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function detailOf(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "";
  }
  const rec = body as Record<string, unknown>;
  const detail = rec.detail;
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    return formatValidationErrors(detail);
  }
  const message = rec.message;
  if (typeof message === "string" && message) {
    const details = rec.details;
    if (typeof details === "object" && details !== null && !Array.isArray(details)) {
      const errors = (details as Record<string, unknown>).errors;
      if (Array.isArray(errors)) {
        const formatted = formatValidationErrors(errors);
        if (formatted) {
          return `${message}: ${formatted}`;
        }
      }
    }
    return message;
  }
  const rpcMessage = jsonRpcError(rec)?.message;
  if (typeof rpcMessage === "string" && rpcMessage) {
    return rpcMessage;
  }
  const description = rec.error_description;
  if (typeof description === "string") {
    return description;
  }
  return "";
}

/** Headers naming the MCP session `sessionId` — none before a session exists. */
export function mcpSessionHeader(sessionId: string | null): Record<string, string> {
  return sessionId ? { "mcp-session-id": sessionId } : {};
}

const JSONRPC_METHOD_NOT_FOUND = -32601;

/**
 * Whether a response says the MCP session a request carried is gone (#39).
 *
 * MCP Streamable HTTP answers a request naming a session the server no
 * longer holds with `404`, and the client must then send a new
 * `initialize`. The server keeps legacy (`initialize`-handshake) sessions
 * in process memory and drops them after an idle hour and on every restart.
 * (As deployed, v0.75.0 re-adopts an unknown session id instead of
 * answering `404`, so against it this never fires; it is reached against a
 * server that enforces the spec.)
 *
 * The one `404` that is not about the session is the stateless 2026-07-28
 * `-32601` Method-not-found reply: that path ignores the session id, so
 * re-initializing would only open an orphan session.
 */
export function mcpSessionExpired(
  status: number,
  bodyText: string,
  sessionId: string | null,
): boolean {
  if (!sessionId || status !== 404) {
    return false;
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return true;
  }
  return jsonRpcError(body)?.code !== JSONRPC_METHOD_NOT_FOUND;
}

/**
 * Drop server-provided detail strings that contain credential markers.
 *
 * A future server bug echoing back the Bearer header or api_key must not
 * be passed straight to the user. Returns `null` when the detail is empty
 * or unsafe to display.
 */
export function sanitizeServerDetail(detail: string | null | undefined): string | null {
  if (!detail) {
    return null;
  }
  const lowered = detail.toLowerCase();
  if (lowered.includes("bearer") || lowered.includes("authorization") || lowered.includes("api_key=")) {
    return null;
  }
  return detail;
}

/**
 * Parse a numeric `Retry-After` header (delta-seconds), else `null`.
 *
 * Only the integer-seconds form is honored; an HTTP-date `Retry-After`
 * (rare for rate limits) is treated as absent rather than mis-parsed.
 */
export function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("Retry-After");
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
}

/** Error codes of the plan and quota refusals, per surface. */
export interface GateCodes {
  plan: readonly string[];
  quota: readonly string[];
}

/**
 * The daily MCP call cap, which every non-read-only tool checks in-band
 * and answers with an error envelope rather than an HTTP 429. It carries
 * no `gate` and names its counts `used_today` / `daily_limit`; the cap
 * counts calls per UTC day.
 */
export const MCP_DAILY_CAP_CODE = "rate_limit_exceeded";

/**
 * MCP envelope codes. `feature_not_available` is the analysis tools'
 * twin of `plan_required`, as REST `FEAT-001` is of both,
 * `setup_connector` forwards the connector seat cap's REST code
 * `CONNECTOR-001` as is, and {@link MCP_DAILY_CAP_CODE} names one cap, so
 * the code alone makes it a quota.
 */
export const MCP_GATE_CODES: GateCodes = {
  plan: ["plan_required", "feature_not_available"],
  quota: ["quota_exceeded", "CONNECTOR-001", MCP_DAILY_CAP_CODE],
};

/**
 * REST canonical-envelope codes. Beside `QUOTA-001`, the quota family has
 * `QUOTA-002` (embedding spend) and `CONNECTOR-001` (connector seats).
 */
export const REST_GATE_CODES: GateCodes = {
  plan: ["FEAT-001"],
  quota: ["QUOTA-001", "QUOTA-002", "CONNECTOR-001"],
};

function stringField(block: Record<string, unknown>, key: string): string | null {
  const value = block[key];
  return typeof value === "string" ? value : null;
}

function numberField(block: Record<string, unknown>, key: string): number | null {
  const value = block[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The first of `keys` that holds a number in `block`, else `null`. */
function firstNumberField(block: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = numberField(block, key);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

/**
 * A retry hint sent in the body rather than as a `Retry-After` header:
 * `block[key]` in whole seconds, rounded up, or `null` when it is absent,
 * not a number, or negative.
 *
 * The resource events-per-hour quota is the case that needs it: REST sends
 * `details.retry_after` with no header, and MCP sends `retry_after_seconds`
 * at the top of the envelope.
 */
export function bodyRetryAfter(block: Record<string, unknown>, key: string): number | null {
  const value = numberField(block, key);
  return value === null || value < 0 ? null : Math.ceil(value);
}

/**
 * Seconds to wait before retrying a REST error response: its numeric
 * `Retry-After` header, else the `details.retry_after` of a canonical
 * error body, else `null`.
 */
export function responseRetryAfter(headers: Headers, bodyText: string): number | null {
  return envelopeRetryAfter(headers, parseErrorEnvelope(bodyText));
}

/** {@link responseRetryAfter} with the body's envelope already read. */
function envelopeRetryAfter(headers: Headers, envelope: ErrorEnvelope | null): number | null {
  const header = retryAfterSeconds(headers);
  if (header !== null) {
    return header;
  }
  return envelope === null ? null : bodyRetryAfter(envelope.details, "retry_after");
}

/**
 * The Free capacity lock (memory-cloud v0.99.0+, #1941): REST `403
 * CAPACITY-001` with `details.gate === "capacity"`, MCP `capacity_locked`.
 * Either code means the lock on either surface, as in the Python SDK.
 */
const CAPACITY_GATE = "capacity";
const CAPACITY_CODES: readonly string[] = ["capacity_locked", "CAPACITY-001"];

/**
 * Which refusal `block` is: `"capacity"`, `"plan"`, `"quota"`, or `null`
 * for none of them.
 *
 * `block` holds the gate fields: the MCP envelope itself, or a REST
 * body's `details`. The capacity lock comes first, by its `gate` or its
 * code: it is neither a quota nor a plan gate. Then the `gate`
 * (memory-cloud v0.75.0+) decides whenever it is one the SDK knows,
 * because the code alone can mislead: the resource-token cap is a quota
 * that answers 403, and the connector seat cap keeps a code of its own.
 * `allowlist` and `deployment` are the other two reasons a feature is
 * unavailable, so they count as `"plan"` — the kind an older server's bare
 * `FEAT-001` already gets. With no gate, `code` decides against the
 * surface's `codes`.
 */
function gateKind(
  block: Record<string, unknown>,
  code: string | null,
  codes: GateCodes,
): "capacity" | "plan" | "quota" | null {
  const gate = stringField(block, "gate");
  if (gate === CAPACITY_GATE || (code !== null && CAPACITY_CODES.includes(code))) {
    return "capacity";
  }
  if (gate === "quota") {
    return "quota";
  }
  if (gate === "plan" || gate === "allowlist" || gate === "deployment") {
    return "plan";
  }
  if (code !== null && codes.quota.includes(code)) {
    return "quota";
  }
  if (code !== null && codes.plan.includes(code)) {
    return "plan";
  }
  return null;
}

/**
 * Where a refusal's counts live when the canonical `current` / `limit`
 * are absent: the names servers older than v0.75.0 sent instead (v0.75.0
 * adds the canonical pair and keeps these beside it). The daily memory and
 * analysis quotas send `used_today`, the analysis one with `limit_today`;
 * the workspace cap sends `owned_count` / `cap`, and the connector seat
 * cap `active_connectors` / `max_connectors`.
 */
const LEGACY_CURRENT_KEYS = ["used_today", "owned_count", "active_connectors"] as const;
const LEGACY_LIMIT_KEYS = ["limit_today", "cap", "max_connectors"] as const;

/**
 * The gate payload in `block`, camelCased. Wire keys are snake_case; a
 * missing or wrong-typed one reads as `null` rather than trusting the
 * shape. `current` and `limit` fall back to the legacy count names an
 * older server sent instead.
 */
function gateOptions(block: Record<string, unknown>): KaguraQuotaErrorOptions {
  return {
    gate: stringField(block, "gate"),
    feature: stringField(block, "feature"),
    requiredPlan: stringField(block, "required_plan"),
    requiredPlanDisplay: stringField(block, "required_plan_display"),
    currentPlan: stringField(block, "current_plan"),
    quotaType: stringField(block, "quota_type"),
    current: firstNumberField(block, ["current", ...LEGACY_CURRENT_KEYS]),
    limit: firstNumberField(block, ["limit", ...LEGACY_LIMIT_KEYS]),
    usedToday: numberField(block, "used_today"),
    resetsAt: stringField(block, "resets_at"),
  };
}

/** The next UTC midnight, as Python's `datetime.isoformat()` writes it (`+00:00`). */
function nextUtcMidnight(now: Date): string {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return new Date(midnight).toISOString().replace(".000Z", "+00:00");
}

/**
 * The daily MCP cap's envelope with the canonical quota fields it leaves
 * implicit filled in: `quota_type` `api_mcp_daily`, `current` from
 * `used_today`, `limit` from `daily_limit`, and `resets_at` the next UTC
 * midnight. Whatever the server does send wins, as in Python's
 * `gate_error`.
 */
function withMcpDailyCapFields(block: Record<string, unknown>): Record<string, unknown> {
  return {
    quota_type: "api_mcp_daily",
    current: block.used_today,
    limit: block.daily_limit,
    resets_at: nextUtcMidnight(new Date()),
    ...block,
  };
}

/**
 * A whole number at `block[key]`, else `null` (Python's `_opt_int`): a
 * count the server sent as anything else is dropped rather than trusted.
 */
function intField(block: Record<string, unknown>, key: string): number | null {
  const value = block[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** The capacity lock's figures in `block`, camelCased; a wrong-typed one reads `null`. */
function capacityOptions(block: Record<string, unknown>): KaguraCapacityLockedErrorOptions {
  return {
    cleanupUrl: stringField(block, "cleanup_url"),
    memoryCount: intField(block, "memory_count"),
    memoryLimit: intField(block, "memory_limit"),
    overMemories: intField(block, "over_memories"),
    usedBytes: intField(block, "used_bytes"),
    storageLimitBytes: intField(block, "storage_limit_bytes"),
    overBytes: intField(block, "over_bytes"),
  };
}

/** Envelope keys that frame an MCP refusal rather than describe it. */
const ENVELOPE_KEYS: readonly string[] = ["status", "error", "message"];

/** `record` without the keys in `drop`, as a fresh object. */
function without(record: Record<string, unknown>, drop: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!drop.includes(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * An MCP tool-error envelope without its frame (`status` / `error` /
 * `message`), as a fresh object: what the error's `details` keep.
 *
 * Only the MCP envelope is stripped so: there the whole `result` is the
 * refusal. A REST `details` object, a JSON-RPC `data` and an OAuth body are
 * kept as sent, so a server field that happens to be named `status` or
 * `message` there is not lost.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function mcpEnvelopeFields(result: Record<string, unknown>): Record<string, unknown> {
  return without(result, ENVELOPE_KEYS);
}

/**
 * An OAuth-style error body without its `error` (the code), as a fresh
 * object: `error_description` and whatever else the server sent.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function oauthBodyFields(body: Record<string, unknown>): Record<string, unknown> {
  return without(body, ["error"]);
}

/**
 * Build the typed error for a plan, quota or capacity refusal, or `null` if
 * it is none of them: {@link KaguraCapacityLockedError},
 * {@link KaguraFeatureNotAvailableError} or {@link KaguraQuotaError}, as
 * `gateKind` decides, carrying the payload `block` holds. `retryAfter` is
 * the caller's reading of the response's retry hint; with none, a quota
 * error derives it from `resets_at`. The MCP daily call cap
 * ({@link MCP_DAILY_CAP_CODE}) is the `api_mcp_daily` quota, resetting at
 * the next UTC midnight.
 *
 * The error's `code` is `code`, and its `details` are `details` — by
 * default `block` itself, as the server sent it, before the daily cap's
 * canonical names are filled in. The MCP caller passes the envelope
 * without its frame ({@link mcpEnvelopeFields}); a REST `details` block is
 * kept whole.
 */
export function gateError(
  block: Record<string, unknown>,
  code: string | null,
  codes: GateCodes,
  message: string,
  retryAfter: number | null = null,
  details: Record<string, unknown> = block,
): KaguraError | null {
  if (code === MCP_DAILY_CAP_CODE) {
    block = withMcpDailyCapFields(block);
  }
  const kind = gateKind(block, code, codes);
  if (kind === null) {
    return null;
  }
  const server = code === null ? { details } : { code, details };
  if (kind === "capacity") {
    return new KaguraCapacityLockedError(message, { ...capacityOptions(block), ...server });
  }
  const options = { ...gateOptions(block), ...server };
  return kind === "plan"
    ? new KaguraFeatureNotAvailableError(message, options)
    : new KaguraQuotaError(message, retryAfter, options);
}

/**
 * Keep the server's error `code` and its other fields on `err` (Python's
 * `annotate_server_error`).
 *
 * `code` is the server's error code, `undefined` when it sent none (the
 * error then keeps whatever code it has, usually none). `fields` is what
 * came with it, stored as a copy as given — the REST `details`, a JSON-RPC
 * error's `data` or an OAuth body's other fields ({@link serverErrorFields}
 * reads all three); an MCP envelope is passed through
 * {@link mcpEnvelopeFields} first. A `code` or `details` the error already
 * has (a typed error builds its own) is kept.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function annotateServerError<E extends KaguraError>(
  err: E,
  code: string | undefined,
  fields: Record<string, unknown>,
): E {
  // Written once, here, where the server's answer is read; readonly to callers.
  const target = err as unknown as { code: string | undefined; details: Record<string, unknown> };
  if (target.code === undefined && code !== undefined) {
    target.code = code;
  }
  if (Object.keys(target.details).length === 0) {
    target.details = { ...fields };
  }
  return err;
}

/** @internal */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An error response body decoded as JSON, `undefined` when it is not JSON.
 *
 * Decoded once per error response and handed to the readers below
 * ({@link detailOf}, {@link envelopeOf}, {@link serverErrorFieldsOf}), as
 * {@link throwForKaguraStatus} does.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function parseJsonBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    return undefined;
  }
}

/** `[code, fields]` of an error body: see {@link serverErrorFieldsOf}. */
export type ServerErrorFields = [string, Record<string, unknown>];

/**
 * `[code, fields]` of an error body that names an error code, else `null`
 * (Python's `server_error_fields`).
 *
 * Reads the three shapes memory-cloud answers with: the REST envelope
 * `{"error": <code>, "message": …, "details": {…}}` (`fields` is
 * `details`); a JSON-RPC error whose `data` carries `error` — the `/mcp`
 * transport's refusals and server failures, with `cause`,
 * `correlation_id`, `help` and `retryable` (memory-cloud v0.82.0+, #1742;
 * `fields` is `data` without its `error`, the code itself); and the
 * OAuth-style `{"error": <code>, "error_description": …}` (`fields` is the
 * body without `error`). `fields` is always a fresh object.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function serverErrorFieldsOf(body: unknown): ServerErrorFields | null {
  if (!isRecord(body)) {
    return null;
  }
  const error = body.error;
  if (isRecord(error)) {
    const data = error.data;
    return isRecord(data) && typeof data.error === "string" ? [data.error, without(data, ["error"])] : null;
  }
  if (typeof error !== "string") {
    return null;
  }
  if (isRecord(body.details)) {
    return [error, { ...body.details }];
  }
  return [error, oauthBodyFields(body)];
}

/**
 * {@link serverErrorFieldsOf} of a body still to be decoded.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function serverErrorFields(bodyText: string): ServerErrorFields | null {
  return serverErrorFieldsOf(parseJsonBody(bodyText));
}

const INSUFFICIENT_SCOPE = "insufficient_scope";

/**
 * One item of a `WWW-Authenticate` value: a `name=value` parameter (the
 * value a quoted string, RFC 9110 §11.2, or a bare token), else a bare
 * token — an auth-scheme, or the token68 some schemes carry. One value can
 * hold several challenges: fetch joins repeated headers with ", " (RFC
 * 9110 §11.6.1).
 */
const CHALLENGE_ITEM_RE = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))|([^\s,="]+=*)/g;

/**
 * The parameters of the `WWW-Authenticate: Bearer` challenge in `headers`
 * (RFC 6750 §3), names lower-cased; `{}` when there is none. The Bearer
 * challenge may come after another one (`Basic realm="x", Bearer
 * error=…`, a proxy's challenge joined with the server's).
 */
function bearerChallenge(headers: Headers): Record<string, string> {
  const header = headers.get("WWW-Authenticate");
  if (header === null) {
    return {};
  }
  let params: Record<string, string> | null = null;
  for (const match of header.matchAll(CHALLENGE_ITEM_RE)) {
    const scheme = match[4];
    if (scheme !== undefined) {
      if (params !== null) {
        break; // the next challenge starts: the Bearer one is complete
      }
      if (scheme.toLowerCase() === "bearer") {
        params = {};
      }
    } else if (params !== null) {
      const quoted = match[2];
      params[match[1]!.toLowerCase()] = quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : match[3]!;
    }
  }
  return params ?? {};
}

/**
 * The {@link KaguraAuthError} for a 403 `insufficient_scope`, else `null`
 * (Python's `insufficient_scope_error`).
 *
 * memory-cloud v0.79.0+ (#1686) refuses a `tools/call` whose OAuth token
 * lacks the tool's scope — `memory:read` for the read-only tools, `recall`
 * and `get_agent_bootstrap`, `memory:write` for every other tool — with
 * HTTP 403, a `WWW-Authenticate: Bearer error="insufficient_scope"`
 * challenge and a JSON-RPC error whose `data` names `required_scope`. REST
 * `/api/v1/*` sends the challenge with `scope="<required>"`.
 * `data.required_scope` wins: the `/mcp` challenge's `scope` is the granted
 * scopes plus the required one.
 *
 * The error's `code` is `"insufficient_scope"`, and `details.required_scope`
 * names the scope when it is known.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function insufficientScopeError(headers: Headers, bodyText: string): KaguraAuthError | null {
  return insufficientScopeFrom(headers, serverErrorFields(bodyText));
}

/**
 * {@link insufficientScopeError} with the body's {@link serverErrorFieldsOf}
 * already read.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function insufficientScopeFrom(headers: Headers, fields: ServerErrorFields | null): KaguraAuthError | null {
  const data = fields !== null && fields[0] === INSUFFICIENT_SCOPE ? fields[1] : null;
  const challenge = bearerChallenge(headers);
  if (data === null && challenge.error !== INSUFFICIENT_SCOPE) {
    return null;
  }
  const scope = stringField(data ?? {}, "required_scope") || challenge.scope || null;
  const needs = scope ? `the ${scope} scope` : "a scope";
  const err = new KaguraAuthError(
    `The OAuth sign-in lacks ${needs} this call needs (HTTP 403 insufficient_scope). ` +
      "Run `kagura-memory auth login` to sign in again with it; a `--read-only` login grants " +
      "memory:read only.",
  );
  annotateServerError(err, INSUFFICIENT_SCOPE, data ?? {});
  if (scope) {
    err.details.required_scope = scope;
  }
  return err;
}

/**
 * The {@link KaguraServiceUnavailableError} for an HTTP 503 (Python's
 * `service_unavailable_error`).
 *
 * `retryAfter` is the numeric `Retry-After` header, else a JSON-RPC
 * `data.retry_after_seconds`; `reason` is the REST `details.reason`
 * (`DB-002`, memory-cloud v0.104.0+), else the MCP `cause`, else the error
 * code (`/mcp`'s `temporarily_unavailable`, v0.82.0+). The error keeps the
 * body's code and fields.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function serviceUnavailableError(
  headers: Headers,
  message: string,
  bodyText: string,
): KaguraServiceUnavailableError {
  return serviceUnavailableFrom(headers, message, serverErrorFields(bodyText));
}

/**
 * {@link serviceUnavailableError} with the body's
 * {@link serverErrorFieldsOf} already read.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function serviceUnavailableFrom(
  headers: Headers,
  message: string,
  fields: ServerErrorFields | null,
): KaguraServiceUnavailableError {
  const code = fields === null ? null : fields[0];
  const data = fields === null ? {} : fields[1];
  const retryAfter = retryAfterSeconds(headers) ?? intField(data, "retry_after_seconds");
  const reason = stringField(data, "reason") || stringField(data, "cause") || code;
  const err = new KaguraServiceUnavailableError(message, { retryAfter, reason });
  return code === null ? err : annotateServerError(err, code, data);
}

/** `HTTP <status>: <detail>`, or the bare status when there is no detail. */
function statusMessage(status: number, detail: string): string {
  // Avoid a doubled "HTTP 500: HTTP 500" when the body carries no detail.
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

/** A canonical REST error body split into its code and details block. */
interface ErrorEnvelope {
  code: string | null;
  details: Record<string, unknown>;
}

/**
 * Split a canonical `{"error", "message", "details"}` REST body into its
 * code and details block; `null` for any other body.
 */
export function parseErrorEnvelope(bodyText: string): ErrorEnvelope | null {
  return envelopeOf(parseJsonBody(bodyText));
}

/** {@link parseErrorEnvelope} of a body already decoded ({@link parseJsonBody}). */
function envelopeOf(body: unknown): ErrorEnvelope | null {
  if (!isRecord(body)) {
    return null;
  }
  const details = body.details;
  return {
    code: typeof body.error === "string" ? body.error : null,
    details: isRecord(details) ? details : {},
  };
}

/**
 * Translate a non-2xx HTTP response into the matching Kagura error.
 *
 * Maps 401 → KaguraAuthError, a 403 `insufficient_scope` (an OAuth token
 * without the scope the call needs, memory-cloud v0.79.0+, #1686) →
 * KaguraAuthError naming the scope, 429 → KaguraRateLimitError (honoring
 * a numeric `Retry-After` header, else the body's `details.retry_after`),
 * 503 → KaguraServiceUnavailableError (its `Retry-After` and reason), and
 * every other status → KaguraConnectionError. The server-supplied detail
 * is appended when present, otherwise `fallbackMessage` is used so the
 * status is never left bare. The error code and fields the body carried
 * (a JSON-RPC error's `data`, the REST `details`, an OAuth body's fields)
 * are kept as the error's `code` / `details`. The body is decoded once,
 * for every reader. This function always throws.
 *
 * A 429 that is a typed quota refusal (the daily call quota) keeps its
 * class, which existing handlers catch, but carries the quota's gate
 * payload; any other 429 leaves it `null`.
 */
export function throwForKaguraStatus(
  status: number,
  headers: Headers,
  bodyText: string,
  fallbackMessage?: string,
): never {
  if (status === 401) {
    throw new KaguraAuthError("Authentication failed. Check your API key.");
  }
  const body = parseJsonBody(bodyText);
  const fields = serverErrorFieldsOf(body);
  if (status === 403) {
    const scopeError = insufficientScopeFrom(headers, fields);
    if (scopeError !== null) {
      throw scopeError;
    }
  }
  const detail = detailOf(body) || fallbackMessage || "";
  let err: KaguraError;
  if (status === 429) {
    const envelope = envelopeOf(body);
    err = new KaguraRateLimitError(
      `Rate limit exceeded (HTTP 429): ${detail || `HTTP ${status}`}`,
      envelopeRetryAfter(headers, envelope),
      envelope !== null && gateKind(envelope.details, envelope.code, REST_GATE_CODES) === "quota"
        ? gateOptions(envelope.details)
        : {},
    );
  } else if (status === 503) {
    err = serviceUnavailableFrom(headers, statusMessage(status, detail), fields);
  } else {
    err = new KaguraConnectionError(statusMessage(status, detail));
  }
  throw fields === null ? err : annotateServerError(err, fields[0], fields[1]);
}

// Plain-HTTP is permitted only for genuine loopback hosts. The host token must
// be followed by a boundary — a port (:\d+), a path/query/fragment delimiter,
// or end-of-string — so a prefix-match attack like http://localhost.evil.com
// or a userinfo trick like http://localhost@evil.com cannot smuggle an
// external host past the check (#189).
// Both patterns are case-insensitive: URL parsing lower-cases the scheme
// and host, so `HTTP://EVIL.TEST` is fetched over plaintext exactly like
// `http://evil.test`. A case-sensitive guard would wave it through. Without
// the `u` flag, `/i` never folds a non-ASCII letter to an ASCII one, so no
// Unicode case fold (`ſ` → `s`) spells `localhost`: Python's `re.ASCII`.
// Any `http:` scheme counts, slashes or not: WHATWG parsers (fetch among
// them) read `http:/evil.com`, `http:evil.com` and `http:\\evil.com` as
// `http://evil.com`, and a loopback URL written that way is refused.
const PLAIN_HTTP_RE = /^http:/i;
const LOCALHOST_HTTP_RE = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

/**
 * What a URL parser drops before it reads the scheme: whitespace and C0
 * controls around the URL, and (WHATWG: fetch, browsers, the harnesses
 * `setup` writes for) a tab or newline anywhere in it. The whitespace is
 * Python's `\s`, so the class is Python's `_URL_IGNORED_RE` exactly; it
 * strips some Unicode spaces (U+3000) WHATWG keeps, which only makes the
 * check more conservative.
 */
const URL_SPACE = `\\x00-\\x20${PY_SPACE_CLASS}`;
const URL_IGNORED_RE = new RegExp(`^[${URL_SPACE}]+|[${URL_SPACE}]+$|[\\t\\n\\r]`, "g");

/**
 * Return `url` as a URL parser reads it, before it reads the scheme: the
 * port of the Python SDK's `normalize_url`.
 *
 * Surrounding whitespace and C0 controls go, and so does any tab or
 * newline inside it. Nothing else changes: the scheme and host keep their
 * case.
 */
export function normalizeUrl(url: string): string {
  return url.replace(URL_IGNORED_RE, "");
}

/**
 * Enforce HTTPS except for localhost development.
 *
 * The URL is checked as a parser reads it ({@link normalizeUrl}), the
 * scheme and host in any case: `" HTTP://evil.com"`, `"ht\ttp://evil.com"`
 * and `"http:evil.com"` all reach the network as plain HTTP to `evil.com`,
 * and are all refused (python-sdk#274). The message shows the normalized
 * URL.
 *
 * @throws Error if the URL uses HTTP and is not a loopback host.
 */
export function validateHttpsUrl(url: string, label = "URL"): void {
  // Both patterns are anchored, so without normalizing first they would
  // never match a URL a parser reads as plain HTTP after dropping what
  // surrounds it, and the guard would pass. Normalize here rather than
  // relying on callers to have done it.
  const candidate = normalizeUrl(url);
  if (PLAIN_HTTP_RE.test(candidate) && !LOCALHOST_HTTP_RE.test(candidate)) {
    throw new Error(
      `${label} must use HTTPS for security (got: ${candidate}). ` +
        "HTTP is only allowed for localhost development.",
    );
  }
}
