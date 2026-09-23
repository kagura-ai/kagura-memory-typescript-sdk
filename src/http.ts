/** Shared HTTP utilities for Kagura Memory SDK clients (port of _http.py). */

import {
  KaguraAuthError,
  KaguraConnectionError,
  KaguraRateLimitError,
} from "./errors.js";

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
  const m = /\/mcp(?=\/|$)/.exec(path);
  return m ? path.slice(0, m.index) : path;
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

/**
 * Translate a non-2xx HTTP response into the matching Kagura error.
 *
 * Maps 401 → KaguraAuthError, 429 → KaguraRateLimitError (honoring a
 * numeric `Retry-After` header), and every other status →
 * KaguraConnectionError. The server-supplied detail is appended when
 * present, otherwise `fallbackMessage` is used so the status is never
 * left bare. This function always throws.
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
    throw new KaguraRateLimitError(
      `Rate limit exceeded (HTTP 429): ${detail || `HTTP ${status}`}`,
      retryAfterSeconds(headers),
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
