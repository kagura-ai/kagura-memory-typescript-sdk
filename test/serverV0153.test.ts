/**
 * memory-cloud v0.153.0 (#144; the Python SDK 0.46.0's #335): the opt-in
 * Sleep related index. `rollback_sleep_run` undoes its `index_related`
 * actions and counts them in the summary as `related_indexes_reverted`,
 * a key the server adds only when at least one entry was reverted.
 *
 * The count is a field of `RollbackSummary`, after `points_requeued` as in
 * Python's model: typed on a clean rollback and on
 * `KaguraPartialRollbackError.summary`, checked as the other counters are,
 * and 0 in the model's reading when the server sends no key.
 */

import { describe, expect, it } from "vitest";

import { KaguraPartialRollbackError } from "../src/errors.js";
import { readModel, ROLLBACK_RESULT, ROLLBACK_SUMMARY } from "../src/pyModels.js";
import { FakeServer, makeClient } from "./fakeServer.js";

const CTX = "c0ffee00-0000-4000-8000-000000000001";

describe("RollbackSummary.related_indexes_reverted (v0.153.0+)", () => {
  it("is read after points_requeued, and is 0 when the server sends no key", () => {
    const read = readModel({ edges_deleted: 1 }, ROLLBACK_SUMMARY, "rollback_sleep_run");
    expect(read.related_indexes_reverted).toBe(0);
    const keys = Object.keys(read);
    expect(keys.indexOf("related_indexes_reverted")).toBe(keys.indexOf("points_requeued") + 1);
    expect(keys.indexOf("errors")).toBe(keys.indexOf("related_indexes_reverted") + 1);
  });

  it("keeps the count the server sends, also inside a RollbackResult", () => {
    expect(
      readModel({ related_indexes_reverted: 2 }, ROLLBACK_SUMMARY, "rollback_sleep_run").related_indexes_reverted,
    ).toBe(2);
    const result = readModel(
      { report_id: "r-1", status: "rolled_back", rollback_summary: { related_indexes_reverted: 4 } },
      ROLLBACK_RESULT,
      "rollback_sleep_run",
    );
    expect((result.rollback_summary as Record<string, unknown>).related_indexes_reverted).toBe(4);
  });

  it("a clean rollback returns it, typed", async () => {
    const server = new FakeServer();
    server.toolResults.rollback_sleep_run = {
      status: "rolled_back",
      report_id: "r-1",
      rollback_summary: { edges_deleted: 1, related_indexes_reverted: 2, errors: [] },
    };
    const result = await makeClient(server).rollbackSleepRun({ contextId: CTX, reportId: "r-1" });
    const count: number | undefined = result.rollback_summary.related_indexes_reverted;
    expect(count).toBe(2);
  });

  it("a partial rollback's summary carries it, and a count that is no integer is drift", async () => {
    const server = new FakeServer();
    const reply = (related: unknown): Record<string, unknown> => ({
      status: "error",
      error: "partial_rollback",
      message: "1 action could not be reversed",
      report_id: "r-1",
      rollback_summary: { related_indexes_reverted: related, errors: ["Action 42 (merge): edge changed"] },
    });
    server.toolResults.rollback_sleep_run = reply(3);
    const err = await makeClient(server)
      .rollbackSleepRun({ contextId: CTX, reportId: "r-1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraPartialRollbackError);
    const count: number | undefined = (err as KaguraPartialRollbackError).summary.related_indexes_reverted;
    expect(count).toBe(3);

    server.toolResults.rollback_sleep_run = reply("three");
    const drift = await makeClient(server)
      .rollbackSleepRun({ contextId: CTX, reportId: "r-1" })
      .catch((e: unknown) => e);
    expect(drift).toBeInstanceOf(KaguraPartialRollbackError);
    expect((drift as Error).message).toContain("(rollback_summary could not be read)");
    expect(((drift as Error).cause as Error).message).toContain(
      "related_indexes_reverted: Input should be a valid integer, unable to parse string as an integer",
    );
  });
});
