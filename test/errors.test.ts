import { afterEach, describe, expect, it, vi } from "vitest";

import {
  excMessage,
  KaguraAuthDeniedError,
  KaguraAuthError,
  KaguraAuthExpiredError,
  KaguraConnectionError,
  KaguraError,
  KaguraFetchError,
  KaguraNotFoundError,
  KaguraPartialRollbackError,
  KaguraPermissionError,
  KaguraFeatureNotAvailableError,
  KaguraQuotaError,
  KaguraRateLimitError,
  KaguraResponseError,
} from "../src/errors.js";

describe("error hierarchy", () => {
  it("all Kagura errors are instances of KaguraError and Error", () => {
    const e = new KaguraNotFoundError("gone");
    expect(e).toBeInstanceOf(KaguraError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("KaguraNotFoundError");
    expect(e.message).toBe("gone");
  });

  it("auth sub-errors are instances of KaguraAuthError", () => {
    expect(new KaguraAuthExpiredError("expired")).toBeInstanceOf(KaguraAuthError);
    expect(new KaguraAuthDeniedError("denied")).toBeInstanceOf(KaguraAuthError);
  });

  it("KaguraAuthExpiredError carries expiresAt", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    expect(new KaguraAuthExpiredError("expired", at).expiresAt).toBe(at);
    expect(new KaguraAuthExpiredError("expired").expiresAt).toBeNull();
  });

  it("rate limit and quota errors carry retryAfter", () => {
    expect(new KaguraRateLimitError("slow down", 30).retryAfter).toBe(30);
    expect(new KaguraRateLimitError("slow down").retryAfter).toBeNull();
    expect(new KaguraQuotaError("quota", 60).retryAfter).toBe(60);
  });

  it("KaguraFetchError carries url", () => {
    expect(new KaguraFetchError("bad", "https://x.test").url).toBe("https://x.test");
    expect(new KaguraFetchError("bad").url).toBeNull();
  });

  it("KaguraResponseError carries the operation, and is no connection error", () => {
    // Python's class extends KaguraError directly: the call succeeded, so
    // code retrying on KaguraConnectionError must not retry this.
    const e = new KaguraResponseError("recall_series: unexpected server response", "recall_series");
    expect(e).toBeInstanceOf(KaguraError);
    expect(e).not.toBeInstanceOf(KaguraConnectionError);
    expect(e.name).toBe("KaguraResponseError");
    expect(e.operation).toBe("recall_series");
    expect(new KaguraResponseError("x").operation).toBeUndefined();
    const cause = new Error("root");
    expect(new KaguraResponseError("x", "op", { cause }).cause).toBe(cause);
  });

  it("supports cause chaining", () => {
    const cause = new Error("root");
    const e = new KaguraConnectionError("wrapped", { cause });
    expect(e.cause).toBe(cause);
  });
});

describe("gate errors (#40)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("every new class is a KaguraError", () => {
    expect(new KaguraFeatureNotAvailableError("plan")).toBeInstanceOf(KaguraError);
    expect(new KaguraPartialRollbackError("partial")).toBeInstanceOf(KaguraError);
    expect(new KaguraPermissionError("denied")).toBeInstanceOf(KaguraError);
    expect(new KaguraFeatureNotAvailableError("plan").name).toBe("KaguraFeatureNotAvailableError");
  });

  it("KaguraQuotaError keeps its (message, retryAfter, options) signature", () => {
    const cause = new Error("root");
    const e = new KaguraQuotaError("quota", 60, { cause });
    expect(e.retryAfter).toBe(60);
    expect(e.cause).toBe(cause);
    // Every gate field defaults to null, so a pre-#40 construction still
    // reads as "the server said nothing more".
    expect(e.gate).toBeNull();
    expect(e.quotaType).toBeNull();
    expect(e.current).toBeNull();
    expect(e.limit).toBeNull();
    expect(e.usedToday).toBeNull();
    expect(e.resetsAt).toBeNull();
    expect(e.requiredPlan).toBeNull();
  });

  it("KaguraQuotaError carries the gate payload", () => {
    const e = new KaguraQuotaError("quota", null, {
      gate: "quota",
      quotaType: "resource_tokens",
      current: 3,
      limit: 3,
      feature: "resources",
      requiredPlan: "pro",
      requiredPlanDisplay: "L",
      currentPlan: "basic",
    });
    expect(e.gate).toBe("quota");
    expect(e.quotaType).toBe("resource_tokens");
    expect(e.current).toBe(3);
    expect(e.limit).toBe(3);
    expect(e.feature).toBe("resources");
    expect(e.requiredPlan).toBe("pro");
    expect(e.requiredPlanDisplay).toBe("L");
    expect(e.currentPlan).toBe("basic");
    // A fixed cap has no reset time, so nothing to wait for.
    expect(e.retryAfter).toBeNull();
  });

  it("derives retryAfter from resetsAt when none is given", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T23:58:30Z"));
    const e = new KaguraQuotaError("daily", null, { resetsAt: "2026-09-24T00:00:00+00:00" });
    expect(e.resetsAt).toBe("2026-09-24T00:00:00+00:00");
    expect(e.retryAfter).toBe(90);
  });

  it("rounds a fractional wait up, so retrying after it is never early", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T23:59:59.500Z"));
    const e = new KaguraQuotaError("daily", null, { resetsAt: "2026-09-24T00:00:00Z" });
    expect(e.retryAfter).toBe(1);
  });

  it("prefers an explicit retryAfter over resetsAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
    const e = new KaguraQuotaError("daily", 7, { resetsAt: "2026-09-24T00:00:00Z" });
    expect(e.retryAfter).toBe(7);
  });

  it("clamps a past resetsAt to 0 and ignores an unparseable one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T00:00:05Z"));
    const past = new KaguraQuotaError("q", null, { resetsAt: "2026-09-24T00:00:00Z" });
    expect(past.retryAfter).toBe(0);
    const garbled = new KaguraQuotaError("q", null, { resetsAt: "tomorrow" });
    expect(garbled.retryAfter).toBeNull();
  });

  it("KaguraFeatureNotAvailableError carries the plan payload and defaults it to null", () => {
    const e = new KaguraFeatureNotAvailableError("upgrade", {
      gate: "plan",
      feature: "resources",
      requiredPlan: "promax",
      requiredPlanDisplay: "XL",
      currentPlan: "pro",
    });
    expect(e.gate).toBe("plan");
    expect(e.feature).toBe("resources");
    expect(e.requiredPlan).toBe("promax");
    expect(e.requiredPlanDisplay).toBe("XL");
    expect(e.currentPlan).toBe("pro");

    const bare = new KaguraFeatureNotAvailableError("upgrade");
    expect(bare.gate).toBeNull();
    expect(bare.feature).toBeNull();
    expect(bare.requiredPlan).toBeNull();
  });

  it("KaguraPartialRollbackError carries the report id and summary", () => {
    const summary = { edges_deleted: 2, errors: ["Action 7 (merge): edge changed"] };
    const e = new KaguraPartialRollbackError("partial", "r1", summary);
    expect(e.reportId).toBe("r1");
    expect(e.summary).toBe(summary);

    const bare = new KaguraPartialRollbackError("partial");
    expect(bare.reportId).toBeNull();
    expect(bare.summary).toEqual({});
  });

  it("KaguraRateLimitError keeps its signature and defaults the gate payload to null", () => {
    const cause = new Error("root");
    const e = new KaguraRateLimitError("slow down", 60, { cause });
    expect(e.retryAfter).toBe(60);
    expect(e.cause).toBe(cause);
    expect(e.gate).toBeNull();
    expect(e.quotaType).toBeNull();
    expect(e.current).toBeNull();
    expect(e.requiredPlan).toBeNull();

    const quota = new KaguraRateLimitError("daily", null, {
      gate: "quota",
      quotaType: "api_mcp_daily",
    });
    expect(quota).not.toBeInstanceOf(KaguraQuotaError);
    expect(quota.gate).toBe("quota");
    expect(quota.quotaType).toBe("api_mcp_daily");
  });

  it("KaguraPermissionError carries requiredRole", () => {
    expect(new KaguraPermissionError("denied", "editor").requiredRole).toBe("editor");
    expect(new KaguraPermissionError("denied").requiredRole).toBeNull();
  });
});

describe("excMessage", () => {
  it("returns the message when non-empty", () => {
    expect(excMessage(new Error("boom"))).toBe("boom");
  });

  it("falls back to the class name for unmessaged errors", () => {
    expect(excMessage(new RangeError())).toBe("RangeError");
  });

  it("stringifies non-Error values", () => {
    expect(excMessage("plain")).toBe("plain");
  });
});
