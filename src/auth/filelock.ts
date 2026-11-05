/**
 * Portable exclusive-create credential lock protocol v1.
 *
 * Every participating writer creates `<target>.lock-v1` with O_EXCL and
 * removes only its own file after its entire read/network/write operation.
 * Age never proves abandonment: a suspended owner can resume. Acquisition
 * times out; recovery after a crash requires stopping every client first.
 *
 * Python 0.44.0 uses an incompatible native advisory lock on `.lock`.
 * We never remove that inode. Its presence fails closed to detect known
 * legacy use, but cannot prevent an old client starting later. Concurrent
 * use requires all clients to adopt this protocol; see compatibility docs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export const DEFAULT_LOCK_RETRY_MS = 50;
export const DEFAULT_LOCK_TIMEOUT_MS = 90_000;

export class FileLockTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "FileLockTimeoutError"; }
}

export class LegacyCredentialsLockError extends Error {
  constructor(target: string) {
    super(`Legacy credentials lock detected: ${target}.lock. Stop all older SDK/CLI processes before migrating; ` +
      "do not share this credentials file concurrently with Python SDK 0.44.0 or older TypeScript clients.");
    this.name = "LegacyCredentialsLockError";
  }
}

export interface FileLockOptions {
  timeoutMs?: number;
  retryMs?: number;
}
export interface FileLockHandle {
  readonly path: string;
  release(): void;
}
export function lockPath(target: string): string { return `${target}.lock-v1`; }
function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function refuseLegacy(target: string): void {
  try { fs.lstatSync(`${target}.lock`); }
  catch (error) { if (errno(error, "ENOENT")) return; throw error; }
  throw new LegacyCredentialsLockError(target);
}

export async function acquireFileLock(target: string, options: FileLockOptions = {}): Promise<FileLockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const lockFile = lockPath(target);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = performance.now() + timeoutMs;
  const owner = JSON.stringify({ protocol: "kagura-credentials-lock-v1", owner: randomUUID(), pid: process.pid }) + "\n";
  for (;;) {
    refuseLegacy(target);
    let fd: number;
    try { fd = fs.openSync(lockFile, "wx", 0o600); }
    catch (error) {
      if (!errno(error, "EEXIST")) throw error;
      if (performance.now() >= deadline) {
        throw new FileLockTimeoutError(`could not acquire credentials lock within ${timeoutMs / 1000}s: ${lockFile}. ` +
          "If its owner crashed, stop every client before removing this lock; age alone is not safe evidence.");
      }
      await sleep(retryMs);
      continue;
    }
    try {
      fs.writeFileSync(fd, owner);
    } catch (error) {
      fs.closeSync(fd);
      fs.unlinkSync(lockFile);
      throw error;
    }
    fs.closeSync(fd);
    let released = false;
    const handle: FileLockHandle = {
      path: lockFile,
      release() {
        if (released) return;
        released = true;
        try {
          // Never delete a replacement produced by manual recovery or another
          // protocol. Participating owners never break one another's locks.
          if (fs.readFileSync(lockFile, "utf8") === owner) fs.unlinkSync(lockFile);
        } catch (error) { if (!errno(error, "ENOENT")) throw error; }
      },
    };
    try { refuseLegacy(target); }
    catch (error) { handle.release(); throw error; }
    return handle;
  }
}

export async function withFileLock<T>(target: string, fn: () => T | Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const handle = await acquireFileLock(target, options);
  try { return await fn(); }
  finally { handle.release(); }
}
