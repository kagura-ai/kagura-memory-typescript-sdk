/**
 * `setup codex | hermes | openclaw`.
 *
 * No process is spawned and no real PATH is read: `which` and `execFile`
 * are the injected fakes below, and HOME plus each harness's home variable
 * point into a per-test sandbox.
 *
 * These setups never see, write, print or pass the API key: the entry
 * names the variable the harness reads it from, as in the Python CLI
 * (python-sdk#260). They write no file either; the harness's own CLI does,
 * or the user adds the printed block.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolveAuthOptions } from "../../../src/auth/resolve.js";
import type { ResolvedAuth } from "../../../src/auth/types.js";
import { shellQuote } from "../../../src/cli/commands/harnessConfig.js";
import type { ExecOptions, ExecResult } from "../../../src/cli/exec.js";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { loadConfig, type KaguraConfig } from "../../../src/config.js";
import { KaguraAuthError } from "../../../src/errors.js";
import { GUARDRAIL_VERSION_HEADER, MemoryClient } from "../../../src/memoryClient.js";
import { restClientFromAuth } from "../../../src/restBase.js";
import { FakeRest } from "../../fakeServer.js";

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  /** Every program `execFile` was asked to run, as `[file, ...argv]`. */
  runs: string[][];
  /** The timeout each of those runs was given, in the same order. */
  timeouts: (number | undefined)[];
  /** The digest server the AGENTS.md export fetches from. */
  rest: FakeRest;
  /** How often the export's credential was resolved. */
  resolved: number;
  /** Runs and fetches, in the order they happened: `run <program>` / `fetch`. */
  events: string[];
}

interface Programs {
  /** Program name → the path `which` reports; absent means not on PATH. */
  onPath?: Record<string, string>;
  /** What a run returns; defaults to a silent exit 0. */
  exec?: (file: string, argv: readonly string[]) => ExecResult;
  /**
   * The credential the CLI chain resolves for the export, or a function
   * that answers (or throws) instead. Defaults to {@link EXPORT_AUTH}.
   */
  auth?: ResolvedAuth | ((options: ResolveAuthOptions) => ResolvedAuth);
}

/** A KAGURA_API_KEY credential on the server of {@link MCP_URL}. */
const EXPORT_KEY = "kagura_export_key_0123456789";
const EXPORT_AUTH: ResolvedAuth = {
  kind: "static",
  apiKey: EXPORT_KEY,
  mcpUrl: "https://x.test/mcp",
  source: "env",
};

/**
 * `config` stands in for what `loadConfig` returns; "disk" runs the real
 * loader, which reads ./.kagura.json, then ~/.kagura.json, and only when
 * neither exists the KAGURA_* variables. The export's credential and its
 * digest server are fakes: nothing reads the real credentials file or the
 * network.
 */
function harness(programs: Programs = {}, config: KaguraConfig | "disk" = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const runs: string[][] = [];
  const timeouts: (number | undefined)[] = [];
  const events: string[] = [];
  const rest = new FakeRest();
  rest.body = EXPORT_BLOCK;
  rest.responseHeaders = { "content-type": "text/markdown", [GUARDRAIL_VERSION_HEADER]: VERSION };
  const fetchDigest = rest.fetch;
  rest.fetch = async (input, init) => {
    events.push("fetch");
    return fetchDigest(input, init);
  };
  const h: Harness = { deps: undefined as unknown as CliDeps, out, err, runs, timeouts, rest, resolved: 0, events };
  h.deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => true,
    which: (name: string) => programs.onPath?.[name] ?? null,
    execFile: async (file: string, argv: readonly string[], options?: ExecOptions) => {
      runs.push([file, ...argv]);
      timeouts.push(options?.timeoutMs);
      events.push(`run ${path.basename(file)}`);
      return programs.exec?.(file, argv) ?? { code: 0, stdout: "", stderr: "" };
    },
    loadConfig: () => (config === "disk" ? loadConfig() : config),
    resolveAuth: (options: ResolveAuthOptions = {}) => {
      h.resolved += 1;
      const auth = programs.auth ?? EXPORT_AUTH;
      return typeof auth === "function" ? auth(options) : auth;
    },
    makeMemoryClient: (auth?: ResolvedAuth) => restClientFromAuth(MemoryClient, auth!, { fetch: rest.fetch }),
  } as unknown as CliDeps;
  return h;
}

const KEY = "kagura_secret_0123456789";
const CONTEXT = "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c";
const MCP_URL = "https://x.test/mcp";
const VERSION = "abc123";
const EXPORT_BLOCK =
  `<!-- kagura-memory:guardrails begin context=${CONTEXT} tool_triggered_version=${VERSION} -->\n` +
  "- (aaaaaaaa) Squash-merge only after the head SHA matches\n" +
  "<!-- kagura-memory:guardrails end -->\n";

let sandbox: string;
let home: string;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

/**
 * True when the sandboxes this file creates (all under `os.tmpdir()`) sit on
 * a case-insensitive filesystem (macOS APFS default, Windows): a file
 * written under one case is found under any other. Probed once, since the
 * temp directory's case sensitivity does not change between tests. Where
 * this is true, `AGENTS.md`/`agents.md` and `CLAUDE.md`/`claude.md` name the
 * same file, so `hermesContextFile`'s probe order (the upper-case spelling
 * comes first in each pair) — not the spelling actually on disk — decides
 * which name the export note prints.
 */
const CASE_INSENSITIVE_FS = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-case-probe-"));
  try {
    fs.writeFileSync(path.join(probe, "case.tmp"), "");
    return fs.existsSync(path.join(probe, "CASE.TMP"));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-setup-"));
  home = path.join(sandbox, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Every KAGURA_* too: a developer's own key must not leak into what the
  // no-secret assertions scan, nor their URL or context into a fallback.
  for (const name of [
    "CODEX_HOME",
    "HERMES_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_WORKSPACE_DIR",
    "CLAUDE_CONFIG_DIR",
    ...Object.keys(process.env).filter((key) => key.startsWith("KAGURA_")),
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

/** `setup <harness>` with a URL. No key: these setups never take one. */
function setup(harnessName: string, ...extra: string[]): string[] {
  return ["setup", harnessName, "--mcp-url", MCP_URL, ...extra];
}

function report(h: Harness): Record<string, any> {
  return JSON.parse(h.out.join("\n"));
}

function notes(h: Harness): string[] {
  return report(h).notes as string[];
}

/** Every file under the sandbox, the fake home included. */
function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return filesUnder(full);
    return e.isFile() ? [full] : [];
  });
}

const CODEX_KEY_NOTE =
  "Codex reads the API key from $KAGURA_API_KEY when it connects: set it in the environment " +
  "that starts Codex, e.g. `export KAGURA_API_KEY=<your-api-key>` in your shell profile. " +
  "(Codex refuses an inline bearer_token on a URL entry.)";
const HERMES_KEY_NOTE =
  "Add `MCP_KAGURA_MEMORY_API_KEY=<your-api-key>` to ~/.hermes/.env with an editor: the entry " +
  "reads it from there, and setup never sees the key.";
const OPENCLAW_KEY_NOTE =
  "Add `KAGURA_API_KEY=<your-api-key>` to ~/.openclaw/.env with an editor: the entry sends " +
  "${KAGURA_API_KEY} (mcp.servers headers take no SecretRef), and setup never sees the key.";
const NOT_ON_PATH = (cli: string) => `\`${cli}\` is not on PATH, or only as a Windows .cmd shim, which needs a shell`;
/** Python's closing hint for Hermes and OpenClaw when nothing is exported. */
const RERUN = (file: string, title: string) =>
  "Re-run with --agents-md --context-id <id> to put a snapshot of a context's tool guardrails into " +
  `${file}, which ${title} loads every session.`;
const MCP_URL_SHAPE =
  "Error: Invalid value for '--mcp-url': use an https:// URL, e.g. " +
  "https://memory.kagura-ai.com/mcp/w/<workspace-id>";

describe("setup codex", () => {
  const codex: Programs = { onPath: { codex: "/usr/bin/codex" } };
  const configToml = () => path.join(home, ".codex", "config.toml");

  it("runs `codex mcp add … --bearer-token-env-var KAGURA_API_KEY` with Python's 120 s timeout", async () => {
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
    expect(h.timeouts).toEqual([120_000]);
    expect(report(h)).toMatchObject({
      status: "success",
      harness: "codex",
      applied_with: `codex mcp add kagura-memory --url ${MCP_URL} --bearer-token-env-var KAGURA_API_KEY`,
      mcp_url: MCP_URL,
      guardrails: null,
    });
  });

  it("needs no key, and ends with Python's notes on where the key goes and how to check the entry", async () => {
    // No --api-key, no KAGURA_API_KEY, no .kagura.json: the entry only
    // names the variable, so nothing is missing.
    const h = harness(codex);
    expect(await runCli(setup("codex"), h.deps)).toBe(0);
    expect(notes(h)).toEqual([
      "Done: codex wrote kagura-memory to ~/.codex/config.toml.",
      CODEX_KEY_NOTE,
      "Restart Codex (or start a new session) to load the entry.",
      "Check it with: codex mcp get kagura-memory",
    ]);
  });

  it("writes no file: no .kagura.json, no .gitignore, and nothing into the Codex config itself", async () => {
    process.chdir(sandbox);
    const h = harness(codex);
    expect(await runCli(setup("codex", "-c", CONTEXT), h.deps)).toBe(0);
    expect(filesUnder(sandbox)).toEqual([]);
    // The fields stay; `wrote` lists what was actually written.
    expect(report(h)).toMatchObject({
      project_dir: fs.realpathSync(sandbox),
      wrote: [],
      gitignore_added: [],
      context_id: CONTEXT,
    });
  });

  it("takes --api-key-env as the variable, in the argv, the table and the key note", async () => {
    const h = harness(codex);
    expect(await runCli(setup("codex", "--api-key-env", "KAGURA_CODEX_KEY"), h.deps)).toBe(0);
    expect(h.runs[0]!.slice(-2)).toEqual(["--bearer-token-env-var", "KAGURA_CODEX_KEY"]);
    expect(notes(h).join("\n")).toContain("export KAGURA_CODEX_KEY=<your-api-key>");

    const printed = harness({});
    await runCli(setup("codex", "--api-key-env", "KAGURA_CODEX_KEY"), printed.deps);
    expect(printed.err.join("\n")).toContain('bearer_token_env_var = "KAGURA_CODEX_KEY"');
  });

  it.each(["my-key", "kagura_api_key", "1KEY", ""])("refuses --api-key-env %j with exit 2", async (value) => {
    const h = harness(codex);
    expect(await runCli(setup("codex", `--api-key-env=${value}`), h.deps)).toBe(2);
    expect(h.err).toContain(
      "Error: Invalid value for '--api-key-env': use an upper-case variable name, e.g. KAGURA_API_KEY",
    );
    expect(h.runs).toEqual([]);
  });

  it("refuses a plain-HTTP --mcp-url that is not localhost, with exit 2", async () => {
    const h = harness(codex);
    expect(await runCli(setup("codex", "--mcp-url", "http://example.com/mcp"), h.deps)).toBe(2);
    expect(h.err).toContain(
      "Error: Invalid value for '--mcp-url': MCP URL must use HTTPS for security " +
        "(got: http://example.com/mcp). HTTP is only allowed for localhost development.",
    );
    expect(h.runs).toEqual([]);

    const local = harness(codex);
    expect(await runCli(setup("codex", "--mcp-url", "http://localhost:8080/mcp"), local.deps)).toBe(0);
  });

  it.each(["HTTP://example.com/mcp", "Http://example.com/mcp", " http://example.com/mcp"])(
    "refuses %j too: a URL's scheme has no case, and a parser drops the space",
    async (url) => {
      // Python's startswith("http://") check lets each of these through.
      const h = harness(codex);
      expect(await runCli(setup("codex", "--mcp-url", url), h.deps)).toBe(2);
      expect(h.err.join("\n")).toContain("Error: Invalid value for '--mcp-url': MCP URL must use HTTPS");
      expect(h.runs).toEqual([]);
    },
  );

  it("refuses a plain-HTTP configured mcp_url too, before anything runs", async () => {
    const h = harness(codex, { mcp_url: "http://example.com/mcp" });
    expect(await runCli(["setup", "codex"], h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("MCP URL must use HTTPS for security (got: http://example.com/mcp)");
    expect(h.err.join("\n")).toContain("--mcp-url");
    expect(h.runs).toEqual([]);
  });

  describe("a configuration it cannot load", () => {
    // The real loader reads ./.kagura.json first. This one would make
    // JSON.parse quote the start of the key.
    const BROKEN = `{"api_key": ${KEY}}`;

    it("stops nothing with --mcp-url, which Python reads alone, and quotes none of it", async () => {
      process.chdir(sandbox);
      fs.writeFileSync(path.join(sandbox, ".kagura.json"), BROKEN);
      const h = harness(codex, "disk");
      expect(await runCli(setup("codex"), h.deps)).toBe(0);
      expect(h.runs).toHaveLength(1);
      expect(notes(h)).toContain(
        "Note: the configuration (.kagura.json) could not be loaded, so setup went on without it: " +
          "--mcp-url gives the URL.",
      );
      for (const text of [h.out.join("\n"), h.err.join("\n")]) expect(text).not.toContain(KEY.slice(0, 10));
      expect(fs.readFileSync(path.join(sandbox, ".kagura.json"), "utf-8")).toBe(BROKEN);
    });

    it("stops setup without --mcp-url, whose fallback is its mcp_url", async () => {
      process.chdir(sandbox);
      fs.writeFileSync(path.join(sandbox, ".kagura.json"), "{not json");
      const h = harness(codex, "disk");
      expect(await runCli(["setup", "codex"], h.deps)).toBe(1);
      expect(h.err.join("\n")).toContain("Error: Invalid JSON or encoding in .kagura.json");
      expect(h.runs).toEqual([]);
    });

    it.each(["codex", "hermes", "openclaw"])("stops setup %s without --mcp-url, and quotes none of it", async (name) => {
      process.chdir(sandbox);
      fs.writeFileSync(path.join(sandbox, ".kagura.json"), BROKEN);
      const h = harness({ onPath: { [name]: `/usr/bin/${name}` } }, "disk");
      expect(await runCli(["setup", name, "--dry-run"], h.deps)).toBe(1);
      // The position is optional: V8 on Node 18 reports one here, Node 20+ does not.
      expect(h.err).toHaveLength(1);
      expect(h.err[0]).toMatch(
        /^Error: Invalid JSON or encoding in \.kagura\.json \(expected UTF-8\)(: line \d+ column \d+)?$/,
      );
      expect(h.err.join("\n")).not.toContain("kagura_");
    });
  });

  it("falls back to the configured mcp_url, then the default", async () => {
    const configured = harness(codex, { mcp_url: "https://self.test/mcp/w/ws1" });
    await runCli(["setup", "codex"], configured.deps);
    expect(configured.runs[0]![5]).toBe("https://self.test/mcp/w/ws1");

    const bare = harness(codex);
    await runCli(["setup", "codex"], bare.deps);
    expect(bare.runs[0]![5]).toBe("https://memory.kagura-ai.com/mcp");
  });

  describe("the options v0.10 took, now accepted and inert", () => {
    it("--api-key is neither stored nor used, and says so", async () => {
      process.chdir(sandbox);
      const h = harness(codex);
      expect(await runCli(setup("codex", "--api-key", KEY), h.deps)).toBe(0);
      expect(notes(h)).toContain(
        "Note: --api-key is not stored or used: the Codex entry reads the key from $KAGURA_API_KEY, " +
          "and setup never handles the key.",
      );
      expect(filesUnder(sandbox)).toEqual([]);
      expect(h.out.join("\n")).not.toContain(KEY);
      expect(h.err.join("\n")).not.toContain(KEY);
      expect(h.runs.flat().join(" ")).not.toContain(KEY);
    });

    it("--project-dir is not used, and says so, even for a directory that does not exist", async () => {
      const h = harness(codex);
      const gone = path.join(sandbox, "gone");
      expect(await runCli(setup("codex", "--project-dir", gone), h.deps)).toBe(0);
      expect(notes(h)).toContain(
        "Note: --project-dir is not used: the Codex entry is per user, and harness setups write no " +
          ".kagura.json or .gitignore.",
      );
      expect(fs.existsSync(gone)).toBe(false);
    });

    it("--url-form is accepted: every entry here is the URL form", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--url-form"), h.deps)).toBe(0);
      expect(h.runs).toHaveLength(1);
    });
  });

  describe("--profile", () => {
    it("without --url-form, names the Python command for this harness and --url-form", async () => {
      // Python v0.40.0 ships `kagura setup codex --profile`.
      const h = harness(codex);
      expect(await runCli(["setup", "codex", "--profile", "work"], h.deps)).toBe(1);
      const err = h.err.join("\n");
      expect(err).toContain("kagura-mcp");
      expect(err).toContain("`pip install kagura-memory && kagura setup codex --profile work`");
      expect(err).toContain("--url-form");
      expect(h.runs).toEqual([]);
    });

    it("is still refused beside --api-key, even with --url-form, as it was before 0.11.0", async () => {
      // Both are inert here, but the pair was a usage error in v0.10, and
      // Python's harness setups take no --api-key at all (exit 2 too).
      const h = harness(codex);
      expect(await runCli(setup("codex", "--url-form", "--profile", "work", "--api-key", KEY), h.deps)).toBe(2);
      expect(h.err).toContain(
        "Error: --profile (OAuth) and --api-key (static token) are mutually exclusive; pick one.",
      );
      expect(h.err.join("\n")).not.toContain(KEY);
      expect(h.runs).toEqual([]);
    });

    it("with --url-form, is ignored with a note that covers the AGENTS.md export too", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--url-form", "--profile", "work"), h.deps)).toBe(0);
      expect(notes(h)).toContain(
        "Note: --profile is not used: this port lists no contexts, and the AGENTS.md export " +
          "(--agents-md) fetches on the usual credential chain (KAGURA_API_KEY, the OAuth profile, " +
          ".kagura.json), as `kagura-memory guardrails digest` does.",
      );
      expect(h.runs).toHaveLength(1);
    });

    it("with --url-form, cannot turn a context name into a UUID either (exit 2)", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--url-form", "--profile", "work", "-c", "proj"), h.deps)).toBe(2);
      expect(h.err).toEqual([
        "Error: --profile is not used here, so --context-id must be a context UUID: setup cannot " +
          "list contexts.",
      ]);
      expect(h.runs).toEqual([]);
    });

    it("without --url-form, is refused before a context name is looked at", async () => {
      const h = harness(codex);
      expect(await runCli(["setup", "codex", "--profile", "work", "-c", "proj"], h.deps)).toBe(1);
      expect(h.err.join("\n")).toContain("kagura-mcp");
    });
  });

  it("warns that a ?tools= allowlist wins over --tool-profile", async () => {
    // memory-cloud applies `tools` before it reads `profile`.
    const h = harness(codex);
    expect(
      await runCli(setup("codex", "--mcp-url", `${MCP_URL}?tools=recall`, "--tool-profile", "core"), h.deps),
    ).toBe(0);
    expect(notes(h)).toContain(
      "Warning: the MCP URL has a ?tools= allowlist, which the server applies instead of --tool-profile core.",
    );
    expect(h.runs[0]![5]).toBe(`${MCP_URL}?tools=recall&profile=core`);

    const plain = harness(codex);
    await runCli(setup("codex", "--mcp-url", `${MCP_URL}?tools=recall`), plain.deps);
    expect(notes(plain).join("\n")).not.toMatch(/allowlist/);
  });

  it("--dry-run says so first, shows the command and the table, and runs and writes nothing", async () => {
    process.chdir(sandbox);
    const h = harness(codex);
    expect(await runCli(setup("codex", "--dry-run"), h.deps)).toBe(0);
    expect(h.runs).toEqual([]);
    expect(filesUnder(sandbox)).toEqual([]);
    expect(h.err.join("\n")).toContain(
      `[mcp_servers.kagura-memory]\nurl = "${MCP_URL}"\nbearer_token_env_var = "KAGURA_API_KEY"`,
    );
    expect(h.err.join("\n")).toContain("~/.codex/config.toml");
    // Python returns before its closing notes on a dry run.
    expect(notes(h)).toEqual([
      "Dry run: nothing is written, run or fetched.",
      `Would run: codex mcp add kagura-memory --url ${MCP_URL} --bearer-token-env-var KAGURA_API_KEY`,
    ]);
    expect(report(h)).toMatchObject({ status: "dry_run", applied_with: null, wrote: [] });
  });

  it("without codex on PATH, prints the table in Python's words, with the closing notes, and exits 0", async () => {
    const h = harness({});
    expect(await runCli(setup("codex"), h.deps)).toBe(0);
    expect(h.runs).toEqual([]);
    const err = h.err.join("\n");
    // True on Windows too, where an npm-installed codex is a .cmd shim
    // that `which` passes over.
    expect(err).toContain(
      `Setup does not edit ~/.codex/config.toml itself (${NOT_ON_PATH("codex")}).\n` +
        "Add this kagura-memory entry to it:",
    );
    expect(err).toContain("bearer_token_env_var");
    expect(report(h).applied_with).toBeNull();
    expect(notes(h)).toEqual([
      `Setup does not edit ~/.codex/config.toml itself (${NOT_ON_PATH("codex")}). ` +
        "Add the kagura-memory entry printed on stderr to it.",
      CODEX_KEY_NOTE,
      "Restart Codex (or start a new session) to load the entry.",
      "Check it with: codex mcp get kagura-memory",
    ]);
  });

  it("honours CODEX_HOME", async () => {
    process.env.CODEX_HOME = path.join(sandbox, "codex-home");
    const h = harness({});
    await runCli(setup("codex"), h.deps);
    // Outside the home directory, so named in full.
    expect(h.err.join("\n")).toContain(path.join(sandbox, "codex-home", "config.toml"));
  });

  describe("guardrails", () => {
    /** Turn the Kagura plugin's Codex hooks on, as their own setup does. */
    function hooksOn(settings: Record<string, unknown> = {}, dir = "kagura-memory-kagura-plugins"): void {
      const data = path.join(home, ".codex", "plugins", "data", dir);
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ context_id: CONTEXT, ...settings }));
    }
    const addedUrl = (h: Harness) => h.runs[0]![5];
    const HOOKS_NOTE =
      "The plugin's hooks deliver guardrails, so the URL gets ?guardrails=off (the hooks' own setup " +
      "asks for it; --guardrails overrides).";

    it("defaults to off when the Codex plugin's hooks are on, in Python's words", async () => {
      hooksOn();
      const h = harness(codex);
      await runCli(setup("codex", "-c", CONTEXT), h.deps);
      expect(addedUrl(h)).toBe(`${MCP_URL}?guardrails=off`);
      expect(report(h).guardrails).toBe("off");
      expect(notes(h)).toContain(HOOKS_NOTE);
    });

    it("counts hooks only for the table their config.json names, kagura-memory by default", async () => {
      hooksOn({ mcp_server: "kagura-work" });
      const other = harness(codex);
      await runCli(setup("codex"), other.deps);
      expect(addedUrl(other)).toBe(MCP_URL);

      const named = harness(codex);
      await runCli(setup("codex", "--name", "kagura-work"), named.deps);
      expect(addedUrl(named)).toBe(`${MCP_URL}?guardrails=off`);
    });

    it.each([
      ["a plugin data directory without config.json", () => {
        fs.mkdirSync(path.join(home, ".codex", "plugins", "data", "kagura-memory-x"), { recursive: true });
      }],
      ["a config.json that is a directory", () => {
        fs.mkdirSync(path.join(home, ".codex", "plugins", "data", "kagura-memory-x", "config.json"), {
          recursive: true,
        });
      }],
      ["a config.json that is not a JSON object", () => {
        const data = path.join(home, ".codex", "plugins", "data", "kagura-memory-x");
        fs.mkdirSync(data, { recursive: true });
        fs.writeFileSync(path.join(data, "config.json"), "[1, 2]");
      }],
      ["a config.json over the hooks' 64 KiB cap", () => {
        hooksOn({ pad: "x".repeat(64 * 1024) });
      }],
      ["another plugin's data directory", () => {
        hooksOn({}, "other-plugin");
      }],
    ])("%s does not count", async (_label, arrange) => {
      arrange();
      const h = harness(codex);
      await runCli(setup("codex"), h.deps);
      expect(addedUrl(h)).toBe(MCP_URL);
    });

    it("reads a config.json that starts with a UTF-8 BOM", async () => {
      const data = path.join(home, ".codex", "plugins", "data", "kagura-memory-x");
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(data, "config.json"), `\uFEFF${JSON.stringify({ context_id: CONTEXT })}`);
      const h = harness(codex);
      await runCli(setup("codex"), h.deps);
      expect(addedUrl(h)).toBe(`${MCP_URL}?guardrails=off`);
    });

    it("an explicit --guardrails beats the hooks default", async () => {
      hooksOn();
      const h = harness(codex);
      await runCli(setup("codex", "--guardrails", CONTEXT), h.deps);
      expect(addedUrl(h)).toBe(`${MCP_URL}?guardrails=${CONTEXT}`);
    });

    it("defaults to the -c context when the hooks are off, with Python's digest note", async () => {
      const h = harness(codex);
      await runCli(setup("codex", "-c", CONTEXT), h.deps);
      expect(addedUrl(h)).toBe(`${MCP_URL}?guardrails=${CONTEXT}`);
      expect(notes(h)).toEqual([
        "Done: codex wrote kagura-memory to ~/.codex/config.toml.",
        CODEX_KEY_NOTE,
        `Codex should get the tool guardrail digest of context ${CONTEXT} in the MCP instructions when ` +
          "it connects. The server sends only its base text instead when the entry's credential cannot " +
          "read that context, the context has no guardrails, or the deployment turns the digest off. " +
          "Preview what it sends: " +
          `KAGURA_MCP_URL='${MCP_URL}?guardrails=${CONTEXT}' kagura-memory guardrails digest ${CONTEXT} ` +
          "--target instructions",
        "Use a context whose editor list you control: every editor's guardrail summaries reach the model.",
        "Restart Codex (or start a new session) to load the entry.",
        "Check it with: codex mcp get kagura-memory",
      ]);
    });

    it("previews on the entry's own key variable", async () => {
      const h = harness(codex);
      await runCli(setup("codex", "-c", CONTEXT, "--api-key-env", "KAGURA_CODEX_KEY"), h.deps);
      expect(notes(h).join("\n")).toContain(
        `KAGURA_API_KEY="\${KAGURA_CODEX_KEY}" KAGURA_MCP_URL='${MCP_URL}?guardrails=${CONTEXT}' ` +
          `kagura-memory guardrails digest ${CONTEXT} --target instructions`,
      );
    });

    it("writes -c canonically into the URL and the report", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", `{${CONTEXT.toUpperCase()}}`), h.deps)).toBe(0);
      expect(addedUrl(h)).toBe(`${MCP_URL}?guardrails=${CONTEXT}`);
      expect(report(h).context_id).toBe(CONTEXT);
    });

    it("keeps a guardrails value already in --mcp-url", async () => {
      hooksOn();
      const h = harness(codex);
      await runCli(setup("codex", "--mcp-url", `${MCP_URL}?guardrails=${CONTEXT}`), h.deps);
      expect(addedUrl(h)).toBe(`${MCP_URL}?guardrails=${CONTEXT}`);
      expect(notes(h)).not.toContain(HOOKS_NOTE);
    });

    it("keeps one in the configured mcp_url too, which --mcp-url defaults to", async () => {
      // `setup claude` writes the URL as given, query included.
      hooksOn();
      const h = harness(codex, { mcp_url: `${MCP_URL}?guardrails=${CONTEXT}` });
      await runCli(["setup", "codex"], h.deps);
      expect(addedUrl(h)).toBe(`${MCP_URL}?guardrails=${CONTEXT}`);
      expect(notes(h)).not.toContain(HOOKS_NOTE);
    });

    it("joins with & when the URL already has a query", async () => {
      hooksOn();
      const h = harness(codex);
      await runCli(setup("codex", "--mcp-url", `${MCP_URL}?profile=core`), h.deps);
      expect(addedUrl(h)).toBe(`${MCP_URL}?profile=core&guardrails=off`);
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
    const STOP = "a kagura-memory entry already exists in ~/.codex/config.toml; re-run with --force to replace it";

    beforeEach(() => {
      fs.mkdirSync(path.dirname(configToml()), { recursive: true });
      fs.writeFileSync(configToml(), '[mcp_servers.kagura-memory]\nurl = "https://old"\n');
    });

    it("stops with exit 1, in Python's words, and runs nothing without --force", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex"), h.deps)).toBe(1);
      expect(h.err).toContain(`Error: Nothing was written: ${STOP}.`);
      expect(h.runs).toEqual([]);
    });

    it("stops without codex on PATH too: Python reads config.toml itself", async () => {
      const h = harness({});
      expect(await runCli(setup("codex"), h.deps)).toBe(1);
      expect(h.err).toContain(`Error: Nothing was written: ${STOP}.`);
    });

    it("is replaced with --force, by one `codex mcp add`, which overwrites", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--force"), h.deps)).toBe(0);
      expect(h.runs).toHaveLength(1);
      expect(h.runs[0]!.slice(1, 3)).toEqual(["mcp", "add"]);
    });

    it("with --force and no codex on PATH, says to put the printed table in place of it", async () => {
      const h = harness({});
      expect(await runCli(setup("codex", "--force"), h.deps)).toBe(0);
      expect(h.err.join("\n")).toContain("Add this kagura-memory entry to it in place of the existing one:");
      expect(notes(h)[0]).toMatch(/printed on stderr to it in place of the existing one\.$/);
    });

    it("under --dry-run is where setup would stop, and labels the command", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--dry-run"), h.deps)).toBe(0);
      expect(notes(h)).toEqual([
        "Dry run: nothing is written, run or fetched.",
        `Setup would stop here: ${STOP}.`,
        `With --force, would run: codex mcp add kagura-memory --url ${MCP_URL} --bearer-token-env-var KAGURA_API_KEY`,
      ]);
    });

    it("is looked up under --name", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--name", "kagura-work"), h.deps)).toBe(0);
      expect(h.runs[0]!.slice(1, 4)).toEqual(["mcp", "add", "kagura-work"]);
    });
  });

  it("stops on a config.toml it cannot read, in Python's words", async () => {
    // A directory in its place: reading it fails whoever runs the tests.
    fs.mkdirSync(configToml(), { recursive: true });
    const h = harness(codex);
    expect(await runCli(setup("codex"), h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/Error: Cannot read ~\/\.codex\/config\.toml \(.+\); fix it and re-run\./);
    expect(h.runs).toEqual([]);
  });

  describe("a failing codex", () => {
    it("exits 1 with its own message, as Python words it", async () => {
      const h = harness({
        onPath: codex.onPath!,
        exec: () => ({ code: 2, stdout: "", stderr: "invalid server name\n" }),
      });
      expect(await runCli(setup("codex"), h.deps)).toBe(1);
      expect(h.err).toContain("Error: `codex mcp add` failed: invalid server name");
    });

    it("names the exit code when it says nothing", async () => {
      const h = harness({ onPath: codex.onPath!, exec: () => ({ code: 2, stdout: "", stderr: "" }) });
      expect(await runCli(setup("codex"), h.deps)).toBe(1);
      expect(h.err).toContain("Error: `codex mcp add` failed: exit code 2");
    });

    it.each([137, 1, 0])("says when it timed out, even with exit code %i", async (code) => {
      // Python kills it and reports the timeout, whatever the CLI did with
      // the signal; a 0 from a killed run is no success.
      const h = harness({
        onPath: codex.onPath!,
        exec: () => ({ code, stdout: "", stderr: "got-term", timedOut: true }),
      });
      expect(await runCli(setup("codex"), h.deps)).toBe(1);
      expect(h.err).toContain("Error: `codex mcp add` failed: timed out after 120s");
      expect(h.out).toEqual([]);
    });

    it("never echoes a key it prints back", async () => {
      // Codex's environment carries the key; a CLI may print what it read.
      process.env.KAGURA_API_KEY = KEY;
      const h = harness({
        onPath: codex.onPath!,
        exec: () => ({ code: 1, stdout: "", stderr: `bad token ${KEY}` }),
      });
      expect(await runCli(setup("codex"), h.deps)).toBe(1);
      expect(h.err).toContain("Error: `codex mcp add` failed: bad token <redacted>");
    });
  });

  it("describes the options in Python's words", async () => {
    const h = harness({});
    expect(await runCli(["setup", "codex", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n").replace(/\s+/g, " ");
    expect(text).toContain("Set up Kagura Memory for OpenAI Codex (CLI and IDE extension).");
    expect(text).toContain("--guardrails off|CONTEXT_ID");
    expect(text).toContain("--api-key-env VAR");
    expect(text).toContain("MCP server name in the harness config");
    expect(text).toContain("Defaults to --context-id");
    expect(text).toContain("codex mcp get kagura-memory");
  });
});

describe("setup hermes", () => {
  const hermesDir = () => path.join(home, ".hermes");
  const configYaml = () => path.join(hermesDir(), "config.yaml");
  const hermes: Programs = { onPath: { hermes: "/usr/bin/hermes" } };

  it("prints the config.yaml block, writing no file, never running hermes and needing no key", async () => {
    process.chdir(sandbox);
    const h = harness(hermes);
    expect(await runCli(setup("hermes"), h.deps)).toBe(0);
    const err = h.err.join("\n");
    expect(err).toContain(
      "Setup does not edit ~/.hermes/config.yaml itself (`hermes mcp add` is interactive and this port " +
        "never prompts).\nAdd this kagura-memory entry to it:",
    );
    expect(err).toContain(
      [
        "mcp_servers:",
        "  kagura-memory:",
        `    url: "${MCP_URL}"`,
        "    headers:",
        '      Authorization: "Bearer ${MCP_KAGURA_MEMORY_API_KEY}"',
      ].join("\n"),
    );
    expect(h.runs).toEqual([]);
    expect(filesUnder(sandbox)).toEqual([]);
    expect(report(h)).toMatchObject({ harness: "hermes", applied_with: null, wrote: [], gitignore_added: [] });
    expect(notes(h)).toEqual([
      "Setup does not edit ~/.hermes/config.yaml itself (`hermes mcp add` is interactive and this port " +
        "never prompts). Add the kagura-memory entry printed on stderr to it.",
      HERMES_KEY_NOTE,
      "Check it with: hermes mcp test kagura-memory",
      // The file Hermes loads in the current directory.
      RERUN(path.join(fs.realpathSync(sandbox), "AGENTS.md"), "Hermes Agent"),
    ]);
  });

  it.each([
    ["without", {}],
    ["with", hermes],
  ])("prints the whole block %s hermes on PATH when it cannot read config.yaml, and exits 0", async (_, programs) => {
    // Python reads config.yaml for its mcp_servers key alone, and prints
    // the whole block with a note when it cannot. A directory in its place
    // fails any reader.
    fs.mkdirSync(configYaml(), { recursive: true });
    const h = harness(programs);
    expect(await runCli(setup("hermes"), h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain("Add this kagura-memory entry to it:\n\nmcp_servers:\n  kagura-memory:");
    expect(notes(h).join("\n")).toMatch(
      /^Setup could not read ~\/\.hermes\/config\.yaml \(.+\): if it already has a top-level mcp_servers: key, put only the kagura-memory entry under it\.$/m,
    );
  });

  it("reads config.yaml as strict UTF-8, as Python's read_text does", async () => {
    fs.mkdirSync(hermesDir(), { recursive: true });
    fs.writeFileSync(configYaml(), Buffer.from([0x6d, 0x63, 0xff, 0x0a]));
    const h = harness({});
    expect(await runCli(setup("hermes"), h.deps)).toBe(0);
    expect(notes(h).join("\n")).toMatch(/^Setup could not read ~\/\.hermes\/config\.yaml \(.+\): if it/m);
    expect(h.err.join("\n")).toContain("mcp_servers:\n  kagura-memory:");
  });

  it("reads a lone CR as a line break, as Python's universal newlines do", async () => {
    fs.mkdirSync(hermesDir(), { recursive: true });
    fs.writeFileSync(configYaml(), "model: x\rmcp_servers:\r  other:\r    url: y\r");
    const h = harness({});
    expect(await runCli(setup("hermes"), h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain("Add this kagura-memory entry to its mcp_servers: mapping:");
  });

  it("says `hermes` is not on PATH when it is not", async () => {
    const h = harness({});
    expect(await runCli(setup("hermes"), h.deps)).toBe(0);
    expect(notes(h)[0]).toContain(`(${NOT_ON_PATH("hermes")})`);
  });

  it("derives the variable from --name, and refuses --api-key-env in Python's words", async () => {
    const h = harness({});
    await runCli(setup("hermes", "--name", "kagura_work"), h.deps);
    expect(h.err.join("\n")).toContain("  kagura_work:");
    expect(h.err.join("\n")).toContain("${MCP_KAGURA_WORK_API_KEY}");
    expect(notes(h)).toContain("Check it with: hermes mcp test kagura_work");

    const refused = harness({});
    expect(await runCli(setup("hermes", "--api-key-env", "MY_KEY"), refused.deps)).toBe(2);
    expect(refused.err).toContain(
      "Error: Hermes Agent names the variable itself (MCP_KAGURA_MEMORY_API_KEY); drop --api-key-env.",
    );
  });

  it("never runs `hermes mcp add` over a kept OAuth entry, so 0.41.3's kept-entry stop cannot arise (python-sdk #287)", async () => {
    // Python 0.41.3: with Hermes's overwrite prompt declined, an `auth: oauth`
    // entry at the same URL is the kept one, not "Done". This port never
    // runs `hermes mcp add`, so there is no prompt: it prints the entry to
    // put in its place, as Python does under -y, and claims nothing written.
    fs.mkdirSync(hermesDir(), { recursive: true });
    const kept = `mcp_servers:\n  kagura-memory:\n    url: "${MCP_URL}"\n    auth: oauth\n`;
    fs.writeFileSync(configYaml(), kept);
    const h = harness(hermes);
    expect(await runCli(setup("hermes", "--url-form", "--force"), h.deps)).toBe(0);
    expect(h.runs).toEqual([]);
    expect(notes(h).some((n) => n.startsWith("Done:"))).toBe(false);
    expect(notes(h)).toContain(
      "Setup does not edit ~/.hermes/config.yaml itself (`hermes mcp add` is interactive and this port " +
        "never prompts). Add the kagura-memory entry printed on stderr to its mcp_servers: mapping in place " +
        "of the existing one.",
    );
    expect(fs.readFileSync(configYaml(), "utf-8")).toBe(kept);
  });

  describe("its home", () => {
    function activeProfile(content: string): void {
      fs.mkdirSync(hermesDir(), { recursive: true });
      fs.writeFileSync(path.join(hermesDir(), "active_profile"), content);
    }

    it("follows the sticky active profile, case-folded", async () => {
      activeProfile("Work\n");
      const profileDir = path.join(hermesDir(), "profiles", "work");
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, "config.yaml"), "mcp_servers:\n  kagura-memory:\n    url: x\n");
      // Found there: with hermes on PATH, an existing entry stops setup.
      const h = harness(hermes);
      expect(await runCli(setup("hermes"), h.deps)).toBe(1);
      expect(h.err.join("\n")).toContain("already exists in ~/.hermes/profiles/work/config.yaml");

      const printed = harness({});
      await runCli(setup("hermes", "--force"), printed.deps);
      expect(notes(printed)).toContain(
        "Add `MCP_KAGURA_MEMORY_API_KEY=<your-api-key>` to ~/.hermes/profiles/work/.env with an editor: " +
          "the entry reads it from there, and setup never sees the key.",
      );
    });

    it.each(["default\n", "../escape\n", "", "-bad\n"])("stays at ~/.hermes for active_profile %j", async (content) => {
      activeProfile(content);
      const h = harness({});
      await runCli(setup("hermes"), h.deps);
      expect(notes(h)[0]).toContain("Setup does not edit ~/.hermes/config.yaml itself");
    });

    it("lets HERMES_HOME win over the active profile", async () => {
      activeProfile("work\n");
      process.env.HERMES_HOME = path.join(sandbox, "hermes-home");
      const h = harness({});
      await runCli(setup("hermes"), h.deps);
      expect(h.err.join("\n")).toContain(path.join(sandbox, "hermes-home", "config.yaml"));
    });
  });

  describe("a config.yaml that already has mcp_servers", () => {
    // Pasted as printed, a second top-level mcp_servers key would replace
    // the first — YAML keeps the last — and drop every other server.
    const other = 'model: x\nmcp_servers:\n  other:\n    url: "https://o"\n';

    it.each(["{}", "null", "{other: {command: foo}}", "~"])(
      "says to rewrite an inline mcp_servers value (%s) as a block first, in Python's words",
      async (value) => {
        fs.mkdirSync(hermesDir(), { recursive: true });
        fs.writeFileSync(configYaml(), `\uFEFFmcp_servers: ${value}\nmodel: gpt\n`);
        const h = harness({});
        expect(await runCli(setup("hermes"), h.deps)).toBe(0);
        expect(h.err.join("\n")).not.toMatch(/^mcp_servers:/m);
        expect(notes(h)).toContain(
          "Its mcp_servers value is written inline (flow style or null): rewrite it as a block mapping, " +
            "one server per indented key, before adding kagura-memory.",
        );
      },
    );

    it("prints the entry alone, to go under the existing key", async () => {
      fs.mkdirSync(hermesDir(), { recursive: true });
      fs.writeFileSync(configYaml(), other);
      const h = harness({});
      expect(await runCli(setup("hermes"), h.deps)).toBe(0);
      expect(h.err.join("\n")).toContain("Add this kagura-memory entry to its mcp_servers: mapping:");
      expect(h.err).toContain(
        [
          "  kagura-memory:",
          `    url: "${MCP_URL}"`,
          "    headers:",
          '      Authorization: "Bearer ${MCP_KAGURA_MEMORY_API_KEY}"',
        ].join("\n"),
      );
      expect(h.err.join("\n")).not.toMatch(/^mcp_servers:/m);
      expect(notes(h)).toContain(
        "~/.hermes/config.yaml already has a top-level mcp_servers: key, so only the entry is printed: " +
          "a second one would replace the first and every server under it.",
      );
      expect(notes(h).join("\n")).not.toContain("inline");
      // Still never written here.
      expect(fs.readFileSync(configYaml(), "utf-8")).toBe(other);
    });

    it("notes it after the guardrails warnings, as Python prints them", async () => {
      fs.mkdirSync(hermesDir(), { recursive: true });
      fs.writeFileSync(configYaml(), other);
      const h = harness({});
      expect(await runCli(setup("hermes", "--guardrails", CONTEXT), h.deps)).toBe(0);
      const all = notes(h);
      const warning = all.findIndex((n) => n.includes("does not read MCP instructions"));
      const key = all.findIndex((n) => n.includes("already has a top-level mcp_servers: key"));
      expect(warning).toBeGreaterThanOrEqual(0);
      expect(key).toBeGreaterThan(warning);
    });

    it("indents the entry as the file indents its other servers", async () => {
      fs.mkdirSync(hermesDir(), { recursive: true });
      fs.writeFileSync(configYaml(), "mcp_servers:\n    other:\n        url: y\n");
      const h = harness({});
      await runCli(setup("hermes", "--dry-run"), h.deps);
      expect(h.err.join("\n")).toContain(`    kagura-memory:\n      url: "${MCP_URL}"`);
    });
  });

  describe("an existing entry", () => {
    beforeEach(() => {
      fs.mkdirSync(hermesDir(), { recursive: true });
      fs.writeFileSync(configYaml(), "mcp_servers:\n  kagura-memory:\n    url: https://old\n");
    });

    it("stops setup without --force when hermes is on PATH, as `hermes mcp list` would show it", async () => {
      const h = harness(hermes);
      expect(await runCli(setup("hermes"), h.deps)).toBe(1);
      expect(h.err).toContain(
        "Error: Nothing was written: a kagura-memory entry already exists in ~/.hermes/config.yaml; " +
          "re-run with --force to replace it.",
      );

      const forced = harness(hermes);
      expect(await runCli(setup("hermes", "--force"), forced.deps)).toBe(0);
      // The file has mcp_servers already, so the entry goes under it.
      expect(forced.err.join("\n")).toContain(
        "Add this kagura-memory entry to its mcp_servers: mapping in place of the existing one:",
      );
    });

    it("without hermes on PATH, prints the block to put in place of it and exits 0, as Python does", async () => {
      // Python finds a Hermes entry only through `hermes mcp list`.
      const h = harness({});
      expect(await runCli(setup("hermes"), h.deps)).toBe(0);
      expect(h.err.join("\n")).toContain(
        "Add this kagura-memory entry to its mcp_servers: mapping in place of the existing one:",
      );
      expect(notes(h).join("\n")).toMatch(/to its mcp_servers: mapping in place of the existing one\.$/m);
    });

    it("under --dry-run without hermes on PATH, is no stop", async () => {
      const h = harness({});
      expect(await runCli(setup("hermes", "--dry-run"), h.deps)).toBe(0);
      expect(notes(h).join("\n")).not.toMatch(/would stop/);
    });
  });

  describe("guardrails", () => {
    it("--guardrails off exits 2 in Python's words", async () => {
      const h = harness({});
      expect(await runCli(setup("hermes", "--guardrails", "off"), h.deps)).toBe(2);
      expect(h.err).toContain(
        "Error: Hermes Agent does not read MCP instructions: its guardrails come only from the guardrails " +
          "block of get_context_info, which --guardrails off removes.",
      );
    });

    it("--guardrails off with --profile is the same usage error, as Python checks it first", async () => {
      const h = harness({});
      expect(await runCli(["setup", "hermes", "--profile", "work", "--guardrails", "off"], h.deps)).toBe(2);
    });

    it("does not write a guardrails context id, with Python's warning", async () => {
      const h = harness({});
      expect(await runCli(setup("hermes", "--guardrails", CONTEXT), h.deps)).toBe(0);
      expect(h.err.join("\n")).not.toContain("guardrails=");
      expect(report(h).guardrails).toBeNull();
      expect(notes(h)).toContain(
        "Warning: Hermes Agent does not read MCP instructions, so --guardrails has no effect there and is " +
          "not written. Guardrails reach Hermes Agent through get_context_info (on by default) and the " +
          "AGENTS.md export (--agents-md).",
      );
    });

    it("drops a guardrails context id carried in --mcp-url, keeping the rest", async () => {
      const h = harness({});
      expect(
        await runCli(setup("hermes", "--mcp-url", `${MCP_URL}?profile=core&guardrails=${CONTEXT}`), h.deps),
      ).toBe(0);
      expect(h.err.join("\n")).toContain(`url: "${MCP_URL}?profile=core"`);
      expect(report(h)).toMatchObject({ mcp_url: `${MCP_URL}?profile=core`, guardrails: null });
      expect(notes(h)).toContain(
        "Warning: Hermes Agent does not read MCP instructions, so the ?guardrails= value in --mcp-url has " +
          "no effect there and is not written. Guardrails reach Hermes Agent through get_context_info " +
          "(on by default) and the AGENTS.md export (--agents-md).",
      );
      // The context id is never echoed either.
      expect(h.out.join("\n")).not.toContain(CONTEXT);
    });

    it("says 'the MCP URL' for a context carried in the configured mcp_url", async () => {
      const h = harness({}, { mcp_url: `${MCP_URL}?guardrails=${CONTEXT}` });
      expect(await runCli(["setup", "hermes"], h.deps)).toBe(0);
      expect(notes(h).join("\n")).toContain("so the ?guardrails= value in the MCP URL has no effect there");
      expect(report(h).mcp_url).toBe(MCP_URL);
    });

    it("keeps guardrails=off carried in --mcp-url, with Python's warning", async () => {
      const h = harness({});
      expect(await runCli(setup("hermes", "--mcp-url", `${MCP_URL}?guardrails=off`), h.deps)).toBe(0);
      expect(h.err.join("\n")).toContain(`url: "${MCP_URL}?guardrails=off"`);
      expect(report(h).guardrails).toBe("off");
      expect(notes(h)).toContain(
        "Warning: --mcp-url has ?guardrails=off, which removes the guardrails block from get_context_info: " +
          "Hermes Agent then gets no guardrails from Kagura.",
      );
    });

    it("says 'the MCP URL' for a guardrails=off carried in the configured mcp_url", async () => {
      const h = harness({}, { mcp_url: `${MCP_URL}?guardrails=OFF` });
      expect(await runCli(["setup", "hermes"], h.deps)).toBe(0);
      expect(notes(h).join("\n")).toContain("Warning: the MCP URL has ?guardrails=off");
    });
  });

  it("--dry-run writes nothing and says so", async () => {
    process.chdir(sandbox);
    const h = harness({});
    expect(await runCli(setup("hermes", "--dry-run"), h.deps)).toBe(0);
    expect(filesUnder(sandbox)).toEqual([]);
    expect(h.err.join("\n")).toContain("${MCP_KAGURA_MEMORY_API_KEY}");
    expect(notes(h)[0]).toBe("Dry run: nothing is written, run or fetched.");
    expect(notes(h).join("\n")).not.toMatch(/Check it with/);
  });

  it("-c alone writes nothing, and the closing notes say how to export it", async () => {
    process.chdir(sandbox);
    const h = harness({});
    expect(await runCli(setup("hermes", "-c", CONTEXT), h.deps)).toBe(0);
    expect(notes(h).at(-1)).toBe(RERUN(path.join(fs.realpathSync(sandbox), "AGENTS.md"), "Hermes Agent"));
    expect(filesUnder(sandbox)).toEqual([]);
    expect(h.resolved).toBe(0);
    expect(h.rest.requests).toEqual([]);
  });

  it("does not take --tool-profile", async () => {
    const h = harness({});
    expect(await runCli(setup("hermes", "--tool-profile", "core"), h.deps)).toBe(2);
  });

  it("describes itself and --guardrails in Python's words", async () => {
    const h = harness({});
    expect(await runCli(["setup", "hermes", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n").replace(/\s+/g, " ");
    expect(text).toContain("Set up Kagura Memory for Hermes Agent.");
    expect(text).toContain("MCP_<NAME>_API_KEY (MCP_KAGURA_MEMORY_API_KEY by default)");
    expect(text).toContain("hermes mcp test kagura-memory");
    const line = h.out.join("\n").split("\n").find((l) => l.trimStart().startsWith("--guardrails"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/Set the URL's guardrails parameter/);
    expect(text).toContain(
      "Never written: Hermes does not read MCP instructions. 'off' is refused (it would remove the " +
        "get_context_info guardrails block, Hermes's only guardrail lane)",
    );
  });
});

describe("setup openclaw", () => {
  const openclaw: Programs = { onPath: { openclaw: "/usr/bin/openclaw" } };
  const stateDir = () => path.join(home, ".openclaw");
  const configJson = () => path.join(stateDir(), "openclaw.json");

  it("runs `openclaw mcp add` with the exact argv and Python's 120 s timeout, writing no .env", async () => {
    process.chdir(sandbox);
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
    expect(h.timeouts).toEqual([120_000]);
    expect(filesUnder(sandbox)).toEqual([]);
    const r = report(h);
    expect(r.applied_with).toBe(
      `openclaw mcp add kagura-memory --url ${MCP_URL} --transport streamable-http --header 'Authorization=Bearer \${KAGURA_API_KEY}' --no-probe`,
    );
    expect(r.notes).toEqual([
      "Done: openclaw wrote kagura-memory to ~/.openclaw/openclaw.json.",
      OPENCLAW_KEY_NOTE,
      "The Gateway hot-reloads the file. MCP tools appear in OpenClaw's coding and messaging tool " +
        "profiles, not in minimal.",
      "Check it with: openclaw mcp doctor kagura-memory --probe",
      RERUN("~/.openclaw/workspace/AGENTS.md", "OpenClaw"),
    ]);
  });

  it("takes --api-key-env as the header's variable everywhere it appears", async () => {
    const h = harness(openclaw);
    expect(await runCli(setup("openclaw", "--api-key-env", "OC_KAGURA_KEY"), h.deps)).toBe(0);
    expect(h.runs[0]).toContain("Authorization=Bearer ${OC_KAGURA_KEY}");
    expect(notes(h).join("\n")).toContain("Add `OC_KAGURA_KEY=<your-api-key>` to ~/.openclaw/.env");
    expect(notes(h).join("\n")).toContain("the entry sends ${OC_KAGURA_KEY}");

    const forced = harness(openclaw);
    await runCli(setup("openclaw", "--api-key-env", "OC_KAGURA_KEY", "--force"), forced.deps);
    expect(JSON.parse(forced.runs[0]![4]!).headers).toEqual({ Authorization: "Bearer ${OC_KAGURA_KEY}" });

    const printed = harness({});
    await runCli(setup("openclaw", "--api-key-env", "OC_KAGURA_KEY"), printed.deps);
    expect(printed.err.join("\n")).toContain('"Authorization": "Bearer ${OC_KAGURA_KEY}"');
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
    expect(err).toContain(`Setup does not edit ~/.openclaw/openclaw.json itself (${NOT_ON_PATH("openclaw")}).`);
    expect(err).toContain('"transport": "streamable-http"');
    expect(err).toContain('"Authorization": "Bearer ${KAGURA_API_KEY}"');
    expect(fs.existsSync(stateDir())).toBe(false);
    expect(notes(h)).toContain("Check it with: openclaw mcp doctor kagura-memory --probe");
  });

  it("honours OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH", async () => {
    process.env.OPENCLAW_STATE_DIR = path.join(home, "oc-state");
    process.env.OPENCLAW_CONFIG_PATH = path.join(sandbox, "conf", "oc.json5");
    const h = harness({});
    await runCli(setup("openclaw"), h.deps);
    expect(h.err.join("\n")).toContain(path.join(sandbox, "conf", "oc.json5"));
    // The .env OpenClaw reads is in its state directory, wherever that is.
    expect(notes(h).join("\n")).toContain("to ~/oc-state/.env with an editor");
  });

  it("names the state and config overrides in its help", async () => {
    const h = harness({});
    expect(await runCli(["setup", "openclaw", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n").replace(/\s+/g, " ");
    expect(text).toContain("Set up Kagura Memory for OpenClaw.");
    expect(text).toContain("$OPENCLAW_STATE_DIR");
    expect(text).toContain("$OPENCLAW_CONFIG_PATH");
    expect(text).toContain("openclaw mcp doctor kagura-memory --probe");
  });

  describe("guardrails", () => {
    it("--guardrails off exits 2 and runs nothing", async () => {
      const h = harness(openclaw);
      expect(await runCli(setup("openclaw", "--guardrails", "off"), h.deps)).toBe(2);
      expect(h.err).toContain(
        "Error: OpenClaw does not read MCP instructions: its guardrails come only from the guardrails " +
          "block of get_context_info, which --guardrails off removes.",
      );
      expect(h.runs).toEqual([]);
    });

    it("does not write a guardrails context id", async () => {
      const h = harness(openclaw);
      await runCli(setup("openclaw", "--guardrails", CONTEXT), h.deps);
      expect(h.runs[0]![5]).toBe(MCP_URL);
      expect(notes(h).join("\n")).toContain("Warning: OpenClaw does not read MCP instructions");
    });

    it("keeps guardrails=off carried in --mcp-url, with a warning", async () => {
      const h = harness(openclaw);
      expect(await runCli(setup("openclaw", "--mcp-url", `${MCP_URL}?guardrails=off`), h.deps)).toBe(0);
      expect(h.runs[0]![5]).toBe(`${MCP_URL}?guardrails=off`);
      expect(notes(h).join("\n")).toContain("OpenClaw then gets no guardrails from Kagura.");
    });

    it("drops a guardrails context id carried in --mcp-url", async () => {
      const h = harness(openclaw);
      expect(await runCli(setup("openclaw", "--mcp-url", `${MCP_URL}?guardrails=${CONTEXT}`), h.deps)).toBe(0);
      expect(h.runs[0]![5]).toBe(MCP_URL);
      expect(notes(h).join("\n")).toContain("get_context_info");
    });
  });

  it("neither reads nor writes --project-dir's .kagura.json, even one it could not parse", async () => {
    // --project-dir is inert. The configuration setup does read, for the
    // URL and context fallbacks, is the current directory's or the home
    // directory's: see "a configuration it cannot load" under setup codex.
    fs.writeFileSync(path.join(sandbox, ".kagura.json"), "{not json");
    const h = harness(openclaw);
    expect(await runCli(setup("openclaw", "--project-dir", sandbox), h.deps)).toBe(0);
    expect(fs.readFileSync(path.join(sandbox, ".kagura.json"), "utf-8")).toBe("{not json");
  });

  describe("an existing entry", () => {
    beforeEach(() => {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(configJson(), "{ mcp: { servers: { 'kagura-memory': { url: 'https://old' } } } }");
    });

    it("stops setup without --force when openclaw is on PATH", async () => {
      const h = harness(openclaw);
      expect(await runCli(setup("openclaw"), h.deps)).toBe(1);
      expect(h.err).toContain(
        "Error: Nothing was written: a kagura-memory entry already exists in ~/.openclaw/openclaw.json; " +
          "re-run with --force to replace it.",
      );
      expect(h.runs).toEqual([]);
    });

    it("under --dry-run labels the `mcp set` a real run needs --force for", async () => {
      const h = harness(openclaw);
      expect(await runCli(setup("openclaw", "--dry-run"), h.deps)).toBe(0);
      expect(notes(h).join("\n")).toContain(
        "With --force, would run: openclaw mcp set kagura-memory '{\"url\":",
      );
      expect(h.runs).toEqual([]);
    });

    it("without openclaw on PATH, prints the block to put in place of it and exits 0, as Python does", async () => {
      // Python finds an OpenClaw entry only through `openclaw mcp show`.
      const h = harness({});
      expect(await runCli(setup("openclaw"), h.deps)).toBe(0);
      expect(h.err.join("\n")).toContain("Add this kagura-memory entry to it in place of the existing one:");
    });
  });

  it("goes on when it cannot read openclaw.json, as Python never reads it", async () => {
    // A directory in its place fails any reader. Python asks `openclaw mcp
    // show`, and without openclaw prints the block.
    fs.mkdirSync(configJson(), { recursive: true });
    const NOTE =
      /^Note: setup could not read ~\/\.openclaw\/openclaw\.json \(.+\), so it did not look there for a kagura-memory entry\.$/m;

    const printed = harness({});
    expect(await runCli(setup("openclaw"), printed.deps)).toBe(0);
    expect(printed.err.join("\n")).toContain("Add this kagura-memory entry to it:");
    expect(notes(printed).join("\n")).toMatch(NOTE);

    // With openclaw, the add runs, and openclaw says whatever it makes of the file.
    const ran = harness(openclaw);
    expect(await runCli(setup("openclaw"), ran.deps)).toBe(0);
    expect(ran.runs[0]!.slice(1, 3)).toEqual(["mcp", "add"]);
    expect(notes(ran).join("\n")).toMatch(NOTE);
  });

  it("exits 1 when openclaw refuses, as Python words it", async () => {
    const h = harness({
      onPath: openclaw.onPath!,
      exec: () => ({ code: 1, stdout: "", stderr: 'MCP server "kagura-memory" already exists' }),
    });
    expect(await runCli(setup("openclaw"), h.deps)).toBe(1);
    expect(h.err).toContain('Error: `openclaw mcp add` failed: MCP server "kagura-memory" already exists');
  });
});

describe("no key reaches output, argv or a file", () => {
  // Python's test_no_secret_in_output_argv_or_files: an exported key, and
  // here the inert --api-key too.
  const everywhere: Programs = {
    onPath: { codex: "/usr/bin/codex", hermes: "/usr/bin/hermes", openclaw: "/usr/bin/openclaw" },
  };

  it.each(["codex", "hermes", "openclaw"])("setup %s", async (name) => {
    process.env.KAGURA_API_KEY = "exported_key_0123456789";
    process.chdir(sandbox);
    for (const dryRun of [[], ["--dry-run"]]) {
      const h = harness(everywhere, "disk");
      expect(await runCli(setup(name, "--api-key", KEY, "-c", CONTEXT, ...dryRun), h.deps)).toBe(0);
      for (const secret of [KEY, "exported_key_0123456789"]) {
        expect(h.out.join("\n")).not.toContain(secret);
        expect(h.err.join("\n")).not.toContain(secret);
        expect(h.runs.flat().join(" ")).not.toContain(secret);
        for (const file of filesUnder(sandbox)) expect(fs.readFileSync(file, "utf-8")).not.toContain(secret);
      }
    }
    expect(filesUnder(sandbox)).toEqual([]);
  });
});

describe("a failing harness CLI's output", () => {
  // No argv carries a key, but a CLI may print its environment or config;
  // every key this process knows of is cut out of what is shown.
  const KEYS = {
    flag: "kagura_FLAG_aaaa1111",
    config: "kagura_CONFIG_bbbb2222",
    env: "kagura_ENV_cccc3333",
    mcpEnv: "kagura_MCPENV_dddd4444",
    other: "kagura_OTHERVAR_eeee5555",
  };

  it.each([
    ["codex", "--api-key", KEYS.flag],
    ["codex", "the configured api_key", KEYS.config],
    ["codex", "$KAGURA_API_KEY", KEYS.env],
    ["codex", "$KAGURA_MCP_API_KEY", KEYS.mcpEnv],
    ["codex", "the --api-key-env variable", KEYS.other],
    ["openclaw", "--api-key", KEYS.flag],
    ["openclaw", "the configured api_key", KEYS.config],
    ["openclaw", "$KAGURA_API_KEY", KEYS.env],
    ["openclaw", "$KAGURA_MCP_API_KEY", KEYS.mcpEnv],
    ["openclaw", "the --api-key-env variable", KEYS.other],
  ])("setup %s masks %s", async (name, _source, key) => {
    process.env.KAGURA_API_KEY = KEYS.env;
    process.env.KAGURA_MCP_API_KEY = KEYS.mcpEnv;
    process.env.OTHERVAR = KEYS.other;
    const h = harness(
      { onPath: { [name]: `/usr/bin/${name}` }, exec: () => ({ code: 4, stdout: "", stderr: `env: ${key}` }) },
      { api_key: KEYS.config },
    );
    expect(await runCli(setup(name, "--api-key", KEYS.flag, "--api-key-env", "OTHERVAR"), h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("failed: env: <redacted>");
    expect(h.err.join("\n")).not.toContain(key);
  });

  it("cuts a longer key whole when it contains a shorter one", async () => {
    process.env.KAGURA_API_KEY = "kagura_short";
    process.env.KAGURA_MCP_API_KEY = "kagura_short_and_longer";
    const h = harness({
      onPath: { codex: "/usr/bin/codex" },
      exec: () => ({ code: 1, stdout: "", stderr: "kagura_short_and_longer kagura_short" }),
    });
    expect(await runCli(setup("codex"), h.deps)).toBe(1);
    expect(h.err).toContain("Error: `codex mcp add` failed: <redacted> <redacted>");
  });
});

describe("--name", () => {
  // The name is a bare positional in the codex and openclaw argv, where a
  // harness CLI would read `--help` as its own option, print its help and
  // exit 0 — a success report with nothing configured.
  const everywhere: Programs = { onPath: { codex: "/usr/bin/codex", openclaw: "/usr/bin/openclaw" } };
  const MESSAGE =
    "Error: Invalid value for '--name': use 1-64 letters, digits, '-' or '_', starting with a letter or digit";

  it.each([
    ["codex", "--help"],
    ["codex", "-h"],
    ["codex", "--no-probe"],
    ["codex", "_x"],
    ["codex", "kagura memory"],
    ["codex", "a.b"],
    ["codex", "x/y"],
    ["codex", ""],
    ["codex", "a".repeat(65)],
    ["openclaw", "--help"],
    ["openclaw", "-x"],
    ["hermes", "--help"],
  ])("setup %s --name=%s exits 2 and runs nothing", async (harnessName, name) => {
    const h = harness(everywhere);
    expect(await runCli(setup(harnessName, `--name=${name}`), h.deps)).toBe(2);
    expect(h.err).toContain(MESSAGE);
    expect(h.runs).toEqual([]);
  });

  it("takes a name with a dash or an underscore, up to 64 characters", async () => {
    const h = harness(everywhere);
    expect(await runCli(setup("codex", "--name=kagura-work_2"), h.deps)).toBe(0);
    expect(h.runs[0]!.slice(1, 4)).toEqual(["mcp", "add", "kagura-work_2"]);

    const long = harness(everywhere);
    expect(await runCli(setup("codex", `--name=${"a".repeat(64)}`), long.deps)).toBe(0);
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

// ---------------------------------------------------------------------------
// python-sdk#279: the MCP URL, Hermes's and OpenClaw's ?guardrails=, and
// OpenClaw's path variables
// ---------------------------------------------------------------------------

describe("the MCP URL (python-sdk#279)", () => {
  const everywhere: Programs = {
    onPath: { codex: "/usr/bin/codex", hermes: "/usr/bin/hermes", openclaw: "/usr/bin/openclaw" },
  };

  it.each(["codex", "hermes", "openclaw"])(
    "setup %s refuses an --mcp-url that is no http(s) URL with a host (exit 2), running nothing",
    async (name) => {
      // It goes on the harness argv after --url, where --help reads as an option.
      for (const url of [
        "--help",
        "",
        "memory.kagura-ai.com/mcp",
        "localhost:8080/mcp",
        "ftp://memory.kagura-ai.com/mcp",
        "https://",
        "https:/x.test/mcp",
        "https://?x=1",
        "https://[::1/mcp",
        "https://]x/mcp",
        "https://[notipv6]/mcp",
        "https://[1.2.3.4]/mcp",
        "https://x[::1]/mcp",
        "https://[::1]x/mcp",
        "https://℀.example/mcp",
      ]) {
        const h = harness(everywhere);
        expect(await runCli(["setup", name, `--mcp-url=${url}`], h.deps), url).toBe(2);
        expect(h.err, url).toEqual([MCP_URL_SHAPE]);
        expect(h.runs).toEqual([]);
      }
    },
  );

  it.each([
    "https://[::1]:8443/mcp",
    "https://[fe80::1%25eth0]/mcp",
    "https://[v1.x]/mcp",
    "http://[::1]:9000/mcp",
    "https://user@x.test:8443/mcp",
  ])("takes %s, which Python's urlsplit reads with a host", async (url) => {
    const h = harness(everywhere);
    expect(await runCli(["setup", "codex", "--mcp-url", url], h.deps)).toBe(0);
    expect(h.runs[0]![5]).toBe(url);
  });

  it.each(["codex", "openclaw"])(
    "setup %s writes the URL the checks read: padding, controls, tabs and newlines dropped",
    async (name) => {
      for (const given of [`  ${MCP_URL}\n`, `\x01${MCP_URL}\x1f`, "ht\ttps://x.test/m\ncp", `　${MCP_URL}`]) {
        const h = harness(everywhere);
        expect(await runCli(["setup", name, "--mcp-url", given], h.deps)).toBe(0);
        const argv = h.runs[0]!;
        expect(argv[argv.indexOf("--url") + 1]).toBe(MCP_URL);
        expect(report(h).mcp_url).toBe(MCP_URL);
      }
    },
  );

  it("setup hermes prints the URL the checks read", async () => {
    const h = harness({});
    expect(await runCli(["setup", "hermes", "--mcp-url", ` ${MCP_URL}\r\n`], h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain(`url: "${MCP_URL}"`);
    expect(report(h).mcp_url).toBe(MCP_URL);
  });

  it.each(["codex", "hermes", "openclaw"])("setup %s refuses plain HTTP in any spelling (exit 2)", async (name) => {
    for (const url of ["HTTP://example.com/mcp", " http://example.com/mcp", "hTtP://example.com/mcp"]) {
      const h = harness(everywhere);
      expect(await runCli(["setup", name, "--mcp-url", url], h.deps), url).toBe(2);
      expect(h.err, url).toEqual([
        `Error: Invalid value for '--mcp-url': MCP URL must use HTTPS for security (got: ${url.trim()}). ` +
          "HTTP is only allowed for localhost development.",
      ]);
      expect(h.runs).toEqual([]);
    }
  });

  it("refuses a configured mcp_url with no host (exit 1), naming --mcp-url", async () => {
    // A fallback only this port has, so no usage error.
    const h = harness(everywhere, { mcp_url: "memory.kagura-ai.com/mcp" });
    expect(await runCli(["setup", "codex"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: the configured mcp_url is refused: use an https:// URL, e.g. " +
        "https://memory.kagura-ai.com/mcp/w/<workspace-id>. Pass --mcp-url for another.",
    ]);
    expect(h.runs).toEqual([]);
  });

  it("reads a configured mcp_url as it reads --mcp-url", async () => {
    const h = harness(everywhere, { mcp_url: ` ${MCP_URL}\t` });
    expect(await runCli(["setup", "codex"], h.deps)).toBe(0);
    expect(h.runs[0]![5]).toBe(MCP_URL);
  });

  describe("an upper-case scheme", () => {
    // Python rebuilds a URL whose query it edits through urlunsplit, which
    // lower-cases the scheme; one it leaves alone stays as written.
    const local = "HTTP://127.0.0.1:47911/mcp/w/WS";

    it.each([
      ["codex", "", ["-c", CONTEXT], `http://127.0.0.1:47911/mcp/w/WS?guardrails=${CONTEXT}`],
      ["openclaw", `?guardrails=OFF&guardrails=${CONTEXT}`, [], "http://127.0.0.1:47911/mcp/w/WS?guardrails=off"],
      ["hermes", `?x=1&guardrails=${CONTEXT}`, [], "http://127.0.0.1:47911/mcp/w/WS?x=1"],
    ])("is written lower-case by setup %s when the query (%j) is rewritten", async (name, query, extra, written) => {
      const h = harness(everywhere);
      expect(await runCli(["setup", name, "--mcp-url", `${local}${query}`, ...extra], h.deps)).toBe(0);
      expect(report(h).mcp_url).toBe(written);
    });

    it.each(["codex", "hermes", "openclaw"])("is kept by setup %s when nothing in the query changes", async (name) => {
      const h = harness(everywhere);
      expect(await runCli(["setup", name, "--mcp-url", `${local}?x=1`], h.deps)).toBe(0);
      expect(report(h).mcp_url).toBe(`${local}?x=1`);
    });
  });
});

describe.each(["hermes", "openclaw"] as const)("setup %s: a ?guardrails= in --mcp-url (python-sdk#279)", (name) => {
  const title = name === "hermes" ? "Hermes Agent" : "OpenClaw";
  const reach =
    `Guardrails reach ${title} through get_context_info (on by default) and the AGENTS.md export ` +
    "(--agents-md).";

  it.each([
    [`guardrails=${CONTEXT}&profile=core`, "a context"],
    [`profile=core&guardrails=${CONTEXT}&guardrails=off`, "a context first, the value the server reads"],
    [`guard%72ails=${CONTEXT}&profile=core`, "an encoded name, which the server decodes"],
    ["guardrails=typo&profile=core", "no context at all"],
  ])("drops %s (%s) with one warning", async (query) => {
    const h = harness({});
    expect(await runCli(setup(name, "--mcp-url", `${MCP_URL}?${query}`), h.deps)).toBe(0);
    expect(report(h).mcp_url).toBe(`${MCP_URL}?profile=core`);
    expect(notes(h).filter((n) => n.startsWith("Warning"))).toEqual([
      `Warning: ${title} does not read MCP instructions, so the ?guardrails= value in --mcp-url has no ` +
        `effect there and is not written. ${reach}`,
    ]);
    expect(`${h.out.join("\n")}${h.err.join("\n")}`).not.toContain(CONTEXT);
  });

  it("drops the whole query when guardrails was all of it", async () => {
    const h = harness({});
    expect(await runCli(setup(name, "--mcp-url", `${MCP_URL}?guardrails=${CONTEXT}`), h.deps)).toBe(0);
    expect(report(h).mcp_url).toBe(MCP_URL);
  });

  it("gives one warning when --guardrails and the URL both name a context", async () => {
    const h = harness({});
    const args = setup(name, "--mcp-url", `${MCP_URL}?guardrails=${CONTEXT}`, "--guardrails", CONTEXT);
    expect(await runCli(args, h.deps)).toBe(0);
    expect(report(h).mcp_url).toBe(MCP_URL);
    expect(notes(h).filter((n) => n.includes("does not read MCP instructions"))).toEqual([
      `Warning: ${title} does not read MCP instructions, so --guardrails and the ?guardrails= value in ` +
        `--mcp-url have no effect there and are not written. ${reach}`,
    ]);
  });

  it.each([
    ["profile=core&guardrails=off", "profile=core&guardrails=off"],
    ["guardrails=off&profile=core", "profile=core&guardrails=off"],
    [`guardrails=OFF&guardrails=${CONTEXT}`, "guardrails=off"],
    [`guardrails=%20Off%20&guard%72ails=${CONTEXT}`, "guardrails=off"],
  ])("keeps a first off (%s) alone, with its own warning", async (query, written) => {
    const h = harness({});
    expect(await runCli(setup(name, "--mcp-url", `${MCP_URL}?${query}`), h.deps)).toBe(0);
    expect(report(h).mcp_url).toBe(`${MCP_URL}?${written}`);
    expect(notes(h).filter((n) => n.startsWith("Warning"))).toEqual([
      "Warning: --mcp-url has ?guardrails=off, which removes the guardrails block from get_context_info: " +
        `${title} then gets no guardrails from Kagura.`,
    ]);
    expect(`${h.out.join("\n")}${h.err.join("\n")}`).not.toContain(CONTEXT);
  });

  it("leaves a URL without guardrails as written", async () => {
    const url = `${MCP_URL}?profile=core&tools=a,b`;
    const h = harness({});
    expect(await runCli(setup(name, "--mcp-url", url), h.deps)).toBe(0);
    expect(report(h).mcp_url).toBe(url);
    expect(notes(h).join("\n")).not.toContain("Warning");
  });
});

describe("setup openclaw: its path variables (python-sdk#279)", () => {
  it("strips OPENCLAW_STATE_DIR, which holds the config, the .env and the workspace", async () => {
    const state = path.join(sandbox, "oc-state");
    process.env.OPENCLAW_STATE_DIR = ` ${state} `;
    const h = harness({});
    expect(await runCli(setup("openclaw"), h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain(`Setup does not edit ${path.join(state, "openclaw.json")} itself`);
    expect(notes(h).join("\n")).toContain(`to ${path.join(state, ".env")} with an editor`);
    expect(notes(h)).toContain(RERUN(path.join(state, "workspace", "AGENTS.md"), "OpenClaw"));
    expect(`${notes(h).join("\n")}${h.err.join("\n")}`).not.toContain("~/.openclaw");
  });

  it.each([
    ["OPENCLAW_STATE_DIR", "~/oc-state", "~/oc-state/openclaw.json", "~/oc-state/workspace/AGENTS.md"],
    ["OPENCLAW_WORKSPACE_DIR", "~/oc-ws", "~/.openclaw/openclaw.json", "~/oc-ws/AGENTS.md"],
    ["OPENCLAW_CONFIG_PATH", " ~/conf/oc.json ", "~/conf/oc.json", "~/.openclaw/workspace/AGENTS.md"],
    ["OPENCLAW_STATE_DIR", "~", "~/openclaw.json", "~/workspace/AGENTS.md"],
  ])("expands a leading ~ in %s=%j", async (variable, value, config, workspace) => {
    process.env[variable] = value;
    const h = harness({});
    expect(await runCli(setup("openclaw"), h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain(`Setup does not edit ${config} itself`);
    expect(notes(h)).toContain(RERUN(workspace, "OpenClaw"));
  });

  it("takes a blank variable as unset", async () => {
    process.env.OPENCLAW_STATE_DIR = "   ";
    process.env.OPENCLAW_CONFIG_PATH = "";
    process.env.OPENCLAW_WORKSPACE_DIR = "\t";
    const h = harness({});
    expect(await runCli(setup("openclaw"), h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain("Setup does not edit ~/.openclaw/openclaw.json itself");
    expect(notes(h)).toContain(RERUN("~/.openclaw/workspace/AGENTS.md", "OpenClaw"));
  });

  it("leaves ~user as written rather than fail the whole setup, as Python does", async () => {
    process.chdir(sandbox);
    process.env.OPENCLAW_STATE_DIR = "~nosuchuser/oc";
    const h = harness({});
    expect(await runCli(setup("openclaw"), h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain(`Setup does not edit ${path.join("~nosuchuser", "oc", "openclaw.json")} itself`);
  });

  it.skipIf(process.platform === "win32")("keeps a .. in OPENCLAW_STATE_DIR, as pathlib does", async () => {
    process.env.OPENCLAW_STATE_DIR = "~/a/../b";
    const h = harness({});
    expect(await runCli(setup("openclaw"), h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain("Setup does not edit ~/a/../b/openclaw.json itself");
    expect(notes(h).join("\n")).toContain("to ~/a/../b/.env with an editor");
    expect(notes(h)).toContain(RERUN("~/a/../b/workspace/AGENTS.md", "OpenClaw"));
  });

  it.skipIf(process.platform === "win32")("joins onto a root without making it a // root", async () => {
    // Path("/") / "openclaw.json" is /openclaw.json; `//` is a root of its own.
    process.env.OPENCLAW_STATE_DIR = "/";
    const h = harness({});
    expect(await runCli(setup("openclaw", "--dry-run"), h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain("Setup does not edit /openclaw.json itself");
    expect(notes(h).at(-1)).toBe(
      "AGENTS.md: /workspace/AGENTS.md (not offered: this port never prompts; --agents-md writes it)",
    );
  });
});

describe.skipIf(process.platform === "win32")("a .. in a harness's home variable (pathlib keeps it)", () => {
  // ~/link points at ~/real/sub, so ~/link/.. is ~/real: the system
  // resolves the .. through the link, for Python's calls and for these,
  // where path.join would have folded ~/link/.. to ~.
  beforeEach(() => {
    fs.mkdirSync(path.join(home, "real", "sub"), { recursive: true });
    fs.symlinkSync(path.join(home, "real", "sub"), path.join(home, "link"));
  });

  it("setup codex reads the config.toml through the link", async () => {
    fs.mkdirSync(path.join(home, "real", "codex"));
    fs.writeFileSync(path.join(home, "real", "codex", "config.toml"), '[mcp_servers.kagura-memory]\nurl = "x"\n');
    process.env.CODEX_HOME = path.join(home, "link") + "/../codex";
    const h = harness({ onPath: { codex: "/usr/bin/codex" } });
    expect(await runCli(setup("codex"), h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: Nothing was written: a kagura-memory entry already exists in ~/link/../codex/config.toml; " +
        "re-run with --force to replace it.",
    ]);
  });

  it("setup codex exports to the AGENTS.md through the link", async () => {
    process.env.CODEX_HOME = path.join(home, "link") + "/../codex";
    const h = harness({ onPath: { codex: "/usr/bin/codex" } });
    expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
    expect(fs.readFileSync(path.join(home, "real", "codex", "AGENTS.md"), "utf-8")).toBe(EXPORT_BLOCK);
    expect(fs.existsSync(path.join(home, "codex"))).toBe(false);
    expect(notes(h)).toContain(`Wrote the guardrail block for context ${CONTEXT} in ~/link/../codex/AGENTS.md`);
    expect(report(h).wrote).toEqual([`${home}/link/../codex/AGENTS.md`]);
  });

  it("setup hermes names its config.yaml and .env with the ..", async () => {
    process.env.HERMES_HOME = path.join(home, "link") + "/../hermes";
    const h = harness({});
    expect(await runCli(setup("hermes"), h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain("Setup does not edit ~/link/../hermes/config.yaml itself");
    expect(notes(h).join("\n")).toContain("to ~/link/../hermes/.env with an editor");
  });

  it("setup openclaw exports to the workspace through the link", async () => {
    process.env.OPENCLAW_STATE_DIR = "~/link/../oc";
    const h = harness({ onPath: { openclaw: "/usr/bin/openclaw" } });
    expect(await runCli(setup("openclaw", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
    expect(fs.readFileSync(path.join(home, "real", "oc", "workspace", "AGENTS.md"), "utf-8")).toBe(EXPORT_BLOCK);
    expect(fs.existsSync(path.join(home, "oc"))).toBe(false);
    expect(notes(h)).toContain(`Done: openclaw wrote kagura-memory to ~/link/../oc/openclaw.json.`);
    expect(notes(h)).toContain(`Wrote the guardrail block for context ${CONTEXT} in ~/link/../oc/workspace/AGENTS.md`);
    expect(report(h).wrote).toEqual([`${home}/link/../oc/workspace/AGENTS.md`]);
  });
});

// ---------------------------------------------------------------------------
// --agents-md: the guardrail export (#57)
// ---------------------------------------------------------------------------

describe("--agents-md", () => {
  const codex: Programs = { onPath: { codex: "/usr/bin/codex" } };
  const openclaw: Programs = { onPath: { openclaw: "/usr/bin/openclaw" } };
  const codexAgents = () => path.join(home, ".codex", "AGENTS.md");
  const OTHER = "99999999-8888-7777-6666-555555555555";
  /** The refresh command's words for `target`. */
  const refresh = (target: string, context = CONTEXT) =>
    `The block is a snapshot; refresh it with: kagura-memory guardrails digest ${context} --out ${shellQuote(target)}`;

  describe("its flags", () => {
    it.each(["codex", "hermes", "openclaw"])("setup %s needs a context: this port never asks (exit 2)", async (name) => {
      for (const extra of [["-y"], []]) {
        const h = harness({});
        expect(await runCli(setup(name, "--agents-md", ...extra), h.deps)).toBe(2);
        expect(h.err).toEqual([
          "Error: --agents-md needs --context-id with -y or without a terminal: setup cannot ask which context.",
        ]);
        expect(h.resolved).toBe(0);
      }
    });

    it("does not count --guardrails off as a context", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--guardrails", "off", "--agents-md"), h.deps)).toBe(2);
      expect(h.runs).toEqual([]);
    });

    it.each(["codex", "hermes", "openclaw"])(
      "setup %s refuses a -c that is no UUID, even without --agents-md (exit 2)",
      async (name) => {
        // Python: `Without --profile` a name cannot be looked up; a padded
        // UUID is no UUID to uuid.UUID either.
        for (const value of ["proj", ` ${CONTEXT}`, `${CONTEXT}\n`, ""]) {
          const h = harness({ onPath: { [name]: `/usr/bin/${name}` } });
          expect(await runCli(setup(name, `--context-id=${value}`), h.deps), value).toBe(2);
          expect(h.err).toEqual([
            "Error: Without --profile, --context-id must be a context UUID: setup cannot list contexts.",
          ]);
          expect(h.runs).toEqual([]);
        }
      },
    );

    it("refuses a PATH of only whitespace (exit 2), in Python's words", async () => {
      process.chdir(sandbox);
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md= "), h.deps)).toBe(2);
      expect(h.err).toEqual([
        "Error: Invalid value for '--agents-md': the path is blank; name a file, or give --agents-md alone " +
          "for the default one",
      ]);
      expect(filesUnder(sandbox)).toEqual([]);
    });

    it("takes --agents-md=VALUE literally, as Python's _HarnessCommand does", async () => {
      process.chdir(sandbox);
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md=-y"), h.deps)).toBe(0);
      expect(fs.readFileSync(path.join(sandbox, "-y"), "utf-8")).toBe(EXPORT_BLOCK);
    });

    // Recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4).
    it("refuses a whitespace PATH given after a space too", async () => {
      process.chdir(sandbox);
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", "  ", "-y"), h.deps)).toBe(2);
      expect(h.err).toEqual([
        "Error: Invalid value for '--agents-md': the path is blank; name a file, or give --agents-md alone " +
          "for the default one",
      ]);
      expect(filesUnder(sandbox)).toEqual([]);
    });

    it.each(["--dry-run", "-"])("takes --agents-md=%s as the file's name", async (value) => {
      process.chdir(sandbox);
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, `--agents-md=${value}`), h.deps)).toBe(0);
      expect(fs.readFileSync(path.join(sandbox, value), "utf-8")).toBe(EXPORT_BLOCK);
      expect(fs.existsSync(codexAgents())).toBe(false);
      expect(notes(h)).not.toContain("Dry run: nothing is written, run or fetched.");
    });

    it("reads --agents-md= as the default file, and a dash-led word after a space as the next option", async () => {
      for (const argv of [["--agents-md="], ["--agents-md", "-y"]]) {
        fs.rmSync(path.join(home, ".codex"), { recursive: true, force: true });
        const h = harness(codex);
        expect(await runCli(setup("codex", "-c", CONTEXT, ...argv), h.deps)).toBe(0);
        expect(fs.readFileSync(codexAgents(), "utf-8")).toBe(EXPORT_BLOCK);
      }
    });

    it("given alone before another option, means the default file", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--agents-md", "-c", CONTEXT), h.deps)).toBe(0);
      expect(fs.readFileSync(codexAgents(), "utf-8")).toBe(EXPORT_BLOCK);
    });
  });

  describe("setup codex", () => {
    it("writes the block into ~/.codex/AGENTS.md after the entry, with the credential it resolved", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      expect(fs.readFileSync(codexAgents(), "utf-8")).toBe(EXPORT_BLOCK);
      expect(h.events).toEqual(["run codex", "fetch"]);
      expect(h.resolved).toBe(1);
      const request = h.rest.requests[0]!;
      const url = new URL(request.url);
      expect(`${url.origin}${url.pathname}`).toBe("https://x.test/api/v1/memory/guardrails/digest");
      expect([...url.searchParams]).toEqual([
        ["context_id", CONTEXT],
        ["target", "export"],
      ]);
      expect(request.headers.authorization).toBe(`Bearer ${EXPORT_KEY}`);
      const r = report(h);
      expect(r.status).toBe("success");
      expect(r.wrote).toEqual([codexAgents()]);
      expect(r.notes.slice(-2)).toEqual([
        `Wrote the guardrail block for context ${CONTEXT} in ~/.codex/AGENTS.md`,
        refresh(codexAgents()),
      ]);
      // The lane still comes from -c: Codex reads the instructions.
      expect(h.runs[0]![5]).toBe(`${MCP_URL}?guardrails=${CONTEXT}`);
      expect(r.notes.join("\n")).not.toContain("Re-run with");
    });

    it("prefers an AGENTS.override.md that exists, as Codex reads it instead", async () => {
      const override = path.join(home, ".codex", "AGENTS.override.md");
      fs.mkdirSync(path.dirname(override), { recursive: true });
      fs.writeFileSync(override, "# Mine\n");
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      expect(fs.readFileSync(override, "utf-8")).toBe(`# Mine\n\n${EXPORT_BLOCK}`);
      expect(fs.existsSync(codexAgents())).toBe(false);
    });

    it("replaces only the marked block, and says when it is already up to date", async () => {
      const target = path.join(sandbox, "AGENTS.md");
      const old = EXPORT_BLOCK.replace(VERSION, "old").replace("head SHA", "old SHA");
      fs.writeFileSync(target, `# Top\n\n${old}\n## Bottom\n`);
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", target), h.deps)).toBe(0);
      expect(fs.readFileSync(target, "utf-8")).toBe(`# Top\n\n${EXPORT_BLOCK}\n## Bottom\n`);
      expect(report(h).wrote).toEqual([target]);

      const mtime = fs.statSync(target).mtimeMs;
      const again = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", target), again.deps)).toBe(0);
      expect(notes(again)).toContain(`Already up to date: the guardrail block for context ${CONTEXT} in ${target}`);
      expect(report(again).wrote).toEqual([]);
      expect(fs.statSync(target).mtimeMs).toBe(mtime);
    });

    it("keeps a CRLF file's line endings", async () => {
      const target = path.join(sandbox, "AGENTS.md");
      fs.writeFileSync(target, "# Top\r\n");
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", target), h.deps)).toBe(0);
      expect(fs.readFileSync(target, "utf-8")).toBe(`# Top\r\n\r\n${EXPORT_BLOCK.split("\n").join("\r\n")}`);
    });

    it("warns when the file is over the 32 KiB Codex reads", async () => {
      fs.mkdirSync(path.dirname(codexAgents()), { recursive: true });
      fs.writeFileSync(codexAgents(), `${"あ".repeat(11_000)}\n`); // 33,001 bytes, 11,001 characters
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      const size = fs.statSync(codexAgents()).size;
      expect(notes(h)).toContain(`Warning: ~/.codex/AGENTS.md is ${size} bytes; Codex reads only the first 32768.`);
    });

    it("counts the bytes on disk, CRLFs included, as Python 0.41.1 does", async () => {
      fs.mkdirSync(path.dirname(codexAgents()), { recursive: true });
      fs.writeFileSync(codexAgents(), "a\r\n".repeat(11_000)); // 33,000 bytes; 22,000 characters as text
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      const size = fs.statSync(codexAgents()).size;
      expect(notes(h)).toContain(`Warning: ~/.codex/AGENTS.md is ${size} bytes; Codex reads only the first 32768.`);
    });

    it("gives no size warning under the cap", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      expect(notes(h).join("\n")).not.toContain("reads only the first");
    });
  });

  describe("an empty digest", () => {
    it("writes nothing, and says why", async () => {
      const target = path.join(sandbox, "AGENTS.md");
      const h = harness(codex);
      h.rest.body = "";
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", target), h.deps)).toBe(0);
      expect(notes(h).at(-1)).toBe(
        `Context ${CONTEXT} has no tool guardrails this credential can see (none marked, or the context ` +
          `is not trusted-tier): nothing was written to ${target}.`,
      );
      expect(fs.existsSync(target)).toBe(false);
      expect(report(h).wrote).toEqual([]);
    });

    // Recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4) against a
    // digest server answering an empty body: `setup codex --url-form … --agents-md AGENTS.md -y`
    // turned "# Top\r\n\r\n<block>## Bottom\r\ntext\r\n" into "# Top\r\n## Bottom\r\ntext\r\n".
    it.each([
      ["lf", "\n"],
      ["crlf", "\r\n"],
    ])("removes an earlier block (%s), as guardrails digest --out does", async (_id, nl) => {
      const target = path.join(sandbox, "AGENTS.md");
      const block = EXPORT_BLOCK.split("\n").join(nl);
      fs.writeFileSync(target, `# Top${nl}${nl}${block}## Bottom${nl}text${nl}`);
      const h = harness(codex);
      h.rest.body = "";
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", target), h.deps)).toBe(0);
      expect(fs.readFileSync(target, "utf-8")).toBe(`# Top${nl}## Bottom${nl}text${nl}`);
      expect(notes(h).at(-1)).toBe(
        `Context ${CONTEXT} has no tool guardrails this credential can see (none marked, or the context ` +
          `is not trusted-tier): removed the earlier guardrail block from ${target}.`,
      );
      expect(report(h).wrote).toEqual([target]);
    });

    it("creates no file or directory without a block", async () => {
      const target = path.join(sandbox, "new-dir", "AGENTS.md");
      const h = harness(codex);
      h.rest.body = "  \n";
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", target), h.deps)).toBe(0);
      expect(notes(h).at(-1)).toBe(
        `Context ${CONTEXT} has no tool guardrails this credential can see (none marked, or the context ` +
          `is not trusted-tier): nothing was written to ${target}.`,
      );
      expect(fs.existsSync(path.join(sandbox, "new-dir"))).toBe(false);
    });

    it.each([
      ["two-blocks", Buffer.from(`# P\n\n${EXPORT_BLOCK}\n${EXPORT_BLOCK}`)],
      ["not-utf-8", Buffer.from([0xff, 0xfe, 0x20, 0x6e])],
    ])("leaves a file it cannot splice unchanged (%s), exit 1", async (_id, content) => {
      const target = path.join(sandbox, "AGENTS.md");
      fs.writeFileSync(target, content);
      const h = harness(codex);
      h.rest.body = "";
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", target), h.deps)).toBe(1);
      expect(h.err.at(-1)).toMatch(
        new RegExp(`^Error: The MCP entry is set up, but the AGENTS\\.md export failed: .*; left unchanged$`),
      );
      expect(fs.readFileSync(target)).toEqual(content);
    });
  });

  describe("a failed export", () => {
    const NOT_FOUND = JSON.stringify({ error: "RES-001", message: `Context not found: ${CONTEXT}`, details: {} });

    it("after the entry was applied: the report, then Python's error (exit 1)", async () => {
      const target = path.join(sandbox, "AGENTS.md");
      const h = harness(codex);
      h.rest.status = 404;
      h.rest.body = NOT_FOUND;
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", target), h.deps)).toBe(1);
      expect(report(h).applied_with).toMatch(/^codex mcp add kagura-memory /);
      expect(h.err.at(-1)).toBe(
        "Error: The MCP entry is set up, but the AGENTS.md export failed: context " +
          `${CONTEXT} is not visible to this credential on\n  https://x.test (404), or the server is ` +
          `older than v0.74.0.\n  Nothing was written to ${target}.`,
      );
      expect(fs.existsSync(target)).toBe(false);
    });

    it("says the entry was only printed when no harness CLI applied it", async () => {
      // As Python 0.41.1 says it (python-sdk #285).
      const target = path.join(sandbox, "AGENTS.md");
      for (const name of ["hermes", "codex"]) {
        const h = harness({});
        h.rest.status = 404;
        h.rest.body = NOT_FOUND;
        expect(await runCli(setup(name, "-c", CONTEXT, "--agents-md", target), h.deps)).toBe(1);
        expect(report(h).applied_with).toBeNull();
        expect(h.err.at(-1)).toMatch(
          /^Error: The MCP entry is printed for you to add, but the AGENTS.md export failed: context /,
        );
      }
    });

    it("reports any other failure with its message", async () => {
      const h = harness(codex);
      h.rest.status = 503;
      h.rest.body = JSON.stringify({ detail: "down" });
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", path.join(sandbox, "A.md")), h.deps)).toBe(1);
      expect(h.err.at(-1)).toBe("Error: The MCP entry is set up, but the AGENTS.md export failed: HTTP 503: down");
    });

    it("leaves a file with a broken block unchanged", async () => {
      const target = path.join(sandbox, "AGENTS.md");
      const broken = `# P\n\n${EXPORT_BLOCK}\n${EXPORT_BLOCK}`;
      fs.writeFileSync(target, broken);
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", target), h.deps)).toBe(1);
      expect(h.err.at(-1)).toBe(
        "Error: The MCP entry is set up, but the AGENTS.md export failed: " +
          `${target}: the file has more than one guardrail block, or a broken one; fix it by hand; left unchanged`,
      );
      expect(fs.readFileSync(target, "utf-8")).toBe(broken);
    });

    it("leaves unchanged a PATH whose parent is a file, in Node's words", async () => {
      fs.writeFileSync(path.join(sandbox, "afile"), "x");
      const target = path.join(sandbox, "afile", "A.md");
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", target), h.deps)).toBe(1);
      const last = h.err.at(-1)!;
      expect(last.startsWith(`Error: The MCP entry is set up, but the AGENTS.md export failed: ${target}: `)).toBe(true);
      expect(last.endsWith("; left unchanged")).toBe(true);
    });
  });

  describe("its credential", () => {
    it("is the CLI chain's, from the configuration setup loaded", async () => {
      const seen: ResolveAuthOptions[] = [];
      const h = harness(
        {
          ...codex,
          auth: (options) => {
            seen.push(options);
            return EXPORT_AUTH;
          },
        },
        { api_key: "kagura_cfg" },
      );
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      expect(seen).toEqual([{ apiKey: null, mcpUrl: null, profile: null, config: { api_key: "kagura_cfg" } }]);
    });

    it("stops setup before the harness runs when there is none (exit 1)", async () => {
      const h = harness({
        ...codex,
        auth: () => {
          throw new KaguraAuthError("No credentials found.\n  Run: kagura auth login");
        },
      });
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", path.join(sandbox, "A.md")), h.deps)).toBe(1);
      expect(h.err).toEqual(["Error: The AGENTS.md export has no credential: No credentials found.\n  Run: kagura auth login"]);
      expect(h.runs).toEqual([]);
      expect(h.rest.requests).toEqual([]);
      expect(h.out).toEqual([]);
    });

    it.each([false, true])("must be for the entry's server, in a dry run too (dry run: %s)", async (dryRun) => {
      const h = harness({
        ...openclaw,
        auth: { kind: "static", apiKey: EXPORT_KEY, mcpUrl: "https://memory.kagura-ai.com/mcp", source: "env" },
      });
      const args = [
        "setup",
        "openclaw",
        "--mcp-url",
        "https://kagura.example.com/mcp/w/ws-1",
        "-c",
        CONTEXT,
        "--agents-md",
        path.join(sandbox, "A.md"),
        ...(dryRun ? ["--dry-run"] : []),
      ];
      expect(await runCli(args, h.deps)).toBe(1);
      // Python says to pass --profile, which is inert here; KAGURA_PROFILE
      // would change nothing either while KAGURA_API_KEY, which outranks
      // it, is set.
      expect(h.err).toEqual([
        "Error: Nothing was written: the AGENTS.md export would use the KAGURA_API_KEY env credential,\n" +
          "  which is for https://memory.kagura-ai.com, but --mcp-url is on https://kagura.example.com.\n" +
          "  Set KAGURA_MCP_URL to that server for KAGURA_API_KEY, or unset\n" +
          "  KAGURA_API_KEY and set KAGURA_PROFILE to a login on it.",
      ]);
      expect(h.runs).toEqual([]);
      expect(h.rest.requests).toEqual([]);
      expect(filesUnder(sandbox).filter((f) => !f.startsWith(home))).toEqual([]);
    });

    it("names KAGURA_PROFILE first for a .kagura.json credential, which a profile outranks", async () => {
      const h = harness({
        ...codex,
        auth: { kind: "static", apiKey: EXPORT_KEY, mcpUrl: "https://memory.kagura-ai.com/mcp", source: "config" },
      });
      const args = ["setup", "codex", "--mcp-url", "https://kagura.example.com/mcp", "-c", CONTEXT, "--agents-md"];
      expect(await runCli(args, h.deps)).toBe(1);
      expect(h.err).toEqual([
        "Error: Nothing was written: the AGENTS.md export would use the .kagura.json credential,\n" +
          "  which is for https://memory.kagura-ai.com, but --mcp-url is on https://kagura.example.com.\n" +
          "  Set KAGURA_PROFILE to a login on that server, or KAGURA_MCP_URL to it for\n" +
          "  KAGURA_API_KEY.",
      ]);
    });

    it.each([
      ["https://x.test/", "https://x.test/mcp/w/ws-1"],
      ["https://x.test/mcp", "https://x.test/"],
      ["https://x.test//", "https://x.test/mcp/"],
      ["https://X.TEST/mcp/", "https://x.test"],
    ])("takes %s and --mcp-url %s for one server, trailing slashes stripped as Python does", async (own, entry) => {
      const target = path.join(sandbox, "A.md");
      const h = harness({ ...codex, auth: { ...EXPORT_AUTH, mcpUrl: own } });
      const args = ["setup", "codex", "--mcp-url", entry, "-c", CONTEXT, "--agents-md", target];
      expect(await runCli(args, h.deps)).toBe(0);
      expect(fs.readFileSync(target, "utf-8")).toBe(EXPORT_BLOCK);
    });

    it("reads a padded configured mcp_url as the entry's URL is read", async () => {
      // The fallback only this port has: the entry gets the URL normalized,
      // and the .kagura.json credential beside it names the same server.
      const padded = " https://x.test/mcp/w/ws-1\t";
      const target = path.join(sandbox, "A.md");
      const h = harness(
        { ...codex, auth: { kind: "static", apiKey: EXPORT_KEY, mcpUrl: padded, source: "config" } },
        { api_key: EXPORT_KEY, mcp_url: padded },
      );
      expect(await runCli(["setup", "codex", "-c", CONTEXT, "--agents-md", target], h.deps)).toBe(0);
      expect(h.runs[0]![5]).toBe(`https://x.test/mcp/w/ws-1?guardrails=${CONTEXT}`);
      expect(new URL(h.rest.requests[0]!.url).host).toBe("x.test");
      expect(fs.readFileSync(target, "utf-8")).toBe(EXPORT_BLOCK);
    });

    it("still refuses another server behind the padding and slashes", async () => {
      const h = harness({ ...codex, auth: { ...EXPORT_AUTH, mcpUrl: " https://y.test/ " } });
      const args = ["setup", "codex", "--mcp-url", "https://x.test/", "-c", CONTEXT, "--agents-md"];
      expect(await runCli(args, h.deps)).toBe(1);
      expect(h.err[0]).toContain("  which is for https://y.test, but --mcp-url is on https://x.test.\n");
      expect(h.runs).toEqual([]);
    });

    it("names an OAuth profile, and says 'the MCP URL' for the configured one", async () => {
      const oauth = {
        kind: "oauth",
        oauth: { getAuthHeader: async () => "Bearer t" },
        mcpUrl: "https://memory.kagura-ai.com/mcp",
        workspaceId: null,
      } as ResolvedAuth;
      const h = harness({ ...codex, auth: oauth }, { mcp_url: "https://kagura.example.com/mcp" });
      expect(await runCli(["setup", "codex", "-c", CONTEXT, "--agents-md"], h.deps)).toBe(1);
      expect(h.err[0]).toBe(
        "Error: Nothing was written: the AGENTS.md export would use the OAuth profile " +
          "(~/.kagura/credentials.json) credential,\n  which is for https://memory.kagura-ai.com, but the MCP " +
          "URL is on https://kagura.example.com.\n  Set KAGURA_PROFILE to a login on that server, or " +
          "KAGURA_MCP_URL to it for\n  KAGURA_API_KEY.",
      );
    });

    it("compares servers by scheme and host in any case, and not by the workspace path", async () => {
      const h = harness({ ...codex, auth: { ...EXPORT_AUTH, mcpUrl: "HTTPS://X.TEST/mcp/w/other?profile=core" } });
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      expect(new URL(h.rest.requests[0]!.url).host).toBe("x.test");
    });

    it("is not looked at when an existing entry stops setup first", async () => {
      fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(home, ".codex", "config.toml"), '[mcp_servers.kagura-memory]\nurl = "https://old"\n');
      const h = harness({
        ...codex,
        auth: () => {
          throw new KaguraAuthError("No credentials found.");
        },
      });
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(1);
      expect(h.err).toEqual([
        "Error: Nothing was written: a kagura-memory entry already exists in ~/.codex/config.toml; re-run " +
          "with --force to replace it.",
      ]);
      expect(h.resolved).toBe(0);
    });

    it("never reaches output, argv or a file", async () => {
      process.chdir(sandbox);
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      expect(h.out.join("\n")).not.toContain(EXPORT_KEY);
      expect(h.err.join("\n")).not.toContain(EXPORT_KEY);
      expect(h.runs.flat().join(" ")).not.toContain(EXPORT_KEY);
      for (const file of filesUnder(sandbox)) expect(fs.readFileSync(file, "utf-8")).not.toContain(EXPORT_KEY);
    });
  });

  describe("under --dry-run", () => {
    it.each([
      ["no file", null, "create"],
      ["a file without a block", "# Mine\n", "append the block to"],
      ["a file with a block", EXPORT_BLOCK, "replace the block in"],
      ["a file with a CRLF block", EXPORT_BLOCK.split("\n").join("\r\n"), "replace the block in"],
      ["a file that is not UTF-8", Buffer.from([0xff, 0xfe, 0x20]), "update"],
    ])("names what it would do to %s, and fetches and writes nothing", async (_label, content, action) => {
      const target = path.join(sandbox, "AGENTS.md");
      if (content !== null) fs.writeFileSync(target, content);
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", target, "--dry-run"), h.deps)).toBe(0);
      expect(notes(h).at(-1)).toBe(`AGENTS.md: would ${action} ${target} (the guardrail block for context ${CONTEXT})`);
      expect(h.rest.requests).toEqual([]);
      expect(h.runs).toEqual([]);
      // The credential is settled all the same; it is only read.
      expect(h.resolved).toBe(1);
      if (content === null) expect(fs.existsSync(target)).toBe(false);
      else expect(fs.readFileSync(target)).toEqual(Buffer.from(content));
      expect(report(h).wrote).toEqual([]);
    });

    it("says where it would stop, what it would run with --force, and the export", async () => {
      fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(home, ".codex", "config.toml"), '[mcp_servers.kagura-memory]\nurl = "https://old"\n');
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", "--dry-run"), h.deps)).toBe(0);
      expect(notes(h)).toEqual([
        "Dry run: nothing is written, run or fetched.",
        "Setup would stop here: a kagura-memory entry already exists in ~/.codex/config.toml; re-run with " +
          "--force to replace it.",
        `With --force, would run: codex mcp add kagura-memory --url '${MCP_URL}?guardrails=${CONTEXT}' ` +
          "--bearer-token-env-var KAGURA_API_KEY",
        `AGENTS.md: would create ~/.codex/AGENTS.md (the guardrail block for context ${CONTEXT})`,
      ]);
    });

    it.each([
      ["openclaw", () => "~/.openclaw/workspace/AGENTS.md"],
      ["hermes", () => path.join(fs.realpathSync(sandbox), "AGENTS.md")],
    ])("setup %s without it says where the export would go", async (name, file) => {
      process.chdir(sandbox);
      const plain = harness({});
      expect(await runCli(setup(name, "--dry-run"), plain.deps)).toBe(0);
      expect(notes(plain).at(-1)).toBe(`AGENTS.md: ${file()} (not offered: this port never prompts; --agents-md writes it)`);

      const quiet = harness({});
      expect(await runCli(setup(name, "--dry-run", "-y"), quiet.deps)).toBe(0);
      expect(notes(quiet).at(-1)).toBe(`AGENTS.md: ${file()} (not offered with -y; --agents-md writes it)`);
      expect(notes(quiet).join("\n")).not.toContain("Re-run with");
    });

    it("setup codex without it says nothing of AGENTS.md", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--dry-run"), h.deps)).toBe(0);
      expect(notes(h).join("\n")).not.toContain("AGENTS.md");
    });
  });

  describe("setup hermes", () => {
    it("writes the context file Hermes loads here, and notes its prompt-injection scan", async () => {
      process.chdir(sandbox);
      fs.writeFileSync("CLAUDE.md", "# Claude\n");
      const h = harness({});
      expect(await runCli(setup("hermes", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      expect(fs.readFileSync("CLAUDE.md", "utf-8")).toBe(`# Claude\n\n${EXPORT_BLOCK}`);
      const target = path.join(fs.realpathSync(sandbox), "CLAUDE.md");
      expect(notes(h).slice(-3)).toEqual([
        `Wrote the guardrail block for context ${CONTEXT} in ${target}`,
        refresh(target),
        "Hermes scans context files for prompt injection and skips a file it flags; if it reports CLAUDE.md " +
          "as blocked, delete the block between the kagura-memory:guardrails markers.",
      ]);
      expect(notes(h).join("\n")).not.toContain("Re-run with");
      expect(report(h).wrote).toEqual([target]);
    });

    it.each([
      [[], "AGENTS.md"],
      [["CLAUDE.md"], "CLAUDE.md"],
      [["CLAUDE.md", "AGENTS.md"], "AGENTS.md"],
      [["AGENTS.md", "AGENTS.override.md"], "AGENTS.override.md"],
      [["AGENTS.md", "HERMES.md"], "HERMES.md"],
      [["HERMES.md", ".hermes.md", "CLAUDE.md"], ".hermes.md"],
    ])("with %j here, picks %s, as Hermes does", async (present, expected) => {
      process.chdir(sandbox);
      for (const file of present) fs.writeFileSync(file, "x");
      const h = harness({});
      expect(await runCli(setup("hermes", "-c", CONTEXT, "--agents-md", "--dry-run"), h.deps)).toBe(0);
      expect(notes(h).at(-1)).toContain(
        `${path.join(fs.realpathSync(sandbox), expected)} (the guardrail block for context ${CONTEXT})`,
      );
    });

    /** Files (name → content) under the sandbox, their directories created. */
    function layout(files: Record<string, string | Buffer>): void {
      for (const [name, text] of Object.entries(files)) {
        const target = path.join(sandbox, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
      }
    }

    // The layouts of python-sdk #278 and the Python SDK 0.42.0's
    // TestHermesPaths.test_the_export_goes_where_hermes_loads_it, recorded
    // from its hermes_context_file.
    it.each([
      ["root-hermes-md", { ".git/x": "", ".hermes.md": "own", "sub/x": "" }, "sub", ".hermes.md"],
      ["root-hermes-md-over-sub-agents", { ".git/x": "", ".hermes.md": "own", "sub/AGENTS.md": "agents" }, "sub", ".hermes.md"],
      ["agents-chain-from-root", { ".git/x": "", "AGENTS.md": "root", "sub/CLAUDE.md": "claude" }, "sub", "sub/AGENTS.md"],
      ["empty-hermes-md", { ".hermes.md": "", "AGENTS.md": "agents" }, ".", "AGENTS.md"],
      ["empty-override", { "AGENTS.override.md": " \n", "AGENTS.md": "agents" }, ".", "AGENTS.md"],
      // On a case-insensitive filesystem, "agents.md"/"claude.md" are the
      // same file as "AGENTS.md"/"CLAUDE.md", so the probe (which checks the
      // upper-case spelling first) matches and returns that spelling instead
      // of the one actually on disk — as Python's `Path.is_file()` does too.
      ["lower-agents-md", { "agents.md": "agents" }, ".", CASE_INSENSITIVE_FS ? "AGENTS.md" : "agents.md"],
      ["lower-claude-md", { "claude.md": "claude" }, ".", CASE_INSENSITIVE_FS ? "CLAUDE.md" : "claude.md"],
      ["hermes-md-above-git-root", { ".hermes.md": "own", "repo/.git/x": "" }, "repo", "repo/AGENTS.md"],
      ["no-git-cwd-only", { ".hermes.md": "own", "sub/x": "" }, "sub", "sub/AGENTS.md"],
      ["empty-sub-hermes-md", { ".git/x": "", ".hermes.md": "own", "sub/.hermes.md": "" }, "sub", "sub/AGENTS.md"],
      ["empty-hermes-md-hides-HERMES-md", { ".hermes.md": "", "HERMES.md": "own" }, ".", "AGENTS.md"],
      ["bom-only-counts-as-text", { "AGENTS.md": "﻿", "CLAUDE.md": "claude" }, ".", "AGENTS.md"],
      // A lone 0xff byte: not UTF-8, read with errors="replace" as U+FFFD, which is text.
      ["not-utf-8-counts-as-text", { "AGENTS.md": Buffer.from([0xff]), "CLAUDE.md": "claude" }, ".", "AGENTS.md"],
    ])("puts the export where Hermes loads it (%s)", async (_id, files, cwd, expected) => {
      layout(files as Record<string, string | Buffer>);
      process.chdir(path.join(sandbox, cwd as string));
      const h = harness({});
      expect(await runCli(setup("hermes", "-c", CONTEXT, "--agents-md", "--dry-run"), h.deps)).toBe(0);
      expect(notes(h).at(-1)).toContain(
        `${path.join(fs.realpathSync(sandbox), expected as string)} (the guardrail block for context ${CONTEXT})`,
      );
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "counts a file it cannot read as empty",
      async () => {
        layout({ "CLAUDE.md": "claude", "AGENTS.md": "agents" });
        fs.chmodSync(path.join(sandbox, "AGENTS.md"), 0);
        try {
          process.chdir(sandbox);
          const h = harness({});
          expect(await runCli(setup("hermes", "-c", CONTEXT, "--agents-md", "--dry-run"), h.deps)).toBe(0);
          expect(notes(h).at(-1)).toContain(path.join(fs.realpathSync(sandbox), "CLAUDE.md"));
        } finally {
          fs.chmodSync(path.join(sandbox, "AGENTS.md"), 0o644);
        }
      },
    );

    describe("with only Cursor rules", () => {
      // Recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4), run
      // in $HOME with a .cursorrules: `setup hermes --url-form --mcp-url … --context-id C
      // --agents-md --dry-run -y` exits 1 with this error.
      const REASON =
        "Hermes loads only ~/.cursorrules here, and it loads the first context file type it finds: a new " +
        "AGENTS.md would stop it loading that file. Name the file with --agents-md PATH";

      beforeEach(() => {
        // pathLabel names files under the real home; a /tmp behind a link must not hide it.
        process.env.HOME = fs.realpathSync(home);
        fs.writeFileSync(path.join(home, ".cursorrules"), "rules");
        process.chdir(home);
      });

      it.each([[["--dry-run"]], [[]]])("stops --agents-md without a PATH before anything runs (%j)", async (extra) => {
        const h = harness({});
        expect(await runCli(setup("hermes", "-c", CONTEXT, "--agents-md", "-y", ...extra), h.deps)).toBe(1);
        expect(h.err.join("\n")).toBe(
          "Error: Nothing was written: Hermes loads only ~/.cursorrules here, and it loads the first context file\n" +
            "  type it finds: a new AGENTS.md would stop it loading that file. Name the file\n" +
            "  with --agents-md PATH.",
        );
        expect(h.out).toEqual([]);
        expect(h.rest.requests).toEqual([]);
        expect(fs.existsSync(path.join(home, "AGENTS.md"))).toBe(false);
      });

      it("writes a named PATH", async () => {
        const h = harness({});
        expect(await runCli(setup("hermes", "-c", CONTEXT, "--agents-md", "RULES.md"), h.deps)).toBe(0);
        expect(fs.readFileSync(path.join(home, "RULES.md"), "utf-8")).toBe(EXPORT_BLOCK);
      });

      it("says the export is not offered in a dry run, naming the file", async () => {
        const h = harness({});
        expect(await runCli(setup("hermes", "--dry-run"), h.deps)).toBe(0);
        expect(notes(h).at(-1)).toBe(`AGENTS.md: not offered. ${REASON}.`);
      });

      it("gives no Re-run hint", async () => {
        const h = harness({});
        expect(await runCli(setup("hermes", "-c", CONTEXT), h.deps)).toBe(0);
        expect(notes(h).join("\n")).not.toContain("Re-run with");
      });

      it("names a .cursor/rules file when there is no .cursorrules", async () => {
        fs.rmSync(path.join(home, ".cursorrules"));
        fs.mkdirSync(path.join(home, ".cursor", "rules"), { recursive: true });
        fs.writeFileSync(path.join(home, ".cursor", "rules", "b.mdc"), "b");
        fs.writeFileSync(path.join(home, ".cursor", "rules", "a.mdc"), "a");
        const h = harness({});
        expect(await runCli(setup("hermes", "--dry-run"), h.deps)).toBe(0);
        expect(notes(h).at(-1)).toMatch(/^AGENTS\.md: not offered\. Hermes loads only ~\/\.cursor\/rules\/a\.mdc here,/);
      });
    });

    it("passes over a directory of a context file's name", async () => {
      process.chdir(sandbox);
      fs.mkdirSync(".hermes.md");
      fs.writeFileSync("CLAUDE.md", "x");
      const h = harness({});
      expect(await runCli(setup("hermes", "-c", CONTEXT, "--agents-md", "--dry-run"), h.deps)).toBe(0);
      expect(notes(h).at(-1)).toContain(`${path.join(fs.realpathSync(sandbox), "CLAUDE.md")} (the guardrail block`);
    });

    it("exports the -c context, never the one it drops from --mcp-url", async () => {
      const target = path.join(sandbox, "A.md");
      const h = harness({});
      const args = ["setup", "hermes", "--mcp-url", `${MCP_URL}?guardrails=${OTHER}`, "-c", CONTEXT, "--agents-md", target];
      expect(await runCli(args, h.deps)).toBe(0);
      expect(new URL(h.rest.requests[0]!.url).searchParams.get("context_id")).toBe(CONTEXT);
      expect(report(h).mcp_url).toBe(MCP_URL);
    });

    it("exports -c over a --guardrails context", async () => {
      const h = harness({});
      const args = setup("hermes", "--guardrails", OTHER, "-c", CONTEXT, "--agents-md", path.join(sandbox, "A.md"));
      expect(await runCli(args, h.deps)).toBe(0);
      expect(new URL(h.rest.requests[0]!.url).searchParams.get("context_id")).toBe(CONTEXT);
    });
  });

  describe("setup openclaw", () => {
    const workspace = () => path.join(home, ".openclaw", "workspace", "AGENTS.md");

    it("exports a --guardrails context to its workspace, which it creates, writing no URL context", async () => {
      const h = harness(openclaw);
      expect(await runCli(setup("openclaw", "--guardrails", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      expect(fs.readFileSync(workspace(), "utf-8")).toBe(EXPORT_BLOCK);
      expect(h.runs[0]![5]).toBe(MCP_URL);
      expect(notes(h)).toContain(
        "Warning: OpenClaw does not read MCP instructions, so --guardrails has no effect there and is not " +
          "written. Guardrails reach OpenClaw through get_context_info (on by default) and the AGENTS.md " +
          "export (--agents-md).",
      );
      expect(notes(h)).toContain(`Wrote the guardrail block for context ${CONTEXT} in ~/.openclaw/workspace/AGENTS.md`);
    });

    it("puts it in $OPENCLAW_WORKSPACE_DIR, over the state directory", async () => {
      const state = path.join(sandbox, "oc-state");
      const ws = path.join(sandbox, "ws");
      process.env.OPENCLAW_STATE_DIR = state;
      process.env.OPENCLAW_WORKSPACE_DIR = ` ${ws} `;
      const h = harness(openclaw);
      expect(await runCli(setup("openclaw", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      expect(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf-8")).toBe(EXPORT_BLOCK);
      expect(fs.existsSync(path.join(state, "workspace"))).toBe(false);
      // The config and the key's .env stay in the state directory.
      expect(notes(h)).toContain(`Done: openclaw wrote kagura-memory to ${path.join(state, "openclaw.json")}.`);
    });

    it("warns past the 20,000 characters OpenClaw reads", async () => {
      fs.mkdirSync(path.dirname(workspace()), { recursive: true });
      fs.writeFileSync(workspace(), `${"x".repeat(20_001)}\n`);
      const h = harness(openclaw);
      expect(await runCli(setup("openclaw", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      const size = [...fs.readFileSync(workspace(), "utf-8")].length;
      expect(notes(h)).toContain(
        `Warning: ~/.openclaw/workspace/AGENTS.md is ${size} characters; OpenClaw reads only the first 20000.`,
      );
    });

    it("counts characters, not bytes", async () => {
      fs.mkdirSync(path.dirname(workspace()), { recursive: true });
      fs.writeFileSync(workspace(), `${"あ".repeat(10_000)}\n`); // 30,001 bytes, 10,001 characters
      const h = harness(openclaw);
      expect(await runCli(setup("openclaw", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      expect(notes(h).join("\n")).not.toContain("reads only the first");
    });

    // Recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4).
    it("counts a CRLF as two characters, as Python's read_bytes().decode() does", async () => {
      // python-sdk #285: 21,000 characters as written, 14,000 once CRLF is folded.
      fs.mkdirSync(path.dirname(workspace()), { recursive: true });
      fs.writeFileSync(workspace(), "x\r\n".repeat(7_000));
      const h = harness(openclaw);
      expect(await runCli(setup("openclaw", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      const size = [...new TextDecoder("utf-8", { ignoreBOM: true }).decode(fs.readFileSync(workspace()))].length;
      expect(size).toBeGreaterThan(20_000);
      expect(notes(h)).toContain(
        `Warning: ~/.openclaw/workspace/AGENTS.md is ${size} characters; OpenClaw reads only the first 20000.`,
      );
    });

    it("counts a BOM as one character and an astral character as one, as len(str) does", async () => {
      // 20,002 code points in 80,004 bytes and 40,002 UTF-16 units: Python's
      // `len(raw.decode("utf-8"))` keeps U+FEFF and counts U+1F600 once. The
      // count is of the file as written, export block included.
      fs.mkdirSync(path.dirname(workspace()), { recursive: true });
      fs.writeFileSync(workspace(), `\ufeff${"\u{1F600}".repeat(20_000)}\n`);
      const codePoints = () => [...new TextDecoder("utf-8", { ignoreBOM: true }).decode(fs.readFileSync(workspace()))].length;
      expect(codePoints()).toBe(20_002);
      const h = harness(openclaw);
      expect(await runCli(setup("openclaw", "-c", CONTEXT, "--agents-md"), h.deps)).toBe(0);
      const size = codePoints();
      expect(size).toBeGreaterThan(20_002);
      expect(size).toBeLessThan(21_000); // 40,002 and more if UTF-16 units were counted
      expect(notes(h)).toContain(
        `Warning: ~/.openclaw/workspace/AGENTS.md is ${size} characters; OpenClaw reads only the first 20000.`,
      );
    });
  });

  describe("its PATH", () => {
    it("keeps ~user as written, as a relative path (python-sdk #285)", async () => {
      process.chdir(sandbox);
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", "~no-such-user-285/AGENTS.md"), h.deps)).toBe(0);
      expect(fs.readFileSync(path.join(sandbox, "~no-such-user-285", "AGENTS.md"), "utf-8")).toBe(EXPORT_BLOCK);
      // Named as `str(Path(...))` names it: on Windows `/` reads as `\`, so
      // Python there says `~no-such-user-285\AGENTS.md`.
      const label = path.join("~no-such-user-285", "AGENTS.md");
      expect(notes(h)).toContain(`Wrote the guardrail block for context ${CONTEXT} in ${label}`);
    });

    it("expands a leading ~", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", "~/notes/n.md"), h.deps)).toBe(0);
      expect(fs.readFileSync(path.join(home, "notes", "n.md"), "utf-8")).toBe(EXPORT_BLOCK);
      expect(notes(h)).toContain(`Wrote the guardrail block for context ${CONTEXT} in ~/notes/n.md`);
    });

    it("stays relative in what setup says, and gets its directories created", async () => {
      process.chdir(sandbox);
      const relative = path.join("sub", "dir", "big.md");
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", relative), h.deps)).toBe(0);
      expect(fs.readFileSync(relative, "utf-8")).toBe(EXPORT_BLOCK);
      expect(notes(h).slice(-2)).toEqual([
        `Wrote the guardrail block for context ${CONTEXT} in ${relative}`,
        refresh(relative),
      ]);
      expect(report(h).wrote).toEqual([path.resolve(relative)]);
    });

    it.skipIf(process.platform === "win32").each([
      // Python's _path_label: relative_to(Path.home()) compares segments,
      // resolving nothing, and `..notes` is a name like any other.
      ["~/x/../y//z.md", "~/x/../y/z.md"],
      ["~/..notes/A.md", "~/..notes/A.md"],
      ["~/./a/./b.md", "~/a/b.md"],
    ])("under ~ as %j, is named %s, as Python names it", async (given, label) => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", given, "--dry-run"), h.deps)).toBe(0);
      expect(notes(h).at(-1)).toBe(`AGENTS.md: would create ${label} (the guardrail block for context ${CONTEXT})`);
    });

    it.skipIf(process.platform === "win32")("outside ~ is named in full, however it starts", async () => {
      // A sibling of home whose name starts with home's own.
      const target = `${home}x/A.md`;
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", target, "--dry-run"), h.deps)).toBe(0);
      expect(notes(h).at(-1)).toBe(`AGENTS.md: would create ${target} (the guardrail block for context ${CONTEXT})`);
    });

    it.skipIf(process.platform === "win32")("is named as Python's pathlib names it", async () => {
      process.chdir(sandbox);
      fs.mkdirSync("x");
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", ".//x/../X.md/"), h.deps)).toBe(0);
      expect(notes(h)).toContain(`Wrote the guardrail block for context ${CONTEXT} in x/../X.md`);
      expect(fs.readFileSync("X.md", "utf-8")).toBe(EXPORT_BLOCK);
    });

    it.skipIf(process.platform === "win32")("follows a link, which stays a link", async () => {
      process.chdir(sandbox);
      fs.writeFileSync("CLAUDE.md", "# Claude\n");
      fs.symlinkSync("CLAUDE.md", "AGENTS.md");
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", CONTEXT, "--agents-md", "AGENTS.md"), h.deps)).toBe(0);
      expect(fs.lstatSync("AGENTS.md").isSymbolicLink()).toBe(true);
      expect(fs.readFileSync("CLAUDE.md", "utf-8")).toBe(`# Claude\n\n${EXPORT_BLOCK}`);
    });
  });

  it("names the context canonically wherever it appears", async () => {
    const h = harness(codex);
    const target = path.join(sandbox, "A.md");
    expect(await runCli(setup("codex", "-c", CONTEXT.toUpperCase().replace(/-/g, ""), "--agents-md", target), h.deps)).toBe(0);
    expect(new URL(h.rest.requests[0]!.url).searchParams.get("context_id")).toBe(CONTEXT);
    expect(notes(h)).toContain(refresh(target));
  });
});

describe("help (python-sdk#279, #57)", () => {
  it.each([
    [
      "codex",
      "Also write the context's tool guardrail export block into PATH (default ~/.codex/AGENTS.md, or " +
        "AGENTS.override.md when it exists). Rarely needed: the digest already arrives in the MCP " +
        "instructions. Only the marked block changes.",
    ],
    [
      "hermes",
      "Write the context's tool guardrail export block into PATH (default: the context file Hermes loads " +
        "from here: the nearest .hermes.md or HERMES.md up to the git root, else this directory's AGENTS " +
        "file, else its CLAUDE.md, else a new AGENTS.md; none when only Cursor rules load, which a new " +
        "AGENTS.md would stop loading). Only the marked block changes; an empty set removes it.",
    ],
    [
      "openclaw",
      "Write the context's tool guardrail export block into PATH (default AGENTS.md in the workspace " +
        "OpenClaw loads every session: $OPENCLAW_WORKSPACE_DIR, else workspace/ in $OPENCLAW_STATE_DIR or " +
        "~/.openclaw). Only the marked block changes.",
    ],
  ])("setup %s shows --agents-md [PATH] after --guardrails, in Python's words", async (name, help) => {
    const h = harness({});
    expect(await runCli(["setup", name, "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/^\s+--agents-md \[PATH\]/m);
    // Python's option order: --guardrails, --agents-md, then --url-form.
    const line = (flag: string) => text.split("\n").findIndex((l) => l.trimStart().startsWith(flag));
    expect(line("--guardrails")).toBeLessThan(line("--agents-md"));
    expect(line("--agents-md")).toBeLessThan(line("--url-form"));
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain(help);
    expect(flat).toContain("Show the command or block, the entry and the AGENTS.md step; change nothing");
    expect(flat).toContain(
      "MCP server name in the harness config: 1-64 letters, digits, '-' or '_', starting with a letter or digit",
    );
    expect(flat).toContain("Context ID, for the guardrails lane and the AGENTS.md export only: a UUID");
    expect(flat).toContain("The MCP URL must be an http(s) URL with a host.");
  });

  it.each(["Hermes", "OpenClaw"])("setup %s describes --guardrails in Python's words", async (title) => {
    const h = harness({});
    expect(await runCli(["setup", title.toLowerCase(), "--help"], h.deps)).toBe(0);
    expect(h.out.join("\n").replace(/\s+/g, " ")).toContain(
      `Never written: ${title} does not read MCP instructions. 'off' is refused (it would remove the ` +
        `get_context_info guardrails block, ${title}'s only guardrail lane); a context UUID only picks the ` +
        "AGENTS.md export's context. A ?guardrails= context in --mcp-url is dropped too.",
    );
  });

  it("setup openclaw describes --api-key-env in Python's words", async () => {
    const h = harness({});
    expect(await runCli(["setup", "openclaw", "--help"], h.deps)).toBe(0);
    expect(h.out.join("\n").replace(/\s+/g, " ")).toContain(
      "The variable the Authorization header references, kept in OpenClaw's .env ($OPENCLAW_STATE_DIR, " +
        "else ~/.openclaw; default KAGURA_API_KEY)",
    );
  });
});
