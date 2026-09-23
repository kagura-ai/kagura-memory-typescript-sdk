import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_MCP_URL } from "../../../src/auth/resolve.js";
import type { ExecOptions, ExecResult } from "../../../src/cli/exec.js";
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
    // setup falls back to it for the key; the developer's own must not leak in.
    "KAGURA_API_KEY",
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
    async function mcpChecks(dir = sandbox): Promise<{ status: string; message: string; details?: unknown }[]> {
      process.chdir(dir);
      const h = harness();
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

    it("warns once for each entry the one in use hides", async () => {
      writeClaudeJson({
        mcpServers: { "kagura-memory": BEARER },
        projects: { [fs.realpathSync(sandbox)]: { mcpServers: { "kagura-memory": BEARER } } },
      });
      writeMcpJson({ "kagura-memory": BEARER });
      const checks = await mcpChecks();
      expect(checks.map((c) => `${c.status} ${c.message}`)).toEqual([
        "pass MCP Mode: static-token (local scope, ~/.claude.json)",
        "warn kagura-memory is also defined in project scope (.mcp.json), but Claude Code uses the local-scope entry here",
        "warn kagura-memory is also defined in user scope (~/.claude.json), but Claude Code uses the local-scope entry here",
      ]);
      expect(checks[2]!.details).toEqual({ scope: "user", source: "~/.claude.json" });
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

  it("falls back to the configured mcp_url, then to DEFAULT_MCP_URL", async () => {
    const configured = harness({ mcp_url: "https://self.example/mcp" });
    await runCli(claude(), configured.deps);
    expect(readJson(path.join(sandbox, ".mcp.json")).mcpServers["kagura-memory"].url).toBe(
      "https://self.example/mcp",
    );

    const bare = harness({});
    await runCli(claude(), bare.deps);
    expect(readJson(path.join(sandbox, ".mcp.json")).mcpServers["kagura-memory"].url).toBe(DEFAULT_MCP_URL);
  });

  it("rejects an unknown --scope with exit 2", async () => {
    const h = harness({});
    expect(await runCli(claude("--scope", "local"), h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/Invalid value for '--scope'/);
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
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
  /** The user-scope entry setup writes for `https://x.test/mcp`. */
  const newEntry = { type: "http", url: "https://x.test/mcp", headers: { Authorization: `Bearer ${KEY}` } };
  const OLD_KEY = "kagura_old_key_9876543210";
  const oldEntry = { type: "http", url: "https://old", headers: { Authorization: `Bearer ${OLD_KEY}` } };
  /** What the add-json command looks like printed, the key left to the shell. */
  const addJsonLine = (url: string) =>
    `claude mcp add-json --scope user kagura-memory '{"type":"http","url":"${url}","headers":{"Authorization":"Bearer '"$KAGURA_API_KEY"'"}}'`;

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
    expect(report.applied_with).toBe(addJsonLine("https://x.test/mcp"));
    expect(report.wrote).toEqual([path.join(sandbox, ".kagura.json")]);
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
  });

  it("leaves an identical user-scope entry alone, and needs no claude for it", async () => {
    // Key order and an empty value (`claude mcp add` stores "env": {}) do
    // not make an entry different, as in Python's same_mcp_entry.
    const before = seedClaudeJson({
      mcpServers: { "kagura-memory": { env: {}, headers: newEntry.headers, url: newEntry.url, type: "http" } },
    });
    const h = harness({});
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(0);
    expect(h.runs).toEqual([]);
    expect(fs.readFileSync(claudeJson(), "utf-8")).toBe(before);
    const report = JSON.parse(h.out.join("\n"));
    expect(report.notes).toContain("User-scope kagura-memory entry already up to date (~/.claude.json)");
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
    expect(err).not.toContain(KEY);
    expect(err).not.toContain(OLD_KEY);
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
  });

  it("says the old user-scope entry is gone when the restore fails too, and how to add the new one", async () => {
    seedClaudeJson({ mcpServers: { "kagura-memory": oldEntry } });
    const h = harness(
      {},
      {
        onPath: { claude: "/usr/bin/claude" },
        exec: (_file, argv) =>
          argv[1] === "add-json"
            ? { code: 1, stdout: "", stderr: `Invalid config: ${argv[5]}` }
            : { code: 0, stdout: "", stderr: "" },
      },
    );
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(1);
    expect(mcpRuns(h).map((r) => r[2])).toEqual(["remove", "add-json", "add-json"]);
    const err = h.err.join("\n");
    expect(err).toMatch(/add-json.*failed \(exit 1\)/);
    expect(err).toMatch(/previous user-scope 'kagura-memory' entry was removed/);
    expect(err).toContain(addJsonLine("https://x.test/mcp"));
    expect(err).not.toContain(KEY);
    expect(err).not.toContain(OLD_KEY);
  });

  it("--scope user without claude on PATH prints the command to run, then fails as Python does", async () => {
    const h = harness({});
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(1);
    expect(h.err.slice(0, 2)).toEqual([
      "  Add the user-scope entry yourself, then re-run this setup:",
      `    ${addJsonLine("https://x.test/mcp")}`,
    ]);
    const err = h.err.join("\n");
    expect(err).toContain(
      "Error: The Claude Code CLI (`claude`) was not found on PATH (a Windows .cmd shim is not run: " +
        "it needs a shell). A user-scope entry lives in ~/.claude.json, which Claude Code owns, so " +
        "setup writes it only through `claude mcp add-json`. Nothing was written.",
    );
    expect(err).not.toContain(KEY);
    expect(h.runs).toEqual([]);
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
  });

  it("without claude, prints the remove before the add when an entry is replaced", async () => {
    seedClaudeJson({ mcpServers: { "kagura-memory": oldEntry } });
    const h = harness({});
    expect(await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp"), h.deps)).toBe(1);
    expect(h.err.slice(0, 3)).toEqual([
      "  Add the user-scope entry yourself, then re-run this setup:",
      "    claude mcp remove --scope user kagura-memory",
      `    ${addJsonLine("https://x.test/mcp")}`,
    ]);
    expect(h.err.join("\n")).not.toContain(OLD_KEY);
  });

  it("the printed command is a working shell command", async () => {
    // Splicing "$KAGURA_API_KEY" between two single-quoted halves is the
    // one POSIX spelling that expands the variable and nothing else.
    const h = harness({});
    await runCli(claude("--scope", "user", "--mcp-url", "https://x.test/mcp?a=1&b=2"), h.deps);
    expect(h.err.join("\n")).toContain(addJsonLine("https://x.test/mcp?a=1&b=2"));
  });

  it("reports a failing add-json with its output, key redacted", async () => {
    const h = harness(
      {},
      {
        onPath: { claude: "/usr/bin/claude" },
        exec: (_file, argv) =>
          argv[1] === "add-json"
            ? { code: 1, stdout: "", stderr: `Invalid config: ${argv[5]}` }
            : { code: 0, stdout: "", stderr: "" },
      },
    );
    expect(await runCli(claude("--scope", "user"), h.deps)).toBe(1);
    const err = h.err.join("\n");
    expect(err).toMatch(/add-json.*failed \(exit 1\)/);
    expect(err).toContain("<redacted>");
    expect(err).not.toContain(KEY);
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
    expect(text).toContain("Plugin settings (/plugin > kagura-memory > Configure; the API key is yours):");
    expect(text).toContain("server_url = https://x.test/mcp");
    expect(text).not.toContain("server_url = https://x.test/mcp?");
    expect(text).toContain(`context_id = ${CONTEXT}`);
    expect(text).not.toContain(KEY);
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
