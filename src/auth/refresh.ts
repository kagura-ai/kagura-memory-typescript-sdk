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
import type { OAuthCredentials, RefreshResult } from "./credentials.js";
import {
  RefreshNotSavedError,
  keepUnsaved,
  loadCredentialsFile,
  refreshSharedState,
  saveFailureReason,
  sharedStateFrom,
  updateProfile,
} from "./credentials.js";
import { authorizeDevice, pollForToken } from "./deviceFlow.js";
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
 * The refresh runs under the cross-process lock on the credentials file,
 * after re-reading it: when another process (a client, `kagura-memory-mcp`,
 * another CLI) already rotated the token, its profile is returned and
 * nothing is sent — a refresh token works once (memory-cloud v0.79.0+).
 *
 * @returns the credentials now in force.
 * @throws Error if the named profile does not exist — also when the
 *   credentials file cannot be read or parsed, which reads as holding no
 *   profile, as Python's `kagura auth refresh` reads it; nothing is sent
 *   and the file is left as it is.
 * @throws KaguraAuthExpiredError the refresh token is no longer valid —
 *   the stored profile is left untouched so it can still be inspected.
 * @throws KaguraAuthError other protocol/response failures; also when the
 *   credentials file became unreadable by the time the lock is held
 *   (before any request, and the file is left as it is), or when the
 *   refreshed profile — or the grant a widening `scope` collected — could
 *   not be saved (the message names the file; this process keeps the new
 *   token in memory).
 * @throws KaguraConnectionError the server was unreachable.
 */
export async function refresh(options: RefreshOptions = {}): Promise<OAuthCredentials> {
  return (await refreshProfile(options)).credentials;
}

/**
 * What {@link refreshProfile} did: the profile it refreshed, and whether
 * it was refreshed here or adopted from another process.
 *
 * @internal Not exported from the package entry point.
 */
export interface ProfileRefreshResult extends RefreshResult {
  /** The profile name the refresh resolved (`options.profile` or the default). */
  profile: string;
}

/**
 * {@link refresh}, also saying which profile and whether this call
 * refreshed it — what `kagura-memory auth refresh` prints.
 *
 * @internal Not exported from the package entry point.
 */
export async function refreshProfile(options: RefreshOptions = {}): Promise<ProfileRefreshResult> {
  // Lenient, as Python's CLI reads it first: a file that cannot be read
  // holds no profile here. The refresh path refuses it under the lock,
  // before any request, if it became unreadable after this read.
  const cf = loadCredentialsFile(options.credentialsPath);
  const target = options.profile || cf.defaultProfile;

  // The shared state, not a copy: a client of this process holding the
  // same profile sees the rotated token, and the refresh is serialized with
  // its own on the in-process mutex.
  const state = sharedStateFrom(cf, options.credentialsPath, target);
  if (state === null) {
    throw new Error(`No profile named '${target}'.\n  Run: kagura-memory auth login`);
  }

  const httpOptions = options.fetch !== undefined ? { fetch: options.fetch } : {};

  // Forced path, as on a 401: refresh unless the file no longer holds the
  // token read here (another process rotated it while this one waited).
  const staleToken = state.credentials.accessToken;
  try {
    const result = await state.mutex.runExclusive(() =>
      refreshSharedState(state, {
        expectedStaleToken: staleToken,
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        ...httpOptions,
      }),
    );
    return { ...result, profile: target };
  } catch (e) {
    // A rejection only means "widen" when the caller actually asked for a
    // different scope; otherwise re-consent would be the wrong response
    // to what is simply a failed refresh.
    if (options.scope === undefined || !isScopeRejection(e)) {
      throw e;
    }
    // Runs outside the lock — the refresh released it on the way out, and
    // updateProfile below re-acquires it, so there is no deadlock. The
    // device flow waits on the user for minutes: holding the lock that
    // long would stall every other process's refresh.
    const before = state.credentials;
    const next = await consentToWiderScope(before, options.scope, options, httpOptions);
    try {
      await updateProfile(target, next, options.credentialsPath);
    } catch (saveError) {
      // As a refresh that could not be saved: the consented grant exists
      // only here, so this process keeps it, and the profile on file (the
      // one this process already marked, or the one it held) stays behind.
      const onFile = state.usedRefreshToken
        ? { accessToken: state.usedAccessToken ?? "", refreshToken: state.usedRefreshToken }
        : before;
      const error = new RefreshNotSavedError(
        `Got consent for scope '${options.scope}' on profile '${target}', but could not save it to ` +
          `${state.path}: ${saveFailureReason(saveError)}\n` +
          "  The profile on file keeps its previous grant.\n" +
          `  Fix the cause, then run: kagura-memory auth refresh --scope "${options.scope}"`,
        next,
        onFile,
        { cause: saveError },
      );
      keepUnsaved(state, error);
      throw error;
    }
    state.credentials = next;
    state.usedRefreshToken = null;
    state.usedAccessToken = null;
    return { credentials: next, refreshed: true, profile: target };
  }
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
  // Without a way to show the code, polling would just run until the
  // device code expires. Fail now, while the cause is still legible.
  if (options.onUserCode === undefined) {
    throw new KaguraAuthError(
      `Widening the scope to '${scope}' needs fresh consent, which requires ` +
        "showing the user a device code — pass onUserCode to refresh(). " +
        "Narrowing a scope does not need consent and works without it.",
    );
  }

  const authorization = await authorizeDevice(stored.server, {
    clientId: stored.clientId,
    scope,
    ...httpOptions,
  });

  await options.onUserCode(authorization);

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
