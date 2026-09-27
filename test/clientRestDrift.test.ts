/**
 * A 2xx body the Python SDK's model refuses, from KaguraClient's
 * REST-backed methods (python-sdk #277): a KaguraResponseError whose
 * operation is `KaguraClient.<method>` and whose message names the failing
 * fields, never their values. Each message is kagura-memory 0.42.0's
 * `parse_response` for the same body, recorded with pydantic 2.13.4
 * (pydantic-core 2.46.4).
 */

import { describe, expect, it, vi } from "vitest";

import type { KaguraClient } from "../src/client.js";
import { KaguraConnectionError, KaguraResponseError } from "../src/errors.js";
import { FakeServer, makeClient } from "./fakeServer.js";

const HINT = "The server may be newer than this SDK; upgrading kagura-memory may help.";

const METHODS: Record<string, { path: string; call: (c: KaguraClient) => Promise<unknown> }> = {
  get_server_info: { path: "/api/v1/system/info", call: (c) => c.getServerInfo() },
  get_embedding_status: { path: "/api/v1/workspace/embedding-status", call: (c) => c.getEmbeddingStatus() },
  get_memory_stats: { path: "/api/v1/contexts/ctx/memory-stats", call: (c) => c.getMemoryStats({ contextId: "ctx" }) },
  find_duplicates: { path: "/api/v1/contexts/ctx/duplicates", call: (c) => c.findDuplicates({ contextId: "ctx" }) },
  list_embedding_models: { path: "/api/v1/system/embedding/models", call: (c) => c.listEmbeddingModels() },
};

const MODEL: Record<string, string> = {
  get_server_info: "ServerInfo",
  get_embedding_status: "EmbeddingStatus",
  get_memory_stats: "MemoryStatsResponse",
  find_duplicates: "DuplicatesResponse",
  list_embedding_models: "EmbeddingModelsResponse",
};

const STAT = {
  id: "m",
  summary: "s",
  type: "note",
  importance: 0.5,
  scope: "context",
  access_count: 3,
  reference_count: 1,
  embedding_status: "done",
  created_at: "2026-06-01T00:00:00Z",
};

const DRIFT: Array<[method: string, body: unknown, problems: string, values: string[]]> = [
  [
    "get_embedding_status",
    { total: 1, by_status: { pending: "x", done: 2 }, failed_memories: [{ id: "m", created_at: "nope" }] },
    "by_status.pending: Input should be a valid integer, unable to parse string as an integer; " +
      "failed_memories.0.summary: Field required; " +
      "failed_memories.0.created_at: Input should be a valid datetime or date, input is too short",
    ['"x"', "nope"],
  ],
  [
    "get_embedding_status",
    { by_status: [], failed_memories: {} },
    "total: Field required; by_status: Input should be a valid dictionary; failed_memories: Input should be a valid list",
    [],
  ],
  [
    "get_memory_stats",
    {
      memories: [{ ...STAT, importance: "high", use_count: 0, access_count: 3.5, reference_count: undefined }],
      total: 1,
      sort_by: "access_count",
    },
    "memories.0.importance: Input should be a valid number, unable to parse string as a number; " +
      "memories.0.access_count: Input should be a valid integer, got a number with a fractional part; " +
      "sort_order: Field required",
    ["high", "3.5"],
  ],
  [
    "find_duplicates",
    {
      pairs: [
        {
          memory_a: { id: "a", summary: "s", type: "note", created_at: "2026-06-01T00:00:00Z" },
          memory_b: { id: 5, summary: "s", type: "note" },
          similarity: "0.95x",
        },
      ],
      total_pairs: 1,
      threshold: 0.9,
      memories_scanned: 10,
    },
    "pairs.0.memory_b.id: Input should be a valid string; pairs.0.memory_b.created_at: Field required; " +
      "pairs.0.similarity: Input should be a valid number, unable to parse string as a number",
    ["0.95x"],
  ],
  [
    "find_duplicates",
    { pairs: null, total_pairs: 0, threshold: 0.9 },
    "pairs: Input should be a valid list; memories_scanned: Field required",
    [],
  ],
  [
    "list_embedding_models",
    { models: [{ name: "m", dimensions: 1536.5, provider: "openai", available: "sometimes" }], default_model: null },
    "models.0.dimensions: Input should be a valid integer, got a number with a fractional part; " +
      "models.0.available: Input should be a valid boolean, unable to interpret input; " +
      "default_model: Input should be a valid string",
    ["1536.5", "sometimes"],
  ],
  [
    "list_embedding_models",
    [1],
    "Input should be a valid dictionary or instance of EmbeddingModelsResponse",
    [],
  ],
  [
    "get_server_info",
    { name: "kagura", version: 1, features: { reranking: "maybe" } },
    "version: Input should be a valid string; features.reranking: Input should be a valid boolean, unable to interpret input",
    ["maybe"],
  ],
  [
    "get_server_info",
    { name: "kagura", version: "0.77.0", search_defaults: [1], terms_version: 2 },
    "search_defaults: Input should be a valid dictionary; terms_version: Input should be a valid string",
    [],
  ],
];

async function call(method: string, body: unknown): Promise<unknown> {
  const server = new FakeServer();
  server.restResults[METHODS[method]!.path] = body;
  return METHODS[method]!.call(makeClient(server));
}

describe("KaguraClient REST drift (python-sdk #277)", () => {
  it.each(DRIFT)("%s refuses %j in Python's words", async (method, body, problems, values) => {
    const error = await call(method, body).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(KaguraResponseError);
    const e = error as KaguraResponseError;
    expect(e.operation).toBe(`KaguraClient.${method}`);
    expect(e.message).toBe(
      `KaguraClient.${method}: unexpected server response for ${MODEL[method]} (${problems}). ${HINT}`,
    );
    for (const value of values) expect(e.message).not.toContain(value);
  });

  it("reports checkServerVersion's drift as get_server_info's, without the advisory", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const server = new FakeServer();
      server.restResults["/api/v1/system/info"] = { name: "mc", version: 75 };
      const error = await makeClient(server).checkServerVersion().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(KaguraResponseError);
      expect((error as KaguraResponseError).operation).toBe("KaguraClient.get_server_info");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("returns an accepted body as the server sent it: checked, not converted", async () => {
    // Python's model accepts it too; it would drop `extra` and read total as 3.
    const body = { total: "3", by_status: { done: 3 }, failed_memories: [], extra: 1 };
    await expect(call("get_embedding_status", body)).resolves.toEqual(body);
    const stats = { memories: [], total: 0, sort_by: "access_count", sort_order: "desc" };
    await expect(call("get_memory_stats", stats)).resolves.toEqual(stats);
  });

  it("accepts a memory-stats row without use_count, which memory-cloud v0.34.0+ never sends", async () => {
    // A deliberate difference (README): Python 0.42.0's MemoryStatItem still
    // requires it and refuses the page with "memories.0.use_count: Field required".
    const body = { memories: [STAT], total: 1, sort_by: "access_count", sort_order: "desc" };
    await expect(call("get_memory_stats", body)).resolves.toEqual(body);
  });

  it.each(Object.keys(METHODS))("%s keeps KaguraConnectionError for a non-JSON 2xx body and a 503", async (method) => {
    const server = new FakeServer();
    server.forcedResponse = new Response("not json", { status: 200 });
    await expect(METHODS[method]!.call(makeClient(server))).rejects.toThrow(/^Invalid response format: /);
    server.forcedResponse = new Response("oops", { status: 503 });
    const error = await METHODS[method]!.call(makeClient(server)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraConnectionError);
    expect(error).not.toBeInstanceOf(KaguraResponseError);
  });
});
