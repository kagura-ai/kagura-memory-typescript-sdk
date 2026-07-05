import { describe, expect, it } from "vitest";

import {
  excMessage,
  KaguraAuthDeniedError,
  KaguraAuthError,
  KaguraAuthExpiredError,
  KaguraConnectionError,
  KaguraError,
  KaguraFetchError,
  KaguraNotFoundError,
  KaguraQuotaError,
  KaguraRateLimitError,
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

  it("supports cause chaining", () => {
    const cause = new Error("root");
    const e = new KaguraConnectionError("wrapped", { cause });
    expect(e.cause).toBe(cause);
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
