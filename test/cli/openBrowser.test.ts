import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { browserCommand, openBrowser } from "../../src/cli/openBrowser.js";

/** Minimal ChildProcess stand-in: emits `spawn` or `error` on next tick. */
function fakeChild(outcome: "spawn" | "error"): EventEmitter & { unref: () => void } {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = () => {};
  queueMicrotask(() => child.emit(outcome, outcome === "error" ? new Error("ENOENT") : undefined));
  return child;
}

describe("browserCommand", () => {
  it("uses the platform opener", () => {
    expect(browserCommand("darwin", "https://x.test")).toEqual(["open", ["https://x.test"]]);
    expect(browserCommand("linux", "https://x.test")).toEqual(["xdg-open", ["https://x.test"]]);
  });

  it("never routes through cmd.exe on Windows", () => {
    // `cmd /c start "" <url>` lets cmd.exe reinterpret & | < > ^ in the
    // URL. That breaks any verification_uri_complete carrying a query
    // string, and a hostile OAuth server could append `& calc.exe`.
    // explorer.exe takes the URL as a plain argument — no shell parsing.
    const [command, args] = browserCommand("win32", "https://x.test/a?b=1&c=2");
    expect(command).toBe("explorer.exe");
    expect(args).toEqual(["https://x.test/a?b=1&c=2"]);
    expect(command).not.toMatch(/cmd/i);
  });
});

describe("openBrowser: URL vetting", () => {
  it.each([
    "javascript:alert(1)",
    "file:///C:/Windows/System32/calc.exe",
    "vbscript:msgbox",
    "not a url",
    "",
  ])("refuses to hand %j to the opener", async (url) => {
    let spawned = false;
    const result = await openBrowser(url, (() => {
      spawned = true;
      return fakeChild("spawn") as never;
    }) as never);

    expect(result).toBe(false);
    expect(spawned).toBe(false);
  });

  it.each(["https://x.test/a?b=1&c=2", "http://localhost:8080/activate"])(
    "opens %j",
    async (url) => {
      await expect(
        openBrowser(url, () => fakeChild("spawn") as never),
      ).resolves.toBe(true);
    },
  );
});

describe("openBrowser", () => {
  it("reports success only once the process actually spawned", async () => {
    await expect(
      openBrowser("https://x.test", () => fakeChild("spawn") as never),
    ).resolves.toBe(true);
  });

  it("reports failure when the opener is missing", async () => {
    // spawn() reports ENOENT asynchronously via the 'error' event, so
    // resolving eagerly after the call would always claim success and the
    // CLI would never print its fallback guidance.
    await expect(
      openBrowser("https://x.test", () => fakeChild("error") as never),
    ).resolves.toBe(false);
  });

  it("reports failure when spawn throws synchronously", async () => {
    await expect(
      openBrowser("https://x.test", () => {
        throw new Error("EPERM");
      }),
    ).resolves.toBe(false);
  });

  it("settles once even if both events fire", async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    queueMicrotask(() => {
      child.emit("spawn");
      child.emit("error", new Error("late"));
    });
    await expect(openBrowser("https://x.test", () => child as never)).resolves.toBe(true);
  });
});
