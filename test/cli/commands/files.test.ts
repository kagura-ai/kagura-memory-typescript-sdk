/**
 * `kagura-memory files …` against the Python CLI's `files` group: the
 * workspace/credential pairing of `_run_files_command` (#115), the
 * `-v` / `--progress` stream of `files upload` (#57), `--remember`, and the
 * plain-text output of `delete` and `download-url`. Cases follow
 * tests/test_cli_files.py and tests/test_logger_progress.py of the Python
 * SDK.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedAuth } from "../../../src/auth/types.js";
import { pathAsUri } from "../../../src/cli/commands/files.js";
import { quote } from "../../../src/cli/parse.js";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { KaguraClient } from "../../../src/client.js";
import type { KaguraConfig } from "../../../src/config.js";
import { KaguraAuthError, KaguraQuotaError } from "../../../src/errors.js";
import { FilesClient } from "../../../src/filesClient.js";
import { restClientFromAuth } from "../../../src/restBase.js";
import { FakeServer } from "../../fakeServer.js";

const WS = "00000000-0000-4000-8000-000000000001";
const OTHER_WS = "20000000-0000-4000-8000-000000000003";
const FILE_ID = "10000000-0000-4000-8000-000000000002";
const UPLOAD_URL = "https://r2.test/bucket/obj?sig=abc";
const NDJSON_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const CONFIG_KEY: ResolvedAuth = {
  kind: "static",
  apiKey: "cfg-key",
  mcpUrl: "https://api.test/mcp",
  source: "config",
};
const ENV_KEY: ResolvedAuth = { ...CONFIG_KEY, apiKey: "env-key", source: "env" };
const OAUTH: ResolvedAuth = {
  kind: "oauth",
  oauth: { getAuthHeader: async () => "Bearer t" },
  mcpUrl: "https://api.test/mcp",
  workspaceId: WS,
};

interface Route {
  status: number;
  body?: unknown;
}

/** The REST side: the upload's three legs, plus list / delete / download-url. */
class FakeFiles {
  requests: Array<{ method: string; url: string; body: unknown }> = [];
  routes: Record<string, Route> = {
    "POST /api/v1/files/reserve": {
      status: 200,
      body: { file_id: FILE_ID, upload_url: UPLOAD_URL, expires_at: "2026-01-01T00:00:00Z" },
    },
    [`PUT ${UPLOAD_URL}`]: { status: 200 },
    [`POST /api/v1/files/${FILE_ID}/confirm`]: {
      status: 200,
      body: {
        id: FILE_ID,
        workspace_id: WS,
        filename: "hello.txt",
        content_type: "text/plain",
        size_bytes: 18,
        sha256: "a".repeat(64),
        status: "uploaded",
        created_at: "2026-01-01T00:00:00Z",
      },
    },
    "GET /api/v1/files": { status: 200, body: [] },
    [`DELETE /api/v1/files/${FILE_ID}`]: { status: 204 },
    [`GET /api/v1/files/${FILE_ID}/download-url`]: {
      status: 200,
      body: { download_url: "https://r2.test/get/key?sig=x", expires_at: "2026-01-01T00:00:00Z" },
    },
  };
  /** Called for each request, so a test can interleave it with stderr. */
  onRequest: (label: string) => void = () => {};

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, url, body });
    const route = this.routes[`${method} ${url}`] ?? this.routes[`${method} ${new URL(url).pathname}`];
    this.onRequest(`${method} ${new URL(url).pathname}`);
    if (route === undefined) return new Response('{"detail":"Not Found"}', { status: 404 });
    const empty = route.status === 204;
    return new Response(empty ? null : JSON.stringify(route.body ?? {}), { status: route.status });
  };

  query(): URLSearchParams {
    return new URL(this.requests[this.requests.length - 1]!.url).searchParams;
  }
}

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  rest: FakeFiles;
  mcp: FakeServer;
  /** Every stderr line and request, in order. */
  timeline: string[];
  /** The arguments `makeFilesClient` and `makeClient` were called with. */
  filesClients: Array<[ResolvedAuth | undefined, string | null | undefined]>;
  mcpClients: unknown[];
}

function harness(
  options: { config?: KaguraConfig; auth?: ResolvedAuth | Error; makeClient?: CliDeps["makeClient"] } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const timeline: string[] = [];
  const rest = new FakeFiles();
  rest.onRequest = (label) => void timeline.push(label);
  const mcp = new FakeServer();
  mcp.toolResults.remember = { status: "success", memory_id: "mem-1" };
  const filesClients: Harness["filesClients"] = [];
  const mcpClients: unknown[] = [];
  const auth = options.auth ?? CONFIG_KEY;
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => {
      err.push(line);
      timeline.push(`stderr ${line}`);
    },
    confirm: async () => true,
    loadConfig: () => options.config ?? { api_key: "cfg-key", context_id: WS },
    resolveAuth: () => {
      if (auth instanceof Error) throw auth;
      return auth;
    },
    makeFilesClient: (a?: ResolvedAuth, hint?: string | null) => {
      filesClients.push([a, hint]);
      return restClientFromAuth(FilesClient, a!, { workspaceIdHint: hint ?? null, fetch: rest.fetch });
    },
    makeClient:
      options.makeClient ??
      ((opts: unknown) => {
        mcpClients.push(opts);
        const fetch: typeof globalThis.fetch = async (input, init) => {
          const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
          if (body?.method === "tools/call") timeline.push(`mcp ${body.params.name}`);
          return mcp.fetch(input, init);
        };
        return new KaguraClient({ apiKey: "test-key", mcpUrl: "https://x.test/mcp", fetch });
      }),
  } as unknown as CliDeps;
  return { deps, out, err, rest, mcp, timeline, filesClients, mcpClients };
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-files-"));
  file = path.join(dir, "hello.txt");
  fs.writeFileSync(file, "hello kagura files");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The NDJSON lines on stderr, parsed, with `ts` checked and dropped. */
function events(err: string[]): Array<Record<string, unknown>> {
  return err
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      const { ts, ...rest } = JSON.parse(l) as Record<string, unknown>;
      expect(ts).toMatch(NDJSON_TS);
      return rest;
    });
}

const RESERVE = {
  v: 1,
  stage: "reserve",
  kind: "action",
  msg: "Reserving upload",
  detail: { desc: "hello.txt (18 bytes)" },
};
const UPLOADING = { v: 1, stage: "upload", kind: "action", msg: "Uploading to object store" };
const CONFIRMING = { v: 1, stage: "confirm", kind: "action", msg: "Confirming upload" };
const COMPLETE = {
  v: 1,
  stage: "complete",
  kind: "success",
  msg: "Upload complete",
  detail: { file_id: FILE_ID, size_bytes: 18 },
};

describe("files upload", () => {
  it("uploads into the workspace paired with the credential and prints the file object", async () => {
    const h = harness();
    expect(await runCli(["files", "upload", file], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join("\n"))).toMatchObject({ id: FILE_ID, status: "uploaded" });
    expect(h.err).toEqual([]);
    expect(h.rest.requests[0]!.body).toMatchObject({ workspace_id: WS, filename: "hello.txt" });
    // The client is built from the one credential resolved, with the
    // .kagura.json workspace as its 403 hint.
    expect(h.filesClients).toEqual([[CONFIG_KEY, WS]]);
  });

  it("sends no binding context unless asked, and the one given when asked", async () => {
    const h = harness();
    await runCli(["files", "upload", file, "--binding-context-id", OTHER_WS], h.deps);
    expect(h.rest.requests[0]!.body).toMatchObject({ context_id: OTHER_WS });
    const plain = harness();
    await runCli(["files", "upload", file], plain.deps);
    expect(plain.rest.requests[0]!.body).not.toHaveProperty("context_id");
  });

  describe("--progress json", () => {
    it("streams Python's four events on stderr and leaves stdout alone", async () => {
      const h = harness();
      expect(await runCli(["files", "upload", file, "--progress", "json"], h.deps)).toBe(0);
      expect(events(h.err)).toEqual([RESERVE, UPLOADING, CONFIRMING, COMPLETE]);
      expect(h.err.every((l) => !l.includes("\n"))).toBe(true);
      expect(JSON.parse(h.out.join("\n"))).toMatchObject({ id: FILE_ID });
      // Python's separators, on one line.
      expect(h.err[1]).toMatch(/^\{"v": 1, "ts": "[^"]+", "stage": "upload", "kind": "action", "msg": "Uploading to object store"\}$/);
    });

    it("ends with an error naming the reserved file when the object store refuses the body", async () => {
      const h = harness();
      h.rest.routes[`PUT ${UPLOAD_URL}`] = { status: 400 };
      expect(await runCli(["files", "upload", file, "--progress", "json"], h.deps)).toBe(1);
      const stream = events(h.err);
      expect(stream.slice(0, 2)).toEqual([RESERVE, UPLOADING]);
      expect(stream[2]).toMatchObject({
        kind: "error",
        stage: "complete",
        detail: { reserved_file_id: FILE_ID, uploaded: false, confirm_started: false, confirmed: false },
      });
      expect(stream).toHaveLength(3);
      expect(h.err[h.err.length - 1]).toMatch(/^Error: Object store rejected upload with HTTP 400 — /);
    });

    it("says the confirm was sent when its answer failed", async () => {
      const h = harness();
      h.rest.routes[`POST /api/v1/files/${FILE_ID}/confirm`] = { status: 500, body: { detail: "x" } };
      expect(await runCli(["files", "upload", file, "--progress=json"], h.deps)).toBe(1);
      expect(events(h.err)[3]).toMatchObject({
        kind: "error",
        detail: { reserved_file_id: FILE_ID, uploaded: true, confirm_started: true, confirmed: false },
      });
    });

    it("emits only the error for a workspace that is no UUID", async () => {
      const h = harness();
      expect(await runCli(["files", "upload", file, "-c", "nope", "--progress", "json"], h.deps)).toBe(1);
      const message =
        "context_id must be a UUID; got 'nope'. Use the OAuth profile's workspace_id, " +
        "a UUID from `kagura context list`, or run `kagura auth login` first.";
      expect(events(h.err)).toEqual([
        {
          v: 1,
          stage: "complete",
          kind: "error",
          msg: `Upload failed: ${message}`,
          detail: { reserved_file_id: null, uploaded: false, confirm_started: false, confirmed: false },
        },
      ]);
      expect(h.err[h.err.length - 1]).toBe(`Error: ${message}`);
      expect(h.rest.requests).toEqual([]);
    });

    it("emits nothing when the credential cannot be paired, as the upload never started", async () => {
      const h = harness({ auth: ENV_KEY });
      expect(await runCli(["files", "upload", file, "--progress", "json"], h.deps)).toBe(1);
      expect(events(h.err)).toEqual([]);
    });
  });

  it("-v prints Rich's plain lines", async () => {
    const h = harness();
    expect(await runCli(["files", "upload", file, "-v"], h.deps)).toBe(0);
    expect(h.err).toEqual([
      "→ Reserving upload hello.txt (18 bytes)",
      "→ Uploading to object store",
      "→ Confirming upload",
      "✓ Upload complete",
    ]);
  });

  it("-vv adds nothing: the upload emits no detail or debug events", async () => {
    const h = harness();
    await runCli(["files", "upload", file, "-vv"], h.deps);
    expect(h.err).toHaveLength(4);
  });

  it("-v shows the failure, then the error", async () => {
    const h = harness();
    h.rest.routes[`PUT ${UPLOAD_URL}`] = { status: 400 };
    expect(await runCli(["files", "upload", file, "-v"], h.deps)).toBe(1);
    expect(h.err[2]).toMatch(/^✗ Upload failed: Object store rejected upload with HTTP 400 — /);
    expect(h.err[3]).toMatch(/^Error: Object store rejected upload/);
  });

  it.each([[["--progress", "none", "-v"]], [["--progress", "NONE", "-vvv"]], [[]]])(
    "is silent with %j",
    async (flags) => {
      const h = harness();
      expect(await runCli(["files", "upload", file, ...flags], h.deps)).toBe(0);
      expect(h.err).toEqual([]);
    },
  );

  describe("usage errors, in click's order", () => {
    it.each<[string[], string]>([
      [["files", "upload", "nope.txt", "--progress", "bad"], "Error: Invalid value for '--progress': 'bad' is not one of 'rich', 'json', 'none'."],
      [["files", "upload", "--progress", "auto", "nope.txt"], "Error: Invalid value for '--progress': 'auto' is not one of 'rich', 'json', 'none'."],
      [["files", "upload", "nope.txt", "--importance", "2"], "Error: Invalid value for '--importance': 2.0 is not in the range 0.0<=x<=1.0."],
      [["files", "upload", "nope.txt", "--summary", "x"], "Error: Invalid value for 'PATH': File 'nope.txt' does not exist."],
      [["files", "upload", "--summary", "x"], "Error: Missing argument 'PATH'."],
      [["files", "upload", "--verbose=2", "x"], "Error: Option '--verbose' does not take a value."],
      [["files", "upload", "-v2", "x"], "Error: No such option: -2"],
    ])("%j", async (argv, first) => {
      const h = harness();
      expect(await runCli(argv, h.deps)).toBe(2);
      expect(h.err[0]).toBe(first);
      expect(h.rest.requests).toEqual([]);
    });

    it("names a directory as click's Path does", async () => {
      const h = harness();
      expect(await runCli(["files", "upload", dir], h.deps)).toBe(2);
      // By its repr, as click prints it: a Windows temp dir's backslashes doubled.
      expect(h.err).toEqual([`Error: Invalid value for 'PATH': File ${quote(dir)} is a directory.`]);
    });

    it("refuses extra arguments after checking the path", async () => {
      const h = harness();
      expect(await runCli(["files", "upload", file, "extra"], h.deps)).toBe(2);
      expect(h.err).toEqual(["Error: Got unexpected extra argument (extra)"]);
      // The order itself: a missing PATH is reported before the extra argument.
      const missing = harness();
      expect(await runCli(["files", "upload", "nope.txt", "extra"], missing.deps)).toBe(2);
      expect(missing.err).toEqual(["Error: Invalid value for 'PATH': File 'nope.txt' does not exist."]);
    });

    it.each([[["--summary", "x"]], [["--tags", "a"]], [["--tags="]]])(
      "refuses %j without --remember instead of dropping it",
      async (flags) => {
        const h = harness();
        expect(await runCli(["files", "upload", file, ...flags], h.deps)).toBe(2);
        expect(h.err).toEqual(["Error: --summary and --tags require --remember."]);
        expect(h.rest.requests).toEqual([]);
      },
    );
  });

  describe("workspace pairing (#115)", () => {
    it("takes the OAuth profile's workspace", async () => {
      const h = harness({ auth: OAUTH, config: {} });
      expect(await runCli(["files", "upload", file], h.deps)).toBe(0);
      expect(h.rest.requests[0]!.body).toMatchObject({ workspace_id: WS });
      expect(h.filesClients).toEqual([[OAUTH, null]]);
    });

    it("refuses an env key without --context-id, never borrowing the config's workspace", async () => {
      const h = harness({ auth: ENV_KEY, config: { context_id: OTHER_WS } });
      expect(await runCli(["files", "upload", file], h.deps)).toBe(1);
      expect(h.err).toEqual([
        "Error: api_key from KAGURA_API_KEY env has no associated workspace; pass --context-id " +
          "(mixing api_key and OAuth profile's workspace is not allowed — see issue #115).",
      ]);
      expect(h.rest.requests).toEqual([]);
    });

    it("lets --context-id win, stripped", async () => {
      const h = harness({ auth: ENV_KEY });
      expect(await runCli(["files", "upload", file, "--context-id", `  ${OTHER_WS}  `], h.deps)).toBe(0);
      expect(h.rest.requests[0]!.body).toMatchObject({ workspace_id: OTHER_WS });
    });

    it("says so when .kagura.json has a key but no workspace", async () => {
      const h = harness({ config: { api_key: "k", context_id: "auto" } });
      expect(await runCli(["files", "upload", file], h.deps)).toBe(1);
      expect(h.err[0]).toMatch(/^Error: \.kagura\.json has api_key but context_id is missing or "auto"\./);
    });

    it("reports a credential that does not resolve", async () => {
      const h = harness({ auth: new KaguraAuthError("No credentials found.") });
      expect(await runCli(["files", "upload", file], h.deps)).toBe(1);
      expect(h.err).toEqual(["Error: No credentials found."]);
    });

    it("reports a client that cannot be built", async () => {
      const h = harness();
      h.deps.makeFilesClient = () => {
        throw new Error("boom from factory");
      };
      expect(await runCli(["files", "upload", file], h.deps)).toBe(1);
      expect(h.err).toEqual(["Error: boom from factory"]);
    });
  });

  describe("a non-string context_id in .kagura.json", () => {
    // Recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4):
    // `kagura files list` with {"api_key": …, "context_id": 123} prints this (exit 1).
    it("reads as absent, naming --context-id", async () => {
      const h = harness({ config: { api_key: "cfg-key", context_id: 123 } as unknown as KaguraConfig });
      expect(await runCli(["files", "list"], h.deps)).toBe(1);
      expect(h.err).toEqual([
        'Error: .kagura.json has api_key but context_id is missing or "auto". Set context_id to the ' +
          "workspace UUID bound to this api_key, or pass --context-id. (Falling back to the OAuth " +
          "profile would mix credential sources — see issue #115.)",
      ]);
      expect(h.rest.requests).toEqual([]);
    });
  });

  describe("--remember", () => {
    it("writes one memory linked to the file, with Python's payload", async () => {
      const h = harness();
      expect(await runCli(["files", "upload", file, "--remember"], h.deps)).toBe(0);
      expect(h.mcp.toolCallArgs()).toEqual({
        context_id: WS,
        summary: "File: hello.txt",
        content: `Uploaded file \`hello.txt\` (18 bytes, text/plain). Stored as file_object ${FILE_ID}.`,
        type: "note",
        importance: 0.5,
        source_uri: pathAsUri(fs.realpathSync(file), process.platform === "win32"),
        source_type: "file",
        details: { file_id: FILE_ID, sha256: "a".repeat(64), size_bytes: 18, content_type: "text/plain" },
      });
      // Built with no options, so it resolves the credential the upload used.
      expect(h.mcpClients).toEqual([{}]);
      const printed = JSON.parse(h.out.join("\n"));
      expect(printed.file).toMatchObject({ id: FILE_ID });
      expect(printed.memory).toMatchObject({ memory_id: "mem-1" });
    });

    it("forwards --summary, --type, --importance and --tags", async () => {
      const h = harness();
      const argv = ["files", "upload", file, "--remember", "--summary", "My doc", "--type", "doc"];
      await runCli([...argv, "--importance", "0.9", "--tags", "a, b"], h.deps);
      expect(h.mcp.toolCallArgs()).toMatchObject({
        summary: "My doc",
        type: "doc",
        importance: 0.9,
        tags: ["a", "b"],
      });
    });

    it("still writes the memory when the file is gone after the upload, as Python's non-strict resolve() does", async () => {
      const h = harness();
      // Removed while the confirm is in flight: the bytes are already uploaded.
      h.rest.onRequest = (label) => {
        if (label.endsWith("/confirm")) fs.rmSync(file);
      };
      expect(await runCli(["files", "upload", file, "--remember"], h.deps)).toBe(0);
      expect(fs.existsSync(file)).toBe(false);
      expect(h.mcp.toolCallArgs()).toMatchObject({
        source_uri: pathAsUri(path.join(fs.realpathSync(dir), "hello.txt"), process.platform === "win32"),
      });
      expect(JSON.parse(h.out.join("\n")).memory).toMatchObject({ memory_id: "mem-1" });
    });

    it("falls back to the filename for an empty --summary, as Python's `or` does", async () => {
      const h = harness();
      await runCli(["files", "upload", file, "--remember", "--summary="], h.deps);
      expect(h.mcp.toolCallArgs()).toMatchObject({ summary: "File: hello.txt" });
    });

    it("holds the upload's success until the memory is written", async () => {
      const h = harness();
      expect(await runCli(["files", "upload", file, "--remember", "--progress", "json"], h.deps)).toBe(0);
      expect(events(h.err)).toEqual([RESERVE, UPLOADING, CONFIRMING, COMPLETE]);
      const success = h.timeline.findIndex((l) => l.includes('"kind": "success"'));
      expect(success).toBeGreaterThan(h.timeline.indexOf("mcp remember"));
    });

    it("names the stored file when the memory write fails, and ends the stream with that error", async () => {
      const h = harness({
        makeClient: (() => ({
          remember: async () => {
            throw new Error("boom");
          },
          close: async () => {},
        })) as unknown as CliDeps["makeClient"],
      });
      expect(await runCli(["files", "upload", file, "--remember", "--progress", "json"], h.deps)).toBe(1);
      const message =
        `File uploaded (file_id=${FILE_ID}), but creating the linked memory failed: boom. ` +
        "The file_object is stored; retry the memory write separately or reference it by file_id.";
      expect(h.err[h.err.length - 1]).toBe(`Error: ${message}`);
      const stream = events(h.err);
      expect(stream.map((e) => e.kind)).toEqual(["action", "action", "action", "error"]);
      expect(stream[3]).toEqual({
        v: 1,
        stage: "complete",
        kind: "error",
        msg: message,
        detail: { reserved_file_id: FILE_ID, uploaded: true, confirm_started: true, confirmed: true },
      });
    });

    it("keeps a quota refusal's reset time and plan under the wrapped message", async () => {
      const h = harness({
        makeClient: (() => ({
          remember: async () => {
            throw new KaguraQuotaError("remember failed (quota_exceeded): Daily memory limit reached.", null, {
              quotaType: "memories_per_day",
              resetsAt: "2099-01-02T00:00:00Z",
              requiredPlan: "pro",
              requiredPlanDisplay: "L",
            });
          },
          close: async () => {},
        })) as unknown as CliDeps["makeClient"],
      });
      expect(await runCli(["files", "upload", file, "--remember"], h.deps)).toBe(1);
      expect(h.err).toEqual([
        `Error: File uploaded (file_id=${FILE_ID}), but creating the linked memory failed: ` +
          // Python's f-string adds its period after the message's own.
          "remember failed (quota_exceeded): Daily memory limit reached.. The file_object is stored; " +
          "retry the memory write separately or reference it by file_id.\n" +
          "  Resets at: 2099-01-02T00:00:00+00:00\n" +
          "  Required plan: L (pro)",
      ]);
    });

    it("treats a write without a memory_id as a failure", async () => {
      const h = harness();
      h.mcp.toolResults.remember = { ok: true };
      expect(await runCli(["files", "upload", file, "--remember"], h.deps)).toBe(1);
      expect(h.err[0]).toContain(
        `File uploaded (file_id=${FILE_ID}), but creating the linked memory failed: ` +
          "memory write reported an error: {'ok': True}.",
      );
      expect(h.out).toEqual([]);
    });

    it("reports a memory client that cannot be built as the memory's failure", async () => {
      const h = harness({
        makeClient: (() => {
          throw new KaguraAuthError("No credentials found.");
        }) as unknown as CliDeps["makeClient"],
      });
      expect(await runCli(["files", "upload", file, "--remember"], h.deps)).toBe(1);
      expect(h.err[0]).toMatch(/^Error: File uploaded \(file_id=.*\), but creating the linked memory failed: No credentials found\./);
    });
  });

  it("lists -v and --progress last in --help, with Python's help texts", async () => {
    const h = harness();
    expect(await runCli(["files", "upload", "--help"], h.deps)).toBe(0);
    const lines = h.out.join("\n").split("\n");
    const options = lines.slice(lines.indexOf("Options:") + 1);
    expect(options.slice(-3).map((l) => l.trim().split(/\s{2,}/)[0])).toEqual([
      "-v, --verbose",
      "--progress [rich|json|none]",
      "--help",
    ]);
    const text = h.out.join("\n");
    expect(text).toContain("Increase verbosity (repeatable: -v, -vv, -vvv).");
    expect(text).toContain(
      "Progress output format. Default: rich if -v given, none otherwise. Use json for AI agents / scripts.",
    );
    expect(text).toContain("Also create a summary memory linked to the uploaded file_object (no LLM).");
    expect(text).toContain("Importance 0.0-1.0 for the --remember memory.  [default: 0.5]");
    expect(text).toContain("kagura-memory files upload ./report.pdf --context-id ctx-uuid");
  });
});

describe("files delete / download-url / list", () => {
  it("delete prints Python's confirmation line", async () => {
    const h = harness();
    expect(await runCli(["files", "delete", FILE_ID, "-c", WS], h.deps)).toBe(0);
    expect(h.out).toEqual([`Deleted ${FILE_ID}`]);
    expect(h.rest.query().get("workspace_id")).toBe(WS);
  });

  it("download-url prints the bare URL, not a JSON string", async () => {
    const h = harness();
    expect(await runCli(["files", "download-url", FILE_ID], h.deps)).toBe(0);
    expect(h.out).toEqual(["https://r2.test/get/key?sig=x"]);
    // The workspace paired with the .kagura.json key.
    expect(h.rest.query().get("workspace_id")).toBe(WS);
  });

  it("download-url needs a workspace the credential's source can supply", async () => {
    const h = harness({ config: { api_key: "k" } });
    expect(await runCli(["files", "download-url", FILE_ID], h.deps)).toBe(1);
    expect(h.err[0]).toMatch(/context_id is missing or "auto".*--context-id/);
    expect(h.rest.requests).toEqual([]);
  });

  it("list sends the paired workspace and the default limit", async () => {
    const h = harness({ auth: OAUTH, config: {} });
    expect(await runCli(["files", "list"], h.deps)).toBe(0);
    expect(h.rest.query().get("workspace_id")).toBe(WS);
    expect(h.rest.query().get("limit")).toBe("50");
    expect(JSON.parse(h.out.join("\n"))).toEqual({ files: [], next_cursor: null });
  });

  it("list range-checks --limit locally", async () => {
    const h = harness();
    expect(await runCli(["files", "list", "--limit", "501"], h.deps)).toBe(2);
    expect(h.err[0]).toBe("Error: Invalid value for '--limit' / '-l': 501 is not in the range 1<=x<=500.");
  });

  it.each([["delete"], ["download-url"]])("%s names its missing argument", async (command) => {
    const h = harness();
    expect(await runCli(["files", command], h.deps)).toBe(2);
    expect(h.err[0]).toBe("Error: Missing argument 'FILE_ID'.");
  });

  // #66: Python puts FILE_ID in the path as typed, so `download-url ..`
  // GETs /api/v1/download-url and `delete 'x?workspace_id=…'` replaces the
  // query the SDK adds.
  it.each([
    ["delete", ".."],
    ["delete", "."],
    ["download-url", ".."],
    ["download-url", ""],
  ])("%s refuses a FILE_ID of %j in click's words (exit 2), sending nothing", async (command, id) => {
    const h = harness();
    expect(await runCli(["files", command, id, "-c", WS], h.deps)).toBe(2);
    expect(h.err).toEqual([`Error: Invalid value for 'FILE_ID': '${id}' is not a valid file id.`]);
    expect(h.rest.requests).toEqual([]);
  });

  it("delete sends a FILE_ID with a query in it as one segment", async () => {
    const h = harness();
    expect(await runCli(["files", "delete", "x?workspace_id=other", "-c", WS], h.deps)).toBe(1);
    const url = new URL(h.rest.requests[0]!.url);
    expect(url.pathname).toBe("/api/v1/files/x%3Fworkspace_id%3Dother");
    expect(url.searchParams.getAll("workspace_id")).toEqual([WS]);
  });
});

describe("pathAsUri: Path.as_uri()", () => {
  it.each<[string, boolean, string]>([
    // What CPython 3.12 and 3.13 print for the same paths.
    ["/tmp/a b(1)!~\u65e5%;:@&=+$,.txt", false, "file:///tmp/a%20b%281%29%21~%E6%97%A5%25%3B%3A%40%26%3D%2B%24%2C.txt"],
    ["/home/u/report.pdf", false, "file:///home/u/report.pdf"],
    ["C:\\Users\\x y\\f(1).txt", true, "file:///C:/Users/x%20y/f%281%29.txt"],
    ["\\\\host\\share\\a b.txt", true, "file://host/share/a%20b.txt"],
  ])("%j", (absolute, windows, uri) => {
    expect(pathAsUri(absolute, windows)).toBe(uri);
  });
});
