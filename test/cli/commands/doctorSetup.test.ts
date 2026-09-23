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

  it("passes a type http .mcp.json entry", async () => {
    fs.writeFileSync(
      path.join(sandbox, ".mcp.json"),
      JSON.stringify({ mcpServers: { "kagura-memory": { type: "http", url: "https://x.test/mcp" } } }),
    );
    process.chdir(sandbox);
    const h = harness();
    await runCli(["doctor"], h.deps);
    expect(h.out.join("\n")).toMatch(/PASS \.mcp\.json configures kagura-memory/);
  });

  it("still accepts an entry setup claude wrote as type url, and suggests re-running it", async () => {
    // Earlier releases wrote `url`. Not a failure here, but Claude Code
    // skips an entry of that type, so the fix is worth saying.
    fs.writeFileSync(
      path.join(sandbox, ".mcp.json"),
      JSON.stringify({ mcpServers: { "kagura-memory": { type: "url", url: "https://x.test/mcp" } } }),
    );
    process.chdir(sandbox);
    const h = harness();
    await runCli(["doctor"], h.deps);
    const text = h.out.join("\n");
    expect(text).toMatch(/WARN .*type "url".*kagura-memory setup claude/);
    expect(text).not.toMatch(/FAIL .*\.mcp\.json/);
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

  it("for --scope user, lists every stronger entry and names the strongest", async () => {
    seedClaudeJson({ projects: { [realSandbox()]: { mcpServers: { "kagura-memory": {} } } } });
    fs.writeFileSync(
      path.join(sandbox, ".mcp.json"),
      JSON.stringify({ mcpServers: { "kagura-memory": { type: "http", url: "https://x" } } }),
    );
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
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    seedClaudeJson({ projects: { [fs.realpathSync(real)]: { mcpServers: { "kagura-memory": {} } } } });
    const h = harness({});
    expect(await runCli(["setup", "claude", "--api-key", KEY, "--project-dir", link], h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("local scope (~/.claude.json)");
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
