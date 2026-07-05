import { describe, expect, it } from "vitest";

import {
  KaguraAuthError,
  KaguraConnectionError,
  KaguraRateLimitError,
} from "../src/errors.js";
import {
  baseUrlFromMcp,
  extractDetail,
  retryAfterSeconds,
  sanitizeServerDetail,
  throwForKaguraStatus,
  validateHttpsUrl,
} from "../src/http.js";

describe("baseUrlFromMcp", () => {
  it("strips /mcp", () => {
    expect(baseUrlFromMcp("https://memory.kagura-ai.com/mcp")).toBe(
      "https://memory.kagura-ai.com",
    );
  });

  it("strips /mcp/w/{workspace}", () => {
    expect(baseUrlFromMcp("https://x.test/mcp/w/abc123")).toBe("https://x.test");
  });

  it("leaves URLs without /mcp untouched", () => {
    expect(baseUrlFromMcp("https://x.test")).toBe("https://x.test");
  });

  it("does not strip an /mcp substring inside a longer segment", () => {
    expect(baseUrlFromMcp("https://x.test/mcpx/foo")).toBe("https://x.test/mcpx/foo");
  });
});

describe("extractDetail", () => {
  it("returns string detail as-is", () => {
    expect(extractDetail(JSON.stringify({ detail: "nope" }))).toBe("nope");
  });

  it("formats FastAPI validation error lists", () => {
    const body = JSON.stringify({
      detail: [
        { loc: ["body", "summary"], msg: "field required" },
        { loc: ["body", "importance"], msg: "must be <= 1.0" },
      ],
    });
    expect(extractDetail(body)).toBe(
      "body.summary: field required; body.importance: must be <= 1.0",
    );
  });

  it("skips malformed validation entries", () => {
    const body = JSON.stringify({
      detail: [{ loc: ["a"], msg: "bad" }, "junk", { msg: 42 }],
    });
    expect(extractDetail(body)).toBe("a: bad");
  });

  it("returns message from the canonical envelope", () => {
    expect(
      extractDetail(JSON.stringify({ error: "CODE", message: "Something failed" })),
    ).toBe("Something failed");
  });

  it("appends details.errors validation list to the envelope message", () => {
    const body = JSON.stringify({
      error: "VALIDATION",
      message: "Request validation failed",
      details: { errors: [{ loc: ["query", "k"], msg: "too big" }] },
    });
    expect(extractDetail(body)).toBe("Request validation failed: query.k: too big");
  });

  it("returns empty string for non-JSON, non-object, or unknown shapes", () => {
    expect(extractDetail("<html>maintenance</html>")).toBe("");
    expect(extractDetail("[1,2]")).toBe("");
    expect(extractDetail(JSON.stringify({ other: 1 }))).toBe("");
  });
});

describe("sanitizeServerDetail", () => {
  it("passes through safe details", () => {
    expect(sanitizeServerDetail("plan limit reached")).toBe("plan limit reached");
  });

  it.each(["Bearer abc123", "authorization header echoed", "api_key=secret"])(
    "drops credential-shaped detail %s",
    (detail) => {
      expect(sanitizeServerDetail(detail)).toBeNull();
    },
  );

  it("returns null for empty input", () => {
    expect(sanitizeServerDetail("")).toBeNull();
    expect(sanitizeServerDetail(null)).toBeNull();
    expect(sanitizeServerDetail(undefined)).toBeNull();
  });
});

describe("retryAfterSeconds", () => {
  it("parses integer seconds", () => {
    expect(retryAfterSeconds(new Headers({ "Retry-After": "30" }))).toBe(30);
  });

  it("ignores HTTP-date form", () => {
    expect(
      retryAfterSeconds(new Headers({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" })),
    ).toBeNull();
  });

  it("returns null when absent", () => {
    expect(retryAfterSeconds(new Headers())).toBeNull();
  });
});

describe("throwForKaguraStatus", () => {
  it("maps 401 to KaguraAuthError", () => {
    expect(() => throwForKaguraStatus(401, new Headers(), "")).toThrow(KaguraAuthError);
  });

  it("maps 429 to KaguraRateLimitError with retryAfter", () => {
    try {
      throwForKaguraStatus(429, new Headers({ "Retry-After": "12" }), JSON.stringify({ detail: "slow" }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KaguraRateLimitError);
      expect((e as KaguraRateLimitError).retryAfter).toBe(12);
      expect((e as KaguraRateLimitError).message).toContain("slow");
    }
  });

  it("maps other statuses to KaguraConnectionError with the detail", () => {
    expect(() =>
      throwForKaguraStatus(422, new Headers(), JSON.stringify({ detail: "bad field" })),
    ).toThrow(/HTTP 422: bad field/);
    expect(() => throwForKaguraStatus(500, new Headers(), "")).toThrow(KaguraConnectionError);
  });

  it("uses the fallback message when no detail is present", () => {
    expect(() => throwForKaguraStatus(503, new Headers(), "", "went away")).toThrow(
      /HTTP 503: went away/,
    );
  });
});

describe("validateHttpsUrl", () => {
  it.each([
    "https://memory.kagura-ai.com/mcp",
    "http://localhost:8080/mcp",
    "http://localhost/mcp",
    "http://127.0.0.1:8080",
    "http://[::1]:8080/mcp",
  ])("accepts %s", (url) => {
    expect(() => validateHttpsUrl(url)).not.toThrow();
  });

  it.each([
    "http://example.com/mcp",
    "http://localhost.evil.com/mcp",
    "http://localhost@evil.com/mcp",
    "http://127.0.0.1.evil.com/",
  ])("rejects %s", (url) => {
    expect(() => validateHttpsUrl(url, "MCP URL")).toThrow(/MCP URL must use HTTPS/);
  });
});
