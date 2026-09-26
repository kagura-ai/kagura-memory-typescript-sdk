/**
 * The resource and files commands print what the Python CLI prints for the
 * same server response (#66): each case below is a response and the
 * Python CLI's stdout, stderr and exit code for it, recorded from the
 * Python CLI 0.41.0 (click 8.3.3, pydantic 2.13.4) against a fake server
 * sending these exact bytes. They include responses with keys the model
 * does not have, responses without its optional keys, lax values (`"6"`
 * for an int, `12.0` for a float), and ones the model refuses. The
 * lone-surrogate cases (#69) were recorded from the Python CLI 0.42.0
 * (click 8.3.3, pydantic 2.13.4) the same way.
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
  {
    name: "files list null",
    argv: ["files","list","-c","11111111-2222-4333-8444-555555555555"],
    routes: {"GET /api/v1/files":{"status":200,"raw":"null"}},
    code: 1,
    stdout: "",
    stderr: "Error: FilesClient.list: unexpected server response for FileListResponse (Input should be a valid dictionary or instance of FileListResponse). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "files list envelope bad item",
    argv: ["files","list","-c","11111111-2222-4333-8444-555555555555"],
    routes: {"GET /api/v1/files":{"status":200,"raw":"{\"files\": [{\"id\": \"f1\"}], \"next_cursor\": null}"}},
    code: 1,
    stdout: "",
    stderr: "Error: FilesClient.list: unexpected server response for FileListResponse (files.0.workspace_id: Field required; files.0.filename: Field required; files.0.content_type: Field required (+4 more)). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "files list envelope ok",
    argv: ["files","list","-c","11111111-2222-4333-8444-555555555555"],
    routes: {"GET /api/v1/files":{"status":200,"raw":"{\"files\": [{\"id\": \"f1\", \"workspace_id\": \"w\", \"filename\": \"a\", \"content_type\": \"t\", \"size_bytes\": \"3\", \"sha256\": \"s\", \"status\": \"confirmed\", \"created_at\": \"2026-06-01T00:00:00Z\", \"x\": 1}], \"next_cursor\": null, \"extra\": 2}"}},
    code: 0,
    stdout: "{\n  \"files\": [\n    {\n      \"id\": \"f1\",\n      \"workspace_id\": \"w\",\n      \"filename\": \"a\",\n      \"content_type\": \"t\",\n      \"size_bytes\": 3,\n      \"sha256\": \"s\",\n      \"status\": \"confirmed\",\n      \"created_at\": \"2026-06-01T00:00:00Z\",\n      \"uploaded_at\": null,\n      \"context_id\": null\n    }\n  ],\n  \"next_cursor\": null\n}\n",
    stderr: "",
  },
  {
    name: "download-url empty",
    argv: ["files","download-url","f1","-c","11111111-2222-4333-8444-555555555555"],
    routes: {"GET /api/v1/files/f1/download-url":{"status":200,"raw":"{}"}},
    code: 1,
    stdout: "",
    stderr: "Error: FilesClient.download_url: unexpected server response for FileDownloadUrlResponse (download_url: Field required). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "download-url number",
    argv: ["files","download-url","f1","-c","11111111-2222-4333-8444-555555555555"],
    routes: {"GET /api/v1/files/f1/download-url":{"status":200,"raw":"{\"download_url\": 5}"}},
    code: 1,
    stdout: "",
    stderr: "Error: FilesClient.download_url: unexpected server response for FileDownloadUrlResponse (download_url: Input should be a valid string). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "download-url null",
    argv: ["files","download-url","f1","-c","11111111-2222-4333-8444-555555555555"],
    routes: {"GET /api/v1/files/f1/download-url":{"status":200,"raw":"null"}},
    code: 1,
    stdout: "",
    stderr: "Error: FilesClient.download_url: unexpected server response for FileDownloadUrlResponse (Input should be a valid dictionary or instance of FileDownloadUrlResponse). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "events payload nested past pydantic's serializer depth",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":`{"events": [{"id": 1, "op": "upsert", "doc_id": "d", "payload": {"x": ${"[".repeat(255)}1${"]".repeat(255)}}}]}`}},
    code: 1,
    stdout: "",
    stderr: "Error: Error serializing to JSON: ValueError: Circular reference detected (depth exceeded)\n",
  },
  {
    name: "schema null",
    argv: ["resource","schema","-r","products"],
    routes: {"GET /api/v1/resources/products/schema":{"status":200,"raw":"null"}},
    code: 1,
    stdout: "",
    stderr: "Error: ResourceClient.get_resource_schema: unexpected server response for ResourceSchemaResponse (Input should be a valid dictionary or instance of ResourceSchemaResponse). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "events doc_id with a lone surrogate",
    argv: ["resource", "events", "products"],
    routes: {"GET /api/v1/resources/products/events": {status: 200, raw: JSON.stringify({events: [{id: 1, op: "upsert", doc_id: "a\u{d800}"}]})}},
    code: 1,
    stdout: "",
    stderr: "Error: Error serializing to JSON: UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 1: surrogates not allowed\n",
  },
  {
    name: "events payload key with a lone surrogate",
    argv: ["resource", "events", "products"],
    routes: {"GET /api/v1/resources/products/events": {status: 200, raw: JSON.stringify({events: [{id: 1, op: "upsert", doc_id: "d", payload: {"k\u{d800}": 1, z: 2}}]})}},
    code: 0,
    stdout: "{\n  \"events\": [\n    {\n      \"id\": 1,\n      \"op\": \"upsert\",\n      \"doc_id\": \"d\",\n      \"version\": null,\n      \"idempotency_key\": null,\n      \"importance\": null,\n      \"created_at\": null,\n      \"payload\": {\n        \"k\u{fffd}\u{fffd}\u{fffd}\": 1,\n        \"z\": 2\n      },\n      \"event_metadata\": {},\n      \"payload_bytes\": null,\n      \"payload_truncated\": false\n    }\n  ],\n  \"next_cursor\": null\n}\n",
    stderr: "",
  },
  {
    name: "events nested payload key with a lone surrogate",
    argv: ["resource", "events", "products"],
    routes: {"GET /api/v1/resources/products/events": {status: 200, raw: JSON.stringify({events: [{id: 1, op: "upsert", doc_id: "d", payload: {x: {"\u{d800}": 1}}}]})}},
    code: 1,
    stdout: "",
    stderr: "Error: Error serializing to JSON: UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 0: surrogates not allowed\n",
  },
  {
    name: "events metadata value with a run of lone surrogates after an emoji",
    argv: ["resource", "events", "products"],
    routes: {"GET /api/v1/resources/products/events": {status: 200, raw: JSON.stringify({events: [{id: 1, op: "upsert", doc_id: "d", event_metadata: {v: "\u{1f600}\u{dc00}\u{d800}x"}}]})}},
    code: 1,
    stdout: "",
    stderr: "Error: Error serializing to JSON: UnicodeEncodeError: 'utf-8' codec can't encode characters in position 1-2: surrogates not allowed\n",
  },
  {
    name: "events id with a lone surrogate",
    argv: ["resource", "events", "products"],
    routes: {"GET /api/v1/resources/products/events": {status: 200, raw: JSON.stringify({events: [{id: "1\u{d800}", op: "upsert", doc_id: "d"}]})}},
    code: 1,
    stdout: "",
    stderr: "Error: ResourceClient.list_resource_events: unexpected server response for ResourceEventsListResponse (events.0.id: Input should be a valid string, unable to parse raw data as a unicode string). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "events op, importance, created_at and payload_truncated with lone surrogates",
    argv: ["resource", "events", "products"],
    routes: {"GET /api/v1/resources/products/events": {status: 200, raw: JSON.stringify({events: [{id: 1, op: "\u{d800}", doc_id: "d", importance: "1\u{d800}", created_at: "2026-06-01\u{d800}", payload_truncated: "t\u{d800}"}]})}},
    code: 1,
    stdout: "",
    stderr: "Error: ResourceClient.list_resource_events: unexpected server response for ResourceEventsListResponse (events.0.op: Input should be a valid string, unable to parse raw data as a unicode string; events.0.importance: Input should be a valid string, unable to parse raw data as a unicode string; events.0.created_at: Input should be a valid string, unable to parse raw data as a unicode string (+1 more)). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
];

/**
 * #69: what the lossless reader keeps, recorded from the Python CLI 0.42.0
 * (click 8.3.3, pydantic 2.13.4) against a fake server sending these exact
 * bytes: key order in untyped mappings, number literals in typed and
 * untyped fields, NaN and Infinity, duplicate keys, the nesting depth
 * past which Python's `json.loads` fails, and a lone surrogate, which
 * pydantic's dump refuses in a string and in a key of a mapping nested
 * inside an untyped value, and writes lossily in a key of the untyped
 * mapping itself; `resource import`'s `json.dumps` summary keeps it and
 * the CLI's UTF-8 stdout (`errors="replace"`) prints one `?` per code unit.
 */
const LOSSLESS_CASES: Case[] = [
  {
    name: "events key order",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"d\", \"payload\": {\"b\": 1, \"2\": 2, \"10\": 3}, \"event_metadata\": {\"id\": \"x\", \"2024\": 1}}]}"}},
    code: 0,
    stdout: "{\n  \"events\": [\n    {\n      \"id\": 1,\n      \"op\": \"upsert\",\n      \"doc_id\": \"d\",\n      \"version\": null,\n      \"idempotency_key\": null,\n      \"importance\": null,\n      \"created_at\": null,\n      \"payload\": {\n        \"b\": 1,\n        \"2\": 2,\n        \"10\": 3\n      },\n      \"event_metadata\": {\n        \"id\": \"x\",\n        \"2024\": 1\n      },\n      \"payload_bytes\": null,\n      \"payload_truncated\": false\n    }\n  ],\n  \"next_cursor\": null\n}\n",
    stderr: "",
  },
  {
    name: "events untyped numbers",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"d\", \"payload\": {\"a\": 1e16, \"b\": 1e300, \"c\": -0.0, \"d\": 1.0, \"e\": 9007199254740993, \"f\": -0, \"g\": 1E5, \"h\": 1e-7, \"i\": 0.00001, \"j\": 2.5e-5}}]}"}},
    code: 0,
    stdout: "{\n  \"events\": [\n    {\n      \"id\": 1,\n      \"op\": \"upsert\",\n      \"doc_id\": \"d\",\n      \"version\": null,\n      \"idempotency_key\": null,\n      \"importance\": null,\n      \"created_at\": null,\n      \"payload\": {\n        \"a\": 1e+16,\n        \"b\": 1e+300,\n        \"c\": -0.0,\n        \"d\": 1.0,\n        \"e\": 9007199254740993,\n        \"f\": 0,\n        \"g\": 100000.0,\n        \"h\": 1e-7,\n        \"i\": 0.00001,\n        \"j\": 0.000025\n      },\n      \"event_metadata\": {},\n      \"payload_bytes\": null,\n      \"payload_truncated\": false\n    }\n  ],\n  \"next_cursor\": null\n}\n",
    stderr: "",
  },
  {
    name: "events int 2^53+1",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 9007199254740993, \"op\": \"upsert\", \"doc_id\": \"d\", \"version\": 1e18}]}"}},
    code: 0,
    stdout: "{\n  \"events\": [\n    {\n      \"id\": 9007199254740993,\n      \"op\": \"upsert\",\n      \"doc_id\": \"d\",\n      \"version\": 1000000000000000000,\n      \"idempotency_key\": null,\n      \"importance\": null,\n      \"created_at\": null,\n      \"payload\": null,\n      \"event_metadata\": {},\n      \"payload_bytes\": null,\n      \"payload_truncated\": false\n    }\n  ],\n  \"next_cursor\": null\n}\n",
    stderr: "",
  },
  {
    name: "events int 1e20",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1e20, \"op\": \"upsert\", \"doc_id\": \"d\"}]}"}},
    code: 1,
    stdout: "",
    stderr: "Error: ResourceClient.list_resource_events: unexpected server response for ResourceEventsListResponse (events.0.id: Unable to parse input string as an integer, exceeded maximum size). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "events float -0",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"d\", \"importance\": -0}]}"}},
    code: 0,
    stdout: "{\n  \"events\": [\n    {\n      \"id\": 1,\n      \"op\": \"upsert\",\n      \"doc_id\": \"d\",\n      \"version\": null,\n      \"idempotency_key\": null,\n      \"importance\": 0.0,\n      \"created_at\": null,\n      \"payload\": null,\n      \"event_metadata\": {},\n      \"payload_bytes\": null,\n      \"payload_truncated\": false\n    }\n  ],\n  \"next_cursor\": null\n}\n",
    stderr: "",
  },
  {
    name: "events NaN Infinity",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"d\", \"importance\": NaN, \"payload\": {\"a\": NaN, \"b\": Infinity, \"c\": -Infinity}}]}"}},
    code: 0,
    stdout: "{\n  \"events\": [\n    {\n      \"id\": 1,\n      \"op\": \"upsert\",\n      \"doc_id\": \"d\",\n      \"version\": null,\n      \"idempotency_key\": null,\n      \"importance\": null,\n      \"created_at\": null,\n      \"payload\": {\n        \"a\": null,\n        \"b\": null,\n        \"c\": null\n      },\n      \"event_metadata\": {},\n      \"payload_bytes\": null,\n      \"payload_truncated\": false\n    }\n  ],\n  \"next_cursor\": null\n}\n",
    stderr: "",
  },
  {
    name: "events NaN int",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": NaN, \"op\": \"upsert\", \"doc_id\": \"d\"}]}"}},
    code: 1,
    stdout: "",
    stderr: "Error: ResourceClient.list_resource_events: unexpected server response for ResourceEventsListResponse (events.0.id: Input should be a finite number). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "ingest-batch errors key order",
    argv: ["resource","ingest-batch","-r","products","-k","rk","-f","events.json"],
    files: {"events.json": "[{\"op\": \"upsert\", \"doc_id\": \"a\"}]"},
    routes: {"POST /api/v1/resources/products/events/batch":{"status":202,"raw":"{\"created_count\": 0, \"failed_count\": 1, \"errors\": [{\"index\": 0, \"10\": \"x\", \"2\": 1e16, \"error\": \"bad\"}]}"}},
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"created_count\": 0,\n  \"failed_count\": 1,\n  \"event_ids\": [],\n  \"errors\": [\n    {\n      \"index\": 0,\n      \"10\": \"x\",\n      \"2\": 1e+16,\n      \"error\": \"bad\"\n    }\n  ]\n}\n",
    stderr: "",
  },
  {
    name: "files list exact size",
    argv: ["files","list","-c","11111111-2222-4333-8444-555555555555"],
    routes: {"GET /api/v1/files":{"status":200,"raw":"[{\"id\": \"f1\", \"workspace_id\": \"w\", \"filename\": \"a\", \"content_type\": \"t\", \"size_bytes\": 9007199254740993, \"sha256\": \"s\", \"status\": \"confirmed\", \"created_at\": \"2026-06-01T00:00:00Z\"}]"}},
    code: 0,
    stdout: "{\n  \"files\": [\n    {\n      \"id\": \"f1\",\n      \"workspace_id\": \"w\",\n      \"filename\": \"a\",\n      \"content_type\": \"t\",\n      \"size_bytes\": 9007199254740993,\n      \"sha256\": \"s\",\n      \"status\": \"confirmed\",\n      \"created_at\": \"2026-06-01T00:00:00Z\",\n      \"uploaded_at\": null,\n      \"context_id\": null\n    }\n  ],\n  \"next_cursor\": null\n}\n",
    stderr: "",
  },
  {
    name: "files list size 1e20",
    argv: ["files","list","-c","11111111-2222-4333-8444-555555555555"],
    routes: {"GET /api/v1/files":{"status":200,"raw":"[{\"id\": \"f1\", \"workspace_id\": \"w\", \"filename\": \"a\", \"content_type\": \"t\", \"size_bytes\": 1e20, \"sha256\": \"s\", \"status\": \"confirmed\", \"created_at\": \"2026-06-01T00:00:00Z\"}]"}},
    code: 1,
    stdout: "",
    stderr: "Error: FilesClient.list: unexpected server response for FileObject (size_bytes: Unable to parse input string as an integer, exceeded maximum size). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "ingest event_id -9223372036854775808.0",
    argv: ["resource","ingest","-r","products","-k","rk","--doc-id","SKU-1"],
    routes: {"POST /api/v1/resources/products/events":{"status":202,"raw":"{\"event_id\": -9223372036854775808.0, \"estimated_indexing_time_seconds\": 9.223372036854775e18}"}},
    code: 1,
    stdout: "",
    stderr: "Error: ResourceClient.ingest_event: unexpected server response for ResourceEventResponse (event_id: Unable to parse input string as an integer, exceeded maximum size). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "events html",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"<html>"}},
    code: 1,
    stdout: "",
    stderr: "Error: Server returned a non-JSON body (HTTP 200) for GET /api/v1/resources/products/events.\n",
  },
  {
    name: "events duplicate keys",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"d\", \"id\": 2, \"payload\": {\"k\": 1, \"3\": \"a\", \"k\": 2.50, \"__proto__\": {\"x\": 1}}}]}"}},
    code: 0,
    stdout: "{\n  \"events\": [\n    {\n      \"id\": 2,\n      \"op\": \"upsert\",\n      \"doc_id\": \"d\",\n      \"version\": null,\n      \"idempotency_key\": null,\n      \"importance\": null,\n      \"created_at\": null,\n      \"payload\": {\n        \"k\": 2.5,\n        \"3\": \"a\",\n        \"__proto__\": {\n          \"x\": 1\n        }\n      },\n      \"event_metadata\": {},\n      \"payload_bytes\": null,\n      \"payload_truncated\": false\n    }\n  ],\n  \"next_cursor\": null\n}\n",
    stderr: "",
  },
  {
    name: "events int 309 digits",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":`{"events": [{"id": ${"1".repeat(309)}, "op": "upsert", "doc_id": "d"}]}`}},
    code: 0,
    stdout: `{\n  "events": [\n    {\n      "id": ${"1".repeat(309)},\n      "op": "upsert",\n      "doc_id": "d",\n      "version": null,\n      "idempotency_key": null,\n      "importance": null,\n      "created_at": null,\n      "payload": null,\n      "event_metadata": {},\n      "payload_bytes": null,\n      "payload_truncated": false\n    }\n  ],\n  "next_cursor": null\n}\n`,
    stderr: "",
  },
  {
    name: "events float -0 and 401 digits",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":`{"events": [{"id": 1, "op": "upsert", "doc_id": "d", "importance": -0}, {"id": 2, "op": "upsert", "doc_id": "d", "importance": ${"1".repeat(401)}}]}`}},
    code: 1,
    stdout: "",
    stderr: "Error: ResourceClient.list_resource_events: unexpected server response for ResourceEventsListResponse (events.1.importance: Input should be a valid number). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "events 5000-digit int",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":`{"events": [{"id": 1, "op": "upsert", "doc_id": "d", "payload": {"x": ${"1".repeat(5000)}}}]}`}},
    code: 1,
    stdout: "",
    stderr: "Error: Server returned a non-JSON body (HTTP 200) for GET /api/v1/resources/products/events.\n",
  },
  {
    name: "events payload 969 arrays deep: parsed, then past pydantic's serializer depth",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":`{"events": [{"id": 1, "op": "upsert", "doc_id": "d", "payload": {"x": ${"[".repeat(969)}${"]".repeat(969)}}}]}`}},
    code: 1,
    stdout: "",
    stderr: "Error: Error serializing to JSON: ValueError: Circular reference detected (depth exceeded)\n",
  },
  {
    name: "events payload 970 arrays deep: past json.loads's depth",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":`{"events": [{"id": 1, "op": "upsert", "doc_id": "d", "payload": {"x": ${"[".repeat(970)}${"]".repeat(970)}}}]}`}},
    code: 1,
    stdout: "",
    stderr: "Error: maximum recursion depth exceeded while decoding a JSON array from a unicode string\n",
  },
  {
    name: "events payload 970 objects deep",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":`{"events": [{"id": 1, "op": "upsert", "doc_id": "d", "payload": {"x": ${'{"a": '.repeat(970)}1${"}".repeat(970)}}}]}`}},
    code: 1,
    stdout: "",
    stderr: "Error: maximum recursion depth exceeded while decoding a JSON object from a unicode string\n",
  },
  {
    name: "events payload 10,000 arrays deep",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":`{"events": [{"id": 1, "op": "upsert", "doc_id": "d", "payload": {"x": ${"[".repeat(10000)}${"]".repeat(10000)}}}]}`}},
    code: 1,
    stdout: "",
    stderr: "Error: maximum recursion depth exceeded while decoding a JSON array from a unicode string\n",
  },
  {
    name: "events lone surrogate",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"d\", \"payload\": {\"s\": \"\\ud800\"}}]}"}},
    code: 1,
    stdout: "",
    stderr: "Error: Error serializing to JSON: UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 0: surrogates not allowed\n",
  },
  {
    name: "events lone surrogate in a typed str field",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"\\udfff\"}]}"}},
    code: 1,
    stdout: "",
    stderr: "Error: Error serializing to JSON: UnicodeEncodeError: 'utf-8' codec can't encode character '\\udfff' in position 0: surrogates not allowed\n",
  },
  {
    name: "events lone surrogate run after an astral character",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"d\", \"payload\": {\"s\": \"\\ud83d\\ude00x\\udc00\\udc00y\"}}]}"}},
    code: 1,
    stdout: "",
    stderr: "Error: Error serializing to JSON: UnicodeEncodeError: 'utf-8' codec can't encode characters in position 2-3: surrogates not allowed\n",
  },
  {
    name: "events lone surrogate key",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"d\", \"payload\": {\"\\ud800\": 1}}]}"}},
    code: 0,
    stdout: "{\n  \"events\": [\n    {\n      \"id\": 1,\n      \"op\": \"upsert\",\n      \"doc_id\": \"d\",\n      \"version\": null,\n      \"idempotency_key\": null,\n      \"importance\": null,\n      \"created_at\": null,\n      \"payload\": {\n        \"\u{fffd}\u{fffd}\u{fffd}\": 1\n      },\n      \"event_metadata\": {},\n      \"payload_bytes\": null,\n      \"payload_truncated\": false\n    }\n  ],\n  \"next_cursor\": null\n}\n",
    stderr: "",
  },
  {
    name: "events lone surrogate key then value",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"d\", \"payload\": {\"\\ud800\": \"a\\udfff\"}}]}"}},
    code: 1,
    stdout: "",
    stderr: "Error: Error serializing to JSON: UnicodeEncodeError: 'utf-8' codec can't encode character '\\udfff' in position 1: surrogates not allowed\n",
  },
  {
    name: "events lone surrogate key in a nested mapping",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"d\", \"payload\": {\"p\": {\"\\ud800\": 1}}}]}"}},
    code: 1,
    stdout: "",
    stderr: "Error: Error serializing to JSON: UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 0: surrogates not allowed\n",
  },
  {
    name: "events lone surrogate run in a nested mapping's key",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"d\", \"payload\": {\"p\": {\"a\\udfff\\udc00b\": 1}}}]}"}},
    code: 1,
    stdout: "",
    stderr: "Error: Error serializing to JSON: UnicodeEncodeError: 'utf-8' codec can't encode characters in position 1-2: surrogates not allowed\n",
  },
  {
    name: "events lone surrogate key in a mapping in a list",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"d\", \"payload\": {\"p\": [{\"\\ud800\": 1}]}}]}"}},
    code: 1,
    stdout: "",
    stderr: "Error: Error serializing to JSON: UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 0: surrogates not allowed\n",
  },
  {
    name: "events lone surrogate nested key then value",
    argv: ["resource","events","products"],
    routes: {"GET /api/v1/resources/products/events":{"status":200,"raw":"{\"events\": [{\"id\": 1, \"op\": \"upsert\", \"doc_id\": \"d\", \"payload\": {\"p\": {\"\\ud800\": \"\\udfff\"}}}]}"}},
    code: 1,
    stdout: "",
    stderr: "Error: Error serializing to JSON: UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 0: surrogates not allowed\n",
  },
  {
    name: "import error lone surrogate value prints ?",
    argv: ["resource","import","-r","products","-k","rk","-f","rows.json"],
    files: {"rows.json": "[{\"a\": 1}]"},
    routes: {"POST /api/v1/resources/products/events/batch":{"status":202,"raw":"{\"created_count\": 1, \"errors\": [{\"index\": 0, \"m\": \"\\ud800\"}]}"}},
    code: 0,
    stdout: "{\n  \"created\": 1,\n  \"failed\": 0,\n  \"total\": 1,\n  \"errors\": [\n    {\n      \"index\": 0,\n      \"m\": \"?\"\n    }\n  ]\n}\n",
    stderr: "",
  },
  {
    name: "import error lone surrogate key prints ?",
    argv: ["resource","import","-r","products","-k","rk","-f","rows.json"],
    files: {"rows.json": "[{\"a\": 1}]"},
    routes: {"POST /api/v1/resources/products/events/batch":{"status":202,"raw":"{\"created_count\": 1, \"errors\": [{\"index\": 0, \"\\ud800\": 1}]}"}},
    code: 0,
    stdout: "{\n  \"created\": 1,\n  \"failed\": 0,\n  \"total\": 1,\n  \"errors\": [\n    {\n      \"index\": 0,\n      \"?\": 1\n    }\n  ]\n}\n",
    stderr: "",
  },
  {
    name: "import error lone surrogate run after an astral character prints ???",
    argv: ["resource","import","-r","products","-k","rk","-f","rows.json"],
    files: {"rows.json": "[{\"a\": 1}]"},
    routes: {"POST /api/v1/resources/products/events/batch":{"status":202,"raw":"{\"created_count\": 1, \"errors\": [{\"index\": 0, \"m\": \"\\ud83d\\ude00\\udfff\\ud800\\ud800x\", \"\\udc00\\ud83d\\ude00\": {\"\\udbff\": \"\\ud800\\udc00\\udc00\"}}]}"}},
    code: 0,
    stdout: "{\n  \"created\": 1,\n  \"failed\": 0,\n  \"total\": 1,\n  \"errors\": [\n    {\n      \"index\": 0,\n      \"m\": \"\u{1f600}???x\",\n      \"?\u{1f600}\": {\n        \"?\": \"\u{10000}?\"\n      }\n    }\n  ]\n}\n",
    stderr: "",
  },
  {
    name: "import sums counts past 2^53 exactly and prints errors as json.dumps does",
    argv: ["resource","import","-r","products","-k","rk","-f","rows.json"],
    files: {"rows.json": `[${Array.from({ length: 101 }, (_, i) => `{"a": ${i}}`).join(", ")}]`},
    routes: {"POST /api/v1/resources/products/events/batch":{"status":202,"raw":"{\"created_count\": 9007199254740993, \"failed_count\": 9007199254740993, \"errors\": [{\"index\": 0, \"2\": -0.0, \"a\": 1e16, \"b\": 1.0, \"n\": NaN}]}"}},
    code: 0,
    stdout: "{\n  \"created\": 18014398509481986,\n  \"failed\": 18014398509481986,\n  \"total\": 101,\n  \"errors\": [\n    {\n      \"index\": 0,\n      \"2\": -0.0,\n      \"a\": 1e+16,\n      \"b\": 1.0,\n      \"n\": NaN\n    },\n    {\n      \"index\": 0,\n      \"2\": -0.0,\n      \"a\": 1e+16,\n      \"b\": 1.0,\n      \"n\": NaN\n    }\n  ]\n}\n",
    stderr: "",
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
  it.each([...CASES, ...LOSSLESS_CASES].map((c) => [c.name, c] as const))("%s", async (_name, c) => {
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
