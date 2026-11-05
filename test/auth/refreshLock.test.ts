/**
 * The one locked refresh path (#92, Python SDK 0.44.0 #313 / PR #316).
 *
 * A refresh token works once (memory-cloud v0.79.0+, #1686), so every
 * refresh — `KaguraOAuth` (clients, `kagura-memory-mcp`), `refresh()` and
 * the CLI — re-reads credentials.json under the cross-process lock and
 * adopts a profile another process already rotated. Around that path:
 * a credentials.json that cannot be read is refused before any request and
 * left as it is, and a refreshed profile that cannot be saved is a typed
 * error that keeps the rotated token in memory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AsyncMutex,
  CredentialsFileError,
  KaguraOAuth,
  RefreshNotSavedError,
  deleteProfile,
  emptyCredentialsFile,
  getProfile,
  getSharedState,
  loadCredentialsFile,
  loadForUpdate,
  refreshProfileLocked,
  resetStateCache,
  saveCredentialsFile,
  setDefaultProfile,
  setProfile,
  updateProfile,
  type OAuthCredentials,
  type SharedCredentialsState,
} from "../../src/auth/credentials.js";
import { acquireFileLock } from "../../src/auth/filelock.js";
import { refresh, refreshProfile } from "../../src/auth/refresh.js";
import { KaguraAuthError, KaguraAuthExpiredError } from "../../src/errors.js";

// Python monkeypatches save_credentials_file to raise OSError; ESM
// namespaces are read-only, so the atomic write's rename is swapped at
// module level instead, failing only on request.
const failRename = vi.hoisted(() => ({ errors: [] as Error[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      const error = failRename.errors.shift();
      if (error !== undefined) throw error;
      actual.renameSync(from, to);
    },
  };
});

/** The error a read-only filesystem gives the atomic write's rename. */
function erofs(): Error {
  return Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
}

let dir: string;
let credentialsPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-refresh-lock-"));
  credentialsPath = path.join(dir, "credentials.json");
  failRename.errors = [];
  resetStateCache();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  failRename.errors = [];
  resetStateCache();
});

function creds(over: Partial<OAuthCredentials> = {}): OAuthCredentials {
  return {
    server: "https://x.test",
    mcpUrl: "https://x.test/mcp",
    clientId: "kagura-cli",
    accessToken: "atok-1",
    refreshToken: "rtok-1",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 3600_000),
    scope: "memory:read memory:write",
    workspaceId: "ws-1",
    workspaceName: "Acme",
    userEmail: "dev@kagura-ai.com",
    issuedAt: new Date(),
    ...over,
  };
}

function seed(profiles: Record<string, OAuthCredentials>, defaultProfile?: string): void {
  const cf = emptyCredentialsFile();
  for (const [name, c] of Object.entries(profiles)) setProfile(cf, name, c);
  if (defaultProfile !== undefined) cf.defaultProfile = defaultProfile;
  saveCredentialsFile(cf, credentialsPath);
}

function onDisk(name = "default"): OAuthCredentials | null {
  return getProfile(loadCredentialsFile(credentialsPath), name);
}

/** A state with its own mutex — a stand-in for a separate process. */
function independentState(c: OAuthCredentials): SharedCredentialsState {
  return { credentials: c, profileName: "default", path: path.resolve(credentialsPath), mutex: new AsyncMutex() };
}

/**
 * A single-use token endpoint, as memory-cloud v0.79.0+ is: each refresh
 * token is answered once with the pair `issued` maps it to, and a second
 * use earns `invalid_grant`.
 */
function singleUseEndpoint(issued: Record<string, [access: string, refresh: string, ttlSeconds: number]>) {
  const sent: string[] = [];
  const impl = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const token = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
    const pair = issued[token];
    if (sent.includes(token) || pair === undefined) {
      sent.push(token);
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    sent.push(token);
    const [access, refreshToken, ttl] = pair;
    return Response.json({
      access_token: access,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: ttl,
      scope: "memory:read memory:write",
    });
  };
  return { sent, fetch: impl as typeof globalThis.fetch };
}

const neverFetch = (async () => {
  throw new Error("fetch must not be called");
}) as unknown as typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// A credentials.json that cannot be read is never rewritten
// ---------------------------------------------------------------------------

/** Python 0.44.0's `_UNREADABLE_FILES`, with the reason each is refused for. */
const UNREADABLE: [label: string, bytes: Buffer, reason: string][] = [
  ["not JSON", Buffer.from("not json {{{"), "it is not valid JSON"],
  ["not UTF-8", Buffer.from([0xff]), "it is not valid JSON"],
  ["a JSON array", Buffer.from('["an", "array"]'), "it is not a JSON object"],
  ["profiles not a map", Buffer.from('{"profiles": []}'), "it is not a credentials file this SDK can read"],
  [
    "a profile missing fields",
    Buffer.from('{"profiles": {"default": {"server": "x"}}}'),
    "it is not a credentials file this SDK can read",
  ],
];

function cannotUpdate(reason: string): string {
  return (
    `Cannot update ${credentialsPath}: ${reason}.\n` +
    "  Fix the file, or move it aside and run: kagura-memory auth login"
  );
}

describe("a credentials.json that cannot be read (#92)", () => {
  it.each(UNREADABLE)("the lenient reader still reads %s as empty", (_label, bytes) => {
    fs.writeFileSync(credentialsPath, bytes);
    expect(loadCredentialsFile(credentialsPath).profiles).toEqual({});
  });

  // Python's `kagura auth refresh` reads the file leniently first.
  it.each(UNREADABLE)("refresh() reads %s as no profile, sending nothing, leaving it as it is", async (_label, bytes) => {
    fs.writeFileSync(credentialsPath, bytes);
    const fetch = vi.fn(neverFetch);

    await expect(refresh({ credentialsPath, fetch })).rejects.toThrow(
      "No profile named 'default'.\n  Run: kagura-memory auth login",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(credentialsPath)).toEqual(bytes);
  });

  it.each(UNREADABLE)(
    "refresh() refuses %s that it became by the time the lock is held, before any request",
    async (_label, bytes, reason) => {
      seed({ default: creds() });
      // A peer holds the lock; refresh() reads the file, then waits.
      const lock = await acquireFileLock(credentialsPath);
      const fetch = vi.fn(neverFetch);
      const pending = refresh({ credentialsPath, fetch }).catch((e: unknown) => e);
      fs.writeFileSync(credentialsPath, bytes);
      lock.release();

      const error = await pending;
      expect(error).toBeInstanceOf(CredentialsFileError);
      expect(error).toBeInstanceOf(KaguraAuthError);
      expect((error as Error).message).toBe(cannotUpdate(reason));
      expect(fetch).not.toHaveBeenCalled();
      expect(fs.readFileSync(credentialsPath)).toEqual(bytes);
    },
  );

  it("names a file that cannot be read at all, with the system's reason", async () => {
    fs.mkdirSync(credentialsPath); // EISDIR on read
    await expect(
      refreshProfileLocked("default", { expectedStaleToken: "atok-1", fallback: creds(), credentialsPath, fetch: neverFetch }),
    ).rejects.toThrow(
      new RegExp(`^Cannot update ${credentialsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: it cannot be read \\(EISDIR`),
    );
  });

  // fs.existsSync is false for a dangling symlink: read as "no file", the
  // save would replace the link with a file holding one profile.
  it("refuses a credentials.json that is a dangling symlink, and leaves the link as it is", async () => {
    const target = path.join(dir, "elsewhere", "credentials.json");
    fs.symlinkSync(target, credentialsPath);
    const fetch = vi.fn(neverFetch);

    for (const attempt of [
      () => refreshProfileLocked("default", { expectedStaleToken: "atok-1", fallback: creds(), credentialsPath, fetch }),
      () => updateProfile("default", creds(), credentialsPath),
      () => setDefaultProfile("default", credentialsPath),
      () => deleteProfile("default", credentialsPath),
    ]) {
      const error = await attempt().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CredentialsFileError);
      expect((error as Error).message).toMatch(/: it cannot be read \(ENOENT/);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.lstatSync(credentialsPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(credentialsPath)).toBe(target);
    expect(fs.existsSync(target)).toBe(false);
    // The lenient reader still reads it as empty, as Python's does.
    expect(loadCredentialsFile(credentialsPath).profiles).toEqual({});
  });

  // A directory this process cannot search: existsSync is false here too,
  // and a save (which chmods the directory back) would drop every profile.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a credentials.json in a directory it cannot search, and leaves the file as it is",
    async () => {
      seed({ default: creds(), work: creds({ accessToken: "work-token" }) });
      const before = fs.readFileSync(credentialsPath);
      fs.chmodSync(dir, 0o600); // read and write, no search
      let thrown: unknown;
      try {
        loadForUpdate(credentialsPath);
      } catch (e) {
        thrown = e;
      } finally {
        fs.chmodSync(dir, 0o700);
      }
      expect(thrown).toBeInstanceOf(CredentialsFileError);
      expect((thrown as Error).message).toMatch(/^Cannot update .*: it cannot be read \(EACCES/);
      expect(fs.readFileSync(credentialsPath)).toEqual(before);

      fs.chmodSync(dir, 0o600);
      try {
        expect(loadCredentialsFile(credentialsPath).profiles).toEqual({});
        // A write refuses too (here already taking the lock beside it).
        await expect(updateProfile("default", creds({ accessToken: "new" }), credentialsPath)).rejects.toThrow(/EACCES/);
      } finally {
        fs.chmodSync(dir, 0o700);
      }
      expect(fs.readFileSync(credentialsPath)).toEqual(before);
    },
  );

  it.each(UNREADABLE)(
    "KaguraOAuth refuses %s that appeared after it loaded, on both refresh paths",
    async (_label, bytes, reason) => {
      seed({ default: creds({ expiresAt: new Date(Date.now() + 10_000) }) }); // inside the skew window
      const state = getSharedState(credentialsPath);
      expect(state).not.toBeNull();
      fs.writeFileSync(credentialsPath, bytes);
      const fetch = vi.fn(neverFetch);
      const auth = new KaguraOAuth(state!, { fetch });

      await expect(auth.getAuthHeader()).rejects.toThrow(cannotUpdate(reason));
      await expect(auth.forceRefresh()).rejects.toThrow(cannotUpdate(reason));
      expect(fetch).not.toHaveBeenCalled();
      expect(fs.readFileSync(credentialsPath)).toEqual(bytes);
      // Nothing was refreshed, so nothing changed in memory either.
      expect(state!.credentials.accessToken).toBe("atok-1");
    },
  );

  it.each(UNREADABLE)("refreshProfileLocked refuses %s even for a caller holding the profile", async (_label, bytes) => {
    fs.writeFileSync(credentialsPath, bytes);
    const fetch = vi.fn(neverFetch);
    await expect(
      refreshProfileLocked("default", { expectedStaleToken: "atok-1", fallback: creds(), credentialsPath, fetch }),
    ).rejects.toBeInstanceOf(CredentialsFileError);
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(credentialsPath)).toEqual(bytes);
  });

  // Python's test_read_modify_write_refuses_a_file_it_cannot_read: loading
  // it as empty and saving would rewrite it with one profile (or none).
  it.each(
    UNREADABLE.flatMap(([label, bytes, reason]) =>
      (["updateProfile", "setDefaultProfile", "deleteProfile"] as const).map(
        (write) => [write, label, bytes, reason] as const,
      ),
    ),
  )("%s refuses %s, naming it, and leaves it as it is", async (write, _label, bytes, reason) => {
    fs.writeFileSync(credentialsPath, bytes);
    const calls = {
      updateProfile: () => updateProfile("default", creds(), credentialsPath),
      setDefaultProfile: () => setDefaultProfile("default", credentialsPath),
      deleteProfile: () => deleteProfile("default", credentialsPath),
    };
    await expect(calls[write]()).rejects.toThrow(cannotUpdate(reason));
    expect(fs.readFileSync(credentialsPath)).toEqual(bytes);
  });

  it("still starts a missing file empty: only an existing file that cannot be read is refused", async () => {
    const nested = path.join(dir, "sub", "credentials.json");
    await updateProfile("work", creds({ accessToken: "first" }), nested);
    const cf = loadCredentialsFile(nested);
    expect(cf.defaultProfile).toBe("work");
    expect(Object.keys(cf.profiles)).toEqual(["work"]);
  });

  it("still says 'no profile' for a missing file", async () => {
    await expect(refresh({ credentialsPath, fetch: neverFetch })).rejects.toThrow(
      "No profile named 'default'.\n  Run: kagura-memory auth login",
    );
    expect(fs.existsSync(credentialsPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Two processes refreshing one profile
// ---------------------------------------------------------------------------

describe("two processes refreshing one profile (#92)", () => {
  // Python's test_cli_and_proxy_refresh_race_makes_one_token_call: a
  // CLI-style forced refresh races a kagura-memory-mcp forceRefresh in
  // another process (its own mutex) against a single-use endpoint.
  it.each(["the CLI first", "the proxy first"])(
    "makes one token call, and both end with the rotated token (%s)",
    async (order) => {
      seed({ default: creds() });
      const endpoint = singleUseEndpoint({ "rtok-1": ["atok-2", "rtok-2", 3600] });
      const proxyState = independentState(creds());
      const proxy = new KaguraOAuth(proxyState, { fetch: endpoint.fetch });
      const cli = () => refreshProfile({ credentialsPath, fetch: endpoint.fetch });

      let cliResult: Awaited<ReturnType<typeof cli>>;
      if (order === "the CLI first") [cliResult] = await Promise.all([cli(), proxy.forceRefresh()]);
      else [, cliResult] = await Promise.all([proxy.forceRefresh(), cli()]);

      expect(endpoint.sent).toEqual(["rtok-1"]);
      expect(cliResult.credentials.accessToken).toBe("atok-2");
      expect(cliResult.refreshed).toBe(order === "the CLI first");
      expect(proxyState.credentials.accessToken).toBe("atok-2");
      expect([onDisk()?.accessToken, onDisk()?.refreshToken]).toEqual(["atok-2", "rtok-2"]);
    },
  );

  it("adopts what a peer saved while it waited on the lock, sending nothing", async () => {
    seed({ default: creds() });
    // The peer holds the lock; the refresh reads the file, then waits.
    const lock = await acquireFileLock(credentialsPath);
    const fetch = vi.fn(neverFetch);
    const pending = refreshProfile({ credentialsPath, fetch });
    // Holding the lock, the peer saves its rotation (consuming rtok-1).
    seed({ default: creds({ accessToken: "atok-peer", refreshToken: "rtok-peer" }) });
    lock.release();

    const result = await pending;
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ profile: "default", refreshed: false });
    expect(result.credentials.accessToken).toBe("atok-peer");
    expect(onDisk()?.refreshToken).toBe("rtok-peer");
  });

  it("the skew path adopts a peer's token outside the skew window", async () => {
    seed({ default: creds({ accessToken: "atok-peer" }) });
    const fetch = vi.fn(neverFetch);
    const result = await refreshProfileLocked("default", {
      expectedStaleToken: null,
      fallback: creds({ expiresAt: new Date(Date.now() + 10_000) }),
      credentialsPath,
      fetch,
    });
    expect(result).toEqual({ credentials: expect.objectContaining({ accessToken: "atok-peer" }), refreshed: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the skew path refreshes a different token on file that is inside the skew window, from the file", async () => {
    seed({
      default: creds({ accessToken: "atok-peer", refreshToken: "rtok-peer", expiresAt: new Date(Date.now() + 10_000) }),
    });
    const endpoint = singleUseEndpoint({ "rtok-peer": ["atok-2", "rtok-2", 3600] });
    const result = await refreshProfileLocked("default", {
      expectedStaleToken: null,
      fallback: creds({ expiresAt: new Date(Date.now() + 10_000) }),
      credentialsPath,
      fetch: endpoint.fetch,
    });
    expect(endpoint.sent).toEqual(["rtok-peer"]);
    expect(result).toEqual({ credentials: expect.objectContaining({ accessToken: "atok-2" }), refreshed: true });
  });

  // gate1 of #92: a different token on file is another process's rotation
  // only while it is live. One that expired as well (a file put back from
  // an older copy, a writer whose clock is behind) is refreshed — from the
  // refresh token on file, the latest — not reported as "already refreshed".
  it("the forced path does not adopt a different token on file that has expired too", async () => {
    seed({
      default: creds({ accessToken: "atok-old", refreshToken: "rtok-disk", expiresAt: new Date(Date.now() - 1000) }),
    });
    const endpoint = singleUseEndpoint({ "rtok-disk": ["atok-2", "rtok-2", 3600] });
    const result = await refreshProfileLocked("default", {
      expectedStaleToken: "atok-1",
      fallback: creds(),
      credentialsPath,
      fetch: endpoint.fetch,
    });
    expect(endpoint.sent).toEqual(["rtok-disk"]);
    expect(result).toEqual({ credentials: expect.objectContaining({ accessToken: "atok-2" }), refreshed: true });
    expect([onDisk()?.accessToken, onDisk()?.refreshToken]).toEqual(["atok-2", "rtok-2"]);
  });

  it("a scope always reaches the server, from the refresh token on file", async () => {
    seed({ default: creds({ accessToken: "atok-peer", refreshToken: "rtok-peer" }) });
    const endpoint = singleUseEndpoint({ "rtok-peer": ["atok-narrow", "rtok-narrow", 3600] });
    const result = await refreshProfileLocked("default", {
      expectedStaleToken: "atok-1",
      fallback: creds(),
      scope: "memory:read",
      credentialsPath,
      fetch: endpoint.fetch,
    });
    expect(endpoint.sent).toEqual(["rtok-peer"]);
    expect(result.refreshed).toBe(true);
  });

  it("keeps every other profile and the default when it saves", async () => {
    seed({ work: creds({ accessToken: "work-token" }), default: creds() }, "work");
    const endpoint = singleUseEndpoint({ "rtok-1": ["atok-2", "rtok-2", 3600] });
    await refresh({ credentialsPath, profile: "default", fetch: endpoint.fetch });
    const cf = loadCredentialsFile(credentialsPath);
    expect(cf.defaultProfile).toBe("work");
    expect(cf.profiles.work?.accessToken).toBe("work-token");
    expect(cf.profiles.default?.accessToken).toBe("atok-2");
  });

  // Defensive re-read for an unexpected external edit. Supported concurrent
  // writers must honor lock-v1; this is not cross-SDK lock interoperability.
  it("keeps a profile written during the round-trip by a writer that does not see this lock", async () => {
    seed({ default: creds() });
    const fetch = (async () => {
      const cf = loadCredentialsFile(credentialsPath);
      setProfile(cf, "work", creds({ accessToken: "work-token" }));
      saveCredentialsFile(cf, credentialsPath);
      return Response.json({ access_token: "atok-2", refresh_token: "rtok-2", expires_in: 3600 });
    }) as unknown as typeof globalThis.fetch;

    await refreshProfileLocked("default", { expectedStaleToken: "atok-1", fallback: creds(), credentialsPath, fetch });

    const cf = loadCredentialsFile(credentialsPath);
    expect(cf.profiles.work?.accessToken).toBe("work-token");
    expect(cf.profiles.default?.accessToken).toBe("atok-2");
  });

  it("has saved the refreshed profile by the time the lock is released", async () => {
    seed({ default: creds() });
    const endpoint = singleUseEndpoint({ "rtok-1": ["atok-2", "rtok-2", 3600] });
    await refreshProfileLocked("default", {
      expectedStaleToken: "atok-1",
      fallback: creds(),
      credentialsPath,
      fetch: endpoint.fetch,
    });
    expect(fs.existsSync(`${credentialsPath}.lock-v1`)).toBe(false);
    expect(onDisk()?.accessToken).toBe("atok-2");
  });
});

// ---------------------------------------------------------------------------
// A refreshed profile that cannot be saved
// ---------------------------------------------------------------------------

function notSaved(reason: string, profile = "default"): string {
  return (
    `Refreshed profile '${profile}', but could not save it to ${credentialsPath}: ${reason}\n` +
    "  The refresh used up the refresh token on file, so the profile on file cannot be refreshed again.\n" +
    "  Fix the cause, then run: kagura-memory auth login"
  );
}

describe("a refreshed profile that cannot be saved (#92)", () => {
  it("is a KaguraAuthError naming the file and auth login, and keeps the new token in memory", async () => {
    seed({ default: creds({ accessToken: "old", refreshToken: "rtok-old" }) });
    const state = independentState(creds({ accessToken: "old", refreshToken: "rtok-old" }));
    const endpoint = singleUseEndpoint({ "rtok-old": ["fresh", "rtok-fresh", 3600] });
    const auth = new KaguraOAuth(state, { fetch: endpoint.fetch });
    const cause = erofs();
    failRename.errors = [cause];

    const error = await auth.forceRefresh().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraAuthError);
    expect(error).toBeInstanceOf(RefreshNotSavedError);
    expect(error).not.toBeInstanceOf(KaguraAuthExpiredError);
    expect((error as Error).message).toBe(notSaved("EROFS: read-only file system"));
    expect((error as Error).cause).toBe(cause);
    expect((error as RefreshNotSavedError).usedRefreshToken).toBe("rtok-old");
    // The process stays usable; the file is as it was.
    expect(state.credentials.accessToken).toBe("fresh");
    expect(await auth.getAuthHeader()).toBe("Bearer fresh");
    expect([onDisk()?.accessToken, onDisk()?.refreshToken]).toEqual(["old", "rtok-old"]);
    // No temporary file is left behind.
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  // It reaches every caller of a client whose refresh could not be saved;
  // Node's inspect (console.error) and JSON loggers print an error's own
  // enumerable properties, and its cause's.
  it("keeps the tokens it carries out of what a logger prints", async () => {
    seed({ default: creds({ accessToken: "atok-on-file", refreshToken: "rtok-on-file" }) });
    const state = independentState(creds({ accessToken: "atok-on-file", refreshToken: "rtok-on-file" }));
    const endpoint = singleUseEndpoint({ "rtok-on-file": ["atok-live-secret", "rtok-live-secret", 3600] });
    failRename.errors = [erofs()];

    const error = await new KaguraOAuth(state, { fetch: endpoint.fetch }).forceRefresh().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefreshNotSavedError);
    const notSavedError = error as RefreshNotSavedError;
    // Still there for the shared state to keep...
    expect(notSavedError.credentials.accessToken).toBe("atok-live-secret");
    expect(notSavedError.usedRefreshToken).toBe("rtok-on-file");
    // ...but in nothing a logger prints, also as another error's cause.
    const printed = [
      util.inspect(notSavedError, { depth: 10 }),
      util.inspect(new Error("request failed", { cause: notSavedError }), { depth: 10 }),
      JSON.stringify(notSavedError),
      notSavedError.message,
    ];
    for (const shown of printed) {
      for (const secret of ["atok-live-secret", "rtok-live-secret", "rtok-on-file", "atok-on-file"]) {
        expect(shown).not.toContain(secret);
      }
    }
  });

  it("refresh() throws it too, and the profile on file is left as it was", async () => {
    seed({ default: creds() });
    const endpoint = singleUseEndpoint({ "rtok-1": ["atok-2", "rtok-2", 3600] });
    failRename.errors = [erofs()];
    await expect(refresh({ credentialsPath, fetch: endpoint.fetch })).rejects.toThrow(
      notSaved("EROFS: read-only file system"),
    );
    expect(onDisk()?.accessToken).toBe("atok-1");
  });

  // Python's test_refresh_after_a_failed_save_sends_the_refresh_token_held_in_memory:
  // the file still holds the pair the first refresh rotated away, so
  // refreshing from it — or (401 path) adopting it because it differs from
  // the rejected token — would end in "login expired".
  it.each(["skew", "401"])(
    "the next refresh after a failed save sends the refresh token held in memory (%s path)",
    async (kind) => {
      const soon = new Date(Date.now() + 5_000); // within REFRESH_SKEW_SEC
      seed({ default: creds({ accessToken: "t1", refreshToken: "r1", expiresAt: soon }) });
      const state = independentState(creds({ accessToken: "t1", refreshToken: "r1", expiresAt: soon }));
      // t2 is issued inside the skew window too, so the skew path refreshes again.
      const endpoint = singleUseEndpoint({ r1: ["t2", "r2", 10], r2: ["t3", "r3", 3600] });
      const auth = new KaguraOAuth(state, { fetch: endpoint.fetch });

      failRename.errors = [erofs()];
      await expect(auth.getAuthHeader()).rejects.toBeInstanceOf(RefreshNotSavedError);
      expect(state.credentials.accessToken).toBe("t2");
      expect(state.usedRefreshToken).toBe("r1");
      if (kind === "skew") await auth.getAuthHeader();
      else await auth.forceRefresh(); // t2 rejected upstream

      expect(endpoint.sent).toEqual(["r1", "r2"]);
      expect(state.credentials.accessToken).toBe("t3");
      expect(state.usedRefreshToken).toBeNull();
      expect([onDisk()?.accessToken, onDisk()?.refreshToken]).toEqual(["t3", "r3"]);
    },
  );

  // Python's test_after_a_failed_save_a_profile_saved_since_wins.
  it("once another process saved the profile since, the file wins again", async () => {
    const soon = new Date(Date.now() + 5_000);
    seed({ default: creds({ accessToken: "t1", refreshToken: "r1", expiresAt: soon }) });
    const state = independentState(creds({ accessToken: "t1", refreshToken: "r1", expiresAt: soon }));
    const endpoint = singleUseEndpoint({ r1: ["t2", "r2", 10] });
    const auth = new KaguraOAuth(state, { fetch: endpoint.fetch });

    failRename.errors = [erofs()];
    await expect(auth.getAuthHeader()).rejects.toBeInstanceOf(RefreshNotSavedError);
    await updateProfile("default", creds({ accessToken: "t-login", refreshToken: "r-login" }), credentialsPath);
    expect(await auth.getAuthHeader()).toBe("Bearer t-login");

    expect(endpoint.sent).toEqual(["r1"]);
    expect(state.usedRefreshToken).toBeNull();
  });

  it("a later getSharedState keeps the token held in memory while the file is behind it", async () => {
    seed({ default: creds({ accessToken: "old", refreshToken: "rtok-old" }) });
    const state = getSharedState(credentialsPath)!;
    const endpoint = singleUseEndpoint({ "rtok-old": ["fresh", "rtok-fresh", 3600] });
    failRename.errors = [erofs()];
    await expect(new KaguraOAuth(state, { fetch: endpoint.fetch }).forceRefresh()).rejects.toBeInstanceOf(
      RefreshNotSavedError,
    );

    // A client constructed later in this process (or the proxy reloading
    // per request) gets the working token, not the revoked one on file.
    expect(getSharedState(credentialsPath)?.credentials.accessToken).toBe("fresh");

    // A login saved since is picked up as before.
    await updateProfile("default", creds({ accessToken: "t-login", refreshToken: "r-login" }), credentialsPath);
    expect(getSharedState(credentialsPath)?.credentials.accessToken).toBe("t-login");
  });

  it("adopting another profile from the file clears the mark that the file is behind", async () => {
    seed({ default: creds({ accessToken: "old", refreshToken: "rtok-old" }) });
    const state = getSharedState(credentialsPath)!;
    const endpoint = singleUseEndpoint({ "rtok-old": ["fresh", "rtok-fresh", 3600] });
    failRename.errors = [erofs()];
    await expect(new KaguraOAuth(state, { fetch: endpoint.fetch }).forceRefresh()).rejects.toBeInstanceOf(
      RefreshNotSavedError,
    );
    expect([state.usedAccessToken, state.usedRefreshToken]).toEqual(["old", "rtok-old"]);

    await updateProfile("default", creds({ accessToken: "t-login", refreshToken: "r-login" }), credentialsPath);
    expect(getSharedState(credentialsPath)).toBe(state);
    expect(state.credentials.accessToken).toBe("t-login");
    expect([state.usedAccessToken, state.usedRefreshToken]).toEqual([null, null]);
    // So the old pair, should it come back (a restored backup), is no
    // longer mistaken for the one this process got ahead of.
    seed({ default: creds({ accessToken: "old", refreshToken: "rtok-old" }) });
    expect(getSharedState(credentialsPath)?.credentials.accessToken).toBe("old");
  });

  // A server that keeps the refresh token on a refresh (omits it from the
  // response) leaves the same refresh token on file across another
  // process's rotation; the access token tells the two profiles apart.
  describe("with a server that keeps the refresh token on a refresh", () => {
    const soon = () => new Date(Date.now() + 5_000); // within REFRESH_SKEW_SEC
    const keepsRefreshToken = () =>
      vi.fn(async () => Response.json({ access_token: "t2", token_type: "Bearer", expires_in: 3600 }));

    it("getSharedState adopts a rotation another process saved since", async () => {
      seed({ default: creds({ accessToken: "t1", refreshToken: "r1", expiresAt: soon() }) });
      const state = getSharedState(credentialsPath)!;
      const fetch = keepsRefreshToken();
      failRename.errors = [erofs()];
      await expect(
        new KaguraOAuth(state, { fetch: fetch as unknown as typeof globalThis.fetch }).getAuthHeader(),
      ).rejects.toBeInstanceOf(RefreshNotSavedError);
      expect([state.credentials.accessToken, state.credentials.refreshToken]).toEqual(["t2", "r1"]);

      await updateProfile("default", creds({ accessToken: "t3", refreshToken: "r1" }), credentialsPath);
      expect(getSharedState(credentialsPath)?.credentials.accessToken).toBe("t3");
      expect(state.usedRefreshToken).toBeNull();
    });

    it("the lock path adopts it too instead of refreshing from the copy in memory", async () => {
      seed({ default: creds({ accessToken: "t1", refreshToken: "r1", expiresAt: soon() }) });
      const state = independentState(creds({ accessToken: "t1", refreshToken: "r1", expiresAt: soon() }));
      const fetch = keepsRefreshToken();
      const auth = new KaguraOAuth(state, { fetch: fetch as unknown as typeof globalThis.fetch });
      failRename.errors = [erofs()];
      await expect(auth.getAuthHeader()).rejects.toBeInstanceOf(RefreshNotSavedError);

      await updateProfile("default", creds({ accessToken: "t3", refreshToken: "r1" }), credentialsPath);
      await auth.forceRefresh(); // t2 rejected upstream
      expect(fetch).toHaveBeenCalledOnce();
      expect(state.credentials.accessToken).toBe("t3");
      expect([state.usedAccessToken, state.usedRefreshToken]).toEqual([null, null]);
    });
  });

  // `refresh()` asks for consent on a scope refusal, read from the OAuth
  // code or, failing that, the message (#84). A credentials-file error has
  // no code, and its message holds the profile name and the path.
  it("a failed save under a scope is never read as a scope refusal, whatever the profile is called", async () => {
    seed({ insufficient_scope: creds() });
    const endpoint = singleUseEndpoint({ "rtok-1": ["atok-2", "rtok-2", 3600] });
    const onUserCode = vi.fn();
    failRename.errors = [erofs()];

    const error = await refresh({
      credentialsPath,
      profile: "insufficient_scope",
      scope: "memory:read",
      fetch: endpoint.fetch,
      onUserCode,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefreshNotSavedError);
    expect(endpoint.sent).toEqual(["rtok-1"]);
    expect(onUserCode).not.toHaveBeenCalled();
  });

  it("nor is a file that cannot be read, whatever its path says", async () => {
    const scoped = path.join(dir, "invalid_scope", "credentials.json");
    const cf = emptyCredentialsFile();
    setProfile(cf, "default", creds());
    saveCredentialsFile(cf, scoped);
    const lock = await acquireFileLock(scoped);
    const fetch = vi.fn(neverFetch);
    const onUserCode = vi.fn();
    const pending = refresh({ credentialsPath: scoped, scope: "memory:read", fetch, onUserCode }).catch((e: unknown) => e);
    fs.writeFileSync(scoped, "not json {{{");
    lock.release();

    const error = await pending;
    expect(error).toBeInstanceOf(CredentialsFileError);
    expect(fetch).not.toHaveBeenCalled();
    expect(onUserCode).not.toHaveBeenCalled();
  });

  // The device flow a widening scope falls back to saves its grant outside
  // the lock: a failure there is the same typed error, and the grant —
  // which exists nowhere else — is kept in memory and used next.
  it("a widening scope's consent that cannot be saved is the same typed error, kept in memory", async () => {
    seed({ default: creds() });
    const wide = "memory:read memory:write profile:read";
    const bodies: string[] = [];
    const replies = [
      Response.json({ error: "insufficient_scope" }, { status: 400 }),
      Response.json({
        device_code: "dev-1",
        user_code: "WDJB-MJHT",
        verification_uri: "https://x.test/activate",
        expires_in: 600,
        interval: 0,
      }),
      Response.json({ access_token: "at-wide", refresh_token: "rt-wide", token_type: "Bearer", expires_in: 3600, scope: wide }),
      Response.json({ access_token: "at-next", refresh_token: "rt-next", token_type: "Bearer", expires_in: 3600, scope: wide }),
    ];
    const fetch = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      const reply = replies.shift();
      if (reply === undefined) throw new Error("unexpected request");
      return reply;
    }) as unknown as typeof globalThis.fetch;
    failRename.errors = [erofs()];

    const error = await refresh({ credentialsPath, scope: wide, fetch, onUserCode: () => {}, sleep: async () => {} }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RefreshNotSavedError);
    expect(error).toBeInstanceOf(KaguraAuthError);
    expect((error as Error).message).toBe(
      `Got consent for scope '${wide}' on profile 'default', but could not save it to ${credentialsPath}: ` +
        "EROFS: read-only file system\n" +
        "  The profile on file keeps its previous grant.\n" +
        `  Fix the cause, then run: kagura-memory auth refresh --scope "${wide}"`,
    );
    expect(util.inspect(error, { depth: 10 })).not.toContain("at-wide");
    expect(onDisk()?.accessToken).toBe("atok-1");
    expect(getSharedState(credentialsPath)?.credentials.accessToken).toBe("at-wide");

    // The next refresh sends the consented grant's refresh token, and saves.
    const next = await refresh({ credentialsPath, fetch });
    expect(new URLSearchParams(bodies[3]).get("refresh_token")).toBe("rt-wide");
    expect(next.accessToken).toBe("at-next");
    expect(onDisk()?.accessToken).toBe("at-next");
  });

  it("is also what a profile that became unreadable during the round-trip gives", async () => {
    seed({ default: creds() });
    const fetch = (async () => {
      fs.writeFileSync(credentialsPath, "not json {{{");
      return Response.json({ access_token: "atok-2", refresh_token: "rtok-2", expires_in: 3600 });
    }) as unknown as typeof globalThis.fetch;
    const state = independentState(creds());
    await expect(new KaguraOAuth(state, { fetch }).forceRefresh()).rejects.toThrow(
      notSaved("it is not valid JSON"),
    );
    expect(state.credentials.accessToken).toBe("atok-2");
    expect(fs.readFileSync(credentialsPath, "utf-8")).toBe("not json {{{");
  });
});
