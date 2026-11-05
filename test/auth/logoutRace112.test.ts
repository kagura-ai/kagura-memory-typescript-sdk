import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteCredentialsFile, deleteProfile, emptyCredentialsFile, loadCredentialsFile,
  refreshProfileLocked, saveCredentialsFile, setProfile, updateProfile, type OAuthCredentials,
} from "../../src/auth/credentials.js";
import { KaguraAuthExpiredError } from "../../src/errors.js";

let dir: string, file: string;
const creds = (): OAuthCredentials => ({
  server: "https://x.test", mcpUrl: "https://x.test/mcp", clientId: "cli", tokenType: "Bearer",
  accessToken: "at-old", refreshToken: "rt-old", expiresAt: new Date(0), issuedAt: new Date(0),
  scope: "memory:read", workspaceId: "ws", workspaceName: "Work", userEmail: "test@example.com",
});
const response = () => new Response(JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }), { status: 200 });
function seed() { const cf = emptyCredentialsFile(); setProfile(cf, "default", creds()); saveCredentialsFile(cf, file); }
function refresh(fetch: typeof globalThis.fetch) {
  return refreshProfileLocked("default", { fallback: creds(), expectedStaleToken: null, credentialsPath: file, fetch });
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-logout112-")); file = path.join(dir, "credentials.json"); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("logout and refresh do not resurrect credentials (#112)", () => {
  it("waits for an in-flight refresh, then deletes its result", async () => {
    seed();
    let enter!: () => void, finish!: (r: Response) => void;
    const entered = new Promise<void>(r => { enter = r; });
    const reply = new Promise<Response>(r => { finish = r; });
    const pending = refresh(async () => { enter(); return reply; });
    await entered;
    let deleted = false;
    const logout = deleteCredentialsFile(file).then(() => { deleted = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(deleted).toBe(false);
    finish(response());
    await Promise.all([pending, logout]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each(["all", "profile"])("rejects a cached fallback after %s logout won the lock", async kind => {
    seed();
    if (kind === "all") await deleteCredentialsFile(file);
    else await deleteProfile("default", file);
    const fetch = vi.fn(async () => response());
    await expect(refresh(fetch)).rejects.toBeInstanceOf(KaguraAuthExpiredError);
    expect(fetch).not.toHaveBeenCalled();
    expect(loadCredentialsFile(file).profiles).toEqual({});
    if (kind === "all") expect(fs.existsSync(file)).toBe(false);
  });

  it("allows explicit login again without clearing the revocation history", async () => {
    seed();
    await deleteCredentialsFile(file);
    const loggedIn = { ...creds(), accessToken: "at-login", expiresAt: new Date(Date.now() + 3600_000) };
    await updateProfile("default", loggedIn, file);
    const fetch = vi.fn(async () => response());
    expect((await refresh(fetch)).credentials.accessToken).toBe("at-login");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still permits an explicitly supplied profile that has never been saved or revoked", async () => {
    const fetch = vi.fn(async () => response());
    expect((await refresh(fetch)).credentials.accessToken).toBe("at-new");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fs.existsSync(file)).toBe(true);
  });

  it("fails closed on an unreadable revocation record before using a fallback", async () => {
    fs.writeFileSync(`${file}.revocations-v1`, "broken");
    const fetch = vi.fn(async () => response());
    await expect(refresh(fetch)).rejects.toThrow(/Cannot read .*revocations-v1/);
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("does not include malformed revocation contents in logged errors", async () => {
    fs.writeFileSync(`${file}.revocations-v1`, 'private-secret-invalid-json');
    const error = await refresh(vi.fn(async () => response())).catch(error => error);
    expect(inspect(error)).not.toContain('private-se');
  });

  it("preserves credentials when revocation cannot be persisted", async () => {
    seed();
    const before = fs.readFileSync(file, "utf8");
    fs.mkdirSync(`${file}.revocations-v1`);
    await expect(deleteCredentialsFile(file)).rejects.toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("preserves other profiles and stores no tokens in a named revocation", async () => {
    seed();
    await updateProfile("work", { ...creds(), accessToken: "private-work-token" }, file);
    await deleteProfile("default", file);
    expect(loadCredentialsFile(file).profiles.work?.accessToken).toBe("private-work-token");
    const marker = fs.readFileSync(`${file}.revocations-v1`, "utf8");
    expect(JSON.parse(marker)).toEqual({ version: 1, all: false, profiles: ["default"] });
    expect(marker).not.toContain("at-old");
    expect(marker).not.toContain("rt-old");
  });
});
