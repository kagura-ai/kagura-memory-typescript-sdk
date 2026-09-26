import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_MCP_URL, resolveAuth } from "../../../src/auth/resolve.js";
import { KaguraClient, MIN_SERVER_VERSION, type KaguraClientOptions } from "../../../src/client.js";
import { KaguraAuthError } from "../../../src/errors.js";
import type { ExecOptions, ExecResult } from "../../../src/cli/exec.js";
import { classifyMcpEntry, holdsCredential, unsetHeaderVars } from "../../../src/cli/commands/setup.js";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import type { KaguraConfig } from "../../../src/config.js";
import { FakeServer, makeClient } from "../../fakeServer.js";

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  server: FakeServer;
  /** Every program `execFile` was asked to run, as `[file, ...argv]`. */
  runs: string[][];
  /** The directory each of those runs was given, in the same order. */
  cwds: (string | undefined)[];
  /** The timeout each of those runs was given, in the same order. */
  timeouts: (number | undefined)[];
}

interface Programs {
  /** Program name → the path `which` reports; absent means not on PATH. */
  onPath?: Record<string, string>;
  /** What a run returns; defaults to a silent exit 0. */
  exec?: (file: string, argv: readonly string[]) => ExecResult;
}

function harness(
  config: KaguraConfig = { api_key: "k", mcp_url: "https://x.test/mcp" },
  programs: Programs = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const runs: string[][] = [];
  const cwds: (string | undefined)[] = [];
  const timeouts: (number | undefined)[] = [];
  const server = new FakeServer();
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => true,
    openBrowser: async () => true,
    which: (name: string) => programs.onPath?.[name] ?? null,
    execFile: async (file: string, argv: readonly string[], options?: ExecOptions) => {
      runs.push([file, ...argv]);
      cwds.push(options?.cwd);
      timeouts.push(options?.timeoutMs);
      return programs.exec?.(file, argv) ?? { code: 0, stdout: "", stderr: "" };
    },
    login: (() => {}) as unknown as CliDeps["login"],
    refresh: (() => {}) as unknown as CliDeps["refresh"],
    loadConfig: () => config,
    makeClient: (o: Record<string, unknown>) => makeClient(server, o),
    makeFilesClient: (() => {
      throw new Error("unused");
    }) as unknown as CliDeps["makeFilesClient"],
    makeResourceClient: (() => {
      throw new Error("unused");
    }) as unknown as CliDeps["makeResourceClient"],
    makeSecretClient: (() => {
      throw new Error("unused");
    }) as unknown as CliDeps["makeSecretClient"],
    isTty: () => false,
    readStdin: () => null,
    spawnChild: async () => 0,
  } as unknown as CliDeps;
  return { deps, out, err, server, runs, cwds, timeouts };
}

let sandbox: string;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-cli-"));
  // Claude Code keys local scope by the enclosing git root, so a sandbox
  // under a TMPDIR inside some work tree would inherit that root. Make the
  // sandbox its own root so every test starts from the same place.
  fs.mkdirSync(path.join(sandbox, ".git"));
  // An isolated HOME so no real credentials profile is read or written.
  process.env.HOME = path.join(sandbox, "home");
  process.env.USERPROFILE = process.env.HOME;
  fs.mkdirSync(process.env.HOME, { recursive: true });
  // Where `setup` looks for harness state; the developer's own must not leak in.
  for (const name of [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "HERMES_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    // setup falls back to them; the developer's own must not leak in.
    "KAGURA_API_KEY",
    "KAGURA_MCP_URL",
    "KAGURA_CONTEXT_ID",
    // The variable a user-scope entry sends: setup says whether this shell
    // has it, and doctor warns when it is unset.
    "KAGURA_MCP_API_KEY",
  ]) {
    delete process.env[name];
  }
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  // Restored in place: assigning a fresh object to process.env detaches it
  // from the real environment, and os.homedir() would go on reading the
  // first test's HOME for the rest of the file.
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const KEY = "kagura_secret_0123456789";
// Windows has no POSIX mode bits and needs privileges for a symlink.
const onPosixIt = os.platform() === "win32" ? it.skip : it;
const CONTEXT = "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c";

/** `setup claude` with a key and the sandbox as the project, plus `extra`. */
function claude(...extra: string[]): string[] {
  return ["setup", "claude", "--api-key", KEY, "--project-dir", sandbox, ...extra];
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

/** A profile as credentials.json stores it: a valid, unexpired one, `fields` over it. */
function profileJson(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: "https://x.test",
    mcp_url: "https://x.test/mcp",
    client_id: "c",
    access_token: "at",
    refresh_token: "rt",
    token_type: "Bearer",
    expires_at: "2099-01-01T00:00:00Z",
    scope: "memory:read",
    workspace_id: "w",
    workspace_name: "W",
    user_email: "u@x",
    issued_at: "2026-01-01T00:00:00Z",
    ...fields,
  };
}

/** Write `$HOME/.kagura/credentials.json` in the sandbox, mode 600. */
function writeCredentials(profiles: Record<string, Record<string, unknown>>, defaultProfile = "default"): void {
  const dir = path.join(process.env.HOME!, ".kagura");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, "credentials.json"),
    JSON.stringify({ version: 1, default_profile: defaultProfile, profiles }),
    { mode: 0o600 },
  );
}

/** A `claude plugin list --json` stand-in answering with `plugins`. */
function pluginList(plugins: unknown, code = 0): Programs {
  return {
    onPath: { claude: "/usr/bin/claude" },
    exec: (_file, argv) =>
      argv[0] === "plugin"
        ? { code, stdout: typeof plugins === "string" ? plugins : JSON.stringify(plugins), stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
  };
}

describe("kagura-memory doctor", () => {
  it("prints one STATUS line per check", async () => {
    const h = harness();
    h.server.restResults["/api/v1/server/info"] = { version: "0.60.0" };
    await runCli(["doctor"], h.deps);
    expect(h.out.length).toBeGreaterThan(3);
    for (const line of h.out) {
      expect(line).toMatch(/^(PASS|WARN|FAIL|INFO) /);
    }
  });

  it("fails on a plaintext mcp_url, because the bearer token would be in the clear", async () => {
    const h = harness({ api_key: "k", mcp_url: "http://memory.example.com/mcp" });
    const code = await runCli(["doctor"], h.deps);
    expect(code).toBe(1);
    expect(h.out.join("\n")).toMatch(/FAIL .*not HTTPS/);
  });

  it("accepts plaintext localhost, which is a deliberate dev choice", async () => {
    const h = harness({ api_key: "k", mcp_url: "http://localhost:8000/mcp" });
    await runCli(["doctor"], h.deps);
    expect(h.out.join("\n")).not.toMatch(/not HTTPS/);
  });

  // The clients' own HTTPS check decides, so doctor and the client agree
  // on every spelling: the scheme in any case, and what a URL parser drops.
  it.each([
    "HTTPS://memory.example.com/mcp",
    "hTtPs://memory.example.com/mcp",
    "HTTP://LOCALHOST:8000/mcp",
  ])("passes %j, which the client accepts", async (url) => {
    const h = harness({ api_key: "k", mcp_url: url });
    await runCli(["doctor"], h.deps);
    expect(h.out).toContain(`PASS mcp_url is ${url}`);
    expect(h.out.join("\n")).not.toMatch(/not HTTPS/);
  });

  it.each([
    "HTTP://memory.example.com/mcp",
    "http:memory.example.com/mcp",
    " http://memory.example.com/mcp",
    "ht\ttp://memory.example.com/mcp",
    // Not http(s) at all: no credential goes anywhere, but it is no HTTPS URL.
    "ftp://memory.example.com/mcp",
  ])("fails %j", async (url) => {
    const h = harness({ api_key: "k", mcp_url: url });
    expect(await runCli(["doctor"], h.deps)).toBe(1);
    expect(h.out).toContain(`FAIL mcp_url is not HTTPS: ${url} — credentials would be sent in the clear`);
  });

  it("warns that KAGURA_API_KEY outranks any OAuth profile", async () => {
    process.env.KAGURA_API_KEY = "kagura_env";
    const h = harness();
    await runCli(["doctor"], h.deps);
    expect(h.out.join("\n")).toMatch(/WARN KAGURA_API_KEY is set and takes precedence/);
  });

  it("exits 1 when any check fails and 0 when none do", async () => {
    const bad = harness({ api_key: "k", mcp_url: "http://x.example/mcp" });
    expect(await runCli(["doctor"], bad.deps)).toBe(1);

    const good = harness();
    good.server.restResults["/api/v1/server/info"] = { version: "0.60.0" };
    // The server check is the only other failure source here.
    const code = await runCli(["doctor"], good.deps);
    expect([0, 1]).toContain(code);
  });

  it("emits the Python JSON shape, including the duplicated section keys", async () => {
    const h = harness();
    await runCli(["doctor", "--json"], h.deps);
    const report = JSON.parse(h.out.join("\n")) as Record<string, unknown>;
    expect(report).toHaveProperty("sections");
    expect(report).toHaveProperty("checks");
    expect(report).toHaveProperty("exit_code");
    // Python's to_dict() spreads sections as top-level keys as well; a
    // script written against it reads them.
    for (const section of Object.keys(report.sections as Record<string, string>)) {
      expect(report[section]).toBe((report.sections as Record<string, string>)[section]);
    }
  });

  it("reports the missing age identity as info, not a failure", async () => {
    delete process.env.KAGURA_AGE_IDENTITY;
    delete process.env.KAGURA_AGE_IDENTITY_FILE;
    const h = harness();
    await runCli(["doctor"], h.deps);
    expect(h.out.join("\n")).toMatch(/INFO no age identity configured/);
  });

  it("warns when the identity sits in the environment", async () => {
    process.env.KAGURA_AGE_IDENTITY = "AGE-SECRET-KEY-1EXAMPLE";
    const h = harness();
    await runCli(["doctor"], h.deps);
    expect(h.out.join("\n")).toMatch(/WARN KAGURA_AGE_IDENTITY holds the private key/);
  });

  describe("the Claude Code entry", () => {
    const BEARER = { type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer k" } };

    function writeMcpJson(servers: Record<string, unknown>): void {
      fs.writeFileSync(path.join(sandbox, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
    }
    function writeClaudeJson(data: unknown): void {
      fs.writeFileSync(path.join(process.env.HOME!, ".claude.json"), JSON.stringify(data));
    }
    /** The mcp-section checks of `doctor --json`, run in `dir` (the sandbox by default). */
    async function mcpChecks(
      dir = sandbox,
      programs: Programs = {},
    ): Promise<{ status: string; message: string; details?: unknown }[]> {
      process.chdir(dir);
      const h = harness(undefined, programs);
      await runCli(["doctor", "--json"], h.deps);
      const report = JSON.parse(h.out.join("\n")) as { checks: { section: string; status: string; message: string }[] };
      // The mcp_url check comes first and is not about the entry.
      return report.checks.filter((c) => c.section === "mcp").slice(1);
    }

    it("reports the entry in use with its scope and file", async () => {
      writeMcpJson({ "kagura-memory": BEARER });
      expect(await mcpChecks()).toEqual([
        {
          section: "mcp",
          status: "pass",
          message: "MCP Mode: static-token (project scope, .mcp.json)",
          details: { scope: "project", source: ".mcp.json" },
        },
      ]);
    });

    it("finds a user-scope entry, which is no .mcp.json at all", async () => {
      writeClaudeJson({ mcpServers: { "kagura-memory": { type: "http", url: "https://x.test/mcp" } } });
      const checks = await mcpChecks();
      expect(checks.map((c) => `${c.status} ${c.message}`)).toEqual(["pass MCP Mode: url (user scope, ~/.claude.json)"]);
    });

    it("finds a local-scope entry under the project's real path, and knows a stdio one", async () => {
      writeClaudeJson({
        projects: { [fs.realpathSync(sandbox)]: { mcpServers: { "kagura-memory": { command: "kagura-mcp" } } } },
      });
      const checks = await mcpChecks();
      expect(checks[0]).toMatchObject({ status: "pass", message: "MCP Mode: stdio (local scope, ~/.claude.json)" });
    });

    it.each([
      ["an absolute path", { type: "stdio", command: "/home/u/.venv/bin/kagura-mcp", args: [] }],
      ["a Windows .exe", { type: "stdio", command: "C:\\venv\\Scripts\\kagura-mcp.exe" }],
      ["a launcher's argument", { command: "uvx", args: ["--from", "kagura-memory", "kagura-mcp"] }],
    ])("knows the Python proxy by %s, as Python's classifier does", async (_label, entry) => {
      // These worked in Claude Code and were reported as unusable.
      writeMcpJson({ "kagura-memory": entry });
      const [mode] = await mcpChecks();
      expect(`${mode!.status} ${mode!.message}`).toBe("pass MCP Mode: stdio (project scope, .mcp.json)");
    });

    it.each([
      [{ "kagura-mcp": "/venv/bin/kagura-mcp" }, "pass kagura-mcp found on PATH"],
      [{}, "fail kagura-mcp not found on PATH"],
    ])("checks PATH for kagura-mcp when the entry in use launches it (%j)", async (onPath, line) => {
      // A missing proxy is exactly what breaks a stdio entry at launch.
      writeClaudeJson({ mcpServers: { "kagura-memory": BEARER } });
      writeMcpJson({ "kagura-memory": { command: "kagura-mcp", args: ["--profile", "default"] } });
      const checks = (await mcpChecks(sandbox, { onPath })).map((c) => `${c.status} ${c.message}`);
      // Last, after the hidden-entry warnings, as in Python.
      expect(checks).toEqual([
        "pass MCP Mode: stdio (project scope, .mcp.json)",
        "warn kagura-memory is also defined in user scope (~/.claude.json), but Claude Code uses the project-scope entry here",
        line,
      ]);
    });

    it("runs no PATH check, and says nothing of one, for an entry that is not stdio", async () => {
      writeMcpJson({ "kagura-memory": BEARER });
      expect((await mcpChecks()).map((c) => c.message).join("\n")).not.toMatch(/kagura-mcp/);
    });

    it("warns for each variable the entry's headers send that is unset here, in Python's order", async () => {
      process.env.SET_ONE = "x";
      process.env.EMPTY_ONE = "";
      writeClaudeJson({ mcpServers: { "kagura-memory": BEARER } });
      writeMcpJson({
        "kagura-memory": {
          type: "url",
          url: "https://x.test/mcp",
          headers: {
            Authorization: "Bearer ${KAGURA_MCP_API_KEY}",
            "X-A": "${SET_ONE}/${EMPTY_ONE}/${WITH_DEFAULT:-d}/${KAGURA_MCP_API_KEY}",
            "X-B": 7,
          },
        },
      });
      const unset = (name: string) =>
        `warn The kagura-memory entry sends \${${name}} in a header, but ${name} is not set here: ` +
        "set it in the environment that starts Claude Code, or the server rejects the request";
      const checks = await mcpChecks();
      // After the type "url" hint, before the hidden entries.
      expect(checks.map((c) => `${c.status} ${c.message}`)).toEqual([
        "pass MCP Mode: static-token (project scope, .mcp.json)",
        'warn The kagura-memory entry has type "url", which Claude Code does not accept; ' +
          're-run `kagura-memory setup claude` to write it as "http"',
        unset("KAGURA_MCP_API_KEY"),
        unset("EMPTY_ONE"),
        "warn kagura-memory is also defined in user scope (~/.claude.json), but Claude Code uses the project-scope entry here",
      ]);
      expect(checks[2]!.details).toEqual({ scope: "project", source: ".mcp.json", env: "KAGURA_MCP_API_KEY" });
    });

    it("does not warn about the variable once it is set, nor about a hidden entry's", async () => {
      process.env.KAGURA_MCP_API_KEY = "kagura_x";
      writeClaudeJson({ mcpServers: { "kagura-memory": { ...BEARER, headers: { Authorization: "Bearer ${UNSET_HIDDEN}" } } } });
      writeMcpJson({ "kagura-memory": { ...BEARER, headers: { Authorization: "Bearer ${KAGURA_MCP_API_KEY}" } } });
      expect((await mcpChecks()).map((c) => c.message).join("\n")).not.toMatch(/is not set here/);
    });

    it("warns once for each entry the one in use hides", async () => {
      writeClaudeJson({
        mcpServers: { "kagura-memory": BEARER },
        projects: { [fs.realpathSync(sandbox)]: { mcpServers: { "kagura-memory": BEARER } } },
      });
      writeMcpJson({ "kagura-memory": BEARER });
      const checks = await mcpChecks();
      expect(checks.map((c) => `${c.status} ${c.message}`)).toEqual([
        "pass MCP Mode: static-token (local scope, ~/.claude.json)",
        "warn The kagura-memory entry (local scope, ~/.claude.json) holds an API key in that file; " +
          "remove it (`claude mcp remove --scope local kagura-memory`), then re-run `kagura-memory setup claude`",
        "warn kagura-memory is also defined in project scope (.mcp.json), but Claude Code uses the local-scope entry here",
        "warn kagura-memory is also defined in user scope (~/.claude.json), but Claude Code uses the local-scope entry here",
      ]);
      expect(checks[3]!.details).toEqual({ scope: "user", source: "~/.claude.json" });
    });

    it("warns about a user-scope entry that holds the key, as setup claude --scope user wrote it before 0.11.0", async () => {
      writeClaudeJson({ mcpServers: { "kagura-memory": { type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer kagura_OLDUSER_1" } } } });
      const checks = await mcpChecks();
      expect(checks.map((c) => `${c.status} ${c.message}`)).toEqual([
        "pass MCP Mode: static-token (user scope, ~/.claude.json)",
        "warn The kagura-memory entry (user scope, ~/.claude.json) holds an API key in that file; " +
          "re-run `kagura-memory setup claude --scope user` with KAGURA_MCP_API_KEY exported to replace it " +
          "with one that sends ${KAGURA_MCP_API_KEY}",
      ]);
      expect(checks[1]!.details).toEqual({ scope: "user", source: "~/.claude.json" });
    });

    it.each([
      ["the user-scope entry setup writes now", "user"],
      ["a project-scope entry, which setup writes with the key in .mcp.json", "project"],
    ] as const)("does not warn about %s", async (_label, scope) => {
      process.env.KAGURA_MCP_API_KEY = "set";
      const header = scope === "user" ? "Bearer ${KAGURA_MCP_API_KEY}" : "Bearer k";
      const servers = { "kagura-memory": { ...BEARER, headers: { Authorization: header } } };
      if (scope === "user") writeClaudeJson({ mcpServers: servers });
      else writeMcpJson(servers);
      expect((await mcpChecks()).map((c) => c.message).join("\n")).not.toMatch(/holds an API key/);
    });

    it("prints the details of every check that shares them, with no [Circular]", async () => {
      writeMcpJson({ "kagura-memory": { ...BEARER, type: "url" } });
      const checks = await mcpChecks();
      expect(checks).toHaveLength(2);
      for (const check of checks) expect(check.details).toEqual({ scope: "project", source: ".mcp.json" });
    });

    it("says where .mcp.json is not valid JSON, never what it holds", async () => {
      fs.writeFileSync(path.join(sandbox, ".mcp.json"), '{"mcpServers": {"kagura-memory": {"headers": {"Authorization": kagura_X}}}}');
      process.chdir(sandbox);
      const h = harness();
      expect(await runCli(["doctor"], h.deps)).toBe(1);
      // Node 18's V8 reports a position for this error, Node 20+ does not.
      expect(h.out.some((l) => /^FAIL \.mcp\.json is not valid JSON( \(line \d+ column \d+\))?$/.test(l))).toBe(true);
      expect(h.out.join("\n")).not.toContain("kagura_X");

      fs.writeFileSync(path.join(sandbox, ".mcp.json"), '{\n  "mcpServers": {} "x": 1}');
      const at = harness();
      await runCli(["doctor"], at.deps);
      expect(at.out).toContain("FAIL .mcp.json is not valid JSON (line 2 column 20)");
    });

    it('warns about a type "url" entry, which setup claude wrote before, and says how to fix it', async () => {
      // Recognised like "http", but Claude Code skips an entry of that type.
      writeMcpJson({ "kagura-memory": { ...BEARER, type: "url" } });
      const checks = await mcpChecks();
      expect(checks.map((c) => `${c.status} ${c.message}`)).toEqual([
        "pass MCP Mode: static-token (project scope, .mcp.json)",
        'warn The kagura-memory entry has type "url", which Claude Code does not accept; ' +
          're-run `kagura-memory setup claude` to write it as "http"',
      ]);
    });

    // A plain re-run writes project scope: it would leave a user entry as
    // it is, and the shadow check refuses it under a local one.
    it.each([
      ["user", "re-run `kagura-memory setup claude --scope user`"],
      ["local", "remove it (`claude mcp remove --scope local kagura-memory`), then re-run `kagura-memory setup claude`"],
    ] as const)('names the fix for a type "url" entry in %s scope', async (scope, fix) => {
      const servers = { "kagura-memory": { ...BEARER, type: "url" } };
      writeClaudeJson(
        scope === "user" ? { mcpServers: servers } : { projects: { [fs.realpathSync(sandbox)]: { mcpServers: servers } } },
      );
      const [hint] = (await mcpChecks()).filter((c) => c.message.includes('type "url"'));
      expect(hint!.message).toBe(
        `The kagura-memory entry has type "url", which Claude Code does not accept; ${fix} to write it as "http"`,
      );
    });

    it('names the directory of a parent .mcp.json with a type "url" entry', async () => {
      // A plain re-run in the subdirectory would write a closer file there.
      const repo = path.join(sandbox, "my repo");
      fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
      fs.writeFileSync(
        path.join(repo, ".mcp.json"),
        JSON.stringify({ mcpServers: { "kagura-memory": { ...BEARER, type: "url" } } }),
      );
      const [hint] = (await mcpChecks(path.join(repo, "sub"))).filter((c) => c.message.includes('type "url"'));
      expect(hint!.message).toContain(
        `re-run \`kagura-memory setup claude --project-dir '${fs.realpathSync(repo)}'\` to write it as "http"`,
      );
    });

    it("finds the local-scope entry Claude Code keys by the git root, from a subdirectory", async () => {
      // Claude Code files local scope under the repository root, whichever
      // subdirectory it runs in; a subdirectory's own key is never used.
      fs.mkdirSync(path.join(sandbox, ".git"), { recursive: true });
      const sub = path.join(sandbox, "pkg", "sub");
      fs.mkdirSync(sub, { recursive: true });
      writeClaudeJson({
        projects: {
          [fs.realpathSync(sandbox)]: { mcpServers: { "kagura-memory": BEARER } },
          [fs.realpathSync(sub)]: { mcpServers: { "kagura-memory": { command: "kagura-mcp" } } },
        },
      });
      const checks = await mcpChecks(sub);
      expect(checks.map((c) => `${c.status} ${c.message}`)).toEqual([
        "pass MCP Mode: static-token (local scope, ~/.claude.json)",
        "warn The kagura-memory entry (local scope, ~/.claude.json) holds an API key in that file; " +
          "remove it (`claude mcp remove --scope local kagura-memory`), then re-run `kagura-memory setup claude`",
      ]);
    });

    it("reports a parent directory's .mcp.json entry, which hides the user one", async () => {
      // Claude Code reads .mcp.json up the tree, and the closest file that
      // defines the server wins over user scope.
      process.env.HOME = fs.realpathSync(process.env.HOME!);
      const repo = path.join(process.env.HOME, "repo");
      const sub = path.join(repo, "sub");
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { "kagura-memory": BEARER } }));
      writeClaudeJson({ mcpServers: { "kagura-memory": { type: "http", url: "https://x.test/mcp" } } });
      const checks = await mcpChecks(sub);
      expect(checks.map((c) => `${c.status} ${c.message}`)).toEqual([
        "pass MCP Mode: static-token (project scope, ~/repo/.mcp.json)",
        "warn kagura-memory is also defined in user scope (~/.claude.json), " +
          "but Claude Code uses the project-scope entry here",
      ]);
    });

    it("warns about an entry that is no form it knows", async () => {
      writeMcpJson({ "kagura-memory": { type: "sse", url: "https://x.test/sse" } });
      expect((await mcpChecks()).map((c) => `${c.status} ${c.message}`)).toEqual([
        "warn No usable kagura-memory entry found in .mcp.json (project scope)",
      ]);
    });

    it("warns about a .mcp.json without the entry", async () => {
      writeMcpJson({ github: {} });
      expect((await mcpChecks()).map((c) => `${c.status} ${c.message}`)).toEqual([
        "warn No usable kagura-memory entry found in .mcp.json",
      ]);
    });

    it("says so, as info, when no scope defines the entry", async () => {
      expect((await mcpChecks()).map((c) => `${c.status} ${c.message}`)).toEqual([
        "info No kagura-memory MCP entry found (.mcp.json, ~/.claude.json)",
      ]);
    });

    it("fails on a .mcp.json that is not JSON", async () => {
      fs.writeFileSync(path.join(sandbox, ".mcp.json"), "{ not json");
      const checks = await mcpChecks();
      expect(checks[0]).toMatchObject({ status: "fail", message: expect.stringMatching(/^\.mcp\.json is not valid JSON/) });
    });
  });

  // #66: Python's `_check_server` — `Server reachable`, then the version's
  // verdict against the SDK's minimum by the shared `meetsMinimum`.
  describe("the server check", () => {
    const INFO_PATH = "/api/v1/system/info";

    /** The server-section checks of `doctor --json`, with the exit code and stderr. */
    async function serverChecks(
      h: Harness,
    ): Promise<{ code: number; checks: { status: string; message: string; details: unknown }[] }> {
      const code = await runCli(["doctor", "--json"], h.deps);
      const report = JSON.parse(h.out.join("\n")) as {
        checks: { section: string; status: string; message: string; details: unknown }[];
      };
      return {
        code,
        checks: report.checks
          .filter((c) => c.section === "server")
          .map(({ status, message, details }) => ({ status, message, details })),
      };
    }

    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it.each(["0.78.0", MIN_SERVER_VERSION, "v0.75.0", "0.75.0+build.7", "1.0.0-rc1"])(
      "passes a version that meets the minimum (%s)",
      async (version) => {
        const h = harness();
        h.server.restResults[INFO_PATH] = { name: "Kagura Memory Cloud", version };
        const { checks } = await serverChecks(h);
        expect(checks).toEqual([
          { status: "pass", message: "Server reachable", details: {} },
          { status: "pass", message: `Version: ${version}`, details: { version } },
        ]);
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it.each(["0.74.9", "0.75.0-rc1", "v0.17.1"])("fails a version below the minimum (%s)", async (version) => {
      const h = harness();
      h.server.restResults[INFO_PATH] = { name: "Kagura Memory Cloud", version };
      const { code, checks } = await serverChecks(h);
      expect(checks).toEqual([
        { status: "pass", message: "Server reachable", details: {} },
        {
          status: "fail",
          message: `Version: ${version} is below minimum ${MIN_SERVER_VERSION}`,
          details: { version, minimum: MIN_SERVER_VERSION },
        },
      ]);
      expect(code).toBe(1);
      // checkServerVersion's advisory, which Python's logging prints too.
      expect(warn).toHaveBeenCalledWith(
        `Server version ${version} is below the SDK's tested minimum ${MIN_SERVER_VERSION}. ` +
          "Some features may not work; older servers may silently ignore unknown parameters.",
      );
    });

    it.each(["main-abc123", "0.78", ""])("reports a version it cannot compare as info (%j)", async (version) => {
      const h = harness();
      h.server.restResults[INFO_PATH] = { name: "Kagura Memory Cloud", version };
      const { checks } = await serverChecks(h);
      expect(checks).toEqual([
        { status: "pass", message: "Server reachable", details: {} },
        { status: "info", message: `Version: ${version}`, details: { version } },
      ]);
    });

    it("fails with Python's wording when the server cannot be reached", async () => {
      const h = harness();
      h.server.forcedResponse = new Response("oops", { status: 503 });
      const { code, checks } = await serverChecks(h);
      expect(code).toBe(1);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ status: "fail", details: {} });
      expect(checks[0]!.message).toMatch(/^Server unreachable: /);
    });

    it("fails with the error's own message on a refused API key", async () => {
      const h = harness();
      h.server.forcedResponse = new Response('{"detail":"Invalid API key"}', { status: 401 });
      const { code, checks } = await serverChecks(h);
      expect(code).toBe(1);
      expect(checks).toHaveLength(1);
      expect(checks[0]!.status).toBe("fail");
      expect(checks[0]!.message).not.toMatch(/^Server unreachable/);
    });

    it("reports an OAuth profile the REST route refuses as info, in Python's words", async () => {
      const h = harness({});
      h.deps.resolveAuth = (() => ({
        kind: "oauth",
        oauth: { getAuthHeader: async () => "Bearer t" },
        mcpUrl: "https://x.test/mcp",
        workspaceId: null,
      })) as unknown as CliDeps["resolveAuth"];
      h.server.forcedResponse = new Response('{"detail":"Invalid API key"}', { status: 401 });
      const { checks } = await serverChecks(h);
      expect(checks).toEqual([
        {
          status: "info",
          message:
            "Could not verify server version over REST with an OAuth profile (expected: REST " +
            "validates API keys, not OAuth bearers; the MCP connection is unaffected).",
          details: {},
        },
      ]);
    });

    it("reports an OAuth refresh failure as Python's info line, not as unreachable (#69)", async () => {
      writeCredentials({ default: profileJson({ refresh_token: "", expires_at: "2020-01-01T00:00:00Z" }) });
      const h = harness({});
      h.deps.resolveAuth = resolveAuth as unknown as CliDeps["resolveAuth"];
      h.deps.makeClient = ((o: KaguraClientOptions) =>
        new KaguraClient({ ...o, fetch: h.server.fetch })) as CliDeps["makeClient"];
      const { checks } = await serverChecks(h);
      expect(checks).toEqual([
        {
          status: "info",
          message:
            "Could not verify server version over REST with an OAuth profile (expected: REST " +
            "validates API keys, not OAuth bearers; the MCP connection is unaffected).",
          details: {},
        },
      ]);
      expect(h.server.requests).toEqual([]);
    });

    it("fails with the error's message when no client can be built", async () => {
      const h = harness();
      h.deps.makeClient = (() => {
        throw new Error("MCP URL must use HTTPS");
      }) as unknown as CliDeps["makeClient"];
      const { checks } = await serverChecks(h);
      expect(checks).toEqual([{ status: "fail", message: "MCP URL must use HTTPS", details: {} }]);
    });

    it("fails the auth section and skips the check when the credential does not resolve, as Python's doctor does", async () => {
      // Python reports the failure in its auth section, then skips the
      // server check: no client, but still exit 1.
      const h = harness();
      h.deps.makeClient = (() => {
        throw new KaguraAuthError("Profile 'missing' (from profile argument) not found in credentials.json.");
      }) as unknown as CliDeps["makeClient"];
      const code = await runCli(["doctor", "--json"], h.deps);
      const report = JSON.parse(h.out.join("\n")) as {
        sections: Record<string, string>;
        checks: { section: string; status: string; message: string }[];
      };
      expect(code).toBe(1);
      expect(report.sections.auth).toBe("fail");
      const sections = report.checks.map((c) => c.section);
      const failed = report.checks.findIndex(
        (c) =>
          c.section === "auth" &&
          c.status === "fail" &&
          c.message ===
            "Authentication could not be resolved: Profile 'missing' (from profile argument) not found in credentials.json.",
      );
      // In the auth block, before the first check of another section.
      expect(failed).toBeGreaterThanOrEqual(0);
      expect(sections.slice(0, failed + 1).every((s) => s === "auth")).toBe(true);
      expect(report.checks.filter((c) => c.section === "server")).toEqual([
        { section: "server", status: "info", message: "Server connectivity check skipped because auth resolution failed", details: {} },
      ]);
    });

    // Python's get_server_info reads the body through its ServerInfo model,
    // and a refusal is a KaguraConnectionError: `Server unreachable`.
    it.each([
      [{}, "name: Field required; version: Field required"],
      [[], "Input should be a valid dictionary or instance of ServerInfo"],
      [null, "Input should be a valid dictionary or instance of ServerInfo"],
      [{ version: "0.1.0" }, "name: Field required"],
      [{ name: "n", version: 76 }, "version: Input should be a valid string"],
      [{ name: "n", version: "0.78.0", features: null }, "features: Input should be a valid dictionary or instance of ServerFeatures"],
      [{ name: "n", version: "0.78.0", search_defaults: [] }, "search_defaults: Input should be a valid dictionary"],
      // terms_version: str | None, from the Python SDK 0.41.0 (memory-cloud v0.77.0).
      [{ name: "n", version: "0.78.0", terms_version: 3 }, "terms_version: Input should be a valid string"],
    ])("fails a /system/info body Python's ServerInfo refuses (%j), without the advisory", async (body, problem) => {
      const h = harness();
      h.server.restResults[INFO_PATH] = body;
      const { code, checks } = await serverChecks(h);
      expect(code).toBe(1);
      expect(checks).toEqual([
        {
          status: "fail",
          message:
            "Server unreachable: Invalid response format: KaguraClient.get_server_info: unexpected server " +
            `response for ServerInfo (${problem}). The server may be newer than this SDK; upgrading ` +
            "kagura-memory may help.",
          details: {},
        },
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("passes a body with Python's optional fields and flags, and keys it does not know", async () => {
      const h = harness();
      h.server.restResults[INFO_PATH] = {
        name: "n",
        version: "0.78.0",
        description: null,
        environment: "prod",
        search_defaults: { use_rerank: true },
        terms_version: "2026-09-01",
        features: { neural_memory: true, flag_from_the_future: 1 },
        extra_key: 3,
      };
      const { code, checks } = await serverChecks(h);
      expect(code).toBe(0);
      expect(checks.map((c) => c.status)).toEqual(["pass", "pass"]);
    });

    it("checks the server with --profile's credential, as Python's doctor does", async () => {
      // Python resolves with profile=PROFILE and no config key over it; a
      // server check with the default profile would report on another server.
      const h = harness();
      const seen: unknown[] = [];
      const resolved: unknown[] = [];
      const make = h.deps.makeClient;
      h.deps.makeClient = ((o: Record<string, unknown>) => {
        seen.push(o);
        return make(o);
      }) as CliDeps["makeClient"];
      h.deps.resolveAuth = ((o: unknown) => {
        resolved.push(o);
        return { kind: "oauth", oauth: { getAuthHeader: async () => "Bearer t" }, mcpUrl: "https://x.test/mcp" };
      }) as unknown as CliDeps["resolveAuth"];
      h.server.forcedResponse = new Response('{"detail":"Invalid token"}', { status: 401 });
      const { checks } = await (async () => {
        const code = await runCli(["doctor", "--json", "--profile", "other"], h.deps);
        const report = JSON.parse(h.out.join("\n")) as { checks: { section: string; status: string }[] };
        return { code, checks: report.checks.filter((c) => c.section === "server") };
      })();
      expect(seen).toEqual([{ profile: "other" }]);
      expect(resolved).toEqual([{ apiKey: null, mcpUrl: null, profile: "other" }]);
      expect(checks).toMatchObject([{ status: "info" }]);
    });

    it("prints the two lines as Python does", async () => {
      const h = harness();
      h.server.restResults[INFO_PATH] = { name: "Kagura Memory Cloud", version: "0.78.0" };
      await runCli(["doctor"], h.deps);
      expect(h.out.slice(-2)).toEqual(["PASS Server reachable", "PASS Version: 0.78.0"]);
    });
  });

  it("gives every check a details object, as Python's to_dict does", async () => {
    const h = harness();
    await runCli(["doctor", "--json"], h.deps);
    const report = JSON.parse(h.out.join("\n")) as { checks: Record<string, unknown>[] };
    for (const check of report.checks) {
      expect(Object.keys(check)).toEqual(["section", "status", "message", "details"]);
      expect(typeof check.details).toBe("object");
    }
  });
});

describe("reading a kagura-memory entry, as Python's claude_code module does", () => {
  // Python's tables (tests/test_claude_code.py), case for case.
  const STDIO = { type: "stdio", command: "kagura-mcp", args: ["--profile", "default"] };
  const BEARER = { type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer kagura_abc" } };

  it.each([
    [STDIO, "stdio"],
    [{ command: "kagura-mcp", args: [] }, "stdio"], // Claude Code's default type
    [{ ...STDIO, command: "/home/u/.venv/bin/kagura-mcp" }, "stdio"], // absolute path
    [{ ...STDIO, command: "C:\\venv\\Scripts\\kagura-mcp.exe" }, "stdio"],
    [{ command: "uvx", args: ["--from", "kagura-memory", "kagura-mcp"] }, "stdio"],
    [{ type: "stdio", command: "kagura-mcp-other" }, "absent"],
    [{ type: "stdio", command: "uvx", args: "kagura-mcp" }, "absent"], // args not a list
    [BEARER, "static-token"],
    [{ ...BEARER, type: "url" }, "static-token"], // legacy SDK form
    [{ ...BEARER, type: "streamable-http" }, "static-token"],
    [{ type: "http", url: "https://h/mcp" }, "url"],
    [{ type: "url", url: "https://h/mcp" }, "url"],
    [{ type: "http", url: "https://h/mcp", headers: ["Authorization"] }, "url"],
    [{ type: "sse", url: "https://h/sse" }, "absent"],
    [{ type: "stdio", command: "other" }, "absent"],
    ["not-a-dict", "absent"],
  ] as const)("classifies %j as %s", (entry, mode) => {
    expect(classifyMcpEntry(entry)).toBe(mode);
  });

  it.each([
    ["Bearer ${KAGURA_MCP_API_KEY}", false],
    ["${TOKEN}", false],
    ["  Bearer   ${TOKEN} ", false],
    ["Bearer kagura_abc", true],
    ["Bearer ${TOKEN:-kagura_abc}", true], // the default may be a key
    ["Bearer kagura_${SUFFIX}", true],
    ["kagura_abc ${TOKEN}", true],
    ["Bearer ${A} ${B}", true],
    ["", true],
    [123, true],
  ] as const)("holdsCredential for an Authorization of %j is %s", (authorization, holds) => {
    const entry = { type: "http", url: "https://h/mcp", headers: { authorization } };
    expect(holdsCredential(entry)).toBe(holds);
  });

  it("holdsCredential looks only at Authorization, and only in an object's headers", () => {
    expect(holdsCredential(STDIO)).toBe(false);
    expect(holdsCredential({ type: "http", headers: { "X-Trace": "abc" } })).toBe(false);
    expect(holdsCredential("not-a-dict")).toBe(false);
  });

  it("unsetHeaderVars names each unset variable once, in order, skipping defaults", () => {
    process.env.SET_ONE = "x";
    process.env.EMPTY_ONE = "";
    const entry = {
      headers: {
        Authorization: "Bearer ${KAGURA_MCP_API_KEY}",
        "X-A": "${SET_ONE}/${EMPTY_ONE}/${WITH_DEFAULT:-d}/${KAGURA_MCP_API_KEY}",
        "X-B": 7,
      },
    };
    expect(unsetHeaderVars(entry)).toEqual(["KAGURA_MCP_API_KEY", "EMPTY_ONE"]);
    expect(unsetHeaderVars(STDIO)).toEqual([]);

    process.env.KAGURA_MCP_API_KEY = "k";
    expect(unsetHeaderVars(entry)).toEqual(["EMPTY_ONE"]);
  });
});

describe("kagura-memory setup claude", () => {
  it("writes both files and gitignores them", async () => {
    const h = harness({});
    const code = await runCli(
      ["setup", "claude", "--api-key", "kagura_secret", "--project-dir", sandbox],
      h.deps,
    );
    expect(code).toBe(0);

    const kagura = JSON.parse(fs.readFileSync(path.join(sandbox, ".kagura.json"), "utf-8"));
    expect(kagura).toMatchObject({ api_key: "kagura_secret" });

    const mcp = JSON.parse(fs.readFileSync(path.join(sandbox, ".mcp.json"), "utf-8"));
    // `http`, the type Claude Code documents for a streamable-HTTP server;
    // `url` is not one of its transports.
    expect(mcp.mcpServers["kagura-memory"]).toEqual({
      type: "http",
      url: DEFAULT_MCP_URL,
      headers: { Authorization: "Bearer kagura_secret" },
    });

    // Both files now hold the key; committing either publishes it.
    const gitignore = fs.readFileSync(path.join(sandbox, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".kagura.json");
    expect(gitignore).toContain(".mcp.json");
  });

  it("does not echo the key back on stdout", async () => {
    const h = harness({});
    await runCli(["setup", "claude", "--api-key", "kagura_secret", "--project-dir", sandbox], h.deps);
    expect(h.out.join("\n")).not.toContain("kagura_secret");
  });

  describe("refuses a plain-HTTP URL to a remote host, which would carry the key in the clear", () => {
    // Python's setup claude refuses these in its connection test, before it
    // writes anything: `Error: Connection failed: MCP URL must use HTTPS …`
    // (exit 1), whichever source the URL came from.
    const refused = (url: string) =>
      `Error: Connection failed: MCP URL must use HTTPS for security (got: ${url}). ` +
      "HTTP is only allowed for localhost development.";

    it.each([
      ["http://evil.example/mcp", "http://evil.example/mcp"],
      ["HTTP://evil.example/mcp", "HTTP://evil.example/mcp"],
      ["http:evil.example/mcp", "http:evil.example/mcp"],
      [" http://evil.example/mcp", "http://evil.example/mcp"],
    ])("from --mcp-url %j", async (url, shown) => {
      const h = harness({}, { onPath: { claude: "/usr/bin/claude" } });
      expect(await runCli(claude("--mcp-url", url, "--scope", "user"), h.deps)).toBe(1);
      expect(h.err).toEqual([refused(shown)]);
      expect(h.out).toEqual([]);
      expect(h.runs).toEqual([]);
      expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
      expect(fs.existsSync(path.join(sandbox, ".mcp.json"))).toBe(false);
    });

    it("from the project's .kagura.json", async () => {
      fs.writeFileSync(path.join(sandbox, ".kagura.json"), JSON.stringify({ mcp_url: "http://evil.example/mcp" }));
      const h = harness({});
      expect(await runCli(claude(), h.deps)).toBe(1);
      expect(h.err).toEqual([refused("http://evil.example/mcp")]);
      expect(fs.existsSync(path.join(sandbox, ".mcp.json"))).toBe(false);
      expect(readJson(path.join(sandbox, ".kagura.json"))).toEqual({ mcp_url: "http://evil.example/mcp" });
    });

    it("from KAGURA_MCP_URL, with the key from KAGURA_API_KEY", async () => {
      process.env.KAGURA_API_KEY = "kg_env_secret";
      process.env.KAGURA_MCP_URL = "http://evil.example/mcp";
      const h = harness({});
      expect(await runCli(["setup", "claude", "--project-dir", sandbox], h.deps)).toBe(1);
      expect(h.err).toEqual([refused("http://evil.example/mcp")]);
      expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
      expect(fs.existsSync(path.join(sandbox, ".mcp.json"))).toBe(false);
    });

    it("from the project's .kagura.json behind an empty --mcp-url, as Python's `or` falls back", async () => {
      // Python 0.40.1: `kagura setup claude -y --mcp-url=` exits 1 with the
      // connection error for the file's URL.
      fs.writeFileSync(path.join(sandbox, ".kagura.json"), JSON.stringify({ mcp_url: "http://evil.example/mcp" }));
      const h = harness({});
      expect(await runCli(claude("--mcp-url="), h.deps)).toBe(1);
      expect(h.err).toEqual([refused("http://evil.example/mcp")]);
      expect(fs.existsSync(path.join(sandbox, ".mcp.json"))).toBe(false);
      expect(readJson(path.join(sandbox, ".kagura.json"))).toEqual({ mcp_url: "http://evil.example/mcp" });
    });

    it.each([["http://localhost:8080/mcp"], ["http://127.0.0.1:8080/mcp"], ["http://[::1]:8080/mcp"]])(
      "but takes plain HTTP to %s, for local development",
      async (url) => {
        const h = harness({});
        expect(await runCli(claude("--mcp-url", url), h.deps)).toBe(0);
        expect(readJson(path.join(sandbox, ".mcp.json")).mcpServers["kagura-memory"].url).toBe(url);
      },
    );
  });

  describe("no setup subcommand prints the key, on either stream", () => {
    const everywhere: Programs = {
      onPath: { claude: "/usr/bin/claude", codex: "/usr/bin/codex", openclaw: "/usr/bin/openclaw" },
      exec: (_file, argv) =>
        argv[0] === "plugin"
          ? { code: 0, stdout: JSON.stringify([{ id: "kagura-memory@m", enabled: true }]), stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
    };
    // A harness CLI that echoes its argv back in an error is the case a
    // redaction has to survive: `claude mcp add-json` carries the key.
    const echoing: Programs = {
      onPath: everywhere.onPath!,
      exec: (_file, argv) => ({ code: 1, stdout: argv.join(" "), stderr: argv.join(" ") }),
    };

    // The exit code is asserted too, so that a scenario which stopped at
    // argument parsing cannot pass for want of reaching the key at all.
    it.each([
      ["claude", [], everywhere, 0],
      ["claude --scope user", ["--scope", "user"], everywhere, 0],
      ["claude --scope user, claude missing", ["--scope", "user"], {}, 1],
      ["claude --scope user, failing", ["--scope", "user"], echoing, 1],
      ["codex", [], everywhere, 0],
      ["codex, failing", [], echoing, 1],
      ["codex, codex missing", [], {}, 0],
      ["codex --dry-run", ["--dry-run"], everywhere, 0],
      ["hermes", [], everywhere, 0],
      ["hermes --dry-run", ["--dry-run"], everywhere, 0],
      ["openclaw", [], everywhere, 0],
      ["openclaw --force", ["--force"], everywhere, 0],
      ["openclaw, failing", [], echoing, 1],
      ["openclaw, openclaw missing", [], {}, 0],
      ["openclaw --dry-run", ["--dry-run"], everywhere, 0],
    ] as const)("%s", async (label, extra, programs, expected) => {
      process.env.CODEX_HOME = path.join(sandbox, "codex");
      process.env.HERMES_HOME = path.join(sandbox, "hermes");
      process.env.OPENCLAW_STATE_DIR = path.join(sandbox, "openclaw");
      const h = harness({}, programs);
      const harnessName = label.split(/[ ,]/)[0]!;
      const code = await runCli(
        ["setup", harnessName, "--api-key", KEY, "--project-dir", sandbox, "-c", CONTEXT, ...extra],
        h.deps,
      );
      expect(code).toBe(expected);
      expect(h.out.join("\n")).not.toContain(KEY);
      expect(h.err.join("\n")).not.toContain(KEY);
    });
  });

  it("reports the harness, how it was applied, guardrails and notes", async () => {
    const h = harness({});
    await runCli(["setup", "claude", "--api-key", "kagura_secret", "--project-dir", sandbox], h.deps);
    const report = JSON.parse(h.out.join("\n"));
    expect(report).toMatchObject({
      status: "success",
      harness: "claude",
      project_dir: sandbox,
      mcp_url: DEFAULT_MCP_URL,
      context_id: null,
      // Written by this bin, not by a harness CLI.
      applied_with: null,
      guardrails: null,
    });
    expect(report.wrote).toEqual([path.join(sandbox, ".kagura.json"), path.join(sandbox, ".mcp.json")]);
    expect(Array.isArray(report.notes)).toBe(true);
  });

  it("writes --mcp-url to .kagura.json as given, without the flags' parameters", async () => {
    // As Python's setup claude does: --guardrails and --tool-profile belong
    // to the entry, and baseUrlFromMcp finds the REST base in the path, so
    // a query the user gave does no harm there.
    const h = harness({});
    const given = "https://x.test/mcp?tools=a,b";
    await runCli(claude("--mcp-url", given, "--guardrails", "off", "--tool-profile", "core"), h.deps);
    const kagura = JSON.parse(fs.readFileSync(path.join(sandbox, ".kagura.json"), "utf-8"));
    expect(kagura.mcp_url).toBe(given);
    const mcp = JSON.parse(fs.readFileSync(path.join(sandbox, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers["kagura-memory"].url).toBe(`${given}&guardrails=off&profile=core`);
  });

  it("merges rather than replacing an existing config", async () => {
    fs.writeFileSync(
      path.join(sandbox, ".kagura.json"),
      JSON.stringify({ model: "gpt-5.4-nano", custom: 1 }),
    );
    fs.writeFileSync(
      path.join(sandbox, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { type: "url", url: "https://other" } } }),
    );
    const h = harness({});
    await runCli(["setup", "claude", "--api-key", "k2", "--project-dir", sandbox], h.deps);

    const kagura = JSON.parse(fs.readFileSync(path.join(sandbox, ".kagura.json"), "utf-8"));
    expect(kagura).toMatchObject({ model: "gpt-5.4-nano", custom: 1, api_key: "k2" });

    const mcp = JSON.parse(fs.readFileSync(path.join(sandbox, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.other).toBeDefined();
    expect(mcp.mcpServers["kagura-memory"]).toBeDefined();
  });

  it("does not duplicate a gitignore entry on a second run", async () => {
    const h = harness({});
    for (let i = 0; i < 2; i++) {
      await runCli(["setup", "claude", "--api-key", "k", "--project-dir", sandbox], h.deps);
    }
    const gitignore = fs.readFileSync(path.join(sandbox, ".gitignore"), "utf-8");
    expect(gitignore.match(/^\.kagura\.json$/gm)).toHaveLength(1);
  });

  it("refuses to rewrite a config file it could not parse", async () => {
    fs.writeFileSync(path.join(sandbox, ".mcp.json"), "{ not json");
    const h = harness({});
    const code = await runCli(["setup", "claude", "--api-key", "k", "--project-dir", sandbox], h.deps);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toMatch(/refusing to rewrite/);
    // The unparseable file must survive untouched, and nothing else be
    // written before the command stops.
    expect(fs.readFileSync(path.join(sandbox, ".mcp.json"), "utf-8")).toBe("{ not json");
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
  });

  it("stops on an unparseable .kagura.json before anything is applied", async () => {
    fs.writeFileSync(path.join(sandbox, ".kagura.json"), "{not json");
    const h = harness({}, { onPath: { claude: "/usr/bin/claude" } });
    expect(await runCli(claude("--scope", "user"), h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/refusing to rewrite .*\.kagura\.json/);
    expect(h.runs.filter((r) => r[1] === "mcp")).toEqual([]);
  });

  it.each([
    [".kagura.json", '{"api_key": kagura_FILECANARY_dddd4444}', "it is not valid JSON"],
    [".mcp.json", '{"mcpServers": {"x": {"headers": {"Authorization": kagura_FILECANARY_dddd4444}}}}', "it is not valid JSON"],
    [".kagura.json", '["kagura_FILECANARY_dddd4444"]', "it is not a JSON object"],
  ])("names a %s it cannot parse, and never quotes it", async (file, text, reason) => {
    // V8's JSON.parse message quotes the text around the error: the key.
    fs.writeFileSync(path.join(sandbox, file), text);
    const h = harness({});
    expect(await runCli(claude(), h.deps)).toBe(1);
    // A position follows when V8 reports one (Node 18 does for these, 20+ does not).
    expect(h.err).toHaveLength(1);
    expect(h.err[0]!.startsWith(`Error: refusing to rewrite ${path.join(sandbox, file)}: ${reason}`)).toBe(true);
    expect(h.err[0]).toMatch(/(: line \d+ column \d+| \(line \d+ column \d+\))?$/);
    expect(h.err[0]).not.toContain("FILECANARY");
  });

  it("rejects --profile with --api-key", async () => {
    const h = harness({});
    const code = await runCli(
      ["setup", "claude", "--profile", "work", "--api-key", "k", "--project-dir", sandbox],
      h.deps,
    );
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("mutually exclusive");
  });

  it("says why the OAuth path is unavailable rather than writing a broken config", async () => {
    const h = harness({});
    const code = await runCli(["setup", "claude", "--profile", "work", "--project-dir", sandbox], h.deps);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toMatch(/kagura-mcp.*stdio/s);
    expect(fs.existsSync(path.join(sandbox, ".mcp.json"))).toBe(false);
  });

  it("requires a key from somewhere", async () => {
    const h = harness({});
    const code = await runCli(["setup", "claude", "--project-dir", sandbox], h.deps);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("no API key");
  });

  it("falls back to the project's mcp_url, then to DEFAULT_MCP_URL", async () => {
    fs.writeFileSync(path.join(sandbox, ".kagura.json"), JSON.stringify({ mcp_url: "https://self.example/mcp" }));
    await runCli(claude(), harness({}).deps);
    expect(readJson(path.join(sandbox, ".mcp.json")).mcpServers["kagura-memory"].url).toBe(
      "https://self.example/mcp",
    );

    fs.rmSync(path.join(sandbox, ".kagura.json"));
    await runCli(claude(), harness({}).deps);
    expect(readJson(path.join(sandbox, ".mcp.json")).mcpServers["kagura-memory"].url).toBe(DEFAULT_MCP_URL);
  });

  describe("with no --api-key or --mcp-url, the project's own .kagura.json", () => {
    // Python reads `project / ".kagura.json"`. This bin's loader reads the
    // current directory's, then ~/.kagura.json: another project's key.
    const A = { api_key: "kagura_PROJA_aaaa1111", mcp_url: "https://a.example/mcp", context_id: "ctx-a" };
    const B = { api_key: "kagura_PROJB_bbbb2222", mcp_url: "https://b.example/mcp", context_id: "ctx-b" };
    let projA: string;
    let projB: string;

    beforeEach(() => {
      projA = path.join(sandbox, "projA");
      projB = path.join(sandbox, "projB");
      fs.mkdirSync(projA);
      fs.mkdirSync(projB);
      fs.writeFileSync(path.join(projA, ".kagura.json"), JSON.stringify(A));
      fs.writeFileSync(path.join(process.env.HOME!, ".kagura.json"), JSON.stringify({ api_key: "kagura_HOME_hhhh" }));
      process.chdir(projA);
    });

    it("gives the key, URL and context, never the current directory's", async () => {
      fs.writeFileSync(path.join(projB, ".kagura.json"), JSON.stringify(B));
      // The injected loader answers as the real one would from projA.
      const h = harness(A);
      expect(await runCli(["setup", "claude", "--project-dir", projB], h.deps)).toBe(0);
      expect(readJson(path.join(projB, ".kagura.json"))).toEqual(B);
      expect(readJson(path.join(projB, ".mcp.json")).mcpServers["kagura-memory"]).toEqual({
        type: "http",
        url: B.mcp_url,
        headers: { Authorization: `Bearer ${B.api_key}` },
      });
      expect(JSON.parse(h.out.join("\n"))).toMatchObject({ mcp_url: B.mcp_url, context_id: B.context_id });
      expect(readJson(path.join(projA, ".kagura.json"))).toEqual(A);
      expect(fs.existsSync(path.join(projA, ".mcp.json"))).toBe(false);
    });

    it("or else KAGURA_API_KEY, never the current directory's key or ~/.kagura.json's", async () => {
      process.env.KAGURA_API_KEY = "kagura_ENV_eeee3333";
      const h = harness(A);
      expect(await runCli(["setup", "claude", "--project-dir", projB], h.deps)).toBe(0);
      expect(readJson(path.join(projB, ".kagura.json"))).toEqual({
        api_key: "kagura_ENV_eeee3333",
        mcp_url: DEFAULT_MCP_URL,
      });
      const text = fs.readFileSync(path.join(projB, ".mcp.json"), "utf-8");
      expect(text).toContain("Bearer kagura_ENV_eeee3333");
      expect(text).not.toContain(A.api_key);
      expect(text).not.toContain("kagura_HOME_hhhh");
    });

    it.each([[["--mcp-url", ""]], [["--mcp-url="]]])(
      "and behind an empty --mcp-url, its URL, never a blank one: %j",
      async (flag) => {
        // Python resolves `mcp_url or existing_config.get("mcp_url")`: an
        // empty flag is no URL. Taking it as one wrote `"url": ""` into the
        // entry and blanked the project's mcp_url, then exited 0.
        fs.writeFileSync(path.join(projB, ".kagura.json"), JSON.stringify(B));
        const h = harness(A);
        expect(await runCli(["setup", "claude", "-y", "--project-dir", projB, ...flag], h.deps)).toBe(0);
        expect(readJson(path.join(projB, ".kagura.json"))).toEqual(B);
        expect(readJson(path.join(projB, ".mcp.json")).mcpServers["kagura-memory"].url).toBe(B.mcp_url);
        expect(JSON.parse(h.out.join("\n"))).toMatchObject({ mcp_url: B.mcp_url });
      },
    );

    it("or else nothing: no key is an error, and nothing is written", async () => {
      const h = harness(A);
      expect(await runCli(["setup", "claude", "--project-dir", projB], h.deps)).toBe(1);
      expect(h.err.join("\n")).toContain(
        "no API key: pass --api-key, set api_key in the project's .kagura.json, or export KAGURA_API_KEY.",
      );
      expect(fs.readdirSync(projB)).toEqual([]);
    });
  });

  it("rejects an unknown --scope with exit 2", async () => {
    const h = harness({});
    expect(await runCli(claude("--scope", "local"), h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/Invalid value for '--scope'/);
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
  });

  it("matches --scope case-sensitively, as Python's click.Choice declares it", async () => {
    const h = harness({});
    expect(await runCli(claude("--scope", "Project"), h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain(
      "Error: Invalid value for '--scope': 'Project' is not one of 'project', 'user'.",
    );
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
  });

  const INERT = [
    "--session-hook",
    "--no-session-hook",
    "--sync-hook",
    "--no-sync-hook",
    "--commands",
    "--no-commands",
    "--no-auto-context",
  ];

  it("accepts the Python CLI's hook, command and auto-context flags, and they change nothing", async () => {
    // So a script written for `kagura setup claude` still runs here.
    const plain = harness({});
    expect(await runCli(claude(), plain.deps)).toBe(0);
    const files = [".kagura.json", ".mcp.json", ".gitignore"].map((f) => fs.readFileSync(path.join(sandbox, f), "utf-8"));
    for (const f of [".kagura.json", ".mcp.json", ".gitignore"]) fs.rmSync(path.join(sandbox, f));

    const h = harness({});
    expect(await runCli(claude(...INERT.filter((f) => f.startsWith("--no-"))), h.deps)).toBe(0);
    expect([".kagura.json", ".mcp.json", ".gitignore"].map((f) => fs.readFileSync(path.join(sandbox, f), "utf-8"))).toEqual(
      files,
    );
    expect(fs.readdirSync(sandbox).sort()).toEqual([".git", ".gitignore", ".kagura.json", ".mcp.json", "home"]);
    expect(JSON.parse(h.out.join("\n")).notes).toEqual(JSON.parse(plain.out.join("\n")).notes);
  });

  it("says so when a flag asks for a hook or command this port does not install", async () => {
    const h = harness({});
    expect(await runCli(claude("--session-hook", "--commands"), h.deps)).toBe(0);
    expect(JSON.parse(h.out.join("\n")).notes).toContain(
      "--session-hook and --commands do nothing here: this port installs no hooks or slash commands",
    );
  });

  it("documents the entry forms, the server floors and the inert flags in --help", async () => {
    const h = harness({});
    expect(await runCli(["setup", "claude", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    // The user-scope entry's variable, and no word of a key on argv.
    expect(text).toContain("${KAGURA_MCP_API_KEY}");
    expect(text).not.toMatch(/argument list/);
    // Python's metavar, as on the harness subcommands.
    expect(text).toMatch(/--guardrails off\|CONTEXT_ID\s+.*server v0\.74\.0\+/);
    // Refused, and the help says so, as the harness subcommands' does.
    expect(text.replace(/\s+/g, " ")).toContain(
      "--profile TEXT OAuth profile (from `kagura auth login`) for the Python CLI's kagura-mcp entry, " +
        "which this port cannot write: refused",
    );
    expect(text).toMatch(/--tool-profile NAME\s+.*server v0\.73\.0\+.*'full' and 'core'/);
    for (const flag of INERT) {
      expect(text).toMatch(new RegExp(`${flag}\\s+Accepted for compatibility; this port ` + "(installs no|never prompts)"));
    }
  });

  it("does not take the hook flags on the other harnesses", async () => {
    const h = harness({});
    expect(await runCli(["setup", "codex", "--api-key", KEY, "--no-session-hook"], h.deps)).toBe(2);
  });
});

describe("setup claude --guardrails and --tool-profile", () => {
  const entryUrl = () => readJson(path.join(sandbox, ".mcp.json")).mcpServers["kagura-memory"].url;

  it("adds guardrails=off with ? when the URL has no query", async () => {
    const h = harness({});
    expect(await runCli(claude("--mcp-url", "https://x.test/mcp", "--guardrails", "OFF"), h.deps)).toBe(0);
    expect(entryUrl()).toBe("https://x.test/mcp?guardrails=off");
    expect(JSON.parse(h.out.join("\n")).guardrails).toBe("off");
  });

  it("keeps the other parameters and moves guardrails to the end, as Python does", async () => {
    // The old value is dropped rather than left first: the server reads the
    // first guardrails it finds.
    const h = harness({});
    const given = `https://x.test/mcp?profile=core&guardrails=${CONTEXT}&tools=a,b`;
    await runCli(claude("--mcp-url", given, "--guardrails", "off"), h.deps);
    expect(entryUrl()).toBe("https://x.test/mcp?profile=core&tools=a,b&guardrails=off");
  });

  it("puts guardrails before profile when both are set", async () => {
    const h = harness({});
    await runCli(
      claude("--mcp-url", "https://x.test/mcp", "--guardrails", CONTEXT.toUpperCase(), "--tool-profile", "core"),
      h.deps,
    );
    expect(entryUrl()).toBe(`https://x.test/mcp?guardrails=${CONTEXT}&profile=core`);
  });

  it("takes a context id and writes it canonically", async () => {
    const h = harness({});
    await runCli(
      claude("--mcp-url", "https://x.test/mcp?profile=core", "--guardrails", CONTEXT.toUpperCase()),
      h.deps,
    );
    expect(entryUrl()).toBe(`https://x.test/mcp?profile=core&guardrails=${CONTEXT}`);
  });

  it("keeps a guardrails value already in --mcp-url when the flag is absent", async () => {
    const h = harness({});
    await runCli(claude("--mcp-url", `https://x.test/mcp?guardrails=${CONTEXT}`), h.deps);
    expect(entryUrl()).toBe(`https://x.test/mcp?guardrails=${CONTEXT}`);
  });

  it.each(["on", "none", "ctx-dev", ""])(
    "rejects --guardrails %j with exit 2, writing nothing",
    async (value) => {
      // The server silently ignores anything but a UUID or off, so a typo
      // would otherwise look like it worked.
      const h = harness({});
      expect(await runCli(claude(`--guardrails=${value}`), h.deps)).toBe(2);
      expect(h.err).toContain(
        `Error: Invalid value for '--guardrails': guardrails must be 'off' or a context UUID, got '${value}'`,
      );
      expect(fs.existsSync(path.join(sandbox, ".mcp.json"))).toBe(false);
    },
  );

  it.each(["", "  "])("rejects --tool-profile %j with exit 2, as Python does", async (value) => {
    const h = harness({});
    expect(await runCli(claude(`--tool-profile=${value}`), h.deps)).toBe(2);
    expect(h.err).toContain("Error: Invalid value for '--tool-profile': must not be empty");
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
  });

  it("trims --tool-profile", async () => {
    const h = harness({});
    await runCli(claude("--mcp-url", "https://x.test/mcp", "--tool-profile", " core "), h.deps);
    expect(entryUrl()).toBe("https://x.test/mcp?profile=core");
  });

  it("--tool-profile sets profile and keeps the rest of the query", async () => {
    const h = harness({});
    await runCli(
      claude("--mcp-url", "https://x.test/mcp?tools=recall&profile=full", "--tool-profile", "core"),
      h.deps,
    );
    expect(entryUrl()).toBe("https://x.test/mcp?tools=recall&profile=core");
  });
});

describe("setup claude scopes", () => {
  const claudeJson = () => path.join(process.env.HOME!, ".claude.json");
  const onClaude: Programs = { onPath: { claude: "/usr/bin/claude" } };
  const mcpRuns = (h: Harness) => h.runs.filter((r) => r[1] === "mcp");
  /** What a user-scope entry carries in place of the key. */
  const REF = "${KAGURA_MCP_API_KEY}";
  /**
   * The user-scope entry setup writes for `https://x.test/mcp`: the variable
   * Claude Code reads the key from when it connects, never the key.
   */
  const newEntry = { type: "http", url: "https://x.test/mcp", headers: { Authorization: `Bearer ${REF}` } };
  const OLD_KEY = "kagura_old_key_9876543210";
  /** An entry with a key baked in, as this bin wrote before #55 and Python before #258. */
  const bakedEntry = { type: "http", url: "https://old", headers: { Authorization: `Bearer ${OLD_KEY}` } };
  /** A different entry that holds no credential, so it can go back on a command line. */
  const oldEntry = { command: "kagura-mcp", args: ["--profile", "work"] };
  /** The add-json command, ready to run as printed: the single quotes keep `${…}` literal. */
  const addJsonLine = (url: string) =>
    `claude mcp add-json --scope user kagura-memory '{"type":"http","url":"${url}","headers":{"Authorization":"Bearer ${REF}"}}'`;
  /** Python's note on where the key comes from, as one JSON note. */
  const ENV_NOTE =
    "The entry sends the API key from $KAGURA_MCP_API_KEY, which Claude Code reads when it connects, " +
    "so the key is neither in the entry nor on a command line. Set it in the environment that starts " +
    "Claude Code, e.g. `export KAGURA_MCP_API_KEY=<your-api-key>` in your shell profile.";
  /** The same note on stderr, wrapped as Python prints it. */
  const ENV_NOTE_LINES = [
    "  The entry sends the API key from $KAGURA_MCP_API_KEY, which Claude Code reads when it",
    "  connects, so the key is neither in the entry nor on a command line. Set it in",
    "  the environment that starts Claude Code, e.g. `export KAGURA_MCP_API_KEY=<your-api-key>`",
    "  in your shell profile.",
  ];
  const notesOf = (h: Harness): string[] => JSON.parse(h.out.join("\n")).notes as string[];

  /** The key Claude Code files the project's local scope under: its real path. */
  const realSandbox = () => fs.realpathSync(sandbox);

  function seedClaudeJson(data: unknown): string {
    const text = JSON.stringify(data);
    fs.writeFileSync(claudeJson(), text);
    return text;
  }

  it("--scope user runs `claude mcp add-json` and writes no .mcp.json", async () => {
    const h = harness({}, onClaude);
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(0);

    // Python's argv order: `--scope user` before the name.
    expect(mcpRuns(h)).toEqual([
      ["/usr/bin/claude", "mcp", "add-json", "--scope", "user", "kagura-memory", JSON.stringify(newEntry)],
    ]);
    expect(fs.existsSync(path.join(sandbox, ".mcp.json"))).toBe(false);
    expect(fs.existsSync(claudeJson())).toBe(false);

    const report = JSON.parse(h.out.join("\n"));
    // The argv holds no secret now, so the command is shown as it ran.
    expect(report.applied_with).toBe(addJsonLine("https://x.test/mcp"));
    expect(report.wrote).toEqual([path.join(sandbox, ".kagura.json")]);
    // .kagura.json keeps the key at both scopes: this bin reads it there.
    expect(readJson(path.join(sandbox, ".kagura.json")).api_key).toBe(KEY);
    expect(report.notes).toEqual([
      "Added kagura-memory at user scope (~/.claude.json)",
      ENV_NOTE,
      "$KAGURA_MCP_API_KEY is not set in this shell.",
    ]);
  });

  it.each([
    [undefined, "$KAGURA_MCP_API_KEY is not set in this shell."],
    ["", "$KAGURA_MCP_API_KEY is not set in this shell."],
    [KEY, "$KAGURA_MCP_API_KEY is already set to this key in this shell."],
    [
      "kagura_other_key",
      "Warning: $KAGURA_MCP_API_KEY in this shell holds a different key, which Claude Code " +
        "started from here would send.",
    ],
  ])("says whether this shell has the variable (KAGURA_MCP_API_KEY=%j), never printing it", async (value, line) => {
    if (value !== undefined) process.env.KAGURA_MCP_API_KEY = value;
    const h = harness({}, onClaude);
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(0);
    const notes = notesOf(h);
    // Exactly one of the three lines, right after the note it qualifies.
    expect(notes.slice(1, 3)).toEqual([ENV_NOTE, line]);
    expect(notes.filter((n) => n.includes("in this shell"))).toHaveLength(1);
    const output = [...h.out, ...h.err].join("\n");
    expect(output).not.toContain(KEY);
    expect(output).not.toContain("kagura_other_key");
  });

  it("says nothing of the variable at project scope, where the key is in .mcp.json", async () => {
    const h = harness({}, onClaude);
    expect(await runCli(claude(), h.deps)).toBe(0);
    expect(readJson(path.join(sandbox, ".mcp.json")).mcpServers["kagura-memory"].headers).toEqual({
      Authorization: `Bearer ${KEY}`,
    });
    expect([...h.out, ...h.err].join("\n")).not.toContain("KAGURA_MCP_API_KEY");
  });

  it("gives every `claude` run Python's 30 s timeout", async () => {
    seedClaudeJson({ mcpServers: { "kagura-memory": oldEntry } });
    const h = harness({}, onClaude);
    expect(await runCli(claude("--scope", "user"), h.deps)).toBe(0);
    // The plugin is looked for once the entry is known to land, as in Python.
    expect(h.runs.map((r) => r.slice(1, 3))).toEqual([
      ["plugin", "list"],
      ["mcp", "remove"],
      ["mcp", "add-json"],
    ]);
    expect(h.timeouts).toEqual([30_000, 30_000, 30_000]);
  });

  it("never writes ~/.claude.json, even when it already holds a user entry", async () => {
    const before = seedClaudeJson({ mcpServers: { "kagura-memory": oldEntry } });
    const h = harness({}, onClaude);
    expect(await runCli(claude("--scope", "user"), h.deps)).toBe(0);
    expect(fs.readFileSync(claudeJson(), "utf-8")).toBe(before);
    // Same scope: replaced wholesale through the CLI, as the .mcp.json
    // entry is, so a stale key cannot keep authenticating.
    expect(mcpRuns(h).map((r) => r.slice(1, 3))).toEqual([
      ["mcp", "remove"],
      ["mcp", "add-json"],
    ]);
    expect(mcpRuns(h)[0]).toEqual(["/usr/bin/claude", "mcp", "remove", "--scope", "user", "kagura-memory"]);
    expect(notesOf(h)[0]).toBe("Replaced the existing user-scope kagura-memory entry (~/.claude.json)");
  });

  it("replaces an entry with a baked key by the variable form, the old key on no command line", async () => {
    // The interop case: an entry this bin (before #55) or Python (before
    // #258) wrote reads as different, and is replaced by the reference.
    seedClaudeJson({ mcpServers: { "kagura-memory": bakedEntry } });
    const h = harness({}, onClaude);
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(0);
    expect(mcpRuns(h).map((r) => r[2])).toEqual(["remove", "add-json"]);
    expect(JSON.parse(mcpRuns(h)[1]![6]!)).toEqual(newEntry);
    expect(h.runs.flat().join(" ")).not.toContain(OLD_KEY);
  });

  it("leaves an identical user-scope entry alone, and needs no claude for it", async () => {
    // Key order and an empty value (`claude mcp add` stores "env": {}) do
    // not make an entry different, as in Python's same_mcp_entry — so the
    // entry either CLI writes reads as up to date to the other.
    const before = seedClaudeJson({
      mcpServers: { "kagura-memory": { env: {}, headers: newEntry.headers, url: newEntry.url, type: "http" } },
    });
    const h = harness({});
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(0);
    expect(h.runs).toEqual([]);
    expect(fs.readFileSync(claudeJson(), "utf-8")).toBe(before);
    const report = JSON.parse(h.out.join("\n"));
    expect(report.notes).toEqual([
      "User-scope kagura-memory entry already up to date (~/.claude.json)",
      ENV_NOTE,
      "$KAGURA_MCP_API_KEY is not set in this shell.",
    ]);
    expect(report.applied_with).toBeNull();
    expect(report.wrote).toEqual([path.join(sandbox, ".kagura.json")]);
  });

  it("puts the removed user-scope entry back when add-json then fails", async () => {
    seedClaudeJson({ mcpServers: { "kagura-memory": oldEntry } });
    let adds = 0;
    const h = harness(
      {},
      {
        onPath: { claude: "/usr/bin/claude" },
        // The new entry fails and the restore succeeds; both echo their argv.
        exec: (_file, argv) =>
          argv[1] === "add-json" && ++adds === 1
            ? { code: 1, stdout: "", stderr: `Invalid config: ${argv[5]}` }
            : { code: 0, stdout: "", stderr: argv.join(" ") },
      },
    );
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(1);
    expect(mcpRuns(h).map((r) => r[2])).toEqual(["remove", "add-json", "add-json"]);
    expect(JSON.parse(mcpRuns(h)[2]![6]!)).toEqual(oldEntry);
    const err = h.err.join("\n");
    expect(err).toMatch(/add-json.*failed \(exit 1\)/);
    expect(err).toContain("The previous user-scope 'kagura-memory' entry was put back.");
    expect(err).not.toContain("could not be restored");
    expect(err).not.toContain(KEY);
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
  });

  it("says the old user-scope entry is gone when the restore fails too, and prints how to re-add it", async () => {
    seedClaudeJson({ mcpServers: { "kagura-memory": oldEntry } });
    const errors = ["new entry rejected", "Invalid configuration"];
    const h = harness(
      {},
      {
        onPath: { claude: "/usr/bin/claude" },
        exec: (_file, argv) =>
          argv[1] === "add-json" ? { code: 1, stdout: "", stderr: errors.shift()! } : { code: 0, stdout: "", stderr: "" },
      },
    );
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(1);
    expect(mcpRuns(h).map((r) => r[2])).toEqual(["remove", "add-json", "add-json"]);
    // Python's lines; the old entry holds no key, so it is printed as it was.
    expect(h.err.slice(0, 2)).toEqual([
      "  Re-add the previous user-scope kagura-memory entry yourself:",
      `    claude mcp add-json --scope user kagura-memory '${JSON.stringify(oldEntry)}'`,
    ]);
    const err = h.err.join("\n");
    // The first error is kept; the restore's is named in the reason.
    expect(err).toMatch(/^Error: `claude mcp add-json .*` failed \(exit 1\):\n {2}new entry rejected\n/m);
    expect(err).toContain("The previous user-scope kagura-memory entry was removed and could not be restored (");
    expect(err).toContain("Invalid configuration");
    expect(err).toContain("); the command above re-adds it.");
    expect(err).not.toContain(KEY);
  });

  it("never puts back an entry that holds a key: it prints the re-add command, key masked", async () => {
    // Restoring it would pass the old key on claude's command line, where
    // every local user can read it in the process list.
    seedClaudeJson({ mcpServers: { "kagura-memory": bakedEntry } });
    const h = harness(
      {},
      {
        onPath: { claude: "/usr/bin/claude" },
        exec: (_file, argv) =>
          argv[1] === "add-json"
            ? { code: 1, stdout: "", stderr: "new entry rejected" }
            : { code: 0, stdout: "", stderr: "" },
      },
    );
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(1);
    // No restore was run.
    expect(mcpRuns(h).map((r) => r[2])).toEqual(["remove", "add-json"]);
    expect(h.runs.flat().join(" ")).not.toContain(OLD_KEY);
    expect(h.err.slice(0, 2)).toEqual([
      "  Re-add the previous user-scope kagura-memory entry yourself:",
      "    claude mcp add-json --scope user kagura-memory " +
        `'{"type":"http","url":"https://old","headers":{"Authorization":"Bearer <your-api-key>"}}'`,
    ]);
    const err = h.err.join("\n");
    expect(err).toContain(
      "could not be restored (the entry holds an API key, which setup never passes on a command line); " +
        "the command above re-adds it.",
    );
    expect(err).not.toContain(OLD_KEY);
    expect(err).not.toContain(KEY);
  });

  it("--scope user without claude on PATH prints the command to run, then fails as Python does", async () => {
    const h = harness({});
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(1);
    // The command names the variable, not the key, and the note says where
    // to set it; which this shell has does not matter to a pasted command.
    expect(h.err.slice(0, 6)).toEqual([
      "  Add the user-scope entry yourself, then re-run this setup:",
      `    ${addJsonLine("https://x.test/mcp")}`,
      ...ENV_NOTE_LINES,
    ]);
    const err = h.err.join("\n");
    expect(err).toContain(
      "Error: The Claude Code CLI (`claude`) was not found on PATH (a Windows .cmd shim is not run: " +
        "it needs a shell). A user-scope entry lives in ~/.claude.json, which Claude Code owns, so " +
        "setup writes it only through `claude mcp add-json`. Nothing was written.",
    );
    expect(err).not.toMatch(/in this shell/);
    expect(err).not.toContain(KEY);
    expect(h.runs).toEqual([]);
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
  });

  it("without claude, prints the remove before the add when an entry is replaced", async () => {
    seedClaudeJson({ mcpServers: { "kagura-memory": bakedEntry } });
    const h = harness({});
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(1);
    expect(h.err.slice(0, 3)).toEqual([
      "  Add the user-scope entry yourself, then re-run this setup:",
      "    claude mcp remove --scope user kagura-memory",
      `    ${addJsonLine("https://x.test/mcp")}`,
    ]);
    expect(h.err.join("\n")).not.toContain(OLD_KEY);
  });

  it("the printed command keeps the variable for Claude Code to expand, whatever the URL holds", async () => {
    // Single-quoted whole, so the shell expands nothing: add-json stores
    // `${KAGURA_MCP_API_KEY}` as written, and Claude Code expands it from
    // its own environment each time it connects.
    const h = harness({});
    await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp?a=1&b=2"), h.deps);
    expect(h.err.join("\n")).toContain(addJsonLine("https://x.test/mcp?a=1&b=2"));
    expect(h.err.join("\n")).not.toContain("$KAGURA_API_KEY");
  });

  it("reports a failing add-json with its output, a key in it redacted", async () => {
    const h = harness(
      {},
      {
        onPath: { claude: "/usr/bin/claude" },
        exec: (_file, argv) =>
          argv[1] === "add-json"
            ? { code: 1, stdout: "", stderr: `Invalid config: ${argv[5]} (${KEY})` }
            : { code: 0, stdout: "", stderr: "" },
      },
    );
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(1);
    const err = h.err.join("\n");
    expect(err).toMatch(/add-json.*failed \(exit 1\)/);
    // The entry it echoes names the variable; the key it could only have
    // found elsewhere is still cut out.
    expect(err).toContain(`Bearer ${REF}`);
    expect(err).toContain("(<redacted>)");
    expect(err).not.toContain(KEY);
  });

  it.each([
    ["--api-key", KEY],
    ["the project's api_key, which --api-key replaces", "kagura_PROJECT_bbbb2222"],
    ["$KAGURA_API_KEY", "kagura_ENV_cccc3333"],
    ["$KAGURA_MCP_API_KEY, which the entry sends", "kagura_MCPENV_dddd4444"],
  ])("masks %s in a failing claude's output", async (_source, key) => {
    fs.writeFileSync(path.join(sandbox, ".kagura.json"), JSON.stringify({ api_key: "kagura_PROJECT_bbbb2222" }));
    process.env.KAGURA_API_KEY = "kagura_ENV_cccc3333";
    process.env.KAGURA_MCP_API_KEY = "kagura_MCPENV_dddd4444";
    const h = harness(
      {},
      {
        onPath: { claude: "/usr/bin/claude" },
        exec: (_file, argv) =>
          argv[1] === "add-json" ? { code: 1, stdout: "", stderr: `env: ${key}` } : { code: 0, stdout: "", stderr: "" },
      },
    );
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("env: <redacted>");
    expect(h.err.join("\n")).not.toContain(key);
  });

  describe("the key never reaches claude's argv or any output", () => {
    // Python's sentinel test (test_setup_claude_scope.py): a failing claude
    // quotes its whole argv back, as a CLI error might.
    const SENTINEL = "kagura_SENTINEL_never_on_argv_5d0c9e";
    const baked = { ...newEntry, headers: { Authorization: `Bearer ${SENTINEL}` } };

    it.each([
      ["add", null, 0],
      ["add-fails", null, 1],
      ["replace-baked", baked, 0],
      ["restore-baked", baked, 1],
      ["unchanged", newEntry, 0],
      ["no-claude", null, 1],
      ["env-set", null, 0],
    ] as const)("%s", async (scenario, existing, code) => {
      if (existing !== null) seedClaudeJson({ mcpServers: { "kagura-memory": existing } });
      if (scenario === "env-set") process.env.KAGURA_MCP_API_KEY = SENTINEL;
      const options: unknown[] = [];
      const h = harness(
        {},
        {
          onPath: scenario === "no-claude" ? {} : { claude: "/usr/bin/claude" },
          exec: (_file, argv) =>
            argv[1] === "add-json" && (scenario === "add-fails" || scenario === "restore-baked")
              ? { code: 1, stdout: "", stderr: `rejected: ${argv.join(" ")}` }
              : { code: 0, stdout: "[]", stderr: "" },
        },
      );
      const exec = h.deps.execFile;
      h.deps.execFile = async (file, argv, opts) => {
        options.push(opts);
        return exec(file, argv, opts);
      };
      const args = ["setup", "claude", "--api-key", SENTINEL, "--mcp-url", "https://x.test/mcp"];
      expect(await runCli([...args, "--project-dir", sandbox, "-c", CONTEXT, "--scope", "user"], h.deps)).toBe(code);

      expect([...h.out, ...h.err].join("\n")).not.toContain(SENTINEL);
      for (const run of h.runs) expect(run.join(" ")).not.toContain(SENTINEL);
      expect(JSON.stringify(options)).not.toContain(SENTINEL);
      const adds = mcpRuns(h).filter((r) => r[2] === "add-json").map((r) => JSON.parse(r[6]!));
      if (["add", "replace-baked", "env-set"].includes(scenario)) expect(adds).toEqual([newEntry]);
      if (scenario === "unchanged") expect(adds).toEqual([]);
    });
  });

  it("stops when local scope already defines kagura-memory, in Python's words", async () => {
    // Local outranks project: the new .mcp.json entry would never be used,
    // though the command would have reported success.
    seedClaudeJson({ projects: { [realSandbox()]: { mcpServers: { "kagura-memory": { type: "http" } } } } });
    // Run in the project: the remove command needs no `cd` there.
    process.chdir(sandbox);
    const h = harness({});
    expect(await runCli(claude(), h.deps)).toBe(1);
    expect(h.err).toEqual([
      "  Warning: Claude Code uses the kagura-memory entry from the strongest scope,",
      "  so in this project a project-scope entry would be hidden by:",
      "    local scope (~/.claude.json) — remove it with:",
      "      claude mcp remove --scope local kagura-memory",
      "Error: Nothing was written: the local-scope kagura-memory entry would hide the project-scope one. " +
        "Remove it (command above) and re-run.",
    ]);
    expect(fs.existsSync(path.join(sandbox, ".mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
  });

  it("prints the remove command with a cd into --project-dir when that is not the current directory", async () => {
    // `claude mcp remove --scope local|project` acts on the directory it
    // runs in, so pasted as it is, it would miss this project's entry.
    const project = path.join(sandbox, "my project");
    fs.mkdirSync(path.join(project, ".git"), { recursive: true }); // its own root
    seedClaudeJson({ projects: { [fs.realpathSync(project)]: { mcpServers: { "kagura-memory": {} } } } });
    fs.writeFileSync(
      path.join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { "kagura-memory": { type: "http", url: "https://x" } } }),
    );
    const args = ["setup", "claude", "--api-key", KEY, "--project-dir", project, "--scope", "user"];
    const cd = `cd '${fs.realpathSync(project)}' && `;

    process.chdir(sandbox);
    const elsewhere = harness({}, onClaude);
    expect(await runCli(args, elsewhere.deps)).toBe(1);
    expect(elsewhere.err).toContain(`      ${cd}claude mcp remove --scope local kagura-memory`);
    expect(elsewhere.err).toContain(`      ${cd}claude mcp remove --scope project kagura-memory`);

    process.chdir(project);
    const inProject = harness({}, onClaude);
    expect(await runCli(args, inProject.deps)).toBe(1);
    expect(inProject.err).toContain("      claude mcp remove --scope local kagura-memory");
    expect(inProject.err).toContain("      claude mcp remove --scope project kagura-memory");
  });

  describe("local scope, keyed as Claude Code keys it", () => {
    /** A local-scope kagura-memory entry filed under `dir`. */
    const localEntryAt = (dir: string) =>
      seedClaudeJson({ projects: { [fs.realpathSync(dir)]: { mcpServers: { "kagura-memory": { type: "http" } } } } });

    it("is found at the git root from a subdirectory", async () => {
      fs.mkdirSync(path.join(sandbox, ".git"), { recursive: true });
      const sub = path.join(sandbox, "pkg", "sub");
      fs.mkdirSync(sub, { recursive: true });
      localEntryAt(sandbox);
      const h = harness({});
      expect(await runCli(["setup", "claude", "--api-key", KEY, "--project-dir", sub], h.deps)).toBe(1);
      expect(h.err.join("\n")).toContain("    local scope (~/.claude.json) — remove it with:");
      expect(fs.existsSync(path.join(sub, ".mcp.json"))).toBe(false);
      expect(fs.existsSync(path.join(sub, ".kagura.json"))).toBe(false);
    });

    it("ignores a subdirectory's own key inside a repository", async () => {
      // Claude Code never files an entry there, so it hides nothing.
      fs.mkdirSync(path.join(sandbox, ".git"), { recursive: true });
      const sub = path.join(sandbox, "pkg");
      fs.mkdirSync(sub);
      localEntryAt(sub);
      const h = harness({});
      expect(await runCli(["setup", "claude", "--api-key", KEY, "--project-dir", sub], h.deps)).toBe(0);
    });

    it("of a linked worktree is found under the main working tree", async () => {
      // The worktree's .git file names its git dir, whose commondir leads
      // to the main repository's .git.
      const main = path.join(sandbox, "main");
      const gitDir = path.join(main, ".git", "worktrees", "wt");
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
      const worktree = path.join(sandbox, "wt");
      fs.mkdirSync(path.join(worktree, "deep"), { recursive: true });
      fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
      localEntryAt(main);
      const h = harness({});
      expect(
        await runCli(["setup", "claude", "--api-key", KEY, "--project-dir", path.join(worktree, "deep")], h.deps),
      ).toBe(1);
      expect(h.err.join("\n")).toContain("local scope (~/.claude.json)");
    });

    it("of a submodule, whose git dir has no commondir, is its own directory", async () => {
      const module = path.join(sandbox, "super", "mod");
      fs.mkdirSync(module, { recursive: true });
      fs.writeFileSync(path.join(module, ".git"), "gitdir: ../.git/modules/mod\n");
      localEntryAt(module);
      const h = harness({});
      expect(await runCli(["setup", "claude", "--api-key", KEY, "--project-dir", module], h.deps)).toBe(1);
    });
  });

  describe("project scope from a parent directory's .mcp.json", () => {
    // Claude Code reads .mcp.json in every directory up to the filesystem
    // root, and the closest file that defines the server wins.
    const parentEntry = {
      type: "http",
      url: "https://x.test/mcp?guardrails=off",
      headers: { Authorization: "Bearer p" },
    };
    /** `setup claude` for `dir`, plus `extra`. */
    const claudeIn = (dir: string, ...extra: string[]) =>
      ["setup", "claude", "--api-key", KEY, "--project-dir", dir, ...extra];

    function writeParent(dir: string): string {
      const file = path.join(dir, ".mcp.json");
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { "kagura-memory": parentEntry } }));
      return file;
    }

    it("stops --scope user, and the remove command runs where that file is", async () => {
      const repo = path.join(sandbox, "my repo");
      const sub = path.join(repo, "pkg");
      fs.mkdirSync(sub, { recursive: true });
      const mcpJson = writeParent(repo);
      const before = fs.readFileSync(mcpJson, "utf-8");
      const h = harness({}, onClaude);
      expect(await runCli(claudeIn(sub, "--scope", "user"), h.deps)).toBe(1);
      const realRepo = fs.realpathSync(repo);
      expect(h.err).toContain(`    project scope (${path.join(realRepo, ".mcp.json")}) — remove it with:`);
      expect(h.err).toContain(`      cd '${realRepo}' && claude mcp remove --scope project kagura-memory`);
      expect(mcpRuns(h)).toEqual([]);
      expect(fs.readFileSync(mcpJson, "utf-8")).toBe(before);
    });

    it("is hidden, not replaced, by a project-scope write below it", async () => {
      const sub = path.join(sandbox, "pkg");
      fs.mkdirSync(sub);
      const mcpJson = writeParent(sandbox);
      const before = fs.readFileSync(mcpJson, "utf-8");
      const h = harness({});
      expect(await runCli(claudeIn(sub), h.deps)).toBe(0);
      expect(readJson(path.join(sub, ".mcp.json")).mcpServers["kagura-memory"].url).toBe(DEFAULT_MCP_URL);
      expect(fs.readFileSync(mcpJson, "utf-8")).toBe(before);
      const notes: string[] = JSON.parse(h.out.join("\n")).notes;
      expect(notes).toContain(
        "Note: in this project it hides the kagura-memory entry in project scope " +
          `(${path.join(realSandbox(), ".mcp.json")}); editing that entry has no effect here.`,
      );
      // Nothing of the parent's entry was replaced, so nothing was dropped.
      expect(notes.join("\n")).not.toMatch(/left out/);
    });

    it("is skipped when it does not define kagura-memory, and the walk goes on", async () => {
      const a = path.join(sandbox, "a");
      const b = path.join(a, "b");
      fs.mkdirSync(b, { recursive: true });
      writeParent(sandbox);
      fs.writeFileSync(path.join(a, ".mcp.json"), JSON.stringify({ mcpServers: { github: {} } }));
      const h = harness({}, onClaude);
      expect(await runCli(claudeIn(b, "--scope", "user"), h.deps)).toBe(1);
      expect(h.err.join("\n")).toContain(`project scope (${path.join(realSandbox(), ".mcp.json")})`);
    });
  });

  it("for --scope user, lists every stronger entry and names the strongest", async () => {
    seedClaudeJson({ projects: { [realSandbox()]: { mcpServers: { "kagura-memory": {} } } } });
    fs.writeFileSync(
      path.join(sandbox, ".mcp.json"),
      JSON.stringify({ mcpServers: { "kagura-memory": { type: "http", url: "https://x" } } }),
    );
    // Run in the project: the remove commands need no `cd` there.
    process.chdir(sandbox);
    const h = harness({}, onClaude);
    expect(await runCli(claude("--scope", "user"), h.deps)).toBe(1);
    const err = h.err.join("\n");
    expect(err).toContain("    local scope (~/.claude.json) — remove it with:");
    expect(err).toContain("    project scope (.mcp.json) — remove it with:");
    expect(err).toContain("      claude mcp remove --scope project kagura-memory");
    expect(err).toContain("Error: Nothing was written: the local-scope kagura-memory entry would hide the user-scope one.");
    expect(h.runs).toEqual([]);
  });

  it("writes over a weaker user-scope entry and notes that it hides it", async () => {
    seedClaudeJson({ mcpServers: { "kagura-memory": { type: "http", url: "https://old" } } });
    const h = harness({});
    expect(await runCli(claude(), h.deps)).toBe(0);
    expect(fs.existsSync(path.join(sandbox, ".mcp.json"))).toBe(true);
    const notes: string[] = JSON.parse(h.out.join("\n")).notes;
    expect(notes).toContain(
      "Note: in this project it hides the kagura-memory entry in user scope (~/.claude.json); " +
        "editing that entry has no effect here.",
    );
  });

  it("reads .claude.json from $CLAUDE_CONFIG_DIR when that is set", async () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(sandbox, "claude-config");
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
    fs.writeFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"),
      JSON.stringify({ projects: { [realSandbox()]: { mcpServers: { "kagura-memory": {} } } } }),
    );
    const h = harness({});
    expect(await runCli(claude(), h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("claude mcp remove --scope local kagura-memory");
  });

  describe("names the .claude.json it read, as Python's claude_json_label does", () => {
    const cases = [
      ["under the home directory", () => path.join(process.env.HOME!, "cfg"), () => "~/cfg/.claude.json"],
      // Not under HOME (the sandbox's own home), so the full path.
      ["elsewhere", () => path.join(sandbox, "claude-config"), () => path.join(sandbox, "claude-config", ".claude.json")],
    ] as const;

    it.each(cases)("in setup's notes and errors, $CLAUDE_CONFIG_DIR %s", async (_where, dir, label) => {
      process.env.CLAUDE_CONFIG_DIR = dir();
      fs.mkdirSync(dir(), { recursive: true });

      const added = harness({}, onClaude);
      expect(await runCli(claude("--scope", "user"), added.deps)).toBe(0);
      expect(notesOf(added)[0]).toBe(`Added kagura-memory at user scope (${label()})`);

      const missing = harness({});
      fs.writeFileSync(
        path.join(dir(), ".claude.json"),
        JSON.stringify({ mcpServers: { "kagura-memory": bakedEntry } }),
      );
      expect(await runCli(claude("--scope", "user"), missing.deps)).toBe(1);
      expect(missing.err.join("\n")).toContain(`A user-scope entry lives in ${label()}, which Claude Code owns`);

      fs.writeFileSync(
        path.join(dir(), ".claude.json"),
        JSON.stringify({ mcpServers: { "kagura-memory": { ...newEntry, url: DEFAULT_MCP_URL } } }),
      );
      const unchanged = harness({});
      expect(await runCli(claude("--scope", "user"), unchanged.deps)).toBe(0);
      expect(notesOf(unchanged)[0]).toBe(`User-scope kagura-memory entry already up to date (${label()})`);

      const shadowed = harness({});
      fs.writeFileSync(
        path.join(dir(), ".claude.json"),
        JSON.stringify({ projects: { [realSandbox()]: { mcpServers: { "kagura-memory": {} } } } }),
      );
      expect(await runCli(claude(), shadowed.deps)).toBe(1);
      expect(shadowed.err).toContain(`    local scope (${label()}) — remove it with:`);
    });

    it.each(cases)("in doctor's report, $CLAUDE_CONFIG_DIR %s", async (_where, dir, label) => {
      process.env.CLAUDE_CONFIG_DIR = dir();
      fs.mkdirSync(dir(), { recursive: true });
      process.chdir(sandbox);

      const none = harness();
      await runCli(["doctor"], none.deps);
      expect(none.out).toContain(`INFO No kagura-memory MCP entry found (.mcp.json, ${label()})`);

      fs.writeFileSync(
        path.join(dir(), ".claude.json"),
        JSON.stringify({ mcpServers: { "kagura-memory": { type: "http", url: "https://x.test/mcp" } } }),
      );
      const found = harness();
      await runCli(["doctor"], found.deps);
      expect(found.out).toContain(`PASS MCP Mode: url (user scope, ${label()})`);
    });
  });

  it("ignores another project's local entry", async () => {
    seedClaudeJson({ projects: { "/elsewhere": { mcpServers: { "kagura-memory": {} } } } });
    const h = harness({});
    expect(await runCli(claude(), h.deps)).toBe(0);
  });

  it("counts an entry only when it is a JSON object", async () => {
    // Claude Code cannot use anything else, so there is nothing to shadow
    // or replace.
    seedClaudeJson({
      mcpServers: { "kagura-memory": "oops" },
      projects: { [realSandbox()]: { mcpServers: { "kagura-memory": null } } },
    });
    const user = harness({}, onClaude);
    expect(await runCli(claude("--scope", "user"), user.deps)).toBe(0);
    expect(mcpRuns(user).map((r) => r[2])).toEqual(["add-json"]);

    // Run second: the .mcp.json it writes is a stronger scope for the other.
    const project = harness({});
    expect(await runCli(claude(), project.deps)).toBe(0);
  });

  onPosixIt("finds the local-scope block under the project's real path", async () => {
    // Claude Code keys the block by the resolved path; --project-dir may
    // name the project through a symlink.
    const real = path.join(sandbox, "real");
    const link = path.join(sandbox, "link");
    fs.mkdirSync(path.join(real, ".git"), { recursive: true }); // its own root
    fs.symlinkSync(real, link);
    seedClaudeJson({ projects: { [fs.realpathSync(real)]: { mcpServers: { "kagura-memory": {} } } } });
    const h = harness({});
    expect(await runCli(["setup", "claude", "--api-key", KEY, "--project-dir", link], h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("local scope (~/.claude.json)");
  });
});

describe("setup claude re-runs and odd inputs", () => {
  const notes = (h: Harness): string[] => JSON.parse(h.out.join("\n")).notes as string[];
  const mcpJson = () => path.join(sandbox, ".mcp.json");

  it("notes the --guardrails and --tool-profile a re-run leaves out, as Python does", async () => {
    // .kagura.json keeps --mcp-url as given, so a re-run rebuilds the URL
    // from its own flags alone.
    const first = harness({});
    const all = claude("--mcp-url", "https://x.test/mcp", "--guardrails", "off", "--tool-profile", "core");
    expect(await runCli(all, first.deps)).toBe(0);

    const second = harness({});
    expect(await runCli(claude("--mcp-url", "https://x.test/mcp", "--tool-profile", "core"), second.deps)).toBe(0);
    expect(notes(second)).toContain(
      "Note: the previous project-scope entry also had --guardrails off, which this run left out; " +
        "re-run with it to keep it.",
    );

    const third = harness({});
    expect(await runCli(claude("--mcp-url", "https://x.test/mcp"), third.deps)).toBe(0);
    expect(notes(third)).toContain(
      "Note: the previous project-scope entry also had --tool-profile core, which this run left out; " +
        "re-run with it to keep it.",
    );

    const fourth = harness({});
    await runCli(claude("--mcp-url", "https://x.test/mcp"), fourth.deps);
    expect(notes(fourth).join("\n")).not.toMatch(/also had/);
  });

  it("names both dropped flags for a user-scope entry", async () => {
    fs.writeFileSync(
      path.join(process.env.HOME!, ".claude.json"),
      JSON.stringify({
        mcpServers: { "kagura-memory": { type: "http", url: `https://x.test/mcp?guardrails=${CONTEXT}&profile=core` } },
      }),
    );
    const h = harness({}, { onPath: { claude: "/usr/bin/claude" } });
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(0);
    expect(notes(h)).toContain(
      `Note: the previous user-scope entry also had --guardrails ${CONTEXT} and --tool-profile core, ` +
        "which this run left out; re-run with them to keep them.",
    );
  });

  it("reads a dropped flag from the kagura-mcp arguments of a stdio entry, = form included", async () => {
    // What the Python CLI's --profile setup writes.
    fs.writeFileSync(
      mcpJson(),
      JSON.stringify({
        mcpServers: {
          "kagura-memory": { command: "kagura-mcp", args: ["--profile", "default", `--guardrails=${CONTEXT}`] },
        },
      }),
    );
    const h = harness({});
    expect(await runCli(claude(), h.deps)).toBe(0);
    expect(notes(h).join("\n")).toContain(`also had --guardrails ${CONTEXT}, which this run left out`);
  });

  it("warns that a ?tools= allowlist wins over --tool-profile", async () => {
    // memory-cloud applies `tools` before it reads `profile`, so the
    // profile would silently do nothing.
    const h = harness({});
    const withTools = claude("--mcp-url", "https://x.test/mcp?tools=recall", "--tool-profile", "core");
    expect(await runCli(withTools, h.deps)).toBe(0);
    expect(notes(h)).toContain(
      "Warning: the MCP URL has a ?tools= allowlist, which the server applies instead of --tool-profile core.",
    );
    expect(readJson(mcpJson()).mcpServers["kagura-memory"].url).toBe("https://x.test/mcp?tools=recall&profile=core");

    const plain = harness({});
    await runCli(claude("--mcp-url", "https://x.test/mcp?tools=recall"), plain.deps);
    expect(notes(plain).join("\n")).not.toMatch(/allowlist/);
  });

  it.each([
    ["an array", "[]"],
    ["a string", '"x"'],
    ["null", "null"],
  ])("refuses an .mcp.json whose mcpServers is %s, before anything is written or run", async (_label, value) => {
    // Set on an array, the entry would vanish in JSON.stringify and the
    // command report success; on a string it would throw halfway.
    const text = `{"mcpServers":${value}}`;
    fs.writeFileSync(mcpJson(), text);
    const h = harness({}, { onPath: { claude: "/usr/bin/claude" } });
    expect(await runCli(claude(), h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain(`refusing to rewrite ${mcpJson()}: its mcpServers is not a JSON object`);
    expect(fs.readFileSync(mcpJson(), "utf-8")).toBe(text);
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
    expect(h.runs).toEqual([]);
  });
});

describe("setup claude plugin awareness", () => {
  const entryUrl = () => readJson(path.join(sandbox, ".mcp.json")).mcpServers["kagura-memory"].url;
  const notes = (h: Harness): string => (JSON.parse(h.out.join("\n")).notes as string[]).join("\n");

  it("asks `claude plugin list --json` through the injected runner", async () => {
    const h = harness({}, pluginList([]));
    await runCli(claude(), h.deps);
    expect(h.runs).toContainEqual(["/usr/bin/claude", "plugin", "list", "--json"]);
  });

  it("asks in --project-dir, which decides the project- and local-scope plugins listed", async () => {
    // The test process runs elsewhere, so a cwd left unset would answer
    // for the wrong project.
    const h = harness({}, pluginList([]));
    await runCli(claude(), h.deps);
    const i = h.runs.findIndex((r) => r[1] === "plugin");
    expect(h.cwds[i]).toBe(sandbox);
  });

  it("with the plugin enabled, leaves the URL alone and says what to configure", async () => {
    const h = harness(
      {},
      pluginList([
        { id: "other@x", enabled: true },
        { id: "kagura-memory@kagura-plugins", enabled: true, scope: "user" },
      ]),
    );
    const given = `https://x.test/mcp?profile=core&guardrails=${CONTEXT}`;
    expect(await runCli(claude("--mcp-url", given, "-c", CONTEXT), h.deps)).toBe(0);

    // `off` would also remove the get_context_info block, and the plugin's
    // hooks deliver guardrails only once configured — so no default.
    expect(entryUrl()).toBe(given);
    const text = notes(h);
    // Python's wording, one note per paragraph.
    expect(text).toContain(
      "kagura-memory@kagura-plugins delivers tool guardrails through its own hooks once you " +
        "configure them (/kagura-memory:setup).",
    );
    expect(text).toContain(
      "Then re-run this setup with --guardrails off so the server does not also send a guardrail " +
        "digest. 'off' also removes the guardrails block from get_context_info, so set it only once " +
        "the hooks deliver guardrails.",
    );
    const all = JSON.parse(h.out.join("\n")).notes as string[];
    const settingsAt = all.findIndex((n) => n.startsWith("Plugin settings"));
    // The settings, then Python's caveat on the one context and its
    // guidance on the key, each its own note.
    expect(all.slice(settingsAt)).toEqual([
      `Plugin settings (/plugin > kagura-memory > Configure): server_url = https://x.test/mcp, context_id = ${CONTEXT}`,
      "The plugin has ONE guardrail context for every project: use this one only if it holds the " +
        "guardrails you want everywhere.",
      "api_key: enter it yourself, a user API key (kagura_...). The plugin's hooks authenticate only with one.",
    ]);
    expect(text).not.toContain(KEY);
  });

  it("still asks for -c in the plugin settings when no context is known", async () => {
    // Python always resolves one; this bin makes no network call.
    const h = harness({}, pluginList([{ id: "kagura-memory@m", enabled: true }]));
    await runCli(claude(), h.deps);
    expect(notes(h)).toContain("context_id = (none; pass -c)");
  });

  it("keeps guardrails=off in the plugin's server_url and stops recommending it", async () => {
    const h = harness({}, pluginList([{ id: "kagura-memory@m", enabled: true }]));
    await runCli(claude("--mcp-url", "https://x.test/mcp?profile=core", "--guardrails", "off"), h.deps);
    const text = notes(h);
    expect(text).toContain("server_url = https://x.test/mcp?guardrails=off");
    expect(text).not.toMatch(/re-run this setup with --guardrails off/);
  });

  it("stops recommending off when --mcp-url already carries it", async () => {
    // Python looks at the flag alone; the URL's own guardrails=off is just
    // as final.
    const h = harness({}, pluginList([{ id: "kagura-memory@m", enabled: true }]));
    await runCli(claude("--mcp-url", "https://x.test/mcp?guardrails=off"), h.deps);
    expect(notes(h)).not.toMatch(/re-run this setup with --guardrails off/);
  });

  it("recognises the plugin by the name before @, a bare id included", async () => {
    const h = harness({}, pluginList([{ id: "kagura-memory", enabled: true }]));
    await runCli(claude(), h.deps);
    expect(notes(h)).toContain("kagura-memory delivers tool guardrails");
  });

  it.each([
    ["a disabled entry", pluginList([{ id: "kagura-memory@m", enabled: false }])],
    ["a different plugin", pluginList([{ id: "kagura-memory-extras@m", enabled: true }])],
    ["unparseable output", pluginList("Plugins:\n  kagura-memory@m (enabled)")],
    ["a non-array document", pluginList({ id: "kagura-memory@m", enabled: true })],
    ["a failing run", pluginList([{ id: "kagura-memory@m", enabled: true }], 1)],
    ["no claude on PATH", {}],
  ] as const)("treats %s as not detected", async (_label, programs) => {
    const h = harness({}, programs);
    expect(await runCli(claude(), h.deps)).toBe(0);
    expect(notes(h)).not.toMatch(/server_url/);
  });
});

describe("credential files are not world-readable", () => {
  // Windows has no POSIX mode bits — chmod there only toggles the
  // read-only flag — so the assertion is meaningful on POSIX only. CI runs
  // ubuntu-latest, which is where it counts.
  const onPosix = os.platform() === "win32" ? it.skip : it;

  onPosix("setup claude writes .kagura.json and .mcp.json at 0600", async () => {
    // Both files carry the API key. At the common umask they would land at
    // 0644, readable by every other account on a shared build host.
    const h = harness({});
    expect(
      await runCli(["setup", "claude", "--api-key", "kagura_secret", "--project-dir", sandbox], h.deps),
    ).toBe(0);
    for (const name of [".kagura.json", ".mcp.json"]) {
      const mode = fs.statSync(path.join(sandbox, name)).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    }
  });

  onPosix("tightens a file that already existed at 0644", async () => {
    // writeFileSync's `mode` applies only on creation, so an existing file
    // keeps its old permissions unless something else tightens them.
    const target = path.join(sandbox, ".kagura.json");
    fs.writeFileSync(target, "{}", { mode: 0o644 });
    const h = harness({});
    await runCli(["setup", "claude", "--api-key", "k", "--project-dir", sandbox], h.deps);
    expect(fs.statSync(target).mode & 0o077).toBe(0);
  });
});
