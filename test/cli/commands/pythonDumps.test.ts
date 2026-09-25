/**
 * The resource and files commands print what the Python CLI prints for the
 * same server response (#66): each case below is a response and the
 * Python CLI's stdout, stderr and exit code for it, recorded from the
 * Python CLI 0.41.0 (click 8.3.3, pydantic 2.13.4) against a fake server
 * sending these exact bytes. They include responses with keys the model
 * does not have, responses without its optional keys, lax values (`"6"`
 * for an int, `12.0` for a float), and ones the model refuses.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedAuth } from "../../../src/auth/types.js";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { FilesClient } from "../../../src/filesClient.js";
import { ResourceClient } from "../../../src/resourceClient.js";
import { restClientFromAuth } from "../../../src/restBase.js";

interface Case {
  name: string;
  argv: string[];
  /** Files the command reads, by the name `argv` gives them. */
  files?: Record<string, string>;
  /** `METHOD /path` → the status and the exact body sent. */
  routes: Record<string, { status: number; raw: string }>;
  code: number;
  stdout: string;
  stderr: string;
}

const CASES: Case[] = [
  {
    name: "tokens list extra keys + missing optionals + lax values",
    argv: ["resource","tokens","list","-r","products","-l","2"],
    routes: {"GET /api/v1/resource-tokens":{"status":200,"raw":"{\"offset\": \"0\", \"tokens\": [{\"status\": \"active\", \"id\": \"6\", \"extra\": [1, 2], \"resource_id\": \"products\", \"quota_events_per_hour\": 1000, \"created_at\": \"2026-06-01T00:00:00Z\", \"is_active\": 1, \"token_hash\": \"zzz\"}], \"total\": 1, \"limit\": 2, \"next\": null}"}},
    code: 0,
    stdout: "{\n  \"tokens\": [\n    {\n      \"id\": 6,\n      \"resource_id\": \"products\",\n      \"description\": null,\n      \"quota_events_per_hour\": 1000,\n      \"created_by\": null,\n      \"created_at\": \"2026-06-01T00:00:00Z\",\n      \"last_used_at\": null,\n      \"is_active\": true,\n      \"status\": \"active\"\n    }\n  ],\n  \"total\": 1,\n  \"limit\": 2,\n  \"offset\": 0\n}\n",
    stderr: "",
  },
  {
    name: "tokens create",
    argv: ["resource","tokens","create","-r","products","-d","Sync"],
    routes: {"POST /api/v1/resource-tokens":{"status":201,"raw":"{\"id\": 7, \"resource_id\": \"products\", \"description\": \"Sync\", \"quota_events_per_hour\": 1000, \"created_by\": null, \"created_at\": \"2026-06-01T00:00:00.5Z\", \"last_used_at\": null, \"is_active\": true, \"status\": \"active\", \"token\": \"kagura_rt_secret\", \"extra\": 1}"}},
    code: 0,
    stdout: "{\n  \"id\": 7,\n  \"resource_id\": \"products\",\n  \"description\": \"Sync\",\n  \"quota_events_per_hour\": 1000,\n  \"created_by\": null,\n  \"created_at\": \"2026-06-01T00:00:00.500000Z\",\n  \"last_used_at\": null,\n  \"is_active\": true,\n  \"status\": \"active\",\n  \"token\": \"kagura_rt_secret\"\n}\n",
    stderr: "",
  },
  {
    name: "resource list",
    argv: ["resource","list"],
    routes: {"GET /api/v1/resources":{"status":200,"raw":"{\"resources\": [{\"resource_id\": \"products\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"products\", \"context_display_name\": null, \"token_count\": 2, \"memory_count\": 120, \"current_schema_version\": 3, \"created_at\": \"2026-06-01T00:00:00Z\", \"updated_at\": \"2026-06-05T00:00:00.000001Z\"}, {\"resource_id\": \"b\", \"context_id\": \"c\", \"context_name\": \"b\", \"token_count\": 0, \"memory_count\": 0, \"created_at\": \"2026-06-01T00:00:00Z\", \"updated_at\": \"2026-06-01T00:00:00Z\", \"last_event_at\": \"x\"}], \"total\": 2}"}},
    code: 0,
    stdout: "{\n  \"resources\": [\n    {\n      \"resource_id\": \"products\",\n      \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n      \"context_name\": \"products\",\n      \"context_display_name\": null,\n      \"token_count\": 2,\n      \"memory_count\": 120,\n      \"current_schema_version\": 3,\n      \"created_at\": \"2026-06-01T00:00:00Z\",\n      \"updated_at\": \"2026-06-05T00:00:00.000001Z\"\n    },\n    {\n      \"resource_id\": \"b\",\n      \"context_id\": \"c\",\n      \"context_name\": \"b\",\n      \"context_display_name\": null,\n      \"token_count\": 0,\n      \"memory_count\": 0,\n      \"current_schema_version\": null,\n      \"created_at\": \"2026-06-01T00:00:00Z\",\n      \"updated_at\": \"2026-06-01T00:00:00Z\"\n    }\n  ],\n  \"total\": 2\n}\n",
    stderr: "",
  },
  {
    name: "stats missing optional",
    argv: ["resource","stats","-r","products"],
    routes: {"GET /api/v1/resources/products/impact":{"status":200,"raw":"{\"memory_count\": \"7\", \"resource_id\": \"products\", \"token_count\": 2.0}"}},
    code: 0,
    stdout: "{\n  \"resource_id\": \"products\",\n  \"token_count\": 2,\n  \"memory_count\": 7,\n  \"current_schema_version\": null\n}\n",
    stderr: "",
  },
  {
    name: "indexer-status full, whole float lag",
    argv: ["resource","indexer-status","-r","products"],
    routes: {"GET /api/v1/resources/products/indexer-status":{"status":200,"raw":"{\"resource_id\": \"products\", \"state\": {\"job_status\": \"running\", \"last_run_at\": \"2026-06-01T00:00:00.123456Z\", \"next_run_at\": null, \"active_version\": 3, \"last_offset\": 1200, \"lag_seconds\": 12.0, \"metrics\": {\"applied_upserts\": 5, \"applied_deletes\": 0, \"errors\": 0, \"skipped_reason\": null, \"extra\": 1}}, \"recent_events\": [{\"id\": 9, \"op\": \"upsert\", \"doc_id\": \"SKU-1\", \"version\": 2, \"created_at\": \"2026-06-01T00:00:00Z\", \"payload\": {\"x\": 1}}]}"}},
    code: 0,
    stdout: "{\n  \"resource_id\": \"products\",\n  \"state\": {\n    \"job_status\": \"running\",\n    \"last_run_at\": \"2026-06-01T00:00:00.123456Z\",\n    \"next_run_at\": null,\n    \"active_version\": 3,\n    \"last_offset\": 1200,\n    \"lag_seconds\": 12.0,\n    \"metrics\": {\n      \"applied_upserts\": 5,\n      \"applied_deletes\": 0,\n      \"errors\": 0,\n      \"skipped_reason\": null\n    }\n  },\n  \"recent_events\": [\n    {\n      \"id\": 9,\n      \"op\": \"upsert\",\n      \"doc_id\": \"SKU-1\",\n      \"version\": 2,\n      \"created_at\": \"2026-06-01T00:00:00Z\"\n    }\n  ]\n}\n",
    stderr: "",
  },
  {
    name: "indexer-status fractional lag, partial metrics",
    argv: ["resource","indexer-status","-r","products"],
    routes: {"GET /api/v1/resources/products/indexer-status":{"status":200,"raw":"{\"resource_id\": \"products\", \"state\": {\"job_status\": \"a-new-status\", \"active_version\": 1, \"last_offset\": 0, \"lag_seconds\": 0.000001, \"metrics\": {\"skipped_reason\": \"memories_per_day_exceeded\"}}}"}},
    code: 0,
    stdout: "{\n  \"resource_id\": \"products\",\n  \"state\": {\n    \"job_status\": \"a-new-status\",\n    \"last_run_at\": null,\n    \"next_run_at\": null,\n    \"active_version\": 1,\n    \"last_offset\": 0,\n    \"lag_seconds\": 1e-6,\n    \"metrics\": {\n      \"applied_upserts\": 0,\n      \"applied_deletes\": 0,\n      \"errors\": 0,\n      \"skipped_reason\": \"memories_per_day_exceeded\"\n    }\n  },\n  \"recent_events\": []\n}\n",
    stderr: "",
  },
  {
    name: "events big id, floats, payload",
    argv: ["resource","events","products","-l","2"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": \"123456789012345678901\", \"op\": \"upsert\", \"doc_id\": \"SKU-1\", \"version\": 3, \"idempotency_key\": null, \"importance\": 1.0, \"created_at\": \"2026-06-01T00:00:00.123456Z\", \"payload\": {\"name\": \"Widget \\u65e5\\u672c\", \"price\": 9.99, \"qty\": 3, \"nested\": {\"a\": [0.5, 1e-7, 12345678901]}}, \"event_metadata\": {}, \"payload_bytes\": 64, \"payload_truncated\": false}, {\"id\": \"7\", \"op\": \"delete\", \"doc_id\": \"SKU-2\", \"importance\": 0.6, \"created_at\": \"2026-06-01T00:00:00Z\", \"payload\": null, \"event_metadata\": {\"source\": \"sync\"}, \"payload_bytes\": 0, \"payload_truncated\": true, \"extra\": 1}], \"next_cursor\": \"eyJ4IjoxfQ==\"}"}},
    code: 0,
    stdout: "{\n  \"events\": [\n    {\n      \"id\": 123456789012345678901,\n      \"op\": \"upsert\",\n      \"doc_id\": \"SKU-1\",\n      \"version\": 3,\n      \"idempotency_key\": null,\n      \"importance\": 1.0,\n      \"created_at\": \"2026-06-01T00:00:00.123456Z\",\n      \"payload\": {\n        \"name\": \"Widget 日本\",\n        \"price\": 9.99,\n        \"qty\": 3,\n        \"nested\": {\n          \"a\": [\n            0.5,\n            1e-7,\n            12345678901\n          ]\n        }\n      },\n      \"event_metadata\": {},\n      \"payload_bytes\": 64,\n      \"payload_truncated\": false\n    },\n    {\n      \"id\": 7,\n      \"op\": \"delete\",\n      \"doc_id\": \"SKU-2\",\n      \"version\": null,\n      \"idempotency_key\": null,\n      \"importance\": 0.6,\n      \"created_at\": \"2026-06-01T00:00:00Z\",\n      \"payload\": null,\n      \"event_metadata\": {\n        \"source\": \"sync\"\n      },\n      \"payload_bytes\": 0,\n      \"payload_truncated\": true\n    }\n  ],\n  \"next_cursor\": \"eyJ4IjoxfQ==\"\n}\n",
    stderr: "",
  },
  {
    name: "events null event_metadata",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"d\", \"event_metadata\": null, \"importance\": \"x\", \"payload\": [1]}]}"}},
    code: 1,
    stdout: "",
    stderr: "Error: ResourceClient.list_resource_events: unexpected server response for ResourceEventsListResponse (events.0.importance: Input should be a valid number, unable to parse string as a number; events.0.payload: Input should be a valid dictionary; events.0.event_metadata: Input should be a valid dictionary). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "schema full + defaults",
    argv: ["resource","schema","-r","products","-v","2"],
    routes: {"GET /api/v1/resources/products/schema":{"status":200,"raw":"{\"resource_id\": \"products\", \"schema_version\": 2, \"field_definitions\": [{\"name\": \"sku\", \"type\": \"text\", \"description\": \"SKU\"}, {\"name\": \"price\", \"type\": \"number\", \"description\": \"Price\", \"classification\": \"internal\", \"index_hint\": \"range\", \"unit\": \"USD\", \"enum_values\": [\"a\", \"b\"], \"example\": \"9.99\", \"required\": true, \"extra\": 1}], \"created_at\": \"2026-06-01T00:00:00.123456Z\", \"extra\": 2}"}},
    code: 0,
    stdout: "{\n  \"resource_id\": \"products\",\n  \"schema_version\": 2,\n  \"field_definitions\": [\n    {\n      \"name\": \"sku\",\n      \"type\": \"text\",\n      \"description\": \"SKU\",\n      \"classification\": \"public\",\n      \"index_hint\": \"\",\n      \"unit\": null,\n      \"enum_values\": null,\n      \"example\": null,\n      \"required\": false\n    },\n    {\n      \"name\": \"price\",\n      \"type\": \"number\",\n      \"description\": \"Price\",\n      \"classification\": \"internal\",\n      \"index_hint\": \"range\",\n      \"unit\": \"USD\",\n      \"enum_values\": [\n        \"a\",\n        \"b\"\n      ],\n      \"example\": \"9.99\",\n      \"required\": true\n    }\n  ],\n  \"created_at\": \"2026-06-01T00:00:00.123456Z\"\n}\n",
    stderr: "",
  },
  {
    name: "ingest minimal",
    argv: ["resource","ingest","-r","products","-k","rk","--doc-id","SKU-1","-p","{\"a\":1}"],
    routes: {"POST /api/v1/resources/products/events":{"status":202,"raw":"{\"event_id\": 42}"}},
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"event_id\": 42,\n  \"queued\": true,\n  \"estimated_indexing_time_seconds\": null\n}\n",
    stderr: "",
  },
  {
    name: "ingest missing event_id",
    argv: ["resource","ingest","-r","products","-k","rk","--doc-id","SKU-1"],
    routes: {"POST /api/v1/resources/products/events":{"status":202,"raw":"{\"status\": \"accepted\"}"}},
    code: 1,
    stdout: "",
    stderr: "Error: ResourceClient.ingest_event: unexpected server response for ResourceEventResponse (event_id: Field required). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "ingest-batch errors",
    argv: ["resource","ingest-batch","-r","products","-k","rk","-f","events.json"],
    files: {"events.json":"[{\"op\": \"upsert\", \"doc_id\": \"a\"}]"},
    routes: {"POST /api/v1/resources/products/events/batch":{"status":202,"raw":"{\"status\": \"partial\", \"created_count\": 1, \"failed_count\": 1, \"event_ids\": [\"5\"], \"errors\": [{\"index\": 1, \"error\": \"bad\", \"score\": 0.5}], \"extra\": 1}"}},
    code: 0,
    stdout: "{\n  \"status\": \"partial\",\n  \"created_count\": 1,\n  \"failed_count\": 1,\n  \"event_ids\": [\n    5\n  ],\n  \"errors\": [\n    {\n      \"index\": 1,\n      \"error\": \"bad\",\n      \"score\": 0.5\n    }\n  ]\n}\n",
    stderr: "",
  },
  {
    name: "import counts as strings",
    argv: ["resource","import","-r","products","-k","rk","-f","rows.json"],
    files: {"rows.json":"[{\"a\": 1}, {\"a\": 2}]"},
    routes: {"POST /api/v1/resources/products/events/batch":{"status":202,"raw":"{\"created_count\": \"2\", \"errors\": [{\"index\": 0, \"error\": \"x\"}]}"}},
    code: 0,
    stdout: "{\n  \"created\": 2,\n  \"failed\": 0,\n  \"total\": 2,\n  \"errors\": [\n    {\n      \"index\": 0,\n      \"error\": \"x\"\n    }\n  ]\n}\n",
    stderr: "",
  },
  {
    name: "files list bare",
    argv: ["files","list","-c","11111111-2222-4333-8444-555555555555"],
    routes: {"GET /api/v1/files":{"status":200,"raw":"[{\"id\": \"f1\", \"workspace_id\": \"11111111-2222-4333-8444-555555555555\", \"context_id\": null, \"filename\": \"a.txt\", \"content_type\": \"text/plain\", \"size_bytes\": 18, \"sha256\": \"abc\", \"status\": \"confirmed\", \"created_at\": \"2026-06-01T00:00:00.123456Z\", \"uploaded_at\": \"2026-06-01T00:00:01.5Z\", \"extra\": 1}, {\"id\": \"f2\", \"workspace_id\": \"11111111-2222-4333-8444-555555555555\", \"filename\": \"b\", \"content_type\": \"x/y\", \"size_bytes\": \"3\", \"sha256\": \"d\", \"status\": \"reserved\", \"created_at\": \"2026-06-01T00:00:00Z\"}]"}},
    code: 0,
    stdout: "{\n  \"files\": [\n    {\n      \"id\": \"f1\",\n      \"workspace_id\": \"11111111-2222-4333-8444-555555555555\",\n      \"filename\": \"a.txt\",\n      \"content_type\": \"text/plain\",\n      \"size_bytes\": 18,\n      \"sha256\": \"abc\",\n      \"status\": \"confirmed\",\n      \"created_at\": \"2026-06-01T00:00:00.123456Z\",\n      \"uploaded_at\": \"2026-06-01T00:00:01.500000Z\",\n      \"context_id\": null\n    },\n    {\n      \"id\": \"f2\",\n      \"workspace_id\": \"11111111-2222-4333-8444-555555555555\",\n      \"filename\": \"b\",\n      \"content_type\": \"x/y\",\n      \"size_bytes\": 3,\n      \"sha256\": \"d\",\n      \"status\": \"reserved\",\n      \"created_at\": \"2026-06-01T00:00:00Z\",\n      \"uploaded_at\": null,\n      \"context_id\": null\n    }\n  ],\n  \"next_cursor\": null\n}\n",
    stderr: "",
  },
  {
    name: "files list malformed item",
    argv: ["files","list","-c","11111111-2222-4333-8444-555555555555"],
    routes: {"GET /api/v1/files":{"status":200,"raw":"[{\"id\": \"f1\"}]"}},
    code: 1,
    stdout: "",
    stderr: "Error: FilesClient.list: unexpected server response for FileObject (workspace_id: Field required; filename: Field required; content_type: Field required (+4 more)). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
];

const AUTH: ResolvedAuth = { kind: "static", apiKey: "k", mcpUrl: "https://api.test/mcp", source: "config" };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kagura-dumps-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fetch answering each `METHOD /path` with its recorded bytes, and 404 otherwise. */
function rawFetch(routes: Case["routes"]): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const route = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    if (route === undefined) return new Response('{"detail":"Not Found"}', { status: 404 });
    return new Response(route.status === 204 ? null : route.raw, { status: route.status });
  };
}

describe("resource and files output, byte for byte the Python CLI's (#66)", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const out: string[] = [];
    const err: string[] = [];
    const fetch = rawFetch(c.routes);
    const deps = {
      write: (line: string) => void out.push(line),
      writeError: (line: string) => void err.push(line),
      loadConfig: () => ({ api_key: "k", context_id: "11111111-2222-4333-8444-555555555555" }),
      resolveAuth: () => AUTH,
      readStdin: () => null,
      makeResourceClient: () => ResourceClient.fromMcpUrl({ apiKey: "k", mcpUrl: AUTH.mcpUrl, fetch }),
      makeFilesClient: (auth: ResolvedAuth, hint?: string | null) =>
        restClientFromAuth(FilesClient, auth, { workspaceIdHint: hint ?? null, fetch }),
    } as unknown as CliDeps;
    for (const [name, text] of Object.entries(c.files ?? {})) fs.writeFileSync(path.join(dir, name), text);
    const argv = c.argv.map((arg) => (c.files?.[arg] !== undefined ? path.join(dir, arg) : arg));

    expect(await runCli(argv, deps)).toBe(c.code);
    expect(out.map((line) => `${line}\n`).join("")).toBe(c.stdout);
    expect(err.map((line) => `${line}\n`).join("")).toBe(c.stderr);
  });
});
