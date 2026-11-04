/**
 * `remember`, `update-memory` and `context search-config` with the
 * arguments of memory-cloud v0.78.0–v0.140.0 (#87), against the Python CLI
 * 0.44.0 (python-sdk #302, and #247 for `--merge-details`). Each case is an
 * argv, the content[0].text of each tool reply in turn and the
 * `GET /api/v1/system/info` answer the fake server sends, byte for byte,
 * and the Python CLI's tool calls, stdout, stderr and exit code for it —
 * recorded from the Python CLI 0.44.0 (click 8.3.3, pydantic 2.13.4)
 * against a fake MCP + REST server sending these exact bytes, with
 * `context_id: "ctx"` in `.kagura.json`.
 *
 * `--merge-details` / `--details-patch` cover each server generation: one
 * `details_patch` call (0.140.0+); a refusal of exactly `details_patch`
 * (0.82.0–0.139.x), then `reference()` and the merged object; and a reply
 * without `version` (a server before 0.82.0 ignored the patch), confirmed
 * with the server-info probe before the second write — or, when the probe
 * fails or reports 0.82.0+, nothing more written and exit 1.
 *
 * Two differences are by design. A message naming a command says
 * `kagura-memory reference`, where Python's says `kagura reference`, as
 * this bin's help does. And a usage error (exit 2) is compared by its
 * `Error:` line: click prints its usage line and a `Try …` hint before it,
 * and this bin its help after it (README, "Command line"); a JSON parse
 * error up to the parser's own words, Python's `json` module there and
 * JavaScript's here.
 */

import { describe, expect, it } from "vitest";

import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { FakeServer, makeClient } from "../../fakeServer.js";

interface Case {
  name: string;
  /** After `kagura-memory`. */
  argv: string[];
  /** Tool name → the {@link TEXTS} its calls get, in turn. */
  replies?: Record<string, string[]>;
  /** The `GET /api/v1/system/info` answer; a 404 when absent. */
  info?: { status: number; body: string };
  /** Every tools/call the Python CLI sent, in order, as [tool, arguments]. */
  calls: Array<[string, Record<string, unknown>]>;
  /** How many `GET /api/v1/system/info` the Python CLI sent. */
  gets?: number;
  code: number;
  stdout: string;
  stderr: string;
}

const TEXTS: Record<string, string> = {
  REMEMBER_OK: "{\"status\": \"success\", \"memory_id\": \"m-1\", \"scope\": \"working\", \"version\": 1, \"session_id\": \"sess-1\", \"summary_truncated\": true, \"summary_original_length\": 612, \"context_id\": \"ctx\", \"context_name\": \"dev\", \"context_display_name\": null, \"context_is_private\": true, \"context_is_locked\": false}",
  DUPLICATE: "{\"status\": \"duplicate_candidate\", \"candidate\": {\"memory_id\": \"m-0\", \"summary\": \"Deploy key rotated on prod\", \"similarity\": 0.91, \"supersedable\": true}, \"context_id\": \"ctx\", \"context_name\": \"dev\", \"context_display_name\": null, \"context_is_private\": true, \"context_is_locked\": false}",
  DEDUPE_UNAVAILABLE: "{\"status\": \"error\", \"error\": \"dedupe_unavailable\", \"message\": \"The duplicate check could not run (embedding unavailable); nothing was written. Retry with dedupe='suggest' or 'off'.\"}",
  UPDATE_OK: "{\"status\": \"success\", \"memory_id\": \"mem-1\", \"operation\": \"updated\", \"re_embedded\": false, \"scope\": \"working\", \"version\": 4, \"context_id\": \"ctx\", \"context_name\": \"dev\", \"context_display_name\": null, \"context_is_private\": true, \"context_is_locked\": false}",
  ACCEPT_OK: "{\"status\": \"success\", \"memory_id\": \"mem-1\", \"operation\": \"updated\", \"re_embedded\": false, \"scope\": \"working\", \"version\": 3, \"superseded_memory_id\": \"mem-0\", \"context_id\": \"ctx\", \"context_name\": \"dev\", \"context_display_name\": null, \"context_is_private\": true, \"context_is_locked\": false}",
  EDGE_EXISTS: "{\"status\": \"error\", \"error\": \"edge_exists\", \"message\": \"A declared edge already links mem-1 and mem-0; nothing was written.\", \"existing_edge\": {\"edge_id\": \"e-1\", \"edge_type\": \"declared_link\", \"source_id\": \"mem-1\", \"target_id\": \"mem-0\"}}",
  VERSION_CONFLICT: "{\"status\": \"error\", \"error\": \"version_conflict\", \"message\": \"Memory mem-1 is at version 5, not the expected version 3. Read it again and resend with its current version.\", \"memory_id\": \"mem-1\", \"expected_version\": 3, \"current_version\": 5, \"retryable\": false, \"help\": \"reference() the memory and resend with its current version, or omit expected_version to overwrite.\"}",
  REFUSE_PATCH: "{\"status\": \"error\", \"error\": \"invalid_argument\", \"message\": \"update_memory does not accept the argument 'details_patch'. Arguments its inputSchema declares: context_id, memory_id.\", \"unknown_arguments\": [\"details_patch\"], \"allowed_arguments\": [\"context_id\", \"memory_id\"], \"suggestions\": {}, \"help\": \"Remove the unknown arguments or rename them as suggested, then call the tool again. tools/list shows each tool's inputSchema.\"}",
  REFERENCE: "{\"status\": \"success\", \"memory\": {\"memory_id\": \"mem-1\", \"details\": {\"location\": {\"lat\": 1.0, \"lon\": 2.0, \"label\": \"old\"}, \"client\": \"acme\", \"n\": 1, \"observed_at\": \"2020-01-01\"}}}",
  REFUSE_PATCH_AND_TAGS: "{\"status\": \"error\", \"error\": \"invalid_argument\", \"message\": \"update_memory does not accept the arguments 'add_tags', 'details_patch'. Arguments its inputSchema declares: context_id, memory_id.\", \"unknown_arguments\": [\"add_tags\", \"details_patch\"], \"allowed_arguments\": [\"context_id\", \"memory_id\"], \"suggestions\": {}}",
  REFUSE_NO_LIST: "{\"status\": \"error\", \"error\": \"invalid_argument\", \"message\": \"update_memory does not accept the argument 'details_patch'.\"}",
  REFERENCE_BOUNDED: "{\"status\": \"success\", \"memory\": {\"memory_id\": \"mem-1\", \"details_omitted\": true, \"details_total_chars\": 24000, \"details_next_offset\": 0}}",
  UPDATE_NO_VERSION: "{\"status\": \"success\", \"memory_id\": \"mem-1\", \"operation\": \"updated\", \"re_embedded\": false, \"scope\": \"working\"}",
  SEARCH_OK: "{\"status\": \"success\", \"context_id\": \"ctx\", \"config\": {\"semantic_weight\": 0.6, \"bm25_weight\": 0.4, \"fetch_factor\": 3, \"use_rerank\": false, \"content_chunks_enabled\": true, \"content_chunks_effective\": true, \"llm_selector_enabled\": false, \"llm_selector_effective\": false}}",
};

const CASES: Case[] = [
  {
    name: "remember: observed_at, dedupe and tags_normalize are sent",
    argv: ["remember", "-s", "Release 2.0 shipped", "--content", "...", "--observed-at", "2026-11-01", "--dedupe", "suggest", "--tags-normalize", "--tags", "release"],
    replies: {"remember": ["REMEMBER_OK"]},
    calls: [["remember", {"context_id": "ctx", "summary": "Release 2.0 shipped", "content": "...", "type": "note", "importance": 0.5, "tags": ["release"], "observed_at": "2026-11-01", "tags_normalize": true, "dedupe": "suggest"}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"m-1\",\n  \"scope\": \"working\",\n  \"version\": 1,\n  \"session_id\": \"sess-1\",\n  \"summary_truncated\": true,\n  \"summary_original_length\": 612,\n  \"context_id\": \"ctx\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": true,\n  \"context_is_locked\": false\n}\n",
    stderr: "",
  },
  {
    name: "remember: an aware datetime is sent as given",
    argv: ["remember", "-s", "Release 2.0 shipped", "--content", "...", "--observed-at", "2024-03-07T10:00:00+09:00", "--dedupe", "off"],
    replies: {"remember": ["REMEMBER_OK"]},
    calls: [["remember", {"context_id": "ctx", "summary": "Release 2.0 shipped", "content": "...", "type": "note", "importance": 0.5, "observed_at": "2024-03-07T10:00:00+09:00", "dedupe": "off"}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"m-1\",\n  \"scope\": \"working\",\n  \"version\": 1,\n  \"session_id\": \"sess-1\",\n  \"summary_truncated\": true,\n  \"summary_original_length\": 612,\n  \"context_id\": \"ctx\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": true,\n  \"context_is_locked\": false\n}\n",
    stderr: "",
  },
  {
    name: "remember: --dedupe check prints a duplicate_candidate and exits 0",
    argv: ["remember", "-s", "Deploy key rotated", "--content", "...", "--dedupe", "check"],
    replies: {"remember": ["DUPLICATE"]},
    calls: [["remember", {"context_id": "ctx", "summary": "Deploy key rotated", "content": "...", "type": "note", "importance": 0.5, "dedupe": "check"}]],
    code: 0,
    stdout: "{\n  \"status\": \"duplicate_candidate\",\n  \"candidate\": {\n    \"memory_id\": \"m-0\",\n    \"summary\": \"Deploy key rotated on prod\",\n    \"similarity\": 0.91,\n    \"supersedable\": true\n  },\n  \"context_id\": \"ctx\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": true,\n  \"context_is_locked\": false\n}\n",
    stderr: "",
  },
  {
    name: "remember: dedupe_unavailable is an error",
    argv: ["remember", "-s", "Deploy key rotated", "--content", "...", "--dedupe", "check"],
    replies: {"remember": ["DEDUPE_UNAVAILABLE"]},
    calls: [["remember", {"context_id": "ctx", "summary": "Deploy key rotated", "content": "...", "type": "note", "importance": 0.5, "dedupe": "check"}]],
    code: 1,
    stdout: "",
    stderr: "Error: remember failed (dedupe_unavailable): The duplicate check could not run (embedding unavailable); nothing was written. Retry with dedupe='suggest' or 'off'.\n",
  },
  {
    name: "remember: a blank --observed-at is unset",
    argv: ["remember", "-s", "Release 2.0 shipped", "--content", "...", "--observed-at", "  "],
    replies: {"remember": ["REMEMBER_OK"]},
    calls: [["remember", {"context_id": "ctx", "summary": "Release 2.0 shipped", "content": "...", "type": "note", "importance": 0.5}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"m-1\",\n  \"scope\": \"working\",\n  \"version\": 1,\n  \"session_id\": \"sess-1\",\n  \"summary_truncated\": true,\n  \"summary_original_length\": 612,\n  \"context_id\": \"ctx\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": true,\n  \"context_is_locked\": false\n}\n",
    stderr: "",
  },
  {
    name: "remember: a basic-form --observed-at exits 1 before any call",
    argv: ["remember", "-s", "Release 2.0 shipped", "--content", "...", "--observed-at", "20261101"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: observed_at must be an ISO 8601 date (2024-03-07) or datetime (2024-03-07T10:00:00Z), got '20261101'\n",
  },
  {
    name: "remember: an impossible day exits 1",
    argv: ["remember", "-s", "Release 2.0 shipped", "--content", "...", "--observed-at", "2026-02-30"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: observed_at must be an ISO 8601 date (2024-03-07) or datetime (2024-03-07T10:00:00Z), got '2026-02-30'\n",
  },
  {
    name: "remember: --observed-at that disagrees with --details exits 1",
    argv: ["remember", "-s", "Release 2.0 shipped", "--content", "...", "--observed-at", "2026-11-01", "--details", "{\"observed_at\": \"2026-10-01\"}"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: details['observed_at'] and observed_at disagree; give one of them (the server answers validation_error)\n",
  },
  {
    name: "remember: --observed-at that agrees with --details is sent",
    argv: ["remember", "-s", "Release 2.0 shipped", "--content", "...", "--observed-at", "2026-11-01", "--details", "{\"observed_at\": \"2026-11-01\"}"],
    replies: {"remember": ["REMEMBER_OK"]},
    calls: [["remember", {"context_id": "ctx", "summary": "Release 2.0 shipped", "content": "...", "type": "note", "importance": 0.5, "details": {"observed_at": "2026-11-01"}, "observed_at": "2026-11-01"}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"m-1\",\n  \"scope\": \"working\",\n  \"version\": 1,\n  \"session_id\": \"sess-1\",\n  \"summary_truncated\": true,\n  \"summary_original_length\": 612,\n  \"context_id\": \"ctx\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": true,\n  \"context_is_locked\": false\n}\n",
    stderr: "",
  },
  {
    name: "remember: a bad --dedupe is a usage error",
    argv: ["remember", "-s", "Release 2.0 shipped", "--content", "...", "--dedupe", "maybe"],
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura remember [OPTIONS]\nTry 'kagura remember --help' for help.\n\nError: Invalid value for '--dedupe': 'maybe' is not one of 'suggest', 'check', 'off'.\n",
  },
  {
    name: "update-memory: partial edits, expected_version and observed_at in one call",
    argv: ["update-memory", "-m", "mem-1", "--add-tag", "status:done", "--add-tag", "  ", "--remove-tag", "status:open", "--details-patch", "{\"status\": \"done\", \"assignee\": null}", "--expected-version", "3", "--observed-at", "2026-11-01"],
    replies: {"update_memory": ["UPDATE_OK"]},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "add_tags": ["status:done"], "remove_tags": ["status:open"], "details_patch": {"status": "done", "assignee": null}, "observed_at": "2026-11-01", "expected_version": 3}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"mem-1\",\n  \"operation\": \"updated\",\n  \"re_embedded\": false,\n  \"scope\": \"working\",\n  \"version\": 4,\n  \"context_id\": \"ctx\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": true,\n  \"context_is_locked\": false\n}\n",
    stderr: "",
  },
  {
    name: "update-memory: --observed-at alone",
    argv: ["update-memory", "-m", "mem-1", "--observed-at", "2026-11-01T09:30:00Z"],
    replies: {"update_memory": ["UPDATE_OK"]},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "observed_at": "2026-11-01T09:30:00Z"}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"mem-1\",\n  \"operation\": \"updated\",\n  \"re_embedded\": false,\n  \"scope\": \"working\",\n  \"version\": 4,\n  \"context_id\": \"ctx\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": true,\n  \"context_is_locked\": false\n}\n",
    stderr: "",
  },
  {
    name: "update-memory: --accept-supersede-candidate",
    argv: ["update-memory", "-m", "mem-1", "--accept-supersede-candidate", "--expected-version", "3"],
    replies: {"update_memory": ["ACCEPT_OK"]},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "expected_version": 3, "accept_supersede_candidate": true}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"mem-1\",\n  \"operation\": \"updated\",\n  \"re_embedded\": false,\n  \"scope\": \"working\",\n  \"version\": 3,\n  \"superseded_memory_id\": \"mem-0\",\n  \"context_id\": \"ctx\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": true,\n  \"context_is_locked\": false\n}\n",
    stderr: "",
  },
  {
    name: "update-memory: an accept that meets another edge",
    argv: ["update-memory", "-m", "mem-1", "--accept-supersede-candidate"],
    replies: {"update_memory": ["EDGE_EXISTS"]},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "accept_supersede_candidate": true}]],
    code: 1,
    stdout: "",
    stderr: "Error: update_memory failed (edge_exists): A declared edge already links mem-1 and mem-0; nothing was written.\n",
  },
  {
    name: "update-memory: the accept with a field edit exits 1 before any call",
    argv: ["update-memory", "-m", "mem-1", "--accept-supersede-candidate", "-s", "a new summary here", "--observed-at", "2026-11-01"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: accept_supersede_candidate cannot be combined with field edits (summary, observed_at); send the edit in a separate update_memory call.\n",
  },
  {
    name: "update-memory: the accept with a dismissal exits 1",
    argv: ["update-memory", "-m", "mem-1", "--accept-supersede-candidate", "--dismiss-supersede-candidate"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: accept_supersede_candidate and dismiss_supersede_candidate cannot both be true: accept the suggestion or reject it.\n",
  },
  {
    name: "update-memory: the accept with --merge-details exits 1",
    argv: ["update-memory", "-m", "mem-1", "--accept-supersede-candidate", "--merge-details", "--location", "1,2"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: accept_supersede_candidate cannot be combined with field edits (details_patch); send the edit in a separate update_memory call.\n",
  },
  {
    name: "update-memory: a stale --expected-version prints the current version",
    argv: ["update-memory", "-m", "mem-1", "-s", "an updated summary", "--expected-version", "3"],
    replies: {"update_memory": ["VERSION_CONFLICT"]},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "summary": "an updated summary", "expected_version": 3}]],
    code: 1,
    stdout: "",
    stderr: "Error: update_memory failed (version_conflict): Memory mem-1 is at version 5, not the expected version 3. Read it again and resend with its current version.\n  Current version: 5\n  Help: reference() the memory and resend with its current version, or omit expected_version to overwrite.\n",
  },
  {
    name: "update-memory: --external-id with in-place-only flags",
    argv: ["update-memory", "--external-id", "ext-1", "--add-tag", "a", "--expected-version", "2", "--dismiss-supersede-candidate", "--accept-supersede-candidate", "--remove-tag", "b", "--details-patch", "{\"a\": 1}", "--merge-details"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: --dismiss-supersede-candidate, --accept-supersede-candidate, --merge-details, --details-patch, --add-tag, --remove-tag, --expected-version require --memory-id (not --external-id)\n",
  },
  {
    name: "update-memory: --external-id with --details-patch",
    argv: ["update-memory", "--external-id", "ext-1", "--details-patch", "{\"a\": 1}"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: --details-patch requires --memory-id (not --external-id)\n",
  },
  {
    name: "update-memory: a blank --details-patch is unset",
    argv: ["update-memory", "--external-id", "ext-1", "-s", "an upsert summary", "--content", "c", "-t", "note", "--details-patch", "  ", "--add-tag", " "],
    replies: {"update_memory": ["UPDATE_OK"]},
    calls: [["update_memory", {"context_id": "ctx", "external_id": "ext-1", "summary": "an upsert summary", "content": "c", "type": "note"}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"mem-1\",\n  \"operation\": \"updated\",\n  \"re_embedded\": false,\n  \"scope\": \"working\",\n  \"version\": 4,\n  \"context_id\": \"ctx\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": true,\n  \"context_is_locked\": false\n}\n",
    stderr: "",
  },
  {
    name: "update-memory: --tags with --add-tag",
    argv: ["update-memory", "-m", "mem-1", "--tags", "a,b", "--add-tag", "c"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: --tags replaces the whole list; --add-tag/--remove-tag edit it. Use one or the other.\n",
  },
  {
    name: "update-memory: --tags with --remove-tag",
    argv: ["update-memory", "-m", "mem-1", "--tags", "a", "--remove-tag", "c"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: --tags replaces the whole list; --add-tag/--remove-tag edit it. Use one or the other.\n",
  },
  {
    name: "update-memory: --details-patch with --details",
    argv: ["update-memory", "-m", "mem-1", "--details-patch", "{\"a\": 1}", "--details", "{\"b\": 2}"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: --details-patch cannot be combined with --details/--location/--merge-details\n",
  },
  {
    name: "update-memory: --details-patch with --merge-details",
    argv: ["update-memory", "-m", "mem-1", "--details-patch", "{\"a\": 1}", "--merge-details"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: --details-patch cannot be combined with --details/--location/--merge-details\n",
  },
  {
    name: "update-memory: --details-patch that is not an object",
    argv: ["update-memory", "-m", "mem-1", "--details-patch", "[1, 2]"],
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura update-memory [OPTIONS]\nTry 'kagura update-memory --help' for help.\n\nError: --details-patch must be a JSON object, got list. Example: --details-patch '{\"location\": {\"lat\": 35.68, \"lon\": 139.76}}'\n",
  },
  {
    name: "update-memory: --details-patch that is not JSON",
    argv: ["update-memory", "-m", "mem-1", "--details-patch", "{bad"],
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura update-memory [OPTIONS]\nTry 'kagura update-memory --help' for help.\n\nError: Invalid JSON for --details-patch: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)\n",
  },
  {
    name: "update-memory: --details-patch is parsed before the --external-id check",
    argv: ["update-memory", "--external-id", "ext-1", "--details-patch", "{bad", "--add-tag", "a"],
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura update-memory [OPTIONS]\nTry 'kagura update-memory --help' for help.\n\nError: Invalid JSON for --details-patch: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)\n",
  },
  {
    name: "update-memory: --expected-version 0",
    argv: ["update-memory", "-m", "mem-1", "--expected-version", "0"],
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura update-memory [OPTIONS]\nTry 'kagura update-memory --help' for help.\n\nError: Invalid value for '--expected-version': 0 is not in the range x>=1.\n",
  },
  {
    name: "update-memory: --expected-version that is no integer",
    argv: ["update-memory", "-m", "mem-1", "--expected-version", "abc"],
    calls: [],
    code: 2,
    stdout: "",
    stderr: "Usage: kagura update-memory [OPTIONS]\nTry 'kagura update-memory --help' for help.\n\nError: Invalid value for '--expected-version': 'abc' is not a valid integer range.\n",
  },
  {
    name: "update-memory: a bad --observed-at",
    argv: ["update-memory", "-m", "mem-1", "--observed-at", "2026-11-01 09:30"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: observed_at must be an ISO 8601 date (2024-03-07) or datetime (2024-03-07T10:00:00Z), got '2026-11-01 09:30'\n",
  },
  {
    name: "update-memory: --observed-at that disagrees with --details-patch",
    argv: ["update-memory", "-m", "mem-1", "--observed-at", "2026-11-01", "--details-patch", "{\"observed_at\": null}"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: details_patch['observed_at'] and observed_at disagree; give one of them (the server answers validation_error)\n",
  },
  {
    name: "update-memory: --observed-at that disagrees with --details",
    argv: ["update-memory", "-m", "mem-1", "--observed-at", "2026-11-01", "--details", "{\"observed_at\": \"2026-10-01\"}"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: details['observed_at'] and observed_at disagree; give one of them (the server answers validation_error)\n",
  },
  {
    name: "update-memory: an --add-tag over 100 characters",
    argv: ["update-memory", "-m", "mem-1", "--add-tag", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: each tag must be at most 100 characters, got 101\n",
  },
  {
    name: "update-memory: 51 --add-tag",
    argv: ["update-memory", "-m", "mem-1", "--add-tag", "t0", "--add-tag", "t1", "--add-tag", "t2", "--add-tag", "t3", "--add-tag", "t4", "--add-tag", "t5", "--add-tag", "t6", "--add-tag", "t7", "--add-tag", "t8", "--add-tag", "t9", "--add-tag", "t10", "--add-tag", "t11", "--add-tag", "t12", "--add-tag", "t13", "--add-tag", "t14", "--add-tag", "t15", "--add-tag", "t16", "--add-tag", "t17", "--add-tag", "t18", "--add-tag", "t19", "--add-tag", "t20", "--add-tag", "t21", "--add-tag", "t22", "--add-tag", "t23", "--add-tag", "t24", "--add-tag", "t25", "--add-tag", "t26", "--add-tag", "t27", "--add-tag", "t28", "--add-tag", "t29", "--add-tag", "t30", "--add-tag", "t31", "--add-tag", "t32", "--add-tag", "t33", "--add-tag", "t34", "--add-tag", "t35", "--add-tag", "t36", "--add-tag", "t37", "--add-tag", "t38", "--add-tag", "t39", "--add-tag", "t40", "--add-tag", "t41", "--add-tag", "t42", "--add-tag", "t43", "--add-tag", "t44", "--add-tag", "t45", "--add-tag", "t46", "--add-tag", "t47", "--add-tag", "t48", "--add-tag", "t49", "--add-tag", "t50"],
    calls: [],
    code: 1,
    stdout: "",
    stderr: "Error: add_tags accepts at most 50 tags, got 51\n",
  },
  {
    name: "update-memory: a long --remove-tag is sent",
    argv: ["update-memory", "-m", "mem-1", "--remove-tag", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
    replies: {"update_memory": ["UPDATE_OK"]},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "remove_tags": ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"mem-1\",\n  \"operation\": \"updated\",\n  \"re_embedded\": false,\n  \"scope\": \"working\",\n  \"version\": 4,\n  \"context_id\": \"ctx\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": true,\n  \"context_is_locked\": false\n}\n",
    stderr: "",
  },
  {
    name: "merge: 0.140.0+ takes the patch in one call",
    argv: ["update-memory", "-m", "mem-1", "--location", "35.68,139.76,Tokyo HQ", "--details", "{\"n\": 2, \"old\": null}", "--merge-details", "--dismiss-supersede-candidate"],
    replies: {"update_memory": ["UPDATE_OK"]},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "dismiss_supersede_candidate": true, "details_patch": {"n": 2, "old": null, "location": {"lat": 35.68, "lon": 139.76, "label": "Tokyo HQ"}}}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"mem-1\",\n  \"operation\": \"updated\",\n  \"re_embedded\": false,\n  \"scope\": \"working\",\n  \"version\": 4,\n  \"context_id\": \"ctx\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": true,\n  \"context_is_locked\": false\n}\n",
    stderr: "",
  },
  {
    name: "merge: --details '{}' is an empty patch",
    argv: ["update-memory", "-m", "mem-1", "--details", "{}", "--merge-details"],
    replies: {"update_memory": ["UPDATE_OK"]},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details_patch": {}}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"mem-1\",\n  \"operation\": \"updated\",\n  \"re_embedded\": false,\n  \"scope\": \"working\",\n  \"version\": 4,\n  \"context_id\": \"ctx\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": true,\n  \"context_is_locked\": false\n}\n",
    stderr: "",
  },
  {
    name: "merge: 0.82.0-0.139.x refuses, then reference() and the merged object",
    argv: ["update-memory", "-m", "mem-1", "--location", "35.68,139.76,Tokyo HQ", "--details", "{\"n\": 2, \"client\": null}", "--merge-details", "--expected-version", "3", "--observed-at", "2026-11-01"],
    replies: {"update_memory": ["REFUSE_PATCH", "UPDATE_OK"], "reference": ["REFERENCE"]},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details_patch": {"n": 2, "client": null, "location": {"lat": 35.68, "lon": 139.76, "label": "Tokyo HQ"}}, "observed_at": "2026-11-01", "expected_version": 3}], ["reference", {"context_id": "ctx", "memory_id": "mem-1"}], ["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details": {"location": {"lat": 35.68, "lon": 139.76, "label": "Tokyo HQ"}, "n": 2, "observed_at": "2026-11-01"}, "observed_at": "2026-11-01", "expected_version": 3}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"mem-1\",\n  \"operation\": \"updated\",\n  \"re_embedded\": false,\n  \"scope\": \"working\",\n  \"version\": 4,\n  \"context_id\": \"ctx\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": true,\n  \"context_is_locked\": false\n}\n",
    stderr: "note: --details-patch/--merge-details in one call needs memory-cloud 0.140.0+; this server refused it, merging via reference() instead.\n",
  },
  {
    name: "merge: --details-patch refused, then the fallback",
    argv: ["update-memory", "-m", "mem-1", "--details-patch", "{\"status\": \"done\"}", "-s", "an updated summary"],
    replies: {"update_memory": ["REFUSE_PATCH", "UPDATE_OK"], "reference": ["REFERENCE"]},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "summary": "an updated summary", "details_patch": {"status": "done"}}], ["reference", {"context_id": "ctx", "memory_id": "mem-1"}], ["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "summary": "an updated summary", "details": {"location": {"lat": 1.0, "lon": 2.0, "label": "old"}, "client": "acme", "n": 1, "observed_at": "2020-01-01", "status": "done"}}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"mem-1\",\n  \"operation\": \"updated\",\n  \"re_embedded\": false,\n  \"scope\": \"working\",\n  \"version\": 4,\n  \"context_id\": \"ctx\",\n  \"context_name\": \"dev\",\n  \"context_display_name\": null,\n  \"context_is_private\": true,\n  \"context_is_locked\": false\n}\n",
    stderr: "note: --details-patch/--merge-details in one call needs memory-cloud 0.140.0+; this server refused it, merging via reference() instead.\n",
  },
  {
    name: "merge: a refusal naming another argument stands",
    argv: ["update-memory", "-m", "mem-1", "--location", "35.68,139.76,Tokyo HQ", "--merge-details", "--add-tag", "x"],
    replies: {"update_memory": ["REFUSE_PATCH_AND_TAGS"]},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "add_tags": ["x"], "details_patch": {"location": {"lat": 35.68, "lon": 139.76, "label": "Tokyo HQ"}}}]],
    code: 1,
    stdout: "",
    stderr: "Error: update_memory failed (invalid_argument): update_memory does not accept the arguments 'add_tags', 'details_patch'. Arguments its inputSchema declares: context_id, memory_id.\n",
  },
  {
    name: "merge: a refusal without unknown_arguments stands",
    argv: ["update-memory", "-m", "mem-1", "--location", "35.68,139.76,Tokyo HQ", "--merge-details"],
    replies: {"update_memory": ["REFUSE_NO_LIST"]},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details_patch": {"location": {"lat": 35.68, "lon": 139.76, "label": "Tokyo HQ"}}}]],
    code: 1,
    stdout: "",
    stderr: "Error: update_memory failed (invalid_argument): update_memory does not accept the argument 'details_patch'.\n",
  },
  {
    name: "merge: the fallback refuses a bounded read",
    argv: ["update-memory", "-m", "mem-1", "--details-patch", "{\"a\": 1}"],
    replies: {"update_memory": ["REFUSE_PATCH"], "reference": ["REFERENCE_BOUNDED"]},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details_patch": {"a": 1}}], ["reference", {"context_id": "ctx", "memory_id": "mem-1"}]],
    code: 1,
    stdout: "",
    stderr: "note: --details-patch/--merge-details in one call needs memory-cloud 0.140.0+; this server refused it, merging via reference() instead.\nError: --details-patch: the memory's current details could not be read in full (24000 characters); the server bounds a reference reply and this CLI cannot page it yet. Send the complete object with --details and without --details-patch (the MCP reference tool returns the whole object with max_chars up to 100000 or details_offset paging).\n",
  },
  {
    name: "merge: before 0.82.0 ignored, confirmed, then the details",
    argv: ["update-memory", "-m", "mem-1", "--location", "35.68,139.76,Tokyo HQ", "--merge-details", "-s", "an updated summary"],
    replies: {"update_memory": ["UPDATE_NO_VERSION", "UPDATE_NO_VERSION"], "reference": ["REFERENCE"]},
    info: {"status": 200, "body": "{\"name\": \"Kagura Memory Cloud\", \"version\": \"0.81.0\", \"environment\": \"production\"}"},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "summary": "an updated summary", "details_patch": {"location": {"lat": 35.68, "lon": 139.76, "label": "Tokyo HQ"}}}], ["reference", {"context_id": "ctx", "memory_id": "mem-1"}], ["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details": {"location": {"lat": 35.68, "lon": 139.76, "label": "Tokyo HQ"}, "client": "acme", "n": 1, "observed_at": "2020-01-01"}}]],
    gets: 1,
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"mem-1\",\n  \"operation\": \"updated\",\n  \"re_embedded\": false,\n  \"scope\": \"working\"\n}\n",
    stderr: "note: --details-patch/--merge-details in one call needs memory-cloud 0.140.0+; this server ignored it (before 0.82.0), merging via reference() in a second call.\n",
  },
  {
    name: "merge: before 0.82.0, the ignored flags exit 1 after both writes",
    argv: ["update-memory", "-m", "mem-1", "--location", "35.68,139.76,Tokyo HQ", "--merge-details", "--add-tag", "x", "--remove-tag", "y", "--expected-version", "2", "--observed-at", "2026-11-01"],
    replies: {"update_memory": ["UPDATE_NO_VERSION", "UPDATE_NO_VERSION"], "reference": ["REFERENCE"]},
    info: {"status": 200, "body": "{\"name\": \"Kagura Memory Cloud\", \"version\": \"v0.75.2\", \"environment\": \"production\"}"},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "add_tags": ["x"], "remove_tags": ["y"], "details_patch": {"location": {"lat": 35.68, "lon": 139.76, "label": "Tokyo HQ"}}, "observed_at": "2026-11-01", "expected_version": 2}], ["reference", {"context_id": "ctx", "memory_id": "mem-1"}], ["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details": {"location": {"lat": 35.68, "lon": 139.76, "label": "Tokyo HQ"}, "client": "acme", "n": 1, "observed_at": "2026-11-01"}}]],
    gets: 1,
    code: 1,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"mem-1\",\n  \"operation\": \"updated\",\n  \"re_embedded\": false,\n  \"scope\": \"working\"\n}\n",
    stderr: "note: --details-patch/--merge-details in one call needs memory-cloud 0.140.0+; this server ignored it (before 0.82.0), merging via reference() in a second call.\nError: the server (before memory-cloud 0.82.0) ignored --add-tag, --remove-tag, --expected-version, --observed-at (--observed-at went into details.observed_at only, which this server does not read). Both writes happened (the first call applied the other changes, the second the merged details); those flags need a newer server, so check the memory with `kagura reference` before editing it again.\n",
  },
  {
    name: "merge: before 0.82.0, --expected-version alone",
    argv: ["update-memory", "-m", "mem-1", "--details-patch", "{\"a\": null}", "--expected-version", "2"],
    replies: {"update_memory": ["UPDATE_NO_VERSION", "UPDATE_NO_VERSION"], "reference": ["REFERENCE"]},
    info: {"status": 200, "body": "{\"name\": \"Kagura Memory Cloud\", \"version\": \"0.81.9\", \"environment\": \"production\"}"},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details_patch": {"a": null}, "expected_version": 2}], ["reference", {"context_id": "ctx", "memory_id": "mem-1"}], ["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details": {"location": {"lat": 1.0, "lon": 2.0, "label": "old"}, "client": "acme", "n": 1, "observed_at": "2020-01-01"}}]],
    gets: 1,
    code: 1,
    stdout: "{\n  \"status\": \"success\",\n  \"memory_id\": \"mem-1\",\n  \"operation\": \"updated\",\n  \"re_embedded\": false,\n  \"scope\": \"working\"\n}\n",
    stderr: "note: --details-patch/--merge-details in one call needs memory-cloud 0.140.0+; this server ignored it (before 0.82.0), merging via reference() in a second call.\nError: the server (before memory-cloud 0.82.0) ignored --expected-version. Both writes happened (the first call applied the other changes, the second the merged details); those flags need a newer server, so check the memory with `kagura reference` before editing it again.\n",
  },
  {
    name: "merge: no version from 0.82.0+ writes nothing more",
    argv: ["update-memory", "-m", "mem-1", "--location", "35.68,139.76,Tokyo HQ", "--merge-details"],
    replies: {"update_memory": ["UPDATE_NO_VERSION"]},
    info: {"status": 200, "body": "{\"name\": \"Kagura Memory Cloud\", \"version\": \"0.130.0\", \"environment\": \"production\"}"},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details_patch": {"location": {"lat": 35.68, "lon": 139.76, "label": "Tokyo HQ"}}}]],
    gets: 1,
    code: 1,
    stdout: "",
    stderr: "Error: the server answered update_memory without 'version' and reports version 0.130.0, so whether it applied --merge-details cannot be confirmed. Nothing more was written, but the call's other changes may have been: read the memory with `kagura reference` before trying again.\n",
  },
  {
    name: "merge: no version and exactly 0.82.0",
    argv: ["update-memory", "-m", "mem-1", "--details-patch", "{\"a\": 1}"],
    replies: {"update_memory": ["UPDATE_NO_VERSION"]},
    info: {"status": 200, "body": "{\"name\": \"Kagura Memory Cloud\", \"version\": \"0.82.0\", \"environment\": \"production\"}"},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details_patch": {"a": 1}}]],
    gets: 1,
    code: 1,
    stdout: "",
    stderr: "Error: the server answered update_memory without 'version' and reports version 0.82.0, so whether it applied --details-patch cannot be confirmed. Nothing more was written, but the call's other changes may have been: read the memory with `kagura reference` before trying again.\n",
  },
  {
    name: "merge: no version and an unparseable version",
    argv: ["update-memory", "-m", "mem-1", "--location", "35.68,139.76,Tokyo HQ", "--merge-details"],
    replies: {"update_memory": ["UPDATE_NO_VERSION"]},
    info: {"status": 200, "body": "{\"name\": \"Kagura Memory Cloud\", \"version\": \"main-abc123\", \"environment\": \"production\"}"},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details_patch": {"location": {"lat": 35.68, "lon": 139.76, "label": "Tokyo HQ"}}}]],
    gets: 1,
    code: 1,
    stdout: "",
    stderr: "Error: the server answered update_memory without 'version' and reports version main-abc123, so whether it applied --merge-details cannot be confirmed. Nothing more was written, but the call's other changes may have been: read the memory with `kagura reference` before trying again.\n",
  },
  {
    name: "merge: no version and a failed probe",
    argv: ["update-memory", "-m", "mem-1", "--location", "35.68,139.76,Tokyo HQ", "--merge-details"],
    replies: {"update_memory": ["UPDATE_NO_VERSION"]},
    info: {"status": 500, "body": "{\"detail\": \"boom\"}"},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details_patch": {"location": {"lat": 35.68, "lon": 139.76, "label": "Tokyo HQ"}}}]],
    gets: 1,
    code: 1,
    stdout: "",
    stderr: "Error: the server answered update_memory without 'version' and its version could not be read (HTTP 500: boom), so whether it applied --merge-details cannot be confirmed. Nothing more was written, but the call's other changes may have been: read the memory with `kagura reference` before trying again.\n",
  },
  {
    name: "merge: no version and a probe the model refuses",
    argv: ["update-memory", "-m", "mem-1", "--location", "35.68,139.76,Tokyo HQ", "--merge-details"],
    replies: {"update_memory": ["UPDATE_NO_VERSION"]},
    info: {"status": 200, "body": "{\"name\": \"x\"}"},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details_patch": {"location": {"lat": 35.68, "lon": 139.76, "label": "Tokyo HQ"}}}]],
    gets: 1,
    code: 1,
    stdout: "",
    stderr: "Error: the server answered update_memory without 'version' and its version could not be read (KaguraClient.get_server_info: unexpected server response for ServerInfo (version: Field required). The server may be newer than this SDK; upgrading kagura-memory may help.), so whether it applied --merge-details cannot be confirmed. Nothing more was written, but the call's other changes may have been: read the memory with `kagura reference` before trying again.\n",
  },
  {
    name: "merge: a stale --expected-version on 0.140.0+",
    argv: ["update-memory", "-m", "mem-1", "--location", "35.68,139.76,Tokyo HQ", "--merge-details", "--expected-version", "3"],
    replies: {"update_memory": ["VERSION_CONFLICT"]},
    calls: [["update_memory", {"context_id": "ctx", "memory_id": "mem-1", "details_patch": {"location": {"lat": 35.68, "lon": 139.76, "label": "Tokyo HQ"}}, "expected_version": 3}]],
    code: 1,
    stdout: "",
    stderr: "Error: update_memory failed (version_conflict): Memory mem-1 is at version 5, not the expected version 3. Read it again and resend with its current version.\n  Current version: 5\n  Help: reference() the memory and resend with its current version, or omit expected_version to overwrite.\n",
  },
  {
    name: "search-config: --content-chunks --no-llm-selector",
    argv: ["context", "search-config", "ctx", "--content-chunks", "--no-llm-selector"],
    replies: {"update_search_config": ["SEARCH_OK"]},
    calls: [["update_search_config", {"context_id": "ctx", "content_chunks_enabled": true, "llm_selector_enabled": false}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"context_id\": \"ctx\",\n  \"config\": {\n    \"semantic_weight\": 0.6,\n    \"bm25_weight\": 0.4,\n    \"fetch_factor\": 3,\n    \"use_rerank\": false,\n    \"content_chunks_enabled\": true,\n    \"content_chunks_effective\": true,\n    \"llm_selector_enabled\": false,\n    \"llm_selector_effective\": false\n  }\n}\n",
    stderr: "",
  },
  {
    name: "search-config: --no-content-chunks alone",
    argv: ["context", "search-config", "ctx", "--no-content-chunks"],
    replies: {"update_search_config": ["SEARCH_OK"]},
    calls: [["update_search_config", {"context_id": "ctx", "content_chunks_enabled": false}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"context_id\": \"ctx\",\n  \"config\": {\n    \"semantic_weight\": 0.6,\n    \"bm25_weight\": 0.4,\n    \"fetch_factor\": 3,\n    \"use_rerank\": false,\n    \"content_chunks_enabled\": true,\n    \"content_chunks_effective\": true,\n    \"llm_selector_enabled\": false,\n    \"llm_selector_effective\": false\n  }\n}\n",
    stderr: "",
  },
  {
    name: "search-config: --llm-selector with a weight",
    argv: ["context", "search-config", "ctx", "--llm-selector", "--fetch-factor", "4"],
    replies: {"update_search_config": ["SEARCH_OK"]},
    calls: [["update_search_config", {"context_id": "ctx", "fetch_factor": 4, "llm_selector_enabled": true}]],
    code: 0,
    stdout: "{\n  \"status\": \"success\",\n  \"context_id\": \"ctx\",\n  \"config\": {\n    \"semantic_weight\": 0.6,\n    \"bm25_weight\": 0.4,\n    \"fetch_factor\": 3,\n    \"use_rerank\": false,\n    \"content_chunks_enabled\": true,\n    \"content_chunks_effective\": true,\n    \"llm_selector_enabled\": false,\n    \"llm_selector_effective\": false\n  }\n}\n",
    stderr: "",
  },
];

const INFO_PATH = "/api/v1/system/info";

async function run(c: Pick<Case, "argv" | "replies" | "info">) {
  const out: string[] = [];
  const err: string[] = [];
  const server = new FakeServer();
  for (const [tool, names] of Object.entries(c.replies ?? {})) {
    server.toolTextQueues[tool] = names.map((name) => TEXTS[name]!);
  }
  if (c.info !== undefined) server.restResponses[INFO_PATH] = c.info;
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
  const code = await runCli(c.argv, deps);
  const calls = server.requests
    .filter((r) => r.body?.method === "tools/call")
    .map((r) => {
      const params = r.body!.params as { name: string; arguments: Record<string, unknown> };
      return [params.name, params.arguments] as [string, Record<string, unknown>];
    });
  const gets = server.requests.filter((r) => r.body === undefined && new URL(r.url).pathname === INFO_PATH).length;
  return { code, out, err, calls, gets, server };
}

/** The Python stderr as this bin words it: the command is `kagura-memory`. */
function asThisBin(stderr: string): string {
  return stderr.replaceAll("`kagura reference`", "`kagura-memory reference`");
}

async function expectPython(c: Case) {
  const result = await run(c);
  const { code, out, err, calls, gets } = result;
  expect(calls).toEqual(c.calls);
  expect(gets).toBe(c.gets ?? 0);
  expect(code).toBe(c.code);
  expect(out.length > 0 ? `${out.join("\n")}\n` : "").toBe(c.stdout);
  if (c.code === 2) {
    const pyError = c.stderr.split("\n").find((line) => line.startsWith("Error: "))!;
    const jsonError = /^Error: Invalid JSON for --[\w-]+: /.exec(pyError);
    if (jsonError !== null) {
      expect(err[0]?.startsWith(jsonError[0])).toBe(true);
    } else {
      expect(err[0]).toBe(pyError);
    }
  } else {
    expect(err.length > 0 ? `${err.join("\n")}\n` : "").toBe(asThisBin(c.stderr));
  }
  return result;
}

describe("remember / update-memory / context search-config, as the Python CLI 0.44.0", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_, c) => {
    await expectPython(c);
  });

  it("sends nothing at all when a local check refuses", async () => {
    // Not even the MCP initialize: every refusal comes before a request.
    for (const c of CASES.filter((c) => c.calls.length === 0)) {
      const { server } = await expectPython(c);
      expect(server.requests, c.name).toEqual([]);
    }
  });

  it("refuses --merge-details beside an empty --external-id=, where Python sends both ids", async () => {
    // A deliberate difference (README, "Command line"): the in-place-only
    // flags are refused beside any --external-id, as
    // --dismiss-supersede-candidate always was here, because "" still goes
    // out as external_id and the server refuses it beside a memory id. The
    // Python CLI 0.44.0 tests the id's truthiness and sends
    // {memory_id, external_id: "", details_patch}.
    const { code, err, server } = await run({
      argv: ["update-memory", "-m", "mem-1", "--external-id=", "--merge-details", "--location", "1,2"],
    });
    expect(code).toBe(1);
    expect(err).toEqual(["Error: --merge-details requires --memory-id (not --external-id)"]);
    expect(server.requests).toEqual([]);
  });

  it("refuses --content-chunks beside --no-content-chunks, as it does --rerank --no-rerank", async () => {
    // click takes whichever comes last; this bin refuses both (README).
    for (const pair of [
      ["--content-chunks", "--no-content-chunks"],
      ["--llm-selector", "--no-llm-selector"],
    ]) {
      const { code, err, server } = await run({ argv: ["context", "search-config", "ctx", ...pair] });
      expect(code).toBe(2);
      expect(err[0]).toBe(`Error: ${pair[0]} and ${pair[1]} are mutually exclusive; pick one.`);
      expect(server.requests).toEqual([]);
    }
  });

  it("writes nothing more when the probe throws something that is not a Kagura error", async () => {
    // Python catches KaguraError only around get_server_info(); anything
    // else propagates as the command's error, after the first write.
    const server = new FakeServer();
    server.toolTextQueues.update_memory = [TEXTS.UPDATE_NO_VERSION!];
    const err: string[] = [];
    const deps = {
      write: () => {},
      writeError: (line: string) => void err.push(line),
      loadConfig: () => ({ context_id: "ctx", api_key: "k" }),
      makeClient: (options: Record<string, unknown>) => {
        const client = makeClient(server, options);
        client.getServerInfo = async () => {
          throw new TypeError("probe exploded");
        };
        return client;
      },
    } as unknown as CliDeps;
    const code = await runCli(["update-memory", "-m", "mem-1", "--details-patch", '{"a": 1}'], deps);
    expect(code).toBe(1);
    expect(err).toEqual(["Error: probe exploded"]);
    expect(server.requests.filter((r) => r.body?.method === "tools/call")).toHaveLength(1);
  });
});

/**
 * The `--help` of the three commands, recorded from the Python CLI 0.44.0
 * (`kagura <command> --help`, COLUMNS=80): each description, whitespace
 * folded (click wraps it at 80 columns; this bin keeps Python's breaks), and
 * the help of each option #87 adds or rewords. This bin lays the options out
 * in its own columns, one line each, without click's range suffix
 * (`[x>=1]`).
 */
const PYTHON_DESCRIPTIONS: ReadonlyArray<readonly [string[], string]> = [
  [["remember"], "Store a memory directly (without AI analysis). Coordinates in --details must be JSON numbers, not strings: the server rejects string-typed lat/lon with a 422 by design. Updating a memory replaces details wholesale; `kagura update-memory --merge-details` revises location while keeping the other keys (or re-send them yourself)."],
  [["update-memory"], "Update an existing memory or upsert by external ID. Use --memory-id for in-place update, or --external-id for upsert. --details REPLACES the memory's details wholesale — the server does not deep-merge — so a bare --location without --merge-details drops every other details key (including the resource_id an --external-id upsert stores there: without it the next upsert of that id creates a new memory instead of replacing this one), and '{}' clears them. --merge-details sends --details/--location as a details_patch: the server merges their top-level keys over the current details in one call, keeps the keys they do not mention, and deletes a key given as null ('\"location\": null' too). --details-patch sends a patch you write yourself. On a server before memory- cloud 0.140.0 either falls back to reading the memory first with reference() and writing the merged object: two calls, not one atomic update (--expected- version still guards the write on 0.113.0+), and the read counts in the memory's access stats. A server before 0.82.0 ignores the patch instead of refusing it; the command confirms that version first, writes the merged details in a second call, and exits 1 naming any other new flag that server ignored (--add-tag, --remove-tag, --expected-version, --observed-at). Coordinates must be JSON numbers, not strings: the server rejects string- typed lat/lon with a 422 by design. --add-tag/--remove-tag edit the stored tags without resending them, and --expected-version makes the update fail, writing nothing, when another edit landed since you read the memory."],
  [["context", "search-config"], "Update search configuration for a context. Weights must sum to 1.0. The weights and reranker settings need context editor access; --content-chunks and --llm-selector need the context owner or a workspace owner/admin, and where the deployment gates them by plan, the plan's feature and a free slot."],
];

const PYTHON_OPTION_HELP: ReadonlyArray<readonly [string[], string, string]> = [
  [["remember"], "--observed-at", "When the fact held, not the write time: YYYY-MM-DD or an ISO 8601 datetime (naive = UTC). Stored as details.observed_at (server v0.127.0+)."],
  [["remember"], "--dedupe", "suggest (server default); check: write nothing when a near-duplicate exists and print it (status duplicate_candidate, exit 0: a result, not an error); off: never suggest a supersede for this memory, permanently (server v0.93.0+)."],
  [["remember"], "--tags-normalize", "Store each tag under the context's established spelling; lint reports each mapping as tag_normalized (server v0.93.0+)."],
  [["update-memory"], "--tags", "Comma-separated tags (replaces the whole list)"],
  [["update-memory"], "--add-tag", "Tag to add to the stored list, keeping the others (repeatable; not with --tags; server v0.140.0+)"],
  [["update-memory"], "--remove-tag", "Tag to remove from the stored list; one that is not there is ignored (repeatable; not with --tags; server v0.140.0+)"],
  [["update-memory"], "--accept-supersede-candidate", "Accept this memory's supersede_candidate: the candidate is shadowed by a supersedes edge. Needs --memory-id and no field edits in the same call (server v0.126.0+)"],
  [["update-memory"], "--expected-version", "Apply the update only while the memory is at this version (the 'version' that reference prints); else nothing is written and the current version is printed (server v0.113.0+)"],
  [["update-memory"], "--observed-at", "When the fact held: YYYY-MM-DD or an ISO 8601 datetime (naive = UTC). Alone it changes only details.observed_at (server v0.127.0+)"],
  [["update-memory"], "--merge-details", "Merge --details/--location into the memory's current details, top-level keys only, so unmentioned keys are kept; a null value deletes a key. One call (details_patch, server v0.140.0+). Needs --memory-id and one of --details/--location."],
  [["update-memory"], "--details-patch", "JSON object merged into the stored details, top-level keys only; a null value deletes the key: '{\"status\": \"done\", \"assignee\": null}'. Needs --memory-id; not with --details/--location/--merge-details (server v0.140.0+)"],
  [["context", "search-config"], "--reranker", "Reranker provider (self_hosted: the deployment's keyless local reranker)"],
  [["context", "search-config"], "--content-chunks", "Embed long content as chunk vectors; sends memory content, not only summaries, to the embedding and rerank providers. Context owner or workspace owner/admin only (server v0.110.0+)"],
  [["context", "search-config"], "--llm-selector", "Let recall send summaries and content to the deployment's judge model to keep the results that answer the query. Context owner or workspace owner/admin only (server v0.115.0+)"],
];

async function help(command: string[]): Promise<string[]> {
  const { code, out } = await run({ argv: [...command, "--help"] });
  expect(code).toBe(0);
  return out.join("\n").split("\n");
}

describe("--help, as the Python CLI 0.44.0", () => {
  it.each(PYTHON_DESCRIPTIONS.map(([command, text]) => [command.join(" "), command, text] as const))(
    "%s describes itself in Python's words",
    async (_, command, text) => {
      const lines = await help(command);
      const description = lines.slice(0, lines.indexOf("Options:")).join(" ").split(/\s+/).join(" ");
      expect(description).toContain(text.replaceAll("kagura ", "kagura-memory "));
    },
  );

  it.each(PYTHON_OPTION_HELP.map(([command, flag, text]) => [`${command.join(" ")} ${flag}`, command, flag, text] as const))(
    "%s",
    async (_, command, flag, text) => {
      const lines = await help(command);
      const options = lines.slice(lines.indexOf("Options:"));
      const line = options.find((l) => new RegExp(`^\\s+(?:-\\w, )?${flag}(?: |$)`).test(l));
      expect(line, flag).toBeDefined();
      expect(line!.trimEnd().endsWith(`  ${text}`)).toBe(true);
    },
  );
});
