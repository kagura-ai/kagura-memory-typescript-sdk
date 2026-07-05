/**
 * OAuth2 RFC 8628 device authorization grant — stateless async helpers
 * (port of auth/device_flow.py).
 *
 * Pure-function API: every entry point takes the server base URL plus the
 * relevant parameters and returns a plain object. No CLI, no terminal IO,
 * no global state.
 *
 * The Python SDK constructs a dedicated unauthenticated `httpx.AsyncClient`
 * so the SDK's `Authorization: Bearer` header cannot leak into `/oauth/*`
 * requests (device-flow uses `client_id` body-parameter authentication, RFC
 * 8628 §3.1 `token_endpoint_auth_method='none'`). With `fetch` there is no
 * client object; the same isolation holds because each request here sets
 * its own headers and never an `Authorization` header. The `fetch`
 * implementation is injectable on every function so tests can stub HTTP.
 */

import { setTimeout as sleepMs } from "node:timers/promises";

import {
  KaguraAuthDeniedError,
  KaguraAuthError,
  KaguraAuthExpiredError,
  KaguraConnectionError,
  excMessage,
} from "../errors.js";
import { extractDetail } from "../http.js";
import { SDK_VERSION } from "../version.js";

// OAuth2 endpoint paths under {server}.
// The path prefix is /api/v1/oauth/ (NOT /oauth2/) per memory-cloud's
// actual mount point; the token endpoint requires the trailing slash.
const PATH_DEVICE_AUTHORIZE = "/api/v1/oauth/device/authorize";
const PATH_TOKEN = "/api/v1/oauth/token/";
const PATH_REVOKE = "/api/v1/oauth/revoke";

// RFC 8628 §3.5 — "slow_down" requires the client to add 5 seconds.
const SLOW_DOWN_INCREMENT_SEC = 5;

/** The pre-registered public client ID seeded by memory-cloud #624. */
export const DEFAULT_CLIENT_ID = "kagura-cli";

export const DEVICE_FLOW_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const REFRESH_TOKEN_GRANT_TYPE = "refresh_token";

/** RFC 8628 §3.2 device authorization response. */
export interface DeviceAuthorizationResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  /** Polling interval in seconds. */
  interval: number;
  /** = now + expiresIn. */
  expiresAt: Date;
}

/**
 * RFC 8628 §3.5 / RFC 6749 §5.1 successful token response.
 *
 * `expiresAt` is computed once at receipt time so a paused or suspended
 * laptop never sees a negative TTL after wake.
 */
export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: Date;
  scope: string;
  userEmail: string;
  workspaceId: string;
  workspaceName: string;
}

/** Common HTTP knobs: injectable `fetch` so tests can stub the transport. */
export interface OAuthHttpOptions {
  fetch?: typeof globalThis.fetch;
}

function userAgent(): string {
  return `kagura-memory-sdk/${SDK_VERSION}`;
}

function tokenUrl(server: string): string {
  return `${server.replace(/\/+$/, "")}${PATH_TOKEN}`;
}

/** Coerce an unknown JSON value to a whole number, or `null`. */
function toInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Parse a 200 response body as a JSON object.
 *
 * Converts malformed / non-object success bodies into a `KaguraAuthError`
 * with HTTP status + truncated body, so a server that wedges and returns
 * HTML / a JSON array / a scalar doesn't surface as an unhelpful
 * `SyntaxError`.
 */
function safeJsonObject(
  bodyText: string,
  status: number,
  endpoint: string,
): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch (e) {
    const detail = bodyText.slice(0, 200);
    throw new KaguraAuthError(
      `${endpoint} returned HTTP ${status} but body is not JSON: ${excMessage(e)}. ` +
        `Body: ${detail}`,
      { cause: e },
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new KaguraAuthError(
      `${endpoint} returned HTTP ${status} but body is not a JSON object ` +
        `(got ${Array.isArray(body) ? "array" : typeof body})`,
    );
  }
  return body as Record<string, unknown>;
}

/** Parse a response body as a JSON object, or `{}` if unparseable. */
function safeJson(bodyText: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {};
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}

/**
 * Build a `TokenResponse` from a 200 `/oauth/token/` body.
 *
 * `expiresAt` is computed from `expires_in` at receipt time so laptop sleep
 * / clock skew won't yield a negative TTL after wake. Missing or invalid
 * required fields surface as `KaguraAuthError`.
 */
function tokenResponseFromBody(bodyText: string, status: number): TokenResponse {
  const body = safeJsonObject(bodyText, status, "Token endpoint");
  const accessToken = body.access_token;
  const expiresIn = toInt(body.expires_in ?? 0);
  if (typeof accessToken !== "string" || expiresIn === null) {
    throw new KaguraAuthError(
      `Token endpoint returned HTTP ${status} but body is missing required fields. ` +
        `Body keys: ${Object.keys(body).sort().join(", ")}`,
    );
  }
  return {
    accessToken,
    refreshToken: stringOr(body.refresh_token, ""),
    tokenType: stringOr(body.token_type, "Bearer"),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scope: stringOr(body.scope, ""),
    userEmail: stringOr(body.user_email, ""),
    workspaceId: stringOr(body.workspace_id, ""),
    workspaceName: stringOr(body.workspace_name, ""),
  };
}

/**
 * POST `{server}/api/v1/oauth/device/authorize` and parse the response.
 *
 * memory-cloud's device/authorize accepts JSON, unlike the /oauth/token/ +
 * /oauth/revoke endpoints which take application/x-www-form-urlencoded.
 */
export async function authorizeDevice(
  server: string,
  options: OAuthHttpOptions & { clientId?: string; scope?: string } = {},
): Promise<DeviceAuthorizationResponse> {
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const scope = options.scope ?? "memory:read";
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${server.replace(/\/+$/, "")}${PATH_DEVICE_AUTHORIZE}`;

  let response: Response;
  let text: string;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        "User-Agent": userAgent(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ client_id: clientId, scope }),
    });
    text = await response.text();
  } catch (e) {
    throw new KaguraConnectionError(`Could not reach ${url}: ${excMessage(e)}`, { cause: e });
  }

  if (!response.ok) {
    const detail = extractDetail(text) || text;
    throw new KaguraAuthError(
      `Device authorization failed (HTTP ${response.status}): ${detail}\n` +
        `  Verify the server URL and that '${clientId}' is registered.`,
    );
  }

  const body = safeJsonObject(text, response.status, "Device authorization");
  const deviceCode = body.device_code;
  const userCode = body.user_code;
  const verificationUri = body.verification_uri;
  const expiresIn = toInt(body.expires_in);
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    expiresIn === null
  ) {
    throw new KaguraAuthError(
      "Device authorization returned HTTP 200 but body is missing required fields. " +
        `Body keys: ${Object.keys(body).sort().join(", ")}`,
    );
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: stringOr(body.verification_uri_complete, verificationUri),
    expiresIn,
    interval: toInt(body.interval) ?? 5,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

export interface PollForTokenOptions extends OAuthHttpOptions {
  clientId: string;
  deviceCode: string;
  /** RFC 8628 polling interval in seconds. */
  interval: number;
  expiresAt: Date;
  /**
   * Injectable sleep (milliseconds) so tests can supply a no-op or
   * counter-based stub without waiting real seconds.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll `{server}/api/v1/oauth/token/` until the user approves or denies.
 *
 * The first poll fires immediately (no initial sleep) so a fast approval
 * never waits a whole interval; sleeps only happen between retries after
 * `authorization_pending` / `slow_down`.
 *
 * @throws KaguraAuthDeniedError user clicked "Deny" at the consent screen
 *   (server returns `access_denied`).
 * @throws KaguraAuthExpiredError the `device_code` lifetime elapsed without
 *   approval (server returns `expired_token`, or `expiresAt` passed locally).
 * @throws KaguraAuthError any other OAuth error or unexpected response.
 * @throws KaguraConnectionError network failure during polling.
 */
export async function pollForToken(
  server: string,
  options: PollForTokenOptions,
): Promise<TokenResponse> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? (async (ms: number): Promise<void> => void (await sleepMs(ms)));
  const url = tokenUrl(server);

  let currentInterval = options.interval;
  let firstPoll = true;

  for (;;) {
    if (Date.now() >= options.expiresAt.getTime()) {
      throw new KaguraAuthExpiredError(
        "Device code expired before user approval. Run: kagura auth login",
        options.expiresAt,
      );
    }

    // Skip the initial sleep so an immediate approval (or a fast
    // server-side error) doesn't wait one whole interval.
    if (firstPoll) {
      firstPoll = false;
    } else {
      await sleep(currentInterval * 1000);
    }

    let response: Response;
    let text: string;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "User-Agent": userAgent() },
        body: new URLSearchParams({
          grant_type: DEVICE_FLOW_GRANT_TYPE,
          device_code: options.deviceCode,
          client_id: options.clientId,
        }),
      });
      text = await response.text();
    } catch (e) {
      throw new KaguraConnectionError(
        `Lost connection while waiting for approval: ${excMessage(e)}\n` +
          `  The login session may still be valid; re-run: kagura auth login`,
        { cause: e },
      );
    }

    if (response.status === 200) {
      return tokenResponseFromBody(text, response.status);
    }

    // RFC 8628 §3.5 — errors come as HTTP 4xx with JSON `error` field.
    const body = safeJson(text);
    const error = stringOr(body.error, "");

    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      currentInterval += SLOW_DOWN_INCREMENT_SEC;
      continue;
    }
    if (error === "access_denied") {
      throw new KaguraAuthDeniedError(
        "Authorization denied at the consent screen.\n" +
          "  Re-run: kagura auth login\n" +
          "  To use a different workspace, log in with that account " +
          "in your browser first.",
      );
    }
    if (error === "expired_token") {
      throw new KaguraAuthExpiredError(
        "Device code expired before user approval. Run: kagura auth login",
        options.expiresAt,
      );
    }

    // Unknown error — surface the HTTP status + raw response so the
    // operator can debug non-OAuth failures (HTML 5xx, proxy errors,
    // non-JSON bodies that make `error` come back empty).
    const description = stringOr(body.error_description, "");
    if (error || description) {
      throw new KaguraAuthError(
        `Token endpoint returned unexpected error '${error}': ${description}`,
      );
    }
    const detail = extractDetail(text) || text.slice(0, 200);
    throw new KaguraAuthError(
      `Token endpoint returned HTTP ${response.status} with no OAuth error code. ` +
        `Body: ${detail}`,
    );
  }
}

export interface RefreshAccessTokenOptions extends OAuthHttpOptions {
  clientId: string;
  refreshToken: string;
  scope?: string | null;
}

/**
 * POST `{server}/api/v1/oauth/token/` with `grant_type=refresh_token`.
 *
 * When `scope` is supplied, the server may reject the call with
 * `insufficient_scope` / `invalid_scope` if the grant doesn't cover it.
 *
 * @throws KaguraAuthExpiredError refresh token is invalid or expired
 *   (server returns `invalid_grant`).
 * @throws KaguraAuthError any other OAuth error.
 * @throws KaguraConnectionError network failure.
 */
export async function refreshAccessToken(
  server: string,
  options: RefreshAccessTokenOptions,
): Promise<TokenResponse> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = tokenUrl(server);
  const form = new URLSearchParams({
    grant_type: REFRESH_TOKEN_GRANT_TYPE,
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  });
  if (options.scope !== undefined && options.scope !== null) {
    form.set("scope", options.scope);
  }

  let response: Response;
  let text: string;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { "User-Agent": userAgent() },
      body: form,
    });
    text = await response.text();
  } catch (e) {
    throw new KaguraConnectionError(`Could not reach ${url}: ${excMessage(e)}`, { cause: e });
  }

  if (response.status === 200) {
    return tokenResponseFromBody(text, response.status);
  }

  const body = safeJson(text);
  const error = stringOr(body.error, "");

  if (error === "invalid_grant") {
    throw new KaguraAuthExpiredError(
      "Your login expired (refresh token is no longer valid).\n" +
        "  Run: kagura auth login\n" +
        "  Your server and workspace selection are preserved.",
    );
  }

  const description = stringOr(body.error_description, "");
  if (error) {
    throw new KaguraAuthError(
      `Refresh failed: ${error}${description ? ` — ${description}` : ""}`,
    );
  }
  // Non-OAuth failure (HTML 5xx, network proxy returning text/plain, etc.).
  const detail = extractDetail(text) || text.slice(0, 200);
  throw new KaguraAuthError(
    `Refresh failed: HTTP ${response.status} with no OAuth error code. Body: ${detail}`,
  );
}

/**
 * POST `{server}/api/v1/oauth/revoke`. Best-effort — never throws.
 *
 * Returns `true` on success, `false` on any failure. The caller
 * (`kagura auth logout`) deletes the local profile regardless of the
 * return value, on the principle that local logout must succeed even when
 * the server is unreachable.
 */
export async function revokeToken(
  server: string,
  options: OAuthHttpOptions & { token: string; clientId?: string },
): Promise<boolean> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${server.replace(/\/+$/, "")}${PATH_REVOKE}`;
  try {
    const response = await doFetch(url, {
      method: "POST",
      headers: { "User-Agent": userAgent() },
      body: new URLSearchParams({
        token: options.token,
        client_id: options.clientId ?? DEFAULT_CLIENT_ID,
      }),
    });
    return response.status === 200 || response.status === 204;
  } catch {
    return false;
  }
}
