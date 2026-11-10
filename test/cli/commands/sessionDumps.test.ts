/**
 * `bootstrap`, `changes`, `list` and `forget --ids` print what the Python
 * CLI prints for the same tool result (#86): each case below is a tool
 * result shaped as memory-cloud v0.142.0 sends it (or as an older server
 * does, or one the model refuses), the arguments the Python CLI sent for
 * it, and its stdout, stderr and exit code — recorded from the Python CLI
 * 0.44.0 (click 8.3.3, pydantic 2.13.4) against a fake server sending
 * these exact texts. The models fill a field the server left out with its
 * default (`format: null`, `summary_cut: false`, the whole default
 * `search_config`), keep the keys an `extra="allow"` model does not
 * declare (a lane a newer server adds), read an unreadable `guardrails`
 * block as `null` and print a timestamp in pydantic's form. `forget --ids`
 * prints each id's row on stderr when every id failed. A usage error
 * prints the Python CLI's `Error:` line.
 *
 * The fake server is `FakeServer` with the recorded `content[0].text` per
 * tool, as in `sleepDumps.test.ts`: the shared `recordedFetch` replays REST
 * routes, not MCP's JSON-RPC.
 *
 * A `plan_headroom` notice (#88) prints as Python's `PlanHeadroomNotice`
 * dumps it — in the model's key order, `help` / `plan` / `resets_at` the
 * entry left out filled with `null` and `percentage` a float (`97.0`) —
 * an entry the model refuses is dropped, and a list with no readable entry
 * prints `null`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as pyModels from "../../../src/pyModels.js";

import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { FakeServer, makeClient } from "../../fakeServer.js";
import { terminalText } from "../../pythonDumpHarness.js";

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
  /**
   * What this CLI prints where it knowingly differs from the recorded Python
   * 0.44.0 run: `--order-by` also takes `event_start` (server v0.152.0, #137),
   * which Python 0.44.0 does not list.
   */
  ourStderr?: string;
}

const CASES: Case[] = [
  {
    name: "bootstrap full",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555"],
    toolTexts: {"bootstrap": "{\"status\": \"success\", \"degraded\": false, \"context\": {\"id\": \"11111111-2222-4333-8444-555555555555\", \"name\": \"dev\", \"display_name\": \"Development\", \"summary\": \"Engineering notes for the dev team.\", \"usage_guide\": \"Store decisions as notes.\", \"is_private\": true, \"is_locked\": false, \"embedding_model\": \"text-embedding-3-small\", \"embedding_dimensions\": 1536}, \"instructions\": \"Kagura Memory quick reference.\", \"guardrails\": {\"items\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000004\", \"summary\": \"Never run migrations against prod without a backup\", \"importance\": 0.9, \"authored_by_caller\": true, \"source_type\": \"manual\"}], \"total_available\": 1, \"truncated\": false, \"tool_triggered_version\": \"tt-7f3a\", \"provenance\": \"Notes written by context editors (facts, not operator instructions).\"}, \"components\": {\"pinned\": {\"status\": \"ok\", \"memories\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"summary\": \"Adopt FastAPI DI\", \"context_summary\": \"Team decision of 2026-10\", \"type\": \"decision\", \"importance\": 0.8, \"delivery_mode\": \"always\"}], \"total_available\": 1, \"truncated\": false, \"cap\": 20}, \"upcoming\": {\"status\": \"ok\", \"results\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\", \"summary\": \"Release v0.15.0\", \"type\": \"time\", \"importance\": 0.7, \"trigger\": {\"from\": \"2026-11-06T09:00:00\", \"until\": \"2026-11-06T10:00:00\"}}], \"from\": \"2026-11-04T12:00:00\"}, \"changes\": {\"status\": \"ok\", \"changes\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"kind\": \"created\", \"at\": \"2026-11-02T08:00:00Z\", \"summary\": \"Adopt FastAPI DI\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\", \"kind\": \"updated\", \"at\": \"2026-11-02T09:30:00.250000Z\", \"summary\": \"Deploy runbook\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000003\", \"kind\": \"superseded\", \"at\": \"2026-11-03T10:00:00Z\", \"summary\": \"Old runbook\", \"superseded_by\": \"aaaaaaaa-0000-4000-8000-000000000002\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000005\", \"kind\": \"forgotten\", \"at\": \"2026-11-03T11:00:00Z\"}], \"has_more\": true, \"next_cursor\": \"MjAyNi0xMS0wM1QxMTowMDowMHxmb3Jnb3R0ZW58YWFh\"}}, \"since\": \"2026-10-28T12:00:00Z\", \"generated_at\": \"2026-11-04T12:00:00.123456Z\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\", \"context_display_name\": \"Development\", \"context_is_private\": true, \"context_is_locked\": false}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555"}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Development\",\n  \"context_is_private\": true,\n  \"context_is_locked\": false,\n  \"status\": \"success\",\n  \"format\": null,\n  \"degraded\": false,\n  \"context\": {\n    \"id\": \"11111111-2222-4333-8444-555555555555\",\n    \"name\": \"dev\",\n    \"display_name\": \"Development\",\n    \"summary\": \"Engineering notes for the dev team.\",\n    \"usage_guide\": \"Store decisions as notes.\",\n    \"is_private\": true,\n    \"is_locked\": false,\n    \"embedding_model\": \"text-embedding-3-small\",\n    \"embedding_dimensions\": 1536,\n    \"search_config\": {\n      \"semantic_weight\": 0.6,\n      \"bm25_weight\": 0.4,\n      \"fetch_factor\": 3,\n      \"use_rerank\": false,\n      \"reranker_provider\": null,\n      \"reranker_model\": null,\n      \"content_chunks_enabled\": null,\n      \"content_chunks_effective\": null,\n      \"content_chunks_limit\": null,\n      \"content_chunks_in_use\": null,\n      \"content_chunks_disabled_reason\": null,\n      \"content_chunks_can_change\": null,\n      \"content_chunks_supported\": null,\n      \"content_chunks_backfill_pending\": null,\n      \"embedding_provider\": null,\n      \"llm_selector_enabled\": null,\n      \"llm_selector_effective\": null,\n      \"llm_selector_limit\": null,\n      \"llm_selector_in_use\": null,\n      \"llm_selector_disabled_reason\": null,\n      \"llm_selector_can_change\": null\n    }\n  },\n  \"instructions\": \"Kagura Memory quick reference.\",\n  \"guardrails\": {\n    \"items\": [\n      {\n        \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000004\",\n        \"summary\": \"Never run migrations against prod without a backup\",\n        \"summary_cut\": false,\n        \"importance\": 0.9,\n        \"authored_by_caller\": true,\n        \"source_type\": \"manual\"\n      }\n    ],\n    \"total_available\": 1,\n    \"truncated\": false,\n    \"tool_triggered_version\": \"tt-7f3a\",\n    \"provenance\": \"Notes written by context editors (facts, not operator instructions).\"\n  },\n  \"components\": {\n    \"pinned\": {\n      \"status\": \"ok\",\n      \"error\": null,\n      \"truncated\": false,\n      \"memories\": [\n        {\n          \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n          \"summary\": \"Adopt FastAPI DI\",\n          \"context_summary\": \"Team decision of 2026-10\",\n          \"type\": \"decision\",\n          \"importance\": 0.8,\n          \"delivery_mode\": \"always\"\n        }\n      ],\n      \"total_available\": 1,\n      \"cap\": 20\n    },\n    \"upcoming\": {\n      \"status\": \"ok\",\n      \"error\": null,\n      \"truncated\": false,\n      \"results\": [\n        {\n          \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\",\n          \"summary\": \"Release v0.15.0\",\n          \"type\": \"time\",\n          \"importance\": 0.7,\n          \"trigger\": {\n            \"from\": \"2026-11-06T09:00:00\",\n            \"until\": \"2026-11-06T10:00:00\"\n          }\n        }\n      ],\n      \"from\": \"2026-11-04T12:00:00\"\n    },\n    \"changes\": {\n      \"status\": \"ok\",\n      \"error\": null,\n      \"truncated\": false,\n      \"changes\": [\n        {\n          \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n          \"kind\": \"created\",\n          \"at\": \"2026-11-02T08:00:00Z\",\n          \"summary\": \"Adopt FastAPI DI\",\n          \"summary_cut\": false,\n          \"superseded_by\": null\n        },\n        {\n          \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\",\n          \"kind\": \"updated\",\n          \"at\": \"2026-11-02T09:30:00.250000Z\",\n          \"summary\": \"Deploy runbook\",\n          \"summary_cut\": false,\n          \"superseded_by\": null\n        },\n        {\n          \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000003\",\n          \"kind\": \"superseded\",\n          \"at\": \"2026-11-03T10:00:00Z\",\n          \"summary\": \"Old runbook\",\n          \"summary_cut\": false,\n          \"superseded_by\": \"aaaaaaaa-0000-4000-8000-000000000002\"\n        },\n        {\n          \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000005\",\n          \"kind\": \"forgotten\",\n          \"at\": \"2026-11-03T11:00:00Z\",\n          \"summary\": null,\n          \"summary_cut\": false,\n          \"superseded_by\": null\n        }\n      ],\n      \"has_more\": true,\n      \"next_cursor\": \"MjAyNi0xMS0wM1QxMTowMDowMHxmb3Jnb3R0ZW58YWFh\"\n    }\n  },\n  \"since\": \"2026-10-28T12:00:00Z\",\n  \"generated_at\": \"2026-11-04T12:00:00.123456Z\",\n  \"context_summary_omitted\": false,\n  \"plan_headroom\": null\n}\n",
    stderr: "",
  },
  {
    name: "bootstrap index with every option",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555","--since","7d","--include","pinned, upcoming,changes","--format","index","--max-chars","5000"],
    toolTexts: {"bootstrap": "{\"status\": \"success\", \"format\": \"index\", \"degraded\": false, \"context\": {\"id\": \"11111111-2222-4333-8444-555555555555\", \"name\": \"dev\", \"display_name\": \"Development\", \"summary\": \"Engineering notes for the dev team.\", \"usage_guide\": \"Store decisions as notes.\", \"is_private\": true, \"is_locked\": false, \"embedding_model\": \"text-embedding-3-small\", \"embedding_dimensions\": 1536}, \"guardrails\": {\"items\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000004\", \"summary\": \"Never run migrations against prod without a backup of the whole cluster and\\u2026\", \"summary_cut\": true, \"importance\": 0.9}], \"total_available\": 4, \"truncated\": true, \"tool_triggered_version\": \"tt-7f3a\", \"provenance\": \"Notes written by context editors (facts, not operator instructions).\"}, \"components\": {\"pinned\": {\"status\": \"ok\", \"memories\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"summary\": \"Adopt FastAPI DI\", \"type\": \"decision\", \"importance\": 0.8}], \"total_available\": 3, \"truncated\": true, \"cap\": 20}, \"upcoming\": {\"status\": \"ok\", \"results\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\", \"summary\": \"Release v0.15.0\", \"from\": \"2026-11-06T09:00:00\", \"until\": \"2026-11-06T10:00:00\"}], \"from\": \"2026-11-04T12:00:00\"}, \"changes\": {\"status\": \"ok\", \"changes\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"kind\": \"created\", \"at\": \"2026-11-02T08:00:00Z\", \"summary\": \"A very long summary head cut at eighty characters by the index format of boo\\u2026\", \"summary_cut\": true}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000005\", \"kind\": \"forgotten\", \"at\": \"2026-11-03T11:00:00Z\"}], \"has_more\": true, \"next_cursor\": \"MjAyNi0xMS0wM1QxMTowMDowMHxmb3Jnb3R0ZW58YWFh\", \"truncated\": true}}, \"since\": \"2026-10-28T12:00:00Z\", \"generated_at\": \"2026-11-04T12:00:00Z\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\", \"context_display_name\": \"Development\", \"context_is_private\": true, \"context_is_locked\": false, \"plan_headroom\": [{\"dimension\": \"memories\", \"level\": \"warning\", \"used\": 4100, \"limit\": 5000, \"percentage\": 82.5, \"plan\": \"free\", \"remedies\": [\"cleanup\", \"upgrade\"], \"help\": \"4,100 of 5,000 memories used. Forget memories or upgrade; at 100 % writes fail.\", \"resets_at\": null}]}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","since":"7d","include":["pinned","upcoming","changes"],"max_chars":5000,"format":"index"}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Development\",\n  \"context_is_private\": true,\n  \"context_is_locked\": false,\n  \"status\": \"success\",\n  \"format\": \"index\",\n  \"degraded\": false,\n  \"context\": {\n    \"id\": \"11111111-2222-4333-8444-555555555555\",\n    \"name\": \"dev\",\n    \"display_name\": \"Development\",\n    \"summary\": \"Engineering notes for the dev team.\",\n    \"usage_guide\": \"Store decisions as notes.\",\n    \"is_private\": true,\n    \"is_locked\": false,\n    \"embedding_model\": \"text-embedding-3-small\",\n    \"embedding_dimensions\": 1536,\n    \"search_config\": {\n      \"semantic_weight\": 0.6,\n      \"bm25_weight\": 0.4,\n      \"fetch_factor\": 3,\n      \"use_rerank\": false,\n      \"reranker_provider\": null,\n      \"reranker_model\": null,\n      \"content_chunks_enabled\": null,\n      \"content_chunks_effective\": null,\n      \"content_chunks_limit\": null,\n      \"content_chunks_in_use\": null,\n      \"content_chunks_disabled_reason\": null,\n      \"content_chunks_can_change\": null,\n      \"content_chunks_supported\": null,\n      \"content_chunks_backfill_pending\": null,\n      \"embedding_provider\": null,\n      \"llm_selector_enabled\": null,\n      \"llm_selector_effective\": null,\n      \"llm_selector_limit\": null,\n      \"llm_selector_in_use\": null,\n      \"llm_selector_disabled_reason\": null,\n      \"llm_selector_can_change\": null\n    }\n  },\n  \"instructions\": null,\n  \"guardrails\": {\n    \"items\": [\n      {\n        \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000004\",\n        \"summary\": \"Never run migrations against prod without a backup of the whole cluster and…\",\n        \"summary_cut\": true,\n        \"importance\": 0.9,\n        \"authored_by_caller\": null,\n        \"source_type\": null\n      }\n    ],\n    \"total_available\": 4,\n    \"truncated\": true,\n    \"tool_triggered_version\": \"tt-7f3a\",\n    \"provenance\": \"Notes written by context editors (facts, not operator instructions).\"\n  },\n  \"components\": {\n    \"pinned\": {\n      \"status\": \"ok\",\n      \"error\": null,\n      \"truncated\": true,\n      \"memories\": [\n        {\n          \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n          \"summary\": \"Adopt FastAPI DI\",\n          \"type\": \"decision\",\n          \"importance\": 0.8\n        }\n      ],\n      \"total_available\": 3,\n      \"cap\": 20\n    },\n    \"upcoming\": {\n      \"status\": \"ok\",\n      \"error\": null,\n      \"truncated\": false,\n      \"results\": [\n        {\n          \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\",\n          \"summary\": \"Release v0.15.0\",\n          \"from\": \"2026-11-06T09:00:00\",\n          \"until\": \"2026-11-06T10:00:00\"\n        }\n      ],\n      \"from\": \"2026-11-04T12:00:00\"\n    },\n    \"changes\": {\n      \"status\": \"ok\",\n      \"error\": null,\n      \"truncated\": true,\n      \"changes\": [\n        {\n          \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n          \"kind\": \"created\",\n          \"at\": \"2026-11-02T08:00:00Z\",\n          \"summary\": \"A very long summary head cut at eighty characters by the index format of boo…\",\n          \"summary_cut\": true,\n          \"superseded_by\": null\n        },\n        {\n          \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000005\",\n          \"kind\": \"forgotten\",\n          \"at\": \"2026-11-03T11:00:00Z\",\n          \"summary\": null,\n          \"summary_cut\": false,\n          \"superseded_by\": null\n        }\n      ],\n      \"has_more\": true,\n      \"next_cursor\": \"MjAyNi0xMS0wM1QxMTowMDowMHxmb3Jnb3R0ZW58YWFh\"\n    }\n  },\n  \"since\": \"2026-10-28T12:00:00Z\",\n  \"generated_at\": \"2026-11-04T12:00:00Z\",\n  \"context_summary_omitted\": false,\n  \"plan_headroom\": [\n    {\n      \"dimension\": \"memories\",\n      \"level\": \"warning\",\n      \"used\": 4100,\n      \"limit\": 5000,\n      \"percentage\": 82.5,\n      \"plan\": \"free\",\n      \"remedies\": [\n        \"cleanup\",\n        \"upgrade\"\n      ],\n      \"help\": \"4,100 of 5,000 memories used. Forget memories or upgrade; at 100 % writes fail.\",\n      \"resets_at\": null\n    }\n  ]\n}\n",
    stderr: "",
  },
  {
    name: "bootstrap degraded lane and an unknown lane",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555","--include","pinned,changes","--since","2026-11-04"],
    toolTexts: {"bootstrap": "{\"status\": \"success\", \"degraded\": true, \"context\": {\"id\": \"11111111-2222-4333-8444-555555555555\", \"name\": \"dev\"}, \"instructions\": \"Kagura Memory quick reference.\", \"guardrails\": null, \"components\": {\"pinned\": {\"status\": \"error\", \"error\": \"component_failed\"}, \"changes\": {\"status\": \"ok\", \"changes\": [], \"has_more\": false, \"next_cursor\": null}, \"state\": {\"status\": \"ok\", \"keys\": [\"a\"]}}, \"since\": \"2026-11-04T00:00:00Z\", \"generated_at\": \"2026-11-04T12:00:00Z\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\", \"context_display_name\": \"Development\", \"context_is_private\": true, \"context_is_locked\": false}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","since":"2026-11-04","include":["pinned","changes"]}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Development\",\n  \"context_is_private\": true,\n  \"context_is_locked\": false,\n  \"status\": \"success\",\n  \"format\": null,\n  \"degraded\": true,\n  \"context\": {\n    \"id\": \"11111111-2222-4333-8444-555555555555\",\n    \"name\": \"dev\",\n    \"display_name\": null,\n    \"summary\": null,\n    \"usage_guide\": null,\n    \"is_private\": true,\n    \"is_locked\": false,\n    \"embedding_model\": null,\n    \"embedding_dimensions\": null,\n    \"search_config\": {\n      \"semantic_weight\": 0.6,\n      \"bm25_weight\": 0.4,\n      \"fetch_factor\": 3,\n      \"use_rerank\": false,\n      \"reranker_provider\": null,\n      \"reranker_model\": null,\n      \"content_chunks_enabled\": null,\n      \"content_chunks_effective\": null,\n      \"content_chunks_limit\": null,\n      \"content_chunks_in_use\": null,\n      \"content_chunks_disabled_reason\": null,\n      \"content_chunks_can_change\": null,\n      \"content_chunks_supported\": null,\n      \"content_chunks_backfill_pending\": null,\n      \"embedding_provider\": null,\n      \"llm_selector_enabled\": null,\n      \"llm_selector_effective\": null,\n      \"llm_selector_limit\": null,\n      \"llm_selector_in_use\": null,\n      \"llm_selector_disabled_reason\": null,\n      \"llm_selector_can_change\": null\n    }\n  },\n  \"instructions\": \"Kagura Memory quick reference.\",\n  \"guardrails\": null,\n  \"components\": {\n    \"pinned\": {\n      \"status\": \"error\",\n      \"error\": \"component_failed\",\n      \"truncated\": false,\n      \"memories\": [],\n      \"total_available\": null,\n      \"cap\": null\n    },\n    \"upcoming\": null,\n    \"changes\": {\n      \"status\": \"ok\",\n      \"error\": null,\n      \"truncated\": false,\n      \"changes\": [],\n      \"has_more\": false,\n      \"next_cursor\": null\n    },\n    \"state\": {\n      \"status\": \"ok\",\n      \"keys\": [\n        \"a\"\n      ]\n    }\n  },\n  \"since\": \"2026-11-04T00:00:00Z\",\n  \"generated_at\": \"2026-11-04T12:00:00Z\",\n  \"context_summary_omitted\": false,\n  \"plan_headroom\": null\n}\n",
    stderr: "",
  },
  {
    name: "bootstrap unreadable guardrails",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555","--format","full","--max-chars","10000"],
    toolTexts: {"bootstrap": "{\"status\": \"success\", \"degraded\": false, \"context\": {\"id\": \"11111111-2222-4333-8444-555555555555\", \"name\": \"dev\", \"display_name\": \"Development\", \"summary\": \"Engineering notes for the dev team.\", \"usage_guide\": \"Store decisions as notes.\", \"is_private\": true, \"is_locked\": false, \"embedding_model\": \"text-embedding-3-small\", \"embedding_dimensions\": 1536}, \"guardrails\": {\"items\": \"x\", \"total_available\": 1}, \"components\": {\"changes\": {\"status\": \"ok\", \"changes\": [], \"has_more\": false}}, \"since\": \"2026-11-04T00:00:00Z\", \"generated_at\": \"2026-11-04T12:00:00Z\"}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","max_chars":10000,"format":"full"}],
    code: 0,
    stdout: "{\n  \"context_id\": null,\n  \"context_name\": null,\n  \"context_display_name\": null,\n  \"context_is_private\": null,\n  \"context_is_locked\": null,\n  \"status\": \"success\",\n  \"format\": null,\n  \"degraded\": false,\n  \"context\": {\n    \"id\": \"11111111-2222-4333-8444-555555555555\",\n    \"name\": \"dev\",\n    \"display_name\": \"Development\",\n    \"summary\": \"Engineering notes for the dev team.\",\n    \"usage_guide\": \"Store decisions as notes.\",\n    \"is_private\": true,\n    \"is_locked\": false,\n    \"embedding_model\": \"text-embedding-3-small\",\n    \"embedding_dimensions\": 1536,\n    \"search_config\": {\n      \"semantic_weight\": 0.6,\n      \"bm25_weight\": 0.4,\n      \"fetch_factor\": 3,\n      \"use_rerank\": false,\n      \"reranker_provider\": null,\n      \"reranker_model\": null,\n      \"content_chunks_enabled\": null,\n      \"content_chunks_effective\": null,\n      \"content_chunks_limit\": null,\n      \"content_chunks_in_use\": null,\n      \"content_chunks_disabled_reason\": null,\n      \"content_chunks_can_change\": null,\n      \"content_chunks_supported\": null,\n      \"content_chunks_backfill_pending\": null,\n      \"embedding_provider\": null,\n      \"llm_selector_enabled\": null,\n      \"llm_selector_effective\": null,\n      \"llm_selector_limit\": null,\n      \"llm_selector_in_use\": null,\n      \"llm_selector_disabled_reason\": null,\n      \"llm_selector_can_change\": null\n    }\n  },\n  \"instructions\": null,\n  \"guardrails\": null,\n  \"components\": {\n    \"pinned\": null,\n    \"upcoming\": null,\n    \"changes\": {\n      \"status\": \"ok\",\n      \"error\": null,\n      \"truncated\": false,\n      \"changes\": [],\n      \"has_more\": false,\n      \"next_cursor\": null\n    }\n  },\n  \"since\": \"2026-11-04T00:00:00Z\",\n  \"generated_at\": \"2026-11-04T12:00:00Z\",\n  \"context_summary_omitted\": false,\n  \"plan_headroom\": null\n}\n",
    stderr: "",
  },
  {
    name: "bootstrap no components",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555"],
    toolTexts: {"bootstrap": "{\"status\": \"success\", \"degraded\": false, \"context\": {\"id\": \"11111111-2222-4333-8444-555555555555\", \"name\": \"dev\", \"display_name\": \"Development\", \"summary\": \"Engineering notes for the dev team.\", \"usage_guide\": \"Store decisions as notes.\", \"is_private\": true, \"is_locked\": false, \"embedding_model\": \"text-embedding-3-small\", \"embedding_dimensions\": 1536}}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555"}],
    code: 1,
    stdout: "",
    stderr: "Error: bootstrap: unexpected server response for BootstrapResponse (components: Field required). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "bootstrap context not found",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555"],
    toolTexts: {"bootstrap": "{\"status\": \"error\", \"error\": \"context_not_found\", \"message\": \"Context not found or not accessible.\"}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555"}],
    code: 1,
    stdout: "",
    stderr: "Error: bootstrap: Context not found or not accessible.\n",
  },
  {
    name: "bootstrap unknown lane",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555","--include","pinned,recall"],
    toolTexts: {},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: include must be a non-empty subset of pinned, upcoming, changes\n",
  },
  {
    name: "bootstrap blank include",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555","--include"," , "],
    toolTexts: {"bootstrap": "{\"status\": \"success\", \"degraded\": true, \"context\": {\"id\": \"11111111-2222-4333-8444-555555555555\", \"name\": \"dev\"}, \"instructions\": \"Kagura Memory quick reference.\", \"guardrails\": null, \"components\": {\"pinned\": {\"status\": \"error\", \"error\": \"component_failed\"}, \"changes\": {\"status\": \"ok\", \"changes\": [], \"has_more\": false, \"next_cursor\": null}, \"state\": {\"status\": \"ok\", \"keys\": [\"a\"]}}, \"since\": \"2026-11-04T00:00:00Z\", \"generated_at\": \"2026-11-04T12:00:00Z\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\", \"context_display_name\": \"Development\", \"context_is_private\": true, \"context_is_locked\": false}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555"}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Development\",\n  \"context_is_private\": true,\n  \"context_is_locked\": false,\n  \"status\": \"success\",\n  \"format\": null,\n  \"degraded\": true,\n  \"context\": {\n    \"id\": \"11111111-2222-4333-8444-555555555555\",\n    \"name\": \"dev\",\n    \"display_name\": null,\n    \"summary\": null,\n    \"usage_guide\": null,\n    \"is_private\": true,\n    \"is_locked\": false,\n    \"embedding_model\": null,\n    \"embedding_dimensions\": null,\n    \"search_config\": {\n      \"semantic_weight\": 0.6,\n      \"bm25_weight\": 0.4,\n      \"fetch_factor\": 3,\n      \"use_rerank\": false,\n      \"reranker_provider\": null,\n      \"reranker_model\": null,\n      \"content_chunks_enabled\": null,\n      \"content_chunks_effective\": null,\n      \"content_chunks_limit\": null,\n      \"content_chunks_in_use\": null,\n      \"content_chunks_disabled_reason\": null,\n      \"content_chunks_can_change\": null,\n      \"content_chunks_supported\": null,\n      \"content_chunks_backfill_pending\": null,\n      \"embedding_provider\": null,\n      \"llm_selector_enabled\": null,\n      \"llm_selector_effective\": null,\n      \"llm_selector_limit\": null,\n      \"llm_selector_in_use\": null,\n      \"llm_selector_disabled_reason\": null,\n      \"llm_selector_can_change\": null\n    }\n  },\n  \"instructions\": \"Kagura Memory quick reference.\",\n  \"guardrails\": null,\n  \"components\": {\n    \"pinned\": {\n      \"status\": \"error\",\n      \"error\": \"component_failed\",\n      \"truncated\": false,\n      \"memories\": [],\n      \"total_available\": null,\n      \"cap\": null\n    },\n    \"upcoming\": null,\n    \"changes\": {\n      \"status\": \"ok\",\n      \"error\": null,\n      \"truncated\": false,\n      \"changes\": [],\n      \"has_more\": false,\n      \"next_cursor\": null\n    },\n    \"state\": {\n      \"status\": \"ok\",\n      \"keys\": [\n        \"a\"\n      ]\n    }\n  },\n  \"since\": \"2026-11-04T00:00:00Z\",\n  \"generated_at\": \"2026-11-04T12:00:00Z\",\n  \"context_summary_omitted\": false,\n  \"plan_headroom\": null\n}\n",
    stderr: "",
  },
  {
    name: "bootstrap full under 10000",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555","--format","full","--max-chars","5000"],
    toolTexts: {},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: format=\"full\" needs max_chars of at least 10000; pass format=\"index\" (or omit format) under it\n",
  },
  {
    name: "bootstrap max-chars 1999",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555","--max-chars","1999"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura bootstrap [OPTIONS]\nTry 'kagura bootstrap --help' for help.\n\nError: Invalid value for '--max-chars': 1999 is not in the range 2000<=x<=100000.\n",
  },
  {
    name: "bootstrap format bogus",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555","--format","short"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura bootstrap [OPTIONS]\nTry 'kagura bootstrap --help' for help.\n\nError: Invalid value for '--format': 'short' is not one of 'full', 'index'.\n",
  },
  {
    name: "bootstrap extra arg",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555","x"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura bootstrap [OPTIONS]\nTry 'kagura bootstrap --help' for help.\n\nError: Got unexpected extra argument (x)\n",
  },
  {
    name: "bootstrap plan_headroom as v0.142.0 sends it",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555","--include","changes","--format","index","--max-chars","2000"],
    toolTexts: {"bootstrap": "{\"status\": \"success\", \"format\": \"index\", \"degraded\": false, \"components\": {\"changes\": {\"status\": \"ok\", \"changes\": [], \"has_more\": false}}, \"since\": \"2026-10-28T12:00:00Z\", \"generated_at\": \"2026-11-04T12:00:00Z\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\", \"context_display_name\": \"Development\", \"context_is_private\": true, \"context_is_locked\": false, \"plan_headroom\": [{\"dimension\": \"memories\", \"level\": \"warning\", \"used\": 4100, \"limit\": 5000, \"percentage\": 82.0, \"plan\": \"free\", \"remedies\": [\"cleanup\", \"upgrade\"]}, {\"dimension\": \"memories_per_day\", \"level\": \"critical\", \"used\": 97, \"limit\": 100, \"percentage\": 97.0, \"resets_at\": \"2026-11-05T00:00:00Z\", \"plan\": \"free\", \"remedies\": [\"wait\", \"upgrade\"], \"help\": \"Wait for the daily reset at 2026-11-05T00:00:00Z, or upgrade the plan from the workspace plan page in the web UI (Workspace settings \\u2192 Plan). At 100 % remember will be refused until the reset.\"}, {\"dimension\": \"mcp_calls_per_day\", \"level\": \"warning\", \"used\": 8123, \"limit\": 10000, \"percentage\": 81.2, \"resets_at\": \"2026-11-05T00:00:00Z\", \"remedies\": [\"wait\", \"admin\"]}]}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","include":["changes"],"max_chars":2000,"format":"index"}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Development\",\n  \"context_is_private\": true,\n  \"context_is_locked\": false,\n  \"status\": \"success\",\n  \"format\": \"index\",\n  \"degraded\": false,\n  \"context\": null,\n  \"instructions\": null,\n  \"guardrails\": null,\n  \"components\": {\n    \"pinned\": null,\n    \"upcoming\": null,\n    \"changes\": {\n      \"status\": \"ok\",\n      \"error\": null,\n      \"truncated\": false,\n      \"changes\": [],\n      \"has_more\": false,\n      \"next_cursor\": null\n    }\n  },\n  \"since\": \"2026-10-28T12:00:00Z\",\n  \"generated_at\": \"2026-11-04T12:00:00Z\",\n  \"context_summary_omitted\": false,\n  \"plan_headroom\": [\n    {\n      \"dimension\": \"memories\",\n      \"level\": \"warning\",\n      \"used\": 4100,\n      \"limit\": 5000,\n      \"percentage\": 82.0,\n      \"plan\": \"free\",\n      \"remedies\": [\n        \"cleanup\",\n        \"upgrade\"\n      ],\n      \"help\": null,\n      \"resets_at\": null\n    },\n    {\n      \"dimension\": \"memories_per_day\",\n      \"level\": \"critical\",\n      \"used\": 97,\n      \"limit\": 100,\n      \"percentage\": 97.0,\n      \"plan\": \"free\",\n      \"remedies\": [\n        \"wait\",\n        \"upgrade\"\n      ],\n      \"help\": \"Wait for the daily reset at 2026-11-05T00:00:00Z, or upgrade the plan from the workspace plan page in the web UI (Workspace settings → Plan). At 100 % remember will be refused until the reset.\",\n      \"resets_at\": \"2026-11-05T00:00:00Z\"\n    },\n    {\n      \"dimension\": \"mcp_calls_per_day\",\n      \"level\": \"warning\",\n      \"used\": 8123,\n      \"limit\": 10000,\n      \"percentage\": 81.2,\n      \"plan\": null,\n      \"remedies\": [\n        \"wait\",\n        \"admin\"\n      ],\n      \"help\": null,\n      \"resets_at\": \"2026-11-05T00:00:00Z\"\n    }\n  ]\n}\n",
    stderr: "",
  },
  {
    name: "bootstrap plan_headroom unreadable entries",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555","--include","changes","--format","index","--max-chars","2000"],
    toolTexts: {"bootstrap": "{\"status\": \"success\", \"format\": \"index\", \"degraded\": false, \"components\": {\"changes\": {\"status\": \"ok\", \"changes\": [], \"has_more\": false}}, \"since\": \"2026-10-28T12:00:00Z\", \"generated_at\": \"2026-11-04T12:00:00Z\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\", \"context_display_name\": \"Development\", \"context_is_private\": true, \"context_is_locked\": false, \"plan_headroom\": [{\"dimension\": \"memories_per_day\", \"level\": \"critical\", \"limit\": 100, \"percentage\": 97.0, \"resets_at\": \"2026-11-05T00:00:00Z\", \"plan\": \"free\", \"remedies\": [\"wait\", \"upgrade\"], \"help\": \"Wait for the daily reset at 2026-11-05T00:00:00Z, or upgrade the plan from the workspace plan page in the web UI (Workspace settings \\u2192 Plan). At 100 % remember will be refused until the reset.\"}, null, \"x\", {\"dimension\": \"mcp_calls_per_day\", \"level\": \"warning\", \"used\": 8123, \"limit\": 10000, \"percentage\": \"high\", \"resets_at\": \"2026-11-05T00:00:00Z\", \"remedies\": [\"wait\", \"admin\"]}, {\"dimension\": \"memories\", \"level\": \"warning\", \"used\": 4100, \"limit\": 5000, \"percentage\": 82.0, \"plan\": \"free\", \"remedies\": [\"cleanup\", \"upgrade\"], \"addon\": \"storage\"}]}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","include":["changes"],"max_chars":2000,"format":"index"}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Development\",\n  \"context_is_private\": true,\n  \"context_is_locked\": false,\n  \"status\": \"success\",\n  \"format\": \"index\",\n  \"degraded\": false,\n  \"context\": null,\n  \"instructions\": null,\n  \"guardrails\": null,\n  \"components\": {\n    \"pinned\": null,\n    \"upcoming\": null,\n    \"changes\": {\n      \"status\": \"ok\",\n      \"error\": null,\n      \"truncated\": false,\n      \"changes\": [],\n      \"has_more\": false,\n      \"next_cursor\": null\n    }\n  },\n  \"since\": \"2026-10-28T12:00:00Z\",\n  \"generated_at\": \"2026-11-04T12:00:00Z\",\n  \"context_summary_omitted\": false,\n  \"plan_headroom\": [\n    {\n      \"dimension\": \"memories\",\n      \"level\": \"warning\",\n      \"used\": 4100,\n      \"limit\": 5000,\n      \"percentage\": 82.0,\n      \"plan\": \"free\",\n      \"remedies\": [\n        \"cleanup\",\n        \"upgrade\"\n      ],\n      \"help\": null,\n      \"resets_at\": null\n    }\n  ]\n}\n",
    stderr: "",
  },
  {
    name: "bootstrap plan_headroom nothing readable",
    argv: ["bootstrap","-c","11111111-2222-4333-8444-555555555555","--include","changes","--format","index","--max-chars","2000"],
    toolTexts: {"bootstrap": "{\"status\": \"success\", \"format\": \"index\", \"degraded\": false, \"components\": {\"changes\": {\"status\": \"ok\", \"changes\": [], \"has_more\": false}}, \"since\": \"2026-10-28T12:00:00Z\", \"generated_at\": \"2026-11-04T12:00:00Z\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\", \"context_display_name\": \"Development\", \"context_is_private\": true, \"context_is_locked\": false, \"plan_headroom\": [{\"dimension\": \"memories_per_day\", \"level\": \"critical\", \"limit\": 100, \"percentage\": 97.0, \"resets_at\": \"2026-11-05T00:00:00Z\", \"plan\": \"free\", \"remedies\": [\"wait\", \"upgrade\"], \"help\": \"Wait for the daily reset at 2026-11-05T00:00:00Z, or upgrade the plan from the workspace plan page in the web UI (Workspace settings \\u2192 Plan). At 100 % remember will be refused until the reset.\"}]}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","include":["changes"],"max_chars":2000,"format":"index"}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Development\",\n  \"context_is_private\": true,\n  \"context_is_locked\": false,\n  \"status\": \"success\",\n  \"format\": \"index\",\n  \"degraded\": false,\n  \"context\": null,\n  \"instructions\": null,\n  \"guardrails\": null,\n  \"components\": {\n    \"pinned\": null,\n    \"upcoming\": null,\n    \"changes\": {\n      \"status\": \"ok\",\n      \"error\": null,\n      \"truncated\": false,\n      \"changes\": [],\n      \"has_more\": false,\n      \"next_cursor\": null\n    }\n  },\n  \"since\": \"2026-10-28T12:00:00Z\",\n  \"generated_at\": \"2026-11-04T12:00:00Z\",\n  \"context_summary_omitted\": false,\n  \"plan_headroom\": null\n}\n",
    stderr: "",
  },
  {
    name: "changes page",
    argv: ["changes","2026-11-01T00:00:00Z","-c","11111111-2222-4333-8444-555555555555"],
    toolTexts: {"changes_since": "{\"status\": \"success\", \"changes\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"kind\": \"created\", \"at\": \"2026-11-02T08:00:00Z\", \"summary\": \"Adopt FastAPI DI\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\", \"kind\": \"updated\", \"at\": \"2026-11-02T09:30:00.250000Z\", \"summary\": \"Deploy runbook\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000003\", \"kind\": \"superseded\", \"at\": \"2026-11-03T10:00:00Z\", \"summary\": \"Old runbook\", \"superseded_by\": \"aaaaaaaa-0000-4000-8000-000000000002\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000005\", \"kind\": \"forgotten\", \"at\": \"2026-11-03T11:00:00Z\"}], \"count\": 4, \"has_more\": true, \"next_cursor\": \"MjAyNi0xMS0wM1QxMTowMDowMHxmb3Jnb3R0ZW58YWFh\", \"since\": \"2026-11-01T00:00:00Z\", \"until\": \"2026-11-04T12:00:00Z\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\", \"context_display_name\": \"Development\", \"context_is_private\": true, \"context_is_locked\": false}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","since":"2026-11-01T00:00:00Z"}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Development\",\n  \"context_is_private\": true,\n  \"context_is_locked\": false,\n  \"status\": \"success\",\n  \"changes\": [\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n      \"kind\": \"created\",\n      \"at\": \"2026-11-02T08:00:00Z\",\n      \"summary\": \"Adopt FastAPI DI\",\n      \"summary_cut\": false,\n      \"superseded_by\": null\n    },\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\",\n      \"kind\": \"updated\",\n      \"at\": \"2026-11-02T09:30:00.250000Z\",\n      \"summary\": \"Deploy runbook\",\n      \"summary_cut\": false,\n      \"superseded_by\": null\n    },\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000003\",\n      \"kind\": \"superseded\",\n      \"at\": \"2026-11-03T10:00:00Z\",\n      \"summary\": \"Old runbook\",\n      \"summary_cut\": false,\n      \"superseded_by\": \"aaaaaaaa-0000-4000-8000-000000000002\"\n    },\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000005\",\n      \"kind\": \"forgotten\",\n      \"at\": \"2026-11-03T11:00:00Z\",\n      \"summary\": null,\n      \"summary_cut\": false,\n      \"superseded_by\": null\n    }\n  ],\n  \"count\": 4,\n  \"has_more\": true,\n  \"next_cursor\": \"MjAyNi0xMS0wM1QxMTowMDowMHxmb3Jnb3R0ZW58YWFh\",\n  \"since\": \"2026-11-01T00:00:00Z\",\n  \"until\": \"2026-11-04T12:00:00Z\",\n  \"session_id\": null,\n  \"by_me\": false,\n  \"truncated\": false\n}\n",
    stderr: "",
  },
  {
    name: "changes every option",
    argv: ["changes","2026-11-04T09:00:00Z","-c","11111111-2222-4333-8444-555555555555","--until","2026-11-04T10:00:00Z","--kinds","created, restored","--cursor","abc","--limit","20","--session-id","sess_3f2a9c","--by-me","--max-chars","20000"],
    toolTexts: {"changes_since": "{\"status\": \"success\", \"changes\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"kind\": \"created\", \"at\": \"2026-11-04T09:01:00Z\", \"summary\": \"Adopt FastAPI DI\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000005\", \"kind\": \"restored\", \"at\": \"2026-11-04T09:05:00Z\"}], \"count\": 2, \"has_more\": false, \"next_cursor\": null, \"since\": \"2026-11-04T09:00:00Z\", \"until\": \"2026-11-04T10:00:00Z\", \"session_id\": \"sess_3f2a9c\", \"by_me\": true, \"truncated\": true, \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\", \"context_display_name\": \"Development\", \"context_is_private\": true, \"context_is_locked\": false}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","since":"2026-11-04T09:00:00Z","until":"2026-11-04T10:00:00Z","kinds":["created","restored"],"cursor":"abc","limit":20,"session_id":"sess_3f2a9c","by_me":true,"max_chars":20000}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Development\",\n  \"context_is_private\": true,\n  \"context_is_locked\": false,\n  \"status\": \"success\",\n  \"changes\": [\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n      \"kind\": \"created\",\n      \"at\": \"2026-11-04T09:01:00Z\",\n      \"summary\": \"Adopt FastAPI DI\",\n      \"summary_cut\": false,\n      \"superseded_by\": null\n    },\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000005\",\n      \"kind\": \"restored\",\n      \"at\": \"2026-11-04T09:05:00Z\",\n      \"summary\": null,\n      \"summary_cut\": false,\n      \"superseded_by\": null\n    }\n  ],\n  \"count\": 2,\n  \"has_more\": false,\n  \"next_cursor\": null,\n  \"since\": \"2026-11-04T09:00:00Z\",\n  \"until\": \"2026-11-04T10:00:00Z\",\n  \"session_id\": \"sess_3f2a9c\",\n  \"by_me\": true,\n  \"truncated\": true\n}\n",
    stderr: "",
  },
  {
    name: "changes blank kinds",
    argv: ["changes","2026-11-01","-c","11111111-2222-4333-8444-555555555555","--kinds",""],
    toolTexts: {"changes_since": "{\"status\": \"success\", \"changes\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"kind\": \"created\", \"at\": \"2026-11-02T08:00:00Z\", \"summary\": \"Adopt FastAPI DI\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\", \"kind\": \"updated\", \"at\": \"2026-11-02T09:30:00.250000Z\", \"summary\": \"Deploy runbook\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000003\", \"kind\": \"superseded\", \"at\": \"2026-11-03T10:00:00Z\", \"summary\": \"Old runbook\", \"superseded_by\": \"aaaaaaaa-0000-4000-8000-000000000002\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000005\", \"kind\": \"forgotten\", \"at\": \"2026-11-03T11:00:00Z\"}], \"count\": 4, \"has_more\": true, \"next_cursor\": \"MjAyNi0xMS0wM1QxMTowMDowMHxmb3Jnb3R0ZW58YWFh\", \"since\": \"2026-11-01T00:00:00Z\", \"until\": \"2026-11-04T12:00:00Z\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\", \"context_display_name\": \"Development\", \"context_is_private\": true, \"context_is_locked\": false}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","since":"2026-11-01"}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Development\",\n  \"context_is_private\": true,\n  \"context_is_locked\": false,\n  \"status\": \"success\",\n  \"changes\": [\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n      \"kind\": \"created\",\n      \"at\": \"2026-11-02T08:00:00Z\",\n      \"summary\": \"Adopt FastAPI DI\",\n      \"summary_cut\": false,\n      \"superseded_by\": null\n    },\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\",\n      \"kind\": \"updated\",\n      \"at\": \"2026-11-02T09:30:00.250000Z\",\n      \"summary\": \"Deploy runbook\",\n      \"summary_cut\": false,\n      \"superseded_by\": null\n    },\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000003\",\n      \"kind\": \"superseded\",\n      \"at\": \"2026-11-03T10:00:00Z\",\n      \"summary\": \"Old runbook\",\n      \"summary_cut\": false,\n      \"superseded_by\": \"aaaaaaaa-0000-4000-8000-000000000002\"\n    },\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000005\",\n      \"kind\": \"forgotten\",\n      \"at\": \"2026-11-03T11:00:00Z\",\n      \"summary\": null,\n      \"summary_cut\": false,\n      \"superseded_by\": null\n    }\n  ],\n  \"count\": 4,\n  \"has_more\": true,\n  \"next_cursor\": \"MjAyNi0xMS0wM1QxMTowMDowMHxmb3Jnb3R0ZW58YWFh\",\n  \"since\": \"2026-11-01T00:00:00Z\",\n  \"until\": \"2026-11-04T12:00:00Z\",\n  \"session_id\": null,\n  \"by_me\": false,\n  \"truncated\": false\n}\n",
    stderr: "",
  },
  {
    name: "changes no has_more",
    argv: ["changes","2026-11-01","-c","11111111-2222-4333-8444-555555555555"],
    toolTexts: {"changes_since": "{\"status\": \"success\", \"changes\": []}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","since":"2026-11-01"}],
    code: 1,
    stdout: "",
    stderr: "Error: changes_since: unexpected server response for ChangesSinceResponse (has_more: Field required). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "changes refused",
    argv: ["changes","2026-11-01","-c","11111111-2222-4333-8444-555555555555","--until","2026-10-01"],
    toolTexts: {"changes_since": "{\"status\": \"error\", \"error\": \"validation_error\", \"message\": \"until must be later than since.\"}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","since":"2026-11-01","until":"2026-10-01"}],
    code: 1,
    stdout: "",
    stderr: "Error: changes_since failed (validation_error): until must be later than since.\n",
  },
  {
    name: "changes missing SINCE",
    argv: ["changes","-c","11111111-2222-4333-8444-555555555555"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura changes [OPTIONS] SINCE\nTry 'kagura changes --help' for help.\n\nError: Missing argument 'SINCE'.\n",
  },
  {
    name: "changes limit 0",
    argv: ["changes","2026-11-01","-c","11111111-2222-4333-8444-555555555555","--limit","0"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura changes [OPTIONS] SINCE\nTry 'kagura changes --help' for help.\n\nError: Invalid value for '--limit': 0 is not in the range 1<=x<=100.\n",
  },
  {
    name: "changes limit 101",
    argv: ["changes","2026-11-01","-c","11111111-2222-4333-8444-555555555555","--limit","101"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura changes [OPTIONS] SINCE\nTry 'kagura changes --help' for help.\n\nError: Invalid value for '--limit': 101 is not in the range 1<=x<=100.\n",
  },
  {
    name: "changes max-chars 9999",
    argv: ["changes","2026-11-01","-c","11111111-2222-4333-8444-555555555555","--max-chars","9999"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura changes [OPTIONS] SINCE\nTry 'kagura changes --help' for help.\n\nError: Invalid value for '--max-chars': 9999 is not in the range 10000<=x<=100000.\n",
  },
  {
    name: "changes limit not int",
    argv: ["changes","2026-11-01","-c","11111111-2222-4333-8444-555555555555","--limit","x"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura changes [OPTIONS] SINCE\nTry 'kagura changes --help' for help.\n\nError: Invalid value for '--limit': 'x' is not a valid integer range.\n",
  },
  {
    name: "list every option",
    argv: ["list","-c","11111111-2222-4333-8444-555555555555","--filters","{\"type\": \"task\", \"details.status\": \"open\", \"tags\": [\"status:open\"]}","--order-by","observed_at","--direction","asc","--cursor","50","--limit","10","--details","--max-chars","30000"],
    toolTexts: {"list": "{\"status\": \"success\", \"memories\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"summary\": \"Fix flaky upload test\", \"type\": \"task\", \"importance\": 0.6, \"scope\": \"persistent\", \"tags\": [\"status:open\"], \"delivery_mode\": \"on_recall\", \"source_type\": null, \"created_at\": \"2026-11-01T08:00:00Z\", \"updated_at\": \"2026-11-02T08:00:00Z\", \"version\": 3, \"observed_at\": \"2026-10-31\", \"details\": {\"status\": \"open\", \"estimate\": 2}}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\", \"summary\": \"Rotate staging keys\", \"type\": \"task\", \"importance\": 0.4, \"scope\": \"persistent\", \"tags\": [], \"delivery_mode\": \"on_recall\", \"source_type\": \"manual\", \"created_at\": \"2026-11-01T09:00:00Z\", \"updated_at\": null, \"version\": 1, \"details\": {\"status\": \"open\"}}], \"count\": 2, \"total\": 12, \"has_more\": true, \"next_cursor\": \"60\", \"order_by\": \"observed_at\", \"direction\": \"asc\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\", \"context_display_name\": \"Development\", \"context_is_private\": true, \"context_is_locked\": false}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","filters":{"type":"task","details.status":"open","tags":["status:open"]},"order_by":"observed_at","direction":"asc","cursor":"50","limit":10,"include_details":true,"max_chars":30000}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Development\",\n  \"context_is_private\": true,\n  \"context_is_locked\": false,\n  \"status\": \"success\",\n  \"memories\": [\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n      \"summary\": \"Fix flaky upload test\",\n      \"type\": \"task\",\n      \"importance\": 0.6,\n      \"scope\": \"persistent\",\n      \"tags\": [\n        \"status:open\"\n      ],\n      \"delivery_mode\": \"on_recall\",\n      \"source_type\": null,\n      \"created_at\": \"2026-11-01T08:00:00Z\",\n      \"updated_at\": \"2026-11-02T08:00:00Z\",\n      \"version\": 3,\n      \"observed_at\": \"2026-10-31\",\n      \"details\": {\n        \"status\": \"open\",\n        \"estimate\": 2\n      }\n    },\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\",\n      \"summary\": \"Rotate staging keys\",\n      \"type\": \"task\",\n      \"importance\": 0.4,\n      \"scope\": \"persistent\",\n      \"tags\": [],\n      \"delivery_mode\": \"on_recall\",\n      \"source_type\": \"manual\",\n      \"created_at\": \"2026-11-01T09:00:00Z\",\n      \"updated_at\": null,\n      \"version\": 1,\n      \"details\": {\n        \"status\": \"open\"\n      }\n    }\n  ],\n  \"count\": 2,\n  \"total\": 12,\n  \"has_more\": true,\n  \"next_cursor\": \"60\",\n  \"order_by\": \"observed_at\",\n  \"direction\": \"asc\",\n  \"truncated\": false,\n  \"details_omitted\": false\n}\n",
    stderr: "",
  },
  {
    name: "list cut page",
    argv: ["list","-c","11111111-2222-4333-8444-555555555555"],
    toolTexts: {"list": "{\"status\": \"success\", \"memories\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"summary\": \"Fix flaky upload test\", \"type\": \"task\", \"importance\": 0.6, \"scope\": \"persistent\", \"tags\": [\"status:open\"], \"delivery_mode\": \"on_recall\", \"source_type\": null, \"created_at\": \"2026-11-01T08:00:00Z\", \"updated_at\": \"2026-11-02T08:00:00Z\", \"version\": 3}], \"count\": 1, \"total\": 12, \"has_more\": true, \"next_cursor\": \"1\", \"order_by\": \"updated_at\", \"direction\": \"desc\", \"truncated\": true, \"details_omitted\": true, \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\", \"context_display_name\": \"Development\", \"context_is_private\": true, \"context_is_locked\": false}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555"}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Development\",\n  \"context_is_private\": true,\n  \"context_is_locked\": false,\n  \"status\": \"success\",\n  \"memories\": [\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n      \"summary\": \"Fix flaky upload test\",\n      \"type\": \"task\",\n      \"importance\": 0.6,\n      \"scope\": \"persistent\",\n      \"tags\": [\n        \"status:open\"\n      ],\n      \"delivery_mode\": \"on_recall\",\n      \"source_type\": null,\n      \"created_at\": \"2026-11-01T08:00:00Z\",\n      \"updated_at\": \"2026-11-02T08:00:00Z\",\n      \"version\": 3\n    }\n  ],\n  \"count\": 1,\n  \"total\": 12,\n  \"has_more\": true,\n  \"next_cursor\": \"1\",\n  \"order_by\": \"updated_at\",\n  \"direction\": \"desc\",\n  \"truncated\": true,\n  \"details_omitted\": true\n}\n",
    stderr: "",
  },
  {
    name: "list blank filters",
    argv: ["list","-c","11111111-2222-4333-8444-555555555555","--filters","  "],
    toolTexts: {"list": "{\"status\": \"success\", \"memories\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"summary\": \"Fix flaky upload test\", \"type\": \"task\", \"importance\": 0.6, \"scope\": \"persistent\", \"tags\": [\"status:open\"], \"delivery_mode\": \"on_recall\", \"source_type\": null, \"created_at\": \"2026-11-01T08:00:00Z\", \"updated_at\": \"2026-11-02T08:00:00Z\", \"version\": 3}], \"count\": 1, \"total\": 12, \"has_more\": true, \"next_cursor\": \"1\", \"order_by\": \"updated_at\", \"direction\": \"desc\", \"truncated\": true, \"details_omitted\": true, \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\", \"context_display_name\": \"Development\", \"context_is_private\": true, \"context_is_locked\": false}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555"}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Development\",\n  \"context_is_private\": true,\n  \"context_is_locked\": false,\n  \"status\": \"success\",\n  \"memories\": [\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n      \"summary\": \"Fix flaky upload test\",\n      \"type\": \"task\",\n      \"importance\": 0.6,\n      \"scope\": \"persistent\",\n      \"tags\": [\n        \"status:open\"\n      ],\n      \"delivery_mode\": \"on_recall\",\n      \"source_type\": null,\n      \"created_at\": \"2026-11-01T08:00:00Z\",\n      \"updated_at\": \"2026-11-02T08:00:00Z\",\n      \"version\": 3\n    }\n  ],\n  \"count\": 1,\n  \"total\": 12,\n  \"has_more\": true,\n  \"next_cursor\": \"1\",\n  \"order_by\": \"updated_at\",\n  \"direction\": \"desc\",\n  \"truncated\": true,\n  \"details_omitted\": true\n}\n",
    stderr: "",
  },
  {
    name: "list empty filters object",
    argv: ["list","-c","11111111-2222-4333-8444-555555555555","--filters","{}"],
    toolTexts: {"list": "{\"status\": \"success\", \"memories\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"summary\": \"Fix flaky upload test\", \"type\": \"task\", \"importance\": 0.6, \"scope\": \"persistent\", \"tags\": [\"status:open\"], \"delivery_mode\": \"on_recall\", \"source_type\": null, \"created_at\": \"2026-11-01T08:00:00Z\", \"updated_at\": \"2026-11-02T08:00:00Z\", \"version\": 3}], \"count\": 1, \"total\": 12, \"has_more\": true, \"next_cursor\": \"1\", \"order_by\": \"updated_at\", \"direction\": \"desc\", \"truncated\": true, \"details_omitted\": true, \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\", \"context_display_name\": \"Development\", \"context_is_private\": true, \"context_is_locked\": false}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","filters":{}}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": \"Development\",\n  \"context_is_private\": true,\n  \"context_is_locked\": false,\n  \"status\": \"success\",\n  \"memories\": [\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n      \"summary\": \"Fix flaky upload test\",\n      \"type\": \"task\",\n      \"importance\": 0.6,\n      \"scope\": \"persistent\",\n      \"tags\": [\n        \"status:open\"\n      ],\n      \"delivery_mode\": \"on_recall\",\n      \"source_type\": null,\n      \"created_at\": \"2026-11-01T08:00:00Z\",\n      \"updated_at\": \"2026-11-02T08:00:00Z\",\n      \"version\": 3\n    }\n  ],\n  \"count\": 1,\n  \"total\": 12,\n  \"has_more\": true,\n  \"next_cursor\": \"1\",\n  \"order_by\": \"updated_at\",\n  \"direction\": \"desc\",\n  \"truncated\": true,\n  \"details_omitted\": true\n}\n",
    stderr: "",
  },
  {
    name: "list no total",
    argv: ["list","-c","11111111-2222-4333-8444-555555555555"],
    toolTexts: {"list": "{\"status\": \"success\", \"memories\": [], \"has_more\": false}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555"}],
    code: 1,
    stdout: "",
    stderr: "Error: list: unexpected server response for ListMatchingResponse (total: Field required). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "list filters not json",
    argv: ["list","-c","11111111-2222-4333-8444-555555555555","--filters","{type: task}"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura list [OPTIONS]\nTry 'kagura list --help' for help.\n\nError: Invalid JSON for --filters: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)\n",
  },
  {
    name: "list filters not an object",
    argv: ["list","-c","11111111-2222-4333-8444-555555555555","--filters","[\"task\"]"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura list [OPTIONS]\nTry 'kagura list --help' for help.\n\nError: --filters must be a JSON object, got list. Example: --filters '{\"type\": \"task\"}'\n",
  },
  {
    name: "list filters a string",
    argv: ["list","-c","11111111-2222-4333-8444-555555555555","--filters","\"task\""],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura list [OPTIONS]\nTry 'kagura list --help' for help.\n\nError: --filters must be a JSON object, got str. Example: --filters '{\"type\": \"task\"}'\n",
  },
  {
    name: "list order-by bogus",
    argv: ["list","-c","11111111-2222-4333-8444-555555555555","--order-by","score"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura list [OPTIONS]\nTry 'kagura list --help' for help.\n\nError: Invalid value for '--order-by': 'score' is not one of 'updated_at', 'created_at', 'importance', 'observed_at'.\n",
    ourStderr: "Usage: kagura list [OPTIONS]\nTry 'kagura list --help' for help.\n\nError: Invalid value for '--order-by': 'score' is not one of 'updated_at', 'created_at', 'importance', 'observed_at', 'event_start'.\n",
  },
  {
    name: "list direction bogus",
    argv: ["list","-c","11111111-2222-4333-8444-555555555555","--direction","up"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura list [OPTIONS]\nTry 'kagura list --help' for help.\n\nError: Invalid value for '--direction': 'up' is not one of 'asc', 'desc'.\n",
  },
  {
    name: "list refused",
    argv: ["list","-c","11111111-2222-4333-8444-555555555555","--filters","{\"colour\": \"red\"}"],
    toolTexts: {"list": "{\"status\": \"error\", \"error\": \"validation_error\", \"message\": \"Unknown filter: colour.\"}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","filters":{"colour":"red"}}],
    code: 1,
    stdout: "",
    stderr: "Error: list failed (validation_error): Unknown filter: colour.\n",
  },
  {
    name: "forget ids partial",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","--ids","aaaaaaaa-0000-4000-8000-000000000001, aaaaaaaa-0000-4000-8000-000000000002,aaaaaaaa-0000-4000-8000-000000000003"],
    toolTexts: {"forget": "{\"status\": \"partial\", \"deleted_count\": 1, \"memory_ids\": [\"aaaaaaaa-0000-4000-8000-000000000001\"], \"results\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"status\": \"deleted\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\", \"status\": \"skipped\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000003\", \"status\": \"error\", \"error\": \"not_attempted\", \"message\": \"The call's time budget ran out before this id; send it again.\"}], \"count\": 3, \"succeeded\": 1, \"skipped\": 1, \"failed\": 1, \"session_id\": \"sess_3f2a9c\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\"}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","memory_ids":["aaaaaaaa-0000-4000-8000-000000000001","aaaaaaaa-0000-4000-8000-000000000002","aaaaaaaa-0000-4000-8000-000000000003"]}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": null,\n  \"context_is_locked\": null,\n  \"status\": \"partial\",\n  \"deleted_count\": 1,\n  \"memory_ids\": [\n    \"aaaaaaaa-0000-4000-8000-000000000001\"\n  ],\n  \"results\": [\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n      \"status\": \"deleted\",\n      \"error\": null,\n      \"message\": null,\n      \"correlation_id\": null\n    },\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\",\n      \"status\": \"skipped\",\n      \"error\": null,\n      \"message\": null,\n      \"correlation_id\": null\n    },\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000003\",\n      \"status\": \"error\",\n      \"error\": \"not_attempted\",\n      \"message\": \"The call's time budget ran out before this id; send it again.\",\n      \"correlation_id\": null\n    }\n  ],\n  \"count\": 3,\n  \"succeeded\": 1,\n  \"skipped\": 1,\n  \"failed\": 1,\n  \"session_id\": \"sess_3f2a9c\"\n}\n",
    stderr: "",
  },
  {
    name: "forget ids batch_failed",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","--ids","aaaaaaaa-0000-4000-8000-000000000001,aaaaaaaa-0000-4000-8000-000000000002"],
    toolTexts: {"forget": "{\"status\": \"error\", \"error\": \"batch_failed\", \"message\": \"No id was deleted; see results.\", \"deleted_count\": 0, \"memory_ids\": [], \"results\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"status\": \"error\", \"error\": \"internal_error\", \"message\": \"memory delete failed\", \"correlation_id\": \"c0ffee\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\", \"status\": \"error\", \"error\": \"not_attempted\", \"message\": \"The call's time budget ran out before this id; send it again.\"}], \"count\": 2, \"succeeded\": 0, \"skipped\": 0, \"failed\": 2, \"session_id\": \"sess_3f2a9c\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\"}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","memory_ids":["aaaaaaaa-0000-4000-8000-000000000001","aaaaaaaa-0000-4000-8000-000000000002"]}],
    code: 1,
    stdout: "",
    stderr: "aaaaaaaa-0000-4000-8000-000000000001 error internal_error\naaaaaaaa-0000-4000-8000-000000000002 error not_attempted\nError: forget failed (batch_failed): No id was deleted; see results.\n",
  },
  {
    name: "forget ids with -k",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","--ids","aaaaaaaa-0000-4000-8000-000000000001","-k","5"],
    toolTexts: {},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: -k applies to --query only, not to --ids\n",
  },
  {
    name: "forget ids with -m",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","--ids","aaaaaaaa-0000-4000-8000-000000000001","-m","aaaaaaaa-0000-4000-8000-000000000002"],
    toolTexts: {},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: Use only one of --memory-id, --ids or --query\n",
  },
  {
    name: "forget ids with -q",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","--ids","aaaaaaaa-0000-4000-8000-000000000001","-q","old"],
    toolTexts: {},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: Use only one of --memory-id, --ids or --query\n",
  },
  {
    name: "forget ids blank",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","--ids"," , "],
    toolTexts: {},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: --ids needs at least one memory ID\n",
  },
  {
    name: "forget ids empty",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","--ids",""],
    toolTexts: {},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: --ids needs at least one memory ID\n",
  },
  {
    name: "forget ids not a uuid",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","--ids","aaaaaaaa-0000-4000-8000-000000000001,abc-123"],
    toolTexts: {},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: memory_ids[1] is not a memory UUID\n",
  },
  {
    name: "forget ids repeated",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","--ids","aaaaaaaa-0000-4000-8000-000000000001,AAAAAAAA-0000-4000-8000-000000000001"],
    toolTexts: {},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: memory_ids lists aaaaaaaa-0000-4000-8000-000000000001 more than once\n",
  },
  {
    name: "forget ids braces",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","--ids","{aaaaaaaa-0000-4000-8000-000000000001}"],
    toolTexts: {"forget": "{\"status\": \"partial\", \"deleted_count\": 1, \"memory_ids\": [\"aaaaaaaa-0000-4000-8000-000000000001\"], \"results\": [{\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"status\": \"deleted\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\", \"status\": \"skipped\"}, {\"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000003\", \"status\": \"error\", \"error\": \"not_attempted\", \"message\": \"The call's time budget ran out before this id; send it again.\"}], \"count\": 3, \"succeeded\": 1, \"skipped\": 1, \"failed\": 1, \"session_id\": \"sess_3f2a9c\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"context_name\": \"dev\"}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","memory_ids":["{aaaaaaaa-0000-4000-8000-000000000001}"]}],
    code: 0,
    stdout: "{\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": null,\n  \"context_is_locked\": null,\n  \"status\": \"partial\",\n  \"deleted_count\": 1,\n  \"memory_ids\": [\n    \"aaaaaaaa-0000-4000-8000-000000000001\"\n  ],\n  \"results\": [\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\",\n      \"status\": \"deleted\",\n      \"error\": null,\n      \"message\": null,\n      \"correlation_id\": null\n    },\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000002\",\n      \"status\": \"skipped\",\n      \"error\": null,\n      \"message\": null,\n      \"correlation_id\": null\n    },\n    {\n      \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000003\",\n      \"status\": \"error\",\n      \"error\": \"not_attempted\",\n      \"message\": \"The call's time budget ran out before this id; send it again.\",\n      \"correlation_id\": null\n    }\n  ],\n  \"count\": 3,\n  \"succeeded\": 1,\n  \"skipped\": 1,\n  \"failed\": 1,\n  \"session_id\": \"sess_3f2a9c\"\n}\n",
    stderr: "",
  },
  {
    name: "forget ids 51",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","--ids","aaaaaaaa-0000-4000-8000-000000000000,aaaaaaaa-0000-4000-8000-000000000001,aaaaaaaa-0000-4000-8000-000000000002,aaaaaaaa-0000-4000-8000-000000000003,aaaaaaaa-0000-4000-8000-000000000004,aaaaaaaa-0000-4000-8000-000000000005,aaaaaaaa-0000-4000-8000-000000000006,aaaaaaaa-0000-4000-8000-000000000007,aaaaaaaa-0000-4000-8000-000000000008,aaaaaaaa-0000-4000-8000-000000000009,aaaaaaaa-0000-4000-8000-000000000010,aaaaaaaa-0000-4000-8000-000000000011,aaaaaaaa-0000-4000-8000-000000000012,aaaaaaaa-0000-4000-8000-000000000013,aaaaaaaa-0000-4000-8000-000000000014,aaaaaaaa-0000-4000-8000-000000000015,aaaaaaaa-0000-4000-8000-000000000016,aaaaaaaa-0000-4000-8000-000000000017,aaaaaaaa-0000-4000-8000-000000000018,aaaaaaaa-0000-4000-8000-000000000019,aaaaaaaa-0000-4000-8000-000000000020,aaaaaaaa-0000-4000-8000-000000000021,aaaaaaaa-0000-4000-8000-000000000022,aaaaaaaa-0000-4000-8000-000000000023,aaaaaaaa-0000-4000-8000-000000000024,aaaaaaaa-0000-4000-8000-000000000025,aaaaaaaa-0000-4000-8000-000000000026,aaaaaaaa-0000-4000-8000-000000000027,aaaaaaaa-0000-4000-8000-000000000028,aaaaaaaa-0000-4000-8000-000000000029,aaaaaaaa-0000-4000-8000-000000000030,aaaaaaaa-0000-4000-8000-000000000031,aaaaaaaa-0000-4000-8000-000000000032,aaaaaaaa-0000-4000-8000-000000000033,aaaaaaaa-0000-4000-8000-000000000034,aaaaaaaa-0000-4000-8000-000000000035,aaaaaaaa-0000-4000-8000-000000000036,aaaaaaaa-0000-4000-8000-000000000037,aaaaaaaa-0000-4000-8000-000000000038,aaaaaaaa-0000-4000-8000-000000000039,aaaaaaaa-0000-4000-8000-000000000040,aaaaaaaa-0000-4000-8000-000000000041,aaaaaaaa-0000-4000-8000-000000000042,aaaaaaaa-0000-4000-8000-000000000043,aaaaaaaa-0000-4000-8000-000000000044,aaaaaaaa-0000-4000-8000-000000000045,aaaaaaaa-0000-4000-8000-000000000046,aaaaaaaa-0000-4000-8000-000000000047,aaaaaaaa-0000-4000-8000-000000000048,aaaaaaaa-0000-4000-8000-000000000049,aaaaaaaa-0000-4000-8000-000000000050"],
    toolTexts: {},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: memory_ids must hold 1 to 50 ids, got 51\n",
  },
  {
    name: "forget nothing",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555"],
    toolTexts: {},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: Either --memory-id or --query is required (or --ids)\n",
  },
  {
    name: "forget -k with no target",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","-k","3"],
    toolTexts: {},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: Either --memory-id or --query is required (or --ids)\n",
  },
  {
    name: "forget query default k",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","-q","old"],
    toolTexts: {"forget": "{\"status\": \"success\", \"deleted_count\": 1, \"memory_ids\": [\"aaaaaaaa-0000-4000-8000-000000000001\"], \"session_id\": \"sess_3f2a9c\"}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","query":"old","k":10}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"deleted_count\": 1,\n  \"memory_ids\": [\n    \"aaaaaaaa-0000-4000-8000-000000000001\"\n  ],\n  \"session_id\": \"sess_3f2a9c\"\n}\n",
    stderr: "",
  },
  {
    name: "forget memory id",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","-m","aaaaaaaa-0000-4000-8000-000000000001"],
    toolTexts: {"forget": "{\"status\": \"success\", \"deleted_count\": 1, \"memory_ids\": [\"aaaaaaaa-0000-4000-8000-000000000001\"], \"session_id\": \"sess_3f2a9c\"}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","memory_id":"aaaaaaaa-0000-4000-8000-000000000001"}],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"deleted_count\": 1,\n  \"memory_ids\": [\n    \"aaaaaaaa-0000-4000-8000-000000000001\"\n  ],\n  \"session_id\": \"sess_3f2a9c\"\n}\n",
    stderr: "",
  },
  {
    name: "forget ids bad -k",
    argv: ["forget","-c","11111111-2222-4333-8444-555555555555","--ids","aaaaaaaa-0000-4000-8000-000000000001","-k","x"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura forget [OPTIONS]\nTry 'kagura forget --help' for help.\n\nError: Invalid value for '-k': 'x' is not a valid integer.\n",
  },
  // click checks a given option before it reports SINCE missing; a NaN or
  // an infinity json.loads reads is what httpx then refuses to send, after
  // the context is resolved; --details is read by the same parser as
  // --filters, so its JSON errors are json.loads' words too.
  {
    name: "changes limit 0 without SINCE",
    argv: ["changes","--limit","0"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura changes [OPTIONS] SINCE\nTry 'kagura changes --help' for help.\n\nError: Invalid value for '--limit': 0 is not in the range 1<=x<=100.\n",
  },
  {
    name: "changes max-chars 5 without SINCE",
    argv: ["changes","-c","11111111-2222-4333-8444-555555555555","--max-chars","5"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura changes [OPTIONS] SINCE\nTry 'kagura changes --help' for help.\n\nError: Invalid value for '--max-chars': 5 is not in the range 10000<=x<=100000.\n",
  },
  {
    name: "list filters NaN",
    argv: ["list","-c","11111111-2222-4333-8444-555555555555","--filters","{\"details.x\": NaN}"],
    toolTexts: {"list":"{\"status\": \"success\", \"memories\": [], \"total\": 0, \"has_more\": false}"},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: Out of range float values are not JSON compliant: nan\n",
  },
  {
    name: "list filters 1e400",
    argv: ["list","-c","11111111-2222-4333-8444-555555555555","--filters","{\"details.x\": 1e400}"],
    toolTexts: {"list":"{\"status\": \"success\", \"memories\": [], \"total\": 0, \"has_more\": false}"},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: Out of range float values are not JSON compliant: inf\n",
  },
  {
    name: "list filters NaN no context",
    argv: ["list","--filters","{\"details.x\": NaN}"],
    toolTexts: {},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: context_id required. Pass the context ID or set context_id in .kagura.json\n",
  },
  {
    name: "remember details NaN",
    argv: ["remember","-c","11111111-2222-4333-8444-555555555555","-s","A summary long enough","--content","c","--details","{\"a\": NaN}"],
    toolTexts: {"remember":"{\"status\": \"success\", \"memory_id\": \"m\"}"},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: Out of range float values are not JSON compliant: nan\n",
  },
  {
    name: "remember details bad json",
    argv: ["remember","-c","11111111-2222-4333-8444-555555555555","-s","A summary long enough","--content","c","--details","{\"a\": }"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura remember [OPTIONS]\nTry 'kagura remember --help' for help.\n\nError: Invalid JSON for --details: Expecting value: line 1 column 7 (char 6)\n",
  },
  {
    name: "remember details trailing",
    argv: ["remember","-c","11111111-2222-4333-8444-555555555555","-s","A summary long enough","--content","c","--details","{} x"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura remember [OPTIONS]\nTry 'kagura remember --help' for help.\n\nError: Invalid JSON for --details: Extra data: line 1 column 4 (char 3)\n",
  },
  {
    name: "update-memory details-patch NaN",
    argv: ["update-memory","-c","11111111-2222-4333-8444-555555555555","-m","aaaaaaaa-0000-4000-8000-000000000001","--details-patch","{\"a\": NaN}"],
    toolTexts: {"update_memory":"{\"status\": \"success\", \"memory_id\": \"aaaaaaaa-0000-4000-8000-000000000001\", \"version\": 2}"},
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: Out of range float values are not JSON compliant: nan\n",
  },
  {
    name: "update-memory details-patch bad json",
    argv: ["update-memory","-c","11111111-2222-4333-8444-555555555555","-m","aaaaaaaa-0000-4000-8000-000000000001","--details-patch","{\"a\": }"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura update-memory [OPTIONS]\nTry 'kagura update-memory --help' for help.\n\nError: Invalid JSON for --details-patch: Expecting value: line 1 column 7 (char 6)\n",
  },
];

describe("bootstrap / changes / list / forget --ids output, byte for byte the Python CLI's (#86)", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const reads = vi.spyOn(pyModels, "readModel");
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
    if (c.code === 0 && (["bootstrap", "changes", "list"].includes(c.argv[0]!) ||
        (c.argv[0] === "forget" && c.argv.includes("--ids")))) {
      expect(reads.mock.calls).toHaveLength(1);
    }
    expect(terminalText(out)).toBe(c.stdout);
    const stderr = (c.ourStderr ?? c.stderr).replace(/^(Usage: |Try ')kagura(?= )/gm, "$1kagura-memory");
    expect(terminalText(err)).toBe(stderr);
    const calls = server.requests.filter((r) => r.body?.method === "tools/call");
    expect(calls.map((r) => (r.body?.params as { arguments: unknown }).arguments)).toEqual(c.calls);
  });
});
