import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { execFile, which } from "../../src/cli/exec.js";

type FakeStream = EventEmitter & { destroyed: boolean; destroy: () => void };
type FakeChild = EventEmitter & {
  stdout: FakeStream;
  stderr: FakeStream;
  pid?: number;
  kills: string[];
  kill: (signal: string) => boolean;
};

function fakeStream(): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.destroyed = false;
  stream.destroy = () => {
    stream.destroyed = true;
  };
  return stream;
}

/** ChildProcess stand-in; the test drives its events. Nothing is spawned. */
function fakeChild(pid?: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = fakeStream();
  child.stderr = fakeStream();
  if (pid !== undefined) child.pid = pid;
  child.kills = [];
  child.kill = (signal: string) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

/** A `process.kill` stand-in: a fake child's pid must never reach the real one. */
function fakeKill(): { calls: [number, string][]; kill: (pid: number, signal: NodeJS.Signals) => void } {
  const calls: [number, string][] = [];
  return { calls, kill: (pid, signal) => void calls.push([pid, signal]) };
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
    const pending = execFile("/bin/codex", ["mcp", "add", "a&b"], {}, ((...args: unknown[]) => {
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

  it("runs in the directory it is given", async () => {
    // `claude plugin list` answers for the project it is run in.
    const child = fakeChild();
    let options: Record<string, unknown> = {};
    const pending = execFile("/bin/claude", ["plugin", "list"], { cwd: dir }, ((...args: unknown[]) => {
      options = args[2] as Record<string, unknown>;
      return child;
    }) as never);
    child.emit("close", 0, null);
    await pending;
    expect(options.cwd).toBe(dir);
  });

  it("runs the program as the leader of its own process group on POSIX, not on Windows", async () => {
    // So the timeout's kill reaches whatever it starts; Windows has no groups.
    const spawned: Record<string, unknown>[] = [];
    for (const platform of ["linux", "win32"] as const) {
      const child = fakeChild();
      const pending = execFile(
        "/bin/codex",
        [],
        {},
        ((...args: unknown[]) => {
          spawned.push(args[2] as Record<string, unknown>);
          return child;
        }) as never,
        fakeKill().kill,
        platform,
      );
      child.emit("close", 0, null);
      await pending;
    }
    expect(spawned.map((o) => o.detached)).toEqual([true, false]);
    // The timeout is execFile's own, not spawn's, which kills the program alone.
    expect(spawned.map((o) => o.timeout)).toEqual([undefined, undefined]);
  });

  describe("at the timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("SIGKILLs the whole process group and settles without waiting for 'close'", async () => {
      // A launcher's child that holds the pipes would keep 'close' from ever
      // coming; SIGKILL, as Python's subprocess.run kills it: a CLI can
      // catch SIGTERM and exit as it likes, or ignore it and run on.
      const child = fakeChild(4242);
      const killer = fakeKill();
      const pending = execFile("/bin/codex", [], { timeoutMs: 120_000 }, (() => child) as never, killer.kill, "linux");
      child.stdout.emit("data", Buffer.from("partial"));
      await vi.advanceTimersByTimeAsync(119_999);
      expect(killer.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({
        code: 128 + os.constants.signals.SIGKILL,
        stdout: "partial",
        stderr: "",
        timedOut: true,
      });
      expect(killer.calls).toEqual([[-4242, "SIGKILL"]]);
      expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true);
      expect(child.kills).toEqual([]);
    });

    it("waits 60 s when no timeout is given", async () => {
      const child = fakeChild(7);
      const killer = fakeKill();
      const pending = execFile("/bin/claude", [], {}, (() => child) as never, killer.kill, "linux");
      await vi.advanceTimersByTimeAsync(59_999);
      expect(killer.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ timedOut: true });
      expect(killer.calls).toEqual([[-7, "SIGKILL"]]);
    });

    it("on Windows, kills the program itself and settles all the same", async () => {
      const child = fakeChild(9);
      const killer = fakeKill();
      const pending = execFile("codex.exe", [], { timeoutMs: 30_000 }, (() => child) as never, killer.kill, "win32");
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toMatchObject({ timedOut: true });
      expect(child.kills).toEqual(["SIGKILL"]);
      expect(killer.calls).toEqual([]);
    });

    it("kills nothing once the program has closed", async () => {
      const child = fakeChild(11);
      const killer = fakeKill();
      const pending = execFile("/bin/codex", [], { timeoutMs: 1_000 }, (() => child) as never, killer.kill, "linux");
      child.emit("close", 0, null);
      await expect(pending).resolves.toEqual({ code: 0, stdout: "", stderr: "" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(killer.calls).toEqual([]);
    });

    it("ignores a 'close' that comes after it", async () => {
      const child = fakeChild(12);
      const pending = execFile("x", [], { timeoutMs: 10 }, (() => child) as never, fakeKill().kill, "linux");
      await vi.advanceTimersByTimeAsync(10);
      child.emit("close", 0, null);
      await expect(pending).resolves.toMatchObject({ code: 128 + os.constants.signals.SIGKILL, timedOut: true });
    });
  });

  it("kills the group when this process is interrupted, and stops listening once settled", async () => {
    // A detached group no longer gets the terminal's Ctrl-C. Another
    // listener stays in place, so the signal is not raised again here.
    const other = () => {};
    process.on("SIGINT", other);
    try {
      const before = process.listenerCount("SIGINT");
      const child = fakeChild(31);
      const killer = fakeKill();
      const pending = execFile("/bin/codex", [], {}, (() => child) as never, killer.kill, "linux");
      expect(process.listenerCount("SIGINT")).toBe(before + 1);
      process.emit("SIGINT", "SIGINT");
      expect(killer.calls).toEqual([[-31, "SIGKILL"]]);
      expect(process.listenerCount("SIGINT")).toBe(before);
      child.emit("close", null, "SIGKILL");
      await pending;
      expect(process.listenerCount("SIGINT")).toBe(before);
    } finally {
      process.removeListener("SIGINT", other);
    }
  });

  // A real launcher: the npm `codex` spawns the native binary with its own
  // stdio (our pipes), and forwards SIGTERM, which SIGKILL cannot be.
  (os.platform() === "win32" ? it.skip : it)(
    "ends a launcher and the grandchild holding its pipes at the timeout",
    async () => {
      const grandchild = "setInterval(() => {}, 1000);";
      const launcher = path.join(dir, "launcher.cjs");
      fs.writeFileSync(
        launcher,
        [
          'const { spawn } = require("node:child_process");',
          `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "inherit" });`,
          'for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));',
          "process.stdout.write(`${child.pid}\\n`);",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      const started = Date.now();
      const result = await execFile(process.execPath, [launcher], { timeoutMs: 1_500 });
      const elapsed = Date.now() - started;
      expect(result).toMatchObject({ code: 128 + os.constants.signals.SIGKILL, timedOut: true });
      expect(elapsed).toBeLessThan(5_000);
      const pid = Number(result.stdout.trim());
      expect(pid).toBeGreaterThan(0);
      // Gone with its group, not orphaned (allowing a moment to be reaped).
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
      if (alive()) process.kill(pid, "SIGKILL");
      expect(alive()).toBe(false);
    },
    10_000,
  );

  it("reports the exit code of a failing program", async () => {
    const child = fakeChild();
    const pending = execFile("x", [], {}, (() => child) as never);
    child.emit("close", 3, null);
    await expect(pending).resolves.toMatchObject({ code: 3 });
  });

  it("maps a start failure to 127, the shell's 'command not found'", async () => {
    const child = fakeChild();
    const pending = execFile("x", [], {}, (() => child) as never);
    child.emit("error", new Error("spawn x ENOENT"));
    await expect(pending).resolves.toMatchObject({ code: 127, stderr: "spawn x ENOENT" });
  });

  it("maps a synchronous spawn throw to 127", async () => {
    const result = await execFile("x", [], {}, (() => {
      throw new Error("EINVAL");
    }) as never);
    expect(result).toMatchObject({ code: 127, stderr: "EINVAL" });
  });

  it("maps death by signal to 128+n", async () => {
    const child = fakeChild();
    const pending = execFile("x", [], {}, (() => child) as never);
    child.emit("close", null, "SIGTERM");
    const result = await pending;
    expect(result).toMatchObject({ code: 128 + os.constants.signals.SIGTERM });
    // Not killed by execFile's own timeout: someone else sent the signal.
    expect(result.timedOut).toBeUndefined();
  });

});
