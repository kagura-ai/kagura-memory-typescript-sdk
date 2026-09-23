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

function harness(programs: Programs = {}): Harness {
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
    loadConfig: () => ({}),
  } as unknown as CliDeps;
  return { deps, out, err, runs };
}

const KEY = "kagura_secret_0123456789";
const CONTEXT = "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c";
const MCP_URL = "https://x.test/mcp";

let sandbox: string;
let home: string;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-setup-"));
  home = path.join(sandbox, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const name of ["CODEX_HOME", "HERMES_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]) {
    delete process.env[name];
  }
});

afterEach(() => {
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

  it.each(["kagura memory", "a.b", "x/y"])("rejects --name %j with exit 2", async (name) => {
    const h = harness(codex);
    expect(await runCli(setup("codex", "--name", name), h.deps)).toBe(2);
  });

  it("refuses --profile, naming the Python path for Codex", async () => {
    const h = harness(codex);
    expect(await runCli(["setup", "codex", "--profile", "work", "--project-dir", sandbox], h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/kagura-mcp.*kagura setup codex --profile work/s);
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
