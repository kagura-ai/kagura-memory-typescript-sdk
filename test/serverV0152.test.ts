/**
 * memory-cloud v0.152.0 (#137): the event date of a memory
 * (`details.event_start` / `details.event_end`, resolved from
 * `details.event_phrase`). `listMatching` orders by `event_start`, and
 * `recall` takes `eventAfter` / `eventBefore`, merged into `filters` the way
 * `observedAfter` / `observedBefore` are. Wire names and enum values are
 * those of `backend/src/mcp_server/tools/_definitions.py` and
 * `backend/src/utils/event_dates.py` at v0.152.0.
 */

import { describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../src/cli/run.js";
import type { ListOrderBy } from "../src/index.js";
import { FakeServer, makeClient } from "./fakeServer.js";

const CTX = "11111111-2222-4333-8444-555555555555";

function recallServer(): FakeServer {
  const server = new FakeServer();
  server.toolResults.recall = { status: "success", results: [], count: 0 };
  return server;
}

async function refused(call: (client: ReturnType<typeof makeClient>) => Promise<unknown>, message: string): Promise<void> {
  const server = recallServer();
  await expect(call(makeClient(server))).rejects.toThrow(message);
  expect(server.requests).toEqual([]);
}

describe("listMatching: orderBy event_start", () => {
  it("sends order_by event_start and a direction, beside the event filters", async () => {
    const server = new FakeServer();
    server.toolResults.list = { status: "success", memories: [], total: 0, has_more: false };
    const order: ListOrderBy = "event_start";
    await makeClient(server).listMatching({
      contextId: CTX,
      orderBy: order,
      direction: "asc",
      filters: { event_after: "2026-10-01", event_before: "2026-11-01" },
    });
    expect(server.toolCallArgs(0)).toEqual({
      context_id: CTX,
      filters: { event_after: "2026-10-01", event_before: "2026-11-01" },
      order_by: "event_start",
      direction: "asc",
    });
  });
});

describe("recall: eventAfter and eventBefore", () => {
  it("sends them as the filter keys, beside the other filters, without changing the caller's", async () => {
    const server = recallServer();
    const client = makeClient(server);
    const filters = { type: "decision" };
    await client.recall({ contextId: CTX, query: "q", filters, eventAfter: "2026-10-01", eventBefore: "2026-11-01T00:00:00Z" });
    await client.recall({ contextId: CTX, query: "q", eventBefore: "2026-11-01" });
    await client.recall({ contextId: CTX, query: "q", eventAfter: "2026-10-01" });
    expect(server.toolCallArgs(0).filters).toEqual({
      type: "decision",
      event_after: "2026-10-01",
      event_before: "2026-11-01T00:00:00Z",
    });
    expect(filters).toEqual({ type: "decision" });
    expect(server.toolCallArgs(1).filters).toEqual({ event_before: "2026-11-01" });
    expect(server.toolCallArgs(2).filters).toEqual({ event_after: "2026-10-01" });
  });

  it("sends nothing new when unset, so a request that does not use them is unchanged", async () => {
    const server = recallServer();
    const client = makeClient(server);
    await client.recall({ contextId: CTX, query: "q" });
    await client.recall({ contextId: CTX, query: "q", filters: { type: "note" } });
    expect(server.toolCallArgs(0)).not.toHaveProperty("filters");
    expect(server.toolCallArgs(1).filters).toEqual({ type: "note" });
  });

  it("refuses one beside the same key in filters, before any request", async () => {
    await refused(
      (c) => c.recall({ contextId: CTX, query: "q", filters: { event_after: "2026-10-01" }, eventAfter: "2026-10-01" }),
      "eventAfter and filters.event_after are the same filter; give one of them",
    );
    await refused(
      (c) => c.recall({ contextId: CTX, query: "q", filters: { event_before: null }, eventBefore: "2026-10-01" }),
      "eventBefore and filters.event_before are the same filter; give one of them",
    );
  });

  it("keeps the observed pair working beside the event pair", async () => {
    const server = recallServer();
    await makeClient(server).recall({
      contextId: CTX,
      query: "q",
      observedAfter: "2024-01-01",
      observedBefore: "2024-02-01",
      eventAfter: "2024-03-01",
      eventBefore: "2024-04-01",
    });
    expect(server.toolCallArgs(0).filters).toEqual({
      observed_after: "2024-01-01",
      observed_before: "2024-02-01",
      event_after: "2024-03-01",
      event_before: "2024-04-01",
    });
    await refused(
      (c) => c.recall({ contextId: CTX, query: "q", filters: { observed_after: "2024-01-01" }, observedAfter: "2024-01-01" }),
      "observedAfter and filters.observed_after are the same filter; give one of them",
    );
  });
});

describe("CLI list --order-by event_start", () => {
  function harness() {
    const out: string[] = [];
    const err: string[] = [];
    const server = new FakeServer();
    server.toolResults.list = { status: "success", memories: [], total: 0, has_more: false };
    const deps = {
      write: (line: string) => void out.push(line),
      writeError: (line: string) => void err.push(line),
      loadConfig: () => ({ api_key: "k" }),
      makeClient: (o: Record<string, unknown>) => makeClient(server, o),
    } as unknown as CliDeps;
    return { out, err, server, deps };
  }

  it("is a choice and reaches the list tool as order_by", async () => {
    const h = harness();
    expect(await runCli(["list", "-c", CTX, "--order-by", "event_start", "--direction", "asc"], h.deps)).toBe(0);
    expect(h.server.toolCallArgs(0)).toEqual({ context_id: CTX, order_by: "event_start", direction: "asc" });
  });

  it("names event_start among the choices of a refused value and in the help", async () => {
    const h = harness();
    expect(await runCli(["list", "-c", CTX, "--order-by", "score"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain(
      "'score' is not one of 'updated_at', 'created_at', 'importance', 'observed_at', 'event_start'.",
    );
    const help = harness();
    expect(await runCli(["list", "--help"], help.deps)).toBe(0);
    const text = help.out.join("\n").replace(/\s+/g, " ");
    expect(text).toContain("--order-by [updated_at|created_at|importance|observed_at|event_start]");
    expect(text).toContain("observed_at needs server v0.127.0+, event_start v0.152.0+)");
  });
});
