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

import { currentDetailsForMerge } from "../../../src/cli/commands/memory.js";
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

const BOUNDED = (size: string) =>
  `Error: --merge-details: the memory's current details could not be read in full${size}; the server ` +
  "bounds a reference reply and this CLI cannot page it yet. Send the complete object with --details " +
  "and without --merge-details (the MCP reference tool returns the whole object with max_chars up to " +
  "100000 or details_offset paging).\n";
const REFERENCE_CALL: [string, Record<string, unknown>] = ["reference", { context_id: "ctx", memory_id: "mem-1" }];
const MERGE_LOCATION = ["-m", "mem-1", "--location", "35.68,139.76", "--merge-details"];

const MERGE_CASES: Case[] = [
  {
    name: "--merge-details with --external-id exits 1 before any call",
    argv: ["--external-id", "ext-1", "--location", "35.68,139.76", "--merge-details"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: --merge-details requires --memory-id (not --external-id)\n",
  },
  {
    name: "the --external-id refusal comes before the --details parse",
    argv: ["--external-id", "ext", "--merge-details", "--details", "{bad"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: --merge-details requires --memory-id (not --external-id)\n",
  },
  {
    name: "--merge-details with no payload exits 1",
    argv: ["-m", "mem-1", "--merge-details"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: --merge-details needs --details or --location\n",
  },
  {
    name: "a blank --details is no payload",
    argv: ["-m", "mem-1", "--merge-details", "--details", "  "],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: --merge-details needs --details or --location\n",
  },
  {
    name: "the id check comes first",
    argv: ["--merge-details", "--location", "1,2"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: Either --memory-id or --external-id is required\n",
  },
  {
    name: "a bad --details is a usage error before the payload check",
    argv: ["-m", "mem-1", "--merge-details", "--details", "{bad"],
    calls: [],
    code: 2,
    stdout: "",
    stderr: USAGE + "Error: Invalid JSON for --details: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)\n",
    errorPrefix: "Error: Invalid JSON for --details: ",
  },
  {
    name: "a bad -i is click's usage error first",
    argv: ["-m", "mem-1", "--merge-details", "--location", "1,2", "-i", "abc"],
    calls: [],
    code: 2,
    stdout: "",
    stderr: USAGE + "Error: Invalid value for '--importance' / '-i': 'abc' is not a valid float.\n",
  },
  {
    name: "merges top-level keys over the current details; --dismiss-supersede-candidate rides along",
    argv: ["-m", "mem-1", "--location", "35.68,139.76,Tokyo HQ", "--details", '{"n": 2}', "--merge-details", "--dismiss-supersede-candidate"],
    reference: '{"status": "success", "memory": {"memory_id": "mem-1", "details": {"location": {"lat": 1.0, "lon": 2.0, "label": "old"}, "client": "acme", "n": 1}}}',
    calls: [
      REFERENCE_CALL,
      ["update_memory", { context_id: "ctx", memory_id: "mem-1", details: { location: { lat: 35.68, lon: 139.76, label: "Tokyo HQ" }, client: "acme", n: 2 }, dismiss_supersede_candidate: true }],
    ],
    code: 0,
    stdout: SUCCESS,
    stderr: "",
  },
  {
    name: "null details merge onto {}",
    argv: MERGE_LOCATION,
    reference: '{"status": "success", "memory": {"memory_id": "mem-1", "details": null}}',
    calls: [REFERENCE_CALL, ["update_memory", { context_id: "ctx", memory_id: "mem-1", details: { location: { lat: 35.68, lon: 139.76 } } }]],
    code: 0,
    stdout: SUCCESS,
    stderr: "",
  },
  {
    name: "an absent details key with no marker merges onto {}",
    argv: MERGE_LOCATION,
    reference: '{"status": "success", "memory": {"memory_id": "mem-1"}}',
    calls: [REFERENCE_CALL, ["update_memory", { context_id: "ctx", memory_id: "mem-1", details: { location: { lat: 35.68, lon: 139.76 } } }]],
    code: 0,
    stdout: SUCCESS,
    stderr: "",
  },
  {
    name: "--details '{}' re-sends the current details",
    argv: ["-m", "mem-1", "--details", "{}", "--merge-details"],
    reference: '{"status": "success", "memory": {"memory_id": "mem-1", "details": {"location": {"lat": 1.0, "lon": 2.0}, "client": "acme"}}}',
    calls: [REFERENCE_CALL, ["update_memory", { context_id: "ctx", memory_id: "mem-1", details: { location: { lat: 1.0, lon: 2.0 }, client: "acme" } }]],
    code: 0,
    stdout: SUCCESS,
    stderr: "",
  },
  {
    name: "a bounded reply that omitted details is refused, naming its size",
    argv: MERGE_LOCATION,
    reference: '{"status": "success", "memory": {"memory_id": "mem-1", "details_omitted": true, "details_total_chars": 24000, "details_next_offset": 0}}',
    calls: [REFERENCE_CALL],
    code: 1,
    stdout: "",
    stderr: BOUNDED(" (24000 characters)"),
  },
  {
    name: "a details_json page is refused",
    argv: MERGE_LOCATION,
    reference: '{"status": "success", "memory": {"memory_id": "mem-1", "details_json": "{\\"client\\": \\"ac", "details_offset": 0, "details_total_chars": 1000, "details_truncated": true, "details_next_offset": 14}}',
    calls: [REFERENCE_CALL],
    code: 1,
    stdout: "",
    stderr: BOUNDED(" (1000 characters)"),
  },
  {
    name: "a truthy non-bool details_omitted is refused",
    argv: MERGE_LOCATION,
    reference: '{"status": "success", "memory": {"memory_id": "mem-1", "details_omitted": 1, "details_total_chars": 100}}',
    calls: [REFERENCE_CALL],
    code: 1,
    stdout: "",
    stderr: BOUNDED(" (100 characters)"),
  },
  {
    name: "a size marker without the details key is refused",
    argv: MERGE_LOCATION,
    reference: '{"status": "success", "memory": {"memory_id": "mem-1", "details_total_chars": 100}}',
    calls: [REFERENCE_CALL],
    code: 1,
    stdout: "",
    stderr: BOUNDED(" (100 characters)"),
  },
  {
    name: "details_omitted wins over a details key, and no size leaves the count out",
    argv: MERGE_LOCATION,
    reference: '{"status": "success", "memory": {"memory_id": "mem-1", "details": null, "details_omitted": true}}',
    calls: [REFERENCE_CALL],
    code: 1,
    stdout: "",
    stderr: BOUNDED(""),
  },
  {
    name: "a details_json page wins over a details key",
    argv: MERGE_LOCATION,
    reference: '{"status": "success", "memory": {"memory_id": "mem-1", "details": null, "details_json": "{\\"client\\": \\"ac", "details_next_offset": 14}}',
    calls: [REFERENCE_CALL],
    code: 1,
    stdout: "",
    stderr: BOUNDED(""),
  },
  {
    name: "current details that are not an object are refused",
    argv: MERGE_LOCATION,
    reference: '{"status": "success", "memory": {"memory_id": "mem-1", "details": ["not", "an", "object"]}}',
    calls: [REFERENCE_CALL],
    code: 1,
    stdout: "",
    stderr: "Error: --merge-details: the memory's current details are not a JSON object\n",
  },
  {
    name: "a reply without a memory object is refused",
    argv: MERGE_LOCATION,
    reference: '{"status": "success"}',
    calls: [REFERENCE_CALL],
    code: 1,
    stdout: "",
    stderr: "Error: --merge-details: the reference reply carried no memory object\n",
  },
  {
    name: "a memory that is not an object is refused",
    argv: MERGE_LOCATION,
    reference: '{"status": "success", "memory": "mem-1"}',
    calls: [REFERENCE_CALL],
    code: 1,
    stdout: "",
    stderr: "Error: --merge-details: the reference reply carried no memory object\n",
  },
  {
    name: "a failed read fails the command and never writes",
    argv: MERGE_LOCATION,
    reference: '{"status": "error", "error": "memory_not_found", "message": "Memory not found or you don\'t have access: mem-1"}',
    calls: [REFERENCE_CALL],
    code: 1,
    stdout: "",
    stderr: "Error: reference: Memory not found or you don't have access: mem-1\n",
  },
  {
    name: "an empty --external-id= beside -m is sent, as Python tests it for truthiness",
    argv: ["-m", "mem-1", "--external-id=", "--merge-details", "--location", "1,2"],
    reference: '{"status": "success", "memory": {"memory_id": "mem-1", "details": null}}',
    calls: [REFERENCE_CALL, ["update_memory", { context_id: "ctx", memory_id: "mem-1", external_id: "", details: { location: { lat: 1.0, lon: 2.0 } } }]],
    code: 0,
    stdout: SUCCESS,
    stderr: "",
  },
];

describe("update-memory --merge-details, as the Python CLI 0.42.0", () => {
  it.each(MERGE_CASES.map((c) => [c.name, c] as const))("%s", async (_, c) => {
    await expectPython(c);
  });

  it("sends nothing at all when it refuses before the read", async () => {
    // Not even the MCP initialize: the checks come before a client is used.
    for (const c of MERGE_CASES.slice(0, 7)) {
      const server = await expectPython(c);
      expect(server.requests, c.name).toEqual([]);
    }
  });

  it("never writes after a read that is not JSON", async () => {
    const { code, err, calls } = await run({
      name: "transport",
      argv: MERGE_LOCATION,
      reference: "not json",
      calls: [],
      code: 1,
      stdout: "",
      stderr: "",
    });
    expect(code).toBe(1);
    expect(calls.map(([tool]) => tool)).toEqual(["reference"]);
    expect(err[0]).toMatch(/^Error: Invalid response format: /);
  });

  it("does not change the details it read", async () => {
    const current = { location: { lat: 1, lon: 2 }, n: 1 };
    const client = {
      reference: async () => ({ status: "success", memory: { memory_id: "mem-1", details: current } }),
    } as unknown as Parameters<typeof currentDetailsForMerge>[0];
    const read = await currentDetailsForMerge(client, "ctx", "mem-1");
    expect(read).toBe(current);
    expect(current).toEqual({ location: { lat: 1, lon: 2 }, n: 1 });
  });

  it("states the wholesale replace and the merge caveats in --help, as Python's does", async () => {
    const { code, out } = await run({ name: "help", argv: ["--help"], calls: [], code: 0, stdout: "", stderr: "" });
    expect(code).toBe(0);
    const text = out.join("\n").split(/\s+/).join(" ");
    // The four claims python-sdk's test_update_memory_help_states_wholesale_replace pins.
    expect(text).toContain("REPLACES the memory's details wholesale");
    expect(text).toContain("--merge-details");
    expect(text).toContain("top-level keys");
    expect(text).toContain("two calls, not one atomic update");
  });
});
