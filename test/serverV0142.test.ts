/**
 * memory-cloud v0.142.0 (#88; the Python SDK 0.44.0's #314): the
 * `plan_headroom` notice on the success envelope of `remember`,
 * `remember_batch`, `update_memory` and `bootstrap` (#2615), and
 * `supersede_candidate.acceptance` on every `recall` row (#2508), as on
 * `reference` since v0.137.0 (#2427).
 *
 * **plan_headroom.** `bootstrap` and `rememberBatch` read it fail-open, as
 * Python's `PlanHeadroom` field type reads it: an entry
 * `PlanHeadroomNotice` refuses is dropped and the call succeeds, and a
 * value that is not a list, or keeps no entry, is left out. The entries
 * that read come back as sent. `remember` / `updateMemory` return it as
 * sent, unchecked, as Python's dicts do. The notices are shaped like
 * memory-cloud v0.142.0's `services/plan_headroom.py::_notice` (key order
 * `dimension, level, used, limit, percentage, resets_at?, plan?, remedies,
 * help`), with `help` on the most severe entry only, as `bootstrap`'s
 * budget fit leaves it.
 *
 * **acceptance.** `{allowed, reason?}`: `reason` only when `allowed` is
 * `false`; absent on a share-key read and where the server could not
 * evaluate it. `recall` and `reference` return it as sent.
 */

import { describe, expect, it } from "vitest";

import { KaguraResponseError } from "../src/errors.js";
import type { BootstrapResponse, PlanHeadroomNotice, RememberBatchResult, SupersedeAcceptance } from "../src/index.js";
import { FakeServer, makeClient } from "./fakeServer.js";

const CTX = "11111111-2222-4333-8444-555555555555";
const M1 = "aaaaaaaa-0000-4000-8000-000000000001";
const M2 = "aaaaaaaa-0000-4000-8000-000000000002";
const M3 = "aaaaaaaa-0000-4000-8000-000000000003";

const MEMORIES_NO_HELP = {
  dimension: "memories",
  level: "warning",
  used: 4100,
  limit: 5000,
  percentage: 82.0,
  plan: "free",
  remedies: ["cleanup", "upgrade"],
};
const PER_DAY_CRITICAL = {
  dimension: "memories_per_day",
  level: "critical",
  used: 97,
  limit: 100,
  percentage: 97.0,
  resets_at: "2026-11-05T00:00:00Z",
  plan: "free",
  remedies: ["wait", "upgrade"],
  help:
    "Wait for the daily reset at 2026-11-05T00:00:00Z, or upgrade the plan from the workspace plan " +
    "page in the web UI (Workspace settings → Plan). At 100 % remember will be refused until the reset.",
};
const MCP_CALLS_NO_PLAN = {
  dimension: "mcp_calls_per_day",
  level: "warning",
  used: 8123,
  limit: 10000,
  percentage: 81.2,
  resets_at: "2026-11-05T00:00:00Z",
  remedies: ["wait", "admin"],
};
const SENT = [MEMORIES_NO_HELP, PER_DAY_CRITICAL, MCP_CALLS_NO_PLAN];

function without(entry: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...entry };
  delete copy[key];
  return copy;
}

/** Entries `PlanHeadroomNotice` refuses: a required field missing or unreadable, not an object. */
const UNREADABLE: unknown[] = [
  without(PER_DAY_CRITICAL, "used"),
  without(PER_DAY_CRITICAL, "limit"),
  { ...MCP_CALLS_NO_PLAN, percentage: "high" },
  { ...MEMORIES_NO_HELP, remedies: "cleanup" },
  { ...PER_DAY_CRITICAL, resets_at: "tomorrow" },
  null,
  "memories",
];
/** Readable: a key the model does not declare passes, as Python ignores it. */
const NEWER_KEY = { ...MEMORIES_NO_HELP, addon: "storage" };

/** A `bootstrap({ include: ["changes"], format: "index" })` reply on a `?guardrails=off` URL. */
const BOOTSTRAP = {
  status: "success",
  format: "index",
  degraded: false,
  components: { changes: { status: "ok", changes: [], has_more: false } },
  since: "2026-10-28T12:00:00Z",
  generated_at: "2026-11-04T12:00:00Z",
  context_id: CTX,
  context_name: "dev",
};

const BATCH = {
  status: "success",
  results: [{ index: 0, status: "success", memory_id: M1, scope: "persistent" }],
  count: 1,
  succeeded: 1,
  candidates: 0,
  failed: 0,
  skipped: 0,
  session_id: "sess_3f2a9c",
  context_id: CTX,
};

type Envelope = BootstrapResponse | RememberBatchResult;

/** Call `tool` through its method against a server that answers `reply`. */
async function call(tool: "bootstrap" | "remember_batch", reply: unknown): Promise<Envelope> {
  const server = new FakeServer();
  server.toolResults[tool] = reply;
  const client = makeClient(server);
  return tool === "bootstrap"
    ? client.bootstrap({ contextId: CTX })
    : client.rememberBatch({ contextId: CTX, items: [{ summary: "s", content: "c", type: "note" }] });
}

const ENVELOPES = [
  ["bootstrap", BOOTSTRAP],
  ["remember_batch", BATCH],
] as const;

describe("plan_headroom on bootstrap and remember_batch (memory-cloud v0.142.0, #2615)", () => {
  it.each(ENVELOPES)("%s returns notices that read as sent", async (tool, envelope) => {
    const reply = { ...envelope, plan_headroom: SENT };
    const result = await call(tool, reply);
    expect(result).toEqual(reply);
    const notices: PlanHeadroomNotice[] | undefined = result.plan_headroom;
    expect(notices?.map((n) => [n.dimension, n.level, n.percentage])).toEqual([
      ["memories", "warning", 82],
      ["memories_per_day", "critical", 97],
      ["mcp_calls_per_day", "warning", 81.2],
    ]);
    // What the entry left out stays out: no defaults are filled in.
    expect(notices?.[0]).not.toHaveProperty("help");
    expect(notices?.[2]).not.toHaveProperty("plan");
    expect(notices?.[1]?.resets_at).toBe("2026-11-05T00:00:00Z");
  });

  it.each(ENVELOPES)("%s without plan_headroom (below 80 %%) has none", async (tool, envelope) => {
    const result = await call(tool, envelope);
    expect(result).toEqual(envelope);
    expect(result).not.toHaveProperty("plan_headroom");
  });

  it.each(ENVELOPES)("%s drops each entry PlanHeadroomNotice refuses, and the call succeeds", async (tool, envelope) => {
    const reply = { ...envelope, plan_headroom: [UNREADABLE[0], PER_DAY_CRITICAL, ...UNREADABLE.slice(1), NEWER_KEY] };
    const result = await call(tool, reply);
    expect(result).toEqual({ ...envelope, plan_headroom: [PER_DAY_CRITICAL, NEWER_KEY] });
    // The rest of the reply is untouched, its keys in the order sent.
    expect(Object.keys(result)).toEqual(Object.keys(reply));
  });

  it.each(
    ENVELOPES.flatMap(([tool, envelope]) =>
      (
        [
          ["no entry reads", [without(PER_DAY_CRITICAL, "used")]],
          ["it is empty", []],
          ["it is null", null],
          ["it is an object", { x: 1 }],
          ["it is a string", "x"],
        ] as const
      ).map(([why, value]) => [tool, why, envelope, value] as const),
    ),
  )("%s leaves plan_headroom out when %s", async (tool, _why, envelope, value) => {
    const result = await call(tool, { ...envelope, plan_headroom: value });
    expect(result).toEqual(envelope);
    expect(result).not.toHaveProperty("plan_headroom");
  });

  it("bootstrap reads an unreadable guardrails block and plan_headroom fail-open together", async () => {
    const reply = { ...BOOTSTRAP, guardrails: { items: "x" }, plan_headroom: [UNREADABLE[0], PER_DAY_CRITICAL] };
    const result = await call("bootstrap", reply);
    expect(result).toEqual({ ...BOOTSTRAP, guardrails: null, plan_headroom: [PER_DAY_CRITICAL] });
  });

  it("an unreadable notice never rescues a reply the model refuses", async () => {
    const reply = { ...without(BATCH, "count"), plan_headroom: UNREADABLE };
    const err = await call("remember_batch", reply).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraResponseError);
    expect((err as Error).message).toContain("(count: Field required)");
  });
});

describe("plan_headroom on remember and update_memory: as sent, as Python's dicts (#2615)", () => {
  // Unchecked, like the rest of these replies: nothing is dropped.
  const notices = [UNREADABLE[0], PER_DAY_CRITICAL];

  it("remember returns the notices as sent", async () => {
    const server = new FakeServer();
    const reply = { status: "success", memory_id: M1, scope: "persistent", version: 1, plan_headroom: notices };
    server.toolResults.remember = reply;
    const result = await makeClient(server).remember({ contextId: CTX, summary: "s", content: "c" });
    expect(result).toEqual(reply);
    expect(result.plan_headroom?.[1]?.level).toBe("critical");
  });

  it("updateMemory returns the notices as sent", async () => {
    const server = new FakeServer();
    const reply = { status: "success", memory_id: M1, operation: "updated", version: 2, plan_headroom: notices };
    server.toolResults.update_memory = reply;
    const result = await makeClient(server).updateMemory({ contextId: CTX, memoryId: M1, summary: "A summary of ten" });
    expect(result).toEqual(reply);
    expect(result.plan_headroom?.[1]?.dimension).toBe("memories_per_day");
  });
});

describe("supersede_candidate.acceptance (recall v0.142.0 #2508, reference v0.137.0 #2427)", () => {
  const candidate = { memory_id: M2, summary: "Deploy target is us-east-1", similarity: 0.93 };
  const row = (memoryId: string, extra: Record<string, unknown>) => ({
    memory_id: memoryId,
    summary: "Deploy target moved to ap-northeast-1",
    type: "decision",
    importance: 0.8,
    score: 0.81,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: null,
    ...extra,
  });
  const RECALL = {
    confidence: { level: "high", top_score: 0.81, result_count: 4, rationale: "Top hit stands out." },
    status: "success",
    results: [
      row(M1, { supersede_candidate: { ...candidate, verified: true, acceptance: { allowed: true } } }),
      row(M3, { supersede_candidate: { ...candidate, acceptance: { allowed: false, reason: "newer_candidate" } } }),
      // A share-key read, or an evaluation that failed: no acceptance.
      row(M2, { supersede_candidate: candidate }),
      row("aaaaaaaa-0000-4000-8000-000000000004", {}),
    ],
    count: 4,
    context_id: CTX,
  };

  it("recall returns each row's acceptance as sent, reason only on a refusal", async () => {
    const server = new FakeServer();
    server.toolResults.recall = RECALL;
    const result = await makeClient(server).recall({ contextId: CTX, query: "deploy target" });
    expect(result).toEqual(RECALL);
    const acceptance: Array<SupersedeAcceptance | undefined> = result.results.map(
      (hit) => hit.supersede_candidate?.acceptance,
    );
    expect(acceptance).toEqual([{ allowed: true }, { allowed: false, reason: "newer_candidate" }, undefined, undefined]);
    expect(acceptance[0]).not.toHaveProperty("reason");
    expect(result.results[2]!.supersede_candidate).not.toHaveProperty("acceptance");
  });

  it.each(["not_writable", "not_owner", "newer_candidate", "edge_exists"])(
    "reference returns a refusal with reason %s as sent",
    async (reason) => {
      const server = new FakeServer();
      const reply = {
        status: "success",
        memory: {
          memory_id: M1,
          summary: "Deploy target moved",
          version: 3,
          supersede_candidate: { ...candidate, acceptance: { allowed: false, reason } },
        },
      };
      server.toolResults.reference = reply;
      const result = await makeClient(server).reference({ contextId: CTX, memoryId: M1 });
      expect(result).toEqual(reply);
      expect(result.memory.supersede_candidate?.acceptance).toEqual({ allowed: false, reason });
    },
  );

  it("reference from a server before v0.137.0 has no acceptance", async () => {
    const server = new FakeServer();
    const reply = { status: "success", memory: { memory_id: M1, supersede_candidate: candidate } };
    server.toolResults.reference = reply;
    const result = await makeClient(server).reference({ contextId: CTX, memoryId: M1 });
    expect(result).toEqual(reply);
    expect(result.memory.supersede_candidate?.acceptance).toBeUndefined();
  });
});
