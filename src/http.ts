/** Shared HTTP utilities for Kagura Memory SDK clients (port of _http.py). */

import {
  KaguraAuthError,
  KaguraConnectionError,
  KaguraError,
  KaguraFeatureNotAvailableError,
  KaguraQuotaError,
  KaguraRateLimitError,
} from "./errors.js";
import type { KaguraQuotaErrorOptions } from "./errors.js";

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
 * Handles five response shapes:
 * - `{"detail": "string"}` — returned as-is (FastAPI HTTPException default).
 * - `{"detail": [{"loc": [...], "msg": "...", ...}, ...]}` — FastAPI's
 *   validation-error format; each entry becomes `"<loc.path>: <msg>"`.
 * - `{"error": "<CODE>", "message": "string", "details": {...}}` — the
 *   memory-cloud canonical envelope; returns `message`, appending
 *   `details.errors` validation entries when present.
 * - `{"jsonrpc": "2.0", "error": {"code": int, "message": "string"}}` — the
 *   MCP transport's 4xx for a request it rejects before dispatch; returns
 *   `error.message`, e.g. the expired-session 404's re-initialize hint.
 * - Anything else — returns an empty string so callers can fall back.
 */
export function extractDetail(bodyText: string): string {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return "";
  }
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
 * MCP envelope codes. `feature_not_available` is the analysis tools'
 * twin of `plan_required`, as REST `FEAT-001` is of both, and
 * `setup_connector` forwards the connector seat cap's REST code
 * `CONNECTOR-001` as is.
 */
export const MCP_GATE_CODES: GateCodes = {
  plan: ["plan_required", "feature_not_available"],
  quota: ["quota_exceeded", "CONNECTOR-001"],
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

/**
 * Which refusal `block` is: `"plan"`, `"quota"`, or `null` for neither.
 *
 * `block` holds the gate fields: the MCP envelope itself, or a REST
 * body's `details`. Its `gate` (memory-cloud v0.75.0+) decides whenever
 * it is one the SDK knows, because the code alone can mislead: the
 * resource-token cap is a quota that answers 403, and the connector seat
 * cap keeps a code of its own. `allowlist` and `deployment` are the other
 * two reasons a feature is unavailable, so they count as `"plan"` — the
 * kind an older server's bare `FEAT-001` already gets. With no gate,
 * `code` decides against the surface's `codes`.
 */
function gateKind(
  block: Record<string, unknown>,
  code: string | null,
  codes: GateCodes,
): "plan" | "quota" | null {
  const gate = stringField(block, "gate");
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
 * The gate payload in `block`, camelCased. Wire keys are snake_case; a
 * missing or wrong-typed one reads as `null` rather than trusting the
 * shape.
 */
function gateOptions(block: Record<string, unknown>): KaguraQuotaErrorOptions {
  return {
    gate: stringField(block, "gate"),
    feature: stringField(block, "feature"),
    requiredPlan: stringField(block, "required_plan"),
    requiredPlanDisplay: stringField(block, "required_plan_display"),
    currentPlan: stringField(block, "current_plan"),
    quotaType: stringField(block, "quota_type"),
    current: numberField(block, "current"),
    limit: numberField(block, "limit"),
    usedToday: numberField(block, "used_today"),
    resetsAt: stringField(block, "resets_at"),
  };
}

/**
 * Build the typed error for a plan or quota refusal, or `null` if it is
 * neither: {@link KaguraFeatureNotAvailableError} or {@link KaguraQuotaError}, as
 * `gateKind` decides, carrying the payload `block` holds.
 */
export function gateError(
  block: Record<string, unknown>,
  code: string | null,
  codes: GateCodes,
  message: string,
  retryAfter: number | null = null,
): KaguraError | null {
  const kind = gateKind(block, code, codes);
  if (kind === null) {
    return null;
  }
  const options = gateOptions(block);
  return kind === "plan"
    ? new KaguraFeatureNotAvailableError(message, options)
    : new KaguraQuotaError(message, retryAfter, options);
}

/**
 * Split a canonical `{"error", "message", "details"}` REST body into its
 * code and details block; `null` for any other body.
 */
export function parseErrorEnvelope(
  bodyText: string,
): { code: string | null; details: Record<string, unknown> } | null {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const rec = body as Record<string, unknown>;
  const details = rec.details;
  return {
    code: typeof rec.error === "string" ? rec.error : null,
    details:
      typeof details === "object" && details !== null && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : {},
  };
}

/**
 * Translate a non-2xx HTTP response into the matching Kagura error.
 *
 * Maps 401 → KaguraAuthError, 429 → KaguraRateLimitError (honoring a
 * numeric `Retry-After` header), and every other status →
 * KaguraConnectionError. The server-supplied detail is appended when
 * present, otherwise `fallbackMessage` is used so the status is never
 * left bare. This function always throws.
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
  const detail = extractDetail(bodyText) || fallbackMessage || "";
  if (status === 429) {
    const envelope = parseErrorEnvelope(bodyText);
    throw new KaguraRateLimitError(
      `Rate limit exceeded (HTTP 429): ${detail || `HTTP ${status}`}`,
      retryAfterSeconds(headers),
      envelope !== null && gateKind(envelope.details, envelope.code, REST_GATE_CODES) === "quota"
        ? gateOptions(envelope.details)
        : {},
    );
  }
  // Avoid a doubled "HTTP 500: HTTP 500" when the body carries no detail.
  throw new KaguraConnectionError(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`);
}

// Plain-HTTP is permitted only for genuine loopback hosts. The host token must
// be followed by a boundary — a port (:\d+), a path/query/fragment delimiter,
// or end-of-string — so a prefix-match attack like http://localhost.evil.com
// or a userinfo trick like http://localhost@evil.com cannot smuggle an
// external host past the check (#189).
// Both patterns are case-insensitive: URL parsing lower-cases the scheme
// and host, so `HTTP://EVIL.TEST` is fetched over plaintext exactly like
// `http://evil.test`. A case-sensitive guard would wave it through.
const PLAIN_HTTP_RE = /^http:\/\//i;
const LOCALHOST_HTTP_RE = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

/**
 * Enforce HTTPS except for localhost development.
 *
 * @throws Error if the URL uses HTTP and is not a loopback host.
 */
export function validateHttpsUrl(url: string, label = "URL"): void {
  // WHATWG URL parsing strips surrounding whitespace, so `" http://x"`
  // reaches the network as plain HTTP. Both patterns are anchored, so
  // without trimming first they would never match it and the guard would
  // pass. Trim here rather than relying on callers to have done it.
  const candidate = url.trim();
  if (PLAIN_HTTP_RE.test(candidate) && !LOCALHOST_HTTP_RE.test(candidate)) {
    throw new Error(
      `${label} must use HTTPS for security (got: ${candidate}). ` +
        "HTTP is only allowed for localhost development.",
    );
  }
}
