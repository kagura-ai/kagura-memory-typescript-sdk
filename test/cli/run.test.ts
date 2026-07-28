import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadCredentialsFile,
  resetStateCache,
  saveCredentialsFile,
  emptyCredentialsFile,
  setProfile,
  type OAuthCredentials,
} from "../../src/auth/credentials.js";
import { DEFAULT_SCOPE, READ_ONLY_SCOPE } from "../../src/auth/login.js";
import { runCli, type CliDeps } from "../../src/cli/run.js";
import { KaguraAuthExpiredError } from "../../src/errors.js";

let dir: string;
let credentialsPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-cli-"));
  credentialsPath = path.join(dir, "credentials.json");
  resetStateCache();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetStateCache();
});

function creds(over: Partial<OAuthCredentials> = {}): OAuthCredentials {
  return {
    server: "https://x.test",
    mcpUrl: "https://x.test/mcp",
    clientId: "kagura-cli",
    accessToken: "at-1",
    refreshToken: "rt-1",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 3600_000),
    scope: DEFAULT_SCOPE,
    workspaceId: "ws-1",
    workspaceName: "Acme",
    userEmail: "dev@kagura-ai.com",
    issuedAt: new Date(),
    ...over,
  };
}

function seed(profiles: Record<string, OAuthCredentials>, defaultProfile?: string): void {
  const cf = emptyCredentialsFile();
  for (const [name, c] of Object.entries(profiles)) {
    setProfile(cf, name, c);
  }
  if (defaultProfile !== undefined) {
    cf.defaultProfile = defaultProfile;
  }
  saveCredentialsFile(cf, credentialsPath);
}

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  loginCalls: unknown[];
  refreshCalls: unknown[];
  opened: string[];
  confirmAnswer: { value: boolean };
}

function harness(over: Partial<CliDeps> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const loginCalls: unknown[] = [];
  const refreshCalls: unknown[] = [];
  const opened: string[] = [];
  const confirmAnswer = { value: true };

  const deps = {
    write: (l: string) => out.push(l),
    writeError: (l: string) => err.push(l),
    confirm: async () => confirmAnswer.value,
    openBrowser: async (url: string) => {
      opened.push(url);
      return true;
    },
    login: async (o: unknown) => {
      loginCalls.push(o);
      return creds();
    },
    refresh: async (o: unknown) => {
      refreshCalls.push(o);
      return creds({ accessToken: "at-2" });
    },
    credentialsPath,
    ...over,
  } as unknown as CliDeps;

  return { deps, out, err, loginCalls, refreshCalls, opened, confirmAnswer };
}

describe("cli: usage and dispatch", () => {
  it.each([[[]], [["--help"]], [["help"]]])("prints usage for %j", async (argv) => {
    const h = harness();
    await runCli(argv, h.deps);
    expect([...h.out, ...h.err].join("\n")).toMatch(/kagura-memory auth login/);
  });

  it("exits 2 with no command but 0 for explicit help", async () => {
    expect(await runCli([], harness().deps)).toBe(2);
    expect(await runCli(["--help"], harness().deps)).toBe(0);
  });

  it("accepts the 'auth' prefix so it reads like the Python CLI", async () => {
    const h = harness();
    expect(await runCli(["auth", "status"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toMatch(/No profiles/);
  });

  it.each([
    [["login", "--profile="], "--profile"],
    [["login", "--scope="], "--scope"],
    [["login", "--profile=   "], "--profile"],
  ])("rejects an empty value in %j", async (argv, flag) => {
    const h = harness();
    // "" is a usable profile name, so this would otherwise create a
    // nameless profile; an empty scope would go to the server verbatim.
    expect(await runCli(argv, h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(new RegExp(`${flag} needs a non-empty value`));
    expect(h.loginCalls).toEqual([]);
  });

  it("reports --json as unknown rather than silently ignoring it", async () => {
    const h = harness();
    expect(await runCli(["login", "--json"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/Unknown option: --json/);
  });

  it("rejects an unknown command and an unknown flag", async () => {
    const a = harness();
    expect(await runCli(["frobnicate"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/Unknown command: frobnicate/);

    const b = harness();
    expect(await runCli(["login", "--porfile", "x"], b.deps)).toBe(2);
    expect(b.err.join("\n")).toMatch(/Unknown option: --porfile/);
  });
});

describe("cli: login", () => {
  it("passes profile, server and scope through", async () => {
    const h = harness();
    await runCli(
      ["login", "--profile", "work", "--server", "https://self.test/mcp", "--scope", "memory:read"],
      h.deps,
    );
    expect(h.loginCalls[0]).toMatchObject({
      profile: "work",
      mcpUrl: "https://self.test/mcp",
      scope: "memory:read",
    });
  });

  it("maps --read-only to READ_ONLY_SCOPE and omits scope otherwise", async () => {
    const a = harness();
    await runCli(["login", "--read-only"], a.deps);
    expect(a.loginCalls[0]).toMatchObject({ scope: READ_ONLY_SCOPE });

    const b = harness();
    await runCli(["login"], b.deps);
    // Omitted, so login() applies DEFAULT_SCOPE — the CLI must not
    // hard-code its own default and drift from the library.
    expect(b.loginCalls[0]).not.toHaveProperty("scope");
  });

  it("rejects --read-only together with --scope, as Python does", async () => {
    const h = harness();
    expect(await runCli(["login", "--read-only", "--scope", "memory:read"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/mutually exclusive/);
    expect(h.loginCalls).toEqual([]);
  });

  it("prints the code and URL before attempting a browser", async () => {
    const h = harness();
    await runCli(["login"], h.deps);
    const onUserCode = (h.loginCalls[0] as { onUserCode: (a: unknown) => Promise<void> })
      .onUserCode;
    await onUserCode({
      userCode: "WDJB-MJHT",
      verificationUri: "https://x.test/activate",
      verificationUriComplete: "https://x.test/activate?user_code=WDJB-MJHT",
    });

    const text = h.out.join("\n");
    expect(text).toMatch(/WDJB-MJHT/);
    expect(text).toMatch(/https:\/\/x\.test\/activate\?user_code=WDJB-MJHT/);
    // The code must be visible even if the launch fails or opens silently.
    expect(text.indexOf("WDJB-MJHT")).toBeLessThan(text.length);
    expect(h.opened).toEqual(["https://x.test/activate?user_code=WDJB-MJHT"]);
  });

  it("does not open a browser with --no-browser", async () => {
    const h = harness();
    await runCli(["login", "--no-browser"], h.deps);
    const onUserCode = (h.loginCalls[0] as { onUserCode: (a: unknown) => Promise<void> })
      .onUserCode;
    await onUserCode({ userCode: "X", verificationUri: "https://x.test/a" });

    expect(h.opened).toEqual([]);
    expect(h.out.join("\n")).toMatch(/not opening a browser/);
  });

  it("says so when the browser cannot be opened", async () => {
    const h = harness({ openBrowser: async () => false });
    await runCli(["login"], h.deps);
    const onUserCode = (h.loginCalls[0] as { onUserCode: (a: unknown) => Promise<void> })
      .onUserCode;
    await onUserCode({ userCode: "X", verificationUri: "https://x.test/a" });
    expect(h.out.join("\n")).toMatch(/Could not open a browser/);
  });

  it("falls back to the workspace id when the name is absent", async () => {
    // workspace_name is optional in the token response and parses to "",
    // so interpolating it bare printed "workspace .".
    const h = harness({ login: async () => creds({ workspaceName: "" }) });
    await runCli(["login"], h.deps);
    expect(h.out.join("\n")).toMatch(/workspace ws-1\./);
    expect(h.out.join("\n")).not.toMatch(/workspace \./);
  });

  it("reports an auth failure with its guidance and exits 1", async () => {
    const h = harness({
      login: async () => {
        throw new KaguraAuthExpiredError("Your login expired.\n  Run: kagura auth login");
      },
    });
    expect(await runCli(["login"], h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/Run: kagura auth login/);
  });
});

describe("cli: status", () => {
  it("reports refreshable: false for a profile with no refresh token", async () => {
    seed({ default: creds({ refreshToken: "" }) });
    const h = harness();
    expect(await runCli(["status"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toMatch(/refreshable: false/);
  });

  it("distinguishes expired-but-refreshable from genuinely expired", async () => {
    seed({
      live: creds({ expiresAt: new Date(Date.now() - 1000) }),
      dead: creds({ expiresAt: new Date(Date.now() - 1000), refreshToken: "" }),
    });
    const h = harness();
    await runCli(["status"], h.deps);
    const text = h.out.join("\n");
    expect(text).toMatch(/expired \(refreshable\)/);
    expect(text).toMatch(/state: {6}expired\n/);
  });

  it("marks the default profile and can filter to one", async () => {
    seed({ default: creds(), work: creds({ workspaceName: "Work" }) }, "work");
    const h = harness();
    await runCli(["status"], h.deps);
    expect(h.out.join("\n")).toMatch(/\* work/);

    const one = harness();
    await runCli(["status", "--profile", "default"], one.deps);
    expect(one.out.join("\n")).not.toMatch(/Work/);
  });

  it("exits 1 for an unknown profile", async () => {
    seed({ default: creds() });
    const h = harness();
    expect(await runCli(["status", "--profile", "nope"], h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/No profile named 'nope'/);
  });
});

describe("cli: use", () => {
  it("switches the default profile", async () => {
    seed({ default: creds(), work: creds() });
    const h = harness();
    expect(await runCli(["use", "work"], h.deps)).toBe(0);
    expect(loadCredentialsFile(credentialsPath).defaultProfile).toBe("work");
  });

  it("refuses an unknown profile rather than pointing the file at nothing", async () => {
    seed({ default: creds() });
    const h = harness();
    expect(await runCli(["use", "nope"], h.deps)).toBe(1);
    expect(loadCredentialsFile(credentialsPath).defaultProfile).toBe("default");
  });

  it("requires the profile argument", async () => {
    const h = harness();
    expect(await runCli(["use"], h.deps)).toBe(2);
  });
});

describe("cli: logout", () => {
  it("removes the default profile after confirmation", async () => {
    seed({ default: creds(), work: creds() });
    const h = harness();
    expect(await runCli(["logout"], h.deps)).toBe(0);
    expect(Object.keys(loadCredentialsFile(credentialsPath).profiles)).toEqual(["work"]);
  });

  it("keeps everything when the confirmation is declined", async () => {
    seed({ default: creds() });
    const h = harness();
    h.confirmAnswer.value = false;
    expect(await runCli(["logout"], h.deps)).toBe(1);
    expect(Object.keys(loadCredentialsFile(credentialsPath).profiles)).toEqual(["default"]);
  });

  it("skips the prompt with --yes", async () => {
    seed({ default: creds() });
    const h = harness({
      confirm: async () => {
        throw new Error("should not prompt");
      },
    });
    expect(await runCli(["logout", "--yes"], h.deps)).toBe(0);
  });

  it("removes the whole file with --all", async () => {
    seed({ default: creds(), work: creds() });
    const h = harness();
    expect(await runCli(["logout", "--all", "--yes"], h.deps)).toBe(0);
    expect(fs.existsSync(credentialsPath)).toBe(false);
  });

  it("rejects --all together with --profile", async () => {
    seed({ default: creds() });
    const h = harness();
    expect(await runCli(["logout", "--all", "--profile", "default"], h.deps)).toBe(2);
    expect(fs.existsSync(credentialsPath)).toBe(true);
  });

  it("reports an absent profile instead of claiming a removal", async () => {
    seed({ default: creds() });
    const h = harness();
    expect(await runCli(["logout", "--profile", "nope", "--yes"], h.deps)).toBe(1);
    expect(h.out.join("\n")).toMatch(/No profile named 'nope'/);
  });
});

describe("cli: refresh", () => {
  it("passes profile and scope through", async () => {
    const h = harness();
    expect(await runCli(["refresh", "--profile", "work", "--scope", "memory:read"], h.deps)).toBe(
      0,
    );
    expect(h.refreshCalls[0]).toMatchObject({ profile: "work", scope: "memory:read" });
  });

  it("supplies onUserCode so a widening fallback can show the code", async () => {
    const h = harness();
    await runCli(["refresh", "--scope", "memory:read memory:write profile:read"], h.deps);
    expect(h.refreshCalls[0]).toHaveProperty("onUserCode");
  });
});
