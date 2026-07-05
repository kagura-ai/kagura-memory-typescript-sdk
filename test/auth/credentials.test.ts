import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AsyncMutex,
  CREDENTIALS_DIR_MODE,
  CREDENTIALS_FILE_MODE,
  KaguraOAuth,
  REFRESH_SKEW_SEC,
  credentialsFileFromDict,
  credentialsFileToDict,
  credentialsFromDict,
  credentialsToDict,
  deleteCredentialsFile,
  deleteProfile,
  emptyCredentialsFile,
  getProfile,
  getSharedState,
  isExpired,
  loadCredentialsFile,
  removeProfile,
  resetStateCache,
  saveCredentialsFile,
  setDefaultProfile,
  setProfile,
  updateProfile,
  withRefreshed,
} from "../../src/auth/credentials.js";
import type {
  OAuthCredentials,
  SharedCredentialsState,
} from "../../src/auth/credentials.js";
import { KaguraAuthError, KaguraAuthExpiredError } from "../../src/errors.js";

const posixIt = it.skipIf(process.platform === "win32");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-creds-"));
  resetStateCache();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetStateCache();
});

function sampleCreds(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
  return {
    server: "https://test.example.com",
    mcpUrl: "https://test.example.com/mcp",
    clientId: "kagura-cli",
    accessToken: "atok-1",
    refreshToken: "rtok-1",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 3600_000),
    scope: "memory:read",
    workspaceId: "ws-1",
    workspaceName: "test-ws",
    userEmail: "test@example.com",
    issuedAt: new Date(),
    ...overrides,
  };
}

/** Counting fetch stub that always answers with the given JSON + status. */
function tokenFetch(
  body: Record<string, unknown>,
  options: { status?: number; counter?: { calls: number }; delayMs?: number } = {},
): typeof fetch {
  const impl = async (): Promise<Response> => {
    if (options.counter) {
      options.counter.calls += 1;
    }
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    return new Response(JSON.stringify(body), { status: options.status ?? 200 });
  };
  return impl as typeof fetch;
}

const FRESH_TOKEN_BODY = {
  access_token: "new-token",
  refresh_token: "new-rtok",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "memory:read",
};

// ---------------------------------------------------------------------------
// OAuthCredentials helpers
// ---------------------------------------------------------------------------

describe("isExpired", () => {
  it("is false when far in the future, even with skew", () => {
    const creds = sampleCreds({ expiresAt: new Date(Date.now() + 3600_000) });
    expect(isExpired(creds)).toBe(false);
    expect(isExpired(creds, 300)).toBe(false);
  });

  it("is true when in the past", () => {
    const creds = sampleCreds({ expiresAt: new Date(Date.now() - 10_000) });
    expect(isExpired(creds)).toBe(true);
  });

  it("treats a token expiring in 2 minutes as expired with the 5-minute skew", () => {
    const creds = sampleCreds({ expiresAt: new Date(Date.now() + 120_000) });
    expect(isExpired(creds)).toBe(false);
    expect(isExpired(creds, REFRESH_SKEW_SEC)).toBe(true);
  });
});

describe("withRefreshed", () => {
  it("rotates only the access token when refresh token is omitted", () => {
    const creds = sampleCreds();
    const newExpires = new Date(Date.now() + 7200_000);
    const rotated = withRefreshed(creds, { accessToken: "atok-2", expiresAt: newExpires });
    expect(rotated.accessToken).toBe("atok-2");
    expect(rotated.refreshToken).toBe(creds.refreshToken); // preserved
    expect(rotated.expiresAt).toBe(newExpires);
    expect(rotated.scope).toBe(creds.scope);
    // Original is unchanged (copy semantics).
    expect(creds.accessToken).toBe("atok-1");
  });

  it("rotates refresh token and scope when supplied", () => {
    const rotated = withRefreshed(sampleCreds(), {
      accessToken: "atok-2",
      refreshToken: "rtok-2",
      expiresAt: new Date(Date.now() + 3600_000),
      scope: "memory:read memory:write",
    });
    expect(rotated.refreshToken).toBe("rtok-2");
    expect(rotated.scope).toBe("memory:read memory:write");
  });
});

describe("credentials dict round-trip", () => {
  it("preserves fields through to_dict/from_dict at seconds precision", () => {
    const creds = sampleCreds();
    const restored = credentialsFromDict(credentialsToDict(creds));
    expect(restored.accessToken).toBe(creds.accessToken);
    expect(restored.refreshToken).toBe(creds.refreshToken);
    expect(restored.scope).toBe(creds.scope);
    expect(restored.expiresAt.getTime()).toBe(
      Math.floor(creds.expiresAt.getTime() / 1000) * 1000,
    );
  });
});

// ---------------------------------------------------------------------------
// CredentialsFile helpers
// ---------------------------------------------------------------------------

describe("CredentialsFile helpers", () => {
  it("getProfile returns the default profile when unnamed", () => {
    const cf = emptyCredentialsFile();
    cf.defaultProfile = "alice";
    cf.profiles.alice = sampleCreds();
    expect(getProfile(cf)?.scope).toBe("memory:read");
  });

  it("getProfile returns named profile or null", () => {
    const creds = sampleCreds();
    const cf = emptyCredentialsFile();
    cf.profiles.work = creds;
    expect(getProfile(cf, "work")).toBe(creds);
    expect(getProfile(cf, "missing")).toBeNull();
  });

  it("setProfile makes the first profile the default", () => {
    const cf = emptyCredentialsFile();
    setProfile(cf, "first", sampleCreds());
    expect(cf.defaultProfile).toBe("first");
  });

  it("removeProfile repoints a deleted default to a remaining profile", () => {
    const cf = emptyCredentialsFile();
    setProfile(cf, "a", sampleCreds());
    setProfile(cf, "b", sampleCreds());
    expect(cf.defaultProfile).toBe("a");
    removeProfile(cf, "a");
    expect("a" in cf.profiles).toBe(false);
    expect(cf.defaultProfile).toBe("b");
  });

  it("round-trips through to_dict/from_dict", () => {
    const cf = emptyCredentialsFile();
    setProfile(cf, "work", sampleCreds({ accessToken: "atok-work" }));
    setProfile(cf, "home", sampleCreds({ accessToken: "atok-home" }));
    const restored = credentialsFileFromDict(credentialsFileToDict(cf));
    expect(Object.keys(restored.profiles).sort()).toEqual(["home", "work"]);
    expect(restored.profiles.work?.accessToken).toBe("atok-work");
  });
});

// ---------------------------------------------------------------------------
// Filesystem IO (atomic write + perms)
// ---------------------------------------------------------------------------

describe("save/load credentials file", () => {
  it("round-trips through disk", () => {
    const p = path.join(dir, ".kagura", "credentials.json");
    const cf = emptyCredentialsFile();
    setProfile(cf, "default", sampleCreds());
    saveCredentialsFile(cf, p);
    const restored = loadCredentialsFile(p);
    expect(restored.defaultProfile).toBe("default");
    expect(getProfile(restored)?.accessToken).toBe("atok-1");
  });

  posixIt("enforces file mode 0600", () => {
    const p = path.join(dir, "creds.json");
    const cf = emptyCredentialsFile();
    setProfile(cf, "default", sampleCreds());
    saveCredentialsFile(cf, p);
    expect(fs.statSync(p).mode & 0o777).toBe(CREDENTIALS_FILE_MODE);
  });

  posixIt("enforces dir mode 0700", () => {
    const p = path.join(dir, "subdir", "creds.json");
    const cf = emptyCredentialsFile();
    setProfile(cf, "default", sampleCreds());
    saveCredentialsFile(cf, p);
    expect(fs.statSync(path.dirname(p)).mode & 0o777).toBe(CREDENTIALS_DIR_MODE);
  });

  posixIt("coerces loose file perms back to 0600 on read", () => {
    const p = path.join(dir, "creds.json");
    fs.writeFileSync(
      p,
      JSON.stringify({ version: 1, default_profile: "x", profiles: {} }),
    );
    fs.chmodSync(p, 0o644);
    loadCredentialsFile(p);
    expect(fs.statSync(p).mode & 0o777).toBe(CREDENTIALS_FILE_MODE);
  });

  it("returns an empty file when missing", () => {
    const cf = loadCredentialsFile(path.join(dir, "nope.json"));
    expect(cf.profiles).toEqual({});
    expect(getProfile(cf)).toBeNull();
  });

  it("returns an empty file on corrupt JSON", () => {
    const p = path.join(dir, "creds.json");
    fs.writeFileSync(p, "not json {{{");
    expect(loadCredentialsFile(p).profiles).toEqual({});
  });

  it("returns an empty file on non-object top-level JSON", () => {
    const p = path.join(dir, "creds.json");
    fs.writeFileSync(p, '["this is", "an array"]');
    expect(loadCredentialsFile(p).profiles).toEqual({});
  });

  it("returns an empty file when a profile is missing required fields", () => {
    const p = path.join(dir, "creds.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        default_profile: "broken",
        profiles: { broken: { only_has_one_field: "yes" } },
      }),
    );
    expect(loadCredentialsFile(p).profiles).toEqual({});
  });

  it("normalizes naive (timezone-less) timestamps to UTC", () => {
    const p = path.join(dir, "creds.json");
    const credsDict = credentialsToDict(sampleCreds());
    credsDict.expires_at = "2099-01-01T00:00:00"; // naive — no Z suffix
    credsDict.issued_at = "2026-01-01T00:00:00";
    fs.writeFileSync(
      p,
      JSON.stringify({ version: 1, default_profile: "default", profiles: { default: credsDict } }),
    );
    const profile = getProfile(loadCredentialsFile(p), "default");
    expect(profile).not.toBeNull();
    expect(isExpired(profile as OAuthCredentials)).toBe(false);
    expect((profile as OAuthCredentials).expiresAt.getTime()).toBe(
      Date.UTC(2099, 0, 1, 0, 0, 0),
    );
  });

  it("leaves no .tmp files behind when the atomic rename fails", () => {
    // A directory at the target path makes the final rename fail on every
    // platform, exercising the cleanup branch.
    const target = path.join(dir, "creds.json");
    fs.mkdirSync(target);
    const cf = emptyCredentialsFile();
    setProfile(cf, "default", sampleCreds());
    expect(() => saveCredentialsFile(cf, target)).toThrow();
    const leftover = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });
});

describe("profile file operations", () => {
  it("updateProfile inserts into an existing file", async () => {
    const p = path.join(dir, "creds.json");
    const cf = emptyCredentialsFile();
    setProfile(cf, "a", sampleCreds({ accessToken: "atok-a" }));
    saveCredentialsFile(cf, p);

    await updateProfile("b", sampleCreds({ accessToken: "atok-b" }), p);
    const restored = loadCredentialsFile(p);
    expect(Object.keys(restored.profiles).sort()).toEqual(["a", "b"]);
  });

  it("deleteProfile removes a profile and keeps the others", async () => {
    const p = path.join(dir, "creds.json");
    const cf = emptyCredentialsFile();
    setProfile(cf, "a", sampleCreds());
    setProfile(cf, "b", sampleCreds());
    saveCredentialsFile(cf, p);

    await deleteProfile("a", p);
    const restored = loadCredentialsFile(p);
    expect("a" in restored.profiles).toBe(false);
    expect("b" in restored.profiles).toBe(true);
  });

  it("deleteProfile is a silent no-op for a missing name", async () => {
    const p = path.join(dir, "creds.json");
    const cf = emptyCredentialsFile();
    setProfile(cf, "alice", sampleCreds());
    saveCredentialsFile(cf, p);

    await deleteProfile("does-not-exist", p);
    expect("alice" in loadCredentialsFile(p).profiles).toBe(true);
  });

  it("deleteCredentialsFile removes the file and is idempotent", () => {
    const p = path.join(dir, "creds.json");
    const cf = emptyCredentialsFile();
    setProfile(cf, "default", sampleCreds());
    saveCredentialsFile(cf, p);

    deleteCredentialsFile(p);
    expect(fs.existsSync(p)).toBe(false);
    deleteCredentialsFile(p); // second call must not throw
  });

  it("setDefaultProfile switches to an existing profile", async () => {
    const p = path.join(dir, "creds.json");
    const cf = emptyCredentialsFile();
    setProfile(cf, "work", sampleCreds());
    setProfile(cf, "personal", sampleCreds());
    saveCredentialsFile(cf, p);

    await setDefaultProfile("personal", p);
    expect(loadCredentialsFile(p).defaultProfile).toBe("personal");
  });

  it("setDefaultProfile throws for a missing profile", async () => {
    const p = path.join(dir, "creds.json");
    const cf = emptyCredentialsFile();
    setProfile(cf, "work", sampleCreds());
    saveCredentialsFile(cf, p);

    await expect(setDefaultProfile("nope", p)).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// Shared state cache
// ---------------------------------------------------------------------------

describe("getSharedState", () => {
  it("returns null when there are no credentials", () => {
    expect(getSharedState(path.join(dir, "creds.json"))).toBeNull();
  });

  it("returns the same object for the same (path, profile)", () => {
    const p = path.join(dir, "creds.json");
    const cf = emptyCredentialsFile();
    setProfile(cf, "default", sampleCreds());
    saveCredentialsFile(cf, p);

    const a = getSharedState(p);
    const b = getSharedState(p);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("gives distinct profiles distinct states sharing one file-level mutex", () => {
    const p = path.join(dir, "creds.json");
    const cf = emptyCredentialsFile();
    setProfile(cf, "a", sampleCreds({ accessToken: "a" }));
    setProfile(cf, "b", sampleCreds({ accessToken: "b" }));
    saveCredentialsFile(cf, p);

    const sa = getSharedState(p, "a");
    const sb = getSharedState(p, "b");
    expect(sa).not.toBeNull();
    expect(sb).not.toBeNull();
    expect(sa).not.toBe(sb);
    expect(sa?.credentials.accessToken).toBe("a");
    expect(sb?.credentials.accessToken).toBe("b");
    expect(sa?.mutex).toBe(sb?.mutex); // shared per-file lock
  });

  it("re-reads disk on a cache hit so a fresh CLI login becomes visible", () => {
    const p = path.join(dir, "creds.json");
    const cf = emptyCredentialsFile();
    setProfile(cf, "default", sampleCreds({ accessToken: "old" }));
    saveCredentialsFile(cf, p);

    const first = getSharedState(p);
    setProfile(cf, "default", sampleCreds({ accessToken: "relogged" }));
    saveCredentialsFile(cf, p);
    const second = getSharedState(p);
    expect(second).toBe(first);
    expect(second?.credentials.accessToken).toBe("relogged");
  });
});

// ---------------------------------------------------------------------------
// KaguraOAuth — getAuthHeader + single-flight refresh
// ---------------------------------------------------------------------------

function writeProfile(p: string, creds: OAuthCredentials): void {
  const cf = emptyCredentialsFile();
  setProfile(cf, "default", creds);
  saveCredentialsFile(cf, p);
}

function mustState(p: string): SharedCredentialsState {
  const state = getSharedState(p);
  if (state === null) {
    throw new Error("expected shared state");
  }
  return state;
}

/** A state with its own mutex — a stand-in for a separate process. */
function independentState(p: string, creds: OAuthCredentials): SharedCredentialsState {
  return {
    credentials: creds,
    profileName: "default",
    path: path.resolve(p),
    mutex: new AsyncMutex(),
  };
}

describe("KaguraOAuth", () => {
  it("returns the current token without refreshing when far from expiry", async () => {
    const p = path.join(dir, "creds.json");
    writeProfile(p, sampleCreds({ accessToken: "fresh-token" }));
    const neverFetch = (async () => {
      throw new Error("fetch must not be called");
    }) as unknown as typeof fetch;

    const auth = new KaguraOAuth(mustState(p), { fetch: neverFetch });
    expect(await auth.getAuthHeader()).toBe("Bearer fresh-token");
  });

  it("refreshes and persists when within the skew window", async () => {
    const p = path.join(dir, "creds.json");
    writeProfile(
      p,
      sampleCreds({ accessToken: "old-token", expiresAt: new Date(Date.now() + 60_000) }),
    );
    const state = mustState(p);
    const auth = new KaguraOAuth(state, { fetch: tokenFetch(FRESH_TOKEN_BODY) });

    expect(await auth.getAuthHeader()).toBe("Bearer new-token");
    expect(state.credentials.accessToken).toBe("new-token");
    expect(state.credentials.refreshToken).toBe("new-rtok");
    // Persisted to disk too.
    expect(getProfile(loadCredentialsFile(p))?.accessToken).toBe("new-token");
  });

  it("coalesces 5 concurrent getAuthHeader calls into a single refresh", async () => {
    const p = path.join(dir, "creds.json");
    writeProfile(
      p,
      sampleCreds({ accessToken: "old", expiresAt: new Date(Date.now() + 10_000) }),
    );
    const counter = { calls: 0 };
    const auth = new KaguraOAuth(mustState(p), {
      fetch: tokenFetch(FRESH_TOKEN_BODY, { counter, delayMs: 10 }),
    });

    const headers = await Promise.all(
      Array.from({ length: 5 }, () => auth.getAuthHeader()),
    );
    expect(counter.calls).toBe(1);
    expect(headers).toEqual(Array.from({ length: 5 }, () => "Bearer new-token"));
  });

  it("preserves the stored refresh token when the server omits it", async () => {
    const p = path.join(dir, "creds.json");
    writeProfile(
      p,
      sampleCreds({
        accessToken: "old",
        refreshToken: "rtok-keep",
        expiresAt: new Date(Date.now() + 10_000),
      }),
    );
    const state = mustState(p);
    const auth = new KaguraOAuth(state, {
      fetch: tokenFetch({ ...FRESH_TOKEN_BODY, refresh_token: "" }),
    });

    await auth.getAuthHeader();
    expect(state.credentials.accessToken).toBe("new-token");
    expect(state.credentials.refreshToken).toBe("rtok-keep");
  });

  it("maps invalid_grant during refresh to KaguraAuthExpiredError", async () => {
    const p = path.join(dir, "creds.json");
    writeProfile(
      p,
      sampleCreds({ accessToken: "old", expiresAt: new Date(Date.now() + 10_000) }),
    );
    const auth = new KaguraOAuth(mustState(p), {
      fetch: tokenFetch({ error: "invalid_grant" }, { status: 400 }),
    });

    await expect(auth.getAuthHeader()).rejects.toThrow(KaguraAuthExpiredError);
    await expect(auth.getAuthHeader()).rejects.toThrow(/login expired/);
  });

  it("maps other refresh failures to KaguraAuthError (not Expired)", async () => {
    const p = path.join(dir, "creds.json");
    writeProfile(
      p,
      sampleCreds({ accessToken: "old", expiresAt: new Date(Date.now() + 10_000) }),
    );
    const auth = new KaguraOAuth(mustState(p), {
      fetch: tokenFetch(
        { error: "server_error", error_description: "boom" },
        { status: 500 },
      ),
    });

    let caught: unknown;
    try {
      await auth.getAuthHeader();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KaguraAuthError);
    expect(caught).not.toBeInstanceOf(KaguraAuthExpiredError);
  });

  it("dedups the network refresh across two independent states (cross-process sim)", async () => {
    const p = path.join(dir, "creds.json");
    const near = new Date(Date.now() + 10_000); // within REFRESH_SKEW_SEC
    writeProfile(p, sampleCreds({ accessToken: "old", expiresAt: near }));

    const counter = { calls: 0 };
    const stub = tokenFetch(
      { ...FRESH_TOKEN_BODY, access_token: "fresh" },
      { counter, delayMs: 20 },
    );
    const authA = new KaguraOAuth(
      independentState(p, sampleCreds({ accessToken: "old", expiresAt: near })),
      { fetch: stub },
    );
    const stateB = independentState(p, sampleCreds({ accessToken: "old", expiresAt: near }));
    const authB = new KaguraOAuth(stateB, { fetch: stub });

    const [ha, hb] = await Promise.all([authA.getAuthHeader(), authB.getAuthHeader()]);
    expect(counter.calls).toBe(1);
    expect(ha).toBe("Bearer fresh");
    // The state that skipped the network still adopts the on-disk token.
    expect(hb).toBe("Bearer fresh");
    expect(stateB.credentials.accessToken).toBe("fresh");
    expect(getProfile(loadCredentialsFile(p))?.accessToken).toBe("fresh");
  });

  it("forceRefresh adopts a peer-rotated on-disk token without a network call", async () => {
    const p = path.join(dir, "creds.json");
    // Disk already holds a rotated token (a peer process refreshed first).
    writeProfile(p, sampleCreds({ accessToken: "peer-rotated" }));
    // This process still holds the now-rejected token in memory.
    const state = independentState(p, sampleCreds({ accessToken: "rejected-401" }));
    const counter = { calls: 0 };
    const auth = new KaguraOAuth(state, {
      fetch: tokenFetch(FRESH_TOKEN_BODY, { counter }),
    });

    await auth.forceRefresh();
    expect(counter.calls).toBe(0);
    expect(state.credentials.accessToken).toBe("peer-rotated");
  });

  it("forceRefresh hits the network when the on-disk token is unchanged", async () => {
    const p = path.join(dir, "creds.json");
    // On-disk token is the SAME one that just got 401'd, and not near expiry —
    // an expires_at-based skip here would wrongly no-op on a 401.
    writeProfile(p, sampleCreds({ accessToken: "rejected-401" }));
    const state = independentState(p, sampleCreds({ accessToken: "rejected-401" }));
    const counter = { calls: 0 };
    const auth = new KaguraOAuth(state, {
      fetch: tokenFetch({ ...FRESH_TOKEN_BODY, access_token: "forced-new" }, { counter }),
    });

    await auth.forceRefresh();
    expect(counter.calls).toBe(1);
    expect(state.credentials.accessToken).toBe("forced-new");
    expect(getProfile(loadCredentialsFile(p))?.accessToken).toBe("forced-new");
  });
});
