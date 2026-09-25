/**
 * Tests for MemoryClient — the REST guardrail routes (memory-cloud
 * v0.74.0+): `POST /api/v1/memory/guardrails` and
 * `GET /api/v1/memory/guardrails/digest`. The cases mirror the Python
 * SDK's "MemoryClient (REST twin)" tests in tests/test_guardrails.py, plus
 * the error bodies the current server sends.
 */

import { describe, expect, it } from "vitest";

import { GUARDRAIL_VERSION_HEADER, MemoryClient } from "../src/memoryClient.js";
import { KaguraConnectionError, KaguraNotFoundError, KaguraResponseError } from "../src/errors.js";
import type { GuardrailItem, GuardrailSet, ToolTrigger } from "../src/models.js";
import { FakeRest } from "./fakeServer.js";

const CTX = "11111111-2222-3333-4444-555555555555";
const VERSION = "3f9c1a7b2d4e6f80";
const EXPORT_BLOCK =
  `<!-- kagura-memory:guardrails begin context=${CTX} tool_triggered_version=${VERSION} -->\n` +
  "- (bbbbbbbb) gh pr merge --delete-branch closes the child PR\n" +
  "<!-- kagura-memory:guardrails end -->\n";

function item(memoryId: string): Record<string, unknown> {
  return {
    memory_id: memoryId,
    summary: "Squash-merge only after the head SHA matches",
    context_summary: null,
    type: "decision",
    importance: 0.9,
    delivery_mode: "on_recall",
    tool_trigger: { tool: "Bash|PowerShell", on: "pre", match: "gh pr merge", action: "inform" },
    source_type: "manual",
    authored_by_caller: true,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
  };
}

/** The REST route's body: the MCP tool's lanes without the context block. */
const GUARDRAIL_SET = {
  status: "success",
  format: 1,
  version: VERSION,
  pinned: [],
  tool_triggered: [item("bbbbbbbb-0000-0000-0000-000000000002")],
  total_available: 7,
  truncated: true,
  cap: 1,
  pinned_cap: 1,
  pinned_total_available: 3,
  pinned_truncated: true,
  tool_triggered_total_available: 4,
  tool_triggered_truncated: true,
};

function makeClient(server: FakeRest): MemoryClient {
  return new MemoryClient({ apiKey: "kagura_test", baseUrl: "https://x.test", fetch: server.fetch });
}

/** The query of the last request, as ordered pairs. */
function query(server: FakeRest): Array<[string, string]> {
  return [...new URL(server.requests.at(-1)!.url).searchParams.entries()];
}

describe("construction", () => {
  it("requires credentials, naming the class and its factory", () => {
    expect(() => new MemoryClient()).toThrow(
      /MemoryClient requires apiKey, or use MemoryClient\.fromMcpUrl/,
    );
  });

  it("derives the REST base from an MCP URL", async () => {
    const server = new FakeRest();
    const client = MemoryClient.fromMcpUrl({
      apiKey: "kagura_test",
      mcpUrl: "https://x.test/mcp/w/abc?profile=core",
      fetch: server.fetch,
      env: {},
    });
    await client.getGuardrailDigest(CTX);
    expect(server.requests[0]!.url.split("?")[0]).toBe(
      "https://x.test/api/v1/memory/guardrails/digest",
    );
    expect(server.requests[0]!.headers.authorization).toBe("Bearer kagura_test");
  });
});

describe("loadGuardrails (REST)", () => {
  it("POSTs the context and returns the set, with no context block", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify(GUARDRAIL_SET);

    const result = await makeClient(server).loadGuardrails(CTX);

    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://x.test/api/v1/memory/guardrails");
    // cap omitted → the server default (50).
    expect(JSON.parse(req.body!)).toEqual({ context_id: CTX });
    expect(result.pinned_truncated).toBe(true);
    expect(result.tool_triggered_truncated).toBe(true);
    // The model's `None`: this surface carries no context block.
    expect(result.context_id).toBeNull();
    expect(result.context_name).toBeNull();
  });

  it("sends the cap, and the canonical form of the context id", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify({ ...GUARDRAIL_SET, truncated: false });

    await makeClient(server).loadGuardrails(CTX.toUpperCase(), { cap: 25 });

    expect(JSON.parse(server.requests[0]!.body!)).toEqual({ context_id: CTX, cap: 25 });
  });

  it("refuses a non-UUID before any request", async () => {
    const server = new FakeRest();
    await expect(makeClient(server).loadGuardrails("not-a-uuid")).rejects.toThrow(
      "context_id must be a UUID, got 'not-a-uuid'",
    );
    expect(server.requests).toEqual([]);
  });

  it("maps the uniform 404", async () => {
    const server = new FakeRest();
    server.status = 404;
    server.body = JSON.stringify({ detail: "Context not found" });
    await expect(makeClient(server).loadGuardrails(CTX)).rejects.toBeInstanceOf(
      KaguraNotFoundError,
    );
  });

  it("maps a server older than v0.74.0 to HTTP 405, not Not Found", async () => {
    // Unlike getGuardrailDigest, whose missing route is the uniform 404,
    // an older server refuses this POST with a 405 (the Python SDK's
    // MemoryClient documents the same), and the README says so.
    const server = new FakeRest();
    server.status = 405;
    server.body = JSON.stringify({ error: "HTTP-405", message: "Method Not Allowed", details: {} });
    const err = await makeClient(server)
      .loadGuardrails(CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraConnectionError);
    expect(err).not.toBeInstanceOf(KaguraNotFoundError);
    expect((err as Error).message).toBe("HTTP 405: Method Not Allowed");
  });
});

describe("loadGuardrails (REST) response check", () => {
  const HINT = "The server may be newer than this SDK; upgrading kagura-memory may help.";
  const OP = "MemoryClient.load_guardrails";

  /** GUARDRAIL_SET with both lanes filled, `edit` applied to a deep copy. */
  function payload(edit: (p: Record<string, any>) => unknown = () => undefined): unknown {
    const p: Record<string, any> = structuredClone({
      ...GUARDRAIL_SET,
      pinned: [{ ...item("aaaaaaaa-0000-0000-0000-000000000001"), tool_trigger: null }],
    });
    const replaced = edit(p);
    return replaced === undefined ? p : replaced;
  }

  async function load(body: unknown): Promise<unknown> {
    const server = new FakeRest();
    server.body = JSON.stringify(body);
    return makeClient(server).loadGuardrails(CTX);
  }

  it("refuses a set missing a truncation flag rather than read it as complete", async () => {
    // Python's test_rest_load_guardrails_missing_flag_is_a_response_error.
    const err = await load(payload((p) => void delete p.tool_triggered_truncated)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as KaguraResponseError).operation).toBe(OP);
    expect((err as Error).message).toBe(
      `${OP}: unexpected server response for GuardrailSet ` +
        `(tool_triggered_truncated: Field required). ${HINT}`,
    );
  });

  // Each expected text is the Python SDK's parse_response output for the
  // same payload (kagura-memory 0.40.1, pydantic 2.13.4).
  it.each<[string, (p: Record<string, any>) => unknown, string]>([
    [
      "all three flags missing",
      (p) => {
        delete p.truncated;
        delete p.pinned_truncated;
        delete p.tool_triggered_truncated;
      },
      "truncated: Field required; pinned_truncated: Field required; " +
        "tool_triggered_truncated: Field required",
    ],
    [
      "an empty object",
      () => ({}),
      "format: Field required; version: Field required; pinned: Field required (+9 more)",
    ],
    [
      "ints that are not whole numbers",
      (p) => Object.assign(p, { cap: "fifty", pinned_cap: 1.5 }),
      "cap: Input should be a valid integer, unable to parse string as an integer; " +
        "pinned_cap: Input should be a valid integer, got a number with a fractional part",
    ],
    [
      "flags that are not booleans",
      (p) => Object.assign(p, { truncated: "maybe", pinned_truncated: 2, tool_triggered_truncated: 0.5 }),
      "truncated: Input should be a valid boolean, unable to interpret input; " +
        "pinned_truncated: Input should be a valid boolean, unable to interpret input; " +
        "tool_triggered_truncated: Input should be a valid boolean",
    ],
    ["a numeric version", (p) => Object.assign(p, { version: 5 }), "version: Input should be a valid string"],
    ["a null status", (p) => Object.assign(p, { status: null }), "status: Input should be a valid string"],
    ["a null lane", (p) => Object.assign(p, { pinned: null }), "pinned: Input should be a valid list"],
    ["an object lane", (p) => Object.assign(p, { pinned: {} }), "pinned: Input should be a valid list"],
    [
      "an item that is not an object",
      (p) => Object.assign(p, { tool_triggered: ["x"] }),
      "tool_triggered.0: Input should be a valid dictionary or instance of GuardrailItem",
    ],
    [
      "an item without its summary",
      (p) => void delete p.pinned[0].summary,
      "pinned.0.summary: Field required",
    ],
    [
      "an item importance that is not a number",
      (p) => void Object.assign(p.pinned[0], { importance: "high" }),
      "pinned.0.importance: Input should be a valid number, unable to parse string as a number",
    ],
    [
      "a numeric memory id",
      (p) => void Object.assign(p.tool_triggered[0], { memory_id: 5 }),
      "tool_triggered.0.memory_id: Input should be a valid string",
    ],
    [
      "a JSON array",
      () => [],
      "Input should be a valid dictionary or instance of GuardrailSet",
    ],
    ["JSON null", () => null, "Input should be a valid dictionary or instance of GuardrailSet"],
  ])("refuses %s, in Python's words", async (_name, edit, problems) => {
    const err = await load(payload(edit)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as Error).message).toBe(
      `${OP}: unexpected server response for GuardrailSet (${problems}). ${HINT}`,
    );
  });

  it("reads the checked fields as pydantic's lax mode does", async () => {
    const result = await load(
      payload((p) => {
        delete p.status;
        Object.assign(p, {
          format: "1",
          cap: "50.0",
          total_available: " 7 ",
          truncated: "yes",
          pinned_truncated: "off",
          tool_triggered_truncated: 1,
          pinned_cap: true,
        });
        p.pinned[0].importance = "0.5";
      }),
    );
    // Python's GuardrailSet reads the same payload as these values.
    expect(result).toMatchObject({
      status: "success",
      format: 1,
      cap: 50,
      total_available: 7,
      truncated: true,
      pinned_truncated: false,
      tool_triggered_truncated: true,
      pinned_cap: 1,
    });
    expect((result as { pinned: Array<{ importance: unknown }> }).pinned[0]!.importance).toBe(0.5);
  });

  it("returns the model's fields only, in its order, as Python's GuardrailSet dumps them", async () => {
    // Python 0.40.1: extra keys dropped (extra="ignore"), the context block
    // None, an item's optional fields None when absent.
    const result = await load(
      payload((p) => {
        Object.assign(p, { some_future_field: { x: 1 } });
        Object.assign(p.pinned[0], { extra_x: 1 });
        for (const key of ["type", "delivery_mode", "source_type", "authored_by_caller", "created_at"]) {
          delete p.pinned[0][key];
        }
      }),
    );
    expect(Object.keys(result as object)).toEqual([
      "status", "format", "version", "pinned", "tool_triggered", "total_available", "truncated", "cap",
      "pinned_cap", "pinned_total_available", "pinned_truncated", "tool_triggered_total_available",
      "tool_triggered_truncated", "context_id", "context_name",
    ]);
    const set = result as { pinned: Record<string, unknown>[]; context_id: unknown };
    expect(set.context_id).toBeNull();
    expect(set.pinned[0]).toEqual({
      memory_id: "aaaaaaaa-0000-0000-0000-000000000001",
      summary: "Squash-merge only after the head SHA matches",
      context_summary: null,
      type: null,
      importance: 0.9,
      delivery_mode: null,
      tool_trigger: null,
      source_type: null,
      authored_by_caller: null,
      created_at: null,
      updated_at: "2026-09-02T00:00:00Z",
    });
  });

  // The same reader as `guardrails load`: the SDK and the bin refuse the
  // same sets. Each text is Python 0.40.1's parse_response for the payload.
  it.each<[string, (p: Record<string, any>) => unknown, string]>([
    [
      "an optional item field of the wrong type",
      (p) => void Object.assign(p.pinned[0], { type: 5, tool_trigger: { tool: 7 } }),
      "pinned.0.type: Input should be a valid string",
    ],
    [
      "a required and an optional field together, in the model's order",
      (p) => {
        delete p.pinned[0].summary;
        p.pinned[0].type = 5;
      },
      "pinned.0.summary: Field required; pinned.0.type: Input should be a valid string",
    ],
    [
      "optional scalars of the wrong type",
      (p) =>
        void Object.assign(p.tool_triggered[0], {
          delivery_mode: 1,
          source_type: [],
          authored_by_caller: "maybe",
        }),
      "tool_triggered.0.delivery_mode: Input should be a valid string; " +
        "tool_triggered.0.source_type: Input should be a valid string; " +
        "tool_triggered.0.authored_by_caller: Input should be a valid boolean, unable to interpret input",
    ],
    ["a numeric context id", (p) => Object.assign(p, { context_id: 5 }), "context_id: Input should be a valid string"],
  ])("refuses %s, as Python's model does", async (_name, edit, problems) => {
    const err = await load(payload(edit)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as Error).message).toBe(
      `${OP}: unexpected server response for GuardrailSet (${problems}). ${HINT}`,
    );
  });

  it("types the fields it may fill with null as nullable, as Python's Optional fields are", async () => {
    // Compile-time half: each entry is `true` only while `null` is part of
    // the field's type, so a field narrowed back to `string` fails
    // typecheck — a strict caller's `item.type.toUpperCase()` or
    // `match === undefined` check must not compile against a null.
    type Nullable<T, K extends keyof T> = null extends T[K] ? true : false;
    const nullable: [
      Nullable<GuardrailItem, "type">,
      Nullable<GuardrailItem, "delivery_mode">,
      Nullable<GuardrailItem, "source_type">,
      Nullable<GuardrailItem, "authored_by_caller">,
      Nullable<GuardrailItem, "created_at">,
      Nullable<GuardrailItem, "updated_at">,
      Nullable<ToolTrigger, "match">,
    ] = [true, true, true, true, true, true, true];
    expect(nullable).not.toContain(false);

    const server = new FakeRest();
    server.body = JSON.stringify(
      payload((p) => {
        for (const key of ["type", "delivery_mode", "source_type", "authored_by_caller", "created_at", "updated_at"]) {
          delete p.tool_triggered[0][key];
        }
        delete p.tool_triggered[0].tool_trigger.match;
      }),
    );
    const set: GuardrailSet = await makeClient(server).loadGuardrails(CTX);
    const [read] = set.tool_triggered;
    expect(read).toMatchObject({
      type: null,
      delivery_mode: null,
      source_type: null,
      authored_by_caller: null,
      created_at: null,
      updated_at: null,
    });
    expect(read!.tool_trigger!.match).toBeNull();
  });

  it("reads a tool_trigger that is no trigger as null, as Python's _validate_or_none does", async () => {
    const result = (await load(payload((p) => void (p.pinned[0].tool_trigger = { tool: 7 })))) as {
      pinned: Array<{ tool_trigger: unknown }>;
      tool_triggered: Array<{ tool_trigger: unknown }>;
    };
    expect(result.pinned[0]!.tool_trigger).toBeNull();
    expect(result.tool_triggered[0]!.tool_trigger).toEqual({
      tool: "Bash|PowerShell",
      on: "pre",
      match: "gh pr merge",
      action: "inform",
    });
  });
});

describe("getGuardrailDigest", () => {
  it("GETs the export target and returns the text and the version header", async () => {
    const server = new FakeRest();
    server.body = EXPORT_BLOCK;
    server.responseHeaders = {
      "Content-Type": "text/markdown; charset=utf-8",
      [GUARDRAIL_VERSION_HEADER]: VERSION,
    };

    const digest = await makeClient(server).getGuardrailDigest(CTX);

    expect(server.requests[0]!.method).toBe("GET");
    expect(new URL(server.requests[0]!.url).pathname).toBe("/api/v1/memory/guardrails/digest");
    expect(query(server)).toEqual([
      ["context_id", CTX],
      ["target", "export"],
    ]);
    expect(digest).toEqual({
      context_id: CTX,
      target: "export",
      text: EXPORT_BLOCK,
      tool_triggered_version: VERSION,
      content_type: "text/markdown; charset=utf-8",
    });
  });

  it("forwards the tool view for the instructions target, encoded as Python encodes it", async () => {
    const server = new FakeRest();
    server.body = "base text";
    server.responseHeaders = { [GUARDRAIL_VERSION_HEADER]: VERSION };

    const digest = await makeClient(server).getGuardrailDigest(CTX, {
      target: "instructions",
      profile: "core",
      tools: "remember,recall a&b",
    });

    expect(server.requests[0]!.url.split("?")[1]).toBe(
      `context_id=${CTX}&target=instructions&profile=core&tools=remember%2Crecall+a%26b`,
    );
    expect(digest.text).toBe("base text");
    expect(digest.target).toBe("instructions");
  });

  it("sends an empty profile or tools value, as Python's `is not None` does", async () => {
    const server = new FakeRest();
    server.body = "";
    await makeClient(server).getGuardrailDigest(CTX, {
      target: "instructions",
      profile: "",
      tools: "",
    });
    expect(query(server)).toEqual([
      ["context_id", CTX],
      ["target", "instructions"],
      ["profile", ""],
      ["tools", ""],
    ]);
  });

  it("returns an empty set as empty text, with its version", async () => {
    const server = new FakeRest();
    server.body = "";
    server.responseHeaders = { [GUARDRAIL_VERSION_HEADER]: "4f53cda18c2baa0c" };

    const digest = await makeClient(server).getGuardrailDigest(CTX);

    expect(digest.text).toBe("");
    expect(digest.tool_triggered_version).toBe("4f53cda18c2baa0c");
  });

  it("reads a missing version header as null", async () => {
    const server = new FakeRest();
    server.body = "";
    const digest = await makeClient(server).getGuardrailDigest(CTX);
    expect(digest.tool_triggered_version).toBeNull();
  });

  it("canonicalizes the context id it sends and returns", async () => {
    const server = new FakeRest();
    server.body = "";
    const digest = await makeClient(server).getGuardrailDigest(`{${CTX.toUpperCase()}}`);
    expect(query(server)[0]).toEqual(["context_id", CTX]);
    expect(digest.context_id).toBe(CTX);
  });

  it.each([
    ["not-a-uuid", "'not-a-uuid'"],
    // Python's uuid.UUID does not trim, so neither does this.
    [` ${CTX}`, `' ${CTX}'`],
  ])("refuses %j before any request, in Python's words", async (raw, shown) => {
    const server = new FakeRest();
    await expect(makeClient(server).getGuardrailDigest(raw)).rejects.toThrow(
      `context_id must be a UUID, got ${shown}`,
    );
    expect(server.requests).toEqual([]);
  });

  it("maps the uniform 404 to the server's message", async () => {
    const server = new FakeRest();
    server.status = 404;
    server.body = JSON.stringify({
      error: "RES-001",
      message: `Context not found: ${CTX}`,
      details: {},
    });
    const err = await makeClient(server)
      .getGuardrailDigest(CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraNotFoundError);
    expect((err as Error).message).toBe(`Context not found: ${CTX}`);
  });

  it("maps a server older than v0.74.0 (no route) to Not Found", async () => {
    const server = new FakeRest();
    server.status = 404;
    server.body = JSON.stringify({ error: "HTTP-404", message: "Not Found", details: {} });
    await expect(makeClient(server).getGuardrailDigest(CTX)).rejects.toThrow(
      new KaguraNotFoundError("Not Found"),
    );
  });

  it("maps an OAuth scope refusal to Python's HTTP 403 text", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "AUTH-003",
      message: "Insufficient scope: memory:read required",
    });
    const err = await makeClient(server)
      .getGuardrailDigest(CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraConnectionError);
    expect((err as Error).message).toBe("HTTP 403: Insufficient scope: memory:read required");
  });

  it("maps a bodiless 500 to the bare status", async () => {
    const server = new FakeRest();
    server.status = 500;
    server.body = "oops";
    server.responseHeaders = { "Content-Type": "text/plain" };
    await expect(makeClient(server).getGuardrailDigest(CTX)).rejects.toThrow(
      new KaguraConnectionError("HTTP 500"),
    );
  });
});
