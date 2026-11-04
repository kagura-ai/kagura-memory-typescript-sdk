/**
 * `auth refresh` / `auth token` on the one locked refresh path (#92).
 *
 * Each `PYTHON` case is the Python CLI 0.44.0's stdout, stderr and exit
 * code (click 8.3.3), recorded with `CliRunner` against a fake token
 * endpoint on 127.0.0.1, HOME in a temp directory (written `/tmp/pyhome`
 * below, so credentials.json is `PY_PATH`), profile `default` (`atok-1` /
 * `rtok-1`, scope `memory:read memory:write`). "Adopted" and "under the
 * lock" patched the CLI's first read of the file to return that profile
 * while the file held the peer's (`atok-peer`, expiring 2099-01-01) or
 * `not json {{{`; "not saved" patched `save_credentials_file` to raise
 * `OSError(EROFS, "Read-only file system")`. "No profile" is what both a
 * missing file and one holding `not json {{{` at the first read give
 * (`auth refresh` and `auth token` alike). This bin names itself
 * `kagura-memory`, and Node words the system error its own way; everything
 * else is compared byte for byte.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  emptyCredentialsFile,
  getProfile,
  loadCredentialsFile,
  resetStateCache,
  saveCredentialsFile,
  setProfile,
  type OAuthCredentials,
} from "../../src/auth/credentials.js";
import { acquireFileLock } from "../../src/auth/filelock.js";
import { refreshProfile } from "../../src/auth/refresh.js";
import { runCli, type CliDeps } from "../../src/cli/run.js";

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

const PY_PATH = "/tmp/pyhome/.kagura/credentials.json";
const PY_OS_ERROR = "[Errno 30] Read-only file system";
const NODE_OS_ERROR = "EROFS: read-only file system";

const PYTHON = {
  refreshAdopted: {
    code: 0,
    stdout:
      "✓ Profile 'default' was already refreshed by another process.\n" +
      "  Scope: memory:read memory:write\n" +
      "  Expires: 2099-01-01T00:00:00+00:00\n",
    stderr: "",
  },
  // Expires is now + expires_in: the line's shape is compared.
  refreshRefreshed: {
    code: 0,
    stdout: "✓ Refreshed profile 'default'.\n  Scope: memory:read memory:write\n  Expires: ",
    stderr: "",
  },
  notSaved: {
    code: 1,
    stdout: "",
    stderr:
      `Error: Refreshed profile 'default', but could not save it to ${PY_PATH}: ${PY_OS_ERROR}\n` +
      "  The refresh used up the refresh token on file, so the profile on file cannot be refreshed again.\n" +
      "  Fix the cause, then run: kagura auth login\n",
  },
  cannotUpdate: {
    code: 1,
    stdout: "",
    stderr:
      `Error: Cannot update ${PY_PATH}: it is not valid JSON.\n` +
      "  Fix the file, or move it aside and run: kagura auth login\n",
  },
  noProfile: {
    code: 1,
    stdout: "",
    stderr: "Error: No profile named 'default'.\n  Run: kagura auth login\n",
  },
  tokenAdopted: { code: 0, stdout: "atok-peer\n" },
};

let dir: string;
let credentialsPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-cli-refresh-"));
  credentialsPath = path.join(dir, "credentials.json");
  failRename.errors = [];
  resetStateCache();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  failRename.errors = [];
  resetStateCache();
});

/** Python's recorded text, as this bin says it about this sandbox's file. */
function here(text: string): string {
  return text
    .replaceAll(PY_PATH, credentialsPath)
    .replaceAll(PY_OS_ERROR, NODE_OS_ERROR)
    .replaceAll("kagura auth login", "kagura-memory auth login");
}

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
    issuedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function seed(c: OAuthCredentials): void {
  const cf = emptyCredentialsFile();
  setProfile(cf, "default", c);
  saveCredentialsFile(cf, credentialsPath);
}

const PEER = creds({
  accessToken: "atok-peer",
  refreshToken: "rtok-peer",
  expiresAt: new Date("2099-01-01T00:00:00Z"),
});

/** A token endpoint answering every refresh with `atok-2` / `rtok-2`. */
function tokenEndpoint() {
  const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) =>
    Response.json({
      access_token: "atok-2",
      refresh_token: "rtok-2",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "memory:read memory:write",
    }),
  );
  return fetch;
}

/** Run the bin with the real refresh, a fake endpoint, and captured streams. */
function run(argv: string[], fetch: ReturnType<typeof tokenEndpoint>) {
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    write: (line: string) => out.push(line),
    writeError: (line: string) => err.push(line),
    confirm: async () => true,
    openBrowser: async () => false,
    login: async () => {
      throw new Error("not used");
    },
    refresh: refreshProfile,
    fetch: fetch as unknown as typeof globalThis.fetch,
    credentialsPath,
  } as unknown as CliDeps;
  const code = runCli(argv, deps);
  const streams = () => ({ stdout: out.map((l) => `${l}\n`).join(""), stderr: err.map((l) => `${l}\n`).join("") });
  return { code, streams };
}

/**
 * Stand in for a `kagura-memory-mcp` process refreshing while the CLI
 * waits: it holds the lock before the CLI starts, so the CLI reads the
 * file, then waits; holding it, it saves `PEER` (consuming `rtok-1`) and
 * releases. The CLI can only see the rotation by re-reading under the lock.
 */
async function peerRotatesWhileCliWaits(
  argv: string[],
  fetch: ReturnType<typeof tokenEndpoint>,
  peer: OAuthCredentials | string = PEER,
) {
  const lock = await acquireFileLock(credentialsPath);
  let result: ReturnType<typeof run>;
  try {
    result = run(argv, fetch);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A string is what the file becomes instead (Python's "under the lock").
    if (typeof peer === "string") fs.writeFileSync(credentialsPath, peer);
    else seed(peer);
  } finally {
    lock.release();
  }
  return { code: await result.code, ...result.streams() };
}

describe("auth refresh on the locked path (#92)", () => {
  it("says the profile was already refreshed by another process, as Python does, and sends nothing", async () => {
    seed(creds());
    const fetch = tokenEndpoint();
    expect(await peerRotatesWhileCliWaits(["auth", "refresh"], fetch)).toEqual(PYTHON.refreshAdopted);
    expect(fetch).not.toHaveBeenCalled();
    const onDisk = getProfile(loadCredentialsFile(credentialsPath));
    expect([onDisk?.accessToken, onDisk?.refreshToken]).toEqual(["atok-peer", "rtok-peer"]);
  });

  it("does not say 'already refreshed' for a different token on file that has expired too (#92 gate1)", async () => {
    seed(creds());
    const fetch = tokenEndpoint();
    const stalePeer = creds({ accessToken: "atok-peer", refreshToken: "rtok-peer", expiresAt: new Date(Date.now() - 1000) });
    const result = await peerRotatesWhileCliWaits(["auth", "refresh"], fetch, stalePeer);
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith(PYTHON.refreshRefreshed.stdout)).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)).get("refresh_token")).toBe("rtok-peer");
    const onDisk = getProfile(loadCredentialsFile(credentialsPath));
    expect([onDisk?.accessToken, onDisk?.refreshToken]).toEqual(["atok-2", "rtok-2"]);
  });

  it("prints Python's lines after a refresh of its own", async () => {
    seed(creds());
    const fetch = tokenEndpoint();
    const { code, streams } = run(["auth", "refresh"], fetch);
    expect(await code).toBe(0);
    const { stdout, stderr } = streams();
    expect(stdout.startsWith(PYTHON.refreshRefreshed.stdout)).toBe(true);
    const expires = getProfile(loadCredentialsFile(credentialsPath))!.expiresAt;
    // Python's isoformat of the expiry it was handed (whole seconds on file).
    expect(stdout.slice(PYTHON.refreshRefreshed.stdout.length)).toMatch(
      new RegExp(`^${expires.toISOString().slice(0, 19)}(\\.\\d{6})?\\+00:00\\n$`),
    );
    expect(stderr).toBe(PYTHON.refreshRefreshed.stderr);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("exits 1 naming the file and auth login when the refreshed profile cannot be saved", async () => {
    seed(creds());
    failRename.errors = [Object.assign(new Error(NODE_OS_ERROR), { code: "EROFS" })];
    const fetch = tokenEndpoint();
    const { code, streams } = run(["auth", "refresh"], fetch);
    expect({ code: await code, ...streams() }).toEqual({ ...PYTHON.notSaved, stderr: here(PYTHON.notSaved.stderr) });
    expect(fetch).toHaveBeenCalledOnce();
    expect(getProfile(loadCredentialsFile(credentialsPath))?.accessToken).toBe("atok-1");
  });

  it("reads a credentials.json it cannot read as no profile, as Python does, sending nothing", async () => {
    fs.writeFileSync(credentialsPath, "not json {{{");
    const fetch = tokenEndpoint();
    const { code, streams } = run(["auth", "refresh"], fetch);
    expect({ code: await code, ...streams() }).toEqual({ ...PYTHON.noProfile, stderr: here(PYTHON.noProfile.stderr) });
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(credentialsPath, "utf-8")).toBe("not json {{{");
  });

  it("refuses, naming it, a credentials.json that became unreadable by the time it holds the lock", async () => {
    seed(creds());
    const fetch = tokenEndpoint();
    expect(await peerRotatesWhileCliWaits(["auth", "refresh"], fetch, "not json {{{")).toEqual({
      ...PYTHON.cannotUpdate,
      stderr: here(PYTHON.cannotUpdate.stderr),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(credentialsPath, "utf-8")).toBe("not json {{{");
  });

  it("still says 'no profile' for a missing file, in Python's words", async () => {
    const fetch = tokenEndpoint();
    const { code, streams } = run(["auth", "refresh"], fetch);
    expect({ code: await code, ...streams() }).toEqual({ ...PYTHON.noProfile, stderr: here(PYTHON.noProfile.stderr) });
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(credentialsPath)).toBe(false);
  });
});

describe("auth token on the locked path (#92)", () => {
  const EXPIRED = creds({ expiresAt: new Date(Date.now() - 1000) });

  it("prints the token another process refreshed while it waited, and sends nothing", async () => {
    seed(EXPIRED);
    const fetch = tokenEndpoint();
    const result = await peerRotatesWhileCliWaits(["auth", "token"], fetch);
    // Python also writes its expiry warning to stderr; this bin does not.
    expect({ code: result.code, stdout: result.stdout }).toEqual(PYTHON.tokenAdopted);
    expect(fetch).not.toHaveBeenCalled();
  });

  // gate1 of #92: only a live token is adopted. A different one that has
  // expired as well is refreshed, from the refresh token on file, and the
  // refreshed token is printed — never the expired one.
  it("refreshes, from the file, a different token another process saved that has expired too", async () => {
    seed(EXPIRED);
    const fetch = tokenEndpoint();
    const stalePeer = creds({ accessToken: "atok-peer", refreshToken: "rtok-peer", expiresAt: new Date(Date.now() - 1000) });
    const result = await peerRotatesWhileCliWaits(["auth", "token"], fetch, stalePeer);
    expect({ code: result.code, stdout: result.stdout }).toEqual({ code: 0, stdout: "atok-2\n" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body)).get("refresh_token")).toBe("rtok-peer");
  });

  it("exits 1 without the token when the refreshed profile cannot be saved", async () => {
    seed(EXPIRED);
    failRename.errors = [Object.assign(new Error(NODE_OS_ERROR), { code: "EROFS" })];
    const fetch = tokenEndpoint();
    const { code, streams } = run(["auth", "token"], fetch);
    const result = { code: await code, ...streams() };
    expect(result).toEqual({ ...PYTHON.notSaved, stderr: here(PYTHON.notSaved.stderr) });
    expect(result.stderr).not.toContain("atok-2");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reads a credentials.json it cannot read as no profile, as Python does", async () => {
    fs.writeFileSync(credentialsPath, "not json {{{");
    const fetch = tokenEndpoint();
    const { code, streams } = run(["auth", "token"], fetch);
    expect({ code: await code, ...streams() }).toEqual({ ...PYTHON.noProfile, stderr: here(PYTHON.noProfile.stderr) });
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(credentialsPath, "utf-8")).toBe("not json {{{");
  });

  it("refuses, naming it, a credentials.json that became unreadable by the time it holds the lock", async () => {
    seed(EXPIRED);
    const fetch = tokenEndpoint();
    expect(await peerRotatesWhileCliWaits(["auth", "token"], fetch, "not json {{{")).toEqual({
      ...PYTHON.cannotUpdate,
      stderr: here(PYTHON.cannotUpdate.stderr),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(credentialsPath, "utf-8")).toBe("not json {{{");
  });
});
