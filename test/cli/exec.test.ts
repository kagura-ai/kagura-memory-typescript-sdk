import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { execFile, which } from "../../src/cli/exec.js";

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

/** ChildProcess stand-in; the test drives its events. Nothing is spawned. */
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-exec-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("which", () => {
  // Mode bits carry "executable" on POSIX only.
  const onPosix = os.platform() === "win32" ? it.skip : it;

  onPosix("returns the first executable match on PATH", () => {
    const empty = path.join(dir, "empty");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(empty);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    expect(which("codex", { PATH: `${empty}:${bin}` }, "linux")).toBe(path.join(bin, "codex"));
  });

  onPosix("skips a file that is not executable", () => {
    fs.writeFileSync(path.join(dir, "codex"), "", { mode: 0o644 });
    expect(which("codex", { PATH: dir }, "linux")).toBeNull();
  });

  it("skips a directory of the same name", () => {
    fs.mkdirSync(path.join(dir, "codex"));
    expect(which("codex", { PATH: dir }, "linux")).toBeNull();
  });

  onPosix("ignores empty and relative PATH entries", () => {
    // Both resolve against the current directory, and running a harness
    // CLI out of wherever setup was started is not a lookup anyone asked for.
    const cwd = process.cwd();
    fs.writeFileSync(path.join(dir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    try {
      process.chdir(dir);
      expect(which("codex", { PATH: ":.:" }, "linux")).toBeNull();
    } finally {
      process.chdir(cwd);
    }
  });

  it("returns null with no PATH at all", () => {
    expect(which("codex", {}, "linux")).toBeNull();
  });

  it("on Windows, finds an .exe and passes over a .cmd shim", () => {
    // A .cmd needs a shell to run, and a shell would re-parse argv that
    // carries the API key inside JSON; treating it as absent makes setup
    // print the block instead.
    fs.writeFileSync(path.join(dir, "claude.cmd"), "");
    fs.writeFileSync(path.join(dir, "codex.exe"), "");
    expect(which("claude", { PATH: dir }, "win32")).toBeNull();
    expect(which("codex", { Path: dir }, "win32")).toBe(path.join(dir, "codex.exe"));
  });
});

describe("execFile", () => {
  it("runs with no shell and a closed stdin, and captures both streams", async () => {
    const child = fakeChild();
    const calls: unknown[][] = [];
    const pending = execFile("/bin/codex", ["mcp", "add", "a&b"], ((...args: unknown[]) => {
      calls.push(args);
      return child;
    }) as never);
    child.stdout.emit("data", Buffer.from("added "));
    child.stdout.emit("data", Buffer.from("ok"));
    child.stderr.emit("data", Buffer.from("warn"));
    child.emit("close", 0, null);

    await expect(pending).resolves.toEqual({ code: 0, stdout: "added ok", stderr: "warn" });
    const [file, argv, options] = calls[0] as [string, string[], Record<string, unknown>];
    expect(file).toBe("/bin/codex");
    expect(argv).toEqual(["mcp", "add", "a&b"]);
    expect(options).toMatchObject({ shell: false, stdio: ["ignore", "pipe", "pipe"] });
  });

  it("reports the exit code of a failing program", async () => {
    const child = fakeChild();
    const pending = execFile("x", [], (() => child) as never);
    child.emit("close", 3, null);
    await expect(pending).resolves.toMatchObject({ code: 3 });
  });

  it("maps a start failure to 127, the shell's 'command not found'", async () => {
    const child = fakeChild();
    const pending = execFile("x", [], (() => child) as never);
    child.emit("error", new Error("spawn x ENOENT"));
    await expect(pending).resolves.toMatchObject({ code: 127, stderr: "spawn x ENOENT" });
  });

  it("maps a synchronous spawn throw to 127", async () => {
    const result = await execFile("x", [], (() => {
      throw new Error("EINVAL");
    }) as never);
    expect(result).toMatchObject({ code: 127, stderr: "EINVAL" });
  });

  it("maps death by signal to 128+n", async () => {
    const child = fakeChild();
    const pending = execFile("x", [], (() => child) as never);
    child.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toMatchObject({ code: 128 + os.constants.signals.SIGTERM });
  });
});
