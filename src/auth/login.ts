/**
 * Interactive OAuth login — the one step the SDK could not do on its own.
 *
 * `deviceFlow.ts` provides the stateless RFC 8628 primitives and
 * `credentials.ts` the Python-CLI-compatible store; this module is the thin
 * orchestrator that joins them: authorize → hand the user code to the host
 * app → poll → persist. It is what lets a TypeScript-only consumer (an
 * Electron app, a CLI of its own) obtain credentials instead of requiring
 * the user to install and run the Python `kagura auth login` first.
 *
 * Deliberately still no terminal IO and no browser launching: `onUserCode`
 * hands the code and verification URI back to the caller, which owns how it
 * is displayed. The only side effect is the credentials file write.
 */

import { KaguraAuthError } from "../errors.js";
import { baseUrlFromMcp } from "../http.js";
import type { OAuthCredentials } from "./credentials.js";
import { setDefaultProfile, updateProfile } from "./credentials.js";
import { authorizeDevice, pollForToken, DEFAULT_CLIENT_ID } from "./deviceFlow.js";
import type { DeviceAuthorizationResponse } from "./deviceFlow.js";
import { DEFAULT_MCP_URL } from "./resolve.js";

export interface LoginOptions {
  /**
   * MCP endpoint to log into (default {@link DEFAULT_MCP_URL}). The OAuth
   * endpoints are derived from it, and both URLs are stored on the profile
   * so the pair can never drift apart.
   */
  mcpUrl?: string;
  /** OAuth client ID (default {@link DEFAULT_CLIENT_ID}). */
  clientId?: string;
  /**
   * Requested scope. Defaults to the device-flow default (`memory:read`),
   * which is **read-only** — pass a wider scope (e.g.
   * `"memory:read memory:write"`) if the credentials need to write.
   */
  scope?: string;
  /** Profile name to store under (default `"default"`). */
  profile?: string;
  /** Credentials file path (default `~/.kagura/credentials.json`). */
  credentialsPath?: string;
  /**
   * Make this profile the default even when others already exist.
   *
   * Off by default: the first profile ever written is promoted
   * automatically, so adding a second one leaves the user's existing
   * default alone unless they ask for the switch.
   */
  setAsDefault?: boolean;
  /**
   * Called once with the device-authorization response before polling
   * starts — display `userCode` and `verificationUri` (or open
   * `verificationUriComplete`) here.
   *
   * Awaited, and a throw aborts the login before any polling or disk
   * write, so a host app that cannot show the code fails fast.
   */
  onUserCode?: (auth: DeviceAuthorizationResponse) => void | Promise<void>;
  /** Injectable fetch (tests / custom agents). */
  fetch?: typeof globalThis.fetch;
  /** Injectable sleep in milliseconds, used between polls. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run the full device-authorization login and persist the result.
 *
 * @returns the credentials that were written.
 * @throws KaguraAuthDeniedError the user denied at the consent screen.
 * @throws KaguraAuthExpiredError the device code expired before approval.
 * @throws KaguraAuthError the token response carried no refresh token, or
 *   (propagated from the device-flow primitives) a protocol/response
 *   failure.
 * @throws KaguraConnectionError the server was unreachable.
 *
 * Nothing is written unless the token exchange succeeds AND yields a
 * refresh token; a failed login never disturbs an existing profile.
 */
export async function login(options: LoginOptions = {}): Promise<OAuthCredentials> {
  const mcpUrl = options.mcpUrl ?? DEFAULT_MCP_URL;
  const server = baseUrlFromMcp(mcpUrl);
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const profile = options.profile ?? "default";

  const authorization = await authorizeDevice(server, {
    clientId,
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });

  await options.onUserCode?.(authorization);

  const token = await pollForToken(server, {
    clientId,
    deviceCode: authorization.deviceCode,
    interval: authorization.interval,
    expiresAt: authorization.expiresAt,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
  });

  // pollForToken defaults a missing refresh_token to "". Persisting that
  // would write a profile this SDK can never auto-refresh: the login looks
  // like it succeeded, then dies at the first expiry with a bare
  // "your login expired". Fail here, while the cause is still visible.
  if (!token.refreshToken) {
    throw new KaguraAuthError(
      "Login succeeded but the token response carried no refresh_token, so " +
        "the profile could not auto-refresh. Nothing was written. Verify the " +
        `'${clientId}' client is allowed offline access on ${server}.`,
    );
  }

  const credentials: OAuthCredentials = {
    server,
    mcpUrl,
    clientId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    tokenType: token.tokenType,
    expiresAt: token.expiresAt,
    scope: token.scope,
    workspaceId: token.workspaceId,
    workspaceName: token.workspaceName,
    userEmail: token.userEmail,
    issuedAt: new Date(),
  };

  await updateProfile(profile, credentials, options.credentialsPath);
  if (options.setAsDefault) {
    await setDefaultProfile(profile, options.credentialsPath);
  }
  return credentials;
}
