/**
 * Cross-process file locking for `~/.kagura/credentials.json` (port of
 * _filelock.py).
 *
 * The in-process mutex in `auth/credentials` serializes credential refreshes
 * *within* a single process. When several processes own the same credentials
 * file at once — e.g. multiple `kagura-mcp` proxy children plus a stray
 * client — they need a *cross-process* gate so a concurrent
 * read-modify-write cannot lose an update.
 *
 * DEVIATION FROM PYTHON: the Python SDK uses OS advisory locks
 * (`fcntl.flock` on POSIX, `msvcrt.locking` on Windows), which Node's
 * builtins do not expose. This port instead uses an `O_EXCL` lockfile-create
 * loop: the lock is *held* while the sibling `<name>.lock` file exists, and
 * acquiring means winning the exclusive create. Consequences:
 *
 * - There is no shared/exclusive distinction — every lock is exclusive
 *   (matching the Python Windows `msvcrt` backend, which has no shared mode).
 * - A kernel lock dies with its owner; a lockfile does not. A crashed holder
 *   is therefore handled by *stale detection*: a lock file whose mtime is
 *   older than `staleMs` is presumed abandoned and broken (deleted), and the
 *   acquire loop retries. The stale threshold is sized above the OAuth
 *   refresh round-trip (the only operation that holds the lock across a
 *   network call), so it never trips on a live holder.
 * - The lockfile protocol is compatible with the Python CLI in the sense
 *   that both lock a sibling of the credentials file, never the file itself,
 *   so neither interferes with the other's atomic rename. (The Python CLI's
 *   kernel lock does not observe our lockfile and vice versa; the atomic
 *   rename in `credentials.ts` still guarantees the file is never torn, the
 *   lock only adds serialization — same as the Python no-op fallback.)
 *
 * A contended acquire is bounded by `timeoutMs` (like the Python msvcrt
 * backend's 90 s ceiling) so a stuck peer cannot wedge a waiter forever.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Poll interval while waiting for a contended lock (Python: 0.05 s). */
export const DEFAULT_LOCK_RETRY_MS = 50;

/**
 * Safety ceiling on a *contended* acquire (Python: 90 s). Sized well above
 * the OAuth refresh round-trip so it only bounds the pathological case.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 90_000;

/**
 * Age after which a held lock file is presumed abandoned (crashed holder)
 * and broken. Must exceed the longest legitimate hold (an OAuth refresh
 * round-trip, bounded by its ~30 s HTTP timeout) and stay below
 * `DEFAULT_LOCK_TIMEOUT_MS` so a crashed peer's lock is broken before a
 * healthy waiter times out.
 */
export const DEFAULT_LOCK_STALE_MS = 60_000;

/** Thrown when a contended acquire exceeds its deadline. */
export class FileLockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileLockTimeoutError";
  }
}

export interface FileLockOptions {
  /** Contended-acquire deadline in ms (default `DEFAULT_LOCK_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Poll interval between attempts in ms (default `DEFAULT_LOCK_RETRY_MS`). */
  retryMs?: number;
  /** Stale-lock age threshold in ms (default `DEFAULT_LOCK_STALE_MS`). */
  staleMs?: number;
}

/** A held lock. `release()` is idempotent. */
export interface FileLockHandle {
  /** Path of the lock file itself (the `<name>.lock` sibling). */
  readonly path: string;
  release(): void;
}

/**
 * Sibling `.lock` file for `target` (never the credentials file itself).
 *
 * Locking a dedicated sibling rather than the credentials file avoids
 * interfering with the atomic rename in `credentials.ts` (which swaps the
 * file out from under any handle open on the original).
 */
export function lockPath(target: string): string {
  return `${target}.lock`;
}

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && "code" in e;
}

/**
 * Acquire the cross-process lock for `target` (see module docs).
 *
 * The lock file is created with mode 0600 (where the platform honors it)
 * and contains `<pid> <iso-timestamp>` for debuggability. The caller must
 * call `release()` on the returned handle — prefer `withFileLock`, which
 * guarantees release in a `finally`.
 *
 * @throws FileLockTimeoutError when the lock stays contended past `timeoutMs`.
 */
export async function acquireFileLock(
  target: string,
  options: FileLockOptions = {},
): Promise<FileLockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;

  const lockFile = lockPath(target);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Attempt the exclusive create ("wx" = O_WRONLY | O_CREAT | O_EXCL).
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockFile, "wx", 0o600);
    } catch (e) {
      if (!isErrnoException(e) || e.code !== "EEXIST") {
        // Permission failure, unsupported FS, etc. — a permanent failure
        // must surface instead of spinning forever (Python parity).
        throw e;
      }
    }
    if (fd !== null) {
      try {
        fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return {
        path: lockFile,
        release(): void {
          if (released) {
            return;
          }
          released = true;
          try {
            fs.unlinkSync(lockFile);
          } catch {
            // Already gone (broken as stale by a waiter) — release is
            // best-effort and idempotent.
          }
        },
      };
    }

    // Lock is held by someone else. Break it if it looks abandoned.
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(lockFile).mtimeMs;
    } catch (e) {
      if (isErrnoException(e) && e.code === "ENOENT") {
        continue; // released between attempts — retry the create at once
      }
      throw e;
    }
    if (Date.now() - mtimeMs > staleMs) {
      try {
        fs.unlinkSync(lockFile);
      } catch (e) {
        if (!isErrnoException(e) || e.code !== "ENOENT") {
          throw e;
        }
      }
      continue; // retry the create at once
    }

    if (Date.now() >= deadline) {
      throw new FileLockTimeoutError(
        `could not acquire credentials lock within ${timeoutMs / 1000}s: ${lockFile}`,
      );
    }
    await sleep(retryMs);
  }
}

/**
 * Hold the cross-process lock for `target` for the duration of `fn`.
 *
 * The lock is always released — including when `fn` throws — via the
 * `finally` block (mirrors Python's `file_lock` context manager).
 */
export async function withFileLock<T>(
  target: string,
  fn: () => T | Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const handle = await acquireFileLock(target, options);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}
