/**
 * `kagura-memory guardrails load|digest` — the Python CLI's `guardrails`
 * group (tests/test_guardrails.py, "CLI: kagura guardrails load /
 * digest"), plus the transcripts of the port's research run against the
 * Python CLI: the printed set's key order and coercions, the check order
 * of `digest`, and the `--out` sequence.
 *
 * Hermetic: config and credentials are injected, both clients talk to
 * fetch stubs, every `--out` file lives in a temp dir the test runs in, and
 * HOME / USERPROFILE point at another one.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultCredentialsPath,
  emptyCredentialsFile,
  resetStateCache,
  saveCredentialsFile,
  setProfile,
} from "../../../src/auth/credentials.js";
import type { ResolvedAuth } from "../../../src/auth/types.js";
import { projectGuardrailSet } from "../../../src/cli/commands/guardrails.js";
import { pathlibString } from "../../../src/cli/pathlib.js";
import { formatJson } from "../../../src/cli/output.js";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { NO_CONTEXT_MESSAGE } from "../../../src/cli/runClientCommand.js";
import { KaguraClient } from "../../../src/client.js";
import { loadConfig, type KaguraConfig } from "../../../src/config.js";
import { KaguraAuthError, KaguraResponseError } from "../../../src/errors.js";
import { MemoryClient } from "../../../src/memoryClient.js";
import { FakeRest, FakeServer } from "../../fakeServer.js";

const CTX = "11111111-2222-3333-4444-555555555555";
const MEM_A = "aaaaaaaa-0000-0000-0000-000000000001";
const MEM_B = "bbbbbbbb-0000-0000-0000-000000000002";
const VERSION = "3f9c1a7b2d4e6f80";

const EXPORT_BLOCK =
  `<!-- kagura-memory:guardrails begin context=${CTX} tool_triggered_version=${VERSION} -->\n` +
  "- (bbbbbbbb) gh pr merge --delete-branch closes the child PR\n" +
  "<!-- kagura-memory:guardrails end -->\n";
const NEW_BLOCK = EXPORT_BLOCK.replace(VERSION, "0123456789abcdef").replace(
  "closes the child PR",
  "closes the stacked child PR",
);

const UPGRADE = "The server may be newer than this SDK; upgrading kagura-memory may help.";

const TRIGGER = { tool: "Bash|PowerShell", on: "pre", match: "gh pr merge", action: "inform" };

/** One server-shaped `GuardrailItem` (`_guardrail_item_payload`). */
function item(
  memoryId: string,
  { toolTrigger = null, pinned = false }: { toolTrigger?: unknown; pinned?: boolean } = {},
): Record<string, unknown> {
  return {
    memory_id: memoryId,
    summary: "Squash-merge only after the head SHA matches",
    context_summary: pinned ? "why this exists" : null,
    type: "decision",
    importance: 0.9,
    delivery_mode: pinned ? "always" : "on_recall",
    tool_trigger: toolTrigger,
    source_type: "manual",
    authored_by_caller: true,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
  };
}

/** The MCP tool's envelope, both lanes truncated, with its context block. */
function guardrailSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "success",
    format: 1,
    version: VERSION,
    pinned: [item(MEM_A, { pinned: true })],
    tool_triggered: [item(MEM_B, { toolTrigger: TRIGGER })],
    total_available: 7,
    truncated: true,
    cap: 1,
    pinned_cap: 1,
    pinned_total_available: 3,
    pinned_truncated: true,
    tool_triggered_total_available: 4,
    tool_triggered_truncated: true,
    context_id: CTX,
    context_name: "dev",
    context_display_name: "Dev",
    context_is_private: true,
    context_is_locked: false,
    ...overrides,
  };
}

const STATIC_AUTH: ResolvedAuth = {
  kind: "static",
  apiKey: "k",
  mcpUrl: "https://x.test/mcp",
  source: "config",
};

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  mcp: FakeServer;
  rest: FakeRest;
  /** The credential each `makeMemoryClient` call received. */
  memoryAuths: Array<ResolvedAuth | undefined>;
  /** The `config` option each `resolveAuth` call received. */
  authConfigs: unknown[];
}

function harness(
  config: KaguraConfig = { api_key: "k", mcp_url: "https://x.test/mcp", context_id: CTX },
  resolveAuth: CliDeps["resolveAuth"] = () => STATIC_AUTH,
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const mcp = new FakeServer();
  const rest = new FakeRest();
  const memoryAuths: Array<ResolvedAuth | undefined> = [];
  const authConfigs: unknown[] = [];
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    loadConfig: () => config,
    makeClient: (options: Record<string, unknown>) =>
      new KaguraClient({ ...options, apiKey: "k", mcpUrl: "https://x.test/mcp", fetch: mcp.fetch }),
    resolveAuth: ((options) => {
      authConfigs.push(options?.config);
      return resolveAuth(options);
    }) as CliDeps["resolveAuth"],
    makeMemoryClient: (auth?: ResolvedAuth) => {
      memoryAuths.push(auth);
      return new MemoryClient({ apiKey: "k", baseUrl: "https://x.test", fetch: rest.fetch });
    },
  } as unknown as CliDeps;
  return { deps, out, err, mcp, rest, memoryAuths, authConfigs };
}

/** The digest route answering `text` with the version header (when given). */
function serveDigest(h: Harness, text: string, version: string | null = VERSION): void {
  h.rest.status = 200;
  h.rest.body = text;
  h.rest.responseHeaders = {
    "content-type": "text/markdown; charset=utf-8",
    ...(version === null ? {} : { "X-Kagura-Guardrails-Tool-Triggered-Version": version }),
  };
}

function toolCalls(h: Harness): number {
  return h.mcp.requests.filter((r) => r.body?.method === "tools/call").length;
}

let dir: string;
/** HOME / USERPROFILE for each test: a path that expands `~` lands here, not in the real home. */
let home: string;
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-guardrails-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-guardrails-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  // Restored in place: assigning a fresh object to process.env detaches it
  // from the real environment.
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe("guardrails group", () => {
  it("lists load and digest with Python's summaries", async () => {
    const h = harness();
    expect(await runCli(["guardrails", "--help"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toBe(
      [
        "Usage: kagura-memory guardrails [OPTIONS] COMMAND [ARGS]...",
        "",
        "  Inspect a context's tool guardrails (server v0.74.0+).",
        "",
        "Commands:",
        "  digest    Render the tool guardrails for clients without tool hooks.",
        "  load      Load the full guardrail set (pinned + tool-triggered lanes) as JSON.",
      ].join("\n"),
    );
  });

  it("documents load: one example per line, with this bin's name", async () => {
    const h = harness();
    expect(await runCli(["guardrails", "load", "--help"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toBe(
      [
        "Usage: kagura-memory guardrails load [OPTIONS] [CONTEXT_ID]",
        "",
        "  Load the full guardrail set (pinned + tool-triggered lanes) as JSON.",
        "",
        "  CONTEXT_ID defaults to context_id in .kagura.json. Check pinned_truncated /",
        "  tool_triggered_truncated before trusting the set as complete.",
        "",
        "  Examples:",
        "    kagura-memory guardrails load",
        "    kagura-memory guardrails load CTX_UUID --cap 200",
        "",
        "Options:",
        "      --cap INTEGER       Max tool-triggered memories (1-1000, server default 50)",
        "  --help                  Show this message and exit.",
      ].join("\n"),
    );
  });

  it("documents digest's options as click does", async () => {
    const h = harness();
    expect(await runCli(["guardrails", "digest", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/^Usage: kagura-memory guardrails digest \[OPTIONS\] \[CONTEXT_ID\]$/m);
    expect(text).toContain(
      "--target [export|instructions]  export: the AGENTS.md block; instructions: " +
        "the MCP server instructions preview  [default: export]",
    );
    expect(text).toContain(
      "--out FILE                      Write the export block into FILE (e.g. AGENTS.md) " +
        "instead of printing it",
    );
    expect(text).toContain("--profile TEXT                  With --target instructions: the MCP URL's");
    expect(text).toContain("--tools TEXT                    With --target instructions: the MCP URL's");
    expect(text).toContain(
      "    kagura-memory guardrails digest CTX_UUID --target instructions --profile core",
    );
    expect(text).toContain("(git update-index\n  --skip-worktree AGENTS.md)");
  });
});

describe("guardrails load", () => {
  it("prints the set in the model's key order, without the context's extra fields", async () => {
    const h = harness();
    h.mcp.toolResults.load_guardrails = guardrailSet();
    expect(await runCli(["guardrails", "load", CTX, "--cap", "5"], h.deps)).toBe(0);
    expect(h.mcp.toolCallArgs()).toEqual({ context_id: CTX, cap: 5 });
    const expectedItem = (memoryId: string, pinned: boolean, toolTrigger: unknown) => ({
      memory_id: memoryId,
      summary: "Squash-merge only after the head SHA matches",
      context_summary: pinned ? "why this exists" : null,
      type: "decision",
      importance: 0.9,
      delivery_mode: pinned ? "always" : "on_recall",
      tool_trigger: toolTrigger,
      source_type: "manual",
      authored_by_caller: true,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-02T00:00:00Z",
    });
    // Byte for byte, key order included: the context_display_name /
    // context_is_private / context_is_locked the tool adds are gone.
    expect(h.out).toEqual([
      formatJson({
        status: "success",
        format: 1,
        version: VERSION,
        pinned: [expectedItem(MEM_A, true, null)],
        tool_triggered: [expectedItem(MEM_B, false, TRIGGER)],
        total_available: 7,
        truncated: true,
        cap: 1,
        pinned_cap: 1,
        pinned_total_available: 3,
        pinned_truncated: true,
        tool_triggered_total_available: 4,
        tool_triggered_truncated: true,
        context_id: CTX,
        context_name: "dev",
      }),
    ]);
    expect(h.err).toEqual([]);
  });

  it("sends an OAuth profile's token to the profile's own server when there is no .kagura.json", async () => {
    // loadConfig's environment fallback fills in the default mcp_url; taken
    // as the URL, it sent this token to https://memory.kagura-ai.com/mcp.
    for (const key of ["KAGURA_API_KEY", "KAGURA_MCP_URL", "KAGURA_PROFILE", "KAGURA_CONTEXT_ID"]) {
      delete process.env[key];
    }
    resetStateCache();
    const cf = emptyCredentialsFile();
    setProfile(cf, "default", {
      server: "https://self.hosted.test",
      mcpUrl: "https://self.hosted.test/mcp",
      clientId: "kagura-cli",
      accessToken: "at-self-hosted",
      refreshToken: "rt-1",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000),
      scope: "memory:read memory:write",
      workspaceId: "ws-1",
      workspaceName: "Acme",
      userEmail: "dev@example.test",
      issuedAt: new Date(),
    });
    saveCredentialsFile(cf, defaultCredentialsPath(home));
    const h = harness();
    h.mcp.toolResults.load_guardrails = guardrailSet();
    // The CLI's own wiring: the real loader (no file in the cwd or HOME) and
    // a client given only what mcpOptions forwards.
    const deps = {
      ...h.deps,
      loadConfig: () => loadConfig(),
      makeClient: (options: Record<string, unknown>) => new KaguraClient({ ...options, fetch: h.mcp.fetch }),
    } as CliDeps;
    try {
      expect(await runCli(["guardrails", "load", CTX], deps)).toBe(0);
    } finally {
      resetStateCache();
    }
    expect(h.mcp.requests.length).toBeGreaterThan(0);
    for (const request of h.mcp.requests) {
      expect(request.url).toBe("https://self.hosted.test/mcp");
      expect(request.headers.authorization).toBe("Bearer at-self-hosted");
    }
  });

  it("falls back to .kagura.json's context and leaves cap to the server", async () => {
    const h = harness();
    h.mcp.toolResults.load_guardrails = guardrailSet();
    expect(await runCli(["guardrails", "load"], h.deps)).toBe(0);
    expect(h.mcp.toolCallArgs()).toEqual({ context_id: CTX });
  });

  it("sends the context as given: the server, not the CLI, checks it", async () => {
    const h = harness();
    h.mcp.toolResults.load_guardrails = {
      status: "error",
      error: "validation_error",
      message: "Invalid context_id format: 'dev'.",
    };
    expect(await runCli(["guardrails", "load", "dev"], h.deps)).toBe(1);
    expect(h.mcp.toolCallArgs()).toEqual({ context_id: "dev" });
    expect(h.err).toEqual([
      "Error: load_guardrails failed (validation_error): Invalid context_id format: 'dev'.",
    ]);
  });

  it("reports an unknown or denied context as the tool words it", async () => {
    const h = harness();
    h.mcp.toolResults.load_guardrails = {
      status: "error",
      error: "context_not_found",
      message: "Context not found or you don't have access to it.",
    };
    expect(await runCli(["guardrails", "load", CTX], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: load_guardrails: Context not found or you don't have access to it.",
    ]);
    expect(h.out).toEqual([]);
  });

  it("adds a quota refusal's reset and plan lines", async () => {
    const h = harness();
    h.mcp.toolResults.load_guardrails = {
      status: "error",
      error: "quota_exceeded",
      message: "Daily limit reached.",
      gate: "quota",
      resets_at: "2026-09-26T00:00:00Z",
      required_plan: "pro",
      required_plan_display: "Pro",
    };
    expect(await runCli(["guardrails", "load", CTX], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: load_guardrails failed (quota_exceeded): Daily limit reached.\n" +
        "  Resets at: 2026-09-26T00:00:00+00:00\n" +
        "  Required plan: Pro (pro)",
    ]);
  });

  it("refuses a set without a truncation flag instead of printing it as complete", async () => {
    const h = harness();
    const payload = guardrailSet();
    delete payload.pinned_truncated;
    h.mcp.toolResults.load_guardrails = payload;
    expect(await runCli(["guardrails", "load", CTX], h.deps)).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.err).toEqual([
      "Error: load_guardrails: unexpected server response for GuardrailSet " +
        `(pinned_truncated: Field required). ${UPGRADE}`,
    ]);
  });

  it("needs a context", async () => {
    const h = harness({ api_key: "k" });
    expect(await runCli(["guardrails", "load"], h.deps)).toBe(1);
    expect(h.err).toEqual([`Error: ${NO_CONTEXT_MESSAGE}`]);
    expect(toolCalls(h)).toBe(0);
  });

  it.each([
    [["--cap", "0"], "Error: Invalid value for '--cap': 0 is not in the range 1<=x<=1000."],
    [["--cap", "+0"], "Error: Invalid value for '--cap': 0 is not in the range 1<=x<=1000."],
    [["--cap", "1001"], "Error: Invalid value for '--cap': 1001 is not in the range 1<=x<=1000."],
    [["--cap", "abc"], "Error: Invalid value for '--cap': 'abc' is not a valid integer range."],
    // Click converts the options before it looks for extra arguments.
    [["a", "b", "--cap", "0"], "Error: Invalid value for '--cap': 0 is not in the range 1<=x<=1000."],
    [["a", "b"], "Error: Got unexpected extra argument (b)"],
  ])("refuses %j with exit 2", async (argv, message) => {
    const h = harness();
    expect(await runCli(["guardrails", "load", ...argv], h.deps)).toBe(2);
    expect(h.err).toEqual([message]);
    expect(toolCalls(h)).toBe(0);
  });

  it("reads --cap as Python's int() does", async () => {
    const h = harness();
    h.mcp.toolResults.load_guardrails = guardrailSet();
    expect(await runCli(["guardrails", "load", CTX, "--cap", "1_000"], h.deps)).toBe(0);
    expect(h.mcp.toolCallArgs()).toEqual({ context_id: CTX, cap: 1000 });
  });
});

describe("projectGuardrailSet", () => {
  const base = () => guardrailSet({ pinned: [], tool_triggered: [] });

  it("defaults status and the context block, as the model does", () => {
    const payload = base();
    delete payload.status;
    delete payload.context_id;
    delete payload.context_name;
    const set = projectGuardrailSet(payload);
    expect(set.status).toBe("success");
    expect(set.context_id).toBeNull();
    expect(set.context_name).toBeNull();
    expect(Object.keys(set)).toHaveLength(15);
  });

  it("fills an item's absent optional fields with null and drops unknown keys", () => {
    const set = projectGuardrailSet({
      ...base(),
      pinned: [{ memory_id: MEM_A, summary: "s", importance: 1, tags: ["x"] }],
    });
    expect(set.pinned).toEqual([
      {
        memory_id: MEM_A,
        summary: "s",
        context_summary: null,
        type: null,
        importance: 1,
        delivery_mode: null,
        tool_trigger: null,
        source_type: null,
        authored_by_caller: null,
        created_at: null,
        updated_at: null,
      },
    ]);
  });

  it("coerces scalars in pydantic's lax mode, printing the converted value", () => {
    const set = projectGuardrailSet({
      ...base(),
      format: "1",
      cap: 50.0,
      truncated: "false",
      pinned_truncated: 0,
      pinned: [{ memory_id: MEM_A, summary: "s", importance: "0.5", authored_by_caller: "yes" }],
    });
    expect(set.format).toBe(1);
    expect(set.cap).toBe(50);
    expect(set.truncated).toBe(false);
    expect(set.pinned_truncated).toBe(false);
    const [first] = set.pinned as unknown as Array<Record<string, unknown>>;
    expect(first!.importance).toBe(0.5);
    expect(first!.authored_by_caller).toBe(true);
  });

  it("passes timestamps through as sent", () => {
    const set = projectGuardrailSet({
      ...base(),
      pinned: [{ memory_id: MEM_A, summary: "s", importance: 1, created_at: "2026-09-01T00:00:00.120Z" }],
    });
    expect((set.pinned as unknown as Array<Record<string, unknown>>)[0]!.created_at).toBe("2026-09-01T00:00:00.120Z");
  });

  it("lists the problems in the model's order, three at most (Python's text)", () => {
    // Verified against the Python CLI: a required and an optional field
    // interleave in the model's field order.
    let caught: unknown;
    try {
      projectGuardrailSet({
        format: 1,
        version: "v",
        pinned: [{ memory_id: "m1", summary: 5, importance: "x", type: 5 }],
        tool_triggered: [],
        total_available: 2,
        truncated: false,
        cap: 50,
        pinned_cap: 100,
        pinned_total_available: 1,
        tool_triggered_total_available: 1,
        tool_triggered_truncated: false,
        context_name: 5,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KaguraResponseError);
    expect((caught as KaguraResponseError).operation).toBe("load_guardrails");
    expect((caught as Error).message).toBe(
      "load_guardrails: unexpected server response for GuardrailSet (" +
        "pinned.0.summary: Input should be a valid string; " +
        "pinned.0.type: Input should be a valid string; " +
        "pinned.0.importance: Input should be a valid number, unable to parse string as a number" +
        ` (+2 more)). ${UPGRADE}`,
    );
  });

  it("refuses an item that is not an object, and a lane that is not a list", () => {
    expect(() => projectGuardrailSet({ ...base(), pinned: ["x"], tool_triggered: null })).toThrow(
      "(pinned.0: Input should be a valid dictionary or instance of GuardrailItem; " +
        "tool_triggered: Input should be a valid list)",
    );
    expect(() => projectGuardrailSet([])).toThrow(
      "(Input should be a valid dictionary or instance of GuardrailSet)",
    );
  });

  it("orders a trigger's fields as the model does and inserts match: null", () => {
    const set = projectGuardrailSet({
      ...base(),
      tool_triggered: [
        {
          memory_id: MEM_B,
          summary: "s",
          importance: 1,
          tool_trigger: { x_new: 2, action: "block", tool: "Bash" },
        },
      ],
    });
    const trigger = (set.tool_triggered as unknown as Array<Record<string, unknown>>)[0]!.tool_trigger;
    expect(JSON.stringify(trigger)).toBe(
      '{"tool":"Bash","on":"pre","match":null,"action":"block","x_new":2}',
    );
  });

  it.each([
    [{ foo: 1 }],
    [{ tool: 5 }],
    ["Bash"],
    [["Bash"]],
    [{ tool: "Bash", on: null }],
    [{ tool: "Bash", match: 5 }],
    [{ tool: "Bash", action: 1 }],
  ])("reads the unusable trigger %j as null, never as a failed read", (trigger) => {
    const set = projectGuardrailSet({
      ...base(),
      tool_triggered: [{ memory_id: MEM_B, summary: "s", importance: 1, tool_trigger: trigger }],
    });
    const [first] = set.tool_triggered as unknown as Array<Record<string, unknown>>;
    expect(first!.tool_trigger).toBeNull();
    expect(first!.memory_id).toBe(MEM_B);
  });

  it("keeps an unknown on / action value for the hook to skip", () => {
    const set = projectGuardrailSet({
      ...base(),
      tool_triggered: [
        {
          memory_id: MEM_B,
          summary: "s",
          importance: 1,
          tool_trigger: { tool: "Bash", on: "post", action: "warn", future_key: 1 },
        },
      ],
    });
    expect((set.tool_triggered as unknown as Array<Record<string, unknown>>)[0]!.tool_trigger).toEqual({
      tool: "Bash",
      on: "post",
      match: null,
      action: "warn",
      future_key: 1,
    });
  });
});

describe("guardrails digest", () => {
  it("prints the export block as is", async () => {
    const h = harness();
    serveDigest(h, EXPORT_BLOCK);
    expect(await runCli(["guardrails", "digest", CTX], h.deps)).toBe(0);
    // The block ends in a newline already; the echo adds none.
    expect(h.out).toEqual([EXPORT_BLOCK.slice(0, -1)]);
    expect(h.err).toEqual([]);
    const url = new URL(h.rest.requests[0]!.url);
    expect(url.pathname).toBe("/api/v1/memory/guardrails/digest");
    expect([...url.searchParams.entries()]).toEqual([
      ["context_id", CTX],
      ["target", "export"],
    ]);
  });

  it("builds the client from the credential it resolved, with the loaded config", async () => {
    const config = { api_key: "k", mcp_url: "https://x.test/mcp", context_id: CTX };
    const h = harness(config);
    serveDigest(h, EXPORT_BLOCK);
    expect(await runCli(["guardrails", "digest"], h.deps)).toBe(0);
    expect(h.memoryAuths).toEqual([STATIC_AUTH]);
    expect(h.authConfigs).toEqual([config]);
  });

  it("adds the newline the instructions preview lacks", async () => {
    const h = harness();
    serveDigest(h, "base text");
    expect(await runCli(["guardrails", "digest", CTX, "--target", "instructions"], h.deps)).toBe(0);
    expect(h.out).toEqual(["base text"]);
    expect(new URL(h.rest.requests[0]!.url).searchParams.get("target")).toBe("instructions");
  });

  it("forwards the tool view, encoded as Python's httpx encodes it", async () => {
    const h = harness();
    serveDigest(h, "base text");
    const argv = [CTX, "--target", "instructions", "--profile", "core", "--tools", "remember,recall a&b"];
    expect(await runCli(["guardrails", "digest", ...argv], h.deps)).toBe(0);
    expect(h.rest.requests[0]!.url.split("?")[1]).toBe(
      `context_id=${CTX}&target=instructions&profile=core&tools=remember%2Crecall+a%26b`,
    );
  });

  it("says so on stderr, and prints nothing, when the context has no tool guardrails", async () => {
    const h = harness();
    serveDigest(h, "");
    expect(await runCli(["guardrails", "digest", CTX], h.deps)).toBe(0);
    expect(h.out).toEqual([]);
    expect(h.err).toEqual([`No tool guardrails in context ${CTX}.`]);
  });

  it.each([["--profile"], ["--tools"]])("refuses %s without --target instructions", async (flag) => {
    const h = harness();
    expect(await runCli(["guardrails", "digest", CTX, flag, "core"], h.deps)).toBe(2);
    expect(h.err).toEqual([
      "Error: --profile / --tools shape the instructions preview; add --target instructions",
    ]);
    expect(h.rest.requests).toEqual([]);
  });

  it("refuses --out with --target instructions, and writes nothing", async () => {
    const h = harness();
    expect(
      await runCli(["guardrails", "digest", CTX, "--target", "instructions", "--out", "AGENTS.md"], h.deps),
    ).toBe(2);
    expect(h.err).toEqual(["Error: --out writes the export block; drop --target instructions"]);
    expect(h.rest.requests).toEqual([]);
    expect(fs.existsSync("AGENTS.md")).toBe(false);
  });

  it("checks --out before --profile: the default target fails the tool-view rule", async () => {
    const h = harness();
    expect(await runCli(["guardrails", "digest", "--out", "X.md", "--profile", "core"], h.deps)).toBe(2);
    expect(h.err).toEqual([
      "Error: --profile / --tools shape the instructions preview; add --target instructions",
    ]);
  });

  it.each([
    [["--target", "EXPORT"], "Error: Invalid value for '--target': 'EXPORT' is not one of 'export', 'instructions'."],
    // Conversions before extra arguments, as click orders them.
    [["a", "b", "--target", "EXPORT"], "Error: Invalid value for '--target': 'EXPORT' is not one of 'export', 'instructions'."],
    [["a", "b"], "Error: Got unexpected extra argument (b)"],
    [["a", "b", "--profile", "x"], "Error: Got unexpected extra argument (b)"],
    [["--out", "adir"], "Error: Invalid value for '--out': File 'adir' is a directory."],
    [["--out", "adir/."], "Error: Invalid value for '--out': File 'adir/.' is a directory."],
    [["--out", "adir", "--target", "instructions"], "Error: Invalid value for '--out': File 'adir' is a directory."],
    // Recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4):
    // `_nonblank_path_option` runs after click.Path's own checks.
    [["--out", ""], "Error: Invalid value for '--out': the path is blank; name a file"],
    [["--out="], "Error: Invalid value for '--out': the path is blank; name a file"],
    [["--out", " "], "Error: Invalid value for '--out': the path is blank; name a file"],
    [["--out", "\t"], "Error: Invalid value for '--out': the path is blank; name a file"],
    [["--out", "", "--target", "instructions"], "Error: Invalid value for '--out': the path is blank; name a file"],
    // The blank check reads the pathlib form, the name the write would
    // create: each of these is the file ' '.
    [["--out", "./ "], "Error: Invalid value for '--out': the path is blank; name a file"],
    [["--out", " /"], "Error: Invalid value for '--out': the path is blank; name a file"],
    [["--out", " /."], "Error: Invalid value for '--out': the path is blank; name a file"],
    [["--out", "\u3000/"], "Error: Invalid value for '--out': the path is blank; name a file"],
    [["--out", "."], "Error: Invalid value for '--out': File '.' is a directory."],
    [["--out", "./"], "Error: Invalid value for '--out': File './' is a directory."],
  ])("refuses %j with exit 2 before anything is sent", async (argv, message) => {
    fs.mkdirSync("adir");
    const h = harness();
    expect(await runCli(["guardrails", "digest", ...argv], h.deps)).toBe(2);
    expect(h.err).toEqual([message]);
    expect(h.rest.requests).toEqual([]);
  });

  // Recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4): a
  // blank LAST segment under a real directory names the file ' ' there,
  // which is not blank.
  it("does not take --out 'a/./ ' as blank", async () => {
    fs.mkdirSync("a");
    const h = harness();
    serveDigest(h, EXPORT_BLOCK);
    expect(await runCli(["guardrails", "digest", CTX, "--out", "a/./ "], h.deps)).toBe(0);
    expect(h.err).toEqual([]);
    expect(h.out).toEqual([
      `{"path": ${JSON.stringify(path.join("a", " "))}, "status": "written", "tool_triggered_version": "${VERSION}"}`,
    ]);
    expect(fs.readFileSync(path.join("a", " "), "utf8")).toBe(EXPORT_BLOCK);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses an --out file it cannot read",
    async () => {
      fs.writeFileSync("noread.md", "# P\n");
      fs.chmodSync("noread.md", 0o200);
      const h = harness();
      expect(await runCli(["guardrails", "digest", "--out", "noread.md"], h.deps)).toBe(2);
      expect(h.err).toEqual(["Error: Invalid value for '--out': File 'noread.md' is not readable."]);
      expect(h.rest.requests).toEqual([]);
    },
  );

  it("needs a context, before any credential is resolved", async () => {
    const h = harness({ api_key: "k" });
    expect(await runCli(["guardrails", "digest"], h.deps)).toBe(1);
    expect(h.err).toEqual([`Error: ${NO_CONTEXT_MESSAGE}`]);
    expect(h.authConfigs).toEqual([]);
    expect(h.rest.requests).toEqual([]);
  });

  it("reports a missing credential in the resolver's words", async () => {
    const h = harness(undefined, () => {
      throw new KaguraAuthError("No credentials found.\n  Run: kagura-memory auth login");
    });
    expect(await runCli(["guardrails", "digest", CTX], h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: No credentials found.\n  Run: kagura-memory auth login"]);
    expect(h.memoryAuths).toEqual([]);
  });

  it.each([
    ["not-a-uuid", "Error: context_id must be a UUID, got 'not-a-uuid'"],
    [` ${CTX}`, `Error: context_id must be a UUID, got ' ${CTX}'`],
  ])("refuses the context %j in the Python SDK's words", async (context, message) => {
    const h = harness();
    expect(await runCli(["guardrails", "digest", context], h.deps)).toBe(1);
    expect(h.err).toEqual([message]);
    expect(h.rest.requests).toEqual([]);
  });

  it("sends a braced or upper-case context in canonical form", async () => {
    const h = harness();
    serveDigest(h, EXPORT_BLOCK);
    expect(await runCli(["guardrails", "digest", `{${CTX.toUpperCase()}}`], h.deps)).toBe(0);
    expect(new URL(h.rest.requests[0]!.url).searchParams.get("context_id")).toBe(CTX);
  });

  it.each([
    [404, { error: "RES-001", message: `Context not found: ${CTX}`, details: {} }, `Error: Context not found: ${CTX}`],
    // A server older than v0.74.0 has no route.
    [404, { error: "HTTP-404", message: "Not Found", details: {} }, "Error: Not Found"],
    [
      403,
      { error: "AUTH-003", message: "Insufficient scope: memory:read required" },
      "Error: HTTP 403: Insufficient scope: memory:read required",
    ],
    [500, "oops", "Error: HTTP 500"],
  ])("reports HTTP %i as the Python CLI does", async (status, body, message) => {
    const h = harness();
    h.rest.status = status;
    h.rest.body = typeof body === "string" ? body : JSON.stringify(body);
    h.rest.responseHeaders = typeof body === "string" ? { "content-type": "text/plain" } : {};
    expect(await runCli(["guardrails", "digest", CTX], h.deps)).toBe(1);
    expect(h.err).toEqual([message]);
    expect(h.out).toEqual([]);
  });

  it("adds a plan refusal's plan line", async () => {
    const h = harness();
    h.rest.status = 403;
    h.rest.body = JSON.stringify({
      error: "FEAT-001",
      message: "Guardrails need the Pro plan.",
      details: { gate: "plan", required_plan: "pro", required_plan_display: "Pro" },
    });
    expect(await runCli(["guardrails", "digest", CTX], h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: Guardrails need the Pro plan.\n  Required plan: Pro (pro)"]);
  });
});

describe("guardrails digest --out", () => {
  const line = (file: string, status: string, version: string | null = VERSION) =>
    `{"path": ${JSON.stringify(file)}, "status": "${status}", "tool_triggered_version": ${
      version === null ? "null" : `"${version}"`
    }}`;

  async function digestOut(file: string, text: string, version: string | null = VERSION) {
    const h = harness();
    serveDigest(h, text, version);
    const code = await runCli(["guardrails", "digest", CTX, "--out", file], h.deps);
    return { code, out: h.out, err: h.err };
  }

  it("writes, then skips an unchanged set, replaces a new one, removes an empty one", async () => {
    fs.writeFileSync("AGENTS.md", "# Project\n");

    expect(await digestOut("AGENTS.md", EXPORT_BLOCK)).toEqual({
      code: 0,
      out: [line("AGENTS.md", "written")],
      err: [],
    });
    expect(fs.readFileSync("AGENTS.md", "utf8")).toBe(`# Project\n\n${EXPORT_BLOCK}`);

    const past = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync("AGENTS.md", past, past);
    expect((await digestOut("AGENTS.md", EXPORT_BLOCK)).out).toEqual([line("AGENTS.md", "unchanged")]);
    expect(fs.statSync("AGENTS.md").mtimeMs).toBe(past.getTime());

    expect((await digestOut("AGENTS.md", NEW_BLOCK, "0123456789abcdef")).out).toEqual([
      line("AGENTS.md", "written", "0123456789abcdef"),
    ]);
    expect(fs.readFileSync("AGENTS.md", "utf8")).toBe(`# Project\n\n${NEW_BLOCK}`);

    expect((await digestOut("AGENTS.md", "", "4f53cda18c2baa0c")).out).toEqual([
      line("AGENTS.md", "removed", "4f53cda18c2baa0c"),
    ]);
    expect(fs.readFileSync("AGENTS.md", "utf8")).toBe("# Project\n");
  });

  it("creates a missing file, but never for an empty set", async () => {
    expect((await digestOut("NEW.md", "")).out).toEqual([line("NEW.md", "unchanged")]);
    expect(fs.existsSync("NEW.md")).toBe(false);
    // No stderr note with --out: the status line says it.
    expect((await digestOut("NEW.md", "")).err).toEqual([]);

    expect((await digestOut("NEW.md", EXPORT_BLOCK)).out).toEqual([line("NEW.md", "written")]);
    expect(fs.readFileSync("NEW.md", "utf8")).toBe(EXPORT_BLOCK);
  });

  it("keeps the heading right above a removed block", async () => {
    fs.writeFileSync("AGENTS.md", `## Guardrails\n${EXPORT_BLOCK}## Next section\nbody\n`);
    expect((await digestOut("AGENTS.md", "")).out).toEqual([line("AGENTS.md", "removed")]);
    expect(fs.readFileSync("AGENTS.md", "utf8")).toBe("## Guardrails\n## Next section\nbody\n");
  });

  it("prints null when the server sends no version header", async () => {
    expect((await digestOut("HDR.md", EXPORT_BLOCK, null)).out).toEqual([line("HDR.md", "written", null)]);
  });

  it.each([
    ["./x/../X.md", "x/../X.md", "X.md"],
    ["x//Y.md/", "x/Y.md", "x/Y.md"],
    ["x/./Z.md", "x/Z.md", "x/Z.md"],
  ])("writes and prints %j as pathlib reads it (%j)", async (arg, shown, written) => {
    fs.mkdirSync("x");
    const result = await digestOut(arg, EXPORT_BLOCK);
    expect(result.out).toEqual([line(shown.split("/").join(path.sep), "written")]);
    expect(fs.readFileSync(written, "utf8")).toBe(EXPORT_BLOCK);
  });

  it("prints a non-ASCII path as written, not as \\u escapes", async () => {
    expect((await digestOut("ガードレール.md", EXPORT_BLOCK)).out).toEqual([
      '{"path": "ガードレール.md", "status": "written", "tool_triggered_version": "3f9c1a7b2d4e6f80"}',
    ]);
  });

  it("does not expand ~ in --out", async () => {
    // HOME is the sandbox's: were `~` ever expanded, the block would land
    // there and fail the check below, not in the real home.
    expect(os.homedir()).toBe(home);
    fs.mkdirSync("~");
    expect((await digestOut("~/A.md", EXPORT_BLOCK)).code).toBe(0);
    expect(fs.readdirSync(home)).toEqual([]);
    expect(fs.readFileSync(path.join("~", "A.md"), "utf8")).toBe(EXPORT_BLOCK);
  });

  it("refuses a file with two blocks, and leaves it unchanged", async () => {
    const original = `# P\n\n${EXPORT_BLOCK}\n${EXPORT_BLOCK}`;
    fs.writeFileSync("AGENTS.md", original);
    expect(await digestOut("AGENTS.md", NEW_BLOCK)).toEqual({
      code: 1,
      out: [],
      err: [
        "Error: AGENTS.md: the file has more than one guardrail block, or a broken one; " +
          "fix it by hand; left unchanged",
      ],
    });
    expect(fs.readFileSync("AGENTS.md", "utf8")).toBe(original);
  });

  it("refuses a fetched block without its markers, naming the file", async () => {
    expect((await digestOut("NEW.md", "- (x) no markers\n")).err).toEqual([
      "Error: NEW.md: fetched block does not have exactly one begin and one end marker line, in that order; " +
        "left unchanged",
    ]);
    expect(fs.existsSync("NEW.md")).toBe(false);
  });

  // Recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4).
  it("refuses a fetched block whose end marker comes first, naming the file", async () => {
    const endFirst =
      "<!-- kagura-memory:guardrails end -->\n" + EXPORT_BLOCK.replace("<!-- kagura-memory:guardrails end -->\n", "");
    expect((await digestOut("NEW.md", endFirst)).err).toEqual([
      "Error: NEW.md: fetched block does not have exactly one begin and one end marker line, in that order; " +
        "left unchanged",
    ]);
    expect(fs.existsSync("NEW.md")).toBe(false);
  });

  it("refuses a file that is not UTF-8, without quoting it", async () => {
    const bytes = Buffer.concat([Buffer.from([0xff]), Buffer.from("SECRET-CONTENT\n")]);
    fs.writeFileSync("bad.md", bytes);
    const result = await digestOut("bad.md", EXPORT_BLOCK);
    expect(result.code).toBe(1);
    // Node's TextDecoder text (the same on Node 18, 20 and 22), and
    // nothing of the file.
    expect(result.err).toEqual([
      "Error: bad.md: The encoded data was not valid for encoding utf-8; left unchanged",
    ]);
    expect(result.err[0]).not.toContain("SECRET");
    expect(fs.readFileSync("bad.md")).toEqual(bytes);
  });

  it("never creates a missing parent directory", async () => {
    const result = await digestOut(path.join("missing", "dir", "AGENTS.md"), EXPORT_BLOCK);
    expect(result.code).toBe(1);
    expect(result.err[0]).toMatch(/^Error: .*ENOENT/);
    expect(fs.existsSync("missing")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("keeps a symlink and the target's mode", async () => {
    fs.writeFileSync("CLAUDE.md", "# Project\n");
    fs.chmodSync("CLAUDE.md", 0o640);
    fs.symlinkSync("CLAUDE.md", "AGENTS.md");
    expect((await digestOut("AGENTS.md", EXPORT_BLOCK)).out).toEqual([line("AGENTS.md", "written")]);
    expect(fs.lstatSync("AGENTS.md").isSymbolicLink()).toBe(true);
    expect(fs.readFileSync("CLAUDE.md", "utf8")).toBe(`# Project\n\n${EXPORT_BLOCK}`);
    expect(fs.statSync("CLAUDE.md").mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(".").filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("keeps a CRLF file's line endings", async () => {
    fs.writeFileSync("AGENTS.md", "# Project\r\n");
    expect((await digestOut("AGENTS.md", EXPORT_BLOCK)).code).toBe(0);
    expect(fs.readFileSync("AGENTS.md", "utf8")).toBe(
      `# Project\n\n${EXPORT_BLOCK}`.split("\n").join("\r\n"),
    );
  });
});

describe("pathlibString", () => {
  // Each pair checked against CPython's str(PurePosixPath(…)) /
  // str(PureWindowsPath(…)).
  it.each([
    ["", "."],
    [".", "."],
    ["./", "."],
    ["//a", "//a"],
    ["///a", "/a"],
    ["a//b/", "a/b"],
    ["./x/../X.md", "x/../X.md"],
    ["/", "/"],
    ["//", "//"],
    ["a/./b/.", "a/b"],
    ["~/A.md", "~/A.md"],
  ])("reads the POSIX path %j as %j", (raw, shown) => {
    expect(pathlibString(raw, path.posix)).toBe(shown);
  });

  it.each([
    ["C:foo", "C:foo"],
    ["C:\\a\\.\\b\\", "C:\\a\\b"],
    ["\\\\server\\share\\x", "\\\\server\\share\\x"],
    ["\\\\server\\share", "\\\\server\\share\\"],
    ["//server/share/x/./y", "\\\\server\\share\\x\\y"],
    ["\\a", "\\a"],
    ["a/b/../c", "a\\b\\..\\c"],
    ["", "."],
    ["./", "."],
    ["C:", "C:"],
    ["C:/", "C:\\"],
    ["a\\\\b", "a\\b"],
  ])("reads the Windows path %j as %j", (raw, shown) => {
    expect(pathlibString(raw, path.win32)).toBe(shown);
  });
});
