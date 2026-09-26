/**
 * The pieces of `setup … --url-form --oauth` that need no harness
 * (python-sdk #282). Expected sentences are recorded from the Python CLI
 * 0.42.0 (click 8.3.3, pydantic 2.13.4), run against a fake memory-cloud on
 * http://127.0.0.1:47701, with Python's wrapped lines joined by one space.
 * The refusal's last sentence is this bin's: it has no stdio entry to offer.
 */

import { describe, expect, it } from "vitest";

import { checkOauthServer, shownVersion } from "../../../src/cli/commands/harnessOauth.js";

const D = "http://127.0.0.1:47701";

/** A fake `/api/v1/system/info`: the body it sends, or a status, or a network error. */
function infoServer(answer: { body?: unknown; status?: number; error?: boolean }) {
  const requests: { url: string; headers: Record<string, string>; init?: RequestInit }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    requests.push({ url: String(input), headers, init });
    if (answer.error) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
  };
  return { requests, fetch };
}

const refused = (why: string, title = "Codex") =>
  `Nothing was written: --oauth needs memory-cloud 0.77.0+, and ${why}. Before 0.77.0, dynamic client ` +
  `registration rejects ${title}'s own client (memory-cloud#1657). Use --url-form with an API key instead (no --oauth).`;
const unconfirmed = `setup could not confirm the version of ${D} (GET /api/v1/system/info did not answer 200 with a JSON object)`;

describe("shownVersion", () => {
  it.each<[unknown, string]>([
    ["0.76.0", "0.76.0"],
    ["9".repeat(64), "9".repeat(64)],
    ["9".repeat(65), "'999999999999...9999999999999'"],
    ["0.76.0\u001b[2J", "'0.76.0\\x1b[2J'"],
    [76, "76"],
    [null, "None"],
  ])("%j -> %s, as Python's _shown_version", (version, expected) => {
    expect(shownVersion(version)).toBe(expected);
  });
});

describe("checkOauthServer", () => {
  it("passes 0.77.0 with Python's note, after one unauthenticated GET of the deployment's system info", async () => {
    const server = infoServer({ body: { name: "Kagura Memory Cloud", features: {}, version: "0.77.0" } });
    expect(await checkOauthServer({ title: "Codex", deployment: D, fetch: server.fetch })).toBe(
      `${D} runs memory-cloud 0.77.0, which accepts Codex's own client registration (0.77.0+).`,
    );
    expect(server.requests.map((r) => r.url)).toEqual([`${D}/api/v1/system/info`]);
    expect(Object.keys(server.requests[0]!.headers)).not.toContain("authorization");
    // Python's httpx client does not follow redirects, so the answer read
    // is the deployment's own, never the one a Location header points at.
    expect(server.requests[0]!.init?.redirect).toBe("manual");
  });

  it("passes a later release written as the server writes it", async () => {
    const server = infoServer({ body: { version: "v0.78.1+build.3" } });
    expect(await checkOauthServer({ title: "Hermes Agent", deployment: D, fetch: server.fetch })).toBe(
      `${D} runs memory-cloud v0.78.1+build.3, which accepts Hermes Agent's own client registration (0.77.0+).`,
    );
  });

  it.each<[string, { body?: unknown; status?: number; error?: boolean }, string]>([
    ["0.76.0", { body: { version: "0.76.0" } }, `${D} runs memory-cloud 0.76.0`],
    ["a pre-release of 0.77.0", { body: { version: "0.77.0-rc1" } }, `${D} runs memory-cloud 0.77.0-rc1`],
    ["terminal escapes", { body: { version: "0.76.0\u001b[2J" } }, `${D} runs memory-cloud '0.76.0\\x1b[2J'`],
    [
      "an unparseable version",
      { body: { version: "main-abc123" } },
      `setup could not confirm the version of ${D} (/api/v1/system/info reports main-abc123)`,
    ],
    [
      "no version",
      { body: { name: "K", features: {} } },
      `setup could not confirm the version of ${D} (/api/v1/system/info reports no version)`,
    ],
    [
      "a version that is not a string",
      { body: { version: 76 } },
      `setup could not confirm the version of ${D} (/api/v1/system/info reports 76)`,
    ],
    ["a 500", { status: 500 }, unconfirmed],
    ["a 302", { status: 302 }, unconfirmed],
    ["an empty object", { body: {} }, unconfirmed],
    ["a JSON array", { body: [1] }, unconfirmed],
    ["no answer", { error: true }, unconfirmed],
  ])("refuses %s in Python's words", async (_name, answer, why) => {
    const server = infoServer(answer);
    await expect(checkOauthServer({ title: "Codex", deployment: D, fetch: server.fetch })).rejects.toThrow(
      refused(why),
    );
    expect(server.requests).toHaveLength(1);
  });

  it("names the harness", async () => {
    const server = infoServer({ body: { version: "0.76.0" } });
    await expect(checkOauthServer({ title: "OpenClaw", deployment: D, fetch: server.fetch })).rejects.toThrow(
      refused(`${D} runs memory-cloud 0.76.0`, "OpenClaw"),
    );
  });
});
