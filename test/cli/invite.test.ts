import { describe, expect, it } from "vitest";

import { FakeRest } from "../fakeServer.js";
import {
  INVITE_PROBE_TIMEOUT_MS,
  MIN_INVITE_HANDOFF_VERSION,
  checkInviteSupport,
  fetchSystemInfo,
  inviteSupport,
  parseVersionPrefix,
} from "../../src/cli/invite.js";

const SERVER = "https://api.test";

function serverReporting(body: unknown, status = 200): FakeRest {
  const rest = new FakeRest();
  rest.status = status;
  rest.body = typeof body === "string" ? body : JSON.stringify(body);
  return rest;
}

/** A /system/info body as memory-cloud writes it; `flag` is its beta_invites entry. */
function systemInfo(
  version: unknown,
  flag: { beta_invites?: unknown } = { beta_invites: true },
): Record<string, unknown> {
  return { name: "Kagura Memory Cloud", version, features: { neural_memory: false, ...flag } };
}

describe("parseVersionPrefix (#44)", () => {
  it.each([
    ["0.76.0", [0, 76, 0]],
    ["v0.76.0", [0, 76, 0]],
    ["0.75.12", [0, 75, 12]],
    ["0.76.0+build.7", [0, 76, 0]],
    ["0.76.0-rc.1", [0, 76, 0]],
    ["0.76", null],
    ["main-abc123", null],
    ["", null],
  ])("reads %j as %j", (version, parsed) => {
    expect(parseVersionPrefix(version)).toEqual(parsed);
  });
});

describe("inviteSupport (#44)", () => {
  it("pins the first memory-cloud release that ships the /join return_to hand-off", () => {
    expect(MIN_INVITE_HANDOFF_VERSION).toBe("0.76.0");
  });

  it.each(["0.76.0", "v0.76.0", "0.76.1", "0.77.3", "v1.0.0", "0.76.0+build.7"])(
    "hands off from 0.76.0 (%s)",
    (version) => {
      expect(inviteSupport(systemInfo(version))).toBe("hand_off");
    },
  );

  it.each(["0.75.0", "0.75.9", "v0.75.1", "0.70.0", "0.9.99"])(
    "takes two steps before 0.76.0 (%s)",
    (version) => {
      expect(inviteSupport(systemInfo(version))).toBe("two_step");
    },
  );

  it.each([[""], ["dev"], ["0.76"], ["latest"], [null], [76], [undefined]])(
    "takes two steps on an unparseable version (%j)",
    (version) => {
      expect(inviteSupport(systemInfo(version))).toBe("two_step");
    },
  );

  it("takes two steps with no info", () => {
    expect(inviteSupport(null)).toBe("two_step");
  });

  it.each([
    ["false", { beta_invites: false }],
    // memory-cloud reads a missing flag as off, and a server older than the
    // flag (before v0.70.0) has no /join route at all.
    ["missing", {}],
    ["the string 'true'", { beta_invites: "true" }],
    ["1", { beta_invites: 1 }],
    ["an object", { beta_invites: {} }],
  ])("is disabled when beta_invites is %s", (_label, flag) => {
    expect(inviteSupport(systemInfo("0.76.0", flag))).toBe("disabled");
  });

  it.each([
    // No features object says nothing about invites: the version decides.
    ["no features key", { version: "0.76.0" }, "hand_off"],
    ["features that is a string", { version: "0.76.0", features: "weird" }, "hand_off"],
    ["features that is an array", { version: "0.76.0", features: [] }, "hand_off"],
    ["features that is null", { version: "0.75.0", features: null }, "two_step"],
  ])("lets the version decide with %s", (_label, info, support) => {
    expect(inviteSupport(info)).toBe(support);
  });
});

describe("fetchSystemInfo (#44)", () => {
  it("returns the raw body of /api/v1/system/info, asked without credentials", async () => {
    const info = systemInfo("0.75.0", { beta_invites: false });
    const rest = serverReporting(info);
    expect(await fetchSystemInfo(`${SERVER}/`, rest.fetch)).toEqual(info);

    expect(rest.requests).toHaveLength(1);
    expect(rest.requests[0]!.url).toBe(`${SERVER}/api/v1/system/info`);
    expect(rest.requests[0]!.method).toBe("GET");
    // The route takes none, and the invite is not the server's business
    // until the browser opens /join.
    expect(rest.requests[0]!.headers).not.toHaveProperty("authorization");
  });

  it("gives up after 5 s: the device code is already ticking", async () => {
    // The Python CLI's timeout.
    expect(INVITE_PROBE_TIMEOUT_MS).toBe(5_000);
    let signal: AbortSignal | null | undefined;
    const spy = (async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Response(JSON.stringify(systemInfo("0.76.0")), { status: 200 });
    }) as typeof globalThis.fetch;
    await fetchSystemInfo(SERVER, spy);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null when the request fails", async () => {
    const rest = new FakeRest();
    rest.error = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(await fetchSystemInfo(SERVER, rest.fetch)).toBeNull();
  });

  it.each([
    ["a 404", serverReporting({ detail: "Not Found" }, 404)],
    ["a 503", serverReporting({ detail: "boom" }, 503)],
    ["a success other than 200", serverReporting(systemInfo("0.76.0"), 203)],
    ["a body that is not JSON", serverReporting("<html>gateway</html>")],
    ["a JSON body that is not an object", serverReporting("[1, 2]")],
    ["an empty object", serverReporting({})],
  ])("returns null on %s", async (_label, rest) => {
    expect(await fetchSystemInfo(SERVER, rest.fetch)).toBeNull();
  });
});

describe("checkInviteSupport (#44)", () => {
  it("reads the server's answer", async () => {
    const rest = serverReporting(systemInfo("0.76.0"));
    expect(await checkInviteSupport(SERVER, rest.fetch)).toBe("hand_off");
  });

  it("takes two steps when the server cannot say", async () => {
    const rest = new FakeRest();
    rest.error = new TypeError("connect ECONNREFUSED");
    expect(await checkInviteSupport(SERVER, rest.fetch)).toBe("two_step");
    expect(await checkInviteSupport(SERVER, serverReporting({}).fetch)).toBe("two_step");
  });
});
