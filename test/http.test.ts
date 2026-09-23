import { describe, expect, it } from "vitest";

import {
  KaguraAuthError,
  KaguraConnectionError,
  KaguraRateLimitError,
} from "../src/errors.js";
import {
  baseUrlFromMcp,
  extractDetail,
  mcpSessionExpired,
  mcpSessionHeader,
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

  it("never matches /mcp inside the scheme or the host", () => {
    expect(baseUrlFromMcp("https://mcp/mcp")).toBe("https://mcp");
    expect(baseUrlFromMcp("https://mcp")).toBe("https://mcp");
    expect(baseUrlFromMcp("http://mcp:8080/mcp?profile=core")).toBe("http://mcp:8080");
  });

  it("does not strip an /mcp substring inside a longer segment", () => {
    expect(baseUrlFromMcp("https://x.test/mcpx/foo")).toBe("https://x.test/mcpx/foo");
  });

  // Server v0.73+ reads `?profile=` / `?tools=` (v0.74+ `?guardrails=`) off
  // the MCP URL, so a query can sit directly on `/mcp`. It must not leak into
  // the REST base as `/mcp?profile=core/api/v1/...`.
  it.each([
    "https://x.test/mcp?profile=core",
    "https://x.test/mcp?tools=a,b&guardrails=off",
    "https://x.test/mcp#x",
    "https://x.test/mcp/?profile=core",
    "https://x.test/mcp/w/abc?profile=core",
  ])("strips /mcp followed by a query or fragment: %s", (url) => {
    expect(baseUrlFromMcp(url)).toBe("https://x.test");
  });

  // The query and fragment address the MCP endpoint, never the REST API,
  // so they are dropped even when there is no /mcp segment to strip.
  it.each([
    ["https://x.test?profile=core", "https://x.test"],
    ["https://x.test/?profile=core", "https://x.test"],
    ["https://x.test/mcpx?profile=core", "https://x.test/mcpx"],
    ["https://x.test/api#x", "https://x.test/api"],
  ])("drops the query and fragment from %s", (url, expected) => {
    expect(baseUrlFromMcp(url)).toBe(expected);
  });

  it("does not take an /mcp inside the query for the path segment", () => {
    expect(baseUrlFromMcp("https://x.test/api?next=/mcp")).toBe("https://x.test/api");
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

  it("returns error.message from a JSON-RPC error body (#39)", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32603, message: "MCP session not found or expired." },
      id: null,
    });
    expect(extractDetail(body)).toBe("MCP session not found or expired.");
  });

  it("returns error_description from an OAuth-style body (the MCP workspace-URL 400/403)", () => {
    const body = JSON.stringify({
      error: "access_denied",
      error_description: "You are not a member of this workspace.",
    });
    expect(extractDetail(body)).toBe("You are not a member of this workspace.");
  });

  it("reads error_description last, after every other shape", () => {
    expect(extractDetail(JSON.stringify({ detail: "d", error_description: "e" }))).toBe("d");
    expect(
      extractDetail(JSON.stringify({ error: "CODE", message: "m", error_description: "e" })),
    ).toBe("m");
    expect(
      extractDetail(
        JSON.stringify({ error: { code: -32600, message: "rpc" }, error_description: "e" }),
      ),
    ).toBe("rpc");
    expect(extractDetail(JSON.stringify({ error: "x", error_description: 42 }))).toBe("");
  });

  it("returns empty string for non-JSON, non-object, or unknown shapes", () => {
    expect(extractDetail("<html>maintenance</html>")).toBe("");
    expect(extractDetail("[1,2]")).toBe("");
    expect(extractDetail(JSON.stringify({ other: 1 }))).toBe("");
    expect(extractDetail(JSON.stringify({ error: { code: -32603 } }))).toBe("");
  });
});

describe("mcpSessionHeader", () => {
  it("names the session", () => {
    expect(mcpSessionHeader("s-1")).toEqual({ "mcp-session-id": "s-1" });
  });

  it("is empty before a session exists", () => {
    expect(mcpSessionHeader(null)).toEqual({});
  });
});

describe("mcpSessionExpired (#39)", () => {
  const expired = JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32603, message: "MCP session not found or expired." },
    id: null,
  });

  it("is true for a 404 on a request that carried a session id", () => {
    expect(mcpSessionExpired(404, expired, "s-1")).toBe(true);
    expect(mcpSessionExpired(404, "", "s-1")).toBe(true);
  });

  it("is false when the request carried no session id", () => {
    expect(mcpSessionExpired(404, expired, null)).toBe(false);
  });

  it.each([200, 400, 401, 500])("is false for HTTP %i", (status) => {
    expect(mcpSessionExpired(status, expired, "s-1")).toBe(false);
  });

  it("is false for the 404 Method-not-found reply, which ignores the session", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32601, message: "Method not found" },
      id: 1,
    });
    expect(mcpSessionExpired(404, body, "s-1")).toBe(false);
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

  it("carries a typed quota's gate payload on the 429 (#40)", () => {
    const body = JSON.stringify({
      error: "QUOTA-001",
      message: "Daily REST quota exceeded: 1001/1000. Resets at midnight UTC.",
      details: { gate: "quota", quota_type: "api_rest_daily", retry_after: 86400 },
    });
    try {
      throwForKaguraStatus(429, new Headers({ "Retry-After": "86400" }), body);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KaguraRateLimitError);
      const limited = e as KaguraRateLimitError;
      expect(limited.gate).toBe("quota");
      expect(limited.quotaType).toBe("api_rest_daily");
      expect(limited.retryAfter).toBe(86400);
    }
  });

  it("leaves the payload null on a per-minute rate limit (#40)", () => {
    // RATE-001 is no quota: its details.limit is requests per minute, not a cap.
    const body = JSON.stringify({
      error: "RATE-001",
      message: "Rate limit exceeded: 61/60 requests per minute",
      details: { retry_after: 60, limit: 60, remaining: 0 },
    });
    try {
      throwForKaguraStatus(429, new Headers({ "Retry-After": "60" }), body);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KaguraRateLimitError);
      const limited = e as KaguraRateLimitError;
      expect(limited.gate).toBeNull();
      expect(limited.quotaType).toBeNull();
      expect(limited.limit).toBeNull();
      expect(limited.retryAfter).toBe(60);
    }
  });

  it("maps other statuses to KaguraConnectionError with the detail", () => {
    expect(() =>
      throwForKaguraStatus(422, new Headers(), JSON.stringify({ detail: "bad field" })),
    ).toThrow(/HTTP 422: bad field/);
    expect(() => throwForKaguraStatus(500, new Headers(), "")).toThrow(KaguraConnectionError);
  });

  it("quotes an OAuth-style error_description, not a bare status", () => {
    // memory-cloud's MCP transport answers a workspace-URL mismatch this way.
    const body = JSON.stringify({
      error: "workspace_mismatch",
      error_description:
        "API key workspace does not match URL workspace. Use an API key scoped to this workspace.",
    });
    expect(() => throwForKaguraStatus(403, new Headers(), body)).toThrow(
      "HTTP 403: API key workspace does not match URL workspace. " +
        "Use an API key scoped to this workspace.",
    );
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

  // URL parsing lower-cases the scheme, so `fetch` sends these over
  // plaintext all the same — a case-sensitive check waves them through.
  it.each([
    "HTTP://example.com/mcp",
    "Http://example.com/mcp",
    "hTTp://localhost.evil.com/mcp",
  ])("rejects %s regardless of scheme case", (url) => {
    expect(new URL(url).protocol).toBe("http:");
    expect(() => validateHttpsUrl(url, "MCP URL")).toThrow(/MCP URL must use HTTPS/);
  });

  it.each(["HTTP://localhost:8080/mcp", "Http://127.0.0.1:8080"])(
    "still accepts loopback %s in any scheme case",
    (url) => {
      expect(() => validateHttpsUrl(url)).not.toThrow();
    },
  );

  // WHATWG URL parsing strips surrounding whitespace, so these reach the
  // network as plain http:// — but an anchored regex on the raw string
  // never matches, and the guard silently passes.
  it.each([
    " http://example.com/mcp",
    "http://example.com/mcp ",
    "\thttp://example.com/mcp\n",
    "  HTTP://example.com/mcp  ",
  ])("rejects %j despite surrounding whitespace", (url) => {
    expect(new URL(url).protocol).toBe("http:");
    expect(() => validateHttpsUrl(url, "MCP URL")).toThrow(/MCP URL must use HTTPS/);
  });

  it("still accepts loopback wrapped in whitespace", () => {
    expect(() => validateHttpsUrl("  http://localhost:8080/mcp  ")).not.toThrow();
  });

  it("reports the trimmed URL in the error message", () => {
    expect(() => validateHttpsUrl("  http://example.com/mcp  ", "MCP URL")).toThrow(
      /got: http:\/\/example\.com\/mcp\)/,
    );
  });
});
