/**
 * `auth login --invite` — the feature check that picks how the invite is
 * presented.
 *
 * The link itself is `buildInviteLink` in `auth/deviceFlow.ts`, a pure
 * helper an embedding app can call too. What the CLI adds is this probe:
 * whether the server takes invites at all, and whether its `/join` page
 * honours `return_to` so one link can do the whole job. The Python SDK's
 * `fetch_system_info` and `invite_support`.
 */

import { SDK_VERSION } from "../version.js";
import { meetsMinimum, requireVersion } from "../versionCheck.js";

/**
 * The first memory-cloud release whose `/join/<token>` honours `return_to`.
 *
 * memory-cloud v0.76.0 ships the `/join` → `/device` hand-off
 * (memory-cloud#1655). It came with no capability flag, so the server
 * version is the switch: from 0.76.0 {@link inviteSupport} answers
 * `"hand_off"`, and 0.75.x and older get the two-step fallback.
 */
export const MIN_INVITE_HANDOFF_VERSION = "0.76.0";

/**
 * How long the `/system/info` probe may take.
 *
 * It runs once the device code is issued, so a hung server must not eat
 * into the user's approval window.
 */
export const INVITE_PROBE_TIMEOUT_MS = 5_000;

/**
 * How the invite is presented.
 *
 * - `hand_off` — `/join/<token>?return_to=…` signs up and lands on approval.
 * - `two_step` — the plain `/join/<token>` link, then the approval URL.
 * - `disabled` — the server does not take invite links; log in without one.
 */
export type InviteSupport = "hand_off" | "two_step" | "disabled";

const MIN_INVITE_HANDOFF_TRIPLE = requireVersion(
  MIN_INVITE_HANDOFF_VERSION,
  "MIN_INVITE_HANDOFF_VERSION",
);

/**
 * GET the public `{server}/api/v1/system/info` and return the raw JSON
 * object.
 *
 * Unauthenticated — the route takes no credentials, and there are none yet
 * during login. Best effort, and never throws: a failed or timed-out
 * request, a status other than 200, or a body that is not a non-empty JSON
 * object all yield `null`.
 */
export async function fetchSystemInfo(
  server: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    const response = await fetchImpl(`${server.replace(/\/+$/, "")}/api/v1/system/info`, {
      method: "GET",
      headers: { "User-Agent": `kagura-memory-sdk/${SDK_VERSION}`, Accept: "application/json" },
      signal: AbortSignal.timeout(INVITE_PROBE_TIMEOUT_MS),
    });
    if (response.status !== 200) return null;
    body = JSON.parse(await response.text());
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  return Object.keys(body).length > 0 ? (body as Record<string, unknown>) : null;
}

/**
 * Decide how `--invite` is presented, from a raw `/system/info` body.
 *
 * A `features` object without `beta_invites: true` means invites are off,
 * as memory-cloud's own web app reads it: the flag is default-off, and a
 * server older than the flag (before 0.70.0) has no `/join` route. With no
 * `features` object the body says nothing about invites, so the version
 * decides.
 *
 * The version is read as `versionCheck.ts` reads every server version, so
 * `v0.76.0` and `0.76.0+build.7` hand off, and a pre-release of 0.76.0
 * (`0.76.0-rc.1`, `0.76.0rc1`) comes before it and does not.
 *
 * @returns `disabled` when `features` is an object whose `beta_invites` is
 *   not `true`; `hand_off` when the version is at least
 *   {@link MIN_INVITE_HANDOFF_VERSION}; otherwise `two_step` (no info, or
 *   an older, pre-release-of-0.76.0 or unparseable version), because it
 *   works on every server.
 */
export function inviteSupport(info: Record<string, unknown> | null): InviteSupport {
  if (info === null) {
    return "two_step";
  }
  const features = info.features;
  if (
    typeof features === "object" &&
    features !== null &&
    !Array.isArray(features) &&
    (features as Record<string, unknown>).beta_invites !== true
  ) {
    return "disabled";
  }
  return meetsMinimum(info.version, MIN_INVITE_HANDOFF_TRIPLE) === true ? "hand_off" : "two_step";
}

/** {@link inviteSupport} of what {@link fetchSystemInfo} finds on `server`. */
export async function checkInviteSupport(
  server: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<InviteSupport> {
  return inviteSupport(await fetchSystemInfo(server, fetchImpl));
}
