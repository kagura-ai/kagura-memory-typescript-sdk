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
