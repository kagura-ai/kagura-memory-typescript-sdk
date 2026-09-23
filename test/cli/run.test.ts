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
import { DEFAULT_SCOPE, READ_ONLY_SCOPE, login } from "../../src/auth/login.js";
import type { CommandGroup } from "../../src/cli/command.js";
import { ROOT_COMMANDS, runCli, type CliDeps } from "../../src/cli/run.js";
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
    // Only `--invite` sends a request of the CLI's own; a test that forgets
    // to supply a server must fail rather than reach the network.
    fetch: async () => {
      throw new Error("no network in tests");
    },
    credentialsPath,
    ...over,
  } as unknown as CliDeps;

  return { deps, out, err, loginCalls, refreshCalls, opened, confirmAnswer };
}

describe("cli: usage and dispatch", () => {
  it.each([[[]], [["--help"]], [["help"]]])("lists the command groups for %j", async (argv) => {
    const h = harness();
    await runCli(argv, h.deps);
    const text = [...h.out, ...h.err].join("\n");
    expect(text).toMatch(/Usage: kagura-memory \[OPTIONS\] COMMAND/);
    // The root listing names groups, not full invocations; `auth --help`
    // is what expands to the subcommands.
    for (const name of ["auth", "recall", "remember", "explore"]) {
      expect(text).toMatch(new RegExp(`^\\s+${name}\\s`, "m"));
    }
  });

  it("expands a group's subcommands under `<group> --help`", async () => {
    const h = harness();
    expect(await runCli(["auth", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    for (const name of ["login", "logout", "refresh", "status", "use"]) {
      expect(text).toMatch(new RegExp(`^\\s+${name}\\s`, "m"));
    }
  });

  it("prints a command's own options under `<command> --help`", async () => {
    const h = harness();
    expect(await runCli(["recall", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/Usage: kagura-memory recall \[OPTIONS\] QUERY/);
    expect(text).toMatch(/-c, --context-id TEXT/);
    // `-k` is short-only in Python; the help must not advertise a --k.
    expect(text).not.toMatch(/--k\b/);
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
    // Click's wording, so the two CLIs fail identically.
    expect(a.err.join("\n")).toMatch(/Error: No such command 'frobnicate'\./);

    const b = harness();
    expect(await runCli(["login", "--porfile", "x"], b.deps)).toBe(2);
    expect(b.err.join("\n")).toMatch(/Unknown option: --porfile/);
  });

  it("rejects an unknown subcommand of a real group", async () => {
    const h = harness();
    expect(await runCli(["auth", "frobnicate"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/Error: No such command 'frobnicate'\./);
  });

  it("reports the version", async () => {
    const h = harness();
    expect(await runCli(["--version"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toMatch(/^kagura-memory, version \d+\.\d+\.\d+$/);
  });

  it("keeps a flag scoped to the command that declares it", async () => {
    // `--read-only` is real for `auth login` and must still be rejected by
    // `recall`, which has no such option — the reason each command carries
    // its own spec instead of sharing one global set.
    const h = harness();
    expect(await runCli(["recall", "q", "--read-only"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/Unknown option: --read-only/);
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
    // Record the launch into the same stream as the output, so ordering
    // is observable rather than asserted by eye.
    const events: string[] = [];
    const h = harness({
      write: (l: string) => events.push(`out: ${l}`),
      openBrowser: async () => {
        events.push("BROWSER LAUNCH");
        return true;
      },
    });

    await runCli(["login"], h.deps);
    const onUserCode = (h.loginCalls[0] as { onUserCode: (a: unknown) => Promise<void> })
      .onUserCode;
    await onUserCode({
      userCode: "WDJB-MJHT",
      verificationUri: "https://x.test/activate",
      verificationUriComplete: "https://x.test/activate?user_code=WDJB-MJHT",
    });

    const codeAt = events.findIndex((e) => e.includes("WDJB-MJHT"));
    const urlAt = events.findIndex((e) => e.includes("user_code=WDJB-MJHT"));
    const launchAt = events.indexOf("BROWSER LAUNCH");

    expect(codeAt).toBeGreaterThanOrEqual(0);
    expect(launchAt).toBeGreaterThanOrEqual(0);
    // A browser that opens silently, or fails to open, must never leave
    // the operator without the code.
    expect(codeAt).toBeLessThan(launchAt);
    expect(urlAt).toBeLessThan(launchAt);
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

/** Matches the server's `^[A-Za-z0-9_-]{20,128}$`; 30 characters. */
const INVITE = "inv_ABCDEFGHIJKLMNOPQRSTUV-123";
const SERVER_ARGS = ["--server", "https://api.test/mcp"];
const APPROVE = "https://app.test/device?user_code=WDJB-MJHT";
const INVITE_LINK = `https://app.test/join/${INVITE}?return_to=%2Fdevice%3Fuser_code%3DWDJB-MJHT`;
const JOIN_LINK = `https://app.test/join/${INVITE}`;

const SUPPORTED = { name: "memory-cloud", version: "0.76.0", features: { beta_invites: true } };
const OLDER = { name: "memory-cloud", version: "0.75.2", features: { beta_invites: true } };
const INVITES_OFF = { name: "memory-cloud", version: "0.76.0", features: { beta_invites: false } };

/**
 * A login server behind a fetch stub, for driving the real `login()`.
 *
 * The frontend (`app.test`, in the device response) is deliberately not
 * the API host (`api.test`), so a test can tell which one the invite link
 * was built on. `/system/info` answers `info`, or fails when it is an
 * Error; the token endpoint approves on the first poll. Every URL is
 * recorded, so a test can prove what was never requested.
 */
function loginServer(info: unknown) {
  const urls: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/api/v1/system/info")) {
      if (info instanceof Error) throw info;
      return new Response(JSON.stringify(info), { status: 200 });
    }
    if (url.endsWith("/api/v1/oauth/device/authorize")) {
      return new Response(
        JSON.stringify({
          device_code: "dev-code-1",
          user_code: "WDJB-MJHT",
          verification_uri: "https://app.test/device",
          verification_uri_complete: APPROVE,
          expires_in: 600,
          interval: 5,
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        access_token: "at-1",
        refresh_token: "rt-1",
        token_type: "Bearer",
        expires_in: 3600,
        scope: DEFAULT_SCOPE,
        user_email: "dev@kagura-ai.com",
        workspace_id: "ws-1",
        workspace_name: "Acme",
      }),
      { status: 200 },
    );
  };
  return { urls, fetch: impl as typeof globalThis.fetch };
}

/** A harness running the real `login()` against {@link loginServer}. */
function inviteHarness(info: unknown, over: Partial<CliDeps> = {}) {
  const server = loginServer(info);
  const h = harness({ login, fetch: server.fetch, ...over });
  return { ...h, urls: server.urls };
}

/** Every file under `root`, read as text. */
function filesUnder(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(root, e.name);
    if (e.isDirectory()) return filesUnder(p);
    return e.isFile() ? [fs.readFileSync(p, "utf8")] : [];
  });
}

describe("cli: login --invite (#44)", () => {
  it.each([
    ["a bare token", INVITE],
    ["a pasted link", `https://app.test/join/${INVITE}?utm=mail#top`],
  ])("prints and opens the one link for %s", async (_label, invite) => {
    const h = inviteHarness(SUPPORTED);
    expect(await runCli(["auth", "login", ...SERVER_ARGS, "--invite", invite], h.deps)).toBe(0);

    // The feature check goes to the login server; the link is built on
    // the frontend origin the device response names.
    expect(h.urls[0]).toBe("https://api.test/api/v1/system/info");
    expect(h.out).toContain(`    ${INVITE_LINK}`);
    expect(h.opened).toEqual([INVITE_LINK]);
  });

  it("prints the code, then the link, then the dashboard fallback", async () => {
    const h = inviteHarness(SUPPORTED);
    await runCli(["login", ...SERVER_ARGS, "--invite", INVITE], h.deps);

    const codeAt = h.out.findIndex((l) => l.includes("one-time code: WDJB-MJHT"));
    const linkAt = h.out.indexOf(`    ${INVITE_LINK}`);
    const fallbackAt = h.out.indexOf("  If you land on the dashboard instead, approve here:");
    expect(codeAt).toBeGreaterThanOrEqual(0);
    expect(linkAt).toBeGreaterThan(codeAt);
    expect(fallbackAt).toBeGreaterThan(linkAt);
    // An already-signed-in user, or a /join that still ends on the
    // dashboard, leaves the device code pending: approve it directly.
    expect(h.out[fallbackAt + 1]).toBe(`    ${APPROVE}`);
  });

  it("accepts a token that begins with a dash", async () => {
    // base64url: about one token in 64. Read as an unknown option, it
    // would be quoted back in the error.
    const dashed = `-${INVITE.slice(1)}`;
    const h = inviteHarness(SUPPORTED);
    expect(await runCli(["login", ...SERVER_ARGS, "--invite", dashed], h.deps)).toBe(0);
    expect(h.opened[0]).toContain(`/join/${dashed}?return_to=`);
    expect(h.err.join("\n")).not.toContain(dashed);
  });

  it.each([
    ["a token that is too short", "abc123"],
    ["a token outside the alphabet", `${INVITE}!`],
    ["an empty value", ""],
    ["a link whose token is malformed", "https://app.test/join/short-token"],
    ["a link with no /join/ segment", `https://app.test/invite/${INVITE}`],
  ])("exits 2 before any request for %s, without echoing it", async (_label, invite) => {
    const urls: string[] = [];
    const h = harness({
      fetch: (async (input: string | URL | Request) => {
        urls.push(String(input));
        throw new Error("no request expected");
      }) as typeof globalThis.fetch,
    });

    expect(await runCli(["login", ...SERVER_ARGS, `--invite=${invite}`], h.deps)).toBe(2);
    expect(urls).toEqual([]);
    expect(h.loginCalls).toEqual([]);
    expect(h.err.join("\n")).toMatch(/--invite/);
    if (invite !== "") {
      expect([...h.out, ...h.err].join("\n")).not.toContain(invite);
    }
  });

  it("aborts before polling on a link from another deployment, writing nothing", async () => {
    const h = inviteHarness(SUPPORTED);
    const code = await runCli(
      ["login", ...SERVER_ARGS, "--invite", `https://other.test/join/${INVITE}`],
      h.deps,
    );

    expect(code).toBe(1);
    expect(h.err.join("\n")).toMatch(/another deployment/);
    expect(h.err.join("\n")).not.toContain(INVITE);
    expect(h.urls.some((u) => u.includes("/oauth/token"))).toBe(false);
    expect(h.opened).toEqual([]);
    expect(fs.existsSync(credentialsPath)).toBe(false);
  });

  it.each([
    ["beta_invites: false", INVITES_OFF],
    ["no beta_invites key", { name: "memory-cloud", version: "0.76.0", features: {} }],
  ])("prints the notice and then the normal prompt for %s", async (_label, info) => {
    const h = inviteHarness(info);
    expect(await runCli(["login", ...SERVER_ARGS, "--invite", INVITE], h.deps)).toBe(0);

    const noticeAt = h.out.findIndex((l) => /does not take invite links/.test(l));
    const codeAt = h.out.findIndex((l) => l.includes("one-time code: WDJB-MJHT"));
    expect(noticeAt).toBeGreaterThanOrEqual(0);
    expect(codeAt).toBeGreaterThan(noticeAt);
    expect(h.out.slice(codeAt + 1, codeAt + 3)).toEqual(["  Then approve at:", `    ${APPROVE}`]);
    expect(h.opened).toEqual([APPROVE]);
    // Not used, so not shown.
    expect(h.out.join("\n")).not.toContain(INVITE);
  });

  it.each([
    ["an older server", OLDER],
    ["an unparseable version", { ...SUPPORTED, version: "nightly" }],
    ["a failed /system/info request", new TypeError("connect ECONNREFUSED")],
  ])("prints the two-step fallback for %s", async (_label, info) => {
    const h = inviteHarness(info);
    expect(await runCli(["login", ...SERVER_ARGS, "--invite", INVITE], h.deps)).toBe(0);

    const joinAt = h.out.indexOf(`    ${JOIN_LINK}`);
    const approveAt = h.out.indexOf(`    ${APPROVE}`);
    expect(joinAt).toBeGreaterThanOrEqual(0);
    expect(h.out[joinAt - 1]).toMatch(/^ {2}1\. /);
    expect(approveAt).toBeGreaterThan(joinAt);
    expect(h.out[approveAt - 1]).toMatch(/^ {2}2\. /);
    // Step 1 is what the browser opens; return_to would be ignored here.
    expect(h.opened).toEqual([JOIN_LINK]);
    expect(h.out.join("\n")).not.toContain("return_to");
  });

  it.each([
    ["one link", SUPPORTED],
    ["two steps", OLDER],
    ["invites off", INVITES_OFF],
  ])("prints the approval URL whenever --invite is given (%s)", async (_label, info) => {
    const h = inviteHarness(info);
    await runCli(["login", ...SERVER_ARGS, "--invite", INVITE], h.deps);
    expect(h.out).toContain(`    ${APPROVE}`);
  });

  it("prints the link and opens nothing with --no-browser", async () => {
    const h = inviteHarness(SUPPORTED);
    expect(
      await runCli(["login", ...SERVER_ARGS, "--invite", INVITE, "--no-browser"], h.deps),
    ).toBe(0);
    expect(h.out).toContain(`    ${INVITE_LINK}`);
    expect(h.opened).toEqual([]);
    expect(h.out.join("\n")).toMatch(/not opening a browser/);
  });

  it("never writes the token to the credentials file or any other file", async () => {
    const h = inviteHarness(SUPPORTED);
    expect(await runCli(["login", ...SERVER_ARGS, "--invite", INVITE], h.deps)).toBe(0);

    // Non-vacuous: the login really did write the profile.
    const cf = loadCredentialsFile(credentialsPath);
    expect(cf.profiles.default?.accessToken).toBe("at-1");
    expect(fs.readFileSync(credentialsPath, "utf8")).not.toContain(INVITE);
    for (const text of filesUnder(dir)) {
      expect(text).not.toContain(INVITE);
    }
  });

  it("sends no feature check without --invite", async () => {
    const h = inviteHarness(SUPPORTED);
    expect(await runCli(["login", ...SERVER_ARGS], h.deps)).toBe(0);
    expect(h.urls.some((u) => u.endsWith("/system/info"))).toBe(false);
    expect(h.opened).toEqual([APPROVE]);
  });

  it("documents --invite in auth login --help", async () => {
    const h = harness();
    expect(await runCli(["auth", "login", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/--invite TOKEN_OR_LINK\s+.*invite/);
    expect(text).toMatch(/\/join\/<token>/);
  });

  const others = Object.keys((ROOT_COMMANDS.auth as CommandGroup).commands).filter(
    (name) => name !== "login",
  );

  it("covers every other auth subcommand", () => {
    // Derived from the registry, so a new subcommand is checked too.
    expect(others.sort()).toEqual(["list", "logout", "refresh", "status", "token", "use"]);
  });

  it.each(others.flatMap((name) => [
    [["auth", name, "--invite", INVITE]],
    [["auth", name, `--invite=${INVITE}`]],
    // The bare alias parses the same pooled flag.
    [[name, "--invite", INVITE]],
  ]))("rejects %j with exit 2, without echoing the token", async (argv) => {
    seed({ default: creds() });
    const h = harness();

    expect(await runCli([...argv, "--yes"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/--invite applies only to 'auth login'/);
    expect([...h.out, ...h.err].join("\n")).not.toContain(INVITE);
    expect(h.refreshCalls).toEqual([]);
    // Nothing acted: logout --yes would otherwise have removed this.
    expect(Object.keys(loadCredentialsFile(credentialsPath).profiles)).toEqual(["default"]);
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

  it("is a successful no-op when there is nothing stored", async () => {
    // emptyCredentialsFile() names a default profile even with none
    // stored, so an untargeted logout used to report "No profile named
    // 'default'" and exit 1 — breaking `logout --yes` in idempotent
    // setup scripts on a fresh machine.
    const h = harness();
    expect(await runCli(["logout", "--yes"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toMatch(/[Nn]othing to do|No profiles/);
  });

  it("still reports an explicitly named profile that is absent", async () => {
    const h = harness();
    // Naming something specific that is not there is a real mismatch,
    // unlike an untargeted logout on an empty file.
    expect(await runCli(["logout", "--profile", "work", "--yes"], h.deps)).toBe(1);
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
