/**
 * Best-effort browser launch for the device-flow prompt.
 *
 * Never throws. The URL and code are always printed first, so failing to
 * open a browser is cosmetic — but it must be *reported* as a failure so
 * the CLI can say "use the URL above" instead of leaving the operator
 * waiting for a window that will never appear.
 */

import { spawn } from "node:child_process";

type SpawnLike = typeof spawn;

/** The platform's URL opener and its arguments. */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "win32") {
    // Deliberately NOT `cmd /c start "" <url>`: spawning cmd hands the
    // URL to a shell that reinterprets & | < > ^, which breaks any
    // verification_uri_complete carrying a query string and lets a
    // hostile OAuth server smuggle a command into the URL it returns.
    // explorer.exe receives the URL as a plain argument and opens the
    // default browser without any shell in between.
    return ["explorer.exe", [url]];
  }
  if (platform === "darwin") {
    return ["open", [url]];
  }
  return ["xdg-open", [url]];
}

/**
 * Whether this URL may be handed to a system opener.
 *
 * The URL comes from the OAuth server, so it is untrusted input. Openers
 * happily dispatch `file:` and script schemes to whatever is registered
 * for them; only web URLs have any business here.
 */
function isOpenableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Launch the platform browser.
 *
 * @returns whether the process actually started. `spawn` reports a missing
 *   opener asynchronously through the `error` event, so this waits for
 *   `spawn`/`error` rather than assuming the call succeeded.
 */
export async function openBrowser(url: string, spawnImpl: SpawnLike = spawn): Promise<boolean> {
  if (!isOpenableUrl(url)) {
    return false;
  }
  const [command, args] = browserCommand(process.platform, url);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };

    try {
      const child = spawnImpl(command, args, { stdio: "ignore", detached: true });
      child.once("spawn", () => settle(true));
      child.once("error", () => settle(false));
      // Don't hold the event loop open waiting for the browser to close.
      child.unref();
    } catch {
      settle(false);
    }
  });
}
