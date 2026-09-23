/**
 * `setup codex | hermes | openclaw`.
 *
 * No process is spawned and no real PATH is read: `which` and `execFile`
 * are the injected fakes below, and HOME plus each harness's home variable
 * point into a per-test sandbox.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecResult } from "../../../src/cli/exec.js";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { loadConfig, type KaguraConfig } from "../../../src/config.js";

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  /** Every program `execFile` was asked to run, as `[file, ...argv]`. */
  runs: string[][];
}

interface Programs {
  /** Program name → the path `which` reports; absent means not on PATH. */
  onPath?: Record<string, string>;
  /** What a run returns; defaults to a silent exit 0. */
  exec?: (file: string, argv: readonly string[]) => ExecResult;
}

/**
 * `config` stands in for what `loadConfig` returns; "disk" runs the real
 * loader, which reads ./.kagura.json, then ~/.kagura.json, and only when
 * neither exists the KAGURA_* variables.
 */
function harness(programs: Programs = {}, config: KaguraConfig | "disk" = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const runs: string[][] = [];
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => true,
    which: (name: string) => programs.onPath?.[name] ?? null,
    execFile: async (file: string, argv: readonly string[]) => {
      runs.push([file, ...argv]);
      return programs.exec?.(file, argv) ?? { code: 0, stdout: "", stderr: "" };
    },
    loadConfig: () => (config === "disk" ? loadConfig() : config),
  } as unknown as CliDeps;
  return { deps, out, err, runs };
}

const KEY = "kagura_secret_0123456789";
const CONTEXT = "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c";
const MCP_URL = "https://x.test/mcp";

let sandbox: string;
let home: string;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-setup-"));
  home = path.join(sandbox, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // KAGURA_API_KEY too: setup falls back to it for the key, so the
  // developer's own must not stand in for a missing one.
  for (const name of [
    "CODEX_HOME",
    "HERMES_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "KAGURA_API_KEY",
    "CLAUDE_CONFIG_DIR",
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

/** `setup <harness>` with a key, a URL and the sandbox as the project. */
function setup(harnessName: string, ...extra: string[]): string[] {
  return ["setup", harnessName, "--api-key", KEY, "--mcp-url", MCP_URL, "--project-dir", sandbox, ...extra];
}

function report(h: Harness): Record<string, any> {
  return JSON.parse(h.out.join("\n"));
}

const onPosix = os.platform() === "win32" ? it.skip : it;

describe("setup codex", () => {
  const codex: Programs = { onPath: { codex: "/usr/bin/codex" } };
  const configToml = () => path.join(home, ".codex", "config.toml");

  it("runs `codex mcp add … --bearer-token-env-var KAGURA_API_KEY`", async () => {
    const h = harness(codex);
    expect(await runCli(setup("codex"), h.deps)).toBe(0);
    expect(h.runs).toEqual([
      [
        "/usr/bin/codex",
        "mcp",
        "add",
        "kagura-memory",
        "--url",
        MCP_URL,
        "--bearer-token-env-var",
        "KAGURA_API_KEY",
      ],
    ]);
    expect(report(h)).toMatchObject({
      status: "success",
      harness: "codex",
      applied_with: `codex mcp add kagura-memory --url ${MCP_URL} --bearer-token-env-var KAGURA_API_KEY`,
      mcp_url: MCP_URL,
      guardrails: null,
    });
  });

  it("says the key must be exported, without printing it", async () => {
    const h = harness(codex);
    await runCli(setup("codex"), h.deps);
    const notes = (report(h).notes as string[]).join("\n");
    expect(notes).toMatch(/export KAGURA_API_KEY/);
    expect(notes).not.toContain(KEY);
  });

  it("writes .kagura.json, gitignored, and nothing into the Codex config itself", async () => {
    const h = harness(codex);
    await runCli(setup("codex"), h.deps);
    expect(JSON.parse(fs.readFileSync(path.join(sandbox, ".kagura.json"), "utf-8"))).toMatchObject({
      api_key: KEY,
      mcp_url: MCP_URL,
    });
    expect(fs.readFileSync(path.join(sandbox, ".gitignore"), "utf-8")).toContain(".kagura.json");
    // Applying is `codex mcp add`'s job; this bin never writes TOML.
    expect(fs.existsSync(configToml())).toBe(false);
  });

  it("writes --mcp-url to .kagura.json as given, without the flags' parameters", async () => {
    // As setup claude does, after Python: baseUrlFromMcp finds the REST
    // base in the path, so the query does no harm there.
    const h = harness(codex);
    const given = `${MCP_URL}?tools=a,b`;
    await runCli(setup("codex", "--mcp-url", given, "--tool-profile", "core", "-c", CONTEXT), h.deps);
    expect(h.runs[0]![5]).toBe(`${given}&guardrails=${CONTEXT}&profile=core`);
    expect(JSON.parse(fs.readFileSync(path.join(sandbox, ".kagura.json"), "utf-8")).mcp_url).toBe(given);
  });

  it("does not copy a key that came from KAGURA_API_KEY into .kagura.json", async () => {
    // Codex reads the key from that variable, and so does this bin; the
    // environment is where the user chose to keep it.
    process.env.KAGURA_API_KEY = "envonly_key_abcdef";
    const h = harness(codex, { api_key: "envonly_key_abcdef" });
    expect(
      await runCli(["setup", "codex", "--mcp-url", MCP_URL, "--project-dir", sandbox, "-c", CONTEXT], h.deps),
    ).toBe(0);
    const kagura = fs.readFileSync(path.join(sandbox, ".kagura.json"), "utf-8");
    expect(kagura).not.toContain("envonly_key_abcdef");
    expect(JSON.parse(kagura)).toEqual({ mcp_url: MCP_URL, context_id: CONTEXT });
    expect((report(h).notes as string[]).join("\n")).toMatch(/not copied into .*\.kagura\.json/);
  });

  describe("with the key in KAGURA_API_KEY and a .kagura.json without one", () => {
    // The real loader returns a .kagura.json as it is, so the variable has
    // to be read by setup itself — and setup codex writes exactly such a
    // file when the key came from the variable.
    const ENV_KEY = "envonly_key_abcdef";
    const kaguraJson = () => path.join(sandbox, ".kagura.json");
    const codexIn = (...extra: string[]) =>
      ["setup", "codex", "--mcp-url", MCP_URL, "--project-dir", sandbox, ...extra];

    beforeEach(() => {
      process.env.KAGURA_API_KEY = ENV_KEY;
      process.chdir(sandbox);
    });

    it("can be re-run: the first run's own .kagura.json does not hide the key", async () => {
      const first = harness(codex, "disk");
      expect(await runCli(codexIn("-c", CONTEXT), first.deps)).toBe(0);
      expect(JSON.parse(fs.readFileSync(kaguraJson(), "utf-8"))).toEqual({ mcp_url: MCP_URL, context_id: CONTEXT });

      const again = harness(codex, "disk");
      expect(await runCli(codexIn("--guardrails", "off"), again.deps)).toBe(0);
      expect(again.runs[0]![5]).toBe(`${MCP_URL}?guardrails=off`);
      expect(fs.readFileSync(kaguraJson(), "utf-8")).not.toContain(ENV_KEY);
    });

    it("works on a first run whose .kagura.json holds only context_id", async () => {
      fs.writeFileSync(kaguraJson(), JSON.stringify({ context_id: CONTEXT }));
      const h = harness(codex, "disk");
      expect(await runCli(codexIn(), h.deps)).toBe(0);
      expect(h.runs).toHaveLength(1);
      expect(fs.readFileSync(kaguraJson(), "utf-8")).not.toContain(ENV_KEY);
    });

    it("lets .kagura.json's own api_key win over the variable", async () => {
      fs.writeFileSync(kaguraJson(), JSON.stringify({ api_key: "file_key_0123456789" }));
      const h = harness(codex, "disk");
      expect(await runCli(codexIn(), h.deps)).toBe(0);
      // Not the variable's key, so it stays in the file as it was.
      expect(JSON.parse(fs.readFileSync(kaguraJson(), "utf-8")).api_key).toBe("file_key_0123456789");
    });
  });

  it("without a key anywhere, names every place one can come from, and not auth login", async () => {
    // setup writes an API-key entry; an OAuth profile does not give it one.
    const h = harness(codex);
    expect(await runCli(["setup", "codex", "--project-dir", sandbox], h.deps)).toBe(1);
    const err = h.err.join("\n");
    expect(err).toContain("Error: no API key: pass --api-key, set api_key in .kagura.json, or export KAGURA_API_KEY.");
    expect(err).not.toMatch(/auth login/);
    expect(h.runs).toEqual([]);
  });

  it("warns that a ?tools= allowlist wins over --tool-profile", async () => {
    // memory-cloud applies `tools` before it reads `profile`.
    const h = harness(codex);
    expect(
      await runCli(setup("codex", "--mcp-url", `${MCP_URL}?tools=recall`, "--tool-profile", "core"), h.deps),
    ).toBe(0);
    expect(report(h).notes).toContain(
      "Warning: the MCP URL has a ?tools= allowlist, which the server applies instead of --tool-profile core.",
    );
    expect(h.runs[0]![5]).toBe(`${MCP_URL}?tools=recall&profile=core`);

    const plain = harness(codex);
    await runCli(setup("codex", "--mcp-url", `${MCP_URL}?tools=recall`), plain.deps);
    expect((report(plain).notes as string[]).join("\n")).not.toMatch(/allowlist/);
  });

  it("describes the --guardrails default with its conditions", async () => {
    const h = harness({});
    expect(await runCli(["setup", "codex", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n").replace(/\s+/g, " ");
    expect(text).toContain(
      "--guardrails, when neither it nor the URL sets one, defaults to off when the Kagura plugin's " +
        "Codex hooks are on, and otherwise to the -c context when that is a UUID.",
    );
  });

  it("--dry-run prints the two-key TOML table and runs and writes nothing", async () => {
    const h = harness(codex);
    expect(await runCli(setup("codex", "--dry-run"), h.deps)).toBe(0);
    expect(h.runs).toEqual([]);
    expect(h.err.join("\n")).toContain(
      `[mcp_servers.kagura-memory]\nurl = "${MCP_URL}"\nbearer_token_env_var = "KAGURA_API_KEY"`,
    );
    expect(h.err.join("\n")).toContain(configToml());
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
    expect(report(h)).toMatchObject({ status: "dry_run", applied_with: null, wrote: [] });
  });

  it("without codex on PATH, prints the table and the file it belongs in, and exits 0", async () => {
    const h = harness({});
    expect(await runCli(setup("codex"), h.deps)).toBe(0);
    expect(h.runs).toEqual([]);
    const err = h.err.join("\n");
    expect(err).toContain(configToml());
    expect(err).toContain("bearer_token_env_var");
    expect(report(h).applied_with).toBeNull();
    // True on Windows too, where an npm-installed codex is a .cmd shim
    // that `which` passes over.
    expect((report(h).notes as string[]).join("\n")).toMatch(/`codex` was not found on PATH.*\.cmd/);
  });

  it("honours CODEX_HOME", async () => {
    process.env.CODEX_HOME = path.join(sandbox, "codex-home");
    const h = harness({});
    await runCli(setup("codex"), h.deps);
    expect(h.err.join("\n")).toContain(path.join(sandbox, "codex-home", "config.toml"));
  });

  describe("guardrails", () => {
    function hooksOn(): void {
      const dir = path.join(home, ".codex", "plugins", "data", "kagura-memory-kagura-plugins");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "config.json"), "{}");
    }
    const addedUrl = (h: Harness) => h.runs[0]![5];

    it("defaults to off when the Codex plugin's hooks are on", async () => {
      hooksOn();
      const h = harness(codex);
      await runCli(setup("codex"), h.deps);
      expect(addedUrl(h)).toBe(`${MCP_URL}?guardrails=off`);
      expect(report(h).guardrails).toBe("off");
    });

    it("joins with & when the URL already has a query", async () => {
      hooksOn();
      const h = harness(codex);
      await runCli(setup("codex", "--mcp-url", `${MCP_URL}?profile=core`), h.deps);
      expect(addedUrl(h)).toBe(`${MCP_URL}?profile=core&guardrails=off`);
    });

    it("an explicit --guardrails beats the hooks default", async () => {
      hooksOn();
      const h = harness(codex);
      await runCli(setup("codex", "--guardrails", CONTEXT), h.deps);
      expect(addedUrl(h)).toBe(`${MCP_URL}?guardrails=${CONTEXT}`);
    });

    it("a plugin data directory without config.json does not count", async () => {
      fs.mkdirSync(path.join(home, ".codex", "plugins", "data", "kagura-memory-x"), { recursive: true });
      const h = harness(codex);
      await runCli(setup("codex"), h.deps);
      expect(addedUrl(h)).toBe(MCP_URL);
    });

    it("defaults to the -c context when the hooks are off", async () => {
      const h = harness(codex);
      await runCli(setup("codex", "-c", CONTEXT), h.deps);
      expect(addedUrl(h)).toBe(`${MCP_URL}?guardrails=${CONTEXT}`);
    });

    it("does not turn a non-UUID -c into a guardrails value the server would ignore", async () => {
      const h = harness(codex);
      await runCli(setup("codex", "-c", "dev"), h.deps);
      expect(addedUrl(h)).toBe(MCP_URL);
      expect((report(h).notes as string[]).join("\n")).toMatch(/not a UUID/);
    });

    it("keeps a guardrails value already in --mcp-url", async () => {
      hooksOn();
      const h = harness(codex);
      await runCli(setup("codex", "--mcp-url", `${MCP_URL}?guardrails=${CONTEXT}`), h.deps);
      expect(addedUrl(h)).toBe(`${MCP_URL}?guardrails=${CONTEXT}`);
    });

    it("--tool-profile core adds profile=core and keeps the rest", async () => {
      const h = harness(codex);
      await runCli(setup("codex", "--mcp-url", `${MCP_URL}?tools=recall`, "--tool-profile", "core"), h.deps);
      expect(addedUrl(h)).toBe(`${MCP_URL}?tools=recall&profile=core`);
    });

    it("puts guardrails before profile, as setup claude does", async () => {
      hooksOn();
      const h = harness(codex);
      await runCli(setup("codex", "--mcp-url", `${MCP_URL}?profile=full`, "--tool-profile", "core"), h.deps);
      expect(addedUrl(h)).toBe(`${MCP_URL}?guardrails=off&profile=core`);
    });

    it("rejects an empty --tool-profile", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--tool-profile="), h.deps)).toBe(2);
      expect(h.err).toContain("Error: Invalid value for '--tool-profile': must not be empty");
      expect(h.runs).toEqual([]);
    });

    it("rejects a --guardrails that is neither a UUID nor off", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--guardrails", "dev"), h.deps)).toBe(2);
      expect(h.runs).toEqual([]);
    });
  });

  describe("an existing entry", () => {
    beforeEach(() => {
      fs.mkdirSync(path.dirname(configToml()), { recursive: true });
      fs.writeFileSync(configToml(), '[mcp_servers.kagura-memory]\nurl = "https://old"\n');
    });

    it("stops with exit 1 and runs nothing without --force", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex"), h.deps)).toBe(1);
      expect(h.err.join("\n")).toMatch(/already has an MCP server named 'kagura-memory'.*--force/s);
      expect(h.runs).toEqual([]);
      expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
    });

    it("is replaced with --force", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--force"), h.deps)).toBe(0);
      expect(h.runs).toHaveLength(1);
    });

    it("under --dry-run is a note, not a failure", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--dry-run"), h.deps)).toBe(0);
      expect((report(h).notes as string[]).join("\n")).toMatch(/--force/);
    });

    it("is looked up under --name", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--name", "kagura-work"), h.deps)).toBe(0);
      expect(h.runs[0]!.slice(1, 4)).toEqual(["mcp", "add", "kagura-work"]);
    });
  });

  it("exits 1 with the harness's own message when codex mcp add fails", async () => {
    const h = harness({
      onPath: codex.onPath!,
      exec: () => ({ code: 2, stdout: "", stderr: "invalid server name" }),
    });
    expect(await runCli(setup("codex"), h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/codex mcp add.*failed \(exit 2\).*invalid server name/s);
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
  });

  it.each(["kagura memory", "a.b", "x/y", ""])("rejects --name %j with exit 2", async (name) => {
    const h = harness(codex);
    expect(await runCli(setup("codex", `--name=${name}`), h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/Invalid value for '--name'/);
  });

  it("refuses --profile without naming a Python command that does not exist yet", async () => {
    const h = harness(codex);
    expect(await runCli(["setup", "codex", "--profile", "work", "--project-dir", sandbox], h.deps)).toBe(1);
    const err = h.err.join("\n");
    expect(err).toMatch(/kagura-mcp.*--api-key/s);
    // The Python CLI has only `setup claude --profile` today (python-sdk#260).
    expect(err).not.toMatch(/kagura setup codex/);
  });
});

describe("setup hermes", () => {
  const hermesDir = () => path.join(home, ".hermes");
  const envFile = () => path.join(hermesDir(), ".env");
  const configYaml = () => path.join(hermesDir(), "config.yaml");

  it("writes the key to $HERMES_HOME/.env as MCP_KAGURA_MEMORY_API_KEY", async () => {
    const h = harness({});
    expect(await runCli(setup("hermes"), h.deps)).toBe(0);
    expect(fs.readFileSync(envFile(), "utf-8")).toBe(`MCP_KAGURA_MEMORY_API_KEY=${KEY}\n`);
    expect(report(h).wrote).toEqual([envFile(), path.join(sandbox, ".kagura.json")]);
  });

  it("replaces an existing line rather than adding a duplicate", async () => {
    fs.mkdirSync(hermesDir(), { recursive: true });
    fs.writeFileSync(envFile(), "OPENAI_API_KEY=o\nMCP_KAGURA_MEMORY_API_KEY=old\n");
    const h = harness({});
    await runCli(setup("hermes"), h.deps);
    expect(fs.readFileSync(envFile(), "utf-8")).toBe(`OPENAI_API_KEY=o\nMCP_KAGURA_MEMORY_API_KEY=${KEY}\n`);
  });

  it("prints the config.yaml block and its file, never writing the config or running hermes", async () => {
    const h = harness({ onPath: { hermes: "/usr/bin/hermes" } });
    await runCli(setup("hermes"), h.deps);
    const err = h.err.join("\n");
    expect(err).toContain(configYaml());
    expect(err).toContain(
      [
        "mcp_servers:",
        "  kagura-memory:",
        `    url: "${MCP_URL}"`,
        "    headers:",
        '      Authorization: "Bearer ${MCP_KAGURA_MEMORY_API_KEY}"',
      ].join("\n"),
    );
    // `hermes mcp add` always prompts; this port never does.
    expect(h.runs).toEqual([]);
    expect(fs.existsSync(configYaml())).toBe(false);
    expect(report(h)).toMatchObject({ harness: "hermes", applied_with: null });
  });

  describe("a config.yaml that already has mcp_servers", () => {
    // Pasted as printed, a second top-level mcp_servers key would replace
    // the first — YAML keeps the last — and drop every other server.
    const other = 'model: x\nmcp_servers:\n  other:\n    url: "https://o"\n';

    it("says to rewrite an inline mcp_servers value as a block first", async () => {
      fs.mkdirSync(hermesDir(), { recursive: true });
      fs.writeFileSync(configYaml(), "\uFEFFmcp_servers: {other: {url: x}}\n");
      const h = harness({});
      expect(await runCli(setup("hermes"), h.deps)).toBe(0);
      expect(h.err.join("\n")).not.toMatch(/^mcp_servers:/m);
      const notes = (report(h).notes as string[]).join("\n");
      expect(notes).toContain(
        `${configYaml()} writes its mcp_servers value inline (flow style or null); rewrite it as a block mapping`,
      );
    });

    it("prints the entry alone, to go under the existing key", async () => {
      fs.mkdirSync(hermesDir(), { recursive: true });
      fs.writeFileSync(configYaml(), other);
      const h = harness({});
      expect(await runCli(setup("hermes"), h.deps)).toBe(0);
      expect(h.err).toContain(`Add this to the mcp_servers: mapping in ${configYaml()}:`);
      expect(h.err).toContain(
        [
          "  kagura-memory:",
          `    url: "${MCP_URL}"`,
          "    headers:",
          '      Authorization: "Bearer ${MCP_KAGURA_MEMORY_API_KEY}"',
        ].join("\n"),
      );
      expect(h.err.join("\n")).not.toMatch(/^mcp_servers:/m);
      const notes = (report(h).notes as string[]).join("\n");
      expect(notes).toContain(`add the block printed on stderr to the mcp_servers: mapping in ${configYaml()}`);
      expect(notes).toContain(
        `${configYaml()} already has a top-level mcp_servers: key, so only the kagura-memory entry is ` +
          "printed: a second mcp_servers: key would replace the first, and the servers under it with it",
      );
      // Still never written here.
      expect(fs.readFileSync(configYaml(), "utf-8")).toBe(other);
    });

    it("indents the entry as the file indents its other servers", async () => {
      fs.mkdirSync(hermesDir(), { recursive: true });
      fs.writeFileSync(configYaml(), "mcp_servers:\n    other:\n        url: y\n");
      const h = harness({});
      await runCli(setup("hermes", "--dry-run"), h.deps);
      expect(h.err.join("\n")).toContain(`    kagura-memory:\n      url: "${MCP_URL}"`);
    });
  });

  it("honours HERMES_HOME", async () => {
    process.env.HERMES_HOME = path.join(sandbox, "hermes-home");
    const h = harness({});
    await runCli(setup("hermes"), h.deps);
    expect(fs.existsSync(path.join(sandbox, "hermes-home", ".env"))).toBe(true);
  });

  it("derives the variable from --name", async () => {
    const h = harness({});
    await runCli(setup("hermes", "--name", "kagura-work"), h.deps);
    expect(fs.readFileSync(envFile(), "utf-8")).toBe(`MCP_KAGURA_WORK_API_KEY=${KEY}\n`);
  });

  it("--guardrails off exits 2 and writes nothing", async () => {
    const h = harness({});
    expect(await runCli(setup("hermes", "--guardrails", "off"), h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/get_context_info/);
    expect(fs.existsSync(envFile())).toBe(false);
  });

  it("does not write a guardrails context id, and says where guardrails come from", async () => {
    const h = harness({});
    expect(await runCli(setup("hermes", "--guardrails", CONTEXT), h.deps)).toBe(0);
    expect(h.err.join("\n")).not.toContain("guardrails=");
    expect(report(h).guardrails).toBeNull();
    expect((report(h).notes as string[]).join("\n")).toMatch(/get_context_info\(context_id\) at session start/);
  });

  it("refuses guardrails=off carried in --mcp-url, as it does the flag", async () => {
    const h = harness({});
    expect(await runCli(setup("hermes", "--mcp-url", `${MCP_URL}?guardrails=off`), h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/guardrails=off.*get_context_info/s);
    expect(fs.existsSync(envFile())).toBe(false);
  });

  it("refuses guardrails=off carried in the configured mcp_url", async () => {
    const h = harness({}, { mcp_url: `${MCP_URL}?guardrails=OFF` });
    expect(await runCli(["setup", "hermes", "--api-key", KEY, "--project-dir", sandbox], h.deps)).toBe(2);
    expect(fs.existsSync(envFile())).toBe(false);
  });

  it("drops a guardrails context id carried in --mcp-url, keeping the rest", async () => {
    const h = harness({});
    expect(
      await runCli(setup("hermes", "--mcp-url", `${MCP_URL}?profile=core&guardrails=${CONTEXT}`), h.deps),
    ).toBe(0);
    expect(h.err.join("\n")).toContain(`url: "${MCP_URL}?profile=core"`);
    expect(report(h)).toMatchObject({ mcp_url: `${MCP_URL}?profile=core`, guardrails: null });
    expect((report(h).notes as string[]).join("\n")).toMatch(/get_context_info\(context_id\) at session start/);
  });

  it("stops on an existing entry in config.yaml unless --force", async () => {
    fs.mkdirSync(hermesDir(), { recursive: true });
    fs.writeFileSync(configYaml(), "mcp_servers:\n  kagura-memory:\n    url: https://old\n");
    const refused = harness({});
    expect(await runCli(setup("hermes"), refused.deps)).toBe(1);
    expect(fs.existsSync(envFile())).toBe(false);

    const forced = harness({});
    expect(await runCli(setup("hermes", "--force"), forced.deps)).toBe(0);
    expect(fs.existsSync(envFile())).toBe(true);
  });

  it("--dry-run writes nothing", async () => {
    const h = harness({});
    expect(await runCli(setup("hermes", "--dry-run"), h.deps)).toBe(0);
    expect(fs.existsSync(envFile())).toBe(false);
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
    expect(h.err.join("\n")).toContain("${MCP_KAGURA_MEMORY_API_KEY}");
  });

  it("does not take --tool-profile", async () => {
    const h = harness({});
    expect(await runCli(setup("hermes", "--tool-profile", "core"), h.deps)).toBe(2);
  });

  it("says the variable follows --name", async () => {
    const h = harness({});
    expect(await runCli(["setup", "hermes", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n").replace(/\s+/g, " ");
    expect(text).toContain("as MCP_<NAME>_API_KEY (MCP_KAGURA_MEMORY_API_KEY by default)");
  });

  it("describes --guardrails as what it does here, not as a URL parameter", async () => {
    const h = harness({});
    expect(await runCli(["setup", "hermes", "--help"], h.deps)).toBe(0);
    const line = h.out.join("\n").split("\n").find((l) => l.trimStart().startsWith("--guardrails"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/Set the URL's guardrails parameter/);
    expect(line).toMatch(/not written/);
  });
});

describe("setup openclaw", () => {
  const openclaw: Programs = { onPath: { openclaw: "/usr/bin/openclaw" } };
  const stateDir = () => path.join(home, ".openclaw");
  const envFile = () => path.join(stateDir(), ".env");
  const configJson = () => path.join(stateDir(), "openclaw.json");

  it("runs `openclaw mcp add` with the exact argv, and the key only in .env", async () => {
    const h = harness(openclaw);
    expect(await runCli(setup("openclaw"), h.deps)).toBe(0);
    expect(h.runs).toEqual([
      [
        "/usr/bin/openclaw",
        "mcp",
        "add",
        "kagura-memory",
        "--url",
        MCP_URL,
        "--transport",
        "streamable-http",
        "--header",
        // Literal: argv reaches openclaw with no shell to expand it, and
        // OpenClaw resolves ${VAR} from its .env.
        "Authorization=Bearer ${KAGURA_API_KEY}",
        "--no-probe",
      ],
    ]);
    expect(fs.readFileSync(envFile(), "utf-8")).toBe(`KAGURA_API_KEY=${KEY}\n`);
    const r = report(h);
    expect(r.applied_with).toBe(
      `openclaw mcp add kagura-memory --url ${MCP_URL} --transport streamable-http --header 'Authorization=Bearer \${KAGURA_API_KEY}' --no-probe`,
    );
    expect((r.notes as string[]).join("\n")).toContain("openclaw mcp doctor kagura-memory --probe");
  });

  it("--force uses `openclaw mcp set` with a streamable-http entry", async () => {
    const h = harness(openclaw);
    expect(await runCli(setup("openclaw", "--force"), h.deps)).toBe(0);
    const [file, ...argv] = h.runs[0]!;
    expect(file).toBe("/usr/bin/openclaw");
    expect(argv.slice(0, 3)).toEqual(["mcp", "set", "kagura-memory"]);
    expect(JSON.parse(argv[3]!)).toEqual({
      url: MCP_URL,
      transport: "streamable-http",
      headers: { Authorization: "Bearer ${KAGURA_API_KEY}" },
    });
  });

  it("without openclaw on PATH, prints the block with transport streamable-http", async () => {
    const h = harness({});
    expect(await runCli(setup("openclaw"), h.deps)).toBe(0);
    const err = h.err.join("\n");
    expect(err).toContain(configJson());
    expect(err).toContain('"transport": "streamable-http"');
    expect(err).toContain('"Authorization": "Bearer ${KAGURA_API_KEY}"');
    expect(fs.existsSync(configJson())).toBe(false);
    expect(fs.readFileSync(envFile(), "utf-8")).toBe(`KAGURA_API_KEY=${KEY}\n`);
  });

  it("honours OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH", async () => {
    process.env.OPENCLAW_STATE_DIR = path.join(sandbox, "state");
    process.env.OPENCLAW_CONFIG_PATH = path.join(sandbox, "conf", "oc.json5");
    const h = harness({});
    await runCli(setup("openclaw"), h.deps);
    expect(fs.existsSync(path.join(sandbox, "state", ".env"))).toBe(true);
    expect(h.err.join("\n")).toContain(path.join(sandbox, "conf", "oc.json5"));
  });

  it("names the state and config overrides in its help", async () => {
    const h = harness({});
    expect(await runCli(["setup", "openclaw", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n").replace(/\s+/g, " ");
    expect(text).toContain("$OPENCLAW_STATE_DIR/.env (default ~/.openclaw/.env)");
    expect(text).toContain("$OPENCLAW_CONFIG_PATH");
    expect(text).not.toContain("Writes the key to ~/.openclaw/.env");
  });

  it("replaces an existing KAGURA_API_KEY line", async () => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(envFile(), "KAGURA_API_KEY=old\nOTHER=1");
    const h = harness(openclaw);
    await runCli(setup("openclaw"), h.deps);
    expect(fs.readFileSync(envFile(), "utf-8")).toBe(`KAGURA_API_KEY=${KEY}\nOTHER=1\n`);
  });

  it("--guardrails off exits 2 and runs nothing", async () => {
    const h = harness(openclaw);
    expect(await runCli(setup("openclaw", "--guardrails", "off"), h.deps)).toBe(2);
    expect(h.runs).toEqual([]);
    expect(fs.existsSync(envFile())).toBe(false);
  });

  it("does not write a guardrails context id", async () => {
    const h = harness(openclaw);
    await runCli(setup("openclaw", "--guardrails", CONTEXT), h.deps);
    expect(h.runs[0]![5]).toBe(MCP_URL);
    expect((report(h).notes as string[]).join("\n")).toMatch(/get_context_info/);
  });

  it("refuses guardrails=off carried in --mcp-url, and runs nothing", async () => {
    const h = harness(openclaw);
    expect(await runCli(setup("openclaw", "--mcp-url", `${MCP_URL}?guardrails=off`), h.deps)).toBe(2);
    expect(h.runs).toEqual([]);
    expect(fs.existsSync(envFile())).toBe(false);
  });

  it("drops a guardrails context id carried in --mcp-url", async () => {
    const h = harness(openclaw);
    expect(await runCli(setup("openclaw", "--mcp-url", `${MCP_URL}?guardrails=${CONTEXT}`), h.deps)).toBe(0);
    expect(h.runs[0]![5]).toBe(MCP_URL);
    expect((report(h).notes as string[]).join("\n")).toMatch(/get_context_info/);
  });

  it("stops on an unparseable .kagura.json before openclaw runs or .env is written", async () => {
    fs.writeFileSync(path.join(sandbox, ".kagura.json"), "{not json");
    const h = harness(openclaw);
    expect(await runCli(setup("openclaw"), h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/refusing to rewrite .*\.kagura\.json/);
    expect(h.runs).toEqual([]);
    expect(fs.existsSync(envFile())).toBe(false);
  });

  it("stops on an existing JSON5 entry unless --force", async () => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(configJson(), "{ mcp: { servers: { 'kagura-memory': { url: 'https://old' } } } }");
    const h = harness(openclaw);
    expect(await runCli(setup("openclaw"), h.deps)).toBe(1);
    expect(h.runs).toEqual([]);
  });

  it("exits 1 when openclaw refuses, leaving .env alone", async () => {
    const h = harness({
      onPath: openclaw.onPath!,
      exec: () => ({ code: 1, stdout: "", stderr: 'MCP server "kagura-memory" already exists' }),
    });
    expect(await runCli(setup("openclaw"), h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("already exists");
    expect(fs.existsSync(envFile())).toBe(false);
  });
});

describe("the harness .env files are not world-readable", () => {
  // Windows has no POSIX mode bits; see doctorSetup.test.ts.
  onPosix.each([
    ["hermes", ".hermes"],
    ["openclaw", ".openclaw"],
  ])("setup %s creates .env at 0600", async (name, dir) => {
    const h = harness({});
    expect(await runCli(setup(name), h.deps)).toBe(0);
    expect(fs.statSync(path.join(home, dir, ".env")).mode & 0o077).toBe(0);
  });

  onPosix.each([
    ["hermes", ".hermes"],
    ["openclaw", ".openclaw"],
  ])("setup %s tightens an existing 0644 .env", async (name, dir) => {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, ".env"), "A=1\n", { mode: 0o644 });
    const h = harness({});
    await runCli(setup(name), h.deps);
    expect(fs.statSync(path.join(home, dir, ".env")).mode & 0o077).toBe(0);
  });
});

describe("a flag-shaped --name", () => {
  // The name is a bare positional in the codex and openclaw argv, where a
  // harness CLI would read `--help` as its own option, print its help and
  // exit 0 — a success report with nothing configured.
  const everywhere: Programs = { onPath: { codex: "/usr/bin/codex", openclaw: "/usr/bin/openclaw" } };

  it.each([
    ["codex", "--help"],
    ["codex", "-h"],
    ["codex", "--no-probe"],
    ["codex", "_x"],
    ["openclaw", "--help"],
    ["openclaw", "-x"],
    ["hermes", "--help"],
  ])("setup %s --name=%s exits 2 and runs nothing", async (harnessName, name) => {
    const h = harness(everywhere);
    expect(await runCli(setup(harnessName, `--name=${name}`), h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain(
      `Error: Invalid value for '--name': '${name}' must start with a letter or digit and contain ` +
        "only letters, digits, '-' and '_'.",
    );
    expect(h.runs).toEqual([]);
    expect(fs.existsSync(path.join(sandbox, ".kagura.json"))).toBe(false);
  });

  it("still takes a name that only contains a dash", async () => {
    const h = harness(everywhere);
    expect(await runCli(setup("codex", "--name=kagura-work_2"), h.deps)).toBe(0);
    expect(h.runs[0]!.slice(1, 4)).toEqual(["mcp", "add", "kagura-work_2"]);
  });
});

describe("setup --help", () => {
  it("lists every harness", async () => {
    const h = harness({});
    expect(await runCli(["setup", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    for (const name of ["claude", "codex", "hermes", "openclaw"]) {
      expect(text).toMatch(new RegExp(`^\\s+${name}\\s`, "m"));
    }
  });
});
