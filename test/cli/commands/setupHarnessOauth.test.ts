/**
 * `setup codex | hermes | openclaw --url-form --oauth` (python-sdk #282,
 * #284, #287): an entry with no key, which the harness signs in to itself,
 * written only once `GET /api/v1/system/info` confirms memory-cloud 0.77.0+.
 *
 * Expected sentences are recorded from the Python CLI 0.42.0 (click 8.3.3,
 * pydantic 2.13.4) against a fake memory-cloud on http://127.0.0.1:47701
 * and fake harness CLIs (a pty from `script` for the terminal cases), with
 * Python's wrapped lines joined by one space: here each is one `notes`
 * entry or one `Error:` line. Where a command names this bin, `kagura` is
 * `kagura-memory`.
 *
 * No process is spawned and no real PATH, network or credentials file is
 * read: `which`, `execFile`, `execAttached`, `stdinIsTty`, `fetch` and the
 * credential chain are the fakes below, and HOME points into a sandbox.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolveAuthOptions } from "../../../src/auth/resolve.js";
import type { ResolvedAuth } from "../../../src/auth/types.js";
import type { ExecResult } from "../../../src/cli/exec.js";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { loadConfig, type KaguraConfig } from "../../../src/config.js";
import { GUARDRAIL_VERSION_HEADER, MemoryClient } from "../../../src/memoryClient.js";
import { restClientFromAuth } from "../../../src/restBase.js";
import { FakeRest } from "../../fakeServer.js";

const U = "http://127.0.0.1:47701/mcp/w/ws-1";
const D = "http://127.0.0.1:47701";
const CONTEXT = "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c";
const OAUTH = ["--url-form", "--oauth", "--mcp-url", U];
const EXPORT_BLOCK =
  `<!-- kagura-memory:guardrails begin context=${CONTEXT} tool_triggered_version=abc -->\n` +
  "- (aaaaaaaa) Squash-merge only after the head SHA matches\n" +
  "<!-- kagura-memory:guardrails end -->\n";
/** A KAGURA_API_KEY credential on the entry's server. */
const ON_SERVER: ResolvedAuth = { kind: "static", apiKey: "kagura_export_key_0123456789", mcpUrl: U, source: "env" };
/** The same key, on another server. */
const ELSEWHERE: ResolvedAuth = { ...ON_SERVER, mcpUrl: "https://x.test/mcp" };

interface SystemInfo {
  /** The `version` the body carries; `undefined` leaves the key out. */
  version: unknown;
  status: number;
  requests: { url: string; headers: Record<string, string> }[];
  fetch: typeof globalThis.fetch;
}

function systemInfo(): SystemInfo {
  const s: SystemInfo = { version: "0.77.0", status: 200, requests: [], fetch: undefined as never };
  s.fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const url = String(input);
    s.requests.push({ url, headers });
    if (!url.endsWith("/api/v1/system/info") || s.status !== 200) {
      return new Response("{}", { status: s.status === 200 ? 404 : s.status });
    }
    const body = { name: "Kagura Memory Cloud", features: {}, ...(s.version === undefined ? {} : { version: s.version }) };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return s;
}

interface Options {
  /** Program name → the path `which` reports. */
  onPath?: Record<string, string>;
  /** A terminal on stdin. */
  tty?: boolean;
  /** What a captured run returns; a silent exit 0 by default. */
  exec?: (file: string, argv: readonly string[]) => ExecResult;
  /** The exit code of an attached run; 0 by default. */
  attached?: (file: string, argv: readonly string[]) => number;
  /** The credential the CLI chain resolves; {@link ELSEWHERE} by default. */
  auth?: ResolvedAuth | ((options: ResolveAuthOptions) => ResolvedAuth);
  /** What `loadConfig` returns; "disk" runs the real loader. */
  config?: KaguraConfig | "disk";
}

interface Oauth {
  deps: CliDeps;
  out: string[];
  err: string[];
  /** Captured runs (`execFile`), as `[file, ...argv]`. */
  runs: string[][];
  /** Attached runs (`execAttached`). */
  attached: string[][];
  server: SystemInfo;
  /** Runs, attached runs and digest fetches, in order. */
  events: string[];
}

function oauthHarness(o: Options = {}): Oauth {
  const out: string[] = [];
  const err: string[] = [];
  const runs: string[][] = [];
  const attached: string[][] = [];
  const events: string[] = [];
  const server = systemInfo();
  const rest = new FakeRest();
  rest.body = EXPORT_BLOCK;
  rest.responseHeaders = { "content-type": "text/markdown", [GUARDRAIL_VERSION_HEADER]: "abc" };
  const digestFetch = rest.fetch;
  rest.fetch = async (input, init) => {
    events.push("fetch digest");
    return digestFetch(input, init);
  };
  const config = o.config ?? {};
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => true,
    which: (name: string) => o.onPath?.[name] ?? null,
    execFile: async (file: string, argv: readonly string[]) => {
      runs.push([file, ...argv]);
      events.push(`run ${path.basename(file)} ${argv.slice(0, 2).join(" ")}`);
      return o.exec?.(file, argv) ?? { code: 0, stdout: "", stderr: "" };
    },
    execAttached: async (file: string, argv: readonly string[]) => {
      attached.push([file, ...argv]);
      events.push(`attached ${path.basename(file)} ${argv.slice(0, 2).join(" ")}`);
      return o.attached?.(file, argv) ?? 0;
    },
    stdinIsTty: () => o.tty === true,
    fetch: server.fetch,
    loadConfig: () => (config === "disk" ? loadConfig() : config),
    resolveAuth: (options: ResolveAuthOptions = {}) => {
      const auth = o.auth ?? ELSEWHERE;
      return typeof auth === "function" ? auth(options) : auth;
    },
    makeMemoryClient: (auth?: ResolvedAuth) => restClientFromAuth(MemoryClient, auth!, { fetch: rest.fetch }),
  } as unknown as CliDeps;
  return { deps, out, err, runs, attached, server, events };
}

function report(h: Oauth): Record<string, any> {
  return JSON.parse(h.out.join("\n"));
}

function notes(h: Oauth): string[] {
  return report(h).notes as string[];
}

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return filesUnder(full);
    return e.isFile() ? [full] : [];
  });
}

const serverOk = (title: string) =>
  `${D} runs memory-cloud 0.77.0, which accepts ${title}'s own client registration (0.77.0+).`;
const refused = (why: string, title: string) =>
  `Error: Nothing was written: --oauth needs memory-cloud 0.77.0+, and ${why}. Before 0.77.0, dynamic client ` +
  `registration rejects ${title}'s own client (memory-cloud#1657). Use --url-form with an API key instead (no --oauth).`;
const TITLE = { codex: "Codex", hermes: "Hermes Agent", openclaw: "OpenClaw" } as const;
const OPENCLAW_LOGIN_RAN =
  "Sign in with `openclaw mcp login kagura-memory`, then check it with the command below. The sign-in redirects the browser to OpenClaw's loopback callback on this host; when the browser cannot reach it (a remote host), `openclaw mcp login kagura-memory --code <code>` takes the code from the redirect. memory-cloud's consent screen shows the client name OpenClaw sends, which nothing verifies: approve only a sign-in you started. OpenClaw keeps the token in its state database (~/.openclaw/state/openclaw.sqlite); setup never sees it.";
const OPENCLAW_LOGIN_PRINTED = OPENCLAW_LOGIN_RAN.replace(
  "Sign in with",
  "Once the entry is in openclaw.json, sign in with",
);
const GATEWAY =
  "The Gateway hot-reloads the file. MCP tools appear in OpenClaw's coding and messaging tool profiles, not in minimal.";

let sandbox: string;
let home: string;
let work: string;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-oauth-"));
  home = path.join(sandbox, "home");
  work = path.join(sandbox, "work");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const name of [
    "CODEX_HOME",
    "HERMES_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_WORKSPACE_DIR",
    ...Object.keys(process.env).filter((key) => key.startsWith("KAGURA_")),
  ]) {
    delete process.env[name];
  }
  process.chdir(work);
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe.each(["codex", "hermes", "openclaw"] as const)("setup %s --oauth: its flags", (name) => {
  const onPath = { [name]: `/usr/bin/${name}` };

  it.each([
    ["without --url-form", ["--oauth", "--mcp-url", U]],
    ["without --mcp-url", ["--url-form", "--oauth"]],
    ["with --profile alone", ["--oauth", "--profile", "default"]],
  ])("%s is a usage error, before any request", async (_case, flags) => {
    const h = oauthHarness({ onPath });
    expect(await runCli(["setup", name, ...flags, "-y"], h.deps)).toBe(2);
    expect(h.err).toContain(
      "Error: --oauth needs --url-form and --mcp-url: the URL the harness signs in to, e.g. --url-form --oauth " +
        "--mcp-url https://memory.kagura-ai.com/mcp/w/<workspace-id>.",
    );
    expect(h.server.requests).toEqual([]);
    expect(h.runs).toEqual([]);
  });

  it("refuses --api-key-env, Hermes included, before any request", async () => {
    const h = oauthHarness({ onPath });
    expect(await runCli(["setup", name, ...OAUTH, "--api-key-env", "KAGURA_API_KEY", "-y"], h.deps)).toBe(2);
    expect(h.err).toContain(
      "Error: --oauth and --api-key-env exclude each other: an --oauth entry has no key variable, since the " +
        "harness signs in itself.",
    );
    expect(h.server.requests).toEqual([]);
  });

  it("refuses a plain-HTTP --mcp-url before the server check", async () => {
    const h = oauthHarness({ onPath });
    expect(await runCli(["setup", name, "--url-form", "--oauth", "--mcp-url", "http://example.com/mcp", "-y"], h.deps)).toBe(2);
    expect(h.server.requests).toEqual([]);
  });
});

describe.each(["codex", "hermes", "openclaw"] as const)("setup %s --oauth: the server check", (name) => {
  const onPath = { [name]: `/usr/bin/${name}` };
  const unconfirmed = `setup could not confirm the version of ${D} (GET /api/v1/system/info did not answer 200 with a JSON object)`;

  it.each<[string, { version?: unknown; status?: number }, string]>([
    ["0.76.0", { version: "0.76.0" }, `${D} runs memory-cloud 0.76.0`],
    ["a pre-release of 0.77.0", { version: "0.77.0-rc1" }, `${D} runs memory-cloud 0.77.0-rc1`],
    [
      "an unparseable version",
      { version: "main-abc123" },
      `setup could not confirm the version of ${D} (/api/v1/system/info reports main-abc123)`,
    ],
    [
      "no version",
      { version: undefined },
      `setup could not confirm the version of ${D} (/api/v1/system/info reports no version)`,
    ],
    ["a 500", { status: 500 }, unconfirmed],
  ])("stops on %s with exit 1, running, fetching and writing nothing", async (_case, answer, why) => {
    // An entry that detection would find, and a file the export would change.
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), '[mcp_servers.kagura-memory]\nurl = "https://x/mcp"\n');
    const before = filesUnder(sandbox);
    const h = oauthHarness({ onPath, tty: true, auth: ON_SERVER });
    if ("version" in answer) h.server.version = answer.version;
    if (answer.status !== undefined) h.server.status = answer.status;
    expect(
      await runCli(["setup", name, ...OAUTH, "--context-id", CONTEXT, "--agents-md", "--force", "-y"], h.deps),
    ).toBe(1);
    expect(h.err).toContain(refused(why, TITLE[name]));
    expect(h.server.requests).toHaveLength(1);
    expect(h.runs).toEqual([]);
    expect(h.attached).toEqual([]);
    expect(h.events).toEqual([]);
    expect(filesUnder(sandbox)).toEqual(before);
    expect(h.out).toEqual([]);
  });

  it("the API-key URL form sends no request", async () => {
    const h = oauthHarness({ onPath });
    expect(await runCli(["setup", name, "--mcp-url", U, "-y"], h.deps)).toBe(0);
    expect(h.server.requests).toEqual([]);
  });
});

describe("setup openclaw --oauth", () => {
  const openclaw = { onPath: { openclaw: "/usr/bin/openclaw" } };
  const ADD = [
    "/usr/bin/openclaw",
    ...["mcp", "add", "kagura-memory", "--url", U, "--transport", "streamable-http", "--auth", "oauth"],
  ];

  it("checks the server, then runs `openclaw mcp add … --auth oauth` with Python's closing notes", async () => {
    const h = oauthHarness(openclaw);
    expect(await runCli(["setup", "openclaw", ...OAUTH, "-y"], h.deps)).toBe(0);
    expect(h.runs).toEqual([ADD]);
    expect(h.attached).toEqual([]);
    expect(notes(h)).toEqual([
      serverOk("OpenClaw"),
      "Done: openclaw wrote kagura-memory to ~/.openclaw/openclaw.json.",
      OPENCLAW_LOGIN_RAN,
      GATEWAY,
      "Check it with: openclaw mcp doctor kagura-memory --probe",
      "Re-run with --agents-md --context-id <id> to put a snapshot of a context's tool guardrails into " +
        "~/.openclaw/workspace/AGENTS.md, which OpenClaw loads every session.",
    ]);
    expect(report(h)).toMatchObject({
      status: "success",
      applied_with: `openclaw mcp add kagura-memory --url ${U} --transport streamable-http --auth oauth`,
      mcp_url: U,
    });
  });

  it("sends one unauthenticated request to the deployment, whatever the URL's query", async () => {
    const h = oauthHarness(openclaw);
    expect(await runCli(["setup", "openclaw", "--url-form", "--oauth", "--mcp-url", `${U}?profile=core`, "-y"], h.deps)).toBe(0);
    expect(h.server.requests.map((r) => r.url)).toEqual([`${D}/api/v1/system/info`]);
    expect(Object.keys(h.server.requests[0]!.headers)).not.toContain("authorization");
    expect(h.runs[0]).toContain(`${U}?profile=core`);
  });

  it("--force replaces the entry with `openclaw mcp set` and an auth oauth entry", async () => {
    const h = oauthHarness(openclaw);
    expect(await runCli(["setup", "openclaw", ...OAUTH, "--force", "-y"], h.deps)).toBe(0);
    expect(h.runs[0]!.slice(0, 4)).toEqual(["/usr/bin/openclaw", "mcp", "set", "kagura-memory"]);
    expect(JSON.parse(h.runs[0]![4]!)).toEqual({ url: U, transport: "streamable-http", auth: "oauth" });
  });

  it("without openclaw on PATH, prints the auth oauth block and the sign-in note for a printed entry", async () => {
    const h = oauthHarness();
    expect(await runCli(["setup", "openclaw", ...OAUTH, "-y"], h.deps)).toBe(0);
    expect(h.runs).toEqual([]);
    const block = h.err.join("\n");
    expect(block).toContain('"auth": "oauth"');
    expect(block).not.toContain("headers");
    expect(notes(h)).toContain(OPENCLAW_LOGIN_PRINTED);
  });

  it("--dry-run sends no request and says what the real run checks first", async () => {
    const h = oauthHarness(openclaw);
    expect(await runCli(["setup", "openclaw", ...OAUTH, "--dry-run"], h.deps)).toBe(0);
    expect(h.server.requests).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(notes(h).slice(0, 2)).toEqual([
      "Dry run: nothing is written, run or fetched.",
      `The real run first checks that ${D} runs memory-cloud 0.77.0+ (GET /api/v1/system/info); this dry run sends no request.`,
    ]);
    expect(notes(h)).toContain(
      `Would run: openclaw mcp add kagura-memory --url ${U} --transport streamable-http --auth oauth`,
    );
  });

  it("names the token store under OPENCLAW_STATE_DIR", async () => {
    process.env.OPENCLAW_STATE_DIR = path.join(home, "oc");
    const h = oauthHarness(openclaw);
    expect(await runCli(["setup", "openclaw", ...OAUTH, "-y"], h.deps)).toBe(0);
    expect(notes(h).join("\n")).toContain("its state database (~/oc/state/openclaw.sqlite)");
  });
});

describe("setup codex --oauth", () => {
  const codex = { onPath: { codex: "/usr/bin/codex" } };
  const ADD = ["/usr/bin/codex", "mcp", "add", "kagura-memory", "--url", U];
  const CODEX_LOGIN_RAN =
    "Codex signs in itself: `codex mcp add` above started its sign-in if it found OAuth on the server. If it did not log in, run `codex mcp login kagura-memory`. The sign-in redirects the browser to Codex's loopback callback on this host; when the browser cannot reach it (no browser here, or a remote host), add --no-browser: Codex then prints the URL and takes the callback URL pasted back. Codex keys the token on the entry's URL, so changing its ?guardrails= later (another --guardrails or --context-id) means signing in again. memory-cloud's consent screen shows the client name Codex sends, which nothing verifies: approve only a sign-in you started. Codex keeps the token in the OS keyring (\"Codex MCP Credentials\"; on Windows, its encrypted secrets store in ~/.codex), else in ~/.codex/.credentials.json; setup never sees it.";
  const CODEX_LOGIN_PRINTED = CODEX_LOGIN_RAN.replace(
    "Codex signs in itself: `codex mcp add` above started its sign-in if it found OAuth on the server. If it did not log in, run `codex mcp login kagura-memory`.",
    "Once the table is in config.toml, sign in with `codex mcp login kagura-memory`.",
  );
  const HOOKS_WARNING = [
    "Warning: the kagura-memory Codex plugin's guardrail hooks read their credential only from a URL entry with a bearer (bearer_token_env_var, env_http_headers or http_headers), so with an --oauth entry they do nothing.",
    "They are turned on here for the kagura-memory entry (a config.json under ~/.codex/plugins/data/kagura-memory-*/): to keep them, re-run with --url-form and an API key (no --oauth).",
  ];
  const turnOnHooks = () => {
    const dir = path.join(home, ".codex", "plugins", "data", "kagura-memory-x");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{}");
  };

  it("with a terminal, runs the bare-URL add attached, and ends with Python's sign-in note", async () => {
    const h = oauthHarness({ ...codex, tty: true });
    expect(await runCli(["setup", "codex", ...OAUTH], h.deps)).toBe(0);
    expect(h.attached).toEqual([ADD]);
    expect(h.runs).toEqual([]);
    expect(notes(h)).toEqual([
      serverOk("Codex"),
      "Done: codex wrote kagura-memory to ~/.codex/config.toml.",
      CODEX_LOGIN_RAN,
      "Restart Codex (or start a new session) to load the entry.",
      "Check it with: codex mcp get kagura-memory",
    ]);
    expect(report(h).applied_with).toBe(`codex mcp add kagura-memory --url ${U}`);
    expect(h.out.join("\n")).not.toContain("export KAGURA_API_KEY");
  });

  it.each([
    ["-y", true, ["-y"], "-y was given"],
    ["no terminal", false, [], "stdin is not a terminal"],
  ])("with %s, prints the table and the login note, and runs nothing", async (_case, tty, flags, why) => {
    const h = oauthHarness({ ...codex, tty });
    expect(await runCli(["setup", "codex", ...OAUTH, ...flags], h.deps)).toBe(0);
    expect(h.attached).toEqual([]);
    expect(h.runs).toEqual([]);
    const reason = `Setup does not edit ~/.codex/config.toml itself (\`codex mcp add\` starts the sign-in and ${why}).`;
    expect(h.err).toEqual([
      `${reason}\nAdd this kagura-memory entry to it:`,
      "",
      `[mcp_servers.kagura-memory]\nurl = "${U}"`,
      "",
    ]);
    expect(notes(h)).toContain(`${reason} Add the kagura-memory entry printed on stderr to it.`);
    expect(notes(h)).toContain(CODEX_LOGIN_PRINTED);
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
  });

  it("without codex on PATH, prints the url-only table", async () => {
    const h = oauthHarness({ tty: true });
    expect(await runCli(["setup", "codex", ...OAUTH, "-y"], h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain(`[mcp_servers.kagura-memory]\nurl = "${U}"`);
    expect(h.err.join("\n")).not.toContain("bearer_token_env_var");
  });

  it("an existing entry stops the run after the server check, with nothing run", async () => {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), '[mcp_servers.kagura-memory]\nurl = "https://x/mcp"\n');
    const h = oauthHarness({ ...codex, tty: true });
    expect(await runCli(["setup", "codex", ...OAUTH], h.deps)).toBe(1);
    expect(h.server.requests).toHaveLength(1);
    expect(h.attached).toEqual([]);
    // This bin's existing-entry stop (70a may have reworded its tail).
    expect(h.err.join("\n")).toMatch(/^Error: Nothing was written: a kagura-memory entry already exists/m);
  });

  it("--force runs the same add", async () => {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codex", "config.toml"),
      '[mcp_servers.kagura-memory]\nurl = "https://x/mcp"\nbearer_token_env_var = "K"\n',
    );
    const h = oauthHarness({ ...codex, tty: true });
    expect(await runCli(["setup", "codex", ...OAUTH, "--force"], h.deps)).toBe(0);
    expect(h.attached).toEqual([ADD]);
  });

  it("a failed add says the entry may be saved already, in Python's layout", async () => {
    const h = oauthHarness({ ...codex, tty: true, attached: () => 1 });
    expect(await runCli(["setup", "codex", ...OAUTH], h.deps)).toBe(1);
    expect(h.err).toContain(
      "Error: `codex mcp add` failed: exit code 1\n" +
        "  Codex saves the entry before it signs in, so it may be saved already: check with\n" +
        "  `codex mcp get kagura-memory`, then sign in with `codex mcp login kagura-memory`.",
    );
    expect(h.out).toEqual([]);
  });

  it("puts --context-id and --guardrails off on the URL", async () => {
    const withContext = oauthHarness({ ...codex, tty: true });
    expect(await runCli(["setup", "codex", ...OAUTH, "--context-id", CONTEXT], withContext.deps)).toBe(0);
    expect(withContext.attached[0]!.at(-1)).toBe(`${U}?guardrails=${CONTEXT}`);

    const off = oauthHarness({ ...codex, tty: true });
    expect(await runCli(["setup", "codex", ...OAUTH, "--guardrails", "off"], off.deps)).toBe(0);
    expect(off.attached[0]!.at(-1)).toBe(`${U}?guardrails=off`);
  });

  it.each([
    ["no context", [], U],
    ["a context", ["--context-id", CONTEXT], `${U}?guardrails=${CONTEXT}`],
  ])("with the plugin's hooks on and %s, neither turns guardrails off nor stays silent", async (_case, flags, url) => {
    turnOnHooks();
    const h = oauthHarness(codex);
    expect(await runCli(["setup", "codex", ...OAUTH, ...flags, "-y"], h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain(`url = "${url}"`);
    expect(h.out.join("\n")).not.toContain("guardrails=off");
    const all = notes(h);
    expect(all.slice(all.indexOf(HOOKS_WARNING[0]!), all.indexOf(HOOKS_WARNING[0]!) + 2)).toEqual(HOOKS_WARNING);
  });

  it("--dry-run with a terminal says it would run the add, and runs and sends nothing", async () => {
    const h = oauthHarness({ ...codex, tty: true });
    expect(await runCli(["setup", "codex", ...OAUTH, "--dry-run"], h.deps)).toBe(0);
    expect(h.server.requests).toEqual([]);
    expect(h.attached).toEqual([]);
    expect(notes(h)).toContain(`Would run: codex mcp add kagura-memory --url ${U}`);
  });
});

describe("setup codex --oauth: the guardrails preview (Python's _preview_command)", () => {
  const codex = { onPath: { codex: "/usr/bin/codex" }, tty: true };
  const HEAD =
    `Codex should get the tool guardrail digest of context ${CONTEXT} in the MCP instructions when it connects. ` +
    "The server sends only its base text instead when the entry's credential cannot read that context, the " +
    "context has no guardrails, or the deployment turns the digest off.";
  const DIGEST = `kagura-memory guardrails digest ${CONTEXT} --target instructions`;
  const NO_PROFILE =
    `The kagura-memory CLI's usual credential is not on ${D}, and no profile is: log in there with ` +
    `\`kagura-memory auth login --server ${D} --profile NAME\`, then preview it (Codex gets what the account it ` +
    "signed in with can read):";
  const EDITORS = "Use a context whose editor list you control: every editor's guardrail summaries reach the model.";
  /** A stored OAuth profile on `mcpUrl`, complete as `kagura-memory auth login` writes it. */
  const profile = (mcpUrl: string): Record<string, unknown> => ({
    server: new URL(mcpUrl).origin,
    mcp_url: mcpUrl,
    client_id: "cid",
    access_token: "at",
    refresh_token: "rt",
    expires_at: "2099-01-01T00:00:00+00:00",
  });
  const writeCredentials = (profiles: Record<string, unknown>) => {
    fs.mkdirSync(path.join(home, ".kagura"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".kagura", "credentials.json"),
      JSON.stringify({ version: 1, default_profile: "default", profiles }),
    );
  };
  const run = async (h: Oauth) => runCli(["setup", "codex", ...OAUTH, "--context-id", CONTEXT], h.deps);
  const digestNotes = (h: Oauth) =>
    notes(h).filter((n) => n.startsWith("Codex should get") || n.startsWith("The preview fails") || n === EDITORS);

  it("on the CLI's credential when it is on the entry's server", async () => {
    const h = oauthHarness({ ...codex, auth: ON_SERVER });
    expect(await run(h)).toBe(0);
    expect(digestNotes(h)).toEqual([
      `${HEAD} Preview it on the kagura-memory CLI's credential (Codex gets what the account it signed in with can read): ${DIGEST}`,
      EDITORS,
    ]);
    const all = notes(h);
    expect(all.indexOf(digestNotes(h)[0]!)).toBe(
      all.indexOf("Restart Codex (or start a new session) to load the entry.") - 2,
    );
  });

  it("names the login to run when neither the CLI's credential nor any profile is on that server", async () => {
    const h = oauthHarness(codex);
    expect(await run(h)).toBe(0);
    expect(digestNotes(h)).toEqual([`${HEAD} ${NO_PROFILE} KAGURA_PROFILE=NAME ${DIGEST}`, EDITORS]);
    expect(h.out.join("\n")).not.toContain("KAGURA_MCP_URL");
  });

  it("unsets KAGURA_API_KEY in the command while it is set, and never prints it", async () => {
    process.env.KAGURA_API_KEY = "kagura_x_secret_key_value";
    const h = oauthHarness(codex);
    expect(await run(h)).toBe(0);
    expect(digestNotes(h)[0]).toBe(`${HEAD} ${NO_PROFILE} env -u KAGURA_API_KEY KAGURA_PROFILE=NAME ${DIGEST}`);
    expect(h.out.join("\n")).not.toContain("kagura_x_secret_key_value");
  });

  it("counts a chain that cannot resolve as no credential", async () => {
    const h = oauthHarness({
      ...codex,
      auth: () => {
        throw new Error("No credentials found.");
      },
    });
    expect(await run(h)).toBe(0);
    expect(digestNotes(h)[0]).toBe(`${HEAD} ${NO_PROFILE} KAGURA_PROFILE=NAME ${DIGEST}`);
  });

  it("names the stored profiles on that server, and previews on the first", async () => {
    writeCredentials({
      zeta: profile(U),
      default: profile("https://memory.kagura-ai.com/mcp"),
      work: profile(`${D}/mcp`),
    });
    const h = oauthHarness(codex);
    expect(await run(h)).toBe(0);
    expect(digestNotes(h)[0]).toBe(
      `${HEAD} The kagura-memory CLI's usual credential is not on ${D}; preview it on a profile there (work, zeta) ` +
        `(Codex gets what the account it signed in with can read): KAGURA_PROFILE=work ${DIGEST}`,
    );
  });

  // The loader reads a credentials.json with any malformed profile as empty
  // (Python's load_credentials_file too), so KAGURA_PROFILE=work could not
  // load `work` there: the preview names the login, never a profile.
  it.each([
    ["a profile whose mcp_url is not a string", { work: profile(`${D}/mcp`), broken: { mcp_url: 5 } }],
    ["a profile without tokens", { work: profile(`${D}/mcp`), zeta: { mcp_url: U } }],
  ])("names the login, not a profile, when credentials.json holds %s", async (_case, profiles) => {
    writeCredentials(profiles);
    const h = oauthHarness(codex);
    expect(await run(h)).toBe(0);
    expect(digestNotes(h)[0]).toBe(`${HEAD} ${NO_PROFILE} KAGURA_PROFILE=NAME ${DIGEST}`);
  });

  it.each([
    ["not JSON", "{not json", "not UTF-8 JSON"],
    ["BOM-prefixed", '\uFEFF{"api_key": "k"}', "not UTF-8 JSON"],
    ["not an object", "[]", "not a JSON object"],
  ])("names a .kagura.json that is %s, which every command reads first", async (_case, text, why) => {
    fs.writeFileSync(path.join(work, ".kagura.json"), text);
    const h = oauthHarness({ ...codex, config: "disk" });
    expect(await run(h)).toBe(0);
    expect(notes(h)).toContain(
      `The preview fails until ${path.join(process.cwd(), ".kagura.json")} (${why}) is fixed or removed: every ` +
        "kagura-memory command reads it first.",
    );
    expect(notes(h)).toContain("Done: codex wrote kagura-memory to ~/.codex/config.toml.");
    expect(h.out.join("\n")).not.toContain("{not json");
  });

  it("names a .kagura.json that is a directory by its strerror", async () => {
    fs.mkdirSync(path.join(work, ".kagura.json"));
    const h = oauthHarness({ ...codex, config: "disk" });
    expect(await run(h)).toBe(0);
    expect(notes(h)).toContain(
      `The preview fails until ${path.join(process.cwd(), ".kagura.json")} (Is a directory) is fixed or removed: ` +
        "every kagura-memory command reads it first.",
    );
  });

  it("has no preview without a guardrails context, or with guardrails off", async () => {
    const plain = oauthHarness(codex);
    expect(await runCli(["setup", "codex", ...OAUTH], plain.deps)).toBe(0);
    expect(digestNotes(plain)).toEqual([]);
    const off = oauthHarness(codex);
    expect(await runCli(["setup", "codex", ...OAUTH, "--guardrails", "off"], off.deps)).toBe(0);
    expect(digestNotes(off)).toEqual([]);
  });
});

/** `hermes`: `config get` answers from `entries`; the attached `mcp add` saves as Hermes does. */
class FakeHermes {
  entries: Record<string, Record<string, unknown>> = {};
  /** False: the add exits 0 without saving (a declined overwrite, a cancel). */
  saves = true;
  /** False: Hermes cannot set up OAuth and saves the entry with no `auth`. */
  oauthOk = true;
  /** False: the sign-in did not finish, and "Save config anyway?" saves it disabled. */
  probeOk = true;
  configGetFails = false;

  exec = (_file: string, argv: readonly string[]): ExecResult => {
    if (argv[0] === "config" && argv[1] === "get") {
      if (this.configGetFails) return { code: 2, stdout: "", stderr: "boom" };
      const entry = this.entries[argv[2]!.slice("mcp_servers.".length)];
      return entry === undefined
        ? { code: 1, stdout: "", stderr: `Config key not set: ${argv[2]}` }
        : { code: 0, stdout: `${JSON.stringify(entry)}\n`, stderr: "" };
    }
    if (argv[0] === "mcp" && argv[1] === "list") {
      const rows = Object.entries(this.entries).map(([n, e]) => `  ${n}    ${String(e.url ?? e.command)}   all\n`);
      return { code: 0, stdout: rows.join(""), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  attached = (_file: string, argv: readonly string[]): number => {
    if (argv[0] === "mcp" && argv[1] === "add" && this.saves) {
      const entry: Record<string, unknown> = { url: argv[argv.indexOf("--url") + 1] };
      if (argv[argv.indexOf("--auth") + 1] === "oauth" && this.oauthOk) entry.auth = "oauth";
      if (!this.probeOk) entry.enabled = false;
      this.entries[argv[2]!] = entry;
    }
    return 0;
  };
}

describe("setup hermes --oauth", () => {
  const ADD = [
    "/usr/bin/hermes",
    ...["mcp", "add", "kagura-memory", "--url", U, "--auth", "oauth", "--connect-timeout", "315"],
  ];
  const GET = ["/usr/bin/hermes", "config", "get", "mcp_servers.kagura-memory", "--json"];
  const HERMES_LOGIN_RAN =
    "Hermes signs in itself: `hermes mcp add` above started its sign-in when it probed the server, with --connect-timeout 315 (the bound `hermes mcp login` uses), which Hermes keeps as the entry's connect_timeout. If it did not log in, run `hermes mcp login kagura-memory` (the browser flow). The sign-in redirects the browser to Hermes's loopback callback on this host; when the browser cannot reach it (a remote host), paste the redirect URL at Hermes's prompt, or (memory-cloud 0.78.0+) run `hermes mcp login kagura-memory --flow device`, which signs in with a code at the server's /device page. memory-cloud's consent screen shows the client name Hermes Agent sends, which nothing verifies: approve only a sign-in you started. Hermes Agent keeps the token in ~/.hermes/mcp-tokens/kagura-memory.json; setup never sees it.";
  const HERMES_LOGIN_PRINTED =
    "Once the entry is in config.yaml, sign in with `hermes mcp login kagura-memory` (the browser flow). The sign-in redirects the browser to Hermes's loopback callback on this host; when the browser cannot reach it (a remote host), paste the redirect URL at Hermes's prompt, or (memory-cloud 0.78.0+) run `hermes mcp login kagura-memory --flow device`, which signs in with a code at the server's /device page. memory-cloud's consent screen shows the client name Hermes Agent sends, which nothing verifies: approve only a sign-in you started. Hermes Agent keeps the token in ~/.hermes/mcp-tokens/kagura-memory.json; setup never sees it.";
  const OLD = "http://127.0.0.1:47701/mcp/w/ws-OLD";
  const withHermes = (fake: FakeHermes, extra: Options = {}) =>
    oauthHarness({ onPath: { hermes: "/usr/bin/hermes" }, tty: true, exec: fake.exec, attached: fake.attached, ...extra });
  /** An entry of this name in config.yaml, which this bin's scan finds. */
  const existingYaml = (url: string) => {
    fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".hermes", "config.yaml"),
      `mcp_servers:\n  kagura-memory:\n    url: "${url}"\n`,
    );
  };

  it("with a terminal, runs the add attached with --connect-timeout 315 and reads the entry back", async () => {
    const fake = new FakeHermes();
    const h = withHermes(fake);
    expect(await runCli(["setup", "hermes", ...OAUTH], h.deps)).toBe(0);
    expect(h.attached).toEqual([ADD]);
    expect(h.runs).toContainEqual(GET);
    expect(notes(h).slice(0, 4)).toEqual([
      serverOk("Hermes Agent"),
      "Done: hermes wrote kagura-memory to ~/.hermes/config.yaml.",
      HERMES_LOGIN_RAN,
      "Check it with: hermes mcp test kagura-memory",
    ]);
    expect(h.out.join("\n")).not.toContain("MCP_KAGURA_MEMORY_API_KEY");
  });

  it.each([
    ["-y", true, ["-y"], "-y was given"],
    ["no terminal", false, [], "stdin is not a terminal"],
  ])("with %s, prints the auth oauth block and runs nothing", async (_case, tty, flags, why) => {
    const fake = new FakeHermes();
    const h = withHermes(fake, { tty });
    expect(await runCli(["setup", "hermes", ...OAUTH, ...flags], h.deps)).toBe(0);
    expect(h.attached).toEqual([]);
    const reason = `Setup does not edit ~/.hermes/config.yaml itself (\`hermes mcp add\` is interactive and ${why}).`;
    expect(h.err).toEqual([
      `${reason}\nAdd this kagura-memory entry to it:`,
      "",
      `mcp_servers:\n  kagura-memory:\n    url: "${U}"\n    auth: oauth`,
      "",
    ]);
    expect(notes(h)).toContain(HERMES_LOGIN_PRINTED);
    expect(h.err.join("\n")).not.toContain("headers");
  });

  it("prints the entry alone under an mcp_servers key config.yaml already has", async () => {
    fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
    fs.writeFileSync(path.join(home, ".hermes", "config.yaml"), "mcp_servers:\n  other:\n    command: foo\n");
    const h = oauthHarness();
    expect(await runCli(["setup", "hermes", ...OAUTH, "-y"], h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain(`  kagura-memory:\n    url: "${U}"\n    auth: oauth`);
  });

  it("an entry saved without auth: oauth is not saved, and the export is skipped", async () => {
    const fake = new FakeHermes();
    fake.oauthOk = false;
    const h = withHermes(fake, { auth: ON_SERVER });
    expect(await runCli(["setup", "hermes", ...OAUTH, "--context-id", CONTEXT, "--agents-md"], h.deps)).toBe(1);
    expect(h.err).toContain(
      "Error: Hermes's kagura-memory entry has no auth: oauth, so it cannot sign in to Kagura: Hermes continues without authentication when it cannot set up OAuth. Re-run with --force to replace it; setup skipped the AGENTS.md export.",
    );
    expect(h.events).not.toContain("fetch digest");
    expect(h.out).toEqual([]);
  });

  it("an entry saved disabled after a failed sign-in stops with the commands that fix it", async () => {
    const fake = new FakeHermes();
    fake.probeOk = false;
    const h = withHermes(fake, { auth: ON_SERVER });
    expect(await runCli(["setup", "hermes", ...OAUTH, "--context-id", CONTEXT, "--agents-md"], h.deps)).toBe(1);
    expect(h.err).toContain(
      "Error: Hermes saved kagura-memory disabled, since its sign-in or connection check did not finish, and it never connects to a disabled entry. Sign in with `hermes mcp login kagura-memory` (add --flow device on memory-cloud 0.78.0+ when the browser cannot reach this host), then turn the entry on with `hermes config set mcp_servers.kagura-memory.enabled true`; setup skipped the AGENTS.md export.",
    );
    expect(h.events).not.toContain("fetch digest");
  });

  it("a cancelled add is no entry", async () => {
    const fake = new FakeHermes();
    fake.saves = false;
    const h = withHermes(fake);
    expect(await runCli(["setup", "hermes", ...OAUTH], h.deps)).toBe(1);
    expect(h.err).toContain(
      "Error: Hermes has no kagura-memory entry: `hermes mcp add` was cancelled or failed\n  there, so nothing was saved.",
    );
  });

  it("an entry config get cannot read is not called saved, nor called missing auth", async () => {
    const fake = new FakeHermes();
    fake.configGetFails = true;
    const h = withHermes(fake);
    expect(await runCli(["setup", "hermes", ...OAUTH], h.deps)).toBe(1);
    expect(h.err).toContain(
      "Error: Setup could not read back Hermes's kagura-memory entry (`hermes config get mcp_servers.kagura-memory` failed), so it cannot tell whether Hermes saved an OAuth entry it can sign in with: check it with that command or `hermes mcp list`.",
    );
  });

  it("with config get failing and no entry in mcp list, nothing was saved", async () => {
    const fake = new FakeHermes();
    fake.configGetFails = true;
    fake.saves = false;
    const h = withHermes(fake);
    expect(await runCli(["setup", "hermes", ...OAUTH], h.deps)).toBe(1);
    expect(h.err).toContain(
      "Error: `hermes mcp list` shows no new kagura-memory entry: `hermes mcp add` was\n  cancelled or failed there, so nothing was saved.",
    );
  });

  it("--force over a header entry whose overwrite was declined: no auth: oauth, with the overwrite advice", async () => {
    existingYaml(U);
    const fake = new FakeHermes();
    fake.entries["kagura-memory"] = { url: U, headers: { Authorization: "Bearer ${MCP_KAGURA_MEMORY_API_KEY}" } };
    fake.saves = false;
    const h = withHermes(fake);
    expect(await runCli(["setup", "hermes", ...OAUTH, "--force"], h.deps)).toBe(1);
    expect(h.err).toContain(
      "Error: Hermes's kagura-memory entry has no auth: oauth, so it cannot sign in to Kagura: Hermes keeps the existing entry when its overwrite prompt is declined, and continues without authentication when it cannot set up OAuth. Re-run with --force and accept Hermes's overwrite prompt.",
    );
  });

  it("--force over an OAuth entry for another URL whose overwrite was declined is still the existing one (0.41.3)", async () => {
    existingYaml(OLD);
    const fake = new FakeHermes();
    fake.entries["kagura-memory"] = { url: OLD, auth: "oauth" };
    fake.saves = false;
    const h = withHermes(fake);
    expect(await runCli(["setup", "hermes", ...OAUTH, "--force"], h.deps)).toBe(1);
    expect(h.err).toContain(
      "Error: Hermes's kagura-memory entry is still the existing one (URL with OAuth): Hermes keeps the existing entry when its overwrite prompt is declined, or when the add stops before saving, so nothing was saved. Re-run with --force and accept Hermes's overwrite prompt.",
    );
    expect(h.err.join("\n")).not.toContain(OLD);
  });

  it("--force over an OAuth entry that Hermes replaced is done", async () => {
    existingYaml(OLD);
    const fake = new FakeHermes();
    fake.entries["kagura-memory"] = { url: OLD, auth: "oauth" };
    const h = withHermes(fake);
    expect(await runCli(["setup", "hermes", ...OAUTH, "--force"], h.deps)).toBe(0);
    expect(fake.entries["kagura-memory"]!.url).toBe(U);
    expect(notes(h)).toContain("Done: hermes wrote kagura-memory to ~/.hermes/config.yaml.");
  });

  it("an entry for another URL that setup did not replace is not the one it asked for", async () => {
    const fake = new FakeHermes();
    fake.saves = false;
    fake.entries["kagura-memory"] = { url: OLD, auth: "oauth" };
    const h = withHermes(fake);
    expect(await runCli(["setup", "hermes", ...OAUTH], h.deps)).toBe(1);
    expect(h.err).toContain(
      "Error: Hermes's kagura-memory entry (URL with OAuth) is not the one setup asked for, so nothing was saved.",
    );
  });

  it("--dry-run with a terminal says it would run the add, and runs and sends nothing", async () => {
    const h = withHermes(new FakeHermes());
    expect(await runCli(["setup", "hermes", ...OAUTH, "--dry-run"], h.deps)).toBe(0);
    expect(h.server.requests).toEqual([]);
    expect(h.attached).toEqual([]);
    expect(notes(h)).toContain(
      `Would run: hermes mcp add kagura-memory --url ${U} --auth oauth --connect-timeout 315`,
    );
  });
});
