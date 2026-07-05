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
 * Strips `/mcp` and everything after it (e.g. `/mcp/w/{workspace}`).
 */
export function baseUrlFromMcp(mcpUrl: string): string {
  const m = /\/mcp(?=\/|$)/.exec(mcpUrl);
  return m ? mcpUrl.slice(0, m.index) : mcpUrl;
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

/**
 * Return a useful server-supplied error string from a response body.
 *
 * Handles four response shapes:
 * - `{"detail": "string"}` — returned as-is (FastAPI HTTPException default).
 * - `{"detail": [{"loc": [...], "msg": "...", ...}, ...]}` — FastAPI's
 *   validation-error format; each entry becomes `"<loc.path>: <msg>"`.
 * - `{"error": "<CODE>", "message": "string", "details": {...}}` — the
 *   memory-cloud canonical envelope; returns `message`, appending
 *   `details.errors` validation entries when present.
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
  return "";
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
const LOCALHOST_HTTP_RE = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/;

/**
 * Enforce HTTPS except for localhost development.
 *
 * @throws Error if the URL uses HTTP and is not a loopback host.
 */
export function validateHttpsUrl(url: string, label = "URL"): void {
  if (url.startsWith("http://") && !LOCALHOST_HTTP_RE.test(url)) {
    throw new Error(
      `${label} must use HTTPS for security (got: ${url}). ` +
        "HTTP is only allowed for localhost development.",
    );
  }
}
