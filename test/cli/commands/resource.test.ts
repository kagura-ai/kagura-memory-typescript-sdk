import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { SETUP_SUMMARY_IGNORED_NOTE } from "../../../src/cli/commands/resource.js";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { FilesClient } from "../../../src/filesClient.js";
import { ResourceClient } from "../../../src/resourceClient.js";
import { FakeServer } from "../../fakeServer.js";

const CONTEXT_UUID = "11111111-2222-4333-8444-555555555555";

/** The MCP `setup_resource` success result, envelope keys included. */
const SETUP_RESULT = {
  status: "success",
  message: "Resource 'res-1' set up successfully.",
  context_id: CONTEXT_UUID,
  context_name: "res-1",
  resource_id: "res-1",
  token: "kagura_rt_x",
  token_id: 1,
};

/** A token as memory-cloud sends it: every field of the Python model. */
const TOKEN = {
  id: 1,
  resource_id: "res-1",
  description: null,
  quota_events_per_hour: 1000,
  created_by: "google_1",
  created_at: "2026-06-01T00:00:00Z",
  last_used_at: null,
  is_active: true,
  status: "active",
};

/** A schema as memory-cloud sends it. */
const SCHEMA = {
  resource_id: "res-1",
  schema_version: 2,
  field_definitions: [{ name: "sku", type: "text", description: "Stock keeping unit" }],
  created_at: "2026-06-01T00:00:00.123456Z",
};

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

class FakeRest {
  requests: Recorded[] = [];
  status = 200;
  body: unknown = {};

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    this.requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    const nullBody = this.status === 204 || this.status === 304;
    return new Response(nullBody ? null : JSON.stringify(this.body), { status: this.status });
  };

  last(): Recorded {
    return this.requests[this.requests.length - 1]!;
  }
  query(): URLSearchParams {
    return new URL(this.last().url).searchParams;
  }
}

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  rest: FakeRest;
}

/**
 * `resourceFetch` replaces the REST fake behind the resource client — for
 * `resource setup`, whose MCP session needs a fake that speaks the
 * handshake ({@link FakeServer}).
 */
function harness(resourceFetch?: typeof globalThis.fetch): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const rest = new FakeRest();
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => true,
    openBrowser: async () => true,
    login: (() => {}) as unknown as CliDeps["login"],
    refresh: (() => {}) as unknown as CliDeps["refresh"],
    // FilesClient requires a UUID workspace id, so the fallback must be one.
    loadConfig: () => ({ api_key: "k", context_id: CONTEXT_UUID }),
    makeClient: (() => {
      throw new Error("MCP client not expected here");
    }) as unknown as CliDeps["makeClient"],
    // `fromMcpUrl`, as production does: baseUrl is derived from the MCP
    // URL rather than passed, so this exercises the same construction path
    // — the one that also stamps the MCP URL `resource setup` needs.
    makeFilesClient: () =>
      FilesClient.fromMcpUrl({ apiKey: "k", mcpUrl: "https://api.test/mcp", fetch: rest.fetch }),
    makeResourceClient: () =>
      ResourceClient.fromMcpUrl({
        apiKey: "k",
        mcpUrl: "https://api.test/mcp",
        fetch: resourceFetch ?? rest.fetch,
      }),
  } as unknown as CliDeps;
  return { deps, out, err, rest };
}

describe("nested groups", () => {
  it("routes the three-level `resource tokens list`", async () => {
    const h = harness();
    h.rest.body = { tokens: [], total: 0, limit: 50, offset: 0 };
    expect(await runCli(["resource", "tokens", "list"], h.deps)).toBe(0);
    expect(h.rest.last().url).toContain("/api/v1/resource-tokens");
  });

  it("lists subcommands for a nested group with --help", async () => {
    const h = harness();
    expect(await runCli(["resource", "tokens", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/Usage: kagura-memory resource tokens/);
    for (const name of ["create", "list", "revoke", "update"]) {
      expect(text).toMatch(new RegExp(`^\\s+${name}\\s`, "m"));
    }
  });

  it("rejects an unknown nested subcommand", async () => {
    const h = harness();
    expect(await runCli(["resource", "tokens", "frobnicate"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/No such command 'frobnicate'/);
  });
});

describe("kagura-memory resource events", () => {
  it("takes RESOURCE_ID positionally, unlike the rest of the group", async () => {
    const h = harness();
    h.rest.body = { events: [], next_cursor: null };
    expect(await runCli(["resource", "events", "res-1"], h.deps)).toBe(0);
    expect(h.rest.last().url).toContain("/api/v1/resources/res-1/events");
    expect(h.rest.query().get("limit")).toBe("50");
  });

  it("reads -c as --cursor, not --context-id", async () => {
    const h = harness();
    h.rest.body = { events: [] };
    await runCli(["resource", "events", "res-1", "-c", "cur-9"], h.deps);
    expect(h.rest.query().get("cursor")).toBe("cur-9");
  });

  it("reads -V as the document version", async () => {
    const h = harness();
    h.rest.body = { events: [] };
    await runCli(["resource", "events", "res-1", "-V", "3"], h.deps);
    expect(h.rest.query().get("version")).toBe("3");
  });

  it.each([["0"], ["101"]])("range-checks --limit %j locally", async (value) => {
    const h = harness();
    expect(await runCli(["resource", "events", "res-1", "--limit", value], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain(`is not in the range 1<=x<=100.`);
    expect(h.rest.requests).toEqual([]);
  });

  it("matches --op case-sensitively, as Python's click.Choice declares it", async () => {
    const h = harness();
    expect(await runCli(["resource", "events", "res-1", "--op", "UPSERT"], h.deps)).toBe(2);
    expect(h.err[0]).toBe("Error: Invalid value for '--op': 'UPSERT' is not one of 'upsert', 'delete'.");
    expect(h.rest.requests).toEqual([]);
  });

  it("rejects a malformed --since before any request", async () => {
    // `new Date("garbage")` is an Invalid Date that serializes to null and
    // would silently drop the filter, returning everything.
    const h = harness();
    expect(await runCli(["resource", "events", "res-1", "--since", "garbage"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("is not a valid ISO 8601 instant");
    expect(h.rest.requests).toEqual([]);
  });

  it("accepts a real ISO 8601 --since", async () => {
    const h = harness();
    h.rest.body = { events: [] };
    expect(await runCli(["resource", "events", "res-1", "--since", "2026-06-01T00:00:00Z"], h.deps)).toBe(0);
    expect(h.rest.query().get("since")).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("a resource id in the REST path (#66)", () => {
  // Python puts it in the path as typed: `resource stats -r ..` GETs
  // /api/v1/impact, and `-r 'x?y'` adds a query.
  const RESOURCE = (id: string) =>
    `Error: Invalid value for '--resource-id' / '-r': '${id}' is not a valid resource id.`;

  it.each([
    [["resource", "stats", "-r", ".."], RESOURCE("..")],
    [["resource", "indexer-status", "-r", "."], RESOURCE(".")],
    [["resource", "schema", "--resource-id="], RESOURCE("")],
    [["resource", "events", ".."], "Error: Invalid value for 'RESOURCE_ID': '..' is not a valid resource id."],
    [["resource", "ingest", "-r", "..", "-k", "rk", "--doc-id", "d"], RESOURCE("..")],
    [["resource", "ingest-batch", "-r", "..", "-k", "rk", "-f", "/nonexistent/events.json"], RESOURCE("..")],
  ])("refuses %j in click's words (exit 2), sending nothing", async (argv, line) => {
    const h = harness();
    expect(await runCli(argv, h.deps)).toBe(2);
    expect(h.err).toEqual([line]);
    expect(h.rest.requests).toEqual([]);
  });

  it("refuses it on import before reading the input", async () => {
    const h = harness();
    h.deps.readStdin = () => {
      throw new Error("stdin must not be read");
    };
    expect(await runCli(["resource", "import", "-r", "..", "-k", "rk", "--format", "json"], h.deps)).toBe(2);
    expect(h.err).toEqual([RESOURCE("..")]);
    expect(h.rest.requests).toEqual([]);
  });

  it("sends an id with a slash or a query as one segment", async () => {
    const h = harness();
    h.rest.body = { resource_id: "a/b?c", token_count: 0, memory_count: 0 };
    expect(await runCli(["resource", "stats", "-r", "a/b?c"], h.deps)).toBe(0);
    expect(new URL(h.rest.last().url).pathname).toBe("/api/v1/resources/a%2Fb%3Fc/impact");
  });

  it("still takes an empty id where it goes in the body (tokens create)", async () => {
    const h = harness();
    h.rest.status = 422;
    h.rest.body = { detail: "resource_id too short" };
    expect(await runCli(["resource", "tokens", "create", "-r", ""], h.deps)).toBe(1);
    expect(h.rest.last().body).toMatchObject({ resource_id: "" });
  });
});

describe("kagura-memory resource schema vs ingest: the -v/-V trap", () => {
  it("reads lowercase -v as the schema version on `schema`", async () => {
    const h = harness();
    h.rest.body = SCHEMA;
    expect(await runCli(["resource", "schema", "-r", "res-1", "-v", "2"], h.deps)).toBe(0);
    expect(h.rest.query().get("schema_version")).toBe("2");
  });

  it("reads capital -V as the document version on `ingest`", async () => {
    const h = harness();
    h.rest.body = { status: "accepted", event_id: 7 };
    expect(
      await runCli(
        ["resource", "ingest", "-r", "res-1", "-k", "rk", "--doc-id", "d1", "-V", "4"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.rest.last().body).toMatchObject({ doc_id: "d1", version: 4, op: "upsert" });
    expect(h.rest.last().headers["x-resource-api-key"]).toBe("rk");
  });

  it("rejects lowercase -v on `ingest`, where it is not declared", async () => {
    const h = harness();
    expect(
      await runCli(["resource", "ingest", "-r", "r", "-k", "k", "--doc-id", "d", "-v", "4"], h.deps),
    ).toBe(2);
    expect(h.err.join("\n")).toMatch(/Error: No such option: -v/);
  });
});

describe("kagura-memory resource quota range checks", () => {
  it("range-checks setup --quota locally", async () => {
    const h = harness();
    expect(await runCli(["resource", "setup", "-r", "res-1", "-q", "20000"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("is not in the range 1<=x<=10000.");
  });

  it("does NOT range-check tokens create --quota, matching Python", async () => {
    // Python declares plain `type=int` there; the bound is pydantic's, on
    // the server. A local check would reject input the Python CLI sends.
    const h = harness();
    h.rest.body = { ...TOKEN, quota_events_per_hour: 20000, token: "t" };
    expect(await runCli(["resource", "tokens", "create", "-r", "res-1", "-q", "20000"], h.deps)).toBe(0);
    expect(h.rest.last().body).toMatchObject({ quota_events_per_hour: 20000 });
  });
});

describe("kagura-memory resource tokens", () => {
  it("requires TOKEN_ID to be an integer", async () => {
    const h = harness();
    expect(await runCli(["resource", "tokens", "revoke", "abc"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("Invalid value for 'TOKEN_ID': 'abc' is not a valid integer.");
  });

  it("names the missing required option", async () => {
    const h = harness();
    expect(await runCli(["resource", "tokens", "create"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("Missing option '--resource-id' / '-r'.");
  });
});

describe("kagura-memory resource ingest --payload", () => {
  it("rejects a JSON array", async () => {
    const h = harness();
    expect(
      await runCli(
        ["resource", "ingest", "-r", "r", "-k", "k", "--doc-id", "d", "-p", "[1,2]"],
        h.deps,
      ),
    ).toBe(2);
    expect(h.err.join("\n")).toContain("--payload must be a JSON object.");
  });

  it("sends a JSON object through", async () => {
    const h = harness();
    h.rest.body = { status: "accepted" };
    await runCli(
      ["resource", "ingest", "-r", "r", "-k", "k", "--doc-id", "d", "-p", '{"a":1}'],
      h.deps,
    );
    expect(h.rest.last().body).toMatchObject({ payload: { a: 1 } });
  });
});

describe("kagura-memory resource ingest-batch --file", () => {
  /** A temp directory holding `events.json` with `text`, removed afterwards. */
  function withFile(text: string, run: (dir: string, file: string) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-batch-"));
    const file = path.join(dir, "events.json");
    fs.writeFileSync(file, text);
    return run(dir, file).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  }

  it("words a file it cannot open as click.File does, and as `resource import --file` does", async () => {
    await withFile("[]", async (dir) => {
      const missing = path.join(dir, "missing.json");
      for (const command of ["ingest-batch", "import"]) {
        const h = harness();
        expect(await runCli(["resource", command, "-r", "p", "-k", "k", "-f", missing], h.deps)).toBe(2);
        // Python's `'<path>': <strerror>`, not Node's `ENOENT: …, open '…'`.
        expect(h.err[0]).toBe(`Error: Invalid value for '--file' / '-f': '${missing}': No such file or directory`);
        expect(h.rest.requests).toEqual([]);
      }
      const h = harness();
      expect(await runCli(["resource", "ingest-batch", "-r", "p", "-k", "k", "-f", dir], h.deps)).toBe(2);
      expect(h.err[0]).toBe(`Error: Invalid value for '--file' / '-f': '${dir}': Is a directory`);
    });
  });

  it("sends the file's events", async () => {
    await withFile('[{"doc_id": "d1", "payload": {"a": 1}}]', async (_dir, file) => {
      const h = harness();
      h.rest.body = { created_count: 1, failed_count: 0, errors: [] };
      expect(await runCli(["resource", "ingest-batch", "-r", "p", "-k", "k", "-f", file], h.deps)).toBe(0);
      expect(h.rest.last().body).toMatchObject({ events: [{ doc_id: "d1", op: "upsert", payload: { a: 1 } }] });
    });
  });
});

describe("kagura-memory resource: review fixes", () => {
  it("refuses an empty tokens update instead of sending a no-op PATCH", async () => {
    const h = harness();
    const code = await runCli(["resource", "tokens", "update", "42"], h.deps);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toBe("Error: At least --description or --quota is required");
    expect(h.rest.requests).toEqual([]);
  });

  it("rejects a non-numeric --importance rather than sending null", async () => {
    // Number.parseFloat("abc") is NaN, which survives an `!== undefined`
    // guard and serializes to null — silently clearing the field.
    const h = harness();
    const code = await runCli(
      ["resource", "ingest", "-r", "r", "-k", "k", "--doc-id", "d", "--importance", "abc"],
      h.deps,
    );
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("is not a valid float");
    expect(h.rest.requests).toEqual([]);
  });
});

describe("REST clients are built through the credential chain", () => {
  it("`resource setup` sets a resource up, naming the context after it", async () => {
    // It needs the MCP URL that only fromMcpUrl/fromResolvedAuth stamps.
    // Built bare it threw "setupResource() requires MCP URL" on EVERY
    // invocation, before any request — the command was unusable, not
    // merely misconfigured.
    //
    // Past that, the server requires a context name, which the command has
    // no flag for: without the resource id as the default it was refused
    // with missing_fields on every call (#47).
    const server = new FakeServer();
    server.toolResults.setup_resource = {
      status: "success",
      context_id: CONTEXT_UUID,
      context_name: "res-1",
      resource_id: "res-1",
      token: "kagura_rt_x",
      token_id: 1,
    };
    const h = harness(server.fetch);
    const code = await runCli(["resource", "setup", "-r", "res-1"], h.deps);

    expect(h.err).toEqual([]);
    expect(code).toBe(0);
    expect(server.toolCallArgs()).toEqual({
      resource_id: "res-1",
      name: "res-1",
      quota_events_per_hour: 1000,
    });
    expect(JSON.parse(h.out.join("\n"))).toMatchObject({
      context_id: CONTEXT_UUID,
      token: "kagura_rt_x",
    });
  });

  it("`resource setup --summary` says the server ignores it, and does not send it (#47)", async () => {
    const server = new FakeServer();
    server.toolResults.setup_resource = SETUP_RESULT;
    const h = harness(server.fetch);
    const code = await runCli(["resource", "setup", "-r", "res-1", "-s", "About res-1"], h.deps);

    expect(code).toBe(0);
    expect(h.err).toEqual([SETUP_SUMMARY_IGNORED_NOTE]);
    // The note names the command that does set it.
    expect(SETUP_SUMMARY_IGNORED_NOTE).toMatch(/--summary.*ignored.*context update <context_id> --summary/);
    expect(server.toolCallArgs()).not.toHaveProperty("summary");
  });
});

describe("kagura-memory resource tokens / schema: Python's lines", () => {
  it("prints `Token revoked.` for a revoke, as Python does, not a JSON document", async () => {
    const h = harness();
    h.rest.status = 204;
    expect(await runCli(["resource", "tokens", "revoke", "42"], h.deps)).toBe(0);
    expect(h.out).toEqual(["Token revoked."]);
    expect(h.err).toEqual([]);
    expect(h.rest.last().method).toBe("DELETE");
    expect(new URL(h.rest.last().url).pathname).toBe("/api/v1/resource-tokens/42");
  });

  it.each([
    ["revoke", []],
    ["update", ["-d", "x"]],
  ])("reads TOKEN_ID as Python's int() does on %s: 1_000 is 1000", async (command, extra) => {
    const h = harness();
    h.rest.status = command === "revoke" ? 204 : 200;
    h.rest.body = { ...TOKEN, id: 1000 };
    expect(await runCli(["resource", "tokens", command, "1_000", ...extra], h.deps)).toBe(0);
    expect(new URL(h.rest.last().url).pathname).toBe("/api/v1/resource-tokens/1000");
  });

  it.each([
    ["revoke", [], "DELETE"],
    ["update", ["-d", "x"], "PATCH"],
  ])(
    "%s sends TOKEN_ID exactly past 2^53, as Python's int() holds it, never a rounded neighbour",
    async (command, extra, method) => {
      for (const id of ["9007199254740993", "1000000000000000000000"]) {
        const h = harness();
        h.rest.status = command === "revoke" ? 204 : 200;
        h.rest.body = TOKEN;
        expect(await runCli(["resource", "tokens", command, id, ...extra], h.deps)).toBe(0);
        expect(h.rest.last().method).toBe(method);
        // Not .../9007199254740992, not .../1e+21.
        expect(new URL(h.rest.last().url).pathname).toBe(`/api/v1/resource-tokens/${id}`);
      }
    },
  );

  it("reports a revoke the server refuses on stderr, and prints nothing", async () => {
    const h = harness();
    h.rest.status = 404;
    h.rest.body = { detail: "Token not found" };
    expect(await runCli(["resource", "tokens", "revoke", "42"], h.deps)).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.err[0]).toMatch(/^Error: .*Token not found/);
  });

  it("prints Python's line when no schema is registered, not `null`", async () => {
    const h = harness();
    h.rest.status = 404;
    h.rest.body = { detail: "Not Found" };
    expect(await runCli(["resource", "schema", "-r", "res-1"], h.deps)).toBe(0);
    expect(h.out).toEqual(["No schema registered for this resource."]);
    expect(h.err).toEqual([]);
  });

  it("prints a registered schema as the Python model's dump", async () => {
    const h = harness();
    h.rest.body = SCHEMA;
    expect(await runCli(["resource", "schema", "-r", "res-1"], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join("\n"))).toEqual({
      ...SCHEMA,
      field_definitions: [
        {
          name: "sku",
          type: "text",
          description: "Stock keeping unit",
          classification: "public",
          index_hint: "",
          unit: null,
          enum_values: null,
          example: null,
          required: false,
        },
      ],
    });
  });
});

describe("kagura-memory resource setup (python-sdk#275)", () => {
  /** Run `resource setup` against an MCP fake answering `result`. */
  async function setup(argv: string[], result: unknown = SETUP_RESULT) {
    const server = new FakeServer();
    server.toolResults.setup_resource = result;
    const h = harness(server.fetch);
    const code = await runCli(["resource", "setup", ...argv], h.deps);
    return { ...h, server, code };
  }

  const MODEL_KEYS = ["context_id", "context_name", "resource_id", "token", "token_id", "warning"];

  it("prints Python's ResourceSetupResponse: six keys in its order, without status or message", async () => {
    const r = await setup(["-r", "res-1"]);
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    const printed = JSON.parse(r.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(printed)).toEqual(MODEL_KEYS);
    // The server may leave the warning out; the model's default is null.
    expect(printed).toEqual({
      context_id: CONTEXT_UUID,
      context_name: "res-1",
      resource_id: "res-1",
      token: "kagura_rt_x",
      token_id: 1,
      warning: null,
    });
    // Indented as model_dump_json(indent=2).
    expect(r.out.join("\n")).toContain('{\n  "context_id": ');
  });

  it("keeps the server's warning, in the model's order, and reads token_id as pydantic does", async () => {
    const warning = "Save this token — it will not be shown again.";
    const r = await setup(["-r", "res-1"], { warning, ...SETUP_RESULT, token_id: "7" });
    expect(r.code).toBe(0);
    const text = r.out.join("\n");
    expect(Object.keys(JSON.parse(text))).toEqual(MODEL_KEYS);
    // pydantic reads "7" as the int 7, and the dump leaves the dash unescaped.
    expect(JSON.parse(text)).toMatchObject({ token_id: 7, warning });
    expect(text).toContain("—");
  });

  it("names the context after the resource unless --name is given", async () => {
    const r = await setup(["-r", "products"]);
    expect(r.server.toolCallArgs()).toEqual({
      resource_id: "products",
      name: "products",
      quota_events_per_hour: 1000,
    });
  });

  it.each([
    [["-n", "product-catalog", "-q", "50"], "product-catalog", 50],
    [["--name", "product-catalog"], "product-catalog", 1000],
    // Sent as given, as Python sends it; the server refuses it itself.
    [["--name="], "", 1000],
  ])("passes %j through as the context name", async (extra, name, quota) => {
    const r = await setup(["-r", "products", ...extra]);
    expect(r.code).toBe(0);
    expect(r.server.toolCallArgs()).toEqual({
      resource_id: "products",
      name,
      quota_events_per_hour: quota,
    });
  });

  it("says --summary is ignored in Python's words, on stderr only", async () => {
    const r = await setup(["-r", "products", "-s", "catalog"]);
    expect(r.code).toBe(0);
    expect(r.err).toEqual([
      "Note: --summary is ignored, since the server's setup_resource has no summary. " +
        "Set it after setup with `kagura-memory context update <context_id> --summary ...` " +
        "(context owner only).",
    ]);
    expect(r.server.toolCallArgs()).not.toHaveProperty("summary");
    expect(JSON.parse(r.out.join("\n"))).toMatchObject({ token: "kagura_rt_x" });
  });

  it("prints the note before any config work, so a config failure follows it", async () => {
    const h = harness();
    (h.deps as unknown as { loadConfig: () => never }).loadConfig = () => {
      throw new Error(".kagura.json is not valid JSON");
    };
    expect(await runCli(["resource", "setup", "-r", "products", "-s", ""], h.deps)).toBe(1);
    expect(h.err).toEqual([SETUP_SUMMARY_IGNORED_NOTE, "Error: .kagura.json is not valid JSON"]);
    expect(h.out).toEqual([]);
  });

  it("refuses an out-of-range --quota before the note, as click does", async () => {
    const r = await setup(["-r", "products", "-s", "catalog", "-q", "0"]);
    expect(r.code).toBe(2);
    expect(r.err).toEqual([
      "Error: Invalid value for '--quota' / '-q': 0 is not in the range 1<=x<=10000.",
    ]);
    expect(r.server.requests).toEqual([]);
  });

  it("names every field of a result the model rejects, never a value", async () => {
    const r = await setup(["-r", "res-1"], {
      status: "success",
      context_id: CONTEXT_UUID,
      context_name: "res-1",
      resource_id: "res-1",
      token_id: "twelve",
    });
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err).toEqual([
      "Error: ResourceClient.setup_resource: unexpected server response for ResourceSetupResponse " +
        "(token: Field required; token_id: Input should be a valid integer, unable to parse string " +
        "as an integer). The server may be newer than this SDK; upgrading kagura-memory may help.",
    ]);
  });

  it("documents --name, the help texts and the examples", async () => {
    const h = harness();
    expect(await runCli(["resource", "setup", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("One-shot resource setup: create context + set resource_id + create token.");
    expect(text).toMatch(/-r, --resource-id TEXT +Resource identifier$/m);
    expect(text).toMatch(
      /-n, --name TEXT +Context name \(default: the resource id; lowercase letters, digits, hyphens, underscores; max 100\)\. Needed when a context of that name already exists$/m,
    );
    expect(text).toMatch(
      /-s, --summary TEXT +Deprecated and ignored by the server; use `kagura-memory context update` after setup$/m,
    );
    expect(text).toContain(
      "  Examples:\n" +
        "    kagura-memory resource setup -r products\n" +
        "    kagura-memory resource setup -r products -n product-catalog\n" +
        '    kagura-memory resource setup -r slack-messages -d "Slack sync" -q 5000',
    );
    // The options in Python's order.
    const order = ["--resource-id", "--name", "--summary", "--description", "--quota"].map((f) =>
      text.indexOf(f),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
