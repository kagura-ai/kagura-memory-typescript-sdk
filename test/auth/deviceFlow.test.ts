import { describe, expect, it } from "vitest";

import {
  DEFAULT_CLIENT_ID,
  authorizeDevice,
  buildInviteLink,
  checkInviteOrigin,
  inviteBaseUrl,
  parseInvite,
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

  it("reports an RFC 6749 error_description rather than the raw body", async () => {
    // The Python SDK's extract_detail reads error_description too.
    const stub = sequenceFetch([
      jsonResponse(400, { error: "invalid_client", error_description: "Unknown client." }),
    ]);
    const message = await authorizeDevice(SERVER, { fetch: stub }).catch(
      (e: unknown) => (e as Error).message,
    );
    expect(message).toMatch(/^Device authorization failed \(HTTP 400\): Unknown client\.\n/);
    expect(message).not.toContain("invalid_client\"");
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

// memory-cloud v0.76.0 limits device/authorize per client address.
const RATE_LIMIT_DESCRIPTION = "Too many device authorization requests. Please try again later.";
const RATE_LIMIT_BODY = { error: "invalid_request", error_description: RATE_LIMIT_DESCRIPTION };

/** What authorizeDevice throws against a server answering `response`. */
async function authorizeAgainst(response: Response): Promise<Error> {
  const calls: RecordedCall[] = [];
  const caught = await authorizeDevice(SERVER, {
    scope: "memory:read",
    fetch: sequenceFetch([response], calls),
  }).catch((e: unknown) => e);
  expect(calls.map((c) => c.url)).toEqual([`${SERVER}/api/v1/oauth/device/authorize`]);
  expect(caught).toBeInstanceOf(KaguraAuthError);
  return caught as Error;
}

function rateLimited(headers: Record<string, string>, body: unknown = RATE_LIMIT_BODY): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 429,
    headers,
  });
}

describe("authorizeDevice: HTTP 429", () => {
  it("says how long to wait, keeping the server's reason", async () => {
    const { message } = await authorizeAgainst(
      rateLimited({ "Retry-After": "60", "Cache-Control": "no-store" }),
    );
    // The Python CLI's wording.
    expect(message).toBe(
      "Too many sign-in attempts from this address (HTTP 429). Retry after 60 seconds.\n" +
        `  Server said: ${RATE_LIMIT_DESCRIPTION}`,
    );
    // Not the generic failure, whose hint (check the client id) is wrong here.
    expect(message).not.toMatch(/Device authorization failed|registered/);
  });

  it("uses the server's Retry-After", async () => {
    const { message } = await authorizeAgainst(rateLimited({ "Retry-After": " 17 " }));
    expect(message).toContain("Retry after 17 seconds.");
  });

  it.each([
    ["absent", {}],
    ["not a number", { "Retry-After": "soon" }],
    ["negative", { "Retry-After": "-5" }],
    ["an HTTP date", { "Retry-After": "Wed, 23 Sep 2026 12:00:00 GMT" }],
  ])("waits the server's 60 s window when Retry-After is %s", async (_label, headers) => {
    const { message } = await authorizeAgainst(rateLimited(headers));
    expect(message).toContain("Retry after 60 seconds.");
  });

  it("stands alone when the body has no reason to quote", async () => {
    // A proxy's 429 page.
    const { message } = await authorizeAgainst(
      rateLimited({ "Retry-After": "30" }, "<html>rate limited</html>"),
    );
    expect(message).toBe(
      "Too many sign-in attempts from this address (HTTP 429). Retry after 30 seconds.",
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

// ---------------------------------------------------------------------------
// Invite hand-off (#44)
// ---------------------------------------------------------------------------

/** Matches the server's `^[A-Za-z0-9_-]{20,128}$`; 30 characters. */
const INVITE = "inv_ABCDEFGHIJKLMNOPQRSTUV-123";

/**
 * A device response whose frontend (`app.test`) is not the API host, as on
 * a deployment that serves them apart: the link must follow the frontend.
 */
const VERIFY = "https://app.test/device";
const COMPLETE = "https://app.test/device?user_code=WDJB-MJHT";

const LINK = `https://app.test/join/${INVITE}?return_to=%2Fdevice%3Fuser_code%3DWDJB-MJHT`;

/** What a function threw, so a test can inspect the error it chose. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("parseInvite", () => {
  it("accepts a bare token", () => {
    expect(parseInvite(INVITE)).toEqual({ token: INVITE, origin: null, link: null });
  });

  it("accepts a /join/<token> link, ignoring any query or fragment", () => {
    expect(parseInvite(`https://app.test/join/${INVITE}?utm=mail#top`)).toEqual({
      token: INVITE,
      origin: "https://app.test",
      link: `https://app.test/join/${INVITE}`,
    });
  });

  it("accepts a link under a base path, keeping the path in the link", () => {
    expect(parseInvite(`https://app.test/kagura/app/join/${INVITE}`)).toEqual({
      token: INVITE,
      origin: "https://app.test",
      link: `https://app.test/kagura/app/join/${INVITE}`,
    });
  });

  it("accepts a trailing slash, as a frontend with trailingSlash produces", () => {
    expect(parseInvite(`https://app.test/join/${INVITE}/`)).toEqual({
      token: INVITE,
      origin: "https://app.test",
      link: `https://app.test/join/${INVITE}`,
    });
  });

  it("drops the scheme's default port from the origin, as a browser does", () => {
    expect(parseInvite(`https://app.test:443/join/${INVITE}`)?.origin).toBe("https://app.test");
  });

  it("accepts plain HTTP on localhost, as --server does", () => {
    expect(parseInvite(`http://localhost:3000/join/${INVITE}`)?.origin).toBe(
      "http://localhost:3000",
    );
  });

  it("tolerates the whitespace a paste drags along", () => {
    expect(parseInvite(`  ${INVITE}\n`)?.token).toBe(INVITE);
  });

  it.each([
    ["too short", "a".repeat(19)],
    ["too long", "a".repeat(129)],
    ["outside the alphabet", `${INVITE}!`],
    ["empty", ""],
    ["a link with no /join/ segment", `https://app.test/invite/${INVITE}`],
    ["a link with a segment after the token", `https://app.test/join/${INVITE}/extra`],
    ["a link whose token is malformed", "https://app.test/join/short"],
    ["a link on a non-web scheme", `ftp://app.test/join/${INVITE}`],
    ["a host without a scheme", `app.test/join/${INVITE}`],
    // The link carries a sign-up credential; the same rule as --server.
    ["a plain-HTTP link off localhost", `http://app.test/join/${INVITE}`],
  ])("returns null for %s", (_label, value) => {
    expect(parseInvite(value)).toBeNull();
  });
});

describe("inviteBaseUrl", () => {
  it.each([
    ["the frontend root", VERIFY, "https://app.test"],
    [
      "a frontend under a base path",
      "https://app.test/kagura/app/device",
      "https://app.test/kagura/app",
    ],
    ["a trailing slash", "https://app.test/device/", "https://app.test"],
    ["plain HTTP on localhost", "http://localhost:3000/device", "http://localhost:3000"],
  ])("strips the final /device from %s", (_label, uri, base) => {
    expect(inviteBaseUrl(uri)).toBe(base);
  });

  it.each([
    ["a URI that does not end in /device", "https://app.test/activate"],
    ["a segment that only ends in 'device'", "https://app.test/mydevice"],
    ["plain HTTP off localhost", "http://app.test/device"],
    ["a non-web scheme", "ftp://app.test/device"],
    ["something that is not a URL", "device"],
  ])("returns null for %s", (_label, uri) => {
    expect(inviteBaseUrl(uri)).toBeNull();
  });
});

describe("buildInviteLink", () => {
  it("builds <base>/join/<token>?return_to=<device path and query>", () => {
    expect(buildInviteLink(VERIFY, COMPLETE, INVITE)).toBe(LINK);
  });

  it("places /join beside /device on a frontend under a base path", () => {
    expect(
      buildInviteLink(
        "https://app.test/kagura/app/device",
        "https://app.test/kagura/app/device?user_code=WDJB-MJHT",
        INVITE,
      ),
    ).toBe(
      `https://app.test/kagura/app/join/${INVITE}` +
        "?return_to=%2Fkagura%2Fapp%2Fdevice%3Fuser_code%3DWDJB-MJHT",
    );
  });

  it("round-trips return_to to exactly the path and query of the complete form", () => {
    const link = new URL(buildInviteLink(VERIFY, COMPLETE, INVITE)!);
    expect(link.searchParams.get("return_to")).toBe("/device?user_code=WDJB-MJHT");
  });

  it("uses the bare path when the complete form carries no query", () => {
    expect(buildInviteLink(VERIFY, VERIFY, INVITE)).toBe(
      `https://app.test/join/${INVITE}?return_to=%2Fdevice`,
    );
  });

  it.each([
    [
      "verificationUri does not end in /device",
      "https://app.test/activate",
      "https://app.test/activate?user_code=X",
    ],
    // The link carries the token: never over plaintext to a remote host.
    [
      "verificationUri is plain HTTP off localhost",
      "http://app.test/device",
      "http://app.test/device?user_code=X",
    ],
    ["the complete form is on another origin", VERIFY, "https://other.test/device?user_code=X"],
    ["the complete form is empty", VERIFY, ""],
  ])("returns null when %s", (_label, uri, complete) => {
    expect(buildInviteLink(uri, complete, INVITE)).toBeNull();
  });

  it("refuses a malformed token without quoting it", () => {
    const bad = "not-a-real-invite-but-close!";
    const caught = thrown(() => buildInviteLink(VERIFY, COMPLETE, bad));
    expect(caught).toBeInstanceOf(KaguraAuthError);
    expect((caught as Error).message).not.toContain(bad);
  });

  it("takes a token, not a link", () => {
    // A link is reduced to its token by parseInvite; handed here whole, it
    // would be interpolated into the path.
    const link = `https://app.test/join/${INVITE}`;
    const caught = thrown(() => buildInviteLink(VERIFY, COMPLETE, link));
    expect(caught).toBeInstanceOf(KaguraAuthError);
    expect((caught as Error).message).not.toContain(INVITE);
  });
});

describe("checkInviteOrigin", () => {
  it.each([
    ["a bare token", INVITE],
    ["a link on the frontend's origin", `https://app.test/join/${INVITE}`],
    ["a link under a base path on that origin", `https://app.test/kagura/join/${INVITE}`],
    ["a link spelling out the default port", `https://app.test:443/join/${INVITE}`],
  ])("passes %s", (_label, value) => {
    expect(() => checkInviteOrigin(parseInvite(value)!, VERIFY)).not.toThrow();
  });

  it.each([
    ["another host", `https://other.test/join/${INVITE}`, VERIFY],
    ["another port", `https://app.test:8443/join/${INVITE}`, VERIFY],
    ["another scheme", `http://localhost/join/${INVITE}`, "https://localhost/device"],
  ])("refuses a link on %s, naming both origins but never the token", (_label, value, uri) => {
    const invite = parseInvite(value)!;
    const caught = thrown(() => checkInviteOrigin(invite, uri));
    expect(caught).toBeInstanceOf(KaguraAuthError);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/different server/);
    expect(msg).toContain(invite.origin!);
    expect(msg).toContain(new URL(uri).origin);
    expect(msg).not.toContain(INVITE);
  });
});
