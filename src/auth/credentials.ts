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
 * round-trip when another process already rotated it.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { KaguraAuthExpiredError } from "../errors.js";
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
    accessToken: requireString(d, "access_token"),
    refreshToken: requireString(d, "refresh_token"),
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

/** Return the named profile, or the default, or `null` if missing. */
export function getProfile(
  cf: CredentialsFile,
  name?: string | null,
): OAuthCredentials | null {
  const key = name || cf.defaultProfile;
  return cf.profiles[key] ?? null;
}

/** Insert or replace a profile. The first profile becomes default. */
export function setProfile(cf: CredentialsFile, name: string, creds: OAuthCredentials): void {
  cf.profiles[name] = creds;
  if (!(cf.defaultProfile in cf.profiles)) {
    cf.defaultProfile = name;
  }
}

/** Remove a profile in memory if present; repoints a deleted default. */
export function removeProfile(cf: CredentialsFile, name: string): void {
  delete cf.profiles[name];
  const next = Object.keys(cf.profiles)[0];
  if (cf.defaultProfile === name && next !== undefined) {
    cf.defaultProfile = next;
  }
}

export function credentialsFileToDict(cf: CredentialsFile): Record<string, unknown> {
  const profiles: Record<string, unknown> = {};
  for (const [name, creds] of Object.entries(cf.profiles)) {
    profiles[name] = credentialsToDict(creds);
  }
  return {
    version: cf.version,
    default_profile: cf.defaultProfile,
    profiles,
  };
}

/** @throws Error when any profile is malformed (caller treats file as empty). */
export function credentialsFileFromDict(d: Record<string, unknown>): CredentialsFile {
  const profilesRaw = d.profiles;
  const profiles: Record<string, OAuthCredentials> = {};
  if (typeof profilesRaw === "object" && profilesRaw !== null && !Array.isArray(profilesRaw)) {
    for (const [name, p] of Object.entries(profilesRaw)) {
      if (typeof p !== "object" || p === null || Array.isArray(p)) {
        throw new Error(`credentials profile '${name}' is not an object`);
      }
      profiles[name] = credentialsFromDict(p as Record<string, unknown>);
    }
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

/**
 * Read and parse the credentials file.
 *
 * Returns an empty `CredentialsFile` when the file is missing, unreadable,
 * or malformed — the caller can distinguish "no profile" via
 * `getProfile(cf) === null`. On a present file, parent directory and file
 * permissions are coerced to 0700/0600 (best-effort).
 */
export function loadCredentialsFile(credentialsPath?: string): CredentialsFile {
  const p = resolvePath(credentialsPath);
  if (!fs.existsSync(p)) {
    return emptyCredentialsFile();
  }

  enforceDirPerms(path.dirname(p));
  enforceFilePerms(p);

  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return emptyCredentialsFile();
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return emptyCredentialsFile();
  }
  try {
    return credentialsFileFromDict(data as Record<string, unknown>);
  } catch {
    // Corrupt or partial file — treat as empty rather than crashing.
    return emptyCredentialsFile();
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
 */
export async function updateProfile(
  profileName: string,
  creds: OAuthCredentials,
  credentialsPath?: string,
): Promise<void> {
  const p = resolvePath(credentialsPath);
  await withFileLock(p, () => {
    const cf = loadCredentialsFile(p);
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
 */
export async function setDefaultProfile(
  profileName: string,
  credentialsPath?: string,
): Promise<void> {
  const p = resolvePath(credentialsPath);
  await withFileLock(p, () => {
    const cf = loadCredentialsFile(p);
    if (!(profileName in cf.profiles)) {
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
 */
export async function deleteProfile(
  profileName: string,
  credentialsPath?: string,
): Promise<void> {
  const p = resolvePath(credentialsPath);
  await withFileLock(p, () => {
    const cf = loadCredentialsFile(p);
    if (!(profileName in cf.profiles)) {
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
  // Normalize the path once so the cache key and the persisted state path
  // stay consistent — a relative path could otherwise cause the cache
  // lookup and the refresh-time write to target different files.
  const p = path.resolve(resolvePath(credentialsPath));
  const cf = loadCredentialsFile(p);
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
  } else {
    // Refresh in-memory creds from disk so a recent CLI login is visible
    // to clients already constructed in this process.
    cached.credentials = creds;
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
      await this.refreshLocked(null);
    });
  }

  /**
   * Unconditionally refresh the access token, ignoring the skew window.
   *
   * Used on an upstream 401: the token was rejected server-side (rotated /
   * revoked out-of-band) even though it is not yet within the skew window.
   * The same in-process mutex serializes this with skew-driven refreshes.
   * Cross-process dedup is handled in `refreshLocked` via the
   * rejected-token identity check.
   */
  async forceRefresh(options: { scope?: string } = {}): Promise<void> {
    // Capture the rejected token BEFORE the in-process mutex: if a peer
    // already rotated it while we waited, we must still compare against
    // the token that actually got the 401, otherwise the rotated token
    // would compare equal to disk and force a redundant refresh.
    const rejectedToken = this.state.credentials.accessToken;
    await this.state.mutex.runExclusive(() =>
      this.refreshLocked(rejectedToken, options.scope),
    );
  }

  /**
   * Refresh `/oauth/token/` once across all processes. Caller holds the
   * in-process mutex.
   *
   * After acquiring the cross-process file lock, re-read the credentials
   * from disk and **skip the network call when another process already
   * rotated the token** — "skip" means "adopt the on-disk result", never
   * "leave the stale in-memory token in place".
   *
   * `expectedStaleToken` governs the "already rotated?" predicate:
   * `null` (skew path) → skip when the on-disk token is no longer within
   * the skew window. A token string (401 path) → skip only when the
   * on-disk token *differs* from the rejected one (a 401 is independent of
   * `expiresAt`).
   */
  private async refreshLocked(
    expectedStaleToken: string | null,
    scope?: string,
  ): Promise<void> {
    const credPath = this.state.path;
    const profileName = this.state.profileName;
    await withFileLock(credPath, async () => {
      const disk = getProfile(loadCredentialsFile(credPath), profileName);
      // A scope change must never adopt a peer's rotation: that token was
      // issued for the *old* scope, so treating it as "already done" would
      // silently drop the change the caller asked for.
      if (scope === undefined && disk !== null && this.alreadyRotated(disk, expectedStaleToken)) {
        this.state.credentials = disk;
        return;
      }
      const base = disk ?? this.state.credentials;
      await this.networkRefreshAndSave(base, credPath, profileName, scope);
    });
  }

  /** Whether `disk` shows another process already produced a usable token. */
  private alreadyRotated(disk: OAuthCredentials, expectedStaleToken: string | null): boolean {
    if (expectedStaleToken === null) {
      // Skew path: a token outside the skew window is fresh enough.
      return !isExpired(disk, REFRESH_SKEW_SEC);
    }
    // 401 path: a different token means someone rotated; an identical token
    // means the rejected token is still current and we must refresh.
    return disk.accessToken !== expectedStaleToken;
  }

  /** Hit `/oauth/token/` from `base` and persist. Caller holds both locks. */
  private async networkRefreshAndSave(
    base: OAuthCredentials,
    credPath: string,
    profileName: string,
    scope?: string,
  ): Promise<void> {
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
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    // Pass `null` when the server omits `refresh_token` so the stored token
    // is preserved: `TokenResponse.refreshToken` defaults to "" when
    // absent, and overwriting a valid stored token with an empty one would
    // break every subsequent refresh.
    this.state.credentials = withRefreshed(base, {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken || null,
      expiresAt: token.expiresAt,
      // `||` not `??`: TokenResponse.scope defaults to "" when the server
      // omits it, and withRefreshed's `?? creds.scope` only catches
      // null/undefined — so an omitted scope used to blank the stored one.
      scope: token.scope || null,
    });
    // We already hold the cross-process lock; write directly rather than
    // via updateProfile (which would re-acquire the same lock and
    // deadlock). Re-load → set → save still preserves every other profile
    // in the file.
    const cf = loadCredentialsFile(credPath);
    setProfile(cf, profileName, this.state.credentials);
    saveCredentialsFile(cf, credPath);
  }
}
