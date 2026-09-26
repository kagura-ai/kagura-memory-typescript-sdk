/**
 * The pieces of `setup … --url-form --oauth` that need no harness
 * (python-sdk #282). Expected sentences are recorded from the Python CLI
 * 0.42.0 (click 8.3.3, pydantic 2.13.4), run against a fake memory-cloud on
 * http://127.0.0.1:47701, with Python's wrapped lines joined by one space.
 * The refusal's last sentence is this bin's: it has no stdio entry to offer.
 */

import { describe, expect, it } from "vitest";

import { checkOauthServer, oauthLoginNote, shownVersion } from "../../../src/cli/commands/harnessOauth.js";

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

describe("oauthLoginNote (recorded from the Python CLI 0.42.0)", () => {
  const CODEX_STORE =
    'the OS keyring ("Codex MCP Credentials"; on Windows, its encrypted secrets store in ~/.codex), else in ' +
    "~/.codex/.credentials.json";

  it("codex, printed", () => {
    expect(oauthLoginNote("codex", "kagura-memory", false, CODEX_STORE)).toBe(
      "Once the table is in config.toml, sign in with `codex mcp login kagura-memory`. The sign-in redirects the browser to Codex's loopback callback on this host; when the browser cannot reach it (no browser here, or a remote host), add --no-browser: Codex then prints the URL and takes the callback URL pasted back. Codex keys the token on the entry's URL, so changing its ?guardrails= later (another --guardrails or --context-id) means signing in again. memory-cloud's consent screen shows the client name Codex sends, which nothing verifies: approve only a sign-in you started. Codex keeps the token in the OS keyring (\"Codex MCP Credentials\"; on Windows, its encrypted secrets store in ~/.codex), else in ~/.codex/.credentials.json; setup never sees it.",
    );
  });

  it("codex, run", () => {
    expect(oauthLoginNote("codex", "kagura-memory", true, CODEX_STORE)).toBe(
      "Codex signs in itself: `codex mcp add` above started its sign-in if it found OAuth on the server. If it did not log in, run `codex mcp login kagura-memory`. The sign-in redirects the browser to Codex's loopback callback on this host; when the browser cannot reach it (no browser here, or a remote host), add --no-browser: Codex then prints the URL and takes the callback URL pasted back. Codex keys the token on the entry's URL, so changing its ?guardrails= later (another --guardrails or --context-id) means signing in again. memory-cloud's consent screen shows the client name Codex sends, which nothing verifies: approve only a sign-in you started. Codex keeps the token in the OS keyring (\"Codex MCP Credentials\"; on Windows, its encrypted secrets store in ~/.codex), else in ~/.codex/.credentials.json; setup never sees it.",
    );
  });

  it("hermes, printed and run, naming the device flow (0.41.2)", () => {
    const store = "~/.hermes/mcp-tokens/kagura-memory.json";
    expect(oauthLoginNote("hermes", "kagura-memory", false, store)).toBe(
      "Once the entry is in config.yaml, sign in with `hermes mcp login kagura-memory` (the browser flow). The sign-in redirects the browser to Hermes's loopback callback on this host; when the browser cannot reach it (a remote host), paste the redirect URL at Hermes's prompt, or (memory-cloud 0.78.0+) run `hermes mcp login kagura-memory --flow device`, which signs in with a code at the server's /device page. memory-cloud's consent screen shows the client name Hermes Agent sends, which nothing verifies: approve only a sign-in you started. Hermes Agent keeps the token in ~/.hermes/mcp-tokens/kagura-memory.json; setup never sees it.",
    );
    expect(oauthLoginNote("hermes", "kagura-memory", true, store)).toBe(
      "Hermes signs in itself: `hermes mcp add` above started its sign-in when it probed the server, with --connect-timeout 315 (the bound `hermes mcp login` uses), which Hermes keeps as the entry's connect_timeout. If it did not log in, run `hermes mcp login kagura-memory` (the browser flow). The sign-in redirects the browser to Hermes's loopback callback on this host; when the browser cannot reach it (a remote host), paste the redirect URL at Hermes's prompt, or (memory-cloud 0.78.0+) run `hermes mcp login kagura-memory --flow device`, which signs in with a code at the server's /device page. memory-cloud's consent screen shows the client name Hermes Agent sends, which nothing verifies: approve only a sign-in you started. Hermes Agent keeps the token in ~/.hermes/mcp-tokens/kagura-memory.json; setup never sees it.",
    );
  });

  it("openclaw, run and printed", () => {
    const store = "its state database (~/.openclaw/state/openclaw.sqlite)";
    expect(oauthLoginNote("openclaw", "kagura-memory", true, store)).toBe(
      "Sign in with `openclaw mcp login kagura-memory`, then check it with the command below. The sign-in redirects the browser to OpenClaw's loopback callback on this host; when the browser cannot reach it (a remote host), `openclaw mcp login kagura-memory --code <code>` takes the code from the redirect. memory-cloud's consent screen shows the client name OpenClaw sends, which nothing verifies: approve only a sign-in you started. OpenClaw keeps the token in its state database (~/.openclaw/state/openclaw.sqlite); setup never sees it.",
    );
    expect(oauthLoginNote("openclaw", "kagura-memory", false, store)).toBe(
      "Once the entry is in openclaw.json, sign in with `openclaw mcp login kagura-memory`, then check it with the command below. The sign-in redirects the browser to OpenClaw's loopback callback on this host; when the browser cannot reach it (a remote host), `openclaw mcp login kagura-memory --code <code>` takes the code from the redirect. memory-cloud's consent screen shows the client name OpenClaw sends, which nothing verifies: approve only a sign-in you started. OpenClaw keeps the token in its state database (~/.openclaw/state/openclaw.sqlite); setup never sees it.",
    );
  });

  it("names the server name it was given", () => {
    expect(oauthLoginNote("openclaw", "km2", true, "x")).toContain("`openclaw mcp login km2 --code <code>`");
  });
});
