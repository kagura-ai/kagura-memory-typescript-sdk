/**
 * `setup codex | hermes | openclaw --url-form --oauth` — the pieces that
 * need no harness: the server check and the login notes. Ports of
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

/** The harnesses `--oauth` sets up. */
export type OauthHarness = "codex" | "hermes" | "openclaw";

/** Python's harness titles. */
export const OAUTH_TITLE: Record<OauthHarness, string> = {
  codex: "Codex",
  hermes: "Hermes Agent",
  openclaw: "OpenClaw",
};

/**
 * The `--connect-timeout` of an `--oauth` `hermes mcp add`, whose probe runs
 * the browser sign-in — Python's `HERMES_OAUTH_CONNECT_TIMEOUT_SEC`: Hermes's
 * own `hermes mcp login` bound (a 300 s callback window plus 15 s). Hermes
 * keeps it as the entry's `connect_timeout`.
 */
export const HERMES_OAUTH_CONNECT_TIMEOUT_S = 315;

/** Python's `sign_in_note` per harness: who signs in, and the way round a browser that cannot reach the callback. */
function signInNote(harness: OauthHarness, name: string, ran: boolean): string {
  if (harness === "codex") {
    const login = `codex mcp login ${name}`;
    const first = ran
      ? "Codex signs in itself: `codex mcp add` above started its sign-in if it found OAuth on the server. " +
        `If it did not log in, run \`${login}\`.`
      : `Once the table is in config.toml, sign in with \`${login}\`.`;
    return (
      `${first} The sign-in redirects the browser to Codex's loopback callback on this host; when the browser ` +
      "cannot reach it (no browser here, or a remote host), add --no-browser: Codex then prints the URL and " +
      "takes the callback URL pasted back. Codex keys the token on the entry's URL, so changing its ?guardrails= " +
      "later (another --guardrails or --context-id) means signing in again."
    );
  }
  if (harness === "hermes") {
    const login = `hermes mcp login ${name}`;
    const first = ran
      ? "Hermes signs in itself: `hermes mcp add` above started its sign-in when it probed the server, with " +
        `--connect-timeout ${HERMES_OAUTH_CONNECT_TIMEOUT_S} (the bound \`hermes mcp login\` uses), which Hermes ` +
        `keeps as the entry's connect_timeout. If it did not log in, run \`${login}\``
      : `Once the entry is in config.yaml, sign in with \`${login}\``;
    return (
      `${first} (the browser flow). The sign-in redirects the browser to Hermes's loopback callback on this ` +
      "host; when the browser cannot reach it (a remote host), paste the redirect URL at Hermes's prompt, or " +
      `(memory-cloud 0.78.0+) run \`${login} --flow device\`, which signs in with a code at the server's /device page.`
    );
  }
  const login = `openclaw mcp login ${name}`;
  const first = ran ? "Sign in" : "Once the entry is in openclaw.json, sign in";
  return (
    `${first} with \`${login}\`, then check it with the command below. The sign-in redirects the browser to ` +
    "OpenClaw's loopback callback on this host; when the browser cannot reach it (a remote host), " +
    `\`${login} --code <code>\` takes the code from the redirect.`
  );
}

/**
 * What replaces the key note for an `--oauth` entry — Python's
 * `login_note`, one line: who signs in and where, and where the harness
 * keeps the token. Setup never runs the login and never sees the token.
 */
export function oauthLoginNote(harness: OauthHarness, name: string, ran: boolean, tokenStore: string): string {
  const title = OAUTH_TITLE[harness];
  return (
    `${signInNote(harness, name, ran)} memory-cloud's consent screen shows the client name ${title} sends, ` +
    `which nothing verifies: approve only a sign-in you started. ${title} keeps the token in ${tokenStore}; ` +
    "setup never sees it."
  );
}
