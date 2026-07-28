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
    // `start` is a cmd builtin, and its first quoted argument is taken as
    // the window title — hence the empty "" before the URL.
    return ["cmd", ["/c", "start", "", url]];
  }
  if (platform === "darwin") {
    return ["open", [url]];
  }
  return ["xdg-open", [url]];
}

/**
 * Launch the platform browser.
 *
 * @returns whether the process actually started. `spawn` reports a missing
 *   opener asynchronously through the `error` event, so this waits for
 *   `spawn`/`error` rather than assuming the call succeeded.
 */
export async function openBrowser(url: string, spawnImpl: SpawnLike = spawn): Promise<boolean> {
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
