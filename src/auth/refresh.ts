/**
 * Explicit credential refresh — the `kagura auth refresh` counterpart.
 *
 * Auto-refresh already happens inside {@link KaguraOAuth} as tokens near
 * expiry, so this is for the cases that skew-driven rotation cannot cover:
 * a token revoked out-of-band (rejected server-side while still outside
 * the skew window), a deliberate scope change, or a pre-flight refresh
 * before a long batch.
 *
 * Like `login()`, this owns no terminal IO — the device-flow fallback
 * hands the user code back through `onUserCode`.
 */

import { KaguraAuthError } from "../errors.js";
import type { OAuthCredentials } from "./credentials.js";
import { loadCredentialsFile, updateProfile, withRefreshed } from "./credentials.js";
import { authorizeDevice, pollForToken, refreshAccessToken } from "./deviceFlow.js";
import type { DeviceAuthorizationResponse } from "./deviceFlow.js";

export interface RefreshOptions {
  /** Profile to refresh (default: the file's default profile). */
  profile?: string;
  /** Credentials file path (default `~/.kagura/credentials.json`). */
  credentialsPath?: string;
  /**
   * Request a different scope.
   *
   * Narrowing goes through the refresh grant silently. Widening needs
   * fresh consent, so a server rejection triggers a full device flow —
   * see {@link RefreshOptions.onUserCode}.
   */
  scope?: string;
  /**
   * Called with the device-authorization response when a scope widening
   * forces re-consent. Required in practice for that path: without it the
   * user is never shown the code, and polling times out.
   */
  onUserCode?: (auth: DeviceAuthorizationResponse) => void | Promise<void>;
  /** Injectable fetch (tests / custom agents). */
  fetch?: typeof globalThis.fetch;
  /** Injectable sleep in milliseconds, used between device-flow polls. */
  sleep?: (ms: number) => Promise<void>;
}

/** Whether an auth failure is the server refusing a wider grant. */
function isScopeRejection(error: unknown): boolean {
  if (!(error instanceof KaguraAuthError)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("insufficient_scope") || message.includes("invalid_scope");
}

/**
 * Refresh a stored profile's access token and persist the result.
 *
 * @returns the credentials that were written.
 * @throws Error if the named profile does not exist.
 * @throws KaguraAuthExpiredError the refresh token is no longer valid —
 *   the stored profile is left untouched so it can still be inspected.
 * @throws KaguraAuthError other protocol/response failures.
 * @throws KaguraConnectionError the server was unreachable.
 */
export async function refresh(options: RefreshOptions = {}): Promise<OAuthCredentials> {
  const cf = loadCredentialsFile(options.credentialsPath);
  const target = options.profile || cf.defaultProfile;
  const stored = cf.profiles[target];
  if (stored === undefined) {
    throw new Error(`No profile named '${target}'. Run a login first.`);
  }

  const httpOptions = options.fetch !== undefined ? { fetch: options.fetch } : {};

  let next: OAuthCredentials;
  try {
    const token = await refreshAccessToken(stored.server, {
      clientId: stored.clientId,
      refreshToken: stored.refreshToken,
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
      ...httpOptions,
    });
    // withRefreshed preserves the stored refresh token when the server
    // omits a new one (RFC 6749 §10.4) and the prior scope when the
    // server omits that — along with workspace/user identity, which a
    // refresh response is not required to repeat.
    next = withRefreshed(stored, {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken || null,
      expiresAt: token.expiresAt,
      scope: token.scope || null,
    });
  } catch (e) {
    // A rejection only means "widen" when the caller actually asked for a
    // different scope; otherwise re-consent would be the wrong response
    // to what is simply a failed refresh.
    if (options.scope === undefined || !isScopeRejection(e)) {
      throw e;
    }
    next = await consentToWiderScope(stored, options.scope, options, httpOptions);
  }

  await updateProfile(target, next, options.credentialsPath);
  return next;
}

/**
 * Re-run the device flow to collect consent for a wider grant.
 *
 * Mirrors the Python CLI's fallback: narrowing succeeds through the
 * refresh grant, widening needs the user to approve again. Diverging here
 * would make `--scope` widening behave differently between the two SDKs
 * on the credentials file they share.
 */
async function consentToWiderScope(
  stored: OAuthCredentials,
  scope: string,
  options: RefreshOptions,
  httpOptions: { fetch?: typeof globalThis.fetch },
): Promise<OAuthCredentials> {
  const authorization = await authorizeDevice(stored.server, {
    clientId: stored.clientId,
    scope,
    ...httpOptions,
  });

  await options.onUserCode?.(authorization);

  const token = await pollForToken(stored.server, {
    clientId: stored.clientId,
    deviceCode: authorization.deviceCode,
    interval: authorization.interval,
    expiresAt: authorization.expiresAt,
    ...httpOptions,
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
  });

  // A fresh grant carries its own identity fields; fall back to the
  // stored ones only where the response is silent.
  return {
    ...stored,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken || stored.refreshToken,
    tokenType: token.tokenType,
    expiresAt: token.expiresAt,
    scope: token.scope || scope,
    workspaceId: token.workspaceId || stored.workspaceId,
    workspaceName: token.workspaceName || stored.workspaceName,
    userEmail: token.userEmail || stored.userEmail,
    issuedAt: new Date(),
  };
}
