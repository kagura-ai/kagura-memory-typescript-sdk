import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkedUrl, ProxyAuth } from "../../src/mcp/auth.js";
import { ProxyError, safeError } from "../../src/mcp/errors.js";
import {
  deleteProfile,
  loadCredentialsFile,
  resetStateCache,
  updateProfile,
} from "../../src/auth/credentials.js";

let dir: string;
let credentialsPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kagura-proxy-auth-"));
  credentialsPath = join(dir, "credentials.json");
  resetStateCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetStateCache();
});

const token = {
  access_token: "private-access",
  refresh_token: "private-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "memory:read",
  workspace_id: "test",
};
const authorization = {
  device_code: "private-device",
  user_code: "TEST-CODE",
  verification_uri: "https://example.test/device",
  verification_uri_complete: "https://example.test/device?code=TEST-CODE",
  expires_in: 600,
  interval: 0,
};
function setup(responses: Response[], extra = {}) {
  const requests: RequestInit[] = [];
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    requests.push(init!);
    const result = responses.shift();
    if (!result) throw new Error("unexpected request");
    return result;
  });
  const open = vi.fn(async () => true);
  const log = vi.fn();
  const auth = new ProxyAuth({
    credentialsPath,
    profile: "desktop",
    server: "https://example.test/mcp",
    fetch: fetcher,
    open,
    log,
    signal: new AbortController().signal,
    ...extra,
  });
  return { auth, requests, open, log, fetcher };
}
async function stored(overrides = {}) {
  await updateProfile(
    "desktop",
    {
      server: "https://example.test",
      mcpUrl: "https://example.test/mcp",
      clientId: "kagura-cli",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000),
      issuedAt: new Date(),
      scope: "memory:read",
      workspaceId: "test",
      workspaceName: "Test",
      userEmail: "",
      ...overrides,
    },
    credentialsPath,
  );
}

describe("desktop OAuth", () => {
  it("performs first login once, opens the URL, stores shared credentials without logging tokens", async () => {
    const s = setup([Response.json(authorization), Response.json(token)]);
    expect(
      await Promise.all([s.auth.getAuthHeader(), s.auth.getAuthHeader()]),
    ).toEqual(["Bearer private-access", "Bearer private-access"]);
    expect(s.open).toHaveBeenCalledOnce();
    expect(s.open).toHaveBeenCalledWith(
      authorization.verification_uri_complete,
    );
    expect(s.fetcher).toHaveBeenCalledTimes(2);
    expect(s.requests.every((r) => r.redirect === "error")).toBe(true);
    expect(
      loadCredentialsFile(credentialsPath).profiles.desktop?.refreshToken,
    ).toBe("private-refresh");
    expect(JSON.stringify(s.log.mock.calls)).toContain("TEST-CODE");
    expect(JSON.stringify(s.log.mock.calls)).not.toContain("private-");
  });

  it("uses an existing profile silently and refreshes on demand", async () => {
    await stored();
    const s = setup([Response.json(token)]);
    expect(await s.auth.getAuthHeader()).toBe("Bearer old-access");
    expect(s.fetcher).not.toHaveBeenCalled();
    await s.auth.forceRefresh();
    expect(await s.auth.getAuthHeader()).toBe("Bearer private-access");
    expect(s.open).not.toHaveBeenCalled();
  });

  it("refreshes near expiry without opening the browser", async () => {
    await stored({ expiresAt: new Date(0) });
    const s = setup([Response.json(token)]);
    expect(await s.auth.getAuthHeader()).toBe("Bearer private-access");
    expect(s.open).not.toHaveBeenCalled();
  });

  it("reauthenticates once after invalid_grant and preserves the existing read-only scope", async () => {
    await stored();
    const s = setup([
      Response.json({ error: "invalid_grant" }, { status: 400 }),
      Response.json(authorization),
      Response.json(token),
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    ]);
    await s.auth.forceRefresh();
    expect(JSON.parse(String(s.requests[1]!.body)).scope).toBe("memory:read");
    await expect(s.auth.forceRefresh()).rejects.toThrow("Login required");
    expect(s.open).toHaveBeenCalledOnce();
  });

  it("fails without touching the network when login is disabled", async () => {
    const s = setup([], { login: false });
    await expect(s.auth.getAuthHeader()).rejects.toThrow("Login required");
    expect(s.fetcher).not.toHaveBeenCalled();
  });

  it("provides a manual browser fallback", async () => {
    const s = setup([Response.json(authorization), Response.json(token)], {
      open: async () => false,
    });
    await s.auth.getAuthHeader();
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining("manually"));
  });

  it("supports no-browser without skipping device authorization", async () => {
    const s = setup([Response.json(authorization), Response.json(token)], {
      openBrowser: false,
    });
    await s.auth.getAuthHeader();
    expect(s.open).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining("TEST-CODE"));
  });

  it("reports denial and keeps the old profile intact", async () => {
    await stored({ expiresAt: new Date(0) });
    const s = setup([
      Response.json({ error: "invalid_grant" }, { status: 400 }),
      Response.json(authorization),
      Response.json({ error: "access_denied" }, { status: 400 }),
    ]);
    await expect(s.auth.getAuthHeader()).rejects.toThrow("denied");
    expect(
      loadCredentialsFile(credentialsPath).profiles.desktop?.accessToken,
    ).toBe("old-access");
  });

  it("aborts a stalled device request at the login deadline", async () => {
    const auth = new ProxyAuth({
      credentialsPath,
      server: "https://example.test/mcp",
      signal: new AbortController().signal,
      log: () => {},
      loginTimeoutMs: 10,
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener(
            "abort",
            () => reject(new Error("abort")),
            { once: true },
          ),
        ),
    });
    await expect(auth.getAuthHeader()).rejects.toThrow("timed out");
  });

  it("does not leak rejected OAuth bodies into errors", async () => {
    const s = setup([
      new Response("private-access private-refresh", { status: 500 }),
    ]);
    await expect(s.auth.getAuthHeader()).rejects.toThrow("login failed");
    expect(JSON.stringify(s.log.mock.calls)).not.toContain("private-");
    expect(safeError(new Error("private-access"))).not.toContain(
      "private-access",
    );
    expect(safeError(new ProxyError("safe"))).toBe("safe");
  });

  it("refuses to reuse a profile on a different server before sending tokens", async () => {
    await stored();
    expect(() => setup([], { server: "https://other.test/mcp" })).toThrow(
      "different server",
    );
    expect(() =>
      setup([], { server: "https://example.test/other/mcp" }),
    ).toThrow("different server");
    const s = setup([]);
    await stored({
      server: "https://other.test",
      mcpUrl: "https://other.test/mcp",
    });
    await expect(s.auth.getAuthHeader()).rejects.toThrow("server changed");
    expect(s.fetcher).not.toHaveBeenCalled();
  });

  it("does not retain a profile removed by CLI logout", async () => {
    await stored();
    const s = setup([], { login: false });
    expect(await s.auth.getAuthHeader()).toBe("Bearer old-access");
    await deleteProfile("desktop", credentialsPath);
    await expect(s.auth.getAuthHeader()).rejects.toThrow("Login required");
  });
});

it("requires HTTPS except for loopback and rejects URL credentials, fragments and non-web schemes", () => {
  for (const url of [
    "http://example.test/mcp",
    "https://user:pass@example.test/mcp",
    "file:///tmp/mcp",
    "https://example.test/mcp#x",
  ])
    expect(() => checkedUrl(url)).toThrow();
  expect(checkedUrl("http://127.0.0.1:1234/mcp").hostname).toBe("127.0.0.1");
});
