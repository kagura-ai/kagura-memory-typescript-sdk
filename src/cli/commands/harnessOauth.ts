/**
 * `setup codex | hermes | openclaw --url-form --oauth` — the pieces that
 * need no harness: the server check and (Task 2) the notes. Ports of
 * Python 0.42.0's `setup_harness.py` (python-sdk #282, #284).
 *
 * memory-cloud 0.77.0 (memory-cloud#1657) accepts the dynamic client
 * registration of Codex, Hermes Agent and OpenClaw on a loopback redirect,
 * so an entry with no key can sign in. Before 0.77.0 the registration gets
 * 400 invalid_client_metadata, so setup checks the version first.
 */

import { pyIsPrintable, reprlibRepr } from "../../python.js";
import { meetsMinimum, requireVersion } from "../../versionCheck.js";
import { fetchSystemInfo } from "../invite.js";
import { CliError } from "../parse.js";

/** Python's `HARNESS_OAUTH_MIN_SERVER_VERSION`. */
export const HARNESS_OAUTH_MIN_SERVER_VERSION = "0.77.0";
const MIN_TRIPLE = requireVersion(HARNESS_OAUTH_MIN_SERVER_VERSION, "HARNESS_OAUTH_MIN_SERVER_VERSION");

/**
 * A version a server reported, safe to print — Python's `_shown_version`:
 * as sent when it is a printable string of at most 64 characters, else
 * its `reprlib.repr`.
 */
export function shownVersion(version: unknown): string {
  if (typeof version === "string" && pyIsPrintable(version) && [...version].length <= 64) return version;
  return reprlibRepr(version);
}

/**
 * Stop unless the `--oauth` entry's server is memory-cloud 0.77.0+ — port
 * of Python's `_check_oauth_server`. One unauthenticated
 * `GET <deployment>/api/v1/system/info`; a version that cannot be read (no
 * answer, not a 200, not a JSON object, unparseable) stops it too.
 *
 * @param options.title The harness's title (`Codex`, `Hermes Agent`, `OpenClaw`).
 * @param options.deployment The entry's server, as `setup.ts`'s `deployment()` gives it.
 * @returns The note saying the server passed.
 * @throws CliError (exit 1) with Python's refusal; its last sentence is
 *   this bin's, which has no stdio entry to offer.
 */
export async function checkOauthServer(options: {
  title: string;
  deployment: string;
  fetch?: typeof globalThis.fetch;
}): Promise<string> {
  const { title, deployment } = options;
  const info = await fetchSystemInfo(deployment, options.fetch);
  const version = info === null ? undefined : info.version;
  const meets = meetsMinimum(version, MIN_TRIPLE);
  if (meets === true) {
    return `${deployment} runs memory-cloud ${shownVersion(version)}, which accepts ${title}'s own client registration (0.77.0+).`;
  }
  let why: string;
  if (meets === false) {
    why = `${deployment} runs memory-cloud ${shownVersion(version)}`;
  } else if (info === null) {
    why = `setup could not confirm the version of ${deployment} (GET /api/v1/system/info did not answer 200 with a JSON object)`;
  } else {
    const reported = version === undefined || version === null ? "no version" : shownVersion(version);
    why = `setup could not confirm the version of ${deployment} (/api/v1/system/info reports ${reported})`;
  }
  throw new CliError(
    `Nothing was written: --oauth needs memory-cloud 0.77.0+, and ${why}. Before 0.77.0, dynamic client ` +
      `registration rejects ${title}'s own client (memory-cloud#1657). Use --url-form with an API key instead ` +
      "(no --oauth).",
  );
}
