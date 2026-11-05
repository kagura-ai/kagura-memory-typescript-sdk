import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork } from "node:child_process";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileLockTimeoutError,
  LegacyCredentialsLockError,
  acquireFileLock,
  lockPath,
  withFileLock,
} from "../../src/auth/filelock.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-lock-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Small knobs so contended cases fail fast instead of waiting 90 s.
const FAST = { timeoutMs: 200, retryMs: 5 };

describe("lockPath", () => {
  it("is the versioned sibling, never the target or Python's inode", () => {
    const target = path.join(dir, "credentials.json");
    expect(lockPath(target)).toBe(path.join(dir, "credentials.json.lock-v1"));
  });
});

describe("acquireFileLock / withFileLock", () => {
  it.each(["parent", "child"])("excludes a second OS process when the %s acquires first", async first => {
    const target = path.join(dir, "credentials.json");
    const source = fs.readFileSync(new URL("../../src/auth/filelock.ts", import.meta.url), "utf8");
    fs.writeFileSync(path.join(dir, "filelock.mjs"), transpileModule(source, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    }).outputText);
    const worker = path.join(dir, "worker.mjs");
    fs.writeFileSync(worker, `
      import { acquireFileLock, FileLockTimeoutError } from './filelock.mjs';
      import { once } from 'node:events';
      try {
        const lock = await acquireFileLock(process.argv[2], {timeoutMs: 150, retryMs: 5});
        process.send('held');
        await once(process, 'message');
        lock.release();
      } catch (error) {
        if (!(error instanceof FileLockTimeoutError)) throw error;
        process.send('timeout');
      }
      process.disconnect();
    `);
    const parent = first === "parent" ? await acquireFileLock(target, FAST) : undefined;
    const child = fork(worker, [target], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] });
    const ended = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve); child.once("error", reject);
    });
    try {
      const message = await new Promise<unknown>((resolve, reject) => {
        child.once("message", resolve); child.once("error", reject);
        child.once("exit", () => reject(new Error("worker exited before reporting lock state")));
      });
      if (first === "parent") expect(message).toBe("timeout");
      else {
        expect(message).toBe("held");
        await expect(acquireFileLock(target, FAST)).rejects.toBeInstanceOf(FileLockTimeoutError);
        child.send("release");
      }
      expect(await ended).toBe(0);
    } finally {
      parent?.release();
      if (child.exitCode === null) { child.kill(); await ended; }
    }
    await withFileLock(target, () => {}, FAST);
  });

  it("creates the lock file while held and removes it on release", async () => {
    const target = path.join(dir, "credentials.json");
    await withFileLock(target, () => {
      expect(fs.existsSync(lockPath(target))).toBe(true);
    });
    expect(fs.existsSync(lockPath(target))).toBe(false);
  });

  it("can be re-acquired sequentially without deadlock", async () => {
    const target = path.join(dir, "credentials.json");
    for (let i = 0; i < 3; i++) {
      await withFileLock(target, () => undefined, FAST);
    }
  });

  it("releases the lock when the body throws", async () => {
    const target = path.join(dir, "credentials.json");
    await expect(
      withFileLock(target, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // If the lock leaked, this second acquire would time out.
    await withFileLock(target, () => undefined, FAST);
  });

  it("creates the parent directory when missing", async () => {
    const target = path.join(dir, "nested", "credentials.json");
    await withFileLock(target, () => {
      expect(fs.statSync(path.join(dir, "nested")).isDirectory()).toBe(true);
    });
  });

  it("release() is idempotent", async () => {
    const target = path.join(dir, "credentials.json");
    const handle = await acquireFileLock(target, FAST);
    handle.release();
    handle.release(); // second call must not throw
  });

  it("times out with FileLockTimeoutError while a fresh lock is held", async () => {
    const target = path.join(dir, "credentials.json");
    const handle = await acquireFileLock(target, FAST);
    try {
      await expect(withFileLock(target, () => undefined, FAST)).rejects.toThrow(
        FileLockTimeoutError,
      );
    } finally {
      handle.release();
    }
  });

  it("serializes concurrent read-modify-write (no lost update)", async () => {
    const target = path.join(dir, "credentials.json");
    const counter = path.join(dir, "counter.txt");
    fs.writeFileSync(counter, "0");

    const bump = () =>
      withFileLock(
        target,
        async () => {
          const value = parseInt(fs.readFileSync(counter, "utf-8"), 10);
          // Widen the read-modify-write window so an unserialized
          // interleaving would certainly lose an update.
          await new Promise((resolve) => setTimeout(resolve, 5));
          fs.writeFileSync(counter, String(value + 1));
        },
        { timeoutMs: 10_000, retryMs: 2 },
      );

    await Promise.all(Array.from({ length: 8 }, bump));
    expect(parseInt(fs.readFileSync(counter, "utf-8"), 10)).toBe(8);
  });

  it("never breaks an old lock: a suspended owner can resume", async () => {
    const target = path.join(dir, "credentials.json");
    const lockFile = lockPath(target);
    fs.writeFileSync(lockFile, "99999 2020-01-01T00:00:00.000Z\n");
    // Backdate the lock file well past the stale threshold.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, past, past);

    let entered = false;
    await expect(withFileLock(
      target,
      () => {
        entered = true;
      },
      { timeoutMs: 50, retryMs: 5 },
    )).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(entered).toBe(false);
    expect(fs.readFileSync(lockFile, "utf8")).toBe("99999 2020-01-01T00:00:00.000Z\n");
  });

  it("does NOT break a live (non-stale) lock", async () => {
    const target = path.join(dir, "credentials.json");
    const lockFile = lockPath(target);
    fs.writeFileSync(lockFile, `${process.pid} ${new Date().toISOString()}\n`);

    await expect(
      withFileLock(target, () => undefined, { timeoutMs: 100, retryMs: 5 }),
    ).rejects.toThrow(/could not acquire credentials lock/);
    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it("fails closed on a legacy Python lock and never removes its inode", async () => {
    const target = path.join(dir, "credentials.json");
    fs.writeFileSync(`${target}.lock`, "");
    const before = fs.statSync(`${target}.lock`);
    const old = new Date(0);
    fs.utimesSync(`${target}.lock`, old, old);
    await expect(acquireFileLock(target, FAST)).rejects.toBeInstanceOf(LegacyCredentialsLockError);
    expect(fs.statSync(`${target}.lock`).ino).toBe(before.ino);
    expect(fs.existsSync(lockPath(target))).toBe(false);
  });

  it("does not remove a replacement lock on release", async () => {
    const target = path.join(dir, "credentials.json");
    const handle = await acquireFileLock(target, FAST);
    fs.writeFileSync(handle.path, "a different owner");
    handle.release();
    expect(fs.readFileSync(handle.path, "utf8")).toBe("a different owner");
  });
});
