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

  it("passes an empty title before the URL on Windows", () => {
    // `start` is a cmd builtin whose first quoted argument is the window
    // title; without the empty "" a quoted URL would be eaten as the title.
    expect(browserCommand("win32", "https://x.test")).toEqual([
      "cmd",
      ["/c", "start", "", "https://x.test"],
    ]);
  });
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
