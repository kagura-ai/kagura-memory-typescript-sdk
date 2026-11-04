/**
 * `kagura-memory recall --verbosity / --full / --max-chars` and the one
 * retry after an `invalid_argument` refusal (#82; the Python CLI 0.43.0,
 * python-sdk #298).
 *
 * Each case in CASES is a sequence of server replies and the Python CLI's
 * stdout, stderr and exit code for it, recorded from the Python CLI 0.44.0
 * (click 8.3.3) against a fake MCP server sending these replies; `calls`
 * is the arguments object of each `tools/call recall` it sent. The replies
 * follow memory-cloud v0.143.0 (`utils/recall_projection.py`,
 * `mcp_server/tools/memory.py::_recall_envelope`; the first hit's content
 * is abridged). The two refusals are what `find_unknown_arguments` answers
 * for `recall(verbosity="full", full=0)` at v0.113.0 (`full` undeclared)
 * and at v0.107.0 (`full` and `verbosity` undeclared), generated from that
 * code.
 */

import { describe, expect, it } from "vitest";

import { refusedShapeArgs, unknownArguments } from "../../../src/cli/commands/memory.js";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import type { KaguraClient } from "../../../src/client.js";
import { KaguraError } from "../../../src/errors.js";
import { FakeServer, makeClient } from "../../fakeServer.js";

const CTX = "11111111-2222-4333-8444-555555555555";

interface PythonCase {
  name: string;
  argv: string[];
  /** The replies served, in order, by name in REPLIES. */
  replies: string[];
  /** The arguments of each `tools/call recall` the Python CLI sent. */
  calls: Array<Record<string, unknown>>;
  code: number;
  stdout: string;
  stderr: string;
}

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  server: FakeServer;
}

/**
 * The envelope fields #84 keeps on `KaguraError` — `code` (the envelope's
 * `error`) and `details` (the envelope without `status` / `error` /
 * `message`, as the Python SDK keeps it) — attached to a recall error
 * that does not carry them yet, so the retry runs through the real client
 * and wire. Once the client keeps the envelope itself, this does nothing.
 */
function keepEnvelope(client: KaguraClient, server: FakeServer): KaguraClient {
  const recall = client.recall.bind(client);
  client.recall = async (options) => {
    try {
      return await recall(options);
    } catch (e) {
      if (e instanceof KaguraError && !("details" in e)) {
        const { status: _status, error, message: _message, ...details } = server.toolResults
          .recall as Record<string, unknown>;
        Object.assign(e, { code: error, details });
      }
      throw e;
    }
  };
  return client;
}

/** A bin whose server answers each `tools/call recall` with the next of `replies`. */
function harness(replies: unknown[] = []): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const server = new FakeServer();
  const queue = [...replies];
  const serve = server.fetch;
  server.fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    if (body?.method === "tools/call" && (body.params as { name?: unknown }).name === "recall") {
      server.toolResults.recall = queue.shift() ?? { status: "success", results: [] };
    }
    return serve(input, init);
  };
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => true,
    loadConfig: () => ({ context_id: CTX, api_key: "k" }),
    makeClient: (options: Record<string, unknown>) => keepEnvelope(makeClient(server, options), server),
  } as unknown as CliDeps;
  return { deps, out, err, server };
}

/** The arguments of every `tools/call` the bin sent. */
function sentCalls(server: FakeServer): Array<Record<string, unknown>> {
  return server.requests
    .filter((r) => r.body?.method === "tools/call")
    .map((r) => (r.body!.params as { arguments: Record<string, unknown> }).arguments);
}

/** Lines as a stream holds them: each written line ends in a newline. */
function stream(lines: string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}

/**
 * Python's stderr as this bin prints it. A usage error prints only click's
 * `Error:` line here (the bin has no `Usage:` / `Try` preamble). Python
 * 0.43.0+ follows a server error with `  Help: <envelope help>` from
 * `KaguraError.help`, which this bin's error rendering does not print yet
 * (python-sdk #299, the error-envelope work in #84); either form passes.
 */
function pythonStderr(c: PythonCase): string[] {
  if (c.code === 2) return [stream([c.stderr.trimEnd().split("\n").at(-1)!])];
  return [c.stderr, c.stderr.replace(/^ {2}Help: .*\n/m, "")];
}

/** Server replies, shaped like memory-cloud v0.143.0's recall (see the file header). */
const REPLIES = {
  "COMPACT": {
    "confidence": {
      "level": "high",
      "top_score": 0.71,
      "prominence": 0.52,
      "relative_margin": 3.1,
      "result_count": 2,
      "rationale": "Top hit stands well above the candidate-pool background."
    },
    "status": "success",
    "results": [
      {
        "memory_id": "aaaaaaaa-0000-4000-8000-000000000001",
        "summary": "Deploy target moved to ap-northeast-1 after the latency review; the old us-east-1 stack stays a warm standby until the cut-over…",
        "summary_cut": true,
        "content": "The latency review showed p95 at 180 ms from Tokyo against 40 ms in-region (abridged).",
        "content_truncated": true,
        "content_next_offset": 1500,
        "type": "decision",
        "importance": 0.8,
        "score": 0.8123,
        "created_at": "2026-10-01T00:00:00Z",
        "updated_at": null,
        "observed_at": "2026-09-30",
        "supersede_candidate": {
          "memory_id": "aaaaaaaa-0000-4000-8000-000000000004",
          "summary": "Deploy target is us-east-1",
          "similarity": 0.93,
          "verified": true
        },
        "folded": {
          "count": 1,
          "memory_ids": [
            "aaaaaaaa-0000-4000-8000-000000000003"
          ]
        }
      },
      {
        "memory_id": "aaaaaaaa-0000-4000-8000-000000000002",
        "summary": "Runbook: rotate the deploy key",
        "type": "note",
        "importance": 0.5,
        "score": 0.61,
        "created_at": "2026-09-01T00:00:00Z",
        "updated_at": "2026-09-02T00:00:00Z",
        "contradicts": [
          "aaaaaaaa-0000-4000-8000-000000000003"
        ]
      }
    ],
    "count": 2,
    "context_id": "11111111-2222-4333-8444-555555555555",
    "context_name": "dev",
    "context_display_name": "Dev",
    "context_is_private": false,
    "context_is_locked": false,
    "related_tags": [
      {
        "tag": "deploy",
        "count": 2
      }
    ],
    "full_applied": 1
  },
  "FULL": {
    "confidence": {
      "level": "high",
      "top_score": 0.71,
      "prominence": 0.52,
      "relative_margin": 3.1,
      "result_count": 1,
      "rationale": "Top hit stands well above the candidate-pool background."
    },
    "status": "success",
    "results": [
      {
        "memory_id": "aaaaaaaa-0000-4000-8000-000000000001",
        "summary": "Deploy target moved to ap-northeast-1 after the latency review; the old us-east-1 stack stays a warm standby until the cut-over in March, when the DNS weights flip.",
        "type": "decision",
        "importance": 0.8,
        "scope": "persistent",
        "score": 0.8123,
        "created_at": "2026-10-01T00:00:00Z",
        "updated_at": null,
        "observed_at": "2026-09-30",
        "version": 3,
        "tags": [
          "deploy",
          "aws"
        ]
      }
    ],
    "count": 1,
    "selector": {
      "applied": false,
      "reason": "daily_cap"
    },
    "context_id": "11111111-2222-4333-8444-555555555555",
    "context_name": "dev",
    "context_display_name": "Dev",
    "context_is_private": false,
    "context_is_locked": false,
    "related_tags": [
      {
        "tag": "deploy",
        "count": 1
      }
    ],
    "context_summary_omitted": true,
    "truncated": true
  },
  "OLD_FULL": {
    "confidence": {
      "level": "high",
      "top_score": 0.71,
      "prominence": 0.52,
      "relative_margin": 3.1,
      "result_count": 1,
      "rationale": "Top hit stands well above the candidate-pool background."
    },
    "status": "success",
    "results": [
      {
        "memory_id": "aaaaaaaa-0000-4000-8000-000000000002",
        "summary": "Runbook: rotate the deploy key",
        "context_summary": "Ops runbook step for the quarterly key rotation.",
        "type": "note",
        "importance": 0.5,
        "scope": "persistent",
        "score": 0.61,
        "created_at": "2026-09-01T00:00:00Z",
        "updated_at": "2026-09-02T00:00:00Z",
        "tags": [
          "ops"
        ]
      }
    ],
    "count": 1,
    "context_id": "11111111-2222-4333-8444-555555555555",
    "context_name": "dev",
    "context_display_name": "Dev",
    "context_is_private": false,
    "context_is_locked": false,
    "related_tags": [
      {
        "tag": "ops",
        "count": 1
      }
    ]
  },
  "REFUSE_113": {
    "status": "error",
    "error": "invalid_argument",
    "message": "recall does not accept the argument 'full'. Arguments its inputSchema declares: context_id, context_ids, filters, include_explore_hints, include_superseded, k, max_chars, query, search_mode, use_rerank, verbosity.",
    "unknown_arguments": [
      "full"
    ],
    "allowed_arguments": [
      "context_id",
      "context_ids",
      "filters",
      "include_explore_hints",
      "include_superseded",
      "k",
      "max_chars",
      "query",
      "search_mode",
      "use_rerank",
      "verbosity"
    ],
    "suggestions": {},
    "help": "Remove the unknown arguments or rename them as suggested, then call the tool again. tools/list shows each tool's inputSchema."
  },
  "REFUSE_107": {
    "status": "error",
    "error": "invalid_argument",
    "message": "recall does not accept the arguments 'full', 'verbosity'. Arguments its inputSchema declares: context_id, context_ids, filters, include_explore_hints, include_superseded, k, max_chars, query, search_mode, use_rerank.",
    "unknown_arguments": [
      "full",
      "verbosity"
    ],
    "allowed_arguments": [
      "context_id",
      "context_ids",
      "filters",
      "include_explore_hints",
      "include_superseded",
      "k",
      "max_chars",
      "query",
      "search_mode",
      "use_rerank"
    ],
    "suggestions": {},
    "help": "Remove the unknown arguments or rename them as suggested, then call the tool again. tools/list shows each tool's inputSchema."
  }
} as const;

const CASES: PythonCase[] = [
  {
    name: "compact default",
    argv: ["recall", "deploy"],
    replies: ["COMPACT"],
    calls: [{"query": "deploy", "k": 5, "context_id": "11111111-2222-4333-8444-555555555555"}],
    code: 0,
    stdout: "{\n  \"confidence\": {\n    \"level\": \"high\",\n    \"top_score\": 0.71,\n    \"prominence\": 0.52,\n    \"relative_margin\": 3.1,\n    \"result_count\": 2,\n    \"rationale\": \"Top hit stands well above the candidate-pool background.\"\n  },\n  \"status\": \"success\",\n  \"results\": [\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n      \"summary\": \"Deploy target moved to ap-northeast-1 after the latency review; the old us-east-1 stack stays a warm standby until the cut-over…\",\n      \"summary_cut\": true,\n      \"content\": \"The latency review showed p95 at 180 ms from Tokyo against 40 ms in-region (abridged).\",\n      \"content_truncated\": true,\n      \"content_next_offset\": 1500,\n      \"type\": \"decision\",\n      \"importance\": 0.8,\n      \"score\": 0.8123,\n      \"created_at\": \"2026-10-01T00:00:00Z\",\n      \"updated_at\": null,\n      \"observed_at\": \"2026-09-30\",\n      \"supersede_candidate\": {\n        \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000004\",\n        \"summary\": \"Deploy target is us-east-1\",\n        \"similarity\": 0.93,\n        \"verified\": true\n      },\n      \"folded\": {\n        \"count\": 1,\n        \"memory_ids\": [\n          \"aaaaaaaa-0000-4000-8000-000000000003\"\n        ]\n      }\n    },\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\",\n      \"summary\": \"Runbook: rotate the deploy key\",\n      \"type\": \"note\",\n      \"importance\": 0.5,\n      \"score\": 0.61,\n      \"created_at\": \"2026-09-01T00:00:00Z\",\n      \"updated_at\": \"2026-09-02T00:00:00Z\",\n      \"contradicts\": [\n        \"aaaaaaaa-0000-4000-8000-000000000003\"\n      ]\n    }\n  ],\n  \"count\": 2,\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Dev\",\n  \"context_is_private\": false,\n  \"context_is_locked\": false,\n  \"related_tags\": [\n    {\n      \"tag\": \"deploy\",\n      \"count\": 2\n    }\n  ],\n  \"full_applied\": 1\n}\n",
    stderr: "",
  },
  {
    name: "full, summaries only, budget",
    argv: ["recall", "deploy", "--verbosity", "full", "--full", "0", "--max-chars", "10000"],
    replies: ["FULL"],
    calls: [{"query": "deploy", "k": 5, "context_id": "11111111-2222-4333-8444-555555555555", "verbosity": "full", "full": 0, "max_chars": 10000}],
    code: 0,
    stdout: "{\n  \"confidence\": {\n    \"level\": \"high\",\n    \"top_score\": 0.71,\n    \"prominence\": 0.52,\n    \"relative_margin\": 3.1,\n    \"result_count\": 1,\n    \"rationale\": \"Top hit stands well above the candidate-pool background.\"\n  },\n  \"status\": \"success\",\n  \"results\": [\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n      \"summary\": \"Deploy target moved to ap-northeast-1 after the latency review; the old us-east-1 stack stays a warm standby until the cut-over in March, when the DNS weights flip.\",\n      \"type\": \"decision\",\n      \"importance\": 0.8,\n      \"scope\": \"persistent\",\n      \"score\": 0.8123,\n      \"created_at\": \"2026-10-01T00:00:00Z\",\n      \"updated_at\": null,\n      \"observed_at\": \"2026-09-30\",\n      \"version\": 3,\n      \"tags\": [\n        \"deploy\",\n        \"aws\"\n      ]\n    }\n  ],\n  \"count\": 1,\n  \"selector\": {\n    \"applied\": false,\n    \"reason\": \"daily_cap\"\n  },\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Dev\",\n  \"context_is_private\": false,\n  \"context_is_locked\": false,\n  \"related_tags\": [\n    {\n      \"tag\": \"deploy\",\n      \"count\": 1\n    }\n  ],\n  \"context_summary_omitted\": true,\n  \"truncated\": true\n}\n",
    stderr: "",
  },
  {
    name: "0.108-0.113 refuses --full",
    argv: ["recall", "project context", "--trusted-only", "--verbosity", "full", "--full", "0"],
    replies: ["REFUSE_113", "OLD_FULL"],
    calls: [{"query": "project context", "k": 5, "context_id": "11111111-2222-4333-8444-555555555555", "filters": {"trust_tier": "trusted"}, "verbosity": "full", "full": 0}, {"query": "project context", "k": 5, "context_id": "11111111-2222-4333-8444-555555555555", "filters": {"trust_tier": "trusted"}, "verbosity": "full"}],
    code: 0,
    stdout: "{\n  \"confidence\": {\n    \"level\": \"high\",\n    \"top_score\": 0.71,\n    \"prominence\": 0.52,\n    \"relative_margin\": 3.1,\n    \"result_count\": 1,\n    \"rationale\": \"Top hit stands well above the candidate-pool background.\"\n  },\n  \"status\": \"success\",\n  \"results\": [\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\",\n      \"summary\": \"Runbook: rotate the deploy key\",\n      \"context_summary\": \"Ops runbook step for the quarterly key rotation.\",\n      \"type\": \"note\",\n      \"importance\": 0.5,\n      \"scope\": \"persistent\",\n      \"score\": 0.61,\n      \"created_at\": \"2026-09-01T00:00:00Z\",\n      \"updated_at\": \"2026-09-02T00:00:00Z\",\n      \"tags\": [\n        \"ops\"\n      ]\n    }\n  ],\n  \"count\": 1,\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Dev\",\n  \"context_is_private\": false,\n  \"context_is_locked\": false,\n  \"related_tags\": [\n    {\n      \"tag\": \"ops\",\n      \"count\": 1\n    }\n  ]\n}\n",
    stderr: "note: the server refused the recall (invalid_argument); retried without --full (--full needs memory-cloud 0.114.0+).\n",
  },
  {
    name: "0.82-0.107 refuses both",
    argv: ["recall", "project context", "--trusted-only", "--verbosity", "full", "--full", "0"],
    replies: ["REFUSE_107", "OLD_FULL"],
    calls: [{"query": "project context", "k": 5, "context_id": "11111111-2222-4333-8444-555555555555", "filters": {"trust_tier": "trusted"}, "verbosity": "full", "full": 0}, {"query": "project context", "k": 5, "context_id": "11111111-2222-4333-8444-555555555555", "filters": {"trust_tier": "trusted"}}],
    code: 0,
    stdout: "{\n  \"confidence\": {\n    \"level\": \"high\",\n    \"top_score\": 0.71,\n    \"prominence\": 0.52,\n    \"relative_margin\": 3.1,\n    \"result_count\": 1,\n    \"rationale\": \"Top hit stands well above the candidate-pool background.\"\n  },\n  \"status\": \"success\",\n  \"results\": [\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\",\n      \"summary\": \"Runbook: rotate the deploy key\",\n      \"context_summary\": \"Ops runbook step for the quarterly key rotation.\",\n      \"type\": \"note\",\n      \"importance\": 0.5,\n      \"scope\": \"persistent\",\n      \"score\": 0.61,\n      \"created_at\": \"2026-09-01T00:00:00Z\",\n      \"updated_at\": \"2026-09-02T00:00:00Z\",\n      \"tags\": [\n        \"ops\"\n      ]\n    }\n  ],\n  \"count\": 1,\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Dev\",\n  \"context_is_private\": false,\n  \"context_is_locked\": false,\n  \"related_tags\": [\n    {\n      \"tag\": \"ops\",\n      \"count\": 1\n    }\n  ]\n}\n",
    stderr: "note: the server refused the recall (invalid_argument); retried without --verbosity, --full (--verbosity needs memory-cloud 0.108.0+, --full needs memory-cloud 0.114.0+).\n",
  },
  {
    name: "retry refused again",
    argv: ["recall", "project context", "--full", "0", "--max-chars", "40000"],
    replies: ["REFUSE_113", "REFUSE_113"],
    calls: [{"query": "project context", "k": 5, "context_id": "11111111-2222-4333-8444-555555555555", "full": 0, "max_chars": 40000}, {"query": "project context", "k": 5, "context_id": "11111111-2222-4333-8444-555555555555", "max_chars": 40000}],
    code: 1,
    stdout: "",
    stderr: "note: the server refused the recall (invalid_argument); retried without --full (--full needs memory-cloud 0.114.0+).\nError: recall failed (invalid_argument): recall does not accept the argument 'full'. Arguments its inputSchema declares: context_id, context_ids, filters, include_explore_hints, include_superseded, k, max_chars, query, search_mode, use_rerank, verbosity.\n  Help: Remove the unknown arguments or rename them as suggested, then call the tool again. tools/list shows each tool's inputSchema.\n",
  },
  {
    name: "refusal of no sent flag",
    argv: ["recall", "project context", "--max-chars", "40000"],
    replies: ["REFUSE_113"],
    calls: [{"query": "project context", "k": 5, "context_id": "11111111-2222-4333-8444-555555555555", "max_chars": 40000}],
    code: 1,
    stdout: "",
    stderr: "Error: recall failed (invalid_argument): recall does not accept the argument 'full'. Arguments its inputSchema declares: context_id, context_ids, filters, include_explore_hints, include_superseded, k, max_chars, query, search_mode, use_rerank, verbosity.\n  Help: Remove the unknown arguments or rename them as suggested, then call the tool again. tools/list shows each tool's inputSchema.\n",
  },
  {
    name: "no shape flag sent",
    argv: ["recall", "project context"],
    replies: ["REFUSE_107"],
    calls: [{"query": "project context", "k": 5, "context_id": "11111111-2222-4333-8444-555555555555"}],
    code: 1,
    stdout: "",
    stderr: "Error: recall failed (invalid_argument): recall does not accept the arguments 'full', 'verbosity'. Arguments its inputSchema declares: context_id, context_ids, filters, include_explore_hints, include_superseded, k, max_chars, query, search_mode, use_rerank.\n  Help: Remove the unknown arguments or rename them as suggested, then call the tool again. tools/list shows each tool's inputSchema.\n",
  },
  {
    name: "bad verbosity",
    argv: ["recall", "q", "--verbosity", "verbose"],
    replies: [],
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura recall [OPTIONS] QUERY\nTry 'kagura recall --help' for help.\n\nError: Invalid value for '--verbosity': 'verbose' is not one of 'compact', 'full'.\n",
  },
  {
    name: "full too high",
    argv: ["recall", "q", "--full", "101"],
    replies: [],
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura recall [OPTIONS] QUERY\nTry 'kagura recall --help' for help.\n\nError: Invalid value for '--full': 101 is not in the range 0<=x<=100.\n",
  },
  {
    name: "full negative",
    argv: ["recall", "q", "--full", "-1"],
    replies: [],
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura recall [OPTIONS] QUERY\nTry 'kagura recall --help' for help.\n\nError: Invalid value for '--full': -1 is not in the range 0<=x<=100.\n",
  },
  {
    name: "full not int",
    argv: ["recall", "q", "--full", "abc"],
    replies: [],
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura recall [OPTIONS] QUERY\nTry 'kagura recall --help' for help.\n\nError: Invalid value for '--full': 'abc' is not a valid integer range.\n",
  },
  {
    name: "max-chars too low",
    argv: ["recall", "q", "--max-chars", "9999"],
    replies: [],
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura recall [OPTIONS] QUERY\nTry 'kagura recall --help' for help.\n\nError: Invalid value for '--max-chars': 9999 is not in the range 10000<=x<=100000.\n",
  },
  {
    name: "max-chars too high",
    argv: ["recall", "q", "--max-chars", "100001"],
    replies: [],
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura recall [OPTIONS] QUERY\nTry 'kagura recall --help' for help.\n\nError: Invalid value for '--max-chars': 100001 is not in the range 10000<=x<=100000.\n",
  },
];

describe("kagura-memory recall: the Python CLI 0.44.0's output", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const h = harness(c.replies.map((name) => REPLIES[name as keyof typeof REPLIES]));
    const code = await runCli(c.argv, h.deps);
    expect(code).toBe(c.code);
    expect(sentCalls(h.server)).toEqual(c.calls);
    expect(stream(h.out)).toBe(c.stdout);
    expect(pythonStderr(c)).toContain(stream(h.err));
  });
});

describe("kagura-memory recall --verbosity / --full / --max-chars", () => {
  it("sends none of them unless given", async () => {
    const h = harness();
    expect(await runCli(["recall", "q"], h.deps)).toBe(0);
    expect(sentCalls(h.server)).toEqual([{ query: "q", k: 5, context_id: CTX }]);
  });

  it.each([
    [["--verbosity", "compact", "--full", "100", "--max-chars", "100000"], { verbosity: "compact", full: 100, max_chars: 100_000 }],
    [["--verbosity", "full", "--full", "0", "--max-chars", "10000"], { verbosity: "full", full: 0, max_chars: 10_000 }],
    [["--full", "+3"], { full: 3 }],
  ])("%j reaches the wire as %j", async (flags, wire) => {
    const h = harness();
    expect(await runCli(["recall", "q", ...flags], h.deps)).toBe(0);
    expect(sentCalls(h.server)).toEqual([{ query: "q", k: 5, context_id: CTX, ...wire }]);
  });

  it("describes the three flags in the Python CLI's words", async () => {
    const h = harness();
    expect(await runCli(["recall", "--help"], h.deps)).toBe(0);
    const help = h.out.join("\n");
    const line = (flag: string) => help.split("\n").find((l) => l.trimStart().startsWith(`${flag} `)) ?? "";
    expect(line("--verbosity")).toContain(
      "--verbosity [compact|full]  Result detail (server v0.108.0+). compact, the server default: " +
        "160-character summaries without tags; full: uncut summaries, tags, context_summary and scope.",
    );
    expect(line("--full")).toContain(
      "How many top results carry content, up to 1,500 characters each " +
        "(server v0.114.0+; default: the server's, 3 unless set; 0: summaries only).",
    );
    expect(line("--max-chars")).toContain(
      "Response budget in characters, 10000-100000 (server v0.82.0+; default 20000).",
    );
    // The Python CLI's docstring paragraph, as click wraps it.
    expect(help).toContain(
      "  The reply is printed as JSON, with each hit's content (when the server sends\n" +
        "  it) right after its summary. --verbosity, --full and --max-chars are sent\n" +
        "  only when given. A server from v0.82.0 that predates one of them refuses it\n" +
        "  (invalid_argument); the command then retries once without the ones the\n" +
        "  server lists as refused (all three it sent when the reply does not list\n" +
        "  them) and says so on stderr.",
    );
  });
});

describe("kagura-memory recall: the retry after an invalid_argument refusal", () => {
  const REFUSED = REPLIES.REFUSE_113;
  const SHAPE = ["--trusted-only", "--verbosity", "full", "--full", "0"];

  it("drops every shape flag sent when the refusal lists none (no unknown_arguments)", async () => {
    const bare = { status: "error", error: "invalid_argument", message: "refused" };
    const h = harness([bare, REPLIES.OLD_FULL]);
    expect(await runCli(["recall", "q", ...SHAPE], h.deps)).toBe(0);
    const [first, second] = sentCalls(h.server);
    expect(first).toMatchObject({ verbosity: "full", full: 0 });
    expect(second).toEqual({ query: "q", k: 5, context_id: CTX, filters: { trust_tier: "trusted" } });
    expect(h.err).toEqual([
      "note: the server refused the recall (invalid_argument); retried without --verbosity, --full " +
        "(--verbosity needs memory-cloud 0.108.0+, --full needs memory-cloud 0.114.0+).",
    ]);
  });

  it.each([
    [["k"], "another argument"],
    [[], "an empty list"],
    [["verbosity"], "a flag that was not sent"],
  ])("does not retry a refusal listing %j (%s)", async (unknown) => {
    const h = harness([{ ...REFUSED, unknown_arguments: unknown }]);
    expect(await runCli(["recall", "q", "--full", "0"], h.deps)).toBe(1);
    expect(sentCalls(h.server)).toHaveLength(1);
    expect(h.err.join("\n")).not.toContain("note:");
  });

  it.each([
    ["another code", { ...REFUSED, error: "validation_error" }],
    ["a not-found", { status: "error", error: "context_not_found", message: "Context not found" }],
  ])("does not retry %s", async (_name, reply) => {
    const h = harness([reply]);
    expect(await runCli(["recall", "q", "--verbosity", "full"], h.deps)).toBe(1);
    expect(sentCalls(h.server)).toHaveLength(1);
    expect(h.err.join("\n")).not.toContain("note:");
  });

  it("does not retry an error that is not a KaguraError", async () => {
    const h = harness();
    let calls = 0;
    const deps = {
      ...h.deps,
      makeClient: (options: Record<string, unknown>) => {
        const client = makeClient(h.server, options);
        client.recall = async () => {
          calls += 1;
          throw Object.assign(new Error("boom"), { code: "invalid_argument" });
        };
        return client;
      },
    } as unknown as CliDeps;
    expect(await runCli(["recall", "q", "--full", "0"], deps)).toBe(1);
    expect(calls).toBe(1);
    expect(h.err.join("\n")).not.toContain("note:");
  });
});

describe("refusedShapeArgs / unknownArguments", () => {
  const refusal = (fields: Record<string, unknown>) => Object.assign(new KaguraError("recall failed"), fields);
  const SENT = ["verbosity", "full"];

  it("drops only what the refusal lists, in the order sent", () => {
    const err = refusal({ code: "invalid_argument", details: { unknown_arguments: ["full", "verbosity"] } });
    expect(refusedShapeArgs(err, SENT)).toEqual(["verbosity", "full"]);
    expect(refusedShapeArgs(refusal({ code: "invalid_argument", details: { unknown_arguments: ["full"] } }), SENT)).toEqual([
      "full",
    ]);
  });

  it("drops everything sent when the refusal has no readable list", () => {
    for (const details of [undefined, {}, { unknown_arguments: "full" }, ["full"], null]) {
      expect(refusedShapeArgs(refusal({ code: "invalid_argument", details }), SENT)).toEqual(SENT);
    }
  });

  it("is empty for any other code, or none", () => {
    const listed = { details: { unknown_arguments: SENT } };
    expect(refusedShapeArgs(refusal({ code: "validation_error", ...listed }), SENT)).toEqual([]);
    expect(refusedShapeArgs(refusal(listed), SENT)).toEqual([]);
    expect(refusedShapeArgs(new KaguraError("recall failed (invalid_argument): x"), SENT)).toEqual([]);
    expect(refusedShapeArgs(null, SENT)).toEqual([]);
  });

  it("reads only the string names of unknown_arguments", () => {
    expect(unknownArguments({ details: { unknown_arguments: ["full", 3, null, "verbosity"] } })).toEqual([
      "full",
      "verbosity",
    ]);
    expect(unknownArguments({ details: { allowed_arguments: ["k"] } })).toBeUndefined();
    expect(unknownArguments(undefined)).toBeUndefined();
  });
});
