/**
 * The write and read arguments of memory-cloud v0.78.0–v0.140.0 (#87), the
 * port of the Python SDK 0.44.0's (python-sdk #302, tests/test_memory_edits.py):
 * `remember({ observedAt, dedupe, tagsNormalize, verbose, toolTrigger })`,
 * `updateMemory({ observedAt, addTags, removeTags, detailsPatch,
 * expectedVersion, acceptSupersedeCandidate, verbose, toolTrigger })`,
 * `reference({ version, contentOffset, detailsOffset, contextOffset, fields,
 * maxChars })`, `updateSearchConfig({ contentChunksEnabled,
 * llmSelectorEnabled })`, recall's `observedAfter` / `observedBefore`, and
 * {@link KaguraVersionConflictError} on both transports.
 *
 * Each argument reaches the wire under its server name only when set, and
 * each local rule is shown to throw before any request — not even the MCP
 * initialize.
 */

import { describe, expect, it } from "vitest";

import {
  checkUpdateMemoryOptions,
  type ReferenceOptions,
  type RememberOptions,
  type UpdateMemoryOptions,
} from "../src/client.js";
import {
  KaguraConnectionError,
  KaguraError,
  KaguraResponseError,
  KaguraVersionConflictError,
} from "../src/errors.js";
import { runCli, type CliDeps } from "../src/cli/run.js";
import * as sdk from "../src/index.js";
import type { HttpMethod, RestResponse } from "../src/restBase.js";
import { KaguraRestClient } from "../src/restBase.js";
import { FakeRest, FakeServer, makeClient } from "./fakeServer.js";

const CTX = "11111111-2222-4333-8444-555555555555";
const MEM = "22222222-3333-4444-8555-666666666666";
const BASE: RememberOptions = { contextId: CTX, summary: "A summary of ten", content: "c" };
const BASE_WIRE = { context_id: CTX, summary: "A summary of ten", content: "c", type: "note", importance: 0.5 };

async function rememberArgs(options: Partial<RememberOptions>) {
  const server = new FakeServer();
  await makeClient(server).remember({ ...BASE, ...options });
  return server.toolCallArgs(0);
}

async function updateArgs(options: Omit<UpdateMemoryOptions, "contextId">) {
  const server = new FakeServer();
  await makeClient(server).updateMemory({ contextId: CTX, ...options });
  return server.toolCallArgs(0);
}

/** The call throws `message` and nothing reached the server. */
async function expectLocalRefusal(call: (client: ReturnType<typeof makeClient>) => Promise<unknown>, message: string | RegExp) {
  const server = new FakeServer();
  await expect(call(makeClient(server))).rejects.toThrow(message);
  expect(server.requests).toEqual([]);
}

// ============================================================================
// observedAt: the server's accepted forms, checked locally
// ============================================================================

const HINT = "observedAt must be an ISO 8601 date (2024-03-07) or datetime (2024-03-07T10:00:00Z)";

describe("observedAt is checked as memory-cloud v0.127.0 checks it", () => {
  // Each verdict is the Python SDK 0.44.0's `_observed_at_arg` on the same string.
  it.each([
    "2024-03-07",
    "2024-02-29",
    "0001-01-01",
    "2024-03-07T10:00:00",
    "2024-03-07T10:00:00Z",
    "2024-03-07T10:00:00.1234567Z",
    "2024-03-07T10:00:00+23:59",
    "2024-03-07T10:00:00-00:00",
    "2024-03-07T10:00:00.123+01:00",
    "0001-01-01T00:00:00-01:00",
    "9999-12-31T23:00:00+01:00",
    // fromisoformat does not range-check an offset's minutes, only the
    // whole offset (under 24 hours): the server's CPython 3.11 reads these.
    "2024-03-07T10:00:00+00:60",
    "2024-03-07T10:00:00+05:99",
    "2024-03-07T10:00:00-00:99",
    "0001-01-01T01:00:00+00:60",
    " 2024-03-07 ",
    "2024-03-07\n",
    "　2024-03-07",
    `${" ".repeat(30)}2024-03-07`,
  ])("sends %j as given", async (value) => {
    expect((await rememberArgs({ observedAt: value })).observed_at).toBe(value);
  });

  it.each([
    "2024-02-30",
    "2023-02-29",
    "0000-01-01",
    "2024-13-01",
    "2024-00-10",
    "2024-01-00",
    "2024-03-07T10:00:00.Z",
    "2024-03-07T24:00:00",
    "2024-03-07T23:59:60",
    "2024-03-07T10:60:00",
    "2024-03-07T10:00:00+24:00",
    "2024-03-07T10:00:00+23:60",
    "2024-03-07T10:00:00+0100",
    "0001-01-01T00:00:00+01:00",
    "9999-12-31T23:00:00-01:00",
    "0001-01-01T00:30:00+00:31",
    "9999-12-31T23:59:59-00:01",
    "2024-03-07T10:00:00+22:120",
    "2024-03-07T10:00",
    "20240307",
    "2024-03-07 10:00:00",
    "2024-03-07t10:00:00",
    "x".repeat(41),
    `${" ".repeat(31)}2024-03-07`,
    "",
    "   ",
    "٢٠٢٤-03-07",
  ])("refuses %j before any request", async (value) => {
    await expectLocalRefusal((c) => c.remember({ ...BASE, observedAt: value }), `${HINT}, got `);
  });

  it("names the value as Python's repr does", async () => {
    await expectLocalRefusal(
      (c) => c.remember({ ...BASE, observedAt: "2026-02-30" }),
      `${HINT}, got '2026-02-30'`,
    );
  });

  it("refuses a value that is no string or Date by its type", async () => {
    await expectLocalRefusal(
      (c) => c.remember({ ...BASE, observedAt: 5 as unknown as string }),
      `${HINT}, got int`,
    );
  });

  it("sends a Date as its UTC instant, fractional seconds dropped", async () => {
    const args = await rememberArgs({ observedAt: new Date("2024-03-07T10:00:00.500+09:00") });
    expect(args.observed_at).toBe("2024-03-07T01:00:00Z");
    const early = await rememberArgs({ observedAt: new Date("0099-01-02T03:04:05Z") });
    expect(early.observed_at).toBe("0099-01-02T03:04:05Z");
  });

  it("refuses an invalid Date and one outside years 1-9999", async () => {
    await expectLocalRefusal((c) => c.remember({ ...BASE, observedAt: new Date("nope") }), `${HINT}, got an invalid Date`);
    await expectLocalRefusal(
      (c) => c.remember({ ...BASE, observedAt: new Date("+010000-01-01T00:00:00Z") }),
      `${HINT}, got +010000-01-01T00:00:00.000Z`,
    );
  });
});

// ============================================================================
// remember
// ============================================================================

describe("remember: observedAt, dedupe, tagsNormalize, verbose and toolTrigger", () => {
  it("sends none of them by default", async () => {
    expect(await rememberArgs({})).toEqual(BASE_WIRE);
  });

  it("sends each under its server name when set", async () => {
    const args = await rememberArgs({
      observedAt: "2026-11-01",
      dedupe: "check",
      tagsNormalize: true,
      verbose: true,
    });
    expect(args).toEqual({
      ...BASE_WIRE,
      observed_at: "2026-11-01",
      dedupe: "check",
      tags_normalize: true,
      verbose: true,
    });
  });

  it("sends only true for the two switches, and each dedupe mode as given", async () => {
    expect(await rememberArgs({ tagsNormalize: false, verbose: false })).toEqual(BASE_WIRE);
    for (const dedupe of ["suggest", "check", "off"] as const) {
      expect((await rememberArgs({ dedupe })).dedupe).toBe(dedupe);
    }
  });

  it("merges toolTrigger into details without changing the caller's object", async () => {
    const details = { client: "acme" };
    const args = await rememberArgs({ details, toolTrigger: { tool: "Bash", match: "rm -rf" } });
    expect(args.details).toEqual({ client: "acme", tool_trigger: { tool: "Bash", match: "rm -rf" } });
    expect(details).toEqual({ client: "acme" });
    expect((await rememberArgs({ toolTrigger: { tool: "Bash" } })).details).toEqual({ tool_trigger: { tool: "Bash" } });
  });

  it("sends observedAt beside a details.observed_at that agrees", async () => {
    const args = await rememberArgs({ observedAt: "2026-11-01", details: { observed_at: "2026-11-01" } });
    expect(args).toMatchObject({ details: { observed_at: "2026-11-01" }, observed_at: "2026-11-01" });
  });

  it("refuses observedAt beside a details.observed_at that disagrees", async () => {
    await expectLocalRefusal(
      (c) => c.remember({ ...BASE, observedAt: "2026-11-01", details: { observed_at: "2026-10-01" } }),
      "details['observed_at'] and observedAt disagree; give one of them (the server answers validation_error)",
    );
  });

  it("refuses toolTrigger beside a details.tool_trigger", async () => {
    await expectLocalRefusal(
      (c) => c.remember({ ...BASE, details: { tool_trigger: { tool: "x" } }, toolTrigger: { tool: "Bash" } }),
      "Pass the guardrail either as toolTrigger or as details['tool_trigger'], not both",
    );
  });

  it("refuses a dedupe mode the server does not know", async () => {
    await expectLocalRefusal(
      (c) => c.remember({ ...BASE, dedupe: "maybe" as "check" }),
      "dedupe must be 'suggest', 'check' or 'off', got 'maybe'",
    );
  });

  it("returns a duplicate_candidate reply instead of throwing", async () => {
    const server = new FakeServer();
    const reply = { status: "duplicate_candidate", candidate: { memory_id: "m-0", summary: "s", similarity: 0.91 } };
    server.toolResults.remember = reply;
    expect(await makeClient(server).remember({ ...BASE, dedupe: "check" })).toEqual(reply);
  });

  it("returns the write reply's version, session_id and summary cut as sent", async () => {
    const server = new FakeServer();
    const reply = {
      status: "success",
      memory_id: MEM,
      scope: "working",
      version: 1,
      session_id: "sess-1",
      summary_truncated: true,
      summary_original_length: 612,
    };
    server.toolResults.remember = reply;
    const result = await makeClient(server).remember(BASE);
    expect(result).toEqual(reply);
    expect(result.version).toBe(1);
  });

  it("throws dedupe_unavailable as a KaguraError with its code", async () => {
    const server = new FakeServer();
    server.toolResults.remember = { status: "error", error: "dedupe_unavailable", message: "nothing was written" };
    const err = await makeClient(server).remember({ ...BASE, dedupe: "check" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).code).toBe("dedupe_unavailable");
  });
});

// ============================================================================
// updateMemory
// ============================================================================

describe("updateMemory: the partial edits, expectedVersion, the accept and observedAt", () => {
  it("sends none of them by default", async () => {
    expect(await updateArgs({ memoryId: MEM, summary: "A summary of ten" })).toEqual({
      context_id: CTX,
      memory_id: MEM,
      summary: "A summary of ten",
    });
  });

  it("sends each under its server name when set", async () => {
    const args = await updateArgs({
      memoryId: MEM,
      addTags: ["status:done"],
      removeTags: ["status:open"],
      detailsPatch: { status: "done", assignee: null },
      expectedVersion: 3,
      observedAt: "2026-11-01",
      verbose: true,
    });
    expect(args).toEqual({
      context_id: CTX,
      memory_id: MEM,
      add_tags: ["status:done"],
      remove_tags: ["status:open"],
      details_patch: { status: "done", assignee: null },
      expected_version: 3,
      observed_at: "2026-11-01",
      verbose: true,
    });
  });

  it("sends the accept alone, and with expectedVersion", async () => {
    expect(await updateArgs({ memoryId: MEM, acceptSupersedeCandidate: true })).toEqual({
      context_id: CTX,
      memory_id: MEM,
      accept_supersede_candidate: true,
    });
    expect(await updateArgs({ memoryId: MEM, acceptSupersedeCandidate: true, expectedVersion: 2 })).toMatchObject({
      accept_supersede_candidate: true,
      expected_version: 2,
    });
    expect(await updateArgs({ memoryId: MEM, summary: "A summary of ten", acceptSupersedeCandidate: false })).not.toHaveProperty(
      "accept_supersede_candidate",
    );
  });

  it("sends empty partial edits, which the server reads as no change", async () => {
    expect(await updateArgs({ memoryId: MEM, addTags: [], removeTags: [], detailsPatch: {} })).toMatchObject({
      add_tags: [],
      remove_tags: [],
      details_patch: {},
    });
  });

  it("does not cap removeTags, so a stored tag past today's limit can still go", async () => {
    const long = "x".repeat(101);
    const many = Array.from({ length: 60 }, (_, i) => `t${i}`);
    expect((await updateArgs({ memoryId: MEM, removeTags: [long, ...many] })).remove_tags).toEqual([long, ...many]);
  });

  it("merges toolTrigger into detailsPatch when there is one, else into details", async () => {
    const patch = { status: "done" };
    const withPatch = await updateArgs({ memoryId: MEM, detailsPatch: patch, toolTrigger: { tool: "Bash" } });
    expect(withPatch.details_patch).toEqual({ status: "done", tool_trigger: { tool: "Bash" } });
    expect(withPatch).not.toHaveProperty("details");
    expect(patch).toEqual({ status: "done" });
    const alone = await updateArgs({ memoryId: MEM, toolTrigger: { tool: "Bash" } });
    expect(alone.details).toEqual({ tool_trigger: { tool: "Bash" } });
    expect(alone).not.toHaveProperty("details_patch");
  });

  it("sends a Date observedAt in the stored form", async () => {
    const args = await updateArgs({ memoryId: MEM, observedAt: new Date(Date.UTC(2026, 10, 1, 9, 30, 0, 999)) });
    expect(args.observed_at).toBe("2026-11-01T09:30:00Z");
  });

  it("sends observedAt beside a detailsPatch observed_at that agrees", async () => {
    const args = await updateArgs({ memoryId: MEM, observedAt: "2026-11-01", detailsPatch: { observed_at: "2026-11-01" } });
    expect(args).toMatchObject({ details_patch: { observed_at: "2026-11-01" }, observed_at: "2026-11-01" });
  });

  it("returns the reply's version and superseded_memory_id as sent", async () => {
    const server = new FakeServer();
    const reply = { status: "success", memory_id: MEM, operation: "updated", version: 3, superseded_memory_id: "m-0" };
    server.toolResults.update_memory = reply;
    const result = await makeClient(server).updateMemory({ contextId: CTX, memoryId: MEM, acceptSupersedeCandidate: true });
    expect(result).toEqual(reply);
    expect(result.superseded_memory_id).toBe("m-0");
  });
});

describe("updateMemory refuses before any request what the server would refuse", () => {
  const UPSERT = { externalId: "ext-1", summary: "A summary of ten", content: "c", type: "note" };

  it.each([
    [{ ...UPSERT, acceptSupersedeCandidate: true }, "acceptSupersedeCandidate requires memoryId (in-place mode); an externalId upsert replaces the memory and its suggestion."],
    [{ ...UPSERT, dismissSupersedeCandidate: true, acceptSupersedeCandidate: true }, "dismissSupersedeCandidate requires memoryId"],
    [{ ...UPSERT, expectedVersion: 2 }, "expectedVersion requires memoryId (in-place mode); an externalId upsert replaces the memory under a new id."],
    [{ ...UPSERT, addTags: ["a"] }, "addTags require memoryId (in-place mode); use tags / details with externalId."],
    [{ ...UPSERT, removeTags: ["a"] }, "removeTags require memoryId (in-place mode)"],
    [{ ...UPSERT, detailsPatch: { a: 1 } }, "detailsPatch require memoryId (in-place mode)"],
    [{ ...UPSERT, addTags: ["a"], removeTags: ["b"], detailsPatch: {} }, "addTags, removeTags, detailsPatch require memoryId"],
    // Presence, not truthiness: "" is still sent as external_id.
    [{ memoryId: MEM, externalId: "", detailsPatch: { a: 1 } }, "detailsPatch require memoryId"],
    [{ memoryId: MEM, externalId: "", acceptSupersedeCandidate: true }, "acceptSupersedeCandidate requires memoryId"],
    [{ memoryId: MEM, acceptSupersedeCandidate: true, dismissSupersedeCandidate: true }, "acceptSupersedeCandidate and dismissSupersedeCandidate cannot both be true: accept the suggestion or reject it."],
    [{ memoryId: MEM, tags: ["a"], addTags: ["b"] }, "tags replaces the stored list and addTags / removeTags edit it; give one or the other."],
    [{ memoryId: MEM, tags: [], removeTags: ["b"] }, "tags replaces the stored list and addTags / removeTags edit it"],
    [{ memoryId: MEM, details: {}, detailsPatch: { a: 1 } }, "details replaces the stored details and detailsPatch merges into them; give one or the other."],
    [{ memoryId: MEM, expectedVersion: 0 }, "expectedVersion must be an integer of at least 1, got 0"],
    [{ memoryId: MEM, expectedVersion: 1.5 }, "expectedVersion must be an integer of at least 1, got 1.5"],
    [{ memoryId: MEM, expectedVersion: true as unknown as number }, "expectedVersion must be an integer of at least 1, got True"],
    [{ memoryId: MEM, expectedVersion: "3" as unknown as number }, "expectedVersion must be an integer of at least 1, got '3'"],
    [{ memoryId: MEM, addTags: Array.from({ length: 51 }, (_, i) => `t${i}`) }, "addTags accepts at most 50 tags, got 51"],
    [{ memoryId: MEM, addTags: ["x".repeat(101)] }, "each tag must be at most 100 characters, got 101"],
    [{ memoryId: MEM, detailsPatch: { tool_trigger: null }, toolTrigger: { tool: "Bash" } }, "Pass the guardrail either as toolTrigger or as detailsPatch['tool_trigger'], not both"],
    [{ memoryId: MEM, details: { tool_trigger: { tool: "x" } }, toolTrigger: { tool: "Bash" } }, "Pass the guardrail either as toolTrigger or as details['tool_trigger'], not both"],
    [{ memoryId: MEM, observedAt: "2026-11-01 09:30" }, `${HINT}, got '2026-11-01 09:30'`],
    [{ memoryId: MEM, observedAt: "2026-11-01", details: { observed_at: "2026-10-01" } }, "details['observed_at'] and observedAt disagree"],
    // A patch's null is a key delete, so it disagrees too.
    [{ memoryId: MEM, observedAt: "2026-11-01", detailsPatch: { observed_at: null } }, "detailsPatch['observed_at'] and observedAt disagree; give one of them (the server answers validation_error)"],
  ] as Array<[Omit<UpdateMemoryOptions, "contextId">, string]>)("%j", async (options, message) => {
    await expectLocalRefusal((c) => c.updateMemory({ contextId: CTX, ...options }), message);
  });

  it.each([
    ["summary", { summary: "A summary of ten" }],
    ["content", { content: "c" }],
    ["type", { type: "note" }],
    ["importance", { importance: 0.5 }],
    ["tags", { tags: [] }],
    ["contextSummary", { contextSummary: "" }],
    ["deliveryMode", { deliveryMode: "always" }],
    ["details", { details: {} }],
    ["details", { toolTrigger: { tool: "Bash" } }],
    ["detailsPatch", { detailsPatch: {} }],
    ["addTags", { addTags: [] }],
    ["removeTags", { removeTags: [] }],
    ["observedAt", { observedAt: "2026-11-01" }],
  ] as Array<[string, Partial<UpdateMemoryOptions>]>)("refuses the accept beside %s", async (name, edit) => {
    await expectLocalRefusal(
      (c) => c.updateMemory({ contextId: CTX, memoryId: MEM, acceptSupersedeCandidate: true, ...edit }),
      `acceptSupersedeCandidate cannot be combined with field edits (${name}); send the edit in a separate updateMemory call.`,
    );
  });

  it("lists every field edit beside the accept, in the server's order", async () => {
    await expectLocalRefusal(
      (c) =>
        c.updateMemory({ contextId: CTX, memoryId: MEM, acceptSupersedeCandidate: true, observedAt: "2026-11-01", summary: "A summary of ten" }),
      "(summary, observedAt)",
    );
  });

  it("words the same checks by wire name for the CLI", () => {
    expect(() =>
      checkUpdateMemoryOptions({ contextId: CTX, memoryId: MEM, acceptSupersedeCandidate: true, summary: "s", observedAt: "2026-11-01" }, "wire"),
    ).toThrow(
      "accept_supersede_candidate cannot be combined with field edits (summary, observed_at); send the edit in a separate update_memory call.",
    );
    expect(() => checkUpdateMemoryOptions({ contextId: CTX, memoryId: MEM, addTags: Array(51).fill("t") }, "wire")).toThrow(
      "add_tags accepts at most 50 tags, got 51",
    );
    // The Python SDK 0.44.0's words, whole.
    expect(() =>
      checkUpdateMemoryOptions({ contextId: CTX, externalId: "ext-1", acceptSupersedeCandidate: true }, "wire"),
    ).toThrow(
      /^accept_supersede_candidate requires memory_id \(in-place mode\); an external_id upsert replaces the memory and its suggestion\.$/,
    );
  });
});

// ============================================================================
// KaguraVersionConflictError: MCP version_conflict and REST 409 RES-002
// ============================================================================

const MCP_CONFLICT = {
  status: "error",
  error: "version_conflict",
  message: `Memory ${MEM} is at version 5, not the expected version 3. Read it again and resend with its current version.`,
  memory_id: MEM,
  expected_version: 3,
  current_version: 5,
  retryable: false,
  help: "reference() the memory and resend with its current version, or omit expected_version to overwrite.",
};

/** Exposes the protected request spine, as restBase.test.ts does. */
class ProbeClient extends KaguraRestClient {
  requestPublic(method: HttpMethod, p: string, opts?: { json?: Record<string, unknown> }): Promise<RestResponse> {
    return this.request(method, p, opts);
  }
}

async function restError(status: number, body: unknown): Promise<unknown> {
  const rest = new FakeRest();
  rest.status = status;
  rest.body = JSON.stringify(body);
  const client = new ProbeClient({ apiKey: "kagura_test", baseUrl: "https://api.test", fetch: rest.fetch });
  return client.requestPublic("PATCH", `/api/v1/memory/${MEM}`, { json: { expected_version: 3 } }).catch((e: unknown) => e);
}

describe("KaguraVersionConflictError", () => {
  it("is exported from the package entry point", () => {
    expect(sdk.KaguraVersionConflictError).toBe(KaguraVersionConflictError);
  });

  it("types an MCP version_conflict, keeping the envelope", async () => {
    const server = new FakeServer();
    server.toolResults.update_memory = MCP_CONFLICT;
    const err = await makeClient(server)
      .updateMemory({ contextId: CTX, memoryId: MEM, summary: "A summary of ten", expectedVersion: 3 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraVersionConflictError);
    expect(err).toBeInstanceOf(KaguraError);
    const conflict = err as KaguraVersionConflictError;
    expect(conflict.code).toBe("version_conflict");
    expect(conflict.currentVersion).toBe(5);
    expect(conflict.expectedVersion).toBe(3);
    expect(conflict.memoryId).toBe(MEM);
    expect(conflict.retryable).toBe(false);
    expect(conflict.help).toContain("reference()");
    expect(conflict.message).toBe(`update_memory failed (version_conflict): ${MCP_CONFLICT.message}`);
  });

  it("types a REST 409 RES-002 whose reason is version_conflict", async () => {
    const err = await restError(409, {
      error: "RES-002",
      message: `Memory ${MEM} is at version 5, not the expected version 3.`,
      details: { reason: "version_conflict", expected_version: 3, current_version: 5 },
    });
    expect(err).toBeInstanceOf(KaguraVersionConflictError);
    const conflict = err as KaguraVersionConflictError;
    expect(conflict.code).toBe("RES-002");
    expect(conflict.details.reason).toBe("version_conflict");
    expect(conflict.currentVersion).toBe(5);
    expect(conflict.expectedVersion).toBe(3);
    expect(conflict.memoryId).toBeNull();
    expect(conflict.message).toBe(`Memory ${MEM} is at version 5, not the expected version 3.`);
  });

  it.each([
    ["the files dedup 409", { error: "RES-002", message: "A file with this sha256 exists.", details: {} }],
    ["an accept's edge_exists", { error: "RES-002", message: "edge", details: { reason: "edge_exists" } }],
    ["a FastAPI detail", { detail: "conflict" }],
  ])("leaves %s a plain connection error", async (_, body) => {
    const err = await restError(409, body);
    expect(err).toBeInstanceOf(KaguraConnectionError);
    expect(err).not.toBeInstanceOf(KaguraVersionConflictError);
  });

  it("reads null from details of the wrong type", () => {
    const err = new KaguraVersionConflictError("conflict", {
      details: { current_version: true, expected_version: "3", memory_id: 7 },
    });
    expect(err.currentVersion).toBeNull();
    expect(err.expectedVersion).toBeNull();
    expect(err.memoryId).toBeNull();
    expect(new KaguraVersionConflictError("conflict", { details: { current_version: 2.5 } }).currentVersion).toBeNull();
  });

  it("keeps an accept's edge_exists a plain KaguraError with the existing edge", async () => {
    const server = new FakeServer();
    const edge = { edge_id: "e-1", edge_type: "declared_link", source_id: MEM, target_id: "m-0" };
    server.toolResults.update_memory = { status: "error", error: "edge_exists", message: "nothing written", existing_edge: edge };
    const err = await makeClient(server)
      .updateMemory({ contextId: CTX, memoryId: MEM, acceptSupersedeCandidate: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraError);
    expect(err).not.toBeInstanceOf(KaguraVersionConflictError);
    expect((err as KaguraError).code).toBe("edge_exists");
    expect((err as KaguraError).details.existing_edge).toEqual(edge);
  });
});

// ============================================================================
// reference
// ============================================================================

async function referenceArgs(options: Omit<ReferenceOptions, "contextId" | "memoryId">) {
  const server = new FakeServer();
  server.toolResults.reference = { status: "success", memory: { memory_id: MEM, version: 5 } };
  const result = await makeClient(server).reference({ contextId: CTX, memoryId: MEM, ...options });
  return { args: server.toolCallArgs(0), result };
}

describe("reference: version, the offsets, fields and maxChars", () => {
  it("sends none of them by default", async () => {
    const { args, result } = await referenceArgs({});
    expect(args).toEqual({ context_id: CTX, memory_id: MEM });
    expect(result.memory.version).toBe(5);
  });

  it("sends each under its server name when set", async () => {
    expect((await referenceArgs({ version: 2 })).args).toEqual({ context_id: CTX, memory_id: MEM, version: 2 });
    expect((await referenceArgs({ contentOffset: 0 })).args).toMatchObject({ content_offset: 0 });
    expect((await referenceArgs({ detailsOffset: 14 })).args).toMatchObject({ details_offset: 14 });
    expect((await referenceArgs({ contextOffset: 3 })).args).toMatchObject({ context_offset: 3 });
    expect((await referenceArgs({ fields: ["content", "links"] })).args).toMatchObject({ fields: ["content", "links"] });
    expect((await referenceArgs({ fields: [] })).args).toMatchObject({ fields: [] });
    expect((await referenceArgs({ maxChars: 100_000 })).args).toMatchObject({ max_chars: 100_000 });
    expect((await referenceArgs({ contentOffset: 20_000, fields: ["content"], maxChars: 40_000, version: 3 })).args).toEqual({
      context_id: CTX,
      memory_id: MEM,
      version: 3,
      content_offset: 20_000,
      fields: ["content"],
      max_chars: 40_000,
    });
  });

  it.each([
    [{ version: 0 }, "version must be an integer of at least 1, got 0"],
    [{ version: true as unknown as number }, "version must be an integer of at least 1, got True"],
    [{ contentOffset: -1 }, "contentOffset must be an integer of at least 0, got -1"],
    [{ detailsOffset: 1.5 }, "detailsOffset must be an integer of at least 0, got 1.5"],
    [{ contextOffset: "0" as unknown as number }, "contextOffset must be an integer of at least 0, got '0'"],
    [{ contentOffset: 0, detailsOffset: 0 }, "Pass only one of contentOffset, detailsOffset, contextOffset per call, got contentOffset, detailsOffset"],
    // The count before either offset's range.
    [{ contentOffset: -1, contextOffset: 1.5 }, "Pass only one of contentOffset, detailsOffset, contextOffset per call, got contentOffset, contextOffset"],
    [{ fields: ["content", "summary"] as unknown as ReferenceOptions["fields"] }, "fields must be a list of: content, details, context, links, got ['content', 'summary']"],
    [{ fields: "content" as unknown as ReferenceOptions["fields"] }, "fields must be a list of: content, details, context, links, got 'content'"],
    [{ detailsOffset: 0, fields: ["content"] }, "detailsOffset needs 'details' in fields"],
    [{ maxChars: 9_999 }, "maxChars must be an integer between 10000 and 100000, got 9999"],
  ] as Array<[Omit<ReferenceOptions, "contextId" | "memoryId">, string]>)("refuses %j before any request", async (options, message) => {
    await expectLocalRefusal((c) => c.reference({ contextId: CTX, memoryId: MEM, ...options }), message);
  });

  it("returns a bounded reply's paging keys as sent", async () => {
    const server = new FakeServer();
    const memory = {
      memory_id: MEM,
      content: "abc",
      content_truncated: true,
      content_next_offset: 3,
      details_omitted: true,
      details_total_chars: 24_000,
      details_next_offset: 0,
    };
    server.toolResults.reference = { status: "success", memory };
    const result = await makeClient(server).reference({ contextId: CTX, memoryId: MEM });
    expect(result.memory).toEqual(memory);
    expect(result.memory.content_next_offset).toBe(3);
  });
});

// ============================================================================
// The typed replies: status (and reference's memory) checked, the rest as sent
// ============================================================================

describe("the replies remember, updateMemory and reference type", () => {
  const UPGRADE = "The server may be newer than this SDK; upgrading kagura-memory may help.";

  it.each([
    [{ status: "success" }, "memory: Field required"],
    [{ status: "success", memory: "mem-1" }, "memory: Input should be a valid dictionary or instance of ReferenceMemory"],
    [{ status: 1, memory: {} }, "status: Input should be a valid string"],
    [{ memory: null }, "status: Field required; memory: Input should be a valid dictionary or instance of ReferenceMemory"],
    [{}, "status: Field required; memory: Field required"],
  ])("reference refuses %j, naming the tool", async (reply, problems) => {
    const server = new FakeServer();
    server.toolTexts.reference = JSON.stringify(reply);
    const err = await makeClient(server)
      .reference({ contextId: CTX, memoryId: MEM })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as KaguraResponseError).operation).toBe("reference");
    expect((err as Error).message).toBe(
      `reference: unexpected server response for ReferenceResponse (${problems}). ${UPGRADE}`,
    );
  });

  it("returns a reference reply that passes as sent, keys the types do not name included", async () => {
    const server = new FakeServer();
    const reply = { status: "success", memory: { details: null, plan_headroom: [] }, extra: { a: 1 } };
    server.toolResults.reference = reply;
    expect(await makeClient(server).reference({ contextId: CTX, memoryId: MEM })).toEqual(reply);
  });

  it("returns the write replies unchecked, as Python returns its dict", async () => {
    // RememberResult / UpdateMemoryResult type every key optional for this.
    const server = new FakeServer();
    server.toolTexts.remember = '{"memory_id": "m-1"}';
    server.toolTexts.update_memory = "{}";
    const client = makeClient(server);
    expect(await client.remember(BASE)).toEqual({ memory_id: "m-1" });
    expect(await client.updateMemory({ contextId: CTX, memoryId: MEM, summary: "A summary of ten" })).toEqual({});
  });

  it("the CLI's reference prints the raw reply, as the Python CLI prints its dict", async () => {
    const server = new FakeServer();
    server.toolTexts.reference = '{"status": "success"}';
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["reference", "-m", MEM], {
      write: (line: string) => void out.push(line),
      writeError: (line: string) => void err.push(line),
      loadConfig: () => ({ context_id: CTX, api_key: "k" }),
      makeClient: (options: Record<string, unknown>) => makeClient(server, options),
    } as unknown as CliDeps);
    expect({ code, out, err }).toEqual({ code: 0, out: ['{\n  "status": "success"\n}'], err: [] });
  });
});

// ============================================================================
// updateSearchConfig and recall
// ============================================================================

describe("updateSearchConfig: contentChunksEnabled and llmSelectorEnabled", () => {
  it("sends each when set, false included, and neither by default", async () => {
    const server = new FakeServer();
    server.toolResults.update_search_config = { status: "success", config: {} };
    const client = makeClient(server);
    await client.updateSearchConfig({ contextId: CTX, contentChunksEnabled: true, llmSelectorEnabled: false });
    await client.updateSearchConfig({ contextId: CTX, llmSelectorEnabled: true });
    await client.updateSearchConfig({ contextId: CTX, fetchFactor: 3 });
    expect(server.toolCallArgs(0)).toEqual({ context_id: CTX, content_chunks_enabled: true, llm_selector_enabled: false });
    expect(server.toolCallArgs(1)).toEqual({ context_id: CTX, llm_selector_enabled: true });
    expect(server.toolCallArgs(2)).toEqual({ context_id: CTX, fetch_factor: 3 });
  });
});

describe("recall: observedAfter and observedBefore", () => {
  it("sends them as the filter keys, beside the other filters, without changing the caller's", async () => {
    const server = new FakeServer();
    server.toolResults.recall = { status: "success", results: [], count: 0 };
    const client = makeClient(server);
    const filters = { type: "decision" };
    await client.recall({ contextId: CTX, query: "q", filters, observedAfter: "2024-01-01", observedBefore: "2024-02-01T00:00:00Z" });
    await client.recall({ contextId: CTX, query: "q", observedBefore: "2024-02-01" });
    await client.recall({ contextId: CTX, query: "q" });
    expect(server.toolCallArgs(0).filters).toEqual({
      type: "decision",
      observed_after: "2024-01-01",
      observed_before: "2024-02-01T00:00:00Z",
    });
    expect(filters).toEqual({ type: "decision" });
    expect(server.toolCallArgs(1).filters).toEqual({ observed_before: "2024-02-01" });
    expect(server.toolCallArgs(2)).not.toHaveProperty("filters");
  });

  it("refuses one beside the same key in filters, before any request", async () => {
    await expectLocalRefusal(
      (c) => c.recall({ contextId: CTX, query: "q", filters: { observed_after: "2024-01-01" }, observedAfter: "2024-01-01" }),
      "observedAfter and filters.observed_after are the same filter; give one of them",
    );
    await expectLocalRefusal(
      (c) => c.recall({ contextId: CTX, query: "q", filters: { observed_before: null }, observedBefore: "2024-01-01" }),
      "observedBefore and filters.observed_before are the same filter",
    );
  });
});

// ============================================================================
// Against a strict server: every name declared, nothing new sent unset
// ============================================================================

/**
 * The inputSchema properties memory-cloud v0.143.0 declares for these tools
 * (`backend/src/mcp_server/tools/_definitions.py`). A strict fake refuses
 * anything else with `invalid_argument`, as v0.82.0+ servers do.
 */
const DECLARED_V0143: Record<string, readonly string[]> = {
  remember: [
    "content", "context", "context_id", "context_summary", "dedupe", "delivery_mode", "details", "importance",
    "linked_memory_ids", "linked_source_uris", "observed_at", "source_type", "source_uri", "summary", "supersedes",
    "tags", "tags_normalize", "type", "verbose",
  ],
  update_memory: [
    "accept_supersede_candidate", "add_tags", "content", "context", "context_id", "context_summary", "delivery_mode",
    "details", "details_patch", "dismiss_supersede_candidate", "expected_version", "external_id", "importance",
    "memory_id", "observed_at", "remove_tags", "summary", "tags", "type", "verbose",
  ],
  reference: ["content_offset", "context_id", "context_offset", "details_offset", "fields", "max_chars", "memory_id", "version"],
  update_search_config: [
    "bm25_weight", "content_chunks_enabled", "context_id", "fetch_factor", "llm_selector_enabled", "reinforce_enabled",
    "reinforce_max_boost", "reinforce_require_host_arbitration", "reranker_model", "reranker_provider", "routing_mode",
    "semantic_weight", "use_rerank",
  ],
  recall: [
    "context_id", "context_ids", "filters", "full", "include_explore_hints", "include_superseded", "k", "max_chars",
    "query", "search_mode", "use_rerank", "verbosity",
  ],
};

/** The arguments #87 adds, per tool: what a server before their release does not declare. */
const ADDED_BY_87: Record<string, readonly string[]> = {
  remember: ["observed_at", "dedupe", "tags_normalize", "verbose"],
  update_memory: [
    "observed_at", "add_tags", "remove_tags", "details_patch", "expected_version", "accept_supersede_candidate", "verbose",
  ],
  reference: ["version", "content_offset", "details_offset", "context_offset", "fields", "max_chars"],
  update_search_config: ["content_chunks_enabled", "llm_selector_enabled"],
  recall: [],
};

function strictServer(declared: Record<string, readonly string[]>): FakeServer {
  const server = new FakeServer();
  server.declaredArguments = declared;
  server.toolResults.reference = { status: "success", memory: { memory_id: MEM } };
  server.toolResults.update_search_config = { status: "success", config: {} };
  server.toolResults.recall = { status: "success", results: [], count: 0 };
  return server;
}

describe("against a strict server", () => {
  it("a v0.143.0 fake accepts every new argument, so each wire name is one it declares", async () => {
    const server = strictServer(DECLARED_V0143);
    const client = makeClient(server);
    await client.remember({
      ...BASE,
      observedAt: "2026-11-01",
      dedupe: "check",
      tagsNormalize: true,
      verbose: true,
      toolTrigger: { tool: "Bash" },
    });
    await client.updateMemory({
      contextId: CTX,
      memoryId: MEM,
      observedAt: new Date(Date.UTC(2026, 10, 1)),
      addTags: ["a"],
      removeTags: ["b"],
      detailsPatch: { status: "done" },
      expectedVersion: 2,
      verbose: true,
      toolTrigger: { tool: "Bash" },
    });
    await client.updateMemory({ contextId: CTX, memoryId: MEM, acceptSupersedeCandidate: true, expectedVersion: 3 });
    await client.reference({ contextId: CTX, memoryId: MEM, version: 1 });
    await client.reference({ contextId: CTX, memoryId: MEM, detailsOffset: 0, fields: ["details"], maxChars: 40_000 });
    await client.reference({ contextId: CTX, memoryId: MEM, contentOffset: 5 });
    await client.reference({ contextId: CTX, memoryId: MEM, contextOffset: 0 });
    await client.updateSearchConfig({ contextId: CTX, contentChunksEnabled: false, llmSelectorEnabled: true });
    await client.recall({ contextId: CTX, query: "q", observedAfter: "2024-01-01", observedBefore: "2025-01-01" });
    const sent = server.requests
      .filter((r) => r.body?.method === "tools/call")
      .flatMap((r) => Object.keys((r.body!.params as { arguments: Record<string, unknown> }).arguments));
    // Every argument #87 adds went out at least once, and was accepted.
    for (const name of Object.values(ADDED_BY_87).flat()) expect(sent).toContain(name);
  });

  it("a server that predates every #87 argument still takes each call that sets none of them", async () => {
    const older = Object.fromEntries(
      Object.entries(DECLARED_V0143).map(([tool, names]) => [tool, names.filter((n) => !ADDED_BY_87[tool]!.includes(n))]),
    );
    const server = strictServer(older);
    const client = makeClient(server);
    await client.remember({ ...BASE, tags: ["a"], details: { a: 1 } });
    await client.updateMemory({ contextId: CTX, memoryId: MEM, summary: "A summary of ten", details: { a: 1 } });
    await client.updateMemory({ contextId: CTX, memoryId: MEM, dismissSupersedeCandidate: true });
    await client.reference({ contextId: CTX, memoryId: MEM });
    await client.updateSearchConfig({ contextId: CTX, useRerank: true });
    await client.recall({ contextId: CTX, query: "q", filters: { type: "note" } });
    // And one that sets a new argument is refused there, naming it.
    await expect(client.updateMemory({ contextId: CTX, memoryId: MEM, detailsPatch: { a: 1 } })).rejects.toThrow(
      "update_memory does not accept the argument 'details_patch'",
    );
  });
});
