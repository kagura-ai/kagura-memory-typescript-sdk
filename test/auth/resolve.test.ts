import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KaguraOAuth,
  emptyCredentialsFile,
  resetStateCache,
  saveCredentialsFile,
  setProfile,
} from "../../src/auth/credentials.js";
import type { OAuthCredentials } from "../../src/auth/credentials.js";
import {
  DEFAULT_MCP_URL,
  resetProfileWarnings,
  resolveAuth,
} from "../../src/auth/resolve.js";
import type {
  OAuthAuthResult,
  ResolvedAuth,
  StaticAuthResult,
} from "../../src/auth/types.js";
import { KaguraAuthError } from "../../src/errors.js";

let home: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-home-"));
  resetStateCache();
  resetProfileWarnings();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  resetStateCache();
  resetProfileWarnings();
});

function makeCreds(name: string): OAuthCredentials {
  return {
    server: "https://oauth.example.com",
    mcpUrl: "https://oauth.example.com/mcp",
    clientId: "kagura-cli",
    accessToken: `atok-${name}`,
    refreshToken: `rtok-${name}`,
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 3600_000),
    scope: "memory:read",
    workspaceId: "ws-id",
    workspaceName: `ws-${name}`,
    userEmail: `${name}@example.com`,
    issuedAt: new Date(),
  };
}

function writeProfiles(names: string[], defaultProfile?: string): void {
  const cf = emptyCredentialsFile();
  for (const name of names) {
    setProfile(cf, name, makeCreds(name));
  }
  if (defaultProfile) {
    cf.defaultProfile = defaultProfile;
  }
  saveCredentialsFile(cf, path.join(home, ".kagura", "credentials.json"));
}

function asStatic(r: ResolvedAuth): StaticAuthResult {
  expect(r.kind).toBe("static");
  if (r.kind !== "static") {
    throw new Error("expected static auth");
  }
  return r;
}

function asOAuth(r: ResolvedAuth): OAuthAuthResult {
  expect(r.kind).toBe("oauth");
  if (r.kind !== "oauth") {
    throw new Error("expected oauth auth");
  }
  return r;
}

const warnMessages = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));

describe("resolveAuth precedence", () => {
  it("exports the canonical default MCP URL", () => {
    expect(DEFAULT_MCP_URL).toBe("https://memory.kagura-ai.com/mcp");
  });

  it("explicit apiKey wins with the default mcpUrl", () => {
    const r = asStatic(resolveAuth({ apiKey: "key-1", env: {}, home }));
    expect(r.apiKey).toBe("key-1");
    expect(r.source).toBe("explicit");
    expect(r.mcpUrl).toBe(DEFAULT_MCP_URL);
  });

  it("explicit apiKey overrides a present credentials file", () => {
    writeProfiles(["default"]);
    const r = asStatic(resolveAuth({ apiKey: "explicit", env: {}, home }));
    expect(r.apiKey).toBe("explicit");
    expect(r.source).toBe("explicit");
  });

  it("whitespace-only explicit apiKey falls through to the OAuth profile", () => {
    writeProfiles(["default"]);
    const r = asOAuth(resolveAuth({ apiKey: "   ", env: {}, home }));
    expect(r.oauth).toBeInstanceOf(KaguraOAuth);
  });

  it("KAGURA_API_KEY env wins over the credentials file", () => {
    writeProfiles(["default"]);
    const r = asStatic(resolveAuth({ env: { KAGURA_API_KEY: "env-key" }, home }));
    expect(r.apiKey).toBe("env-key");
    expect(r.source).toBe("env");
  });

  it("KAGURA_API_KEY env uses KAGURA_MCP_URL for the endpoint", () => {
    const r = asStatic(
      resolveAuth({
        env: {
          KAGURA_API_KEY: "env-key",
          KAGURA_MCP_URL: "https://env.example.com/mcp",
        },
        home,
      }),
    );
    expect(r.mcpUrl).toBe("https://env.example.com/mcp");
  });

  it("whitespace-only KAGURA_API_KEY falls through to the OAuth profile", () => {
    writeProfiles(["default"]);
    const r = asOAuth(resolveAuth({ env: { KAGURA_API_KEY: "   " }, home }));
    expect(r.oauth).toBeInstanceOf(KaguraOAuth);
  });

  it("with no args picks up the default profile", async () => {
    writeProfiles(["default"]);
    const r = asOAuth(resolveAuth({ env: {}, home }));
    expect(r.oauth).toBeInstanceOf(KaguraOAuth);
    expect(r.mcpUrl).toBe("https://oauth.example.com/mcp"); // from the profile
    expect(r.workspaceId).toBe("ws-id");
    expect(await r.oauth.getAuthHeader()).toBe("Bearer atok-default");
  });

  it("an explicit profile argument overrides the default profile", async () => {
    writeProfiles(["default", "work"], "default");
    const r = asOAuth(resolveAuth({ profile: "work", env: {}, home }));
    expect(await r.oauth.getAuthHeader()).toBe("Bearer atok-work");
  });

  it("KAGURA_PROFILE env selects the profile", async () => {
    writeProfiles(["default", "work"], "default");
    const r = asOAuth(resolveAuth({ env: { KAGURA_PROFILE: "work" }, home }));
    expect(await r.oauth.getAuthHeader()).toBe("Bearer atok-work");
  });

  it("an explicit profile argument beats KAGURA_PROFILE env", async () => {
    writeProfiles(["default", "alpha", "beta"], "default");
    const r = asOAuth(
      resolveAuth({ profile: "alpha", env: { KAGURA_PROFILE: "beta" }, home }),
    );
    expect(await r.oauth.getAuthHeader()).toBe("Bearer atok-alpha");
  });

  it("an explicit mcpUrl overrides the profile's mcp_url", () => {
    writeProfiles(["default"]);
    const r = asOAuth(
      resolveAuth({ mcpUrl: "https://override.example.com/mcp", env: {}, home }),
    );
    expect(r.mcpUrl).toBe("https://override.example.com/mcp");
  });

  it("a missing profile argument raises loudly instead of falling through", () => {
    writeProfiles(["default"]);
    expect(() => resolveAuth({ profile: "missing", env: {}, home })).toThrow(
      /Profile 'missing' \(from profile argument\)/,
    );
  });

  it("a missing KAGURA_PROFILE raises loudly and names the env var", () => {
    writeProfiles(["default"]);
    expect(() => resolveAuth({ env: { KAGURA_PROFILE: "ghost" }, home })).toThrow(
      /KAGURA_PROFILE env/,
    );
  });

  it("falls back to a passed .kagura.json config as the static path of last resort", () => {
    const r = asStatic(
      resolveAuth({
        config: { api_key: "key-from-dot-kagura", mcp_url: "https://legacy.example.com/mcp" },
        env: {},
        home,
      }),
    );
    expect(r.apiKey).toBe("key-from-dot-kagura");
    expect(r.source).toBe("config");
    expect(r.mcpUrl).toBe("https://legacy.example.com/mcp");
  });

  it("a whitespace-only config api_key does not authenticate", () => {
    expect(() => resolveAuth({ config: { api_key: "   " }, env: {}, home })).toThrow(
      KaguraAuthError,
    );
  });

  it("throws with login guidance when no source produces credentials", () => {
    expect(() => resolveAuth({ config: { api_key: "" }, env: {}, home })).toThrow(
      /No credentials found/,
    );
    expect(() => resolveAuth({ config: { api_key: "" }, env: {}, home })).toThrow(
      /kagura auth login/,
    );
  });

  it("fails closed when default_profile points at a missing profile", () => {
    writeProfiles(["work", "personal"], "ghost");
    expect(() => resolveAuth({ config: {}, env: {}, home })).toThrow(/No credentials found/);
  });
});

describe("multi-profile ambiguity warning", () => {
  it("warns once per process for an implicit multi-profile default", () => {
    writeProfiles(["work", "personal"], "work");
    resolveAuth({ env: {}, home });
    resolveAuth({ env: {}, home }); // second call: deduped
    const msgs = warnMessages().filter((m) => m.includes("using profile 'work'"));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("ws-work"); // names the workspace
  });

  it("stays silent for a single profile", () => {
    writeProfiles(["only"]);
    resolveAuth({ env: {}, home });
    expect(warnMessages().filter((m) => m.includes("using profile"))).toHaveLength(0);
  });

  it("stays silent when the profile is chosen explicitly", () => {
    writeProfiles(["work", "personal"], "work");
    resolveAuth({ profile: "personal", env: {}, home });
    expect(warnMessages().filter((m) => m.includes("using profile"))).toHaveLength(0);
  });

  it("stays silent when KAGURA_PROFILE selects the profile", () => {
    writeProfiles(["work", "personal"], "work");
    resolveAuth({ env: { KAGURA_PROFILE: "personal" }, home });
    expect(warnMessages().filter((m) => m.includes("using profile"))).toHaveLength(0);
  });
});

describe("KAGURA_REQUIRE_PROFILE strict mode", () => {
  it("raises on an ambiguous implicit default", () => {
    writeProfiles(["work", "personal"], "work");
    expect(() => resolveAuth({ env: { KAGURA_REQUIRE_PROFILE: "1" }, home })).toThrow(
      /KAGURA_REQUIRE_PROFILE/,
    );
  });

  it("allows a single profile (unambiguous)", () => {
    writeProfiles(["only"]);
    const r = asOAuth(resolveAuth({ env: { KAGURA_REQUIRE_PROFILE: "1" }, home }));
    expect(r.workspaceId).toBe("ws-id");
  });

  it("allows an explicitly selected profile", () => {
    writeProfiles(["work", "personal"], "work");
    const r = asOAuth(
      resolveAuth({ profile: "personal", env: { KAGURA_REQUIRE_PROFILE: "1" }, home }),
    );
    expect(r.workspaceId).toBe("ws-id");
  });

  it("is not suppressed by a prior non-strict warning", () => {
    writeProfiles(["work", "personal"], "work");
    resolveAuth({ env: {}, home });
    expect(warnMessages().some((m) => m.includes("using profile 'work'"))).toBe(true);
    expect(() => resolveAuth({ env: { KAGURA_REQUIRE_PROFILE: "1" }, home })).toThrow(
      /KAGURA_REQUIRE_PROFILE/,
    );
  });
});
