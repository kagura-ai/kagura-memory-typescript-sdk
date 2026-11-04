/**
 * `sleep history` and `sleep report` print what the Python CLI prints for
 * the same tool result (#85): each case below is a `get_sleep_history` /
 * `get_sleep_report` result shaped as memory-cloud v0.141.0 sends it (or
 * as an older server does, without `source`, `llm_call_failures` and the
 * paging keys), the arguments the Python CLI sent for it, and its stdout,
 * stderr and exit code — recorded from the Python CLI 0.44.0 (click 8.3.3,
 * pydantic 2.13.4) against a fake server sending these exact texts. The
 * report's model fills a field the server left out with its default
 * (`source: null`, `actions_has_more: false`, `details_omitted: false`),
 * drops a key it does not have and prints a timestamp in pydantic's form;
 * a report the model refuses exits 1 with the Python SDK's words. A usage
 * error prints the Python CLI's `Error:` line.
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
    name: "history v0.141.0",
    argv: ["sleep","history","11111111-2222-4333-8444-555555555555"],
    toolTexts: {"get_sleep_history": "{\"status\": \"success\", \"reports\": [{\"report_id\": \"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"status\": \"completed\", \"source\": \"sleep\", \"started_at\": \"2026-11-01T03:00:00Z\", \"completed_at\": \"2026-11-01T03:02:10.5Z\", \"memories_processed\": 120, \"edges_created\": 4, \"memories_merged\": 1, \"memories_promoted\": 2, \"llm_calls_made\": 9, \"llm_tokens_used\": 4200, \"llm_call_failures\": 0, \"extra\": 1}], \"count\": 1}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","limit":10}],
    code: 0,
    stdout: "{\n  \"reports\": [\n    {\n      \"report_id\": \"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00\",\n      \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n      \"status\": \"completed\",\n      \"started_at\": \"2026-11-01T03:00:00Z\",\n      \"completed_at\": \"2026-11-01T03:02:10.500000Z\",\n      \"memories_processed\": 120,\n      \"edges_created\": 4,\n      \"memories_merged\": 1,\n      \"memories_promoted\": 2,\n      \"llm_calls_made\": 9,\n      \"llm_tokens_used\": 4200,\n      \"llm_call_failures\": 0,\n      \"source\": \"sleep\"\n    }\n  ]\n}\n",
    stderr: "",
  },
  {
    name: "history --source all --limit 5",
    argv: ["sleep","history","11111111-2222-4333-8444-555555555555","--limit","5","--source","all"],
    toolTexts: {"get_sleep_history": "{\"status\": \"success\", \"reports\": [{\"report_id\": \"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"status\": \"completed\", \"source\": \"sleep\", \"started_at\": \"2026-11-01T03:00:00Z\", \"completed_at\": \"2026-11-01T03:02:10.5Z\", \"memories_processed\": 120, \"edges_created\": 4, \"memories_merged\": 1, \"memories_promoted\": 2, \"llm_calls_made\": 9, \"llm_tokens_used\": 4200, \"llm_call_failures\": 0}, {\"report_id\": \"2f1e0d9c-8b7a-4655-9443-322110ffeedd\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"status\": \"completed\", \"source\": \"analysis\", \"started_at\": \"2026-11-01T03:00:00Z\", \"completed_at\": null, \"memories_processed\": 0, \"edges_created\": 0, \"memories_merged\": 0, \"memories_promoted\": 0, \"llm_calls_made\": 3, \"llm_tokens_used\": 900, \"llm_call_failures\": 0}], \"count\": 2}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","limit":5,"source":"all"}],
    code: 0,
    stdout: "{\n  \"reports\": [\n    {\n      \"report_id\": \"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00\",\n      \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n      \"status\": \"completed\",\n      \"started_at\": \"2026-11-01T03:00:00Z\",\n      \"completed_at\": \"2026-11-01T03:02:10.500000Z\",\n      \"memories_processed\": 120,\n      \"edges_created\": 4,\n      \"memories_merged\": 1,\n      \"memories_promoted\": 2,\n      \"llm_calls_made\": 9,\n      \"llm_tokens_used\": 4200,\n      \"llm_call_failures\": 0,\n      \"source\": \"sleep\"\n    },\n    {\n      \"report_id\": \"2f1e0d9c-8b7a-4655-9443-322110ffeedd\",\n      \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n      \"status\": \"completed\",\n      \"started_at\": \"2026-11-01T03:00:00Z\",\n      \"completed_at\": null,\n      \"memories_processed\": 0,\n      \"edges_created\": 0,\n      \"memories_merged\": 0,\n      \"memories_promoted\": 0,\n      \"llm_calls_made\": 3,\n      \"llm_tokens_used\": 900,\n      \"llm_call_failures\": 0,\n      \"source\": \"analysis\"\n    }\n  ]\n}\n",
    stderr: "",
  },
  {
    name: "history older server",
    argv: ["sleep","history","11111111-2222-4333-8444-555555555555","--source","analysis"],
    toolTexts: {"get_sleep_history": "{\"status\": \"success\", \"reports\": [{\"report_id\": \"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"status\": \"completed\", \"started_at\": \"2026-11-01T03:00:00Z\", \"completed_at\": \"2026-11-01T03:02:10.5Z\", \"memories_processed\": 120, \"edges_created\": 4, \"memories_merged\": 1, \"memories_promoted\": 2, \"llm_calls_made\": 9, \"llm_tokens_used\": 4200}], \"count\": 1}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","limit":10,"source":"analysis"}],
    code: 0,
    stdout: "{\n  \"reports\": [\n    {\n      \"report_id\": \"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00\",\n      \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n      \"status\": \"completed\",\n      \"started_at\": \"2026-11-01T03:00:00Z\",\n      \"completed_at\": \"2026-11-01T03:02:10.500000Z\",\n      \"memories_processed\": 120,\n      \"edges_created\": 4,\n      \"memories_merged\": 1,\n      \"memories_promoted\": 2,\n      \"llm_calls_made\": 9,\n      \"llm_tokens_used\": 4200,\n      \"llm_call_failures\": null,\n      \"source\": null\n    }\n  ]\n}\n",
    stderr: "",
  },
  {
    name: "history unknown source",
    argv: ["sleep","history","11111111-2222-4333-8444-555555555555","--source","everything"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura sleep history [OPTIONS] CONTEXT_ID\nTry 'kagura sleep history --help' for help.\n\nError: Invalid value for '--source': 'everything' is not one of 'sleep', 'analysis', 'all'.\n",
  },
  {
    name: "history refused row",
    argv: ["sleep","history","11111111-2222-4333-8444-555555555555"],
    toolTexts: {"get_sleep_history": "{\"status\": \"success\", \"reports\": [{\"report_id\": \"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00\", \"status\": \"completed\", \"source\": 5}], \"count\": 1}"},
    calls: [{"context_id":"11111111-2222-4333-8444-555555555555","limit":10}],
    code: 1,
    stdout: "",
    stderr: "Error: get_sleep_history: unexpected server response for SleepReport (memories_processed: Field required; edges_created: Field required; memories_merged: Field required (+4 more)). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "report v0.141.0 page",
    argv: ["sleep","report","11111111-2222-4333-8444-555555555555","8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00"],
    toolTexts: {"get_sleep_report": "{\"status\": \"success\", \"report\": {\"report_id\": \"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"status\": \"completed\", \"source\": \"sleep\", \"started_at\": \"2026-11-01T03:00:00Z\", \"completed_at\": \"2026-11-01T03:02:10.5Z\", \"memories_processed\": 120, \"edges_created\": 4, \"memories_merged\": 1, \"memories_promoted\": 2, \"llm_calls_made\": 9, \"llm_tokens_used\": 4200, \"llm_call_failures\": 0, \"memories_flagged\": 1, \"embedding_calls_made\": 12, \"error_message\": null, \"edge_discovery_result\": {\"pairs_checked\": 40, \"threshold\": 0.92}, \"dedup_result\": {\"merged\": 1}, \"importance_result\": null, \"consolidation_result\": null, \"reindex_result\": null, \"merge_retention_result\": null}, \"actions\": [{\"id\": \"41\", \"phase\": \"edge_discovery\", \"action_type\": \"create_edge\", \"memory_id\": \"m-1\", \"target_id\": \"m-2\", \"details\": {\"similarity\": 0.93, \"weight\": 0.5}, \"created_at\": \"2026-11-01T03:01:00Z\"}, {\"id\": \"57\", \"phase\": \"dedup\", \"action_type\": \"merge\", \"memory_id\": \"m-3\", \"target_id\": \"m-4\", \"created_at\": \"2026-11-01T03:01:30.25Z\", \"details_omitted\": true, \"details_total_chars\": 31000}], \"action_count\": 120, \"actions_has_more\": true, \"actions_next_cursor\": \"57\"}"},
    calls: [{"report_id":"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00"}],
    code: 0,
    stdout: "{\n  \"report_id\": \"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00\",\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"status\": \"completed\",\n  \"started_at\": \"2026-11-01T03:00:00Z\",\n  \"completed_at\": \"2026-11-01T03:02:10.500000Z\",\n  \"memories_processed\": 120,\n  \"edges_created\": 4,\n  \"memories_merged\": 1,\n  \"memories_promoted\": 2,\n  \"llm_calls_made\": 9,\n  \"llm_tokens_used\": 4200,\n  \"llm_call_failures\": 0,\n  \"source\": \"sleep\",\n  \"memories_flagged\": 1,\n  \"embedding_calls_made\": 12,\n  \"error_message\": null,\n  \"edge_discovery_result\": {\n    \"pairs_checked\": 40,\n    \"threshold\": 0.92\n  },\n  \"dedup_result\": {\n    \"merged\": 1\n  },\n  \"merge_retention_result\": null,\n  \"importance_result\": null,\n  \"consolidation_result\": null,\n  \"reindex_result\": null,\n  \"actions\": [\n    {\n      \"id\": \"41\",\n      \"phase\": \"edge_discovery\",\n      \"action_type\": \"create_edge\",\n      \"memory_id\": \"m-1\",\n      \"target_id\": \"m-2\",\n      \"details\": {\n        \"similarity\": 0.93,\n        \"weight\": 0.5\n      },\n      \"created_at\": \"2026-11-01T03:01:00Z\",\n      \"details_omitted\": false,\n      \"details_total_chars\": null\n    },\n    {\n      \"id\": \"57\",\n      \"phase\": \"dedup\",\n      \"action_type\": \"merge\",\n      \"memory_id\": \"m-3\",\n      \"target_id\": \"m-4\",\n      \"details\": null,\n      \"created_at\": \"2026-11-01T03:01:30.250000Z\",\n      \"details_omitted\": true,\n      \"details_total_chars\": 31000\n    }\n  ],\n  \"action_count\": 120,\n  \"actions_has_more\": true,\n  \"actions_next_cursor\": \"57\",\n  \"note\": null\n}\n",
    stderr: "",
  },
  {
    name: "report analysis with paging flags",
    argv: ["sleep","report","11111111-2222-4333-8444-555555555555","2f1e0d9c-8b7a-4655-9443-322110ffeedd","--actions-cursor","57","--actions-limit","20"],
    toolTexts: {"get_sleep_report": "{\"status\": \"success\", \"report\": {\"report_id\": \"2f1e0d9c-8b7a-4655-9443-322110ffeedd\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"status\": \"completed\", \"source\": \"analysis\", \"started_at\": \"2026-11-01T03:00:00Z\", \"completed_at\": null, \"memories_processed\": 0, \"edges_created\": 0, \"memories_merged\": 0, \"memories_promoted\": 0, \"llm_calls_made\": 3, \"llm_tokens_used\": 900, \"llm_call_failures\": 0, \"memories_flagged\": 1, \"embedding_calls_made\": 12, \"error_message\": null, \"edge_discovery_result\": null, \"dedup_result\": null, \"importance_result\": null, \"consolidation_result\": null, \"reindex_result\": null, \"merge_retention_result\": null}, \"actions\": [], \"action_count\": 0, \"actions_has_more\": false, \"actions_next_cursor\": null, \"note\": \"This is an analysis report (source 'analysis'): it records the LLM spend of a Memory Analysis run (cluster labeling).\"}"},
    calls: [{"report_id":"2f1e0d9c-8b7a-4655-9443-322110ffeedd","actions_cursor":"57","actions_limit":20}],
    code: 0,
    stdout: "{\n  \"report_id\": \"2f1e0d9c-8b7a-4655-9443-322110ffeedd\",\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"status\": \"completed\",\n  \"started_at\": \"2026-11-01T03:00:00Z\",\n  \"completed_at\": null,\n  \"memories_processed\": 0,\n  \"edges_created\": 0,\n  \"memories_merged\": 0,\n  \"memories_promoted\": 0,\n  \"llm_calls_made\": 3,\n  \"llm_tokens_used\": 900,\n  \"llm_call_failures\": 0,\n  \"source\": \"analysis\",\n  \"memories_flagged\": 1,\n  \"embedding_calls_made\": 12,\n  \"error_message\": null,\n  \"edge_discovery_result\": null,\n  \"dedup_result\": null,\n  \"merge_retention_result\": null,\n  \"importance_result\": null,\n  \"consolidation_result\": null,\n  \"reindex_result\": null,\n  \"actions\": [],\n  \"action_count\": 0,\n  \"actions_has_more\": false,\n  \"actions_next_cursor\": null,\n  \"note\": \"This is an analysis report (source 'analysis'): it records the LLM spend of a Memory Analysis run (cluster labeling).\"\n}\n",
    stderr: "",
  },
  {
    name: "report older server",
    argv: ["sleep","report","11111111-2222-4333-8444-555555555555","8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00"],
    toolTexts: {"get_sleep_report": "{\"status\": \"success\", \"report\": {\"report_id\": \"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"status\": \"completed\", \"started_at\": \"2026-11-01T03:00:00Z\", \"completed_at\": \"2026-11-01T03:02:10.5Z\", \"memories_processed\": 120, \"edges_created\": 4, \"memories_merged\": 1, \"memories_promoted\": 2, \"llm_calls_made\": 9, \"llm_tokens_used\": 4200, \"memories_flagged\": 1, \"embedding_calls_made\": 12, \"error_message\": null, \"edge_discovery_result\": {\"pairs_checked\": 40, \"threshold\": 0.92}, \"dedup_result\": {\"merged\": 1}, \"importance_result\": null, \"consolidation_result\": null, \"reindex_result\": null, \"merge_retention_result\": null}, \"actions\": [{\"id\": \"41\", \"phase\": \"edge_discovery\", \"action_type\": \"create_edge\", \"memory_id\": \"m-1\", \"target_id\": \"m-2\", \"details\": {\"similarity\": 0.93, \"weight\": 0.5}, \"created_at\": \"2026-11-01T03:01:00Z\"}], \"action_count\": 1}"},
    calls: [{"report_id":"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00"}],
    code: 0,
    stdout: "{\n  \"report_id\": \"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00\",\n  \"context_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"status\": \"completed\",\n  \"started_at\": \"2026-11-01T03:00:00Z\",\n  \"completed_at\": \"2026-11-01T03:02:10.500000Z\",\n  \"memories_processed\": 120,\n  \"edges_created\": 4,\n  \"memories_merged\": 1,\n  \"memories_promoted\": 2,\n  \"llm_calls_made\": 9,\n  \"llm_tokens_used\": 4200,\n  \"llm_call_failures\": null,\n  \"source\": null,\n  \"memories_flagged\": 1,\n  \"embedding_calls_made\": 12,\n  \"error_message\": null,\n  \"edge_discovery_result\": {\n    \"pairs_checked\": 40,\n    \"threshold\": 0.92\n  },\n  \"dedup_result\": {\n    \"merged\": 1\n  },\n  \"merge_retention_result\": null,\n  \"importance_result\": null,\n  \"consolidation_result\": null,\n  \"reindex_result\": null,\n  \"actions\": [\n    {\n      \"id\": \"41\",\n      \"phase\": \"edge_discovery\",\n      \"action_type\": \"create_edge\",\n      \"memory_id\": \"m-1\",\n      \"target_id\": \"m-2\",\n      \"details\": {\n        \"similarity\": 0.93,\n        \"weight\": 0.5\n      },\n      \"created_at\": \"2026-11-01T03:01:00Z\",\n      \"details_omitted\": false,\n      \"details_total_chars\": null\n    }\n  ],\n  \"action_count\": 1,\n  \"actions_has_more\": false,\n  \"actions_next_cursor\": null,\n  \"note\": null\n}\n",
    stderr: "",
  },
  {
    name: "report actions-limit 201",
    argv: ["sleep","report","11111111-2222-4333-8444-555555555555","8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00","--actions-limit","201"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura sleep report [OPTIONS] CONTEXT_ID REPORT_ID\nTry 'kagura sleep report --help' for help.\n\nError: Invalid value for '--actions-limit': 201 is not in the range 1<=x<=200.\n",
  },
  {
    name: "report actions-limit 0",
    argv: ["sleep","report","11111111-2222-4333-8444-555555555555","8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00","--actions-limit","0"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura sleep report [OPTIONS] CONTEXT_ID REPORT_ID\nTry 'kagura sleep report --help' for help.\n\nError: Invalid value for '--actions-limit': 0 is not in the range 1<=x<=200.\n",
  },
  {
    name: "report actions-limit abc",
    argv: ["sleep","report","11111111-2222-4333-8444-555555555555","8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00","--actions-limit","abc"],
    toolTexts: {},
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura sleep report [OPTIONS] CONTEXT_ID REPORT_ID\nTry 'kagura sleep report --help' for help.\n\nError: Invalid value for '--actions-limit': 'abc' is not a valid integer range.\n",
  },
  {
    name: "report refused action",
    argv: ["sleep","report","11111111-2222-4333-8444-555555555555","8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00"],
    toolTexts: {"get_sleep_report": "{\"status\": \"success\", \"report\": {\"report_id\": \"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00\", \"context_id\": \"11111111-2222-4333-8444-555555555555\", \"status\": \"completed\", \"source\": \"sleep\", \"started_at\": \"2026-11-01T03:00:00Z\", \"completed_at\": \"2026-11-01T03:02:10.5Z\", \"memories_processed\": 120, \"edges_created\": 4, \"memories_merged\": 1, \"memories_promoted\": 2, \"llm_calls_made\": 9, \"llm_tokens_used\": 4200, \"llm_call_failures\": 0, \"memories_flagged\": 1, \"embedding_calls_made\": 12, \"error_message\": null, \"edge_discovery_result\": {\"pairs_checked\": 40, \"threshold\": 0.92}, \"dedup_result\": {\"merged\": 1}, \"importance_result\": null, \"consolidation_result\": null, \"reindex_result\": null, \"merge_retention_result\": null}, \"actions\": [{\"id\": \"1\", \"phase\": \"dedup\", \"details_omitted\": \"maybe\"}], \"action_count\": 1}"},
    calls: [{"report_id":"8d0c6f2e-1b7a-4c1e-9a55-0f6a3b2c1d00"}],
    code: 1,
    stdout: "",
    stderr: "Error: get_sleep_report: unexpected server response for SleepReportDetail (actions.0.action_type: Field required; actions.0.details_omitted: Input should be a valid boolean, unable to interpret input). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    // #79's recorded 0.42.2 reply (PR #96), as the Python CLI 0.44.0 prints it.
    name: "report: #79 reply, the 0.43.0 model fields filled",
    argv: ["sleep","report","ctx-1","11111111-2222-4333-8444-555555555555"],
    toolTexts: {"get_sleep_report": "{\"status\": \"success\", \"report\": {\"report_id\": \"11111111-2222-4333-8444-555555555555\", \"context_id\": \"c0ffee00-0000-4000-8000-000000000001\", \"status\": \"completed\", \"started_at\": \"2026-06-01T00:00:00Z\", \"completed_at\": \"2026-06-01T00:05:00Z\", \"memories_processed\": 12, \"edges_created\": 3, \"memories_merged\": 1, \"memories_promoted\": 0, \"llm_calls_made\": 4, \"llm_tokens_used\": 900, \"llm_call_failures\": null, \"memories_flagged\": 0, \"embedding_calls_made\": 2, \"error_message\": null, \"edge_discovery_result\": {\"edges\": 3}, \"dedup_result\": null, \"merge_retention_result\": null, \"importance_result\": null, \"consolidation_result\": null, \"reindex_result\": null}, \"actions\": [{\"id\": \"a1\", \"phase\": \"edge_discovery\", \"action_type\": \"create_edge\", \"memory_id\": \"m1\", \"target_id\": \"m2\", \"details\": {\"similarity\": 0.91}, \"created_at\": \"2026-06-01T00:01:00Z\"}], \"action_count\": 1}"},
    calls: [{"report_id":"11111111-2222-4333-8444-555555555555"}],
    code: 0,
    stdout: "{\n  \"report_id\": \"11111111-2222-4333-8444-555555555555\",\n  \"context_id\": \"c0ffee00-0000-4000-8000-000000000001\",\n  \"status\": \"completed\",\n  \"started_at\": \"2026-06-01T00:00:00Z\",\n  \"completed_at\": \"2026-06-01T00:05:00Z\",\n  \"memories_processed\": 12,\n  \"edges_created\": 3,\n  \"memories_merged\": 1,\n  \"memories_promoted\": 0,\n  \"llm_calls_made\": 4,\n  \"llm_tokens_used\": 900,\n  \"llm_call_failures\": null,\n  \"source\": null,\n  \"memories_flagged\": 0,\n  \"embedding_calls_made\": 2,\n  \"error_message\": null,\n  \"edge_discovery_result\": {\n    \"edges\": 3\n  },\n  \"dedup_result\": null,\n  \"merge_retention_result\": null,\n  \"importance_result\": null,\n  \"consolidation_result\": null,\n  \"reindex_result\": null,\n  \"actions\": [\n    {\n      \"id\": \"a1\",\n      \"phase\": \"edge_discovery\",\n      \"action_type\": \"create_edge\",\n      \"memory_id\": \"m1\",\n      \"target_id\": \"m2\",\n      \"details\": {\n        \"similarity\": 0.91\n      },\n      \"created_at\": \"2026-06-01T00:01:00Z\",\n      \"details_omitted\": false,\n      \"details_total_chars\": null\n    }\n  ],\n  \"action_count\": 1,\n  \"actions_has_more\": false,\n  \"actions_next_cursor\": null,\n  \"note\": null\n}\n",
    stderr: "",
  },
];

describe("sleep history / report output, byte for byte the Python CLI's (#85)", () => {
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
    expect(out.map((line) => `${line}\n`).join("")).toBe(c.stdout);
    // A usage error: this bin prints click's `Error:` line without the
    // `Usage:` / `Try '… --help'` lines before it, as for every command.
    const stderr = c.code === 2 ? c.stderr.slice(c.stderr.indexOf("Error: ")) : c.stderr;
    expect(err.map((line) => `${line}\n`).join("")).toBe(stderr);
    const calls = server.requests.filter((r) => r.body?.method === "tools/call");
    expect(calls.map((r) => (r.body?.params as { arguments: unknown }).arguments)).toEqual(c.calls);
  });
});
