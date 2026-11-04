/**
 * A context given to `setup` by name (#90, python-sdk#309): `setup claude`
 * resolves it through every `list_contexts` page, and a harness dry run
 * shows a UUID that is not in the dashed form as a placeholder.
 *
 * The directory is a fake of memory-cloud 0.82.0+'s paged `list_contexts`
 * behind a stubbed fetch (Python's `tests/conftest.py` `PagedContexts`):
 * `name_contains` is a trimmed, case-insensitive substring filter on the
 * name, each page holds `pageSize` rows with `has_more` and an offset
 * `next_cursor`, and row ids are UUIDs made from the position in `names`.
 * The texts are the Python CLI 0.44.0's, recorded from its
 * `_select_or_create_context` and `kagura setup codex|openclaw --dry-run`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedAuth } from "../../../src/auth/types.js";
import { KaguraClient, type KaguraClientOptions, type ListContextsOptions } from "../../../src/client.js";
import {
  CONTEXT_NAME_MAX_CHARS,
  dryRunContext,
  findContextByName,
  lookupContext,
  unknownContextWarning,
  type ListContexts,
} from "../../../src/cli/commands/contextLookup.js";
import { mcpUrlWithQuery } from "../../../src/cli/commands/harnessConfig.js";
import type { ExecOptions, ExecResult } from "../../../src/cli/exec.js";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import type { KaguraConfig } from "../../../src/config.js";
import { KaguraResponseError } from "../../../src/errors.js";
import type { ListContextsResponse } from "../../../src/models.js";
import { isCanonicalUuid, pyStrip, uuidOrNone } from "../../../src/pyCompat.js";
import { FakeServer } from "../../fakeServer.js";

/** What a scripted reply can be: a `list_contexts` body, an HTTP reply, or a fetch that throws. */
type Reply = Record<string, unknown> | Response | Error;

class PagedContexts {
  readonly rows: { id: string; name: string }[];
  /** The `list_contexts` arguments of every call, as sent on the wire. */
  readonly calls: Record<string, unknown>[] = [];

  constructor(
    names: string[],
    readonly pageSize = 2,
    /** Replaces the directory's replies, in order. */
    readonly replies: Reply[] | null = null,
  ) {
    this.rows = names.map((name, i) => ({ id: PagedContexts.idOf(i), name }));
  }

  static idOf(index: number): string {
    return `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
  }

  reply(args: Record<string, unknown>): Reply {
    this.calls.push(args);
    if (this.replies !== null) return this.replies.shift()!;
    const needle = pyStrip(typeof args.name_contains === "string" ? args.name_contains : "").toLowerCase();
    const matched = this.rows.filter((row) => row.name.toLowerCase().includes(needle));
    const start = Number(args.cursor ?? 0);
    const end = start + this.pageSize;
    const hasMore = end < matched.length;
    return {
      status: "success",
      count: this.rows.length,
      contexts: matched.slice(start, end),
      has_more: hasMore,
      next_cursor: hasMore ? String(end) : null,
    };
  }

  /** The directory as `KaguraClient.listContexts` reads it, for the helper's own tests. */
  readonly listContexts: ListContexts = async (options: ListContextsOptions) => {
    const args: Record<string, unknown> = {};
    if (options.nameContains !== undefined) args.name_contains = options.nameContains;
    if (options.cursor !== undefined) args.cursor = options.cursor;
    const reply = this.reply(args);
    if (reply instanceof Error) throw reply;
    return reply as unknown as ListContextsResponse;
  };

  /** A FakeServer whose `list_contexts` is this directory. */
  server(): FakeServer {
    const server = new FakeServer();
    const base = server.fetch;
    server.fetch = async (input, init) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, any>) : undefined;
      if (body?.method === "tools/call" && body.params?.name === "list_contexts") {
        const reply = this.reply(body.params.arguments ?? {});
        if (reply instanceof Error) throw reply;
        if (reply instanceof Response) return reply;
        server.toolResults.list_contexts = reply;
      }
      return base(input, init);
    };
    return server;
  }
}

/** Page one of the plain list holds the two most recent; "far" is the fifth context, and
 * name_contains="far" also matches "far-a" and "far-b", which fill its page one. */
const NAMES = ["recent-a", "recent-b", "far-a", "far-b", "far"];
const FAR_ID = PagedContexts.idOf(4);
const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
/** A dashless 32-hex string: a valid context name, and another spelling of a UUID. */
const HEX_NAME = "0123456789abcdef0123456789abcdef";

const cursors = (fake: PagedContexts) => fake.calls.map((call) => call.cursor);

describe("findContextByName (Python's _find_context_by_name)", () => {
  it("pages with name_contains to the exact name", async () => {
    const fake = new PagedContexts(NAMES);
    expect(await findContextByName("far", fake.listContexts)).toEqual({ id: FAR_ID, name: "far" });
    expect(fake.calls).toEqual([{ name_contains: "far" }, { name_contains: "far", cursor: "2" }]);
  });

  it("stops at the first page with a match", async () => {
    const fake = new PagedContexts(NAMES);
    expect(await findContextByName("far-a", fake.listContexts)).toEqual({ id: PagedContexts.idOf(2), name: "far-a" });
    expect(fake.calls).toHaveLength(1);
  });

  it("counts neither a substring nor another case", async () => {
    const fake = new PagedContexts(["FAR", "far-x", "x-far"], 1);
    expect(await findContextByName("far", fake.listContexts)).toBeNull();
    expect(cursors(fake)).toEqual([undefined, "1", "2"]);
  });

  it("skips rows without an id", async () => {
    const page = { contexts: [{ name: "far" }, "far", { id: "", name: "far" }, ["far"]], has_more: false };
    const fake = new PagedContexts([], 2, [page]);
    expect(await findContextByName("far", fake.listContexts)).toBeNull();
  });

  const NO_CURSOR = "list_contexts: unexpected server response (has_more without a next_cursor)";
  it.each([
    ["no cursor", [{ contexts: [], has_more: true }], NO_CURSOR],
    ["an empty cursor", [{ contexts: [], has_more: true, next_cursor: "" }], NO_CURSOR],
    [
      "a repeated cursor",
      [
        { contexts: [], has_more: true, next_cursor: "2" },
        { contexts: [], has_more: true, next_cursor: "2" },
      ],
      "list_contexts: unexpected server response (a page repeated an earlier next_cursor)",
    ],
    [
      "the 50-page bound",
      Array.from({ length: 50 }, (_, i) => ({ contexts: [], has_more: true, next_cursor: String(i) })),
      "list_contexts: the list did not end within 50 pages",
    ],
  ])("refuses paging that does not add up: %s", async (_label, pages, message) => {
    const fake = new PagedContexts([], 2, [...pages]);
    const error = await findContextByName("far", fake.listContexts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraResponseError);
    expect((error as KaguraResponseError).message).toBe(message);
    expect((error as KaguraResponseError).operation).toBe("list_contexts");
    // Every scripted page was asked for, and no more: the bound is 50 requests.
    expect(fake.replies).toEqual([]);
    expect(fake.calls).toHaveLength(pages.length);
  });

  it("finds a name on the 50th page", async () => {
    const pages: Record<string, unknown>[] = Array.from({ length: 49 }, (_, i) => ({
      contexts: [],
      has_more: true,
      next_cursor: String(i),
    }));
    pages.push({ contexts: [{ id: UUID, name: "far" }], has_more: true, next_cursor: "49" });
    const fake = new PagedContexts([], 2, pages);
    expect(await findContextByName("far", fake.listContexts)).toEqual({ id: UUID, name: "far" });
    expect(fake.calls).toHaveLength(50);
  });
});

describe("lookupContext (Python's _lookup_context)", () => {
  /** The plain first page, fetched from the same directory. */
  const firstPage = (fake: PagedContexts) => () => fake.listContexts({});

  it("takes a first-page row by name, with no further request", async () => {
    const fake = new PagedContexts(NAMES);
    const byName = await lookupContext("recent-b", firstPage(fake), fake.listContexts);
    expect(byName).toEqual({ value: "recent-b", context: fake.rows[1], unknown: false });
    expect(fake.calls).toEqual([{}]);
  });

  it("takes a first-page row by an id that is not in the dashed form", async () => {
    const page = { contexts: [{ id: HEX_NAME, name: "odd" }], has_more: true, next_cursor: "1" };
    const fake = new PagedContexts([], 2, [page]);
    const found = await lookupContext(HEX_NAME, firstPage(fake), fake.listContexts);
    expect(found).toEqual({ value: HEX_NAME, context: { id: HEX_NAME, name: "odd" }, unknown: false });
    expect(fake.calls).toEqual([{}]);
  });

  it("looks a name past the first page up on every page", async () => {
    const fake = new PagedContexts(NAMES);
    const found = await lookupContext("far", firstPage(fake), fake.listContexts);
    expect(found).toEqual({ value: "far", context: { id: FAR_ID, name: "far" }, unknown: false });
    expect(fake.calls).toEqual([{}, { name_contains: "far" }, { name_contains: "far", cursor: "2" }]);
  });

  it("trims the value once, for every use", async () => {
    const fake = new PagedContexts(NAMES);
    const found = await lookupContext("  far \t", firstPage(fake), fake.listContexts);
    expect(found.value).toBe("far");
    expect(found.context?.id).toBe(FAR_ID);
    expect(fake.calls.slice(1).map((call) => call.name_contains)).toEqual(["far", "far"]);
    expect((await lookupContext(" recent-a ", firstPage(fake), fake.listContexts)).context?.name).toBe("recent-a");
  });

  const twoRows = NAMES.slice(0, 2).map((name, i) => ({ id: PagedContexts.idOf(i), name }));
  it.each([
    ["has_more: false", { contexts: twoRows, has_more: false }],
    // A server before 0.82.0 returns every context at once, with no has_more.
    ["no has_more", { contexts: twoRows }],
  ])("takes a first page with %s as the whole list: no second request", async (_label, page) => {
    const fake = new PagedContexts([], 2, [page]);
    const found = await lookupContext("far", firstPage(fake), fake.listContexts);
    expect(found).toEqual({ value: "far", context: null, unknown: true });
    expect(fake.calls).toEqual([{}]);
  });

  it.each([UUID, UUID.toUpperCase(), ` ${UUID}\n`])("sends no request for a dashed UUID (%j)", async (chosen) => {
    const fake = new PagedContexts(NAMES);
    expect(await lookupContext(chosen, firstPage(fake), fake.listContexts)).toEqual({
      value: chosen.trim(),
      context: null,
      unknown: false,
    });
    expect(fake.calls).toEqual([]);
  });

  it("takes a dashed UUID as an id even when a context bears it as its name (no request)", async () => {
    // Python's first page would take the row named UUID and give its id;
    // here a dashed UUID stays off the network (#90), so it is the id it spells.
    const fake = new PagedContexts(["recent-a", UUID]);
    expect(await lookupContext(UUID, firstPage(fake), fake.listContexts)).toEqual({
      value: UUID,
      context: null,
      unknown: false,
    });
    expect(fake.calls).toEqual([]);
  });

  it("looks another UUID spelling up as a name first", async () => {
    // HEX_NAME is the third context, past a first page of two.
    const fake = new PagedContexts(["recent-a", "recent-b", HEX_NAME]);
    const found = await lookupContext(HEX_NAME, firstPage(fake), fake.listContexts);
    expect(found.context).toEqual({ id: PagedContexts.idOf(2), name: HEX_NAME });
    // No context of that name: still an id, so not unknown.
    const upper = await lookupContext(HEX_NAME.toUpperCase(), firstPage(fake), fake.listContexts);
    expect(upper).toEqual({ value: HEX_NAME.toUpperCase(), context: null, unknown: false });
    expect(fake.calls.filter((call) => call.name_contains !== undefined).map((call) => call.name_contains)).toEqual([
      HEX_NAME,
      HEX_NAME.toUpperCase(),
    ]);
  });

  it.each(["", "  "])("sends no request for a blank value (%j)", async (chosen) => {
    const fake = new PagedContexts(NAMES);
    expect(await lookupContext(chosen, firstPage(fake), fake.listContexts)).toEqual({
      value: "",
      context: null,
      unknown: false,
    });
    expect(fake.calls).toEqual([]);
  });

  it("takes a value longer than any context name as unknown, with no request", async () => {
    const fake = new PagedContexts(NAMES);
    const chosen = "x".repeat(CONTEXT_NAME_MAX_CHARS + 1);
    expect(await lookupContext(chosen, firstPage(fake), fake.listContexts)).toEqual({
      value: chosen,
      context: null,
      unknown: true,
    });
    expect(fake.calls).toEqual([]);
    // Code points, as Python's len() counts them: 100 of them can be a name.
    const emoji = "😀".repeat(CONTEXT_NAME_MAX_CHARS);
    expect((await lookupContext(emoji, firstPage(fake), fake.listContexts)).unknown).toBe(true);
    expect(fake.calls).toEqual([{}, { name_contains: emoji }]);
  });

  it("looks a 100-character name up", async () => {
    const fake = new PagedContexts(NAMES);
    const chosen = "x".repeat(CONTEXT_NAME_MAX_CHARS);
    expect(await lookupContext(chosen, firstPage(fake), fake.listContexts)).toEqual({
      value: chosen,
      context: null,
      unknown: true,
    });
    expect(fake.calls).toEqual([{}, { name_contains: chosen }]);
  });
});

describe("uuidOrNone (Python's uuid_or_none)", () => {
  const C = "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c";
  it.each([
    [C.toUpperCase(), C],
    [C.replace(/-/g, ""), C],
    [`{${C}}`, C],
    [`urn:uuid:${C}`, C],
    // uuid.UUID trims nothing.
    [` ${C}`, null],
    ["my-project", null],
  ])("%j → %j", (value, expected) => {
    expect(uuidOrNone(value)).toBe(expected);
  });
});

describe("isCanonicalUuid (Python's is_canonical_uuid)", () => {
  // Recorded from kagura_memory._http.is_canonical_uuid (0.44.0).
  const C = "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c";
  it.each([
    [C, true],
    [C.toUpperCase(), true],
    ["0b5a1c3e-8F2D-4e6a-9c7b-1d2e3f4a5b6c", true],
    [C.replace(/-/g, ""), false],
    [`{${C}}`, false],
    [`urn:uuid:${C}`, false],
    [` ${C}`, false],
    [`${C}\n`, false],
    [C.slice(0, -1), false],
    [`${C}d`, false],
    [`${C.slice(0, -1)}g`, false],
    // A fullwidth "c": ASCII hex digits only, as Python's re.ASCII.
    [`${C.slice(0, -1)}ｃ`, false],
    ["", false],
  ])("%j → %s", (value, expected) => {
    expect(isCanonicalUuid(value)).toBe(expected);
  });
});

describe("the Python CLI 0.44.0's texts", () => {
  it.each([
    ["fa", "'fa'"],
    ["it's", `"it's"`],
    [`a"b'c`, `'a"b\\'c'`],
    ["naïve x", "'naïve\\u2028x'"],
  ])("warns about %j with Python's repr", (value, repr) => {
    expect(unknownContextWarning(value)).toBe(
      `  Warning: no context named ${repr} is visible to this credential; using it as a raw context id.`,
    );
  });

  it.each([
    ["0B5A1C3E-8F2D-4E6A-9C7B-1D2E3F4A5B6C", "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c"],
    [" 0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c\n", "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c"],
    ["0b5a1c3e8f2d4e6a9c7b1d2e3f4a5b6c", "<UUID of context 0b5a1c3e8f2d4e6a9c7b1d2e3f4a5b6c>"],
    ["{0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c}", "<UUID of context {0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c}>"],
    [
      "urn:uuid:0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c",
      "<UUID of context urn:uuid:0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c>",
    ],
    ["my-project", "<UUID of context my-project>"],
  ])("shows %j in a dry run as %s (_dry_run_context)", (chosen, shown) => {
    expect(dryRunContext(chosen)).toBe(shown);
  });

  it("puts a dry run's placeholder in a URL as it is, and encodes everything else", () => {
    const shown = "<UUID of context X>";
    const url = "https://x.test/mcp?a=%3CUUID+of+context+X%3E&guardrails=old#frag";
    expect(mcpUrlWithQuery(url, { guardrails: shown, profile: "a b" }, { guardrailsAsIs: true })).toBe(
      "https://x.test/mcp?a=%3CUUID+of+context+X%3E&guardrails=<UUID of context X>&profile=a+b#frag",
    );
    // Without the option, as before: every value encoded, the other parameters as written.
    expect(mcpUrlWithQuery(url, { guardrails: shown })).toBe(
      "https://x.test/mcp?a=%3CUUID+of+context+X%3E&guardrails=%3CUUID+of+context+X%3E#frag",
    );
    expect(mcpUrlWithQuery("https://x.test/mcp", { profile: "core" }, { guardrailsAsIs: true })).toBe(
      "https://x.test/mcp?profile=core",
    );
  });
});

// --- setup claude, end to end ---------------------------------------------

let sandbox: string;
let home: string;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-lookup-"));
  // Its own git root, so Claude Code's local scope does not reach outside.
  fs.mkdirSync(path.join(sandbox, ".git"));
  home = path.join(sandbox, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const name of [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "HERMES_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_WORKSPACE_DIR",
    ...Object.keys(process.env).filter((key) => key.startsWith("KAGURA_")),
  ]) {
    delete process.env[name];
  }
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const KEY = "kagura_secret_0123456789";
const MCP_URL = "https://x.test/mcp";

interface Run {
  code: number;
  out: string[];
  err: string[];
  /** The options of every client setup built. */
  clients: KaguraClientOptions[];
  /** Every program setup ran, as `[file, ...argv]`. */
  runs: string[][];
  server: FakeServer;
}

async function runSetup(
  args: string[],
  fake: PagedContexts,
  programs: { onPath?: Record<string, string>; closeRejects?: boolean } = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const clients: KaguraClientOptions[] = [];
  const runs: string[][] = [];
  const server = fake.server();
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => true,
    which: (name: string) => programs.onPath?.[name] ?? null,
    execFile: async (file: string, argv: readonly string[], _options?: ExecOptions): Promise<ExecResult> => {
      runs.push([file, ...argv]);
      // `claude plugin list --json`: no plugin.
      return { code: 0, stdout: argv[0] === "plugin" ? "[]" : "", stderr: "" };
    },
    loadConfig: (): KaguraConfig => ({}),
    resolveAuth: (): ResolvedAuth => ({ kind: "static", apiKey: KEY, mcpUrl: MCP_URL, source: "env" }),
    makeClient: (options: KaguraClientOptions) => {
      clients.push(options);
      const client = new KaguraClient({ ...options, fetch: server.fetch });
      if (programs.closeRejects === true) client.close = () => Promise.reject(new Error("close failed"));
      return client;
    },
  } as unknown as CliDeps;
  const code = await runCli(args, deps);
  return { code, out, err, clients, runs, server };
}

/** `setup claude` with the key, the URL and the sandbox as the project, plus `extra`. */
function claude(...extra: string[]): string[] {
  return ["setup", "claude", "--api-key", KEY, "--mcp-url", MCP_URL, "--project-dir", sandbox, ...extra];
}

function kaguraJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(sandbox, ".kagura.json"), "utf-8"));
}

function report(run: Run): Record<string, any> {
  return JSON.parse(run.out.join("\n"));
}

/** What setup wrote into the sandbox, `.git` and the home directory aside. */
function written(): string[] {
  return fs.readdirSync(sandbox).filter((name) => name !== ".git" && name !== "home");
}

const warning = (name: string) =>
  `  Warning: no context named '${name}' is visible to this credential; using it as a raw context id.`;

describe("setup claude resolves a context name across every list_contexts page (#90)", () => {
  it("finds a name on page two and writes its id, on the setup key and URL", async () => {
    const fake = new PagedContexts(NAMES);
    const run = await runSetup(claude("-c", "far"), fake);
    expect(run.code).toBe(0);
    expect(fake.calls).toEqual([{}, { name_contains: "far" }, { name_contains: "far", cursor: "2" }]);
    expect(kaguraJson().context_id).toBe(FAR_ID);
    expect(report(run).context_id).toBe(FAR_ID);
    expect(run.err).toEqual([]);
    // One client, the one the entry gets: the setup key and the URL as given.
    expect(run.clients).toEqual([{ apiKey: KEY, mcpUrl: MCP_URL }]);
    const toolCalls = run.server.requests.filter((r) => r.body?.method === "tools/call");
    expect(toolCalls.map((r) => [r.url, r.headers.authorization])).toEqual(
      Array.from({ length: 3 }, () => [MCP_URL, `Bearer ${KEY}`]),
    );
  });

  it("says so in --help", async () => {
    const run = await runSetup(["setup", "claude", "--help"], new PagedContexts([]));
    expect(run.code).toBe(0);
    expect(run.out.join("\n").replace(/\s+/g, " ")).toContain(
      "A context (-c, else .kagura.json's, else KAGURA_CONTEXT_ID) other than a dashed UUID is looked up by " +
        "exact name on every list_contexts page, and its id is written; a dashed UUID or no context sends no request.",
    );
  });

  it("takes a name on page one with no second request", async () => {
    const fake = new PagedContexts(NAMES);
    const run = await runSetup(claude("-c", "recent-b"), fake);
    expect(run.code).toBe(0);
    expect(fake.calls).toEqual([{}]);
    expect(kaguraJson().context_id).toBe(PagedContexts.idOf(1));
  });

  it("sends no second request when page one says has_more: false, and warns that the name is unknown", async () => {
    const fake = new PagedContexts(["recent-a", "recent-b"]);
    const run = await runSetup(claude("-c", "far"), fake);
    expect(run.code).toBe(0);
    expect(fake.calls).toEqual([{}]);
    // Python's fallback: the value is still written as given.
    expect(kaguraJson().context_id).toBe("far");
    expect(run.err).toEqual([warning("far")]);
  });

  it("takes an older server's reply, with no has_more, as the whole list", async () => {
    const fake = new PagedContexts([], 2, [{ status: "success", count: 1, contexts: [{ id: UUID, name: "far" }] }]);
    const run = await runSetup(claude("-c", "far"), fake);
    expect(run.code).toBe(0);
    expect(fake.calls).toEqual([{}]);
    expect(kaguraJson().context_id).toBe(UUID);
  });

  it("uses a name no page matches as given, after Python's warning", async () => {
    const fake = new PagedContexts(NAMES);
    const run = await runSetup(claude("-c", " fa "), fake);
    expect(run.code).toBe(0);
    // name_contains="fa" matched the three far* contexts over two pages, none named "fa".
    expect(fake.calls).toEqual([{}, { name_contains: "fa" }, { name_contains: "fa", cursor: "2" }]);
    // Trimmed, as it was looked up.
    expect(kaguraJson().context_id).toBe("fa");
    expect(report(run).context_id).toBe("fa");
    expect(run.err).toEqual([warning("fa")]);
  });

  it("resolves a dashless 32-hex name, and takes one no page names as an id, with no warning", async () => {
    const fake = new PagedContexts(["recent-a", "recent-b", HEX_NAME]);
    const named = await runSetup(claude("-c", HEX_NAME), fake);
    expect(named.code).toBe(0);
    expect(kaguraJson().context_id).toBe(PagedContexts.idOf(2));
    expect(fake.calls.at(-1)).toEqual({ name_contains: HEX_NAME });

    const other = HEX_NAME.toUpperCase().split("").reverse().join("");
    const run = await runSetup(claude("-c", other), fake);
    expect(run.code).toBe(0);
    expect(kaguraJson().context_id).toBe(other);
    expect(run.err).toEqual([]);
    expect(fake.calls.at(-1)).toEqual({ name_contains: other });
  });

  it("warns about a value longer than any context name, with no request", async () => {
    const fake = new PagedContexts(NAMES);
    const chosen = "x".repeat(101);
    const run = await runSetup(claude("-c", chosen), fake);
    expect(run.code).toBe(0);
    expect(run.clients).toEqual([]);
    expect(kaguraJson().context_id).toBe(chosen);
    expect(run.err).toEqual([warning(chosen)]);
  });

  it.each([
    ["-c", ["-c", UUID], UUID],
    ["-c in upper case", ["-c", UUID.toUpperCase()], UUID.toUpperCase()],
    // Trimmed, as Python's _lookup_context trims it, and still no request.
    ["-c padded", ["-c", ` ${UUID.toUpperCase()}\t\n`], UUID.toUpperCase()],
    ["no context", [], null],
  ])("sends no request and builds no client for %s", async (_label, extra, written) => {
    const fake = new PagedContexts(NAMES);
    const run = await runSetup(claude(...extra), fake);
    expect(run.code).toBe(0);
    expect(run.clients).toEqual([]);
    expect(run.server.requests).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(report(run).context_id).toBe(written);
    expect(kaguraJson().context_id).toBe(written ?? undefined);
  });

  it.each([
    ["in .kagura.json", { file: ` ${UUID}\n` }],
    ["in KAGURA_CONTEXT_ID", { env: UUID.toUpperCase() }],
  ])("sends no request for a dashed UUID %s either", async (_label, from: { file?: string; env?: string }) => {
    if (from.file !== undefined) {
      fs.writeFileSync(path.join(sandbox, ".kagura.json"), JSON.stringify({ context_id: from.file }));
    }
    if (from.env !== undefined) process.env.KAGURA_CONTEXT_ID = from.env;
    const fake = new PagedContexts(NAMES);
    const run = await runSetup(claude(), fake);
    expect(run.code).toBe(0);
    expect(run.clients).toEqual([]);
    expect(run.server.requests).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(kaguraJson().context_id).toBe(pyStrip(from.file ?? from.env!));
  });

  it("looks a name up with the setup key alone: a blank key stops setup before any request", async () => {
    // KaguraClient reads a blank key as none and would fall back to
    // KAGURA_API_KEY or an OAuth profile, sending another credential here.
    process.env.KAGURA_API_KEY = "kagura_other_credential";
    const fake = new PagedContexts(NAMES);
    const run = await runSetup(
      ["setup", "claude", "--api-key", "  ", "--mcp-url", MCP_URL, "--project-dir", sandbox, "-c", "far"],
      fake,
    );
    expect(run.code).toBe(1);
    expect(run.err).toEqual([
      "Error: no API key: pass --api-key, set api_key in the project's .kagura.json, or export KAGURA_API_KEY.",
    ]);
    expect(run.clients).toEqual([]);
    expect(run.server.requests).toEqual([]);
    expect(written()).toEqual([]);

    // A dashed UUID needs no lookup, so that offline run is as before.
    const offline = await runSetup(
      ["setup", "claude", "--api-key", "  ", "--mcp-url", MCP_URL, "--project-dir", sandbox, "-c", UUID],
      new PagedContexts(NAMES),
    );
    expect(offline.code).toBe(0);
    expect(offline.clients).toEqual([]);
    expect(kaguraJson().context_id).toBe(UUID);
  });

  it("resolves a name in .kagura.json and KAGURA_CONTEXT_ID, and writes the id", async () => {
    fs.writeFileSync(path.join(sandbox, ".kagura.json"), JSON.stringify({ context_id: "far", note: "kept" }));
    const fake = new PagedContexts(NAMES);
    expect((await runSetup(claude(), fake)).code).toBe(0);
    expect(kaguraJson()).toMatchObject({ context_id: FAR_ID, note: "kept" });

    fs.rmSync(path.join(sandbox, ".kagura.json"));
    process.env.KAGURA_CONTEXT_ID = "recent-a";
    expect((await runSetup(claude(), new PagedContexts(NAMES))).code).toBe(0);
    expect(kaguraJson().context_id).toBe(PagedContexts.idOf(0));
  });

  describe("a context given but blank once trimmed", () => {
    // Recorded from `kagura setup claude --api-key … --mcp-url … -c '  ' -y`
    // (0.44.0, connection check faked): exit 1, nothing written.
    const INVALID = "Error: Invalid context_id: '' — must be alphanumeric, hyphens, or underscores only";

    it.each([["  "], ["\t\n"]])("stops setup in Python's words, with no request: -c %j", async (value) => {
      fs.writeFileSync(path.join(sandbox, ".kagura.json"), JSON.stringify({ context_id: UUID }));
      const fake = new PagedContexts(NAMES);
      const run = await runSetup(claude("-c", value), fake);
      expect(run.code).toBe(1);
      expect(run.err).toEqual([INVALID]);
      expect(run.out).toEqual([]);
      expect(run.clients).toEqual([]);
      expect(run.server.requests).toEqual([]);
      // The project's own context is kept, and nothing else is written.
      expect(kaguraJson()).toEqual({ context_id: UUID });
      expect(written()).toEqual([".kagura.json"]);
    });

    it("from .kagura.json too", async () => {
      fs.writeFileSync(path.join(sandbox, ".kagura.json"), JSON.stringify({ context_id: " " }));
      const run = await runSetup(claude(), new PagedContexts(NAMES));
      expect(run.code).toBe(1);
      expect(run.err).toEqual([INVALID]);
      expect(written()).toEqual([".kagura.json"]);
    });

    it("but an empty -c is no -c, as in Python: the project's context is kept", async () => {
      fs.writeFileSync(path.join(sandbox, ".kagura.json"), JSON.stringify({ context_id: UUID }));
      const run = await runSetup(claude("-c", ""), new PagedContexts(NAMES));
      expect(run.code).toBe(0);
      expect(run.clients).toEqual([]);
      expect(kaguraJson().context_id).toBe(UUID);
    });
  });

  describe("a client whose close() rejects never replaces the lookup's outcome", () => {
    it("on a match", async () => {
      const fake = new PagedContexts(NAMES);
      const run = await runSetup(claude("-c", "far"), fake, { closeRejects: true });
      expect(run.code).toBe(0);
      expect(run.clients).toHaveLength(1);
      expect(kaguraJson().context_id).toBe(FAR_ID);
      expect(run.err).toEqual([]);
    });

    it("on a failure", async () => {
      const fake = new PagedContexts([], 2, [new Response("{}", { status: 401 })]);
      const run = await runSetup(claude("-c", "far"), fake, { closeRejects: true });
      expect(run.code).toBe(1);
      expect(run.err.join("\n")).toBe(
        "Error: Authentication failed: Authentication failed. Check your API key.\n" +
          "  Check your API key at: Kagura Web UI > Integrations > API Keys",
      );
      expect(written()).toEqual([]);
    });
  });

  describe("stops before anything is run or written", () => {
    it.each([
      [
        "has_more without a next_cursor",
        [{ contexts: [], has_more: true }],
        "unexpected server response (has_more without a next_cursor)",
      ],
      [
        "a repeated cursor",
        [
          { contexts: [], has_more: true, next_cursor: "2" },
          { contexts: [], has_more: true, next_cursor: "2" },
        ],
        "unexpected server response (a page repeated an earlier next_cursor)",
      ],
      [
        "the 50-page bound",
        Array.from({ length: 50 }, (_, i) => ({ contexts: [], has_more: true, next_cursor: String(i) })),
        "the list did not end within 50 pages",
      ],
    ])("when the name pages do not add up: %s", async (_label, pages, message) => {
      const first = { status: "success", count: 3, contexts: [], has_more: true, next_cursor: "2" };
      const fake = new PagedContexts([], 2, [first, ...pages]);
      const claudeBin = "/usr/bin/claude";
      const run = await runSetup(claude("-c", "far", "--scope", "user"), fake, { onPath: { claude: claudeBin } });
      expect(run.code).toBe(1);
      expect(run.err.join("\n")).toBe(`Error: Setup failed: list_contexts: ${message}`);
      expect(fake.calls).toHaveLength(1 + pages.length);
      expect(run.runs).toEqual([]);
      expect(run.out).toEqual([]);
      expect(written()).toEqual([]);
    });

    it.each([
      [
        "an auth failure on page one",
        [new Response("{}", { status: 401 })],
        "Error: Authentication failed: Authentication failed. Check your API key.\n" +
          "  Check your API key at: Kagura Web UI > Integrations > API Keys",
      ],
      [
        "an auth failure on a name page",
        [{ contexts: [], has_more: true, next_cursor: "2" }, new Response("{}", { status: 401 })],
        "Error: Authentication failed: Authentication failed. Check your API key.\n" +
          "  Check your API key at: Kagura Web UI > Integrations > API Keys",
      ],
      [
        "a connection failure on page one",
        [new TypeError("fetch failed")],
        `Error: Cannot connect to ${MCP_URL}: Connection failed: fetch failed\n` +
          "  Is the server running? Try: docker compose up -d",
      ],
      [
        "a connection failure on a name page",
        [{ contexts: [], has_more: true, next_cursor: "2" }, new TypeError("fetch failed")],
        `Error: Cannot connect to ${MCP_URL}: Connection failed: fetch failed\n` +
          "  Is the server running? Try: docker compose up -d",
      ],
      [
        "another failure on page one, as Python's connection check reports it",
        [{ status: "error", error: "internal_error", message: "kaboom" }],
        "Error: Connection failed: list_contexts failed (internal_error): kaboom",
      ],
      [
        "another failure on a name page",
        [
          { contexts: [], has_more: true, next_cursor: "2" },
          { status: "error", error: "internal_error", message: "kaboom" },
        ],
        "Error: Setup failed: list_contexts failed (internal_error): kaboom",
      ],
    ])("on %s, with the connection check's hints", async (_label, replies, message) => {
      const fake = new PagedContexts([], 2, replies);
      const run = await runSetup(claude("-c", "far"), fake);
      expect(run.code).toBe(1);
      expect(run.err.join("\n")).toBe(message);
      expect(written()).toEqual([]);
    });
  });
});

// --- setup codex | openclaw --dry-run ----------------------------------------

describe("a harness dry run shows a UUID not in the dashed form as Python's placeholder (#90)", () => {
  const DASHLESS = "0B5A1C3E8F2D4E6A9C7B1D2E3F4A5B6C";
  const CANONICAL = "0b5a1c3e-8f2d-4e6a-9c7b-1d2e3f4a5b6c";

  it("in the Codex entry's URL and the AGENTS.md line, as the Python CLI 0.44.0 prints them", async () => {
    const target = path.join(home, "A.md");
    const run = await runSetup(
      ["setup", "codex", "--url-form", "--mcp-url", MCP_URL, "-c", DASHLESS, "--agents-md", target, "--dry-run", "-y"],
      new PagedContexts([]),
    );
    expect(run.code).toBe(0);
    // Recorded from `kagura setup codex --url-form --mcp-url https://x.test/mcp
    // --context-id 0B5A…6C --agents-md ~/A.md --dry-run -y`, codex not on PATH.
    expect(run.err.join("\n")).toContain(
      `url = "${MCP_URL}?guardrails=<UUID of context ${DASHLESS}>"\nbearer_token_env_var = "KAGURA_API_KEY"`,
    );
    expect(report(run).notes).toContain(
      `AGENTS.md: would create ~/A.md (the guardrail block for context <UUID of context ${DASHLESS}>)`,
    );
    expect(report(run).mcp_url).toBe(`${MCP_URL}?guardrails=<UUID of context ${DASHLESS}>`);
    expect(run.clients).toEqual([]);
    expect(run.server.requests).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("with the tool view after it, encoded as usual (#83)", async () => {
    const run = await runSetup(
      [
        ...["setup", "codex", "--url-form", "--mcp-url", MCP_URL, "-c", DASHLESS],
        ...["--tool-profile", "core", "--add-tools", "explore", "--dry-run", "-y"],
      ],
      new PagedContexts([]),
    );
    expect(run.code).toBe(0);
    // Recorded from the Python CLI 0.44.0 with the same flags, codex not on PATH.
    const url = `${MCP_URL}?guardrails=<UUID of context ${DASHLESS}>&profile=core&add_tools=explore`;
    expect(run.err.join("\n")).toContain(`url = "${url}"`);
    expect(report(run).mcp_url).toBe(url);
    expect(run.server.requests).toEqual([]);
  });

  it("on the command line `codex mcp add` would get", async () => {
    const run = await runSetup(
      ["setup", "codex", "--mcp-url", MCP_URL, "-c", `{${CANONICAL}}`, "--dry-run"],
      new PagedContexts([]),
      { onPath: { codex: "/usr/bin/codex" } },
    );
    expect(run.code).toBe(0);
    expect(report(run).notes).toContain(
      `Would run: codex mcp add kagura-memory --url '${MCP_URL}?guardrails=<UUID of context {${CANONICAL}}>' ` +
        "--bearer-token-env-var KAGURA_API_KEY",
    );
  });

  it("in OpenClaw's AGENTS.md line", async () => {
    const target = path.join(home, "B.md");
    const run = await runSetup(
      [
        ...["setup", "openclaw", "--url-form", "--mcp-url", MCP_URL, "-c", `{${CANONICAL}}`],
        ...["--agents-md", target, "--dry-run", "-y"],
      ],
      new PagedContexts([]),
    );
    expect(run.code).toBe(0);
    expect(report(run).notes).toContain(
      `AGENTS.md: would create ~/B.md (the guardrail block for context <UUID of context {${CANONICAL}}>)`,
    );
  });

  it("but a dashed UUID in either case as the canonical one, and a real run every spelling canonically", async () => {
    const target = path.join(home, "A.md");
    const dry = await runSetup(
      ["setup", "codex", "--mcp-url", MCP_URL, "-c", CANONICAL.toUpperCase(), "--agents-md", target, "--dry-run"],
      new PagedContexts([]),
    );
    expect(report(dry).mcp_url).toBe(`${MCP_URL}?guardrails=${CANONICAL}`);
    expect(report(dry).notes).toContain(
      `AGENTS.md: would create ~/A.md (the guardrail block for context ${CANONICAL})`,
    );

    const real = await runSetup(["setup", "codex", "--mcp-url", MCP_URL, "-c", DASHLESS], new PagedContexts([]));
    expect(real.code).toBe(0);
    expect(report(real).mcp_url).toBe(`${MCP_URL}?guardrails=${CANONICAL}`);
    expect(report(real).context_id).toBe(CANONICAL);
    // The harness setups still list no contexts: -c must be a UUID.
    expect(real.server.requests).toEqual([]);
  });
});
