/**
 * `recall({ order })` — date order (memory-cloud v0.182.0, #3004).
 *
 * `order: "date"` runs the same search and returns the rows oldest first,
 * each with `date` / `date_source`, plus `order: "date"` on the envelope.
 * The option is sent only when set, so a default call is the request it was
 * before and an older server never sees it.
 */

import { describe, expect, it } from "vitest";

import type { RecallDateSource, RecallOrder, RecallResponse } from "../src/index.js";
import { FakeServer, makeClient } from "./fakeServer.js";

const CTX = "11111111-2222-4333-8444-555555555555";
const MEM_OLD = "aaaaaaaa-0000-4000-8000-000000000001";
const MEM_NEW = "aaaaaaaa-0000-4000-8000-000000000002";

/** Shaped like memory-cloud v0.182.0's date-ordered recall envelope. */
const DATE_REPLY = {
  confidence: { level: "high", top_score: 0.81, result_count: 2, rationale: "" },
  status: "success",
  results: [
    {
      memory_id: MEM_OLD,
      date: "2026-03-02",
      date_source: "observed",
      summary: "The team meets on Tuesdays",
      type: "fact",
      importance: 0.5,
      score: 0.62,
      created_at: "2026-03-05T00:00:00Z",
      observed_at: "2026-03-02",
      superseded_by: MEM_NEW,
    },
    {
      memory_id: MEM_NEW,
      date: "2026-09-14",
      date_source: "created",
      summary: "The team meets on Thursdays from September",
      type: "fact",
      importance: 0.6,
      score: 0.81,
      created_at: "2026-09-14T08:00:00Z",
    },
  ],
  count: 2,
  order: "date",
  context_id: CTX,
  context_name: "dev",
};

const RELEVANCE_REPLY = {
  status: "success",
  results: [{ memory_id: MEM_NEW, summary: "Thursdays", type: "fact", importance: 0.6, score: 0.81 }],
  count: 1,
  context_id: CTX,
};

function wired(reply: unknown = { status: "success", results: [] }) {
  const server = new FakeServer();
  server.toolResults = { recall: reply };
  return { server, client: makeClient(server) };
}

function recallArgs(server: FakeServer): Array<Record<string, unknown>> {
  return server.requests
    .filter((r) => r.body?.method === "tools/call")
    .map((r) => (r.body!.params as { arguments: Record<string, unknown> }).arguments);
}

describe("recall({ order })", () => {
  it("leaves a default call's request unchanged", async () => {
    const { server, client } = wired();
    await client.recall({ contextId: CTX, query: "team meeting day" });
    expect(recallArgs(server)).toEqual([{ query: "team meeting day", k: 5, context_id: CTX }]);
  });

  it.each(["relevance", "date"] as const)("sends order %s when set", async (order) => {
    const { server, client } = wired();
    await client.recall({ contextId: CTX, query: "q", order });
    expect(recallArgs(server)).toEqual([{ query: "q", k: 5, context_id: CTX, order }]);
  });

  it("treats null as unset, as Python treats None", async () => {
    const { server, client } = wired();
    await client.recall({ contextId: CTX, query: "q", order: null as unknown as RecallOrder });
    expect(recallArgs(server)).toEqual([{ query: "q", k: 5, context_id: CTX }]);
  });

  it("sends includeSuperseded: false only together with order", async () => {
    const { server, client } = wired();
    await client.recall({ contextId: CTX, query: "q", includeSuperseded: false });
    await client.recall({ contextId: CTX, query: "q", includeSuperseded: false, order: "date" });
    await client.recall({ contextId: CTX, query: "q", includeSuperseded: true, order: "date" });
    const [plain, excluded, included] = recallArgs(server);
    expect(plain).not.toHaveProperty("include_superseded");
    expect(excluded).toMatchObject({ include_superseded: false, order: "date" });
    expect(included).toMatchObject({ include_superseded: true, order: "date" });
  });

  it.each([["chronological"], ["DATE"], [""]])("refuses order %j before any request", async (order) => {
    const { server, client } = wired();
    await expect(
      client.recall({ contextId: CTX, query: "q", order: order as RecallOrder }),
    ).rejects.toThrow(`order must be 'relevance' or 'date', got '${order}'`);
    expect(recallArgs(server)).toEqual([]);
  });

  it("returns date, date_source and order from a date-ordered reply", async () => {
    const { client } = wired(DATE_REPLY);
    const reply: RecallResponse = await client.recall({ contextId: CTX, query: "team meeting day", order: "date" });
    expect(reply.order).toBe("date");
    expect(reply.results.map((r) => r.date)).toEqual(["2026-03-02", "2026-09-14"]);
    const sources: Array<RecallDateSource | undefined> = reply.results.map((r) => r.date_source);
    expect(sources).toEqual(["observed", "created"]);
    expect(reply.results[0]!.superseded_by).toBe(MEM_NEW);
  });

  it("reads a reply without the date keys (relevance order or an older server)", async () => {
    const { client } = wired(RELEVANCE_REPLY);
    const reply = await client.recall({ contextId: CTX, query: "team meeting day" });
    expect(reply.order).toBeUndefined();
    expect(reply.results[0]!.date).toBeUndefined();
    expect(reply.results[0]!.date_source).toBeUndefined();
  });
});
