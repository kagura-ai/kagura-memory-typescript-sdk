import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCredentialsFile, resetStateCache } from "../../src/auth/credentials.js";
import { login } from "../../src/auth/login.js";
import { refresh } from "../../src/auth/refresh.js";
import { KaguraAuthError, KaguraAuthExpiredError } from "../../src/errors.js";

let dir: string;
let credentialsPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-refresh-"));
  credentialsPath = path.join(dir, "credentials.json");
  resetStateCache();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetStateCache();
});

/** Scripted OAuth server: a device-authorize response plus queued token replies. */
class FakeOAuthServer {
  urls: string[] = [];
  bodies: string[] = [];
  authorizeBody: Record<string, unknown> = {
    device_code: "dev-code-1",
    user_code: "WDJB-MJHT",
    verification_uri: "https://x.test/activate",
    expires_in: 600,
    interval: 5,
  };
  tokenResponses: { status: number; body: Record<string, unknown> }[] = [];

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    this.urls.push(url);
    this.bodies.push(typeof init?.body === "string" ? init.body : String(init?.body ?? ""));

    if (url.includes("/device/authorize")) {
      return new Response(JSON.stringify(this.authorizeBody), { status: 200 });
    }
    const next = this.tokenResponses.shift();
    if (!next) {
      throw new Error("unexpected extra token request");
    }
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
}

function tokenBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: "at-1",
    refresh_token: "rt-1",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "memory:read memory:write",
    user_email: "dev@kagura-ai.com",
    workspace_id: "ws-1",
    workspace_name: "Acme",
    ...over,
  };
}

/** Seed a stored profile by running a successful login. */
async function seedProfile(profile = "default"): Promise<void> {
  const server = new FakeOAuthServer();
  server.tokenResponses = [{ status: 200, body: tokenBody() }];
  await login({ mcpUrl: "https://x.test/mcp", credentialsPath, profile, fetch: server.fetch });
}

describe("refresh (#16)", () => {
  it("rotates the access token and persists it", async () => {
    await seedProfile();

    const server = new FakeOAuthServer();
    server.tokenResponses = [
      { status: 200, body: tokenBody({ access_token: "at-2", refresh_token: "rt-2" }) },
    ];
    const creds = await refresh({ credentialsPath, fetch: server.fetch });

    expect(creds.accessToken).toBe("at-2");
    expect(creds.refreshToken).toBe("rt-2");
    expect(loadCredentialsFile(credentialsPath).profiles.default!.accessToken).toBe("at-2");

    expect(server.urls).toEqual(["https://x.test/api/v1/oauth/token/"]);
    const form = new URLSearchParams(server.bodies[0]!);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt-1");
    expect(form.has("scope")).toBe(false);
  });

  it("keeps the stored refresh token when the server omits a new one", async () => {
    await seedProfile();

    const server = new FakeOAuthServer();
    server.tokenResponses = [
      { status: 200, body: { access_token: "at-2", expires_in: 3600 } },
    ];
    const creds = await refresh({ credentialsPath, fetch: server.fetch });

    // RFC 6749 §10.4 allows the server to keep the existing refresh token.
    // Overwriting it with "" would strand the profile.
    expect(creds.refreshToken).toBe("rt-1");
    expect(loadCredentialsFile(credentialsPath).profiles.default!.refreshToken).toBe("rt-1");
  });

  it("keeps the stored scope and identity when the server omits them", async () => {
    await seedProfile();

    const server = new FakeOAuthServer();
    server.tokenResponses = [
      { status: 200, body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 60 } },
    ];
    const creds = await refresh({ credentialsPath, fetch: server.fetch });

    expect(creds.scope).toBe("memory:read memory:write");
    expect(creds.workspaceName).toBe("Acme");
    expect(creds.userEmail).toBe("dev@kagura-ai.com");
  });

  it("narrows the scope through the refresh grant without re-consent", async () => {
    await seedProfile();

    const server = new FakeOAuthServer();
    server.tokenResponses = [
      { status: 200, body: tokenBody({ access_token: "at-2", scope: "memory:read" }) },
    ];
    const creds = await refresh({
      credentialsPath,
      scope: "memory:read",
      fetch: server.fetch,
    });

    expect(new URLSearchParams(server.bodies[0]!).get("scope")).toBe("memory:read");
    expect(creds.scope).toBe("memory:read");
    // Narrowing must not trigger a device flow.
    expect(server.urls.some((u) => u.includes("/device/authorize"))).toBe(false);
  });

  it.each(["insufficient_scope", "invalid_scope"])(
    "falls back to the device flow when widening is rejected with %s",
    async (error) => {
      await seedProfile();

      const server = new FakeOAuthServer();
      server.tokenResponses = [
        { status: 400, body: { error } },
        { status: 200, body: tokenBody({ access_token: "at-wide", refresh_token: "rt-wide" }) },
      ];
      const seen: string[] = [];

      const creds = await refresh({
        credentialsPath,
        scope: "memory:read memory:write profile:read",
        fetch: server.fetch,
        onUserCode: (auth) => {
          seen.push(auth.userCode);
        },
      });

      // Widening needs fresh consent — Python re-runs the device flow
      // rather than failing, and the shared credentials file means this
      // SDK must behave the same way.
      expect(server.urls[0]).toBe("https://x.test/api/v1/oauth/token/");
      expect(server.urls[1]).toBe("https://x.test/api/v1/oauth/device/authorize");
      expect(seen).toEqual(["WDJB-MJHT"]);
      expect(creds.accessToken).toBe("at-wide");
      expect(loadCredentialsFile(credentialsPath).profiles.default!.accessToken).toBe("at-wide");
    },
  );

  it("does not fall back to the device flow when no scope was requested", async () => {
    await seedProfile();

    const server = new FakeOAuthServer();
    server.tokenResponses = [{ status: 400, body: { error: "insufficient_scope" } }];

    // Without an explicit scope the rejection is not a widening attempt,
    // so re-consent would be the wrong response.
    await expect(refresh({ credentialsPath, fetch: server.fetch })).rejects.toBeInstanceOf(
      KaguraAuthError,
    );
    expect(server.urls.some((u) => u.includes("/device/authorize"))).toBe(false);
  });

  it("surfaces an expired refresh token as KaguraAuthExpiredError", async () => {
    await seedProfile();

    const server = new FakeOAuthServer();
    server.tokenResponses = [{ status: 400, body: { error: "invalid_grant" } }];

    await expect(refresh({ credentialsPath, fetch: server.fetch })).rejects.toBeInstanceOf(
      KaguraAuthExpiredError,
    );
    // The stored profile is left alone so the user can still inspect it.
    expect(loadCredentialsFile(credentialsPath).profiles.default!.accessToken).toBe("at-1");
  });

  it("refreshes a named profile and leaves the others untouched", async () => {
    await seedProfile("default");
    await seedProfile("work");

    const server = new FakeOAuthServer();
    server.tokenResponses = [
      { status: 200, body: tokenBody({ access_token: "at-work", refresh_token: "rt-work" }) },
    ];
    await refresh({ credentialsPath, profile: "work", fetch: server.fetch });

    const cf = loadCredentialsFile(credentialsPath);
    expect(cf.profiles.work!.accessToken).toBe("at-work");
    expect(cf.profiles.default!.accessToken).toBe("at-1");
  });

  it("throws a directive error when the profile does not exist", async () => {
    const server = new FakeOAuthServer();
    await expect(
      refresh({ credentialsPath, profile: "nope", fetch: server.fetch }),
    ).rejects.toThrow(/No profile named 'nope'/);
    expect(server.urls).toEqual([]);
  });
});
