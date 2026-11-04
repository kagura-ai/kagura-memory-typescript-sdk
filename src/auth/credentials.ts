/**
 * Persistent OAuth credentials for the Kagura SDK (port of
 * auth/credentials.py).
 *
 * This module owns three responsibilities:
 *
 * 1. The `OAuthCredentials` / `CredentialsFile` shapes and their JSON
 *    (de)serialization. The on-disk format at `~/.kagura/credentials.json`
 *    is SHARED with the Python CLI — keys stay snake_case on disk
 *    (`default_profile`, `profiles`, `access_token`, ...), timestamps are
 *    Z-suffixed UTC ISO-8601.
 * 2. Atomic, mode-0600 read/write of the credentials file with a mode-0700
 *    parent directory (permissions are best-effort where the platform,
 *    e.g. Windows/NTFS, does not honor POSIX bits).
 * 3. A process-wide cache (`getSharedState`) so concurrent clients pointing
 *    at the same credentials file share a single in-process mutex, ensuring
 *    only one `/oauth/token/` refresh fires per cycle even when many client
 *    instances run side by side.
 *
 * Multi-process coordination is handled in two layers: the in-process
 * `AsyncMutex` coalesces refreshes *within* a process, and the
 * cross-process lock in `filelock.ts` (acquired inside the refresh path)
 * re-reads the on-disk token after locking and skips the `/oauth/token/`
 * round-trip when another process already rotated it. That refresh path,
 * {@link refreshProfileLocked}, is the one `KaguraOAuth` (every client and
 * `kagura-memory-mcp`), `refresh()` and the CLI's `auth refresh` /
 * `auth token` all take.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { KaguraAuthError, KaguraAuthExpiredError, excMessage } from "../errors.js";
import type { KaguraErrorOptions } from "../errors.js";
import { parseJsonLossless, valueAt } from "../losslessJson.js";
import { pyStr, pyTruthy } from "../python.js";
import { refreshAccessToken } from "./deviceFlow.js";
import { withFileLock } from "./filelock.js";
import type { AuthProvider } from "./types.js";

/**
 * Refresh `accessToken` when within this many seconds of `expiresAt`.
 *
 * Default of 5 minutes mirrors common OAuth2 client conventions and gives
 * enough headroom for a slow refresh round-trip.
 */
export const REFRESH_SKEW_SEC = 300;

export const CREDENTIALS_FILE_MODE = 0o600;
export const CREDENTIALS_DIR_MODE = 0o700;

/**
 * Default location of the credentials file: `~/.kagura/credentials.json`.
 * Tests pass an explicit `home`/path instead of touching the real one.
 */
export function defaultCredentialsPath(home?: string): string {
  return path.join(home ?? os.homedir(), ".kagura", "credentials.json");
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

/** A single profile's OAuth2 credentials (camelCase in memory, snake_case on disk). */
export interface OAuthCredentials {
  server: string;
  mcpUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: Date;
  scope: string;
  workspaceId: string;
  workspaceName: string;
  userEmail: string;
  issuedAt: Date;
}

/** True when `accessToken` is past `expiresAt - skewSeconds`. */
export function isExpired(creds: OAuthCredentials, skewSeconds = 0): boolean {
  return Date.now() >= creds.expiresAt.getTime() - skewSeconds * 1000;
}

/**
 * Return a copy of `creds` with the rotated token fields applied.
 *
 * `refreshToken` is rotated when the server returns a new one (RFC 6749
 * §10.4 recommended) — pass `null`/omit to preserve the stored one.
 * `scope` is updated when the server narrows or widens the grant.
 */
export function withRefreshed(
  creds: OAuthCredentials,
  fields: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt: Date;
    scope?: string | null;
  },
): OAuthCredentials {
  return {
    ...creds,
    accessToken: fields.accessToken,
    refreshToken: fields.refreshToken ?? creds.refreshToken,
    expiresAt: fields.expiresAt,
    scope: fields.scope ?? creds.scope,
  };
}

// ---------------------------------------------------------------------------
// Datetime helpers (Z-suffixed UTC ISO-8601 for human readability)
// ---------------------------------------------------------------------------

/** Serialize a Date as `YYYY-MM-DDTHH:MM:SSZ` (UTC, seconds precision). */
export function isoUtc(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * Parse ISO-8601, accepting `...Z`, `...+00:00`, and naive suffixes.
 *
 * Normalizes a missing timezone to UTC so a user-edited / legacy
 * credentials file with naive timestamps doesn't get parsed as local time
 * (JavaScript's `Date` parses a bare `YYYY-MM-DDTHH:MM:SS` as local).
 */
export function parseIso(s: string): Date {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid ISO-8601 timestamp: ${s}`);
  }
  return date;
}

// ---------------------------------------------------------------------------
// JSON (de)serialization — snake_case on disk, shared with the Python CLI
// ---------------------------------------------------------------------------

export function credentialsToDict(creds: OAuthCredentials): Record<string, unknown> {
  return {
    server: creds.server,
    mcp_url: creds.mcpUrl,
    client_id: creds.clientId,
    access_token: creds.accessToken,
    refresh_token: creds.refreshToken,
    token_type: creds.tokenType,
    expires_at: isoUtc(creds.expiresAt),
    scope: creds.scope,
    workspace_id: creds.workspaceId,
    workspace_name: creds.workspaceName,
    user_email: creds.userEmail,
    issued_at: isoUtc(creds.issuedAt),
  };
}

function requireString(d: Record<string, unknown>, key: string): string {
  const value = d[key];
  if (typeof value !== "string") {
    throw new Error(`credentials profile missing required field '${key}'`);
  }
  return value;
}

/** `d[key]` whatever its type, as Python's `d[key]` reads it; absent throws. */
function requirePresent(d: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(d, key)) {
    throw new Error(`credentials profile missing required field '${key}'`);
  }
  return valueAt(d, key);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** @throws Error when required fields are missing or timestamps invalid. */
export function credentialsFromDict(d: Record<string, unknown>): OAuthCredentials {
  const issuedAtRaw = d.issued_at;
  return {
    server: requireString(d, "server"),
    mcpUrl: requireString(d, "mcp_url"),
    clientId: requireString(d, "client_id"),
    // Python's from_dict reads both untyped (#69): it sends
    // f"Bearer {access_token}", and refreshes only when refresh_token is
    // truthy -- "" here, which every refresh path treats as none. A number
    // is read from the file's own literal: 9007199254740993 stays exact,
    // NaN is "nan" and truthy.
    accessToken: pyStr(requirePresent(d, "access_token")),
    refreshToken: ((value) => (pyTruthy(value) ? pyStr(value) : ""))(requirePresent(d, "refresh_token")),
    tokenType: stringOr(d.token_type, "Bearer"),
    expiresAt: parseIso(requireString(d, "expires_at")),
    scope: stringOr(d.scope, ""),
    workspaceId: stringOr(d.workspace_id, ""),
    workspaceName: stringOr(d.workspace_name, ""),
    userEmail: stringOr(d.user_email, ""),
    issuedAt: typeof issuedAtRaw === "string" && issuedAtRaw ? parseIso(issuedAtRaw) : new Date(),
  };
}

/** Top-level wrapper for `~/.kagura/credentials.json`. */
export interface CredentialsFile {
  version: number;
  defaultProfile: string;
  profiles: Record<string, OAuthCredentials>;
}

export function emptyCredentialsFile(): CredentialsFile {
  return { version: 1, defaultProfile: "default", profiles: {} };
}

/**
 * Whether `name` is a stored profile. Own keys only: `name in profiles`
 * would call `constructor` or `toString` a profile, since `profiles` is a
 * plain object (#66).
 *
 * @internal Not exported from the package entry point.
 */
export function hasProfile(cf: CredentialsFile, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(cf.profiles, name);
}

/**
 * The profile stored under `name`, or `undefined`. Own keys only, as
 * {@link hasProfile}: every lookup by a name a user typed goes through
 * this or {@link getProfile}.
 *
 * @internal Not exported from the package entry point.
 */
export function profileNamed(cf: CredentialsFile, name: string): OAuthCredentials | undefined {
  return hasProfile(cf, name) ? cf.profiles[name] : undefined;
}

/**
 * `record[key] = value` as an own, enumerable property, whatever the key:
 * assigning `__proto__` would replace the object's prototype instead of
 * storing a profile of that name.
 */
function defineOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Return the named profile, or the default, or `null` if missing. */
export function getProfile(
  cf: CredentialsFile,
  name?: string | null,
): OAuthCredentials | null {
  const key = name || cf.defaultProfile;
  return profileNamed(cf, key) ?? null;
}

/** Insert or replace a profile. The first profile becomes default. */
export function setProfile(cf: CredentialsFile, name: string, creds: OAuthCredentials): void {
  defineOwn(cf.profiles, name, creds);
  if (!hasProfile(cf, cf.defaultProfile)) {
    cf.defaultProfile = name;
  }
}

/** Remove a profile in memory if present; repoints a deleted default. */
export function removeProfile(cf: CredentialsFile, name: string): void {
  if (!hasProfile(cf, name)) {
    return;
  }
  delete cf.profiles[name];
  const next = Object.keys(cf.profiles)[0];
  if (cf.defaultProfile === name && next !== undefined) {
    cf.defaultProfile = next;
  }
}

export function credentialsFileToDict(cf: CredentialsFile): Record<string, unknown> {
  const profiles: Record<string, unknown> = {};
  for (const [name, creds] of Object.entries(cf.profiles)) {
    defineOwn(profiles, name, credentialsToDict(creds));
  }
  return {
    version: cf.version,
    default_profile: cf.defaultProfile,
    profiles,
  };
}

/**
 * @throws Error when `profiles` is present but no object, or any profile is
 *   malformed (as Python's `from_dict`, which calls `.items()` on it); the
 *   lenient loader then treats the file as empty, the strict one refuses it.
 */
export function credentialsFileFromDict(d: Record<string, unknown>): CredentialsFile {
  const profilesRaw = Object.prototype.hasOwnProperty.call(d, "profiles") ? d.profiles : {};
  const profiles: Record<string, OAuthCredentials> = {};
  if (typeof profilesRaw !== "object" || profilesRaw === null || Array.isArray(profilesRaw)) {
    throw new Error("credentials 'profiles' is not an object");
  }
  for (const [name, p] of Object.entries(profilesRaw)) {
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      throw new Error(`credentials profile '${name}' is not an object`);
    }
    defineOwn(profiles, name, credentialsFromDict(p as Record<string, unknown>));
  }
  return {
    version: typeof d.version === "number" ? d.version : 1,
    defaultProfile: stringOr(d.default_profile, "default"),
    profiles,
  };
}

// ---------------------------------------------------------------------------
// Filesystem IO
// ---------------------------------------------------------------------------

/** Force the directory to mode 0700 (best-effort; no-op where unsupported). */
function enforceDirPerms(directory: string): void {
  try {
    const mode = fs.statSync(directory).mode & 0o777;
    if (mode !== CREDENTIALS_DIR_MODE) {
      fs.chmodSync(directory, CREDENTIALS_DIR_MODE);
    }
  } catch {
    // Best-effort: a directory we can't chmod is the user's problem, not
    // ours to abort over. Reads/writes will fail downstream with a clearer
    // error if perms genuinely block access.
  }
}

/** Force the credentials file to mode 0600 (defense in depth, best-effort). */
function enforceFilePerms(filePath: string): void {
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if (mode !== CREDENTIALS_FILE_MODE) {
      fs.chmodSync(filePath, CREDENTIALS_FILE_MODE);
    }
  } catch {
    // Best-effort — see enforceDirPerms.
  }
}

/**
 * Write `data` to `filePath` atomically.
 *
 * Steps: exclusive-create temp file in the same directory → write JSON →
 * fsync → chmod → rename over the target. A kill between any two steps
 * either leaves the original file untouched or replaces it cleanly.
 */
function atomicWriteJson(
  filePath: string,
  data: unknown,
  mode: number = CREDENTIALS_FILE_MODE,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  enforceDirPerms(dir);

  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, filePath);
    // fsync the parent directory so the rename itself is durable on crash /
    // power-loss. Best-effort: Windows and some filesystems don't support
    // fsync on a directory descriptor; the atomic rename already happened,
    // so the worst case is losing the most recent write, never file
    // integrity.
    try {
      const dirFd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // See comment above.
    }
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // fd already closed / invalid — nothing more to release.
      }
    }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function resolvePath(p?: string): string {
  return p ?? defaultCredentialsPath();
}

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && "code" in e;
}

// Python reads the file with `read_text(encoding="utf-8")`, which refuses
// bytes that are not UTF-8 where Node's "utf-8" decoding would replace them
// with U+FFFD (and a rewrite would then save the replacement). A leading BOM
// is kept, as `readFileSync(p, "utf-8")` keeps it, so the JSON parse refuses
// it as `json.loads` does.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Whether nothing at all is at `p`: `lstat` says ENOENT. Any other answer
 * — an entry (a dangling symlink too), or a directory that cannot be
 * searched (EACCES), a path through a file (ENOTDIR), a symlink loop —
 * is not "no file". `fs.existsSync` is `false` for all of them.
 *
 * @throws Error why `p` cannot be looked at, when it cannot.
 */
function isAbsent(p: string): boolean {
  try {
    fs.lstatSync(p);
    return false;
  } catch (e) {
    if (isErrnoException(e) && e.code === "ENOENT") {
      return true;
    }
    throw new Error(`it cannot be read (${excMessage(e)})`);
  }
}

/**
 * Parse the credentials file at `p`; `null` when there is none.
 *
 * Coerces the directory and file permissions to 0700/0600 first
 * (best-effort). Python's `_read_credentials_file`.
 *
 * "None" means nothing is at `p` at all. A dangling symlink, or a
 * directory this process cannot search, is a file that cannot be read:
 * read as "none", the strict loader would let a save replace it with one
 * profile.
 *
 * @throws Error when the file exists but cannot be read or parsed. The
 *   message says which (Python's words), never what the file holds.
 */
function readCredentialsFile(p: string): CredentialsFile | null {
  if (isAbsent(p)) {
    return null;
  }
  enforceDirPerms(path.dirname(p));
  enforceFilePerms(p);

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(p);
  } catch (e) {
    if (isErrnoException(e) && e.code === "ENOENT" && isAbsent(p)) {
      return null; // removed since the check above
    }
    throw new Error(`it cannot be read (${excMessage(e)})`);
  }
  let data: unknown;
  try {
    // Read as Python's json.loads reads it (#69): NaN and the infinities
    // are accepted, and each number literal is kept for the tokens.
    data = parseJsonLossless(STRICT_UTF8.decode(bytes));
  } catch {
    // Not UTF-8, or not JSON: Python's UnicodeDecodeError and
    // JSONDecodeError are both this ValueError.
    throw new Error("it is not valid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("it is not a JSON object");
  }
  try {
    return credentialsFileFromDict(data as Record<string, unknown>);
  } catch {
    throw new Error("it is not a credentials file this SDK can read");
  }
}

/**
 * Read and parse the credentials file.
 *
 * Returns an empty `CredentialsFile` when the file is missing, unreadable,
 * or malformed — the caller can distinguish "no profile" via
 * `getProfile(cf) === null`. On a present file, parent directory and file
 * permissions are coerced to 0700/0600 (best-effort).
 *
 * Every read-modify-write of the file reads it with the strict
 * {@link loadForUpdate} instead, so a file read here as empty is never
 * saved back over.
 */
export function loadCredentialsFile(credentialsPath?: string): CredentialsFile {
  try {
    return readCredentialsFile(resolvePath(credentialsPath)) ?? emptyCredentialsFile();
  } catch {
    // Corrupt or partial file — treat as empty rather than crashing.
    return emptyCredentialsFile();
  }
}

/**
 * The credentials file exists but cannot be read or parsed, or a refreshed
 * profile could not be saved to it. The message names the file and the next
 * step, never what the file holds.
 *
 * @internal Not exported from the package entry point: catch
 *   `KaguraAuthError`.
 */
export class CredentialsFileError extends KaguraAuthError {}

/**
 * Load `credentials.json` for a read-modify-write (Python's
 * `_load_for_update`); the caller holds the file lock, or is about to take
 * one to refresh.
 *
 * A missing file starts empty. One that exists but cannot be read or parsed
 * is refused instead of loading as empty: saving an empty file plus the one
 * profile being written would drop every other profile and the default.
 *
 * @throws CredentialsFileError naming the file and why.
 * @internal Not exported from the package entry point.
 */
export function loadForUpdate(credentialsPath?: string): CredentialsFile {
  const p = resolvePath(credentialsPath);
  try {
    return readCredentialsFile(p) ?? emptyCredentialsFile();
  } catch (e) {
    throw new CredentialsFileError(
      `Cannot update ${p}: ${excMessage(e)}.\n` +
        "  Fix the file, or move it aside and run: kagura-memory auth login",
      { cause: e },
    );
  }
}

/** Atomically persist a `CredentialsFile` to disk. */
export function saveCredentialsFile(cf: CredentialsFile, credentialsPath?: string): void {
  atomicWriteJson(resolvePath(credentialsPath), credentialsFileToDict(cf), CREDENTIALS_FILE_MODE);
}

/**
 * Load, mutate one profile, and atomically save back.
 *
 * The read-modify-write is wrapped in the cross-process lock from
 * `filelock.ts` so concurrent writers in *different* processes cannot lose
 * an update. The lock is on a sibling `credentials.json.lock`, not the
 * file itself, so it never races the atomic rename in
 * `saveCredentialsFile`.
 *
 * @throws KaguraAuthError the file exists but cannot be read or parsed; it
 *   is left as it is rather than rewritten with this profile alone.
 */
export async function updateProfile(
  profileName: string,
  creds: OAuthCredentials,
  credentialsPath?: string,
): Promise<void> {
  const p = resolvePath(credentialsPath);
  await withFileLock(p, () => {
    const cf = loadForUpdate(p);
    setProfile(cf, profileName, creds);
    saveCredentialsFile(cf, p);
  });
}

/**
 * Set `default_profile` to an existing profile (backs `kagura auth use`).
 *
 * Unlike `setProfile`'s implicit first-wins promotion, this is a
 * *deliberate* default selection, wrapped in the same cross-process lock as
 * `updateProfile` so a concurrent refresh/login cannot clobber it.
 *
 * @throws Error if `profileName` is not an existing profile — selecting a
 *   non-existent default would silently break resolution. (Python raises
 *   `KeyError` here; a plain `Error` is the TS equivalent.)
 * @throws KaguraAuthError the file exists but cannot be read or parsed.
 */
export async function setDefaultProfile(
  profileName: string,
  credentialsPath?: string,
): Promise<void> {
  const p = resolvePath(credentialsPath);
  await withFileLock(p, () => {
    const cf = loadForUpdate(p);
    if (!hasProfile(cf, profileName)) {
      throw new Error(`profile '${profileName}' not found in credentials file`);
    }
    cf.defaultProfile = profileName;
    saveCredentialsFile(cf, p);
  });
}

/**
 * Remove a profile and save. No-op if the profile is absent.
 *
 * The read-modify-write is wrapped in the cross-process lock so a logout
 * (delete) racing a concurrent token refresh (update) in a sibling process
 * cannot clobber a freshly written token. The absent-profile early return
 * runs *inside* the lock so the membership check and the save observe one
 * consistent snapshot (no TOCTOU).
 *
 * @throws KaguraAuthError the file exists but cannot be read or parsed.
 */
export async function deleteProfile(
  profileName: string,
  credentialsPath?: string,
): Promise<void> {
  const p = resolvePath(credentialsPath);
  await withFileLock(p, () => {
    const cf = loadForUpdate(p);
    if (!hasProfile(cf, profileName)) {
      return;
    }
    removeProfile(cf, profileName);
    saveCredentialsFile(cf, p);
  });
}

/**
 * Remove the entire credentials file (`kagura auth logout --all`).
 *
 * Missing file is treated as success — logout is idempotent.
 */
export function deleteCredentialsFile(credentialsPath?: string): void {
  fs.rmSync(resolvePath(credentialsPath), { force: true });
}

// ---------------------------------------------------------------------------
// Shared state cache (in-process single-flight)
// ---------------------------------------------------------------------------

/**
 * Minimal promise-chaining mutex — the `asyncio.Lock` equivalent.
 *
 * `runExclusive` calls are serialized in arrival order; a rejection inside
 * one critical section does not poison the chain for later callers.
 */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.catch(() => undefined);
    return run;
  }
}

/**
 * Mutable per-(path, profile) state shared across clients.
 *
 * The `mutex` is shared across **all profiles in the same file** — not
 * per-(path, profile) — so two profiles refreshing concurrently can't both
 * read-modify-write the file and clobber each other's update.
 */
export interface SharedCredentialsState {
  credentials: OAuthCredentials;
  profileName: string;
  /** Resolved absolute path of the credentials file. */
  path: string;
  mutex: AsyncMutex;
  /**
   * The refresh token the file still holds after a refresh of this process
   * could not be saved: the server used it up, and `credentials` holds the
   * one that works. `null` (or absent) once a refresh is saved or adopted,
   * or the file holds another profile.
   */
  usedRefreshToken?: string | null;
  /**
   * The access token on file alongside {@link usedRefreshToken}. The file
   * is behind this process only while it holds both: a server that keeps
   * the refresh token on a refresh (omits it from the response) leaves it
   * unchanged across another process's rotation.
   */
  usedAccessToken?: string | null;
}

/**
 * Whether `onFile` is still the profile a refresh of this process rotated
 * away and could not save (both tokens; see
 * {@link SharedCredentialsState.usedAccessToken}).
 */
function isBehind(
  onFile: OAuthCredentials,
  used: { usedRefreshToken?: string | null; usedAccessToken?: string | null },
): boolean {
  return (
    Boolean(used.usedRefreshToken) &&
    onFile.refreshToken === used.usedRefreshToken &&
    onFile.accessToken === used.usedAccessToken
  );
}

const stateCache = new Map<string, SharedCredentialsState>();
// One mutex per credentials file path, shared across profiles in the same
// file so concurrent refreshes serialize at the file level.
const fileMutexes = new Map<string, AsyncMutex>();

function getFileMutex(p: string): AsyncMutex {
  let mutex = fileMutexes.get(p);
  if (mutex === undefined) {
    mutex = new AsyncMutex();
    fileMutexes.set(p, mutex);
  }
  return mutex;
}

/**
 * Return the shared state for `(path, profile)`, loading lazily.
 *
 * Returns `null` if the credentials file is missing or has no matching
 * profile — the caller falls back to other credential sources (static API
 * key, `.kagura.json`, etc.) in that case.
 *
 * Concurrent clients that resolve to the same `(path, profile)` pair get
 * the same state object, which means they share a single mutex and any
 * refresh fired by one of them benefits all of them.
 */
export function getSharedState(
  credentialsPath?: string,
  profile?: string | null,
): SharedCredentialsState | null {
  return sharedStateFrom(loadCredentialsFile(credentialsPath), credentialsPath, profile);
}

/**
 * {@link getSharedState} from a file the caller already loaded (strictly,
 * say), so it is not read a second time.
 *
 * @internal Not exported from the package entry point.
 */
export function sharedStateFrom(
  cf: CredentialsFile,
  credentialsPath?: string,
  profile?: string | null,
): SharedCredentialsState | null {
  // Normalize the path once so the cache key and the persisted state path
  // stay consistent — a relative path could otherwise cause the cache
  // lookup and the refresh-time write to target different files.
  const p = path.resolve(resolvePath(credentialsPath));
  const creds = getProfile(cf, profile);
  if (creds === null) {
    return null;
  }

  const profileName = profile || cf.defaultProfile;
  // JSON-encode the pair so a path containing spaces can never collide
  // with another (path, profile) combination.
  const key = JSON.stringify([p, profileName]);
  let cached = stateCache.get(key);
  if (cached === undefined) {
    cached = {
      credentials: creds,
      profileName,
      path: p,
      mutex: getFileMutex(p),
    };
    stateCache.set(key, cached);
  } else if (!isBehind(creds, cached)) {
    // Refresh in-memory creds from disk so a recent CLI login is visible
    // to clients already constructed in this process. Not while the file
    // still holds the profile a refresh of this process rotated away and
    // could not save: its access token is revoked and its refresh token
    // used up, and the working pair exists only in memory. Once the file
    // holds another profile (a login, another process's rotation), it wins
    // and this process is no longer ahead of it.
    cached.credentials = creds;
    cached.usedRefreshToken = null;
    cached.usedAccessToken = null;
  }
  return cached;
}

/** Clear the module-level cache. Tests call this between cases. */
export function resetStateCache(): void {
  stateCache.clear();
  fileMutexes.clear();
}

// ---------------------------------------------------------------------------
// KaguraOAuth — AuthProvider with single-flight refresh
// ---------------------------------------------------------------------------

/**
 * `AuthProvider` that supplies the current access token as a Bearer header.
 *
 * Holds a reference to a shared `SharedCredentialsState`, so concurrent
 * client instances pointing at the same credentials file all coalesce
 * refresh calls through a single in-process mutex. When the access token
 * is within `REFRESH_SKEW_SEC` of expiry the mutex is acquired, the
 * refresh runs once, and every other in-flight `getAuthHeader` call waits
 * and then sees the rotated token.
 *
 * (The Python SDK expresses this as an `httpx.Auth` subclass; with `fetch`
 * there is no request-hook layer, so clients ask for a fresh header value
 * before each request instead.)
 */
export class KaguraOAuth implements AuthProvider {
  private readonly state: SharedCredentialsState;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;

  constructor(
    state: SharedCredentialsState,
    options: { fetch?: typeof globalThis.fetch } = {},
  ) {
    this.state = state;
    this.fetchImpl = options.fetch;
  }

  /**
   * Return `Bearer <access_token>`, refreshing first when the token is
   * within the skew window.
   */
  async getAuthHeader(): Promise<string> {
    await this.maybeRefresh();
    return `Bearer ${this.state.credentials.accessToken}`;
  }

  /**
   * Refresh the access token if it's within the skew window.
   *
   * The mutex is held across the entire read-check-refresh-persist
   * sequence so a second caller waiting on it will find the token already
   * rotated when it acquires.
   */
  private async maybeRefresh(): Promise<void> {
    await this.state.mutex.runExclusive(async () => {
      if (!isExpired(this.state.credentials, REFRESH_SKEW_SEC)) {
        return;
      }
      // Skew path: skip when another process already saved a token outside
      // the skew window.
      await refreshSharedState(this.state, {
        expectedStaleToken: null,
        ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      });
    });
  }

  /**
   * Unconditionally refresh the access token, ignoring the skew window.
   *
   * Used on an upstream 401: the token was rejected server-side (rotated /
   * revoked out-of-band) even though it is not yet within the skew window.
   * The same in-process mutex serializes this with skew-driven refreshes.
   * Cross-process dedup is handled in {@link refreshProfileLocked} via the
   * rejected-token identity check.
   *
   * @throws KaguraAuthError also when credentials.json exists but cannot be
   *   read (before any request), or when the refreshed profile could not be
   *   saved — the rotated token is then kept in memory, so this process
   *   stays usable until it expires.
   */
  async forceRefresh(options: { scope?: string } = {}): Promise<void> {
    // Capture the rejected token BEFORE the in-process mutex: if a peer
    // already rotated it while we waited, we must still compare against
    // the token that actually got the 401, otherwise the rotated token
    // would compare equal to disk and force a redundant refresh.
    const rejectedToken = this.state.credentials.accessToken;
    await this.state.mutex.runExclusive(() =>
      refreshSharedState(this.state, {
        expectedStaleToken: rejectedToken,
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Cross-process refresh (shared by KaguraOAuth, refresh() and the CLI)
// ---------------------------------------------------------------------------

/**
 * The server rotated the token, but credentials.json could not be written.
 *
 * `credentials` is the refreshed profile and its only copy: the rotation
 * revoked the access token on file and used up its refresh token, which is
 * `usedRefreshToken` (`null` when the profile was not in the file), with
 * `usedAccessToken` beside it. Python's `_RefreshNotSavedError`. Also what
 * `refresh()` throws when the grant a widening `scope` collected through
 * the device flow could not be saved.
 *
 * The token fields are non-enumerable: this error reaches every caller of
 * a client whose refresh could not be saved, and `console.error(e)`,
 * `util.inspect` and JSON loggers print an error's own enumerable
 * properties (and its `cause`'s) — that would write the live access and
 * refresh token to the log.
 *
 * @internal Not exported from the package entry point: catch
 *   `KaguraAuthError`.
 */
export class RefreshNotSavedError extends CredentialsFileError {
  // `declare`: no class field is emitted (ES2022 would define an
  // enumerable one); the constructor defines them non-enumerable.
  declare readonly credentials: OAuthCredentials;
  declare readonly usedRefreshToken: string | null;
  declare readonly usedAccessToken: string | null;

  constructor(
    message: string,
    credentials: OAuthCredentials,
    onFile: Pick<OAuthCredentials, "accessToken" | "refreshToken"> | null,
    options?: KaguraErrorOptions,
  ) {
    super(message, options);
    Object.defineProperties(this, {
      credentials: { value: credentials, enumerable: false },
      usedRefreshToken: { value: onFile !== null ? onFile.refreshToken : null, enumerable: false },
      usedAccessToken: { value: onFile !== null ? onFile.accessToken : null, enumerable: false },
    });
  }
}

/**
 * Why a save failed, for a "could not save it to <path>: <why>" message:
 * the reason a {@link CredentialsFileError} gives (not its whole text,
 * which names the file and a next step of its own), or the system's.
 *
 * @internal Not exported from the package entry point.
 */
export function saveFailureReason(e: unknown): string {
  return e instanceof CredentialsFileError && e.cause !== undefined ? excMessage(e.cause) : excMessage(e);
}

/**
 * Keep the profile a {@link RefreshNotSavedError} carries on `state`, as
 * its only working copy, and mark the profile the file still holds as one
 * this process is ahead of: {@link getSharedState} does not reload it, and
 * the next refresh sends the refresh token held in memory.
 *
 * @internal Not exported from the package entry point.
 */
export function keepUnsaved(state: SharedCredentialsState, error: RefreshNotSavedError): void {
  state.credentials = error.credentials;
  state.usedRefreshToken = error.usedRefreshToken;
  state.usedAccessToken = error.usedAccessToken;
}

/**
 * What {@link refreshProfileLocked} did (Python's `RefreshResult`).
 *
 * @internal Not exported from the package entry point.
 */
export interface RefreshResult {
  /** The profile now in force, as saved in the file. */
  credentials: OAuthCredentials;
  /**
   * `true` when this call refreshed it; `false` when another process had
   * already rotated the token and its profile was adopted without a
   * network call.
   */
  refreshed: boolean;
}

/** @internal Options of {@link refreshProfileLocked}. */
export interface RefreshProfileLockedOptions {
  /**
   * Governs the "already rotated?" check. `null` (skew path) → skip when
   * the on-disk token is outside `REFRESH_SKEW_SEC` of expiry. A token
   * (forced path: an upstream 401, `auth refresh`) → skip only when the
   * on-disk token differs from it and has not expired; the same token
   * means nobody has rotated yet (a 401 is independent of `expiresAt`).
   */
  expectedStaleToken: string | null;
  /**
   * The caller's copy of the profile, refreshed when the profile is no
   * longer in the file or the file is behind it (`usedRefreshToken`).
   */
  fallback: OAuthCredentials;
  /**
   * A refresh token the caller knows is used up: an earlier refresh of its
   * own consumed it but could not be saved ({@link RefreshNotSavedError}),
   * so `fallback` holds the one that works. While the file still holds it
   * and {@link usedAccessToken}, `fallback` is refreshed instead; once the
   * file holds anything else (another process saved since), the file wins
   * as usual.
   */
  usedRefreshToken?: string | null;
  /** The access token on file beside {@link usedRefreshToken}. */
  usedAccessToken?: string | null;
  /**
   * Scope to request. When set, the refresh always runs: a token another
   * process rotated carries the grant it had, not this one.
   */
  scope?: string;
  /** Credentials file path (default `~/.kagura/credentials.json`). */
  credentialsPath?: string;
  /** Injectable fetch for the token request. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Refresh one profile at most once across processes and save the result
 * (Python's `refresh_profile_locked`).
 *
 * The one refresh path: `KaguraOAuth` (every client and
 * `kagura-memory-mcp`), `refresh()` and the CLI's `auth refresh` /
 * `auth token` all come here. Under the cross-process lock it re-reads the
 * profile and, when another process already rotated the token, returns
 * that profile without calling `/oauth/token/`. Otherwise it refreshes from
 * the refresh token on disk and saves the result before releasing the
 * lock. A refresh token works once (memory-cloud v0.79.0+, #1686), so
 * refreshing from an older copy of the file would earn `invalid_grant`.
 *
 * The lock is held across the network round-trip only: callers must not
 * run anything that waits on a person (the device flow) inside it.
 *
 * @throws KaguraAuthExpiredError the profile holds no refresh token, or the
 *   server answered `invalid_grant`.
 * @throws KaguraAuthError any other OAuth refusal; the file exists but
 *   cannot be read or parsed (checked before any network call, and the file
 *   is left as it is); or the refreshed profile could not be saved
 *   ({@link RefreshNotSavedError}: the server has rotated by then, so the
 *   profile on file can no longer be refreshed and the message says to log
 *   in again).
 * @throws KaguraConnectionError the server was unreachable.
 * @throws FileLockTimeoutError another holder kept the lock past the
 *   acquire timeout.
 * @internal Not exported from the package entry point.
 */
export async function refreshProfileLocked(
  profileName: string,
  options: RefreshProfileLockedOptions,
): Promise<RefreshResult> {
  const p = resolvePath(options.credentialsPath);
  return withFileLock(p, async (): Promise<RefreshResult> => {
    // Before any request: a file that cannot be read must never be
    // rewritten with this one profile, and the refresh would use up the
    // refresh token for a profile that then cannot be saved.
    const onFile = getProfile(loadForUpdate(p), profileName);
    // The file behind the caller (its unsaved refresh): refresh from its copy.
    const disk = onFile !== null && !isBehind(onFile, options) ? onFile : null;
    if (
      disk !== null &&
      options.scope === undefined &&
      alreadyRotated(disk, options.expectedStaleToken)
    ) {
      return { credentials: disk, refreshed: false };
    }
    const refreshed = await networkRefresh(disk ?? options.fallback, options.scope, options.fetch);
    try {
      // We already hold the cross-process lock; write directly rather than
      // via updateProfile (which would re-acquire it and deadlock). Loaded
      // again, unlike Python's single load: a Python process does not see
      // this lock, so a profile it saved during the round-trip is kept.
      const cf = readCredentialsFile(p) ?? emptyCredentialsFile();
      setProfile(cf, profileName, refreshed);
      saveCredentialsFile(cf, p);
    } catch (e) {
      throw new RefreshNotSavedError(
        `Refreshed profile '${profileName}', but could not save it to ${p}: ${excMessage(e)}\n` +
          "  The refresh used up the refresh token on file, so the profile on file cannot be " +
          "refreshed again.\n" +
          "  Fix the cause, then run: kagura-memory auth login",
        refreshed,
        onFile,
        { cause: e },
      );
    }
    return { credentials: refreshed, refreshed: true };
  });
}

/**
 * Refresh `state`'s profile through {@link refreshProfileLocked} and adopt
 * the result. Caller holds `state.mutex`.
 *
 * When the refresh succeeded but could not be saved, the refreshed profile
 * is kept on `state` ({@link keepUnsaved}), so this process stays usable
 * until it expires; the error is rethrown.
 *
 * @internal Not exported from the package entry point.
 */
export async function refreshSharedState(
  state: SharedCredentialsState,
  options: {
    expectedStaleToken: string | null;
    scope?: string;
    fetch?: typeof globalThis.fetch;
  },
): Promise<RefreshResult> {
  try {
    const result = await refreshProfileLocked(state.profileName, {
      expectedStaleToken: options.expectedStaleToken,
      fallback: state.credentials,
      usedRefreshToken: state.usedRefreshToken ?? null,
      usedAccessToken: state.usedAccessToken ?? null,
      credentialsPath: state.path,
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    state.credentials = result.credentials;
    state.usedRefreshToken = null;
    state.usedAccessToken = null;
    return result;
  } catch (e) {
    if (e instanceof RefreshNotSavedError) {
      keepUnsaved(state, e);
    }
    throw e;
  }
}

/** Whether `disk` shows another process already produced a usable token. */
function alreadyRotated(disk: OAuthCredentials, expectedStaleToken: string | null): boolean {
  if (expectedStaleToken === null) {
    // Skew path: a token outside the skew window is fresh enough.
    return !isExpired(disk, REFRESH_SKEW_SEC);
  }
  // Forced path: a different token means someone rotated, unless it has
  // expired too (a file put back from an older copy, a writer whose clock
  // is behind): there is nothing fresh to adopt, so refresh, from the
  // refresh token on file. An identical token means the stale token is
  // still current and we must refresh. (Python's `_already_rotated` adopts
  // any different token; the gate1 design of #92 requires a live one.)
  return disk.accessToken !== expectedStaleToken && !isExpired(disk);
}

/** Hit `/oauth/token/` with `base`'s refresh token. Caller holds the file lock. */
async function networkRefresh(
  base: OAuthCredentials,
  scope: string | undefined,
  fetchImpl: typeof globalThis.fetch | undefined,
): Promise<OAuthCredentials> {
  // A profile stored without a refresh token cannot be refreshed. Going
  // to the network first only earns an `invalid_grant`, whose message
  // ("refresh token is no longer valid") describes a token that never
  // existed — the actual cause is that the grant never carried offline
  // access. Fail here instead, naming that.
  if (!base.refreshToken) {
    throw new KaguraAuthExpiredError(
      "This profile was stored without a refresh token, so it cannot be " +
        "refreshed — log in again to get one.\n" +
        "  Run: kagura auth login (or `npx kagura-memory auth login`)",
      base.expiresAt,
    );
  }

  const token = await refreshAccessToken(base.server, {
    clientId: base.clientId,
    refreshToken: base.refreshToken,
    ...(scope !== undefined ? { scope } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  // Pass `null` when the server omits `refresh_token` so the stored token
  // is preserved: `TokenResponse.refreshToken` defaults to "" when
  // absent, and overwriting a valid stored token with an empty one would
  // break every subsequent refresh.
  return withRefreshed(base, {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken || null,
    expiresAt: token.expiresAt,
    // `||` not `??`: TokenResponse.scope defaults to "" when the server
    // omits it, and withRefreshed's `?? creds.scope` only catches
    // null/undefined — so an omitted scope used to blank the stored one.
    scope: token.scope || null,
  });
}
