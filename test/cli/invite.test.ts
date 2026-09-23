import { describe, expect, it } from "vitest";

import { FakeRest } from "../fakeServer.js";
import { MIN_INVITE_HANDOFF_VERSION, checkInviteSupport } from "../../src/cli/invite.js";

const SERVER = "https://api.test";

function serverReporting(body: unknown, status = 200): FakeRest {
  const rest = new FakeRest();
  rest.status = status;
  rest.body = typeof body === "string" ? body : JSON.stringify(body);
  return rest;
}

describe("checkInviteSupport (#44)", () => {
  it("pins the first memory-cloud release that ships the /join return_to hand-off", () => {
    expect(MIN_INVITE_HANDOFF_VERSION).toBe("0.76.0");
  });

  it("asks /api/v1/system/info without credentials", async () => {
    const rest = serverReporting({ version: "0.76.0", features: { beta_invites: true } });
    await checkInviteSupport(`${SERVER}/`, rest.fetch);

    expect(rest.requests).toHaveLength(1);
    expect(rest.requests[0]!.url).toBe(`${SERVER}/api/v1/system/info`);
    expect(rest.requests[0]!.method).toBe("GET");
    // The route takes none, and the invite is not the server's business
    // until the browser opens /join.
    expect(rest.requests[0]!.headers).not.toHaveProperty("authorization");
  });

  it.each(["0.76.0", "0.76.3", "0.80.0", "1.0.0"])(
    "offers the one link on a server reporting %s",
    async (version) => {
      const rest = serverReporting({ version, features: { beta_invites: true } });
      expect(await checkInviteSupport(SERVER, rest.fetch)).toBe("one-link");
    },
  );

  it.each([
    ["an older version", { version: "0.75.9", features: { beta_invites: true } }],
    ["an unparseable version", { version: "nightly", features: { beta_invites: true } }],
    ["no version", { features: { beta_invites: true } }],
  ])("falls back to two steps on %s", async (_label, body) => {
    const rest = serverReporting(body);
    expect(await checkInviteSupport(SERVER, rest.fetch)).toBe("two-step");
  });

  it.each([
    ["beta_invites: false", { version: "0.76.0", features: { beta_invites: false } }],
    ["no beta_invites key", { version: "0.76.0", features: { neural_memory: true } }],
    ["no features at all", { version: "0.76.0" }],
  ])("reports invites off for %s", async (_label, body) => {
    const rest = serverReporting(body);
    expect(await checkInviteSupport(SERVER, rest.fetch)).toBe("off");
  });

  it("falls back to two steps when the request fails", async () => {
    const rest = new FakeRest();
    rest.error = new TypeError("connect ECONNREFUSED");
    expect(await checkInviteSupport(SERVER, rest.fetch)).toBe("two-step");
  });

  it.each([
    ["an HTTP error", serverReporting({ detail: "boom" }, 503)],
    ["a body that is not JSON", serverReporting("<html>gateway</html>")],
    ["a JSON body that is not an object", serverReporting("[1, 2]")],
  ])("falls back to two steps on %s", async (_label, rest) => {
    expect(await checkInviteSupport(SERVER, rest.fetch)).toBe("two-step");
  });
});
