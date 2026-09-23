/**
 * `auth login --invite` — the feature check that picks how the invite is
 * presented.
 *
 * The link itself is `buildInviteLink` in `auth/deviceFlow.ts`, a pure
 * helper an embedding app can call too. What the CLI adds is this probe:
 * whether the server takes invites at all, and whether its `/join` page
 * honours `return_to` so one link can do the whole job.
 */

import { SDK_VERSION } from "../version.js";

/**
 * The first memory-cloud release whose `/join/<token>` honours `return_to`
 * (memory-cloud #1655, milestoned v0.76.0).
 *
 * If the hand-off ships in a later release, bump this: a server below it is
 * sent the two-step fallback, which works everywhere, so the cost of a
 * value that is too high is one extra click — too low, and a new user is
 * signed up and stranded on the dashboard.
 */
export const MIN_INVITE_HANDOFF_VERSION = "0.76.0";

const MIN_INVITE_HANDOFF_TUPLE = MIN_INVITE_HANDOFF_VERSION.split(".").map(Number);

// Best effort: the device code is not issued until this settles, so a hung
// server must not hold the login up for fetch's unbounded default.
const PROBE_TIMEOUT_MS = 10_000;

/**
 * How the invite is presented.
 *
 * - `one-link` — `/join/<token>?return_to=…` signs up and lands on approval.
 * - `two-step` — the plain `/join/<token>` link, then the approval URL.
 * - `off` — the server does not take invite links; log in without one.
 */
export type InviteSupport = "one-link" | "two-step" | "off";

/**
 * `"0.76.0"` → `[0, 76, 0]`, or `null` when unparseable.
 *
 * The same reading as `KaguraClient.checkServerVersion`: the first three
 * dot-separated components, each strictly digits — `Number("")` is 0 and
 * `Number("1e2")` is 100, so NaN alone would not catch them.
 */
function versionTuple(version: unknown): number[] | null {
  if (typeof version !== "string") return null;
  const components = version.split(".").slice(0, 3);
  if (!components.every((c) => /^\d+$/.test(c))) return null;
  return components.map(Number);
}

function atLeast(version: number[], min: number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const have = version[i] ?? 0;
    const want = min[i] ?? 0;
    if (have !== want) return have > want;
  }
  return true;
}

/**
 * Ask `{server}/api/v1/system/info` how to present an invite.
 *
 * Unauthenticated — the route takes no credentials — and never throws: a
 * failed request, an error status or a body that is not a JSON object all
 * mean "unknown", which gets the two-step fallback because it works on
 * every server. `features.beta_invites` false or absent is `off`, whatever
 * the version says.
 */
export async function checkInviteSupport(
  server: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<InviteSupport> {
  let body: unknown;
  try {
    const response = await fetchImpl(`${server.replace(/\/+$/, "")}/api/v1/system/info`, {
      method: "GET",
      headers: { "User-Agent": `kagura-memory-sdk/${SDK_VERSION}`, Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return "two-step";
    body = JSON.parse(await response.text());
  } catch {
    return "two-step";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "two-step";
  }

  const info = body as { version?: unknown; features?: unknown };
  const features = info.features;
  const invites =
    typeof features === "object" && features !== null
      ? (features as Record<string, unknown>).beta_invites
      : undefined;
  if (invites !== true) return "off";

  const version = versionTuple(info.version);
  return version !== null && atLeast(version, MIN_INVITE_HANDOFF_TUPLE) ? "one-link" : "two-step";
}
