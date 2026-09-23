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
import { extractDetail, retryAfterSeconds, validateHttpsUrl } from "../http.js";
import { SDK_VERSION } from "../version.js";

// OAuth2 endpoint paths under {server}.
// The path prefix is /api/v1/oauth/ (NOT /oauth2/) per memory-cloud's
// actual mount point; the token endpoint requires the trailing slash.
const PATH_DEVICE_AUTHORIZE = "/api/v1/oauth/device/authorize";
const PATH_TOKEN = "/api/v1/oauth/token/";
const PATH_REVOKE = "/api/v1/oauth/revoke";

// RFC 8628 §3.5 — "slow_down" requires the client to add 5 seconds.
const SLOW_DOWN_INCREMENT_SEC = 5;

// memory-cloud's per-IP device-flow window (memory-cloud#1656, v0.76.0): the
// wait to report when a 429 carries no usable Retry-After.
const DEVICE_RATE_LIMIT_RETRY_AFTER_SEC = 60;

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
 * The server's reason from an error body: whatever `extractDetail` finds,
 * else an RFC 6749 `error_description`. The Python SDK's `extract_detail`
 * reads that last shape too; the OAuth endpoints answer with it.
 */
function oauthDetail(bodyText: string): string {
  return extractDetail(bodyText) || stringOr(safeJson(bodyText).error_description, "");
}

/**
 * Explain a 429 from `device/authorize`, with the wait from `Retry-After`.
 *
 * memory-cloud v0.76.0 limits `device/authorize` per client address and
 * answers 429 with `Retry-After: 60` and an RFC 6749 `error_description`,
 * which is kept. A missing or non-numeric `Retry-After` reads as that same
 * 60 s window. The Python CLI's wording.
 */
function deviceRateLimitedMessage(headers: Headers, bodyText: string): string {
  const retryAfter = retryAfterSeconds(headers) ?? DEVICE_RATE_LIMIT_RETRY_AFTER_SEC;
  const message =
    "Too many sign-in attempts from this address (HTTP 429). " +
    `Retry after ${retryAfter} seconds.`;
  const detail = oauthDetail(bodyText);
  return detail ? `${message}\n  Server said: ${detail}` : message;
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
 *
 * @throws KaguraAuthError the server refused the request. A 429
 *   (memory-cloud v0.76.0+ limits this endpoint per client address) says
 *   how long to wait, from `Retry-After`.
 * @throws KaguraConnectionError network failure.
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

  if (response.status === 429) {
    throw new KaguraAuthError(deviceRateLimitedMessage(response.headers, text));
  }
  if (!response.ok) {
    const detail = oauthDetail(text) || text;
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

// memory-cloud's beta-invite token shape (its beta_invite_service). Checked
// client-side so a mistyped invite fails before any request, not at sign-up.
const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

/** An invite reduced to what the `/join` hand-off needs. */
export interface ParsedInvite {
  token: string;
  /** Origin of a pasted `/join/<token>` link; `null` for a bare token. */
  origin: string | null;
  /**
   * The pasted link without its query or fragment; `null` for a bare
   * token. Step one of the two-step prompt when `/join` cannot be placed
   * on the frontend.
   */
  link: string | null;
}

/**
 * `value` as a URL when it is http(s) and passes the same HTTPS rule as
 * `--server` (plain HTTP only for localhost); `null` otherwise. Every URL
 * the invite token travels in is held to it.
 */
function secureWebUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  try {
    validateHttpsUrl(url.origin);
  } catch {
    return null;
  }
  return url;
}

/**
 * Read an invite given as a bare token or as a link whose path ends in
 * `/join/<token>`. The link may sit under a base path and end in a slash;
 * any query or fragment is ignored. It must pass the `--server` HTTPS rule,
 * since it carries the token.
 *
 * Returns `null` instead of throwing because the natural error would quote
 * the input, and the token is a sign-up credential: callers word their own
 * error without it.
 */
export function parseInvite(value: string): ParsedInvite | null {
  const text = value.trim();
  if (INVITE_TOKEN_RE.test(text)) {
    return { token: text, origin: null, link: null };
  }
  const url = secureWebUrl(text);
  if (url === null) {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "");
  const token = /\/join\/([^/]*)$/.exec(path)?.[1];
  if (token === undefined || !INVITE_TOKEN_RE.test(token)) {
    return null;
  }
  return { token, origin: url.origin, link: `${url.origin}${path}` };
}

/**
 * The frontend's base URL: `verificationUri` minus its final `/device`.
 *
 * memory-cloud builds `verificationUri` as `{frontend_url}/device`, and it
 * is the only frontend location the CLI learns — `--server` is the API,
 * which can live on another origin. `null` when the URI does not end in a
 * `/device` segment or fails the `--server` HTTPS rule: `/join` cannot
 * then be placed safely.
 */
export function inviteBaseUrl(verificationUri: string): string | null {
  const url = secureWebUrl(verificationUri);
  if (url === null) {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/device")) {
    return null;
  }
  return `${url.origin}${path.slice(0, -"/device".length)}`;
}

/**
 * The one link that signs a new account up with an invite and lands it on
 * the approval page with the code filled in:
 * `<base>/join/<token>?return_to=<path and query of verificationUriComplete>`.
 *
 * The Python SDK's `build_invite_link`, argument for argument. Pure, and
 * meant for `login()`'s `onUserCode` — the first point where both the
 * invite and the user code are known. `base` is {@link inviteBaseUrl}: the
 * frontend serves `/join` beside `/device`, under whatever base path it
 * has. `return_to` is the relative path the server validates as
 * same-origin. `authorizeDevice` fills a missing `verification_uri_complete`
 * with the bare `verificationUri`, which lands on an empty code form; the
 * CLI passes `verificationUri` plus `?user_code=` in that case.
 *
 * Needs a memory-cloud whose `/join` honours `return_to` (memory-cloud
 * #1655). An older one signs the user up and stops on its dashboard, where
 * `verificationUriComplete` still approves the pending code — so show that
 * too.
 *
 * @param token a bare invite token; a pasted link reduced to its token.
 * @returns the link, or `null` when `/join` cannot be placed:
 *   `verificationUri` does not end in `/device` or is plain HTTP off
 *   localhost, or `verificationUriComplete` is on another origin.
 * @throws KaguraAuthError the token is malformed (the message never
 *   quotes it).
 */
export function buildInviteLink(
  verificationUri: string,
  verificationUriComplete: string,
  token: string,
): string | null {
  if (!INVITE_TOKEN_RE.test(token)) {
    throw new KaguraAuthError(
      "An invite token must be 20-128 characters from A-Z, a-z, 0-9, '_' and '-'.",
    );
  }
  const base = inviteBaseUrl(verificationUri);
  const complete = secureWebUrl(verificationUriComplete);
  if (
    base === null ||
    complete === null ||
    complete.origin !== new URL(verificationUri).origin
  ) {
    return null;
  }
  const returnTo = `${complete.pathname}${complete.search}`;
  return `${base}/join/${token}?return_to=${encodeURIComponent(returnTo)}`;
}

/**
 * Refuse a pasted invite link whose origin is not the frontend's.
 *
 * The frontend's origin is `verificationUri`'s — `--server` is the API,
 * which can differ. A link is never rewritten onto another host, so a
 * mismatch means the login is going to the wrong server. A bare token
 * carries no origin and always passes.
 *
 * @throws KaguraAuthError the origins differ. The message names both,
 *   never the token.
 */
export function checkInviteOrigin(invite: ParsedInvite, verificationUri: string): void {
  if (invite.origin === null) {
    return;
  }
  let frontend: string;
  try {
    frontend = new URL(verificationUri).origin;
  } catch {
    frontend = verificationUri;
  }
  if (invite.origin !== frontend) {
    throw new KaguraAuthError(
      `This invite is for a different server (${invite.origin}) than the one ` +
        `you are logging in to (${frontend}).`,
    );
  }
}
