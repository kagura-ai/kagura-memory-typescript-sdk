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

import type { ExecOptions, ExecResult } from "../../../src/cli/exec.js";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { loadConfig, type KaguraConfig } from "../../../src/config.js";

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  /** Every program `execFile` was asked to run, as `[file, ...argv]`. */
  runs: string[][];
  /** The timeout each of those runs was given, in the same order. */
  timeouts: (number | undefined)[];
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
  const timeouts: (number | undefined)[] = [];
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => true,
    which: (name: string) => programs.onPath?.[name] ?? null,
    execFile: async (file: string, argv: readonly string[], options?: ExecOptions) => {
      runs.push([file, ...argv]);
      timeouts.push(options?.timeoutMs);
      return programs.exec?.(file, argv) ?? { code: 0, stdout: "", stderr: "" };
    },
    loadConfig: () => (config === "disk" ? loadConfig() : config),
  } as unknown as CliDeps;
  return { deps, out, err, runs, timeouts };
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
  // KAGURA_API_KEY too: a developer's own must not leak into what the
  // no-secret assertions scan.
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
      expect(h.err).toEqual(["Error: Invalid JSON or encoding in .kagura.json (expected UTF-8)"]);
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

    it("with --url-form, is ignored with a note: this port never contacts the server", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "--url-form", "--profile", "work"), h.deps)).toBe(0);
      expect(notes(h)).toContain(
        "Note: --profile is not used: this port lists no contexts and writes no AGENTS.md export.",
      );
      expect(h.runs).toHaveLength(1);
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
          "Preview what it sends with the Python CLI: " +
          `KAGURA_MCP_URL='${MCP_URL}?guardrails=${CONTEXT}' kagura guardrails digest ${CONTEXT} --target instructions`,
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
          `kagura guardrails digest ${CONTEXT} --target instructions`,
      );
    });

    it("does not turn a non-UUID -c into a guardrails value the server would ignore", async () => {
      const h = harness(codex);
      expect(await runCli(setup("codex", "-c", "dev"), h.deps)).toBe(0);
      expect(addedUrl(h)).toBe(MCP_URL);
      expect(notes(h)).toContain(
        "Note: --context-id 'dev' is not a UUID, so it was not used for guardrails: this port looks up " +
          "no context names.",
      );
      expect(notes(h).join("\n")).not.toMatch(/tool guardrail digest/);
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
    ]);
  });

  it.each([
    ["without", {}],
    ["with", hermes],
  ])("prints the whole block %s hermes on PATH when it cannot read config.yaml, and exits 0", async (_, programs) => {
    // Python never reads config.yaml: it asks `hermes mcp list`, and without
    // hermes prints the block. A directory in its place fails any reader.
    fs.mkdirSync(configYaml(), { recursive: true });
    const h = harness(programs);
    expect(await runCli(setup("hermes"), h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain("Add this kagura-memory entry to it:\n\nmcp_servers:\n  kagura-memory:");
    expect(notes(h).join("\n")).toMatch(
      /^Note: setup could not read ~\/\.hermes\/config\.yaml \(.+\), so it did not look there for a kagura-memory entry\.$/m,
    );
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

    it("says to rewrite an inline mcp_servers value as a block first", async () => {
      fs.mkdirSync(hermesDir(), { recursive: true });
      fs.writeFileSync(configYaml(), "\uFEFFmcp_servers: {other: {url: x}}\n");
      const h = harness({});
      expect(await runCli(setup("hermes"), h.deps)).toBe(0);
      expect(h.err.join("\n")).not.toMatch(/^mcp_servers:/m);
      expect(notes(h).join("\n")).toContain(
        "~/.hermes/config.yaml writes its mcp_servers value inline (flow style or null); rewrite it as a block mapping",
      );
    });

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
        "~/.hermes/config.yaml already has a top-level mcp_servers: key, so only the kagura-memory entry is " +
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
          "not written. Guardrails reach Hermes Agent through get_context_info (on by default).",
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
        `Warning: Hermes Agent does not read MCP instructions, so the MCP URL's ?guardrails=${CONTEXT} has ` +
          "no effect there and is not written. Guardrails reach Hermes Agent through get_context_info " +
          "(on by default).",
      );
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

  it("-c is not used, and says so", async () => {
    const h = harness({});
    expect(await runCli(setup("hermes", "-c", CONTEXT), h.deps)).toBe(0);
    expect(notes(h)).toContain(
      "Note: --context-id is not used: Hermes Agent does not read MCP instructions, and this port writes " +
        "no AGENTS.md export.",
    );
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
