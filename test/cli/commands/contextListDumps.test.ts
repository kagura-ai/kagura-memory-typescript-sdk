/**
 * `context list` and `contexts` print what the Python CLI prints for the
 * same `list_contexts` reply (#89): each case below is a reply shaped as
 * memory-cloud v0.143.0 sends it (or as a server before v0.82.0 does,
 * without `has_more` / `next_cursor`), the arguments the Python CLI sent
 * for it, and its stdout, stderr and exit code — recorded from the Python
 * CLI 0.44.0 (click 8.3.3, pydantic 2.13.4) against a fake MCP server
 * sending these exact texts. stdout stays the reply's JSON; a cut page
 * adds one line on stderr naming `next_cursor` and the command for the
 * next page, the cursor itself only when it is ASCII digits, the only form
 * the server takes back; a blank `--cursor` is unset; and `--details
 * --limit 21` without a non-blank `--name-contains` is a usage error
 * before any request. A server that refuses an argument (here a
 * v0.82.0+ schema without `limit`) exits 1 with its message and `help`.
 */

import { describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { FakeServer, makeClient } from "../../fakeServer.js";

interface Case {
  name: string;
  argv: string[];
  /** Tool name → the exact `content[0].text` the fake server sends. */
  toolTexts: Record<string, string>;
  /** The arguments of each `tools/call` the Python CLI made. */
  calls: Record<string, unknown>[];
  code: number;
  stdout: string;
  stderr: string;
}

const CASES: Case[] = [
  {
    name: "context list cut page",
    argv: ["context","list","--limit","2"],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000000\", \"name\": \"ctx-0\", \"is_private\": true, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}, {\"id\": \"00000000-0000-4000-8000-000000000001\", \"name\": \"ctx-1\", \"is_private\": false, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 3, \"total\": 2, \"has_more\": true, \"next_cursor\": \"2\", \"limit\": 500, \"can_create\": true}"},
    calls: [{"limit":2}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000000\",\n      \"name\": \"ctx-0\",\n      \"is_private\": true,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    },\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000001\",\n      \"name\": \"ctx-1\",\n      \"is_private\": false,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 3,\n  \"total\": 2,\n  \"has_more\": true,\n  \"next_cursor\": \"2\",\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "has_more: true; next_cursor: \"2\". For the next page, run the command again with the same options and --cursor \"2\".\n",
  },
  {
    name: "context list last page",
    argv: ["context","list","--limit","2","--cursor","2"],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000002\", \"name\": \"ctx-2\", \"is_private\": true, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 3, \"total\": 1, \"has_more\": false, \"next_cursor\": null, \"limit\": 500, \"can_create\": true}"},
    calls: [{"cursor":"2","limit":2}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000002\",\n      \"name\": \"ctx-2\",\n      \"is_private\": true,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 3,\n  \"total\": 1,\n  \"has_more\": false,\n  \"next_cursor\": null,\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "",
  },
  {
    name: "context list only page",
    argv: ["context","list"],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000001\", \"name\": \"ctx-1\", \"is_private\": false, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 1, \"total\": 1, \"has_more\": false, \"next_cursor\": null, \"limit\": 500, \"can_create\": true}"},
    calls: [{}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000001\",\n      \"name\": \"ctx-1\",\n      \"is_private\": false,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 1,\n  \"total\": 1,\n  \"has_more\": false,\n  \"next_cursor\": null,\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "",
  },
  {
    name: "context list older server",
    argv: ["context","list"],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000001\", \"name\": \"ctx-1\", \"is_private\": false, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 1, \"total\": 1, \"limit\": 500, \"can_create\": true}"},
    calls: [{}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000001\",\n      \"name\": \"ctx-1\",\n      \"is_private\": false,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 1,\n  \"total\": 1,\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "",
  },
  {
    name: "context list filters with paging",
    argv: ["context","list","--name-contains","  ctx ","--details","--limit","50","--cursor","100"],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000001\", \"name\": \"ctx-1\", \"is_private\": false, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 1, \"total\": 1, \"has_more\": false, \"next_cursor\": null, \"limit\": 500, \"can_create\": true}"},
    calls: [{"name_contains":"ctx","include_details":true,"cursor":"100","limit":50}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000001\",\n      \"name\": \"ctx-1\",\n      \"is_private\": false,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 1,\n  \"total\": 1,\n  \"has_more\": false,\n  \"next_cursor\": null,\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "",
  },
  {
    name: "context list blank cursor",
    argv: ["context","list","--limit","2","--cursor","  "],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000000\", \"name\": \"ctx-0\", \"is_private\": true, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}, {\"id\": \"00000000-0000-4000-8000-000000000001\", \"name\": \"ctx-1\", \"is_private\": false, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 3, \"total\": 2, \"has_more\": true, \"next_cursor\": \"2\", \"limit\": 500, \"can_create\": true}"},
    calls: [{"limit":2}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000000\",\n      \"name\": \"ctx-0\",\n      \"is_private\": true,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    },\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000001\",\n      \"name\": \"ctx-1\",\n      \"is_private\": false,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 3,\n  \"total\": 2,\n  \"has_more\": true,\n  \"next_cursor\": \"2\",\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "has_more: true; next_cursor: \"2\". For the next page, run the command again with the same options and --cursor \"2\".\n",
  },
  {
    name: "context list empty cursor",
    argv: ["context","list","--cursor",""],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000001\", \"name\": \"ctx-1\", \"is_private\": false, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 1, \"total\": 1, \"has_more\": false, \"next_cursor\": null, \"limit\": 500, \"can_create\": true}"},
    calls: [{}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000001\",\n      \"name\": \"ctx-1\",\n      \"is_private\": false,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 1,\n  \"total\": 1,\n  \"has_more\": false,\n  \"next_cursor\": null,\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "",
  },
  {
    name: "context list non-digit next_cursor",
    argv: ["context","list","--limit","1"],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000000\", \"name\": \"ctx-0\", \"is_private\": true, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 3, \"total\": 1, \"has_more\": true, \"next_cursor\": \"1$(touch pwned)\", \"limit\": 500, \"can_create\": true}"},
    calls: [{"limit":1}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000000\",\n      \"name\": \"ctx-0\",\n      \"is_private\": true,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 3,\n  \"total\": 1,\n  \"has_more\": true,\n  \"next_cursor\": \"1$(touch pwned)\",\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "has_more: true. For the next page, run the command again with the same options and --cursor set to next_cursor from the JSON.\n",
  },
  {
    name: "context list has_more without cursor",
    argv: ["context","list","--limit","1"],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000000\", \"name\": \"ctx-0\", \"is_private\": true, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 3, \"total\": 1, \"has_more\": true, \"next_cursor\": null, \"limit\": 500, \"can_create\": true}"},
    calls: [{"limit":1}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000000\",\n      \"name\": \"ctx-0\",\n      \"is_private\": true,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 3,\n  \"total\": 1,\n  \"has_more\": true,\n  \"next_cursor\": null,\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "",
  },
  {
    name: "context list has_more not a boolean",
    argv: ["context","list","--limit","1"],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000000\", \"name\": \"ctx-0\", \"is_private\": true, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 3, \"total\": 1, \"has_more\": \"true\", \"next_cursor\": \"1\", \"limit\": 500, \"can_create\": true}"},
    calls: [{"limit":1}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000000\",\n      \"name\": \"ctx-0\",\n      \"is_private\": true,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 3,\n  \"total\": 1,\n  \"has_more\": \"true\",\n  \"next_cursor\": \"1\",\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "",
  },
  {
    name: "context list details limit 20",
    argv: ["context","list","--details","--limit","20"],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000001\", \"name\": \"ctx-1\", \"is_private\": false, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 1, \"total\": 1, \"has_more\": false, \"next_cursor\": null, \"limit\": 500, \"can_create\": true}"},
    calls: [{"include_details":true,"limit":20}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000001\",\n      \"name\": \"ctx-1\",\n      \"is_private\": false,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 1,\n  \"total\": 1,\n  \"has_more\": false,\n  \"next_cursor\": null,\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "",
  },
  {
    name: "context list details over 20",
    argv: ["context","list","--details","--limit","21"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: main context list [OPTIONS]\nTry 'main context list --help' for help.\n\nError: --details returns full summaries: pass --name-contains or --limit 20 or less (got 21).\n",
  },
  {
    name: "context list details blank filter over 20",
    argv: ["context","list","--details","--name-contains","   ","--limit","200"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: main context list [OPTIONS]\nTry 'main context list --help' for help.\n\nError: --details returns full summaries: pass --name-contains or --limit 20 or less (got 200).\n",
  },
  {
    name: "context list details filter 200",
    argv: ["context","list","--details","--name-contains","auth","--limit","200"],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000001\", \"name\": \"ctx-1\", \"is_private\": false, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 1, \"total\": 1, \"has_more\": false, \"next_cursor\": null, \"limit\": 500, \"can_create\": true}"},
    calls: [{"name_contains":"auth","include_details":true,"limit":200}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000001\",\n      \"name\": \"ctx-1\",\n      \"is_private\": false,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 1,\n  \"total\": 1,\n  \"has_more\": false,\n  \"next_cursor\": null,\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "",
  },
  {
    name: "context list limit 0",
    argv: ["context","list","--limit","0"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: main context list [OPTIONS]\nTry 'main context list --help' for help.\n\nError: Invalid value for '--limit': 0 is not in the range 1<=x<=200.\n",
  },
  {
    name: "context list limit 201",
    argv: ["context","list","--limit","201"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: main context list [OPTIONS]\nTry 'main context list --help' for help.\n\nError: Invalid value for '--limit': 201 is not in the range 1<=x<=200.\n",
  },
  {
    name: "context list limit not a number",
    argv: ["context","list","--limit","x"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: main context list [OPTIONS]\nTry 'main context list --help' for help.\n\nError: Invalid value for '--limit': 'x' is not a valid integer range.\n",
  },
  {
    name: "context list refused cursor",
    argv: ["context","list","--cursor","abc"],
    toolTexts: {"list_contexts": "{\"status\": \"error\", \"error\": \"validation_error\", \"message\": \"'cursor' must be the next_cursor of a previous list_contexts response.\", \"received\": \"abc\"}"},
    calls: [{"cursor":"abc"}],
    code: 1,
    stdout: "",
    stderr: "Error: list_contexts failed (validation_error): 'cursor' must be the next_cursor of a previous list_contexts response.\n",
  },
  {
    name: "context list refused limit",
    argv: ["context","list","--limit","50"],
    toolTexts: {"list_contexts": "{\"status\": \"error\", \"error\": \"invalid_argument\", \"message\": \"list_contexts does not accept the argument 'limit'. Arguments its inputSchema declares: cursor, include_details, include_stats, include_summary, name_contains.\", \"unknown_arguments\": [\"limit\"], \"allowed_arguments\": [\"cursor\", \"include_details\", \"include_stats\", \"include_summary\", \"name_contains\"], \"suggestions\": {}, \"help\": \"Remove the unknown arguments or rename them as suggested, then call the tool again. tools/list shows each tool's inputSchema.\"}"},
    calls: [{"limit":50}],
    code: 1,
    stdout: "",
    stderr: "Error: list_contexts failed (invalid_argument): list_contexts does not accept the argument 'limit'. Arguments its inputSchema declares: cursor, include_details, include_stats, include_summary, name_contains.\n  Help: Remove the unknown arguments or rename them as suggested, then call the tool again. tools/list shows each tool's inputSchema.\n",
  },
  {
    name: "contexts cut page",
    argv: ["contexts"],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000000\", \"name\": \"ctx-0\", \"is_private\": true, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}, {\"id\": \"00000000-0000-4000-8000-000000000001\", \"name\": \"ctx-1\", \"is_private\": false, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 101, \"total\": 2, \"has_more\": true, \"next_cursor\": \"100\", \"limit\": 500, \"can_create\": true}"},
    calls: [{}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000000\",\n      \"name\": \"ctx-0\",\n      \"is_private\": true,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    },\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000001\",\n      \"name\": \"ctx-1\",\n      \"is_private\": false,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 101,\n  \"total\": 2,\n  \"has_more\": true,\n  \"next_cursor\": \"100\",\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "has_more: true; next_cursor: \"100\". For the next page, run kagura context list --cursor \"100\".\n",
  },
  {
    name: "contexts only page",
    argv: ["contexts"],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000001\", \"name\": \"ctx-1\", \"is_private\": false, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 1, \"total\": 1, \"has_more\": false, \"next_cursor\": null, \"limit\": 500, \"can_create\": true}"},
    calls: [{}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000001\",\n      \"name\": \"ctx-1\",\n      \"is_private\": false,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 1,\n  \"total\": 1,\n  \"has_more\": false,\n  \"next_cursor\": null,\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "",
  },
  {
    name: "contexts non-digit next_cursor",
    argv: ["contexts"],
    toolTexts: {"list_contexts": "{\"status\": \"success\", \"contexts\": [{\"id\": \"00000000-0000-4000-8000-000000000000\", \"name\": \"ctx-0\", \"is_private\": true, \"is_locked\": false, \"last_used_at\": \"2026-11-01T00:00:00Z\"}], \"count\": 3, \"total\": 1, \"has_more\": true, \"next_cursor\": \"1$(touch pwned)\", \"limit\": 500, \"can_create\": true}"},
    calls: [{}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"contexts\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000000000\",\n      \"name\": \"ctx-0\",\n      \"is_private\": true,\n      \"is_locked\": false,\n      \"last_used_at\": \"2026-11-01T00:00:00Z\"\n    }\n  ],\n  \"count\": 3,\n  \"total\": 1,\n  \"has_more\": true,\n  \"next_cursor\": \"1$(touch pwned)\",\n  \"limit\": 500,\n  \"can_create\": true\n}\n",
    stderr: "has_more: true. For the next page, run kagura context list --cursor set to next_cursor from the JSON.\n",
  },
];

describe("context list / contexts output, byte for byte the Python CLI's (#89)", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const out: string[] = [];
    const err: string[] = [];
    const server = new FakeServer();
    Object.assign(server.toolTexts, c.toolTexts);
    const deps = {
      write: (line: string) => void out.push(line),
      writeError: (line: string) => void err.push(line),
      loadConfig: () => ({ api_key: "k" }),
      makeClient: (o: Record<string, unknown>) => makeClient(server, o),
    } as unknown as CliDeps;

    expect(await runCli(c.argv, deps)).toBe(c.code);
    expect(out.map((line) => `${line}
`).join("")).toBe(c.stdout);
    // A usage error: this bin prints click's `Error:` line without the
    // `Usage:` / `Try '… --help'` lines before it, as for every command.
    // The `contexts` hint names this bin's `context list`, `kagura-memory`
    // where the Python CLI's names `kagura`.
    const stderr = (c.code === 2 ? c.stderr.slice(c.stderr.indexOf("Error: ")) : c.stderr).replace(
      "run kagura context list",
      "run kagura-memory context list",
    );
    expect(err.map((line) => `${line}
`).join("")).toBe(stderr);
    const calls = server.requests.filter((r) => r.body?.method === "tools/call");
    expect(calls.map((r) => (r.body?.params as { arguments: unknown }).arguments)).toEqual(c.calls);
  });
});
