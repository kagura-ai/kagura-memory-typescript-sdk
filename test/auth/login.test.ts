import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCredentialsFile, resetStateCache } from "../../src/auth/credentials.js";
import { login } from "../../src/auth/login.js";
import type { DeviceAuthorizationResponse } from "../../src/auth/deviceFlow.js";
import { KaguraAuthDeniedError } from "../../src/errors.js";

let dir: string;
let credentialsPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-login-"));
  credentialsPath = path.join(dir, "credentials.json");
  resetStateCache();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetStateCache();
});

/**
 * Scripted device-flow server: one `device/authorize` response followed by
 * `token/` responses drawn from `tokenResponses` in order.
 */
class FakeOAuthServer {
  urls: string[] = [];
  bodies: string[] = [];
  authorizeBody: Record<string, unknown> = {
    device_code: "dev-code-1",
    user_code: "WDJB-MJHT",
    verification_uri: "https://x.test/activate",
    verification_uri_complete: "https://x.test/activate?user_code=WDJB-MJHT",
    expires_in: 600,
    interval: 5,
  };
  tokenResponses: { status: number; body: Record<string, unknown> }[] = [
    {
      status: 200,
      body: {
        access_token: "at-1",
        refresh_token: "rt-1",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "memory:read memory:write",
        user_email: "dev@kagura-ai.com",
        workspace_id: "ws-1",
        workspace_name: "Acme",
      },
    },
  ];

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

describe("login (#9)", () => {
  it("runs authorize → poll → save and returns the stored credentials", async () => {
    const server = new FakeOAuthServer();
    const seen: DeviceAuthorizationResponse[] = [];

    const creds = await login({
      mcpUrl: "https://x.test/mcp",
      credentialsPath,
      fetch: server.fetch,
      onUserCode: (auth) => {
        seen.push(auth);
      },
    });

    // The host app is handed the code before any polling happens.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.userCode).toBe("WDJB-MJHT");
    expect(seen[0]!.verificationUri).toBe("https://x.test/activate");

    // Device endpoints hang off the REST base, not the /mcp path.
    expect(server.urls[0]).toBe("https://x.test/api/v1/oauth/device/authorize");
    expect(server.urls[1]).toBe("https://x.test/api/v1/oauth/token/");

    expect(creds.accessToken).toBe("at-1");
    expect(creds.refreshToken).toBe("rt-1");
    expect(creds.workspaceName).toBe("Acme");
    expect(creds.userEmail).toBe("dev@kagura-ai.com");
    expect(creds.server).toBe("https://x.test");
    expect(creds.mcpUrl).toBe("https://x.test/mcp");
  });

  it("writes the Python-CLI-compatible file shape at the given path", async () => {
    const server = new FakeOAuthServer();
    await login({
      mcpUrl: "https://x.test/mcp",
      credentialsPath,
      fetch: server.fetch,
    });

    const raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as Record<string, unknown>;
    expect(raw.version).toBe(1);
    expect(raw.default_profile).toBe("default");

    const profiles = raw.profiles as Record<string, Record<string, unknown>>;
    const profile = profiles.default!;
    expect(Object.keys(profile).sort()).toEqual(
      [
        "access_token",
        "client_id",
        "expires_at",
        "issued_at",
        "mcp_url",
        "refresh_token",
        "scope",
        "server",
        "token_type",
        "user_email",
        "workspace_id",
        "workspace_name",
      ].sort(),
    );
    expect(profile.access_token).toBe("at-1");
    expect(profile.mcp_url).toBe("https://x.test/mcp");
    // Z-suffixed UTC, seconds precision — the shape the Python CLI writes.
    expect(profile.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("stores under a named profile without stealing an existing default", async () => {
    const first = new FakeOAuthServer();
    await login({ mcpUrl: "https://x.test/mcp", credentialsPath, fetch: first.fetch });

    const second = new FakeOAuthServer();
    await login({
      mcpUrl: "https://x.test/mcp",
      credentialsPath,
      profile: "work",
      fetch: second.fetch,
    });

    const cf = loadCredentialsFile(credentialsPath);
    expect(Object.keys(cf.profiles).sort()).toEqual(["default", "work"]);
    expect(cf.defaultProfile).toBe("default");
  });

  it("promotes the new profile when setAsDefault is true", async () => {
    const first = new FakeOAuthServer();
    await login({ mcpUrl: "https://x.test/mcp", credentialsPath, fetch: first.fetch });

    const second = new FakeOAuthServer();
    await login({
      mcpUrl: "https://x.test/mcp",
      credentialsPath,
      profile: "work",
      setAsDefault: true,
      fetch: second.fetch,
    });

    expect(loadCredentialsFile(credentialsPath).defaultProfile).toBe("work");
  });

  it("polls through authorization_pending using the injected sleep", async () => {
    const server = new FakeOAuthServer();
    server.tokenResponses = [
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      {
        status: 200,
        body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 60 },
      },
    ];
    const slept: number[] = [];

    const creds = await login({
      mcpUrl: "https://x.test/mcp",
      credentialsPath,
      fetch: server.fetch,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(creds.accessToken).toBe("at-2");
    // First poll is immediate; then 5s, then 10s after slow_down (+5).
    expect(slept).toEqual([5000, 10_000]);
  });

  it("does not write credentials when the user denies", async () => {
    const server = new FakeOAuthServer();
    server.tokenResponses = [{ status: 400, body: { error: "access_denied" } }];

    await expect(
      login({ mcpUrl: "https://x.test/mcp", credentialsPath, fetch: server.fetch }),
    ).rejects.toBeInstanceOf(KaguraAuthDeniedError);

    expect(fs.existsSync(credentialsPath)).toBe(false);
  });

  it("propagates a throwing onUserCode without polling or writing", async () => {
    const server = new FakeOAuthServer();

    await expect(
      login({
        mcpUrl: "https://x.test/mcp",
        credentialsPath,
        fetch: server.fetch,
        onUserCode: () => {
          throw new Error("host app refused to display the code");
        },
      }),
    ).rejects.toThrow(/host app refused/);

    expect(server.urls).toEqual(["https://x.test/api/v1/oauth/device/authorize"]);
    expect(fs.existsSync(credentialsPath)).toBe(false);
  });

  it("forwards clientId and scope to the authorize call", async () => {
    const server = new FakeOAuthServer();
    await login({
      mcpUrl: "https://x.test/mcp",
      credentialsPath,
      clientId: "my-app",
      scope: "memory:read memory:write",
      fetch: server.fetch,
    });

    const body = JSON.parse(server.bodies[0]!) as Record<string, unknown>;
    expect(body).toEqual({ client_id: "my-app", scope: "memory:read memory:write" });

    const tokenForm = new URLSearchParams(server.bodies[1]!);
    expect(tokenForm.get("client_id")).toBe("my-app");
    expect(tokenForm.get("device_code")).toBe("dev-code-1");
  });
});
