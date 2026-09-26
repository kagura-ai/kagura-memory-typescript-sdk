/**
 * `update-memory --details / --location / --merge-details` against the
 * Python CLI (python-sdk #247). Each case is an argv, the `reference` reply
 * the fake server sends (content[0].text, byte for byte), and the Python
 * CLI's tool calls, stdout, stderr and exit code for it, recorded from the
 * Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4) against a fake MCP
 * server sending these exact bytes, with KAGURA_CONTEXT_ID=ctx.
 *
 * A usage error (exit 2) is compared by its `Error:` line: click prints its
 * usage line and a `Try …` hint before it, and this bin its help after it
 * (README, "Command line"). `errorPrefix` marks a line whose tail is a JSON
 * parser's own words: Python's `json` module there, JavaScript's here.
 */

import { describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { FakeServer, makeClient } from "../../fakeServer.js";

interface Case {
  name: string;
  /** After `update-memory`. */
  argv: string[];
  /** content[0].text of the `reference` reply. */
  reference?: string;
  /** Every tools/call the Python CLI sent, in order, as [tool, arguments]. */
  calls: Array<[string, Record<string, unknown>]>;
  code: number;
  stdout: string;
  stderr: string;
  /** Compare the `Error:` line up to here only. */
  errorPrefix?: string;
}

const SUCCESS = '{\n  "status": "success"\n}\n';
const USAGE = "Usage: kagura update-memory [OPTIONS]\nTry 'kagura update-memory --help' for help.\n\n";

async function run(c: Case) {
  const out: string[] = [];
  const err: string[] = [];
  const server = new FakeServer();
  if (c.reference !== undefined) server.toolTexts.reference = c.reference;
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => true,
    openBrowser: async () => true,
    login: (async () => {
      throw new Error("not used");
    }) as unknown as CliDeps["login"],
    refresh: (async () => {
      throw new Error("not used");
    }) as unknown as CliDeps["refresh"],
    loadConfig: () => ({ context_id: "ctx", api_key: "k" }),
    makeClient: (options: Record<string, unknown>) => makeClient(server, options),
  } as unknown as CliDeps;
  const code = await runCli(["update-memory", ...c.argv], deps);
  const calls = server.requests
    .filter((r) => r.body?.method === "tools/call")
    .map((r) => {
      const params = r.body!.params as { name: string; arguments: Record<string, unknown> };
      return [params.name, params.arguments] as [string, Record<string, unknown>];
    });
  return { code, out, err, calls, server };
}

async function expectPython(c: Case): Promise<FakeServer> {
  const { code, out, err, calls, server } = await run(c);
  expect(calls).toEqual(c.calls);
  expect(code).toBe(c.code);
  expect(out.length > 0 ? `${out.join("\n")}\n` : "").toBe(c.stdout);
  const pyError = c.stderr.split("\n").find((l) => l.startsWith("Error: "));
  if (pyError === undefined) {
    expect(err).toEqual([]);
  } else if (c.errorPrefix !== undefined) {
    expect(pyError.startsWith(c.errorPrefix)).toBe(true);
    expect(err[0]?.startsWith(c.errorPrefix)).toBe(true);
  } else {
    expect(err[0]).toBe(pyError);
  }
  return server;
}

const DETAILS_CASES: Case[] = [
  {
    name: "a --details object is sent as details",
    argv: ["-m", "mem-1", "--details", '{"location": {"lat": 35.68, "lon": 139.76}, "client": "acme"}'],
    calls: [["update_memory", { context_id: "ctx", memory_id: "mem-1", details: { location: { lat: 35.68, lon: 139.76 }, client: "acme" } }]],
    code: 0,
    stdout: SUCCESS,
    stderr: "",
  },
  {
    name: "'{}' clears details",
    argv: ["-m", "mem-1", "--details", "{}"],
    calls: [["update_memory", { context_id: "ctx", memory_id: "mem-1", details: {} }]],
    code: 0,
    stdout: SUCCESS,
    stderr: "",
  },
  {
    name: "a blank --details is unset, so details are left alone",
    argv: ["-m", "mem-1", "-s", "x", "--details", "   "],
    calls: [["update_memory", { context_id: "ctx", memory_id: "mem-1", summary: "x" }]],
    code: 0,
    stdout: SUCCESS,
    stderr: "",
  },
  {
    name: "invalid JSON is a usage error",
    argv: ["-m", "mem-1", "--details", "{not json"],
    calls: [],
    code: 2,
    stdout: "",
    stderr: USAGE + "Error: Invalid JSON for --details: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)\n",
    errorPrefix: "Error: Invalid JSON for --details: ",
  },
  {
    name: "a JSON list is a usage error",
    argv: ["-m", "mem-1", "--details", "[1, 2]"],
    calls: [],
    code: 2,
    stdout: "",
    stderr: USAGE + "Error: --details must be a JSON object, got list. Example: --details '{\"location\": {\"lat\": 35.68, \"lon\": 139.76}}'\n",
  },
  {
    name: "--location beside a location key is a usage error",
    argv: ["-m", "mem-1", "--details", '{"location": {"lat": 1.0, "lon": 2.0}}', "--location", "35.68,139.76"],
    calls: [],
    code: 2,
    stdout: "",
    stderr: USAGE + "Error: --location conflicts with the 'location' key in --details. Use one or the other.\n",
  },
  {
    name: "--location with one number is a usage error",
    argv: ["-m", "mem-1", "--location", "35.68"],
    calls: [],
    code: 2,
    stdout: "",
    stderr: USAGE + "Error: --location must be 'lat,lon' or 'lat,lon,label', got '35.68'\n",
  },
  {
    name: "a bare --location replaces details with just the location",
    argv: ["-m", "mem-1", "--location", "35.68,139.76"],
    calls: [["update_memory", { context_id: "ctx", memory_id: "mem-1", details: { location: { lat: 35.68, lon: 139.76 } } }]],
    code: 0,
    stdout: SUCCESS,
    stderr: "",
  },
  {
    name: "--location with a label, spaces stripped",
    argv: ["-m", "mem-1", "--location", "35.68, 139.76, Tokyo HQ"],
    calls: [["update_memory", { context_id: "ctx", memory_id: "mem-1", details: { location: { lat: 35.68, lon: 139.76, label: "Tokyo HQ" } } }]],
    code: 0,
    stdout: SUCCESS,
    stderr: "",
  },
  {
    name: "the payload rides along on an --external-id upsert, with no read first",
    argv: ["--external-id", "ext-1", "-s", "sum", "--content", "c", "-t", "note", "--location", "35.68,139.76"],
    calls: [["update_memory", { context_id: "ctx", external_id: "ext-1", summary: "sum", content: "c", type: "note", details: { location: { lat: 35.68, lon: 139.76 } } }]],
    code: 0,
    stdout: SUCCESS,
    stderr: "",
  },
];

describe("update-memory --details / --location, as the Python CLI 0.42.0", () => {
  it.each(DETAILS_CASES.map((c) => [c.name, c] as const))("%s", async (_, c) => {
    await expectPython(c);
  });

  it("sends coordinates as JSON numbers, not strings", async () => {
    // The server 422s string-typed lat/lon by design.
    const { calls } = await run({ ...DETAILS_CASES[7]! });
    const details = calls[0]![1].details as { location: { lat: unknown; lon: unknown } };
    expect(typeof details.location.lat).toBe("number");
    expect(typeof details.location.lon).toBe("number");
  });
});
