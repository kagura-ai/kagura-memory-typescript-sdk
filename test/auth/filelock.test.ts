import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileLockTimeoutError,
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
const FAST = { timeoutMs: 200, retryMs: 5, staleMs: 60_000 };

describe("lockPath", () => {
  it("is the sibling <name>.lock, never the target itself", () => {
    const target = path.join(dir, "credentials.json");
    expect(lockPath(target)).toBe(path.join(dir, "credentials.json.lock"));
  });
});

describe("acquireFileLock / withFileLock", () => {
  it("creates the lock file while held and removes it on release", async () => {
    const target = path.join(dir, "credentials.json");
    await withFileLock(target, () => {
      expect(fs.existsSync(path.join(dir, "credentials.json.lock"))).toBe(true);
    });
    expect(fs.existsSync(path.join(dir, "credentials.json.lock"))).toBe(false);
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
        { timeoutMs: 10_000, retryMs: 2, staleMs: 60_000 },
      );

    await Promise.all(Array.from({ length: 8 }, bump));
    expect(parseInt(fs.readFileSync(counter, "utf-8"), 10)).toBe(8);
  });

  it("breaks a stale lock left behind by a crashed holder", async () => {
    const target = path.join(dir, "credentials.json");
    const lockFile = lockPath(target);
    fs.writeFileSync(lockFile, "99999 2020-01-01T00:00:00.000Z\n");
    // Backdate the lock file well past the stale threshold.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, past, past);

    let entered = false;
    await withFileLock(
      target,
      () => {
        entered = true;
      },
      { timeoutMs: 500, retryMs: 5, staleMs: 1_000 },
    );
    expect(entered).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("does NOT break a live (non-stale) lock", async () => {
    const target = path.join(dir, "credentials.json");
    const lockFile = lockPath(target);
    fs.writeFileSync(lockFile, `${process.pid} ${new Date().toISOString()}\n`);

    await expect(
      withFileLock(target, () => undefined, { timeoutMs: 100, retryMs: 5, staleMs: 60_000 }),
    ).rejects.toThrow(/could not acquire credentials lock/);
    expect(fs.existsSync(lockFile)).toBe(true);
  });
});
