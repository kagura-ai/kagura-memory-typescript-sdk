import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyCredentialsFile, resetStateCache, saveCredentialsFile, setProfile } from "../../src/auth/credentials.js";
import { refreshProfile } from "../../src/auth/refresh.js";
import { runCli, type CliDeps } from "../../src/cli/run.js";
import { terminalText } from "../pythonDumpHarness.js";
import cases from "./authToken112.json" with { type: "json" };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-token112-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
  resetStateCache();
});
afterEach(() => {
  vi.useRealTimers();
  resetStateCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("auth token stdout/stderr/exit code against Python 0.44.0 (#112)", () => {
  it.each(cases)("expires in $seconds seconds, refresh token=$refreshToken", async c => {
    const credentialsPath = path.join(dir, "credentials.json");
    const cf = emptyCredentialsFile();
    setProfile(cf, "default", {
      server: "https://x.test", mcpUrl: "https://x.test/mcp", clientId: "kagura-cli",
      accessToken: "atok-1", refreshToken: c.refreshToken ? "rtok-1" : "", tokenType: "Bearer",
      expiresAt: new Date(Date.now() + c.seconds * 1000), scope: "memory:read memory:write",
      workspaceId: "ws-1", workspaceName: "Acme", userEmail: "test@example.com", issuedAt: new Date(),
    });
    saveCredentialsFile(cf, credentialsPath);
    if (!Number.isInteger(c.seconds)) {
      // Both SDK writers truncate to seconds; a user-edited/imported file can
      // carry fractions, as the Python oracle's input does.
      const raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
      raw.profiles.default.expires_at = new Date(Date.now() + c.seconds * 1000).toISOString();
      fs.writeFileSync(credentialsPath, JSON.stringify(raw));
    }
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: "atok-2", refresh_token: "rtok-2", token_type: "Bearer", expires_in: 3600,
    }), { status: 200 }));
    const refresh = vi.fn(refreshProfile);
    const out: string[] = [], err: string[] = [];
    const deps = { credentialsPath, fetch, refresh,
      write: (s: string) => out.push(s), writeError: (s: string) => err.push(s),
    } as unknown as CliDeps;
    expect(await runCli(["auth", "token"], deps)).toBe(c.code);
    expect(terminalText(out)).toBe(c.stdout);
    expect(terminalText(err)).toBe(c.stderr);
    expect(refresh).toHaveBeenCalledTimes(c.refreshCalls.length);
    if (c.refreshCalls.length) expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ onlyIfExpiring: true }));
    expect(fetch).toHaveBeenCalledTimes(c.refreshToken ? c.refreshCalls.length : 0);
  });
});
