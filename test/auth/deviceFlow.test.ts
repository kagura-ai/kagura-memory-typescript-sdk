import { describe, expect, it } from "vitest";

import {
  DEFAULT_CLIENT_ID,
  authorizeDevice,
  pollForToken,
  refreshAccessToken,
  revokeToken,
} from "../../src/auth/deviceFlow.js";
import {
  KaguraAuthDeniedError,
  KaguraAuthError,
  KaguraAuthExpiredError,
  KaguraConnectionError,
} from "../../src/errors.js";

const SERVER = "https://test.example.com";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

/** Fetch stub that answers from a queue of responses, recording calls. */
function sequenceFetch(responses: Response[], calls?: RecordedCall[]): typeof fetch {
  let i = 0;
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls?.push({ url: String(input), init });
    const response = responses[i];
    i += 1;
    if (response === undefined) {
      throw new Error("sequenceFetch: ran out of stubbed responses");
    }
    return response;
  };
  return impl as typeof fetch;
}

function failingFetch(message = "connect ECONNREFUSED"): typeof fetch {
  const impl = async (): Promise<Response> => {
    throw new TypeError(message);
  };
  return impl as typeof fetch;
}

const noSleep = async (_ms: number): Promise<void> => {};

const TOKEN_BODY = {
  access_token: "atok",
  refresh_token: "rtok",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "memory:read",
  user_email: "u@example.com",
  workspace_id: "ws-1",
  workspace_name: "ws",
};

function futureDate(ms: number): Date {
  return new Date(Date.now() + ms);
}

// ---------------------------------------------------------------------------
// authorizeDevice
// ---------------------------------------------------------------------------

describe("authorizeDevice", () => {
  it("posts JSON with client_id + scope and parses the response", async () => {
    const calls: RecordedCall[] = [];
    const stub = sequenceFetch(
      [
        jsonResponse(200, {
          device_code: "dc-1",
          user_code: "ABCD-1234",
          verification_uri: "https://test.example.com/device",
          verification_uri_complete: "https://test.example.com/device?user_code=ABCD-1234",
          expires_in: 600,
          interval: 5,
        }),
      ],
      calls,
    );

    const da = await authorizeDevice(SERVER, { scope: "memory:read", fetch: stub });
    expect(da.userCode).toBe("ABCD-1234");
    expect(da.deviceCode).toBe("dc-1");
    expect(da.interval).toBe(5);
    expect(da.verificationUriComplete).toContain("user_code=ABCD-1234");
    expect(da.expiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${SERVER}/api/v1/oauth/device/authorize`);
    const posted = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(posted.client_id).toBe(DEFAULT_CLIENT_ID);
    expect(posted.scope).toBe("memory:read");
    // client_id auth only — never a Bearer header on /oauth/* requests.
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });

  it("falls back verification_uri_complete to verification_uri", async () => {
    const stub = sequenceFetch([
      jsonResponse(200, {
        device_code: "dc",
        user_code: "AB",
        verification_uri: "https://x/device",
        expires_in: 600,
      }),
    ]);
    const da = await authorizeDevice(SERVER, { fetch: stub });
    expect(da.verificationUriComplete).toBe("https://x/device");
    expect(da.interval).toBe(5); // default when the server omits it
  });

  it("wraps an HTTP error as KaguraAuthError", async () => {
    const stub = sequenceFetch([jsonResponse(400, { detail: "invalid_client" })]);
    await expect(authorizeDevice(SERVER, { fetch: stub })).rejects.toThrow(
      /Device authorization failed/,
    );
  });

  it("wraps a network error as KaguraConnectionError", async () => {
    await expect(authorizeDevice(SERVER, { fetch: failingFetch() })).rejects.toThrow(
      KaguraConnectionError,
    );
    await expect(authorizeDevice(SERVER, { fetch: failingFetch() })).rejects.toThrow(
      /Could not reach/,
    );
  });

  it("raises KaguraAuthError for a non-JSON 200 body", async () => {
    const stub = sequenceFetch([textResponse(200, "<html>500 Internal Server Error</html>")]);
    await expect(authorizeDevice(SERVER, { fetch: stub })).rejects.toThrow(/not JSON/);
  });

  it("raises KaguraAuthError when device_code is missing", async () => {
    const stub = sequenceFetch([
      jsonResponse(200, {
        user_code: "ABCD",
        verification_uri: "https://x",
        expires_in: 600,
      }),
    ]);
    await expect(authorizeDevice(SERVER, { fetch: stub })).rejects.toThrow(
      /missing required fields/,
    );
  });
});

// ---------------------------------------------------------------------------
// pollForToken
// ---------------------------------------------------------------------------

describe("pollForToken", () => {
  it("returns the token on an immediate 200 with zero sleeps", async () => {
    const sleeps: number[] = [];
    const token = await pollForToken(SERVER, {
      clientId: DEFAULT_CLIENT_ID,
      deviceCode: "dc",
      interval: 5,
      expiresAt: futureDate(600_000),
      fetch: sequenceFetch([jsonResponse(200, TOKEN_BODY)]),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(token.accessToken).toBe("atok");
    expect(token.refreshToken).toBe("rtok");
    expect(token.userEmail).toBe("u@example.com");
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(sleeps).toEqual([]); // first poll fires immediately
  });

  it("retries through authorization_pending until success", async () => {
    const calls: RecordedCall[] = [];
    const stub = sequenceFetch(
      [
        jsonResponse(400, { error: "authorization_pending" }),
        jsonResponse(400, { error: "authorization_pending" }),
        jsonResponse(200, TOKEN_BODY),
      ],
      calls,
    );
    const token = await pollForToken(SERVER, {
      clientId: DEFAULT_CLIENT_ID,
      deviceCode: "dc",
      interval: 5,
      expiresAt: futureDate(600_000),
      fetch: stub,
      sleep: noSleep,
    });
    expect(token.accessToken).toBe("atok");
    expect(calls).toHaveLength(3);
    expect(String(calls[0]?.init?.body)).toContain("device_code=dc");
    expect(calls[0]?.url).toBe(`${SERVER}/api/v1/oauth/token/`);
  });

  it("adds 5 seconds to the interval after slow_down", async () => {
    const sleeps: number[] = [];
    const stub = sequenceFetch([
      jsonResponse(400, { error: "slow_down" }),
      jsonResponse(200, TOKEN_BODY),
    ]);
    await pollForToken(SERVER, {
      clientId: DEFAULT_CLIENT_ID,
      deviceCode: "dc",
      interval: 5,
      expiresAt: futureDate(600_000),
      fetch: stub,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    // First poll is immediate; after slow_down the interval becomes 10 s.
    expect(sleeps).toEqual([10_000]);
  });

  it("raises KaguraAuthDeniedError on access_denied", async () => {
    const stub = sequenceFetch([jsonResponse(400, { error: "access_denied" })]);
    await expect(
      pollForToken(SERVER, {
        clientId: DEFAULT_CLIENT_ID,
        deviceCode: "dc",
        interval: 5,
        expiresAt: futureDate(600_000),
        fetch: stub,
        sleep: noSleep,
      }),
    ).rejects.toThrow(KaguraAuthDeniedError);
  });

  it("raises KaguraAuthExpiredError on expired_token", async () => {
    const stub = sequenceFetch([jsonResponse(400, { error: "expired_token" })]);
    await expect(
      pollForToken(SERVER, {
        clientId: DEFAULT_CLIENT_ID,
        deviceCode: "dc",
        interval: 5,
        expiresAt: futureDate(600_000),
        fetch: stub,
        sleep: noSleep,
      }),
    ).rejects.toThrow(KaguraAuthExpiredError);
  });

  it("raises KaguraAuthExpiredError when expiresAt has already passed", async () => {
    const calls: RecordedCall[] = [];
    const stub = sequenceFetch([jsonResponse(400, { error: "authorization_pending" })], calls);
    await expect(
      pollForToken(SERVER, {
        clientId: DEFAULT_CLIENT_ID,
        deviceCode: "dc",
        interval: 5,
        expiresAt: new Date(Date.now() - 1000),
        fetch: stub,
        sleep: noSleep,
      }),
    ).rejects.toThrow(KaguraAuthExpiredError);
    expect(calls).toHaveLength(0); // cut off before any poll
  });

  it("wraps a network error as KaguraConnectionError", async () => {
    await expect(
      pollForToken(SERVER, {
        clientId: DEFAULT_CLIENT_ID,
        deviceCode: "dc",
        interval: 5,
        expiresAt: futureDate(600_000),
        fetch: failingFetch(),
        sleep: noSleep,
      }),
    ).rejects.toThrow(/Lost connection/);
  });

  it("surfaces HTTP status + body for a non-JSON 5xx", async () => {
    const stub = sequenceFetch([textResponse(502, "Bad Gateway")]);
    await expect(
      pollForToken(SERVER, {
        clientId: DEFAULT_CLIENT_ID,
        deviceCode: "dc",
        interval: 5,
        expiresAt: futureDate(600_000),
        fetch: stub,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/HTTP 502/);
  });

  it("raises KaguraAuthError for a non-JSON 200 body", async () => {
    const stub = sequenceFetch([textResponse(200, "garbled")]);
    await expect(
      pollForToken(SERVER, {
        clientId: DEFAULT_CLIENT_ID,
        deviceCode: "dc",
        interval: 5,
        expiresAt: futureDate(600_000),
        fetch: stub,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/not JSON/);
  });
});

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------

describe("refreshAccessToken", () => {
  it("posts grant_type=refresh_token as a form body without scope", async () => {
    const calls: RecordedCall[] = [];
    const stub = sequenceFetch(
      [jsonResponse(200, { ...TOKEN_BODY, access_token: "atok-new", refresh_token: "rtok-new" })],
      calls,
    );
    const token = await refreshAccessToken(SERVER, {
      clientId: DEFAULT_CLIENT_ID,
      refreshToken: "rtok-old",
      fetch: stub,
    });
    expect(token.accessToken).toBe("atok-new");
    expect(token.refreshToken).toBe("rtok-new");

    const body = String(calls[0]?.init?.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=rtok-old");
    expect(body).not.toContain("scope=");
  });

  it("includes scope in the form body when supplied", async () => {
    const calls: RecordedCall[] = [];
    const stub = sequenceFetch(
      [jsonResponse(200, { ...TOKEN_BODY, scope: "memory:read memory:write" })],
      calls,
    );
    const token = await refreshAccessToken(SERVER, {
      clientId: DEFAULT_CLIENT_ID,
      refreshToken: "rtok-old",
      scope: "memory:read memory:write",
      fetch: stub,
    });
    expect(token.scope).toBe("memory:read memory:write");
    expect(String(calls[0]?.init?.body)).toContain("scope=memory%3Aread+memory%3Awrite");
  });

  it("maps invalid_grant to KaguraAuthExpiredError", async () => {
    const stub = sequenceFetch([jsonResponse(400, { error: "invalid_grant" })]);
    await expect(
      refreshAccessToken(SERVER, {
        clientId: DEFAULT_CLIENT_ID,
        refreshToken: "rtok-old",
        fetch: stub,
      }),
    ).rejects.toThrow(KaguraAuthExpiredError);
  });

  it("maps insufficient_scope to a generic KaguraAuthError", async () => {
    const stub = sequenceFetch([jsonResponse(400, { error: "insufficient_scope" })]);
    let caught: unknown;
    try {
      await refreshAccessToken(SERVER, {
        clientId: DEFAULT_CLIENT_ID,
        refreshToken: "rtok-old",
        scope: "memory:write",
        fetch: stub,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KaguraAuthError);
    expect(caught).not.toBeInstanceOf(KaguraAuthExpiredError);
    expect((caught as Error).message).toMatch(/insufficient_scope/);
  });

  it("surfaces HTTP status + body for a non-JSON 5xx", async () => {
    const stub = sequenceFetch([textResponse(503, "Service Unavailable - proxy timeout")]);
    await expect(
      refreshAccessToken(SERVER, {
        clientId: DEFAULT_CLIENT_ID,
        refreshToken: "rtok-old",
        fetch: stub,
      }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("wraps a network error as KaguraConnectionError with a non-empty reason", async () => {
    let caught: unknown;
    try {
      await refreshAccessToken(SERVER, {
        clientId: DEFAULT_CLIENT_ID,
        refreshToken: "rtok-old",
        fetch: failingFetch(""),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KaguraConnectionError);
    // The wrapper must not strand the prefix when the cause has no message.
    const msg = (caught as Error).message;
    expect(msg.split(": ").pop()).not.toBe("");
  });

  it("raises KaguraAuthError for a non-JSON 200 body", async () => {
    const stub = sequenceFetch([textResponse(200, "garbled")]);
    await expect(
      refreshAccessToken(SERVER, {
        clientId: DEFAULT_CLIENT_ID,
        refreshToken: "rtok",
        fetch: stub,
      }),
    ).rejects.toThrow(/not JSON/);
  });
});

// ---------------------------------------------------------------------------
// revokeToken (best-effort)
// ---------------------------------------------------------------------------

describe("revokeToken", () => {
  it("returns true on 200", async () => {
    const stub = sequenceFetch([jsonResponse(200, {})]);
    expect(await revokeToken(SERVER, { token: "atok", fetch: stub })).toBe(true);
  });

  it("returns true on 204", async () => {
    const stub = sequenceFetch([new Response(null, { status: 204 })]);
    expect(await revokeToken(SERVER, { token: "atok", fetch: stub })).toBe(true);
  });

  it("returns false on 5xx", async () => {
    const stub = sequenceFetch([jsonResponse(500, {})]);
    expect(await revokeToken(SERVER, { token: "atok", fetch: stub })).toBe(false);
  });

  it("returns false on network failure (never throws)", async () => {
    expect(await revokeToken(SERVER, { token: "atok", fetch: failingFetch() })).toBe(false);
  });
});
