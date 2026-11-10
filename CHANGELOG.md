# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `WorkspaceClient.listOperationHistory` for the workspace operation history of
  memory-cloud v0.154.0 (`GET /api/v1/workspaces/{id}/operation-history`), with
  the `OperationHistoryPage` / `OperationHistoryEvent` models and combined
  filters. The route accepts a signed-in web session only: a client built with
  an API key or OAuth token throws before any request. Pro and Max workspaces,
  owners and admins (#136).

## [0.17.0] - 2026-11-05

### Added

- Workspace member context-access APIs for memory-cloud v0.144.0, including
  explicit empty grants and a typed context-access conflict (#121).

### Changed

- Require Node.js >=22.12.0 for the SDK, CLI and MCPB bundle. Builds target Node 22 and the test suite runs on Vitest 5 (#115).
- CLI help now uses Click's 80-column layout, wrapped option descriptions,
  range metavars/annotations and required markers. Usage errors print Usage,
  the `--help` hint and the error without dumping command help; missing file
  paths follow the same rule. Parser errors that Click raises without context
  still print only the error. Remaining command-surface help differences from
  Python 0.44.0 are listed in `docs/cli-help-differences.md` (#111).

## [0.16.0] - 2026-11-05

Reliability fixes for the existing Python SDK/CLI 0.44.0 parity surface.
Node.js >=20.19.0 and the memory-cloud 0.75.0 floor remain unchanged.
CLI-wide help formatting, Node 22/Vitest 5 migration and context-access APIs
remain deferred to v0.17.0.

### Added

- The MCP proxy gives Python-compatible re-login guidance for HTTP 403
  `insufficient_scope` and HTTP 401 after the refresh attempt. Forwarded
  JSON-RPC errors retain their upstream codes and data.

### Changed

- Match Python SDK 0.44.0's shared quota classifier. `QUOTA-001` and
  `quota_exceeded` need a quota gate, a known tier quota type, or a retry
  window to produce `KaguraQuotaError`. Other refusals with these codes
  produce `KaguraError`, retaining server metadata. REST HTTP 429 and 402
  retain their status-specific mappings, as in Python.

### Fixed

- Validate member key and invitation rows in `WorkspaceClient` against the
  Python SDK 0.44.0 models. Malformed fields raise `KaguraResponseError`
  with the Python operation name. CLI commands reuse the validated rows,
  including normalized timestamps and model defaults.

- Sleep report and rollback responses now validate against the Python SDK
  0.44.0 models. `sleep rollback` prints model defaults, preserves exact
  counters, matches Python's confirmation and cancellation behavior, and
  prints the partial rollback summary before exiting with an error (#110).

- Claude setup validates resolved context IDs before writing and resolves
  UUID-shaped context names on the first page, following Python 0.44.0.
  UUID normalization now accepts Unicode decimal digits, including digits
  outside the BMP, while preserving Python's original length check (#116).

- Credential deletion now waits for the same lock as refresh and records
  revocation so a cached fallback cannot recreate a logged-out profile.
  **API change:** `deleteCredentialsFile()` returns `Promise<void>`; callers
  must `await` it. The portable `.lock-v1` protocol never breaks an old lock
  by age and refuses a legacy `.lock` marker. Concurrent credential sharing
  with Python 0.44.0/older TypeScript clients is unsupported; migration and
  crash-recovery steps are in `docs/compatibility.md` (#112; python-sdk#327).
- `auth token` refreshes within five minutes of expiry and prints Python's
  expiry warning and no-refresh-token error. Login rejects unreadable
  credentials before device authorization; refresh has a 30-second deadline
  including response-body reads; generic HTTP 401 errors retain server
  `code`, `help`, and details (#112).

## [0.15.0] - 2026-11-05

Parity target: the Python SDK and CLI 0.44.0, checked against memory-cloud
up to v0.143.0. `MIN_SERVER_VERSION` stays 0.75.0; each surface below names
the server version it needs, and
[`docs/compatibility.md`](docs/compatibility.md) lists them per release.
Apart from four sends listed next, every new option and flag is sent only
when set. A new tool argument is ignored by a server before v0.82.0 that
predates it and refused with `invalid_argument` by a server from v0.82.0
that predates it; a new MCP URL query key or header is ignored by any
server that predates it. The four sends nobody asks for are safe on every
server (the reasons are in `docs/compatibility.md`): `createContext`'s
quota pre-check sends `list_contexts` `limit: 1`, `rollbackSession`
always sends `dry_run`, `setup claude`'s name lookup sends
`name_contains` / `cursor` only after a page that says `has_more`, and
`auth logout` sends a second revoke for the access token.

Breaking for some callers, each entry below says how: Node.js 18 is no
longer supported
([#76](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/76)); `kagura-memory list` is the Python CLI's memory
listing, no longer a hidden spelling of `auth list`; `sleep history`
prints `{"reports": […]}` instead of a bare list; a 403
`insufficient_scope` and the REST capacity lock are no longer
`KaguraConnectionError`s; `recall()`'s return type,
`ResourceListItem.context_id` / `context_name` and
`SleepReport.llm_call_failures` are typed differently; and a
numeric-string id such as `"7"` now stays a string.

### Added

- **The server's error envelope on every error**
  ([#84](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/84);
  memory-cloud v0.78.0+ / v0.82.0+, memory-cloud#1684, #1742;
  python-sdk#299): `KaguraError` has `code` (the MCP envelope's `error`,
  the REST `error`, the OAuth `error` or a JSON-RPC `data.error`;
  `undefined` when the SDK raised the error itself or the server named no
  code) and `details` (the other fields the server sent, as sent, `{}`
  when none), set on every error built from a server body on both
  transports and in the device flow. Getters `help`, `serverCause`,
  `correlationId`, `retryable` and `outcome` read the envelope;
  `serverCause` is Python's `cause`, renamed because `Error.cause` holds
  the chained error. Branch on `code`, never on the message.
  `payload_too_large` (a memory over 1 MB on MCP, v0.108.0+,
  memory-cloud#2003) is a plain `KaguraError` with `limit` / `actual` in
  `details`.
- **`KaguraCapacityLockedError`**
  ([#84](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/84);
  memory-cloud v0.99.0+, memory-cloud#1941; python-sdk#299): a Free
  workspace over its capacity — MCP `capacity_locked`, REST 403
  `CAPACITY-001` with `details.gate: "capacity"`. Carries `cleanupUrl`,
  `memoryCount`, `memoryLimit`, `overMemories`, `usedBytes`,
  `storageLimitBytes`, `overBytes` (`null` when not sent, e.g. for a
  caller outside the locked workspace). It extends `KaguraError`, neither
  a quota nor a plan gate. `getUsage()` returns `capacity_lock`
  (`CapacityLock`, with `help` and, from the REST route, `purge_at`,
  v0.102.0+) and checks it as Python's model does.
- **`KaguraServiceUnavailableError`**
  ([#84](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/84);
  memory-cloud v0.82.0+, memory-cloud#1742; `DB-002` reasons v0.104.0+,
  memory-cloud#1980; python-sdk#299): every HTTP 503 — `/mcp`'s
  `temporarily_unavailable`, its JSON-RPC transport failures, REST
  `DB-002`. `retryAfter` from `Retry-After` (else
  `data.retry_after_seconds`; `null` for a write whose outcome is
  unknown), `reason` from `details.reason` (`pool_exhausted`,
  `connection_refused`, `database_error`, `deadlock`), else the MCP
  `cause`, else the code.
- **`KaguraPartialSessionRollbackError`**
  ([#86](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/86);
  memory-cloud v0.113.0+, memory-cloud#2044; python-sdk#301): a real
  `rollbackSession` run in which some items failed (`partial_rollback`),
  with `sessionSummary`, `totals`, `rollbackId` and `remaining`; call
  again with the same arguments to retry them. `session_not_found` is a
  `KaguraNotFoundError` on every tool.
- **Device flow**
  ([#84](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/84);
  memory-cloud v0.78.0+, memory-cloud#1671, and v0.84.0+,
  memory-cloud#1770; python-sdk#299): an RFC 6749 refusal from
  `device/authorize` (`invalid_request`, `invalid_client`,
  `invalid_scope`) is a `KaguraAuthError` whose `code` is the OAuth
  `error` and whose message and `details` carry the `error_description`
  (any other error body keeps the generic message and its "Verify the
  server URL" hint, with the body's code); `pollForToken` keeps an unknown
  OAuth error as `code`, and keeps polling on `temporarily_unavailable`
  until the device code expires, after `Retry-After` (never shorter than
  the interval) or the interval.
- **`recall` verbosity, full and maxChars**
  ([#82](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/82);
  memory-cloud v0.108.0 / v0.114.0 / v0.82.0, memory-cloud#2002, #2124,
  #1743; python-sdk#298):
  - `recall({ verbosity: "compact" | "full", full, maxChars })`.
    `verbosity: "full"` brings back `tags`, `context_summary`, `scope`,
    `version` and the uncut `summary`. `full` sets how many of the top
    hits carry `content` (0–100; `0` means summaries only). `maxChars` is
    the reply budget (10,000–100,000).
  - Each is sent only when set and checked locally before any request. A
    server from v0.82.0 that predates one refuses it (`invalid_argument`).
  - New types: `RecallVerbosity`, `RecallResponse`, `RecallResult`,
    `RecallConfidence`, `RecallSelector` and `SupersedeCandidate`. They
    cover `summary_cut`, `content` / `content_truncated` /
    `content_next_offset`, `spans`, `folded`, `observed_at`, `selector`,
    `full_applied`, `context_summary_omitted`, `truncated`,
    `explore_hints_omitted` and `supersede_candidate.verified`.
- **`maxChars` on `loadPinned`, `loadGuardrails`, `getAgentBootstrap` and
  `AgentsClient.bootstrap`**
  ([#82](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/82);
  memory-cloud v0.82.0, memory-cloud#1743; python-sdk#298): the reply
  budget, sent only when set. `AgentBootstrapResponse.context_summary_omitted`
  is typed.
- **`recallNearby({ includeDetails })`**
  ([#82](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/82);
  memory-cloud v0.82.0, memory-cloud#1743; python-sdk#298): since v0.82.0
  items carry `location` (typed on `NearbyMemory`) instead of `details`.
  `includeDetails: true` returns `details`, and items past the budget
  carry `details_omitted` / `details_total_chars`.
- **Session tools: `bootstrap`, `changesSince`, `listMatching`,
  `rememberBatch`, `forget({ memoryIds })`, `describeTools`, `guide`,
  `listRevisions` and `rollbackSession`**
  ([#86](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/86);
  memory-cloud v0.93.0+, memory-cloud#1849–#1853; python-sdk#301).
  `bootstrap()` opens a session on one context in one deterministic call
  — context block, guardrails, pinned / upcoming / changes lanes, each
  fail-soft — with `format: "index" | "full"` and `maxChars` down to 2,000
  from v0.115.0 (memory-cloud#2126). `changesSince()` pages a context's
  change log (`sessionId` v0.113.0, `byMe` v0.114.0; a forgotten memory's
  events carry no `summary` from v0.96.0). `listMatching()` is the MCP
  `list` tool: exact filters (`details.<key>` JSON-type strict), a stable
  order (`observed_at` v0.127.0) and a `total`. `rememberBatch()` stores
  1-50 memories, optionally atomic (`dedupe` takes `DedupeMode`); a batch
  that wrote nothing throws `KaguraError` `batch_failed` /
  `batch_refused` (rows in `details.results`) or `timeout`, an atomic
  batch over the daily quota `KaguraQuotaError`.
  `forget({ contextId, memoryIds })` (v0.117.0, memory-cloud#2127)
  returns a `ForgetBatchResult` with one `deleted` / `skipped` / `error`
  row per id (`not_attempted` from v0.118.0); it refuses `memoryId` /
  `query` / `k` beside it before any request. `describeTools()` /
  `guide()` read what the MCP URL's tool list leaves out and the server's
  manual. `listRevisions()` (v0.113.0, memory-cloud#2043) reads a
  memory's revision log; `rollbackSession()` (v0.113.0 / v0.114.0,
  memory-cloud#2044) plans or undoes what a session — or the caller in a
  window — wrote, `dry_run` always sent and `true` by default. Each reply
  is checked against the Python SDK's model and typed
  (`BootstrapResponse`, `ChangesSinceResponse`, `ListMatchingResponse`,
  `RememberBatchResult`, `ForgetBatchResult`, `ToolDescriptions`,
  `GuideResponse`, `RevisionsPage`, `SessionRollbackResult`).
- **`observedAt` on `remember` / `updateMemory`, and recall's
  `observedAfter` / `observedBefore`**
  ([#87](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/87);
  memory-cloud v0.127.0, memory-cloud#2330; python-sdk#302): when a fact
  held, a `YYYY-MM-DD` date or an extended ISO 8601 datetime (or a
  `Date`, sent as its UTC instant), stored as `details.observed_at`.
  Checked locally as the server checks it — a basic form, a time without
  seconds, an impossible day or a disagreeing `details.observed_at`
  throws before any request. `kagura-memory remember|update-memory
  --observed-at`.
- **Partial memory edits**
  ([#87](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/87);
  memory-cloud v0.140.0, memory-cloud#2585; python-sdk#302):
  `updateMemory({ addTags, removeTags, detailsPatch })` edit the stored
  tags and shallow-merge into the stored details (`null` deletes a key)
  instead of replacing them; never with `tags` / `details` /
  `externalId`, and `addTags` keeps the 50 × 100 caps. `kagura-memory
  update-memory --add-tag --remove-tag --details-patch`.
- **`expectedVersion` and `KaguraVersionConflictError`**
  ([#87](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/87);
  memory-cloud v0.113.0, memory-cloud#2043; python-sdk#302): an edit
  applies only while the memory is at that version, else nothing is
  written and `KaguraVersionConflictError` (`currentVersion`,
  `expectedVersion`, `memoryId`) is thrown — MCP `version_conflict`, REST
  409 `RES-002` with `details.reason === "version_conflict"`.
  `reference({ version })` reads an earlier version. `kagura-memory
  update-memory --expected-version` prints the current version when
  refused.
- **`acceptSupersedeCandidate`**
  ([#87](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/87);
  memory-cloud v0.126.0, memory-cloud#2308; python-sdk#302):
  `updateMemory({ memoryId, acceptSupersedeCandidate: true })` shadows the
  suggested older memory (`superseded_memory_id` in the reply); a graph
  action that takes no field edit. An accept that meets another declared
  edge throws `KaguraError` with `code` `"edge_exists"` and
  `details.existing_edge`. `kagura-memory update-memory
  --accept-supersede-candidate`.
- **`remember({ dedupe, tagsNormalize, verbose })`**
  ([#87](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/87);
  memory-cloud v0.93.0, memory-cloud#1853, #1851; python-sdk#302):
  `dedupe: "check"` returns `{ status: "duplicate_candidate", candidate }`
  and writes nothing; `"off"` opts out of supersede suggestions for good.
  `kagura-memory remember --dedupe --tags-normalize` (`--dedupe check`
  exits 0 on a duplicate). `toolTrigger` on both write methods merges
  into `details` (or `detailsPatch`).
- **Bounded, paged `reference`**
  ([#87](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/87);
  memory-cloud v0.78.0, memory-cloud#1685; python-sdk#302):
  `reference({ contentOffset, detailsOffset, contextOffset, fields,
  maxChars })` and a typed `ReferenceResponse` carrying the bounded-reply
  keys (`content_truncated`, `content_next_offset`, `details_omitted`,
  `details_json`, …); a reply whose `status` is not a string or whose
  `memory` is not an object throws `KaguraResponseError`. Of these, the
  Python SDK 0.44.0 wraps `content_offset` only.
- **`updateSearchConfig({ contentChunksEnabled, llmSelectorEnabled })`**
  ([#87](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/87);
  memory-cloud v0.110.0 / v0.115.0, memory-cloud#2015, #2144;
  python-sdk#302): context owner or workspace owner/admin. `kagura-memory
  context search-config --[no-]content-chunks --[no-]llm-selector`.
- **Typed write replies `RememberResult` / `UpdateMemoryResult`**
  ([#87](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/87);
  memory-cloud v0.108.0 / v0.113.0, memory-cloud#2003, #2043;
  python-sdk#302), returned as sent (apart from a `plan_headroom` entry
  the model cannot read, see below), every key optional, with `version`,
  `session_id` (v0.113.0) and `summary_truncated` /
  `summary_original_length` (v0.108.0).
- **`plan_headroom` notices**
  ([#88](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/88);
  memory-cloud v0.142.0+, memory-cloud#2615; python-sdk#314): the success
  reply of `bootstrap`, `rememberBatch`, `remember` and `updateMemory`
  carries `plan_headroom` when a plan dimension (`memories`,
  `memories_per_day`, `mcp_calls_per_day`) is at 80 % (`warning`) or 95 %
  (`critical`) of its effective limit. It holds one `PlanHeadroomNotice`
  per dimension, with `used`, `limit`, `percentage`, `plan`, `remedies`,
  `help` and, on the daily caps, `resets_at`. All four type it
  `PlanHeadroomNotice[]` and read it fail-open, like the Python SDK's
  `PlanHeadroom` field: an entry the model cannot read is dropped and the
  call still succeeds, and a value that is not a list, or has no readable
  entry, is left out. The Python SDK's `remember` / `update_memory` return
  their reply as an unchecked dict, so for a malformed notice only, Python
  keeps what `remember` / `updateMemory` drop here. `kagura-memory
  bootstrap` prints each notice as the Python CLI does (defaults filled,
  unreadable entries dropped); `remember`, `update-memory` and `files
  upload --remember` print the reply as sent, as the Python CLI does.
  Older servers do not send it.
- **`supersede_candidate.acceptance` on recall rows**
  ([#88](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/88);
  memory-cloud v0.142.0+, memory-cloud#2508; on `reference` since
  v0.137.0, memory-cloud#2427; python-sdk#314):
  `SupersedeCandidate.acceptance?: SupersedeAcceptance` (`{ allowed,
  reason? }`) says whether `updateMemory({ acceptSupersedeCandidate: true
  })` would go through. `reason` is set only on a refusal: `not_writable`
  (from v0.142.0 also the guardrail gate on a `details.tool_trigger`
  memory, memory-cloud#2614), `not_owner`, `newer_candidate` or
  `edge_exists`. It is absent on a share-key read and where the server
  could not evaluate it. The README documents the direction asymmetry:
  the accept refuses a candidate newer than its carrier, while
  `createEdge` / `updateEdge` apply no direction check.
- **Paging cursors**
  ([#85](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/85);
  memory-cloud v0.82.0+, memory-cloud#1743; python-sdk#299):
  `listContexts({ cursor })` and `getState({ cursor })` (list mode; a
  `cursor` with a `key` throws before any request) pass a page's
  `next_cursor` back, and `ListContextsResponse` types `has_more` /
  `next_cursor`. `listAgents` follows `next_cursor` to the end — at most
  50 pages, each agent `id` once — and throws `KaguraResponseError` on a
  page that says `has_more` without a cursor or repeats one.
  `getSleepReport({ actionsCursor, actionsLimit, maxChars })` pages the
  audit log: the detail carries `actions_has_more` /
  `actions_next_cursor`, and an action too large for its page
  `details_omitted` / `details_total_chars` instead of `details`. Each
  argument is sent only when set. CLI: `sleep report --actions-cursor C
  --actions-limit N` (1–200).
- **Page sizes for `listContexts` and `getState`, and `context list
  --limit/--cursor`**
  ([#89](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/89);
  memory-cloud v0.82.0+, memory-cloud#1743; python-sdk#315):
  - `listContexts({ limit })` takes 1-200 contexts a page. More than 20
    with `includeDetails` and no non-blank `nameContains` throws before
    any request, as the server would refuse it.
  - `nameContains` is now sent trimmed, and not at all when blank.
  - `getState({ limit, maxChars })` sizes a list-mode page (1-200
    entries, 10,000-100,000 characters), checked before any request. With
    `key`, any of `cursor` / `limit` / `maxChars` throws.
  - `createContext`'s quota pre-check reads a one-row page.
  - CLI `context list --limit N --cursor TOKEN` prints the page as JSON on
    stdout. When the page was cut, stderr adds `has_more` /
    `next_cursor` and the command for the next page; the cursor appears
    there only when it is ASCII digits. A blank `--cursor` is unset, and
    `--details --limit 21` without `--name-contains` exits 2.
  - `kagura-memory contexts` names the `context list --cursor` call on
    stderr when more contexts follow.
  - Servers before v0.82.0 ignore `limit`, `maxChars` and `--limit` /
    `--cursor` and return every context or entry.
- **`getSleepHistory({ source: "sleep" | "analysis" | "all" })`** and CLI
  `sleep history --source`
  ([#85](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/85);
  memory-cloud v0.138.0+, memory-cloud#2219; python-sdk#299).
- **`listEdges` warns about a cut direction**
  ([#85](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/85);
  memory-cloud v0.82.0+, memory-cloud#1743; python-sdk#299): when the
  server's default limit (50) or its 200 clamp cut a direction
  (`outgoing_has_more` / `incoming_has_more`), the client logs the Python
  SDK's warning through its `warn` option (default `console.warn`).
  `minWeight` is still always sent, `0.0` unless set, so every edge comes
  back although the server's own default is 0.05 since v0.117.0
  (memory-cloud#2127).
- **`KaguraClientOptions.warn`**
  ([#85](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/85);
  client-side, every server; python-sdk#299): where the client's advisory
  warnings go — `listEdges`' cut-direction warning and
  `checkServerVersion`'s below-minimum warning, the ones the Python SDK
  logs on its `kagura_memory` logger. Default `console.warn`;
  `warn: () => {}` silences them, `warn: (m) => logger.warn(m)` routes
  them.
- **Local write caps**
  ([#85](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/85);
  memory-cloud v0.82.0's bounds, checked on every server; python-sdk#299):
  `remember` / `updateMemory` throw before any request for more than 50
  tags or a tag longer than 100 characters, and `setState` for a value
  longer than 16,384 characters of compact JSON as the server measures
  it, in the Python SDK's words.
- **CLI `kagura-memory bootstrap`, `changes SINCE`, `list` and `forget
  --ids`**
  ([#86](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/86);
  memory-cloud v0.93.0+, `forget --ids` v0.117.0+; python-sdk#301), the
  Python CLI 0.44.0's, printing the Python model's dump of the reply.
  `forget --ids ID,ID` refuses `-k` and, when every id failed, prints one
  `<id> <status> [<error>]` row per id on stderr before the error.
- **`kagura-memory recall --verbosity {compact,full} --full N --max-chars
  N`**
  ([#82](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/82);
  memory-cloud v0.108.0 / v0.114.0 / v0.82.0; python-sdk#298): when a
  server refuses one of them with `invalid_argument`, the command retries
  once without the ones the refusal names and says so on stderr. Output,
  notes and exit codes match the Python CLI 0.43.0+.
- **CLI error lines**
  ([#84](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/84);
  memory-cloud v0.78.0+, memory-cloud#1684; python-sdk#299): a failed
  command prints, under its `Error: …` line on stderr, `  Help: <help>`
  whenever the error carries the server's `help` and
  `  Correlation ID: <id>` whenever it carries a `correlation_id`, plus
  the capacity lock's `  Clean up or re-subscribe: <url>` (unless `help`
  already names it) and a 503's `  Retry after: N s`, in the Python CLI
  0.43.0+'s format and order; an error without them prints as before.
  Exit codes are unchanged.
- **`doctor` warns about a non-`kagura_` key**
  ([#84](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/84);
  memory-cloud v0.119.0+, memory-cloud#1994; python-sdk#299): in the auth
  section and Python's words, about a static key that does not start with
  `kagura_`: memory-cloud v0.119.0+ routes such a bearer as an OAuth
  token, so it is a 401. A client-side check, shown on every server. Exit
  codes are unchanged.
- **`?add_tools=` and `?context=` on the MCP URL; `kagura-memory-mcp`
  query and session flags**
  ([#83](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/83);
  memory-cloud v0.93.0 / v0.114.0 / v0.129.0, memory-cloud#1849, #2122,
  #2125, #2354; python-sdk#300).
  - Since memory-cloud 0.93.0 a bare MCP URL lists the `core` tool
    profile (21 tools; `?profile=full` lists 72). `tools/call` is
    unaffected.
  - `setup claude --add-tools NAME[,NAME…] --context CONTEXT_ID` writes
    `?add_tools=` / `?context=` into the entry. `setup
    codex|hermes|openclaw` take `--add-tools` and `--tool-profile`.
  - `kagura-memory-mcp` takes `--guardrails`, `--tool-profile`,
    `--add-tools`, `--context` and `--session-id`. `--session-id` defaults
    to `$KAGURA_MCP_SESSION_ID` and is sent as `Kagura-Session-Id` on
    every upstream request.
  - `MemoryClient.getGuardrailDigest({ addTools })` and `guardrails digest
    --add-tools` send the digest route's `add_tools`.
  - `doctor` ends with a `tools` check: the `tools/list` count and the
    profile / `add_tools` / allowlist that the CLI's MCP URL selects.
  - `recall`'s `explore_hints` need `explore` listed on memory-cloud
    0.135.0+ (memory-cloud#2470): `--add-tools explore` writes that URL.
  - `--tool-profile` now refuses a name starting with `-`, and its errors
    use Python 0.44.0's words.
- **memory-cloud v0.141.0 response fields**
  ([#85](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/85);
  memory-cloud v0.79.0–v0.141.0; python-sdk#299), each optional with the
  Python model's default: `ServerFeatures.content_chunks_require_plan` /
  `llm_selector_require_plan`; `SearchConfig`'s `content_chunks_*`,
  `llm_selector_*` and `embedding_provider`;
  `MemberAPIKey.default_context_id` / `default_context_name` / `agent_id`
  / `connector_id`; `WorkspaceMember.seat_paused`;
  `IndexerStateMetrics.failed_events` and the `plan_suspended` /
  `memory_limit_exceeded` skip reasons;
  `FailedMemoryInfo.embedding_attempted_at`; `Agent.description_truncated`;
  `GuardrailSet.context_summary_omitted`; `ContextGuardrails.provenance`
  and a `ContextGuardrailItem` type with `summary_cut`;
  `MemoryListItem.observed_at` (the stored date or datetime text, not
  parsed); `ListTagsResponse.has_more`; `SleepReport.source` and the
  `SleepReportSource` type; `SleepReportDetail.note`;
  `RollbackSummary.chunks_requeued` / `points_requeued`. The
  pydantic-parity readers fill them in, so `workspace member list
  --json`, `auth list-keys --json`, `auth create-key`, `resource
  indexer-status` and `guardrails load` print the new keys as the Python
  CLI 0.44.0 does.
- **README: "Permission model (memory-cloud v0.126.0+)"**
  ([#85](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/85);
  memory-cloud v0.126.0; python-sdk#299): owner/admin reach every shared
  context, a member or viewer its `allowed_context_ids` (none set: a
  viewer every shared context, a member none), a context outside the list
  is `KaguraNotFoundError`, a workspace viewer is read-only; resource
  tokens are workspace-scoped (v0.94.0) and another workspace's token is
  404 (v0.97.0); `deleteContext` soft-deletes the context's files and
  `mergeContexts({ deleteSource: true })` moves them (v0.101.0); a
  `supersedes` edge needs both memories to be the caller's (v0.132.0).
- **`docs/compatibility.md`**
  ([#93](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/93);
  python-sdk#323): which memory-cloud release each SDK release needs and
  was checked against, one section per release from 0.15.0 back to 0.1.0,
  with the floor of every method, option and flag newer than
  `MIN_SERVER_VERSION`, in the shape of the Python SDK's file.

### Changed

- **403 `insufficient_scope` is a `KaguraAuthError`**
  ([#84](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/84);
  memory-cloud v0.79.0+, memory-cloud#1686; python-sdk#299): an OAuth
  token without the scope a call needs (`memory:read` for the read-only
  tools, `memory:write` for the rest — every write from a `--read-only`
  login) raised `KaguraConnectionError` (`HTTP 403: …`); it now raises
  `KaguraAuthError` naming the scope and the re-login (`kagura-memory auth
  login`), with `code` `"insufficient_scope"` and
  `details.required_scope`, on `KaguraClient` and every REST client
  (before a client's own 403 hint).
- **HTTP 503 is a `KaguraServiceUnavailableError`**
  ([#84](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/84);
  memory-cloud v0.82.0+, memory-cloud#1742; python-sdk#299): a
  `KaguraConnectionError` subclass, so handlers catching
  `KaguraConnectionError` keep catching it; the message is unchanged.
- **The capacity lock is a `KaguraCapacityLockedError`**
  ([#84](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/84);
  memory-cloud v0.99.0+, memory-cloud#1941; python-sdk#299): it was a
  plain `KaguraError` (MCP) or `KaguraConnectionError` (REST 403).
- **`authorizeDevice` refusal messages**
  ([#84](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/84);
  memory-cloud v0.78.0+, memory-cloud#1671; python-sdk#299) read `Device
  authorization failed (HTTP 400 invalid_client): …` (the OAuth `error`
  after the status) for an RFC 6749 refusal, as the Python SDK's since
  0.43.0; any other error body keeps the previous message and hint.
- **`recall` hits are compact by default on memory-cloud v0.108.0+**
  ([#82](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/82);
  memory-cloud#2002, #2124, #2470; python-sdk#298): a 160-character
  summary head, with no `tags`, `context_summary` or `scope`. Code that
  reads those from a hit must pass `verbosity: "full"`. Since v0.114.0 the
  top 3 hits on MCP also carry `content`; pass `full: 0` for summaries
  only. Since v0.135.0 `includeExploreHints` gets hints only on an MCP URL
  with `?add_tools=explore` or `?profile=full`; `explore()` is
  unaffected.
- **`recall()` returns `RecallResponse` instead of `ToolResult`**
  ([#82](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/82);
  client-side; the Python SDK 0.43.0+ keeps a `dict`, python-sdk#298):
  the same value, now typed. It is still assignable to `ToolResult`. A
  cast of `results` to your own row type that names a key `RecallResult`
  does not declare now needs `as unknown as`.
- **`get_sleep_history` lists Sleep runs only by default on memory-cloud
  v0.138.0+**
  ([#85](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/85);
  memory-cloud#2219; python-sdk#299): the server leaves out the rows
  Memory Analysis writes for its LLM spend unless `source` asks for them
  (`"analysis"`, `"all"`); older servers list both and send no `source`.
  `getSleepHistory` sends `source` only when set, and v0.82.0–v0.137.x
  refuse it (`invalid_argument`).
- **`KaguraClient.getToolDefinitions()` refuses a malformed `tools/list`
  result**
  ([#83](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/83);
  client-side, every server; python-sdk#311). A result that is not an
  object, or whose `tools` is not a list of objects, throws
  `KaguraResponseError` (`operation`
  `KaguraClient.get_tool_definitions`), as the Python SDK 0.44.0 does,
  instead of returning `[]`. A result without `tools` still lists none.
  `doctor`'s `tools` check fails with that message.
- **`kagura-memory list` is the Python CLI's `list` command**
  ([#86](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/86);
  memory-cloud v0.93.0+; python-sdk#301): it lists a context's memories by
  exact filters. It was a hidden v0.7.0 spelling of `auth list`, which is
  unchanged; the other bare `auth` aliases stay. A script that ran
  `kagura-memory list` for the profiles must now run `kagura-memory auth
  list`.
- **`forget`'s `-k` has no default of its own**
  ([#86](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/86);
  python-sdk#301) in `--help`, and a call without a target says `Either
  --memory-id or --query is required (or --ids)`, as the Python CLI 0.44.0
  (query mode still sends `k: 10`, on every server).
- **`remember` / `update-memory --details` read JSON as the Python CLI
  does**
  ([#86](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/86);
  client-side; python-sdk#301): text that is not JSON is refused in
  Python's `json` words (`Invalid JSON for --details: Expecting value:
  line 1 column 7 (char 6)`), and a `NaN` or infinity in the object, which
  JavaScript's parser refused as invalid JSON (exit 2), is now `Out of
  range float values are not JSON compliant: nan` (exit 1), Python's line,
  rather than ever being sent as `null`.
- **`update-memory --merge-details` is one call**
  ([#87](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/87);
  memory-cloud v0.140.0+, memory-cloud#2585; python-sdk#302, continuing
  python-sdk#247 /
  [#70](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/70)):
  `--details` / `--location` go out as one `details_patch`, so unmentioned
  keys are kept without a read and a `null` value now deletes a key. The
  `reference()` read-then-write round-trip is kept only for a server that
  refuses the patch (0.82.0–0.139.x: nothing is written, then the merged
  object is sent) or ignores it (before 0.82.0: confirmed with `GET
  /api/v1/system/info` before the second write; exit 1 naming each of
  `--add-tag` / `--remove-tag` / `--expected-version` / `--observed-at`
  that server ignored). A reply without `version` from 0.82.0+, or a probe
  that fails, writes nothing more and exits 1.
- **`sleep history` and `sleep report` print the Python CLI's dump**
  ([#85](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/85);
  client-side, every server; python-sdk#299): `history` prints
  `{"reports": […]}` rather than the bare list, and both read each report
  through the Python SDK's model — its keys in its order, its defaults
  filled, unknown keys dropped, timestamps in pydantic's form, with the
  known float-literal difference of the MCP text path (`1.0` in a
  `details` / `*_result` object prints `1`) — so a report the model
  refuses exits 1 with the `KaguraResponseError` text. `getSleepHistory` /
  `getSleepReport` still return the body as the server sent it.
- **The MCP URL's query is read once, and as the server reads it**
  ([#91](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/91);
  `?profile=` / `?tools=` memory-cloud v0.73.0+, memory-cloud#1601,
  `?guardrails=` v0.74.0+, memory-cloud#1621, `?add_tools=` v0.129.0+,
  memory-cloud#2354; python-sdk#311).
  - `setup *`, `kagura-memory-mcp` and the Claude plugin's `server_url`
    share one reader. `guardrails=off` is the first value, trimmed as
    Python and memory-cloud trim it.
  - Each command splits its URL once, for its warnings and the URL it
    writes.
  - A REST error response's body is decoded once, however many of the
    client's error hooks read it (Python's `ErrorBody`). Errors are
    unchanged.
- **`ResourceListItem.context_id` / `context_name` may be `null`**
  ([#80](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/80);
  memory-cloud v0.94.0+, memory-cloud#1863; python-sdk#297, fixed there in
  0.42.2): both fields are now typed `?: string | null` instead of
  `string` (optional, as Python's `str | None = None`), so TypeScript
  callers that read them need a null check. This lets
  `ResourceClient.listResources()` read the row memory-cloud v0.94.0+
  sends for a resource whose contexts were all deleted while it still
  holds active tokens: both fields `null`, so those tokens stay reachable,
  and revoking the last token removes the row. Before, one such row made
  `listResources()` throw `KaguraResponseError` and `kagura-memory
  resource list` exit 1; now the row is returned and printed as the Python
  CLI prints it. For such a resource `getResourceImpact` and
  `getIndexerStatus` throw `KaguraNotFoundError` and `getResourceSchema`
  returns `null` (the server's 404); `listResourceEvents` still returns
  its events. Older servers never send the row.
- **A numeric-string id now stays a string**
  ([#102](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/102);
  memory-cloud v0.89.0+, memory-cloud#1008; the Python SDK 0.42.1+'s
  `int | str`, python-sdk#294; behaviour change from 0.14.1): 0.14.1 read
  a wire `"7"` in an `int | str` id as the integer `7` (its note said
  `"7"` still reads `7`); it is now the string `"7"`, as pydantic's
  smart-mode union keeps it. This reaches `WorkspaceClient.mintMemberKey`'s
  `id` and the CLI's `--json` / model dumps: `resource tokens
  list|create|update` (`id`), `resource setup` (`token_id`), `auth
  list-keys --json` and `workspace invite list --json` (`id`). Only a
  reply that sends an id as a numeric string changes: an integer still
  reads as the integer, and `ResourceClient`'s methods return the body as
  it arrived, as before.
- **`SleepReport.llm_call_failures` is typed `number | null`**
  (`@default null`;
  [#85](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/85);
  memory-cloud before v0.43.0; python-sdk#299): servers older than v0.43.0
  send `null` or nothing, and the Python model is `int | None = None`; it
  was typed `number` with `@default 0`.
- **README parity target**
  ([#93](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/93)):
  the Python SDK and CLI 0.44.0, checked against memory-cloud up to
  v0.143.0, where it was 0.42.0 and v0.77.0; `MIN_SERVER_VERSION` stays
  0.75.0 (the decision and the reasons are in `docs/compatibility.md`).
- **Node.js 18 is no longer supported; the floor is 20.19.0**
  ([#76](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/76);
  breaking; no server or python-sdk counterpart). `engines.node` and the
  Claude Desktop bundle's `compatibility.runtimes.node` are `>=20.19.0`,
  the floor `age-encryption`'s `@noble/*` dependencies already declare,
  so installing the optional crypto peer no longer warns `EBADENGINE`.
  Node 18 reached end of life on 2025-04-30; stay on 0.14.x if you cannot
  leave it. The Node 18 WebCrypto shim goes with it: `encrypt`,
  `generateKeypair` and everything built on them no longer install
  `node:crypto`'s `webcrypto` as `globalThis.crypto` when the global is
  missing, since every supported Node provides it, and `npm run
  test:no-webcrypto` (the suite with the global deleted) is removed. On a
  runtime without the global (Node 18 with the engines warning ignored),
  `encrypt`, `decrypt`, `generateKeypair` and `recipientFromIdentity` now
  throw a `KaguraCryptoError` that names the running Node and the 20.19.0
  floor. They no longer fail inside `@noble` with
  `crypto.getRandomValues must be defined`. CI tests Node 20, 22 and 24,
  and runs the bundle's smoke test on exactly 20.19.0. The test toolchain
  moves to vitest 4.1 (vite 8), replacing vitest 3.2 and the vite 6 pin,
  which fixes GHSA-82fw-gwwq-j7x9 (Dependabot alerts 11 and 12, dismissed
  until now) and GHSA-qxg6-89mg-rqv8; the open vite, tinypool,
  source-map-js and node-forge (now 1.4.3, via `@anthropic-ai/mcpb`)
  advisories clear with it. tsup now targets `node20`, which emits the
  same bytes as `node18` did. Apart from the shim and the new runtime
  check, the published code is unchanged. Upgrading: Node.js >= 20.19.0
  is required; on Node 18, stay on `kagura-memory@0.14`.

### Fixed

- **Sleep report and rollback work again on memory-cloud v0.82.0+**
  ([#79](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/79);
  memory-cloud#1742; python-sdk#296, fixed in the Python SDK 0.42.2): from
  v0.82.0 every MCP tool refuses an argument its schema does not declare,
  and no memory-cloud release declares `context_id` on `get_sleep_report`
  or `rollback_sleep_run`. `KaguraClient.getSleepReport()`,
  `rollbackSleepRun()` and `kagura-memory sleep report|rollback` therefore
  failed every call there with `invalid_argument`. They now send
  `report_id` only, which works on every server. `contextId` is ignored
  and now optional, so calls that pass it still compile. The CLI's
  `CONTEXT_ID` stays a required positional and is ignored too: the server
  finds the run by `report_id`. From v0.126.0 (memory-cloud#2315) the
  server authorizes against the report's own context: read access for a
  report, and the editor or owner role for a rollback
  (`KaguraPermissionError` without it; a workspace viewer cannot roll
  back). A report in a context the caller cannot read throws
  `KaguraNotFoundError`, like a missing one. From v0.140.0
  (memory-cloud#2547) a Memory Analysis report (`source: "analysis"`) is
  refused by `rollbackSleepRun` with `analysis_report`, a plain
  `KaguraError`.
- **One locked refresh path; an unreadable credentials file is never
  rewritten; a failed save is typed**
  ([#92](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/92);
  client-side, every server; memory-cloud v0.79.0 single-use refresh
  tokens, memory-cloud#1686; python-sdk#313): `KaguraOAuth` (every client
  and `kagura-memory-mcp`), `refresh()` and `kagura-memory auth refresh` /
  `auth token` refresh through one path that re-reads `credentials.json`
  under the cross-process lock and uses a profile another process already
  rotated (to a token that has not expired) without sending anything;
  `auth refresh` then prints `✓ Profile 'NAME' was already refreshed by
  another process.` (exit 0), and after a refresh of its own Python's
  `✓ Refreshed profile 'NAME'.` with `Scope:` and `Expires:` lines
  (replacing `Refreshed. Expires … Scope: …`). A `credentials.json` that
  exists but cannot be read or parsed — a dangling symlink and an
  unsearchable directory included — is refused with `KaguraAuthError`
  `Cannot update <path>: <reason>.` before any refresh request or write —
  by a refresh (under the lock), `updateProfile` (so `login()`'s save),
  `setDefaultProfile`, `deleteProfile` and `kagura-memory-mcp` (at
  startup, before any browser login) — instead of being rewritten with
  one profile; a missing file is still "no profile", and
  `loadCredentialsFile()`, `refresh()`, `auth refresh` and `auth token`
  still read an unreadable file as holding no profile first, as Python's
  do (now also a non-UTF-8 one). When the server rotated but the profile
  cannot be saved, the refresh throws `KaguraAuthError` `Refreshed profile
  'NAME', but could not save it to <path>: …` saying the refresh token on
  file is used up and to run `kagura-memory auth login`; the process keeps
  the rotated token in memory and uses it for its next refresh,
  `kagura-memory-mcp` serves the request with it and logs the message
  once, `auth refresh` / `auth token` exit 1 and `auth token` prints no
  token. A widening `--scope` whose device-flow grant cannot be saved
  throws the same kind of error (`Got consent for scope 'S' on profile
  'NAME', but could not save it to <path>: …`) and keeps the grant in
  memory. `refresh()`'s missing-profile error now reads `No profile named
  'NAME'.\n  Run: kagura-memory auth login`, and `auth token`'s
  missing-profile line starts with `Error: `, as Python's does.
- **`auth logout` revokes the refresh token**
  ([#81](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/81);
  memory-cloud v0.82.0+, memory-cloud#1741; python-sdk#312, the Python CLI
  0.43.0's `_revocable_token`): `kagura-memory auth logout` (one profile
  or `--all`) now revokes each profile's refresh token and, when the
  profile has both, the access token too, so servers before 0.82.0 also
  lose the access token at logout. Up to 0.14.1 logout revoked only the
  access token, which left the refresh token valid on the server, so a
  logged-out profile could still be refreshed. Each request to
  `/api/v1/oauth/revoke` carries the profile's `client_id`. One 30 s
  bound covers a profile's requests, and the revoke stays best effort. On
  memory-cloud 0.82.0+ revoking the refresh token revokes its access
  token too, and the second request changes nothing. The Python CLI sends
  only the refresh token. A profile with no token sends nothing. The
  warning printed when a revoke fails now has Python 0.43.0's wording:
  `Its tokens may stay valid on the server until they expire.`
- **`setup claude --context-id NAME`**
  ([#90](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/90);
  memory-cloud v0.73.0 `name_contains` / v0.82.0 cursor paging,
  memory-cloud#1743; python-sdk#309): a context name from `-c`,
  `.kagura.json`'s `context_id` or `KAGURA_CONTEXT_ID` is now resolved to
  its id through `list_contexts` on the setup key and URL, by exact name
  on every page (`name_contains` and the cursor when the first page says
  `has_more`, at most 50 pages), and the id is written. Before, setup made
  no connection and wrote the name into `.kagura.json`, which every later
  command refused, since the server takes only a UUID. Any value but a
  dashed UUID, up to 100 characters, is looked up, a dashless 32-hex name
  included, and the value is trimmed; it is matched by id or exact name
  on the first page, then by exact name on every page. A context that is
  only whitespace stops setup with Python's `Invalid context_id: '' —
  must be alphanumeric, hyphens, or underscores only` (exit 1), before
  any request or write; an empty `--context-id` counts as none. A value
  no page matches, or a longer one, is still written as given, after
  Python's stderr warning `Warning: no context named 'NAME' is visible to
  this credential; using it as a raw context id.` when it is not a UUID.
  Paging that does not add up (`Setup failed: …`) and a failed request
  (`Authentication failed: …` / `Cannot connect to …` with Python's
  hints, else `Connection failed: …` on the first page) stop setup (exit
  1) before anything is written or run, as does a blank key: the lookup
  never authenticates with any credential but the setup key. A dashed
  UUID or no context still sends no request.
- **`setup codex|hermes|openclaw --dry-run`**
  ([#90](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/90);
  client-side, no request; python-sdk#309): a `--context-id` UUID not in
  the dashed form (dashless, `{braced}`, `urn:uuid:`) shows as `<UUID of
  context VALUE>`, as the Python CLI 0.44.0 shows it, in the AGENTS.md
  line and in the Codex entry's `?guardrails=` URL. A real run still
  writes the canonical UUID, and these setups still take only a UUID
  (`-c` NAME is exit 2).
- **`setup claude` names a dropped `?tools=` allowlist**
  ([#91](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/91);
  `?tools=` memory-cloud v0.73.0+, memory-cloud#1601; python-sdk#311). A
  re-run whose `--mcp-url` leaves out the replaced entry's `?tools=`
  allowlist now says so, as the Python CLI 0.44.0 does: `Note: the
  previous project-scope entry also had ?tools=recall,remember, which
  this run left out; re-run with it (?tools= on the MCP URL) to keep it.`
- **A padded `?guardrails=off` reads as the server reads it**
  ([#91](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/91);
  `?guardrails=` memory-cloud v0.74.0+, memory-cloud#1621;
  python-sdk#311). `setup claude` decides the plugin's `server_url`
  (`…?guardrails=off`) and whether to print the "re-run with
  `--guardrails off`" note. It now reads `?guardrails=%1Foff` (a control
  character, which Python's `str.strip` removes) as `off`, and
  `?guardrails=%EF%BB%BFoff` (a U+FEFF, which it keeps) as not `off`, as
  memory-cloud does.
- **The Claude plugin's `server_url` lower-cases the scheme**
  ([#91](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/91);
  client-side; python-sdk#311). For an `--mcp-url` of
  `HTTPS://X.test/mcp…`, `setup claude`'s plugin note now names
  `https://X.test/mcp`, as the Python CLI 0.44.0 (`urlunsplit`) and the
  written entry do.
- **Member API key and invitation ids are read as `int | str`**
  ([#102](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/102);
  memory-cloud v0.89.0+, memory-cloud#1008; python-sdk#294): this corrects
  the 0.14.1 note, which said the readers accept either. Two of them still
  read `id` as an integer, so `WorkspaceClient.mintMemberKey` threw its
  salvage error and `auth create-key`, `auth list-keys`, `workspace invite
  create` and `workspace invite list` exited 1 on every v0.89.0+ reply
  (`id: Input should be a valid integer, unable to parse string as an
  integer`). They now read an `akey_…` / `winv_…` id as the string and an
  older server's integer as the integer; a value neither an int nor a
  string is refused under `id.int` and `id.str`, as pydantic names them.
  `auth list-keys` and `workspace invite list` widen the ID column to the
  longest id (6 at least), as the Python CLI does.

## [0.14.1] - 2026-10-02

### Changed

- **String public ids for resource tokens, invitations and member API keys**
  (memory-cloud v0.89.0+, memory-cloud#1008): memory-cloud v0.89.0 makes
  these ids opaque prefixed strings (`rtok_…`, `winv_…`, `akey_…`) and
  answers an integer path id with HTTP 422. `ResourceClient.updateToken` /
  `revokeToken`, `WorkspaceClient.revokeInvitation` and `revokeMemberKey`
  take `number | bigint | string`; a string is sent percent-encoded as one
  path segment, and an empty, whitespace-only, `.` or `..` one throws
  before anything is sent. Integer ids work as before against older
  servers. The `id` / `token_id` of `ResourceTokenResponse`,
  `ResourceSetupResponse`, `WorkspaceInvitation` and `MemberAPIKey` are
  `number | string`, and the readers accept either (`"7"` still reads `7`).
  The CLI's `resource tokens update|revoke TOKEN_ID`,
  `workspace invite revoke INVITATION_ID` and `auth revoke-key KEY_ID`
  accept the string id as typed, and their messages print the id without
  the `#` (`Revoked key akey_… of USER`). Upgrade before the server moves
  to v0.89.0.

> **Correction (0.15.0,
> [#102](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/102)).**
> The readers did not all accept either id. The member API key reader
> (`WorkspaceClient.mintMemberKey`, `auth create-key`, `auth list-keys`)
> and the CLI's invitation reader (`workspace invite create`, `workspace
> invite list`) still read `id` as an integer, so they refused every
> `akey_…` / `winv_…` id a v0.89.0+ server sends; 0.15.0 fixes them. And a
> numeric-string id such as `"7"` no longer reads `7`: from 0.15.0 it stays
> the string `"7"`, as the Python SDK's `int | str` keeps it. See 0.15.0's
> Fixed and Changed entries.

## [0.14.0] - 2026-09-28

### Added

- **`setup codex|hermes|openclaw --url-form --oauth --mcp-url URL`**
  (memory-cloud v0.77.0+; the Python SDK 0.41.0's harness OAuth URL form,
  python-sdk#282, verified end to end in 0.41.2, #284): an entry with no
  key, no header and no key variable, which the harness signs in to
  itself. Setup first sends one unauthenticated `GET /api/v1/system/info`
  and stops (exit 1), having run and written nothing, when the server is
  older than 0.77.0 or its version cannot be confirmed; `--dry-run` sends
  no request. `--oauth` needs `--url-form` and `--mcp-url` and refuses
  `--api-key-env` (exit 2). Codex: `codex mcp add NAME --url URL` runs
  attached (it signs in) only with a terminal and without `-y`, else the
  table is printed with `codex mcp login NAME`. Hermes:
  `hermes mcp add NAME --url URL --auth oauth --connect-timeout 315`,
  then the entry is read back with `hermes config get`, and a kept entry,
  one without `auth: oauth`, or one saved disabled stops setup with the
  command that fixes it (`hermes mcp login NAME [--flow device]`,
  `hermes config set mcp_servers.NAME.enabled true`). OpenClaw:
  `openclaw mcp add NAME … --auth oauth` (`mcp set` with `--force`), then
  `openclaw mcp login NAME` and `openclaw mcp doctor NAME --probe`. A
  sign-in note replaces the key note; setup never runs the login or sees
  the token.
- **`update-memory --details` and `--location`**, as the Python CLI 0.42.0
  takes them (python-sdk #247): the same JSON object and `lat,lon[,label]`
  shorthand as `remember`, with the same usage errors, sent as `details`.
  The server replaces the memory's details wholesale, so a bare
  `--location` drops every other key and `--details '{}'` clears them; a
  blank value leaves them alone. `remember --help` now says so, and shows
  Python's examples.
- **`update-memory --merge-details`** (python-sdk #247): reads the memory
  with `reference()` first and merges `--details`/`--location` over its
  current details, top-level keys only, so the keys you leave out are kept.
  It needs `--memory-id` and one of `--details`/`--location`, both checked
  before anything is sent. It is two calls, not one atomic update, and it
  cannot remove a key. When the read is not the whole object (memory-cloud
  0.78.0+ leaves a large `details` out of a `reference` reply), it stops
  without writing and asks for the complete object with `--details`, in
  the Python CLI's words.

### Changed

- **`doctor`** reports a `/api/v1/system/info` body the SDK cannot read as
  the Python CLI 0.42.0 does (python-sdk #277): `Server answered, but the
  SDK could not read /api/v1/system/info: …`, with the failing fields,
  where it said `Server unreachable: Invalid response format: …`.
- **`getServerInfo`, `checkServerVersion`, `getEmbeddingStatus`,
  `getMemoryStats`, `findDuplicates` and `listEmbeddingModels`** check a
  2xx body against the Python SDK's model and throw `KaguraResponseError`
  (`operation` `KaguraClient.<method>`, `KaguraClient.get_server_info` for
  `checkServerVersion`) when it does not match, naming the fields and never
  their values, as the Python SDK 0.42.0 does (python-sdk #277). They used
  to return such a body unchecked. The body they return is still the one
  the server sent. A network failure, a body that is not JSON and a non-2xx
  status other than 401/429 still throw `KaguraConnectionError`.
  `checkServerVersion` now throws on a version that is not a string, as
  Python does, where it returned the body without comparing.

### Fixed

- **`workspace invite create -c` and `createInvitation`** (python-sdk #285):
  a `-c` that is not a context UUID is a usage error (exit 2, `Invalid
  value for '--context' / '-c': 'x' is not a valid context UUID.`) before
  anything is read, for an admin invitation too, where it was exit 1 after
  the credential; `WorkspaceClient.createInvitation` refuses such an
  `allowedContextIds` entry before any request and sends each one in
  canonical form; it and every `WorkspaceClient` workspace id now take
  the spellings Python's `uuid.UUID` takes (`0x…`, `urn:`/`uuid:`
  anywhere, padding and underscores in the hex), and the message quotes
  the value as Python's `repr` does (`got 'ctx-1'`). `member remove` and
  `revoke-key` ask about the workspace in canonical form, as the Python
  CLI 0.41.1 does.
- **`guardrails digest --out`** refuses an empty or whitespace-only path
  in the Python CLI 0.41.1's words (`Invalid value for '--out': the path
  is blank; name a file`, exit 2), where `' '` was taken as a file name.
  `--agents-md`, `--agents-md=VALUE` and the float ranges already behaved
  as 0.41.1 does, and now have recorded tests.
- **The `AGENTS.md` export** (python-sdk #285): the OpenClaw size warning
  counts the characters as written, a CRLF as two, as the Python CLI
  0.41.1 does, where a CRLF file just over 20,000 got no warning; a
  fetched block with its markers missing or out of order is refused in
  Python's words (`fetched block does not have exactly one begin and one
  end marker line, in that order`), by `setup` and by `guardrails digest
  --out`.
- **`setup hermes --agents-md`** (python-sdk #278) writes the context file
  Hermes loads, found as Hermes finds it: the nearest `.hermes.md` /
  `HERMES.md` up to the git root, then the `AGENTS` chain, then
  `CLAUDE.md`, only files with text counting. Before, the first of five
  names that existed here was used even when Hermes loaded another, so
  the export could displace the user's own file. With only Cursor rules
  there is no default file (exit 1 without a PATH, no hint, and a dry run
  says why).
- **An empty `AGENTS.md` export removes an earlier block**, on every
  `setup` harness, as `guardrails digest --out` does and as the Python CLI
  0.41.1 does, instead of keeping it with a note.
- **`resource import --progress`** starts its stream only once the client
  is built, as the Python CLI 0.41.1 does (python-sdk #285): a credential
  that fails prints the error alone, where the stream began with
  `import_start` and ended with `error`.
- **`--help` shows every command's examples**, one per line, as the
  Python CLI 0.41.1 does (python-sdk #285): the 28 commands whose
  examples the Python CLI 0.40.1 printed as one run-on line (`auth
  login|refresh`, `context create|delete|update|search-config`, `edge
  …`, `explore`, `forget`, `reference`, `resource tokens …`,
  `resource list|stats|indexer-status|schema|events|ingest|ingest-batch`,
  `setup claude|codex|hermes|openclaw`) showed none here (`remember`
  already had its block).
- **`ResourceClient`'s readers refuse a body the Python SDK's model
  refuses** ([#69](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/69)):
  `createToken`, `listTokens`, `updateToken`, `setupResource`,
  `getResourceImpact`, `listResources`, `getIndexerStatus`,
  `getResourceSchema`, `listResourceEvents`, `ingestEvent` and
  `ingestEvents` (after its `error` progress event) throw
  `KaguraResponseError` (`ResourceClient.<method>: unexpected server
  response for <Model> (…)`) where they returned the body unchecked. An
  accepted body is still returned as it arrived. `KaguraClient`'s REST
  readers get the same check in #70.
- **A hand-edited credentials profile is read as the Python SDK reads it**
  ([#69](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/69)):
  one whose `refresh_token` is `null`, or whose `access_token` is no
  string, is kept (sent as `Bearer 123`, no refresh) where the whole file
  was read as empty and every command said no credentials were found.
  The file is read as Python's `json.loads` reads it, so a number token is
  rendered as Python renders it (`1.0` sends `Bearer 1.0`, an int past
  2^53 exactly) and a file with `NaN` or `Infinity` in it is no longer
  read as empty (README, "Hand-edited credentials").
- **`doctor` checks the server the SDK would use**
  ([#69](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/69)).
  Without `--profile` it forced `.kagura.json`'s key and URL; it now
  resolves as a bare client does, as Python's does: `KAGURA_API_KEY`, then
  the OAuth profile, then `.kagura.json`, so `KAGURA_REQUIRE_PROFILE` and a
  missing `KAGURA_PROFILE` fail the auth section and skip the check. An
  insecure resolved MCP URL is Python's warning, and the check is skipped
  (`Server connectivity check skipped because the MCP URL is insecure`),
  where it failed, from every source: `KAGURA_MCP_URL` with no
  `.kagura.json`, and the `mcp_url` of the `.kagura.json` the credential
  resolved from, get the warning alone (exit 0), where the `mcp` section
  also failed them (`mcp_url is not HTTPS: …`, exit 1). A plain-HTTP
  `.kagura.json` `mcp_url` that `KAGURA_API_KEY` or an OAuth profile
  shadows still fails, as `setup claude` refuses it (README, `doctor`).
  `--profile missing`
  no longer fails when `KAGURA_API_KEY` is set, and `--profile ''` means
  the default profile. A selected profile that does not exist is reported
  once, by the resolution's `Authentication could not be resolved: …`,
  no longer also as `no profile named …`; an expired profile that
  `KAGURA_API_KEY` shadows is no failure, as Python only warns; and with
  no `.kagura.json` the auth section no longer says `.kagura.json carries
  an api_key` for the key the environment supplied. A `.kagura.json`
  that does not parse fails the
  check with the message naming it, never as `No credentials found`.
- **An OAuth refresh failure on a `KaguraClient` REST read is a
  `KaguraAuthExpiredError`** ([#69](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/69)),
  as on the MCP path and in the REST clients, where it was a
  `KaguraConnectionError` (`Connection failed: …`). `doctor` now prints
  Python's OAuth info line for it rather than `Server unreachable`.
- **MCP envelope errors read as the Python SDK's**
  ([#69](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/69)):
  a `null` JSON-RPC body is no result instead of a `TypeError`, a
  JSON-RPC `error.message` that is no string is rendered with Python's
  `str()` (it could throw a `TypeError`), a tool error's non-string code or
  message likewise (`t failed (None): …`, where it read `unknown` /
  `Unknown error`), and a `partial_rollback` whose `rollback_summary` does
  not match the model says `(rollback_summary could not be read)` with the
  `KaguraResponseError` as its `cause`. A number literal in a code or
  message still renders from the JavaScript number (`1.0` reads `1`) and
  an object's integer-like keys print first, where Python prints the
  literal and keeps the key order (README, "The MCP envelope").
- **Lax number and bool fields read strings as pydantic-core does**
  ([#69](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/69)).
  An int field takes `"0-1"` (as -1), `"0__7"` and `" +1"` as pydantic
  does, and refuses a digit run past 4,300 characters with `Unable to parse
  input string as an integer, exceeded maximum size`. A float field follows
  pydantic's `str_as_float`, where it followed Python's `float()`: `"1_.5"`,
  `"+_1"` and `"1e_10"` read, `" 1_000"` and `"1_000\n"` do not. A bool
  field sent a whole number of magnitude 2^63 or more says `Input should be
  a valid boolean`. A string holding a lone surrogate is refused in any
  field but a `str`, datetimes and `Literal`s included, with `Input should
  be a valid string, unable to parse raw data as a unicode string`. One
  gap stays (README "Reading responses"): an int field of an MCP tool
  result (`recallSeries`' `count`, a bucket's `count`) sent a whole float
  literal of 2^63 or more (`1e20`) reads it as that double, where pydantic
  refuses it, because the tool text is read with `JSON.parse` and the
  literal is gone.
- **REST bodies are read as Python's `json.loads` reads them**
  ([#69](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/69)).
  The resource and files commands keep the server's key order inside an
  untyped mapping (`{"b": 1, "2": 2}` no longer prints `"2"` first) and
  print each number as written: an int field sent `9007199254740993`
  prints exactly and one sent `1e20` is refused as pydantic refuses it, a
  float field sent `-0` prints `0.0`, and `1e16` / `-0.0` in a `payload`
  print `1e+16` / `-0.0`. A body with `NaN` or `Infinity` is read rather
  than refused as non-JSON; one nested deeper than 973 containers fails
  with Python's `maximum recursion depth exceeded while decoding a JSON
  array from a unicode string`; and `KaguraClient`'s REST methods word an
  unreadable body as Python does (`Invalid response format: Expecting
  value: line 1 column 1 (char 0)`). A string value holding a lone
  surrogate fails as pydantic's dump does (`Error serializing to JSON:
  UnicodeEncodeError: 'utf-8' codec can't encode character '\udXXX' in
  position N: surrogates not allowed`, `characters in position N-M` for a
  run) instead of printing the `\udXXX` escape; a key of the untyped
  mapping itself holding one prints as three U+FFFD, and a key of a
  mapping nested inside it exits 1 like a value. The values the SDK
  returns are unchanged.
- **`resource import` adds its counts exactly and prints its summary as
  Python's `json.dumps` does**
  ([#69](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/69)):
  `created` / `failed` past 2^53 are exact, an error's `1.0`, `1e16`
  and `NaN` print `1.0`, `1e+16` and `NaN`, in the server's key order,
  and a lone surrogate in an error's string or key prints as `?` (one per
  code unit), as the Python CLI's `errors="replace"` stdout writes it,
  rather than the `\ud800` escape.

## [0.13.0] - 2026-09-25

### Added

- **`ServerInfo.terms_version`** (memory-cloud v0.77.0+): the
  terms-of-service version, `null` when the deployment does not record
  acceptance, as the Python SDK 0.41.0 reads it. `doctor` checks it with
  the rest of the body.

### Changed

- **The resource and files commands print what the Python CLI prints**
  ([#66](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/66)):
  `resource tokens list|create|update`, `resource
  list|stats|indexer-status|events|schema`, `resource
  ingest|ingest-batch|setup`, `files list` and `files upload` print the
  result as the Python SDK's model dumps it (`model_dump_json(indent=2)`),
  where they printed the server's JSON as it arrived. So the model's keys
  in its order, its defaults for keys the server left out, and none it
  does not have; an int field sent as `"12"` prints `12`, a float field
  prints as a float (`1.0`, `1e-6`, as pydantic writes them), a resource
  event's id, which memory-cloud sends as a string, prints as the exact
  number past 2^53, and a timestamp prints in pydantic's form, a port of
  pydantic 2's datetime reading (`2026-06-01T09:00:00.5+00:00` as
  `2026-06-01T09:00:00.500000Z`; memory-cloud already sends that form).
  A record the model refuses exits 1 with the Python SDK's
  `KaguraResponseError` text, as the Python CLI does, and so does a
  `null` body (`files list`, and `resource schema`, which read it as no
  schema), where one threw a `TypeError` or exited 0. An untyped value
  (an event's `payload`) nested past pydantic's limit, 256 containers,
  exits 1 with pydantic's `Error serializing to JSON: …`, where it printed,
  or overflowed the stack. `files upload
  --remember` prints the file as its model reads it, and `resource import`
  reads each batch's counts through the model, so a count sent as `"2"`
  adds 2. Checked against the Python CLI 0.41.0 on 52 server responses,
  extra and missing keys, lax values and refused records included:
  identical stdout, stderr and exit code on each.
- **`FilesClient.upload` reads each leg through the Python SDK's model**:
  the reserve as `FileReserveResponse`, the confirm and a 409's existing
  file as `FileObject`. A body the model refuses is a `KaguraResponseError`
  that ends the progress stream, before any PUT for a reserve, and never
  reported `confirmed` for a confirm; the confirm used to be checked for
  its `id` only. A reserve whose `file_id` no path can carry (`.`, `..` or
  empty) is refused the same way, before the PUT, by this SDK's own check;
  the Python SDK accepts it. The value returned is unchanged.
- **`FilesClient.list` and `downloadUrl` read the body through the Python
  SDK's model**, as `upload` does: a bare list's items as `FileObject`
  (anything else whole as `FileListResponse`), and `FileDownloadUrlResponse`.
  A body the model refuses is a `KaguraResponseError`, where `files
  download-url` printed `undefined` and exited 0 for a body without its
  URL. The value returned is unchanged.
- **`ResourceClient.getResourceSchema` refuses a 2xx body that is no JSON
  object**, so only the 404 means no schema, as in Python, where a `null`
  body read as none. An object is returned as it arrives, as every
  `ResourceClient` reader returns it; `resource schema` reads it through
  `ResourceSchemaResponse`.
- **`doctor` reports the server version's verdict**, as Python's `doctor`
  does (python-sdk #280): `Server reachable`, then `Version: X` as pass,
  fail (`Version: X is below minimum 0.75.0`) or info (a version it cannot
  compare), by the shared `meetsMinimum` against `MIN_SERVER_VERSION`. An
  unreachable server fails with `Server unreachable: …`, an API key the
  server refuses with its own message, and an OAuth profile the REST route
  refuses is Python's info line. The `/system/info` body is read through
  Python's `ServerInfo`, and one it refuses fails as unreachable
  (`Server unreachable: Invalid response format: …`, the problem in the
  SDK's words where Python prints pydantic's); a credential that does not
  resolve fails the auth section with Python's `Authentication could not
  be resolved: …` and skips the check, as Python's is skipped. With
  `--profile NAME`
  the server is checked with that profile, as Python checks it, where it was checked
  with the default one. `doctor --json` gives every check
  `details`, `{}` when it has none, as Python's `to_dict` does.

### Fixed

- **Ids in a REST path stay one segment**
  ([#66](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/66)).
  Every id a client puts in a URL path is percent-encoded, so a `/`, `?`,
  `#` or `%` in it can no longer reach another route or replace the query,
  and one that is `.`, `..` or empty, which no encoding neutralizes, throws
  before anything is sent: `FilesClient.delete` / `downloadUrl`'s file id,
  every `ResourceClient` resource
  id, `KaguraClient`'s context id for `getMemoryStats`, `findDuplicates`
  and the `listTags` drill-down, `SecretClient.approvePubkey` /
  `revokePubkey`'s pubkey id, and a `WorkspaceClient` user id, which now
  refuses an empty id too. The bin refuses the same ids in click's words
  (exit 2) before anything is read or sent: `FILE_ID`, `USER_ID` /
  `--user`, and the resource id of `resource stats`, `indexer-status`,
  `schema`, `events`, `ingest`, `ingest-batch` and `import`. The Python
  SDK sends them as typed (`files download-url ..` asks for
  `/api/v1/download-url`), but for a user id, which it refuses too from
  0.41.1, in the same click words.
- **A profile named like an `Object.prototype` key**
  ([#66](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/66)).
  `getProfile`, `setDefaultProfile`, `deleteProfile`, `refresh`, `auth
  status|token|logout`, `doctor` and the MCP proxy read `constructor`,
  `toString` and the like as stored profiles, since the profiles are a
  plain object; they now look at the file's own profiles only. A profile
  named `__proto__` is stored as one, rather than replacing the map's
  prototype and vanishing on save.
- **A tool reply whose text is not a JSON object**
  ([#66](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/66)):
  `null` threw a `TypeError` from every MCP method, and a list or a scalar
  came back as the result. Each is now a `KaguraResponseError` naming the
  tool (`remember: unexpected server response (tool reply: expected a JSON
  object, got NoneType). …`); `recordMeasurement` refuses a list here,
  before its model, where Python fails with an `AttributeError`. A
  `content` item that is `null` reads as `{}`, as one with no text does,
  rather than throwing a `TypeError`.
- **A number with a long run of whitespace inside**: an int or float field
  (`"5 … 5"` from the server) or a CLI number took time quadratic in the
  run to refuse, seconds for 80,000 spaces. The whitespace around a number
  is now stripped in linear time.
- **`checkServerVersion` on a `/system/info` body that is no object**
  threw a `TypeError`; it returns the body without a warning, as for a
  version it cannot compare.

## [0.12.0] - 2026-09-25

### Added

- **Claude Desktop MCPB extension and `kagura-memory-mcp` stdio proxy**
  ([#63](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/63)):
  browser device login, shared OAuth profiles, token refresh, transparent JSON/SSE
  forwarding, bounded session recovery, deterministic bundles and Windows/macOS
  artifact validation. See [installation and host validation](docs/mcpb.md).

- **`workspace` group**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)):
  `workspace member list|add|set-role|remove` and `workspace invite
  create|list|revoke`, the Python CLI's workspace administration commands
  (memory-cloud v0.42.0+), with its options, help, tables and exit codes.
  The server takes only the workspace owner's static API key here; an OAuth
  profile gets an access-denied error saying so. As in Python (its #115),
  the workspace comes from the same source as the key: `-w/--workspace`,
  else the OAuth profile's workspace, else `context_id` in the
  `.kagura.json` holding the key, and a `KAGURA_API_KEY` key needs `-w`.
  An empty or `auto` `-w` is refused (exit 1) rather than falling back to
  the source's workspace. `member remove` asks first, naming the
  workspace, unless `--yes`. `invite create` prints the invitation URL
  once, on stdout, after a warning on stderr; `invite list` never shows it.
  `--json` prints each record as the Python model dumps it: its fields in
  its order, `null` or `false` for what the server left out, unknown ones
  dropped, and never a join credential. A record missing a required field,
  or holding a scalar, list or mapping of the wrong type
  (`allowed_context_ids: Input should be a valid list`), is refused with
  `KaguraResponseError`'s message (`WorkspaceClient.list_members:
  unexpected server response for WorkspaceMember (role: Field required).
  …`), exit 1. `--role` matches
  exactly, as click's `Choice` does. `invite revoke` reads its id as
  Python's `int()` does, and exactly: `9007199254740993` is not rounded to
  a neighbouring invitation's id. Four things differ on purpose: a
  workspace that is not a UUID is refused before `member remove` asks,
  where Python asks first; each `invite create -c` must be a context UUID
  (exit 1, `context_id must be a UUID, got '…'`), where Python sends it as
  typed and the server answers `HTTP 500`; a `USER_ID` of `.` or `..` is
  refused (exit 2, `Invalid value for 'USER_ID': '..' is not a valid user
  id.`) before anything is asked or sent, where Python sends it and URL
  resolution turns `member remove .. --yes` into a `DELETE` of the
  workspace's own URL; and an invitation with no email prints `-`, as
  `invite list` does, where Python prints `None`.

- **`auth create-key`, `auth list-keys` and `auth revoke-key`**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
  which mint, list and revoke an API key for another member of the
  workspace, as the Python CLI's do, through the same workspace pairing
  and owner-key rule as the `workspace` group. `create-key` needs
  `--expires-days` (1-3650) and prints the key once, on stdout, after a
  warning on stderr; `list-keys` never shows a plaintext, not even under
  `--json` if a server sent one; `revoke-key` asks first unless `--yes`,
  refuses a workspace that is not a UUID before it asks, and revokes the
  `KEY_ID` typed, exactly, however large. `create-key` reads the server's
  answer as Python's `MemberAPIKey` model does (an `id` of `"42"` is key
  #42). A `--user` of `.` or `..` is refused (exit 2) before anything is
  asked or sent, where Python sends it to another endpoint. They refuse
  `--invite` as every `auth` subcommand but `login` does, and have no bare
  `kagura-memory create-key` spelling: the bare aliases stay the seven
  subcommands v0.7.0 had.

- **`guardrails load` and `guardrails digest`**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
  the Python CLI's `guardrails` group (memory-cloud v0.74.0+). Both take
  the context as an optional argument, else `context_id` from
  `.kagura.json`. `load [CONTEXT_ID] [--cap 1-1000]` calls the MCP
  `load_guardrails` tool and prints the set as Python's `GuardrailSet`
  prints it: its fifteen keys in the model's order (the tool's
  `context_display_name`, `context_is_private` and `context_is_locked` left
  out), each item's eleven, scalars read as pydantic reads them (`"50"` is
  `50`), and a `tool_trigger` Python cannot read as `null`, with
  `match: null` filled in. A set missing a required field, a truncation
  flag above all, exits 1 with the Python SDK's `KaguraResponseError` text
  (`load_guardrails: unexpected server response for GuardrailSet
  (pinned_truncated: Field required). …`) instead of printing a set that
  reads as complete. `digest [CONTEXT_ID] [--target export|instructions]
  [--out FILE] [--profile P] [--tools T]` reads the REST digest route with
  the credential chain and prints the export block, or the MCP server
  instructions preview; an empty set prints nothing and says so on stderr.
  With `--out`, the block is spliced into FILE between its marker lines
  (replaced in place, left alone when unchanged, removed when the set is
  empty), a symlink, the file's mode and its CRLF line endings kept, and
  one JSON line reports `path`, `status` (`written`, `unchanged` or
  `removed`) and `tool_triggered_version`. Options, messages and exit codes
  are the Python CLI's: `--target` is case-sensitive, `--out` refuses a
  directory or an unreadable file (exit 2), `--out` with `--target
  instructions` and `--profile` / `--tools` without it are usage errors,
  and a context that is not a UUID is refused with `context_id must be a
  UUID, got '…'` (exit 1). Unlike the Python CLI, `--out ''` is a usage
  error (exit 2), where click takes the empty path as the current
  directory and the write then fails (exit 1). The help examples name
  `kagura-memory`, one per line.

- **`setup codex|hermes|openclaw --agents-md [PATH]`**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
  the guardrail export (memory-cloud v0.74.0+). It fetches the context's
  tool guardrail export block and splices it into a file the harness loads
  every session, between its `kagura-memory:guardrails` marker lines, with
  the rules `guardrails digest --out` follows: an earlier block is replaced
  in place, an unchanged set rewrites nothing, and the rest of the file
  keeps its text, line endings and links. Without PATH the file is the
  harness's own, as in Python: `$CODEX_HOME/AGENTS.md` (or
  `AGENTS.override.md` when that exists), the first of `.hermes.md`,
  `HERMES.md`, `AGENTS.override.md`, `AGENTS.md` and `CLAUDE.md` in the
  current directory for Hermes, and `AGENTS.md` in OpenClaw's workspace
  (`$OPENCLAW_WORKSPACE_DIR`, else `workspace/` in its state directory). The
  context is `--context-id`, else a `--guardrails` context UUID; without one
  the flag is a usage error (exit 2), since this port never asks. The block
  is fetched on the usual credential chain, settled before anything runs,
  a dry run included: no credential, or one for another server than the
  entry's, stops setup with nothing run (exit 1). The written file is in
  `wrote`, and the notes carry Python's lines: the refresh command
  (`kagura-memory guardrails digest <ctx> --out <file>`), a warning past the
  32 KiB Codex reads or the 20,000 characters OpenClaw reads, and Hermes's
  prompt-injection note. An empty digest writes nothing and says so, a
  failed export prints the report and then the error (exit 1), and
  `--dry-run` names what the export would do to the file. Hermes and
  OpenClaw runs without it end with Python's "Re-run with --agents-md
  --context-id <id> …" hint.

- **The measurement lane: `recordMeasurement` and `recallSeries`**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
  the port of the Python SDK's `record_measurement` / `recall_series`
  (memory-cloud v0.54.0+, the HOW-MUCH axis). `recordMeasurement({
  contextId, metric, value, measuredAt, unit, details })` appends one
  number to a metric's series; `recallSeries({ contextId, metric, period,
  agg, start, end })` reads it back bucketed by `day`, `week` or `month`
  and aggregated by `avg`, `min`, `max`, `sum`, `count` or `last`.
  Measurements are not memories: never embedded, recalled or
  consolidated, and append-only. The metric (1-64 characters, counted as
  Python counts them), the value (a finite number; a string or a boolean
  is refused, not coerced) and the unit (1-32 characters) are checked
  before any request, with the Python SDK's messages. `measuredAt`,
  `start` and `end` take an ISO 8601 string, sent as given, or a `Date`,
  sent as its UTC instant. Both return the Python SDK's model, its keys in
  its order, `unit` `null` and `status` `"success"` when the server leaves
  them out and other fields dropped, and a result that does not read as
  one raises `KaguraResponseError` (`operation` `record_measurement` /
  `recall_series`) in the Python SDK's words. The models
  `MeasurementResult`, `MeasurementSeries`, `SeriesBucket`,
  `MeasurementPeriod` and `MeasurementAggregate`, and the option types
  `RecordMeasurementOptions` and `RecallSeriesOptions`, are exported.

- **`listMemories` bounding box**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)):
  `latMin`, `latMax`, `lonMin` and `lonMax` (memory-cloud v0.54.0+), in
  any combination, keep only memories with a location; `lonMin > lonMax`
  is the box across the antimeridian. A bound that is not a number or is
  out of range is refused before any request, with the Python SDK's
  sentence and the option's name (`latMax must be between -90 and 90,
  got 91`). An older server ignores the bounds and returns an unfiltered
  page. `MemoryListItemLocation` names the `{ lat, lon }` each item
  carries.

- **`measure record` and `measure series`**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
  the Python CLI's `measure` group, with its arguments, options, help and
  errors. The context is the first argument, never read from
  `.kagura.json`. A negative VALUE needs no `--` (`measure record
  <context-id> pnl_usd -120`); an option `record` does not declare is
  refused as `No such option: <token>` when it lands in CONTEXT_ID or
  METRIC, as click refuses it, even after `--`. Unlike click, these
  errors never print the value of a `--name=value` token: it is named
  `--name`, as in every other command, since the value may be a key.
  `--period` and `--agg` match exactly. A non-finite VALUE, a bad metric or a bad unit exits 1
  with the SDK's message, as in the Python CLI. The result prints as the
  Python CLI prints it, apart from a whole float (`72.0` prints `72`).

- **`files upload -v/--verbose` and `--progress`, and `resource import -v/--verbose`
  and `--progress`**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)).
  `--progress json` writes the Python CLI's NDJSON on stderr, one event per
  line (`{"v": 1, "ts": …, "stage": …, "kind": …, "msg": …, "detail": …}`),
  ending with the operation's one `success` or `error`; `-v`, or
  `--progress rich`, writes the lines the Python CLI shows (`→ Reserving
  upload report.pdf (1234 bytes)`, `✓ Upload complete`, `✗ Upload failed:
  …`), as plain text; `--progress none` is silent even with `-v`. `-v` is
  repeatable, and `--progress` takes any case, as click declares them.
  Stdout carries the same result JSON either way. Unlike the Python CLI,
  `files upload --remember` reports `success` only once the linked memory
  is written, and `resource import` ends with an `error` event when the
  credential fails after its start event.

- **`onProgress` on `FilesClient.upload` and `ResourceClient.ingestEvents`**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
  the Python SDK's `logger=` hooks as a callback: each event is the NDJSON
  line without `v` and `ts`. An upload reports `reserve`, `upload` and
  `confirm`, then one terminal `complete` event, even when it throws: a
  `success` with the file id, or an `error` saying how far it got
  (`reserved_file_id`, `uploaded`, `confirm_started`, `confirmed`).
  `ingestEvents` takes it as a new optional fourth argument,
  `{ onProgress }`. `ProgressEvent`, `ProgressKind`, `ProgressCallback`,
  `IngestEventsOptions` and `PROGRESS_SCHEMA_VERSION` are exported. Without
  a callback nothing is emitted, and one that throws, or an `async` one
  that rejects, is ignored.

- **`resource setup --name` (`-n`)**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
  as in the Python CLI 0.40.1: the context's name, which defaults to the
  resource id. A workspace that already has a context of that name needs
  it, since the server refuses a second one. `--name=` is sent as given,
  and the server refuses it, as with Python. The help texts, the summary
  and the examples are Python's.

- **`MemoryClient`, the REST guardrail client**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
  the port of the Python SDK's `MemoryClient` (memory-cloud v0.74.0+).
  `getGuardrailDigest(contextId, { target, profile, tools })` returns the
  `AGENTS.md` export block (`target: "export"`, the default; `""` when the
  context has no tool guardrails) or the MCP server instructions this
  credential would receive (`"instructions"`), as a `GuardrailDigest` with
  the text as is and the `X-Kagura-Guardrails-Tool-Triggered-Version` header
  as `tool_triggered_version` (`null` when the server sends none).
  `loadGuardrails(contextId, { cap })` is the REST twin of
  `KaguraClient.loadGuardrails`, returning the new `GuardrailSet` type (the
  MCP `LoadGuardrailsResponse` is now that set plus its context block). It
  reads the set as the Python SDK's `GuardrailSet` model does, with the
  reader `guardrails load` prints through, so the two accept and refuse
  the same sets: the model's fields only, in its order, `null` for an
  optional one left out (the context block included), and a `tool_trigger`
  that is no trigger `null`. A set missing a required field, a truncation
  flag included, or holding one of the wrong type raises
  `KaguraResponseError` (`operation` `MemoryClient.load_guardrails`)
  rather than read as complete. The types say so too: `GuardrailItem`'s
  `type`, `delivery_mode`, `source_type`, `authored_by_caller`,
  `created_at` and `updated_at` are now `… | null`, and `ToolTrigger.match`
  `string | null`, as in the Python SDK's model, so strict code that used
  them as plain strings (or tested `match === undefined`) no longer
  compiles rather than failing on a `null` at run time. A
  `contextId` that is not a UUID is refused before any request with the
  Python SDK's `context_id must be a UUID, got '…'`; like Python's
  `uuid.UUID`, a braced, `urn:uuid:` or dashless spelling is sent in
  canonical form, and one padded with whitespace is refused. A caller with
  only an API key, an agent-bound one included, reads guardrails without
  an MCP session. `GUARDRAIL_VERSION_HEADER`, `GetGuardrailDigestOptions`,
  `MemoryLoadGuardrailsOptions`, `GuardrailDigest` and
  `GuardrailDigestTarget` are exported too.

- **`KaguraResponseError`**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
  the Python SDK's class for a successful response the SDK cannot read,
  usually because the server is newer than the SDK. Its message reads as
  Python's, `<operation>: unexpected server response for <Model> (<field>:
  Field required). The server may be newer than this SDK; upgrading
  kagura-memory may help.`, naming at most three failing fields (then
  `(+N more)`) and never their values, and `operation` names the call. It
  extends `KaguraError`, not `KaguraConnectionError`: the call succeeded,
  so a retry fails the same way. The methods added in this release raise
  it, and so do `ResourceClient.ingestEvents` and `FilesClient.upload` for
  a 2xx body they cannot read (see Changed); every other existing method
  keeps the errors it raised.

- **Quota and plan details on CLI errors**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)).
  A quota refusal (`KaguraQuotaError`) adds `  Resets at: <time>` after
  `Error: <message>`, in Python's `isoformat()` form (`+00:00`, never `Z`;
  microseconds only when not zero), and a quota or feature refusal adds
  `  Required plan: <label> (<key>)`, as the Python CLI prints them. Every
  command gets them.

### Changed

- **`auth use` reads as the Python CLI's**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57),
  as Python #206). Its argument is `NAME`, and success prints `Default
  profile set to '<name>' (workspace '<workspace>').`, with a note when
  `KAGURA_PROFILE` is set and still overrides the new default, where it
  printed `Default profile is now '<name>'.`. An unknown name exits 1 with
  `Profile '<name>' not found. Available: <the stored profiles, sorted>`
  (or `(none — run: kagura-memory auth login)`), where the message named
  the credentials file; a missing name is click's `Missing argument
  'NAME'.` (exit 2), where it printed a usage line; and an extra argument
  is refused (exit 2), where it was ignored. A name such as `constructor`
  is no longer taken for a stored profile.

- **`WorkspaceClient`'s shape errors read as the Python SDK's**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
  which the new commands print: `WorkspaceClient.list_members: unexpected
  server response (GET …: expected a JSON array, got dict). The server may
  be newer than this SDK; upgrading kagura-memory may help.` for
  `listMembers` and `listInvitations`, the same with `expected an object
  carrying a 'api_keys' array` for `listMemberKeys`, and a mis-shaped
  `mintMemberKey` response prefixed `WorkspaceClient.mint_member_key: `.
  The classes are unchanged (`KaguraConnectionError`, and `KaguraError`
  for the mint).

- **The REST clients name a request's whole path in their diagnostics**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
  as the Python SDK does (httpx's `url.path`): a base URL's own prefix
  included and `%XX` escapes decoded, so a `non-JSON body` or shape error
  reads `GET /kagura/api/v1/workspaces/…/members/a@b/credentials` for a
  server at `https://host/kagura`, where it read
  `GET /api/v1/workspaces/…/members/a%40b/credentials`.

- **`WorkspaceClient.mintMemberKey` reads its response as the Python
  SDK's `MemberAPIKey` model does**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)):
  leniently, as pydantic does (an `id` of `"42"` is 42, where it was
  refused as a mis-shaped mint), and whole (a `plaintext_key` that is no
  string is refused, where it was returned). The key it returns has the
  model's fields only, with `null` or `false` for what the server left
  out.

- **`setup codex|hermes|openclaw` read `--mcp-url` as a URL parser does**
  (python-sdk#279): whitespace and control characters around it, and any
  tab or newline inside it, are dropped before the checks, and the entry
  gets that URL. Anything but an http(s) URL with a host is refused
  (`--mcp-url=--help`, `memory.kagura-ai.com/mcp` or `https://[::1/mcp`,
  exit 2 with Python's `use an https:// URL, e.g. …`), since it would go on
  the harness's command line after `--url`. A configured `mcp_url` gets the
  same checks and exits 1, saying to pass `--mcp-url`.

- **A `?guardrails=` in the MCP URL of `setup hermes|openclaw` is handled
  as Python does now** (python-sdk#279). Every context value is dropped,
  names compared decoded as the server reads them (`guard%72ails`), with
  one warning that names `--guardrails` and the URL's value together and
  points at the AGENTS.md export. A first `off`, the value the server
  reads, is kept alone (`?guardrails=OFF&guardrails=<ctx>` is written
  `?guardrails=off`), where the whole query was kept and the context with
  it.

- **`setup codex|hermes|openclaw --context-id` must be a context UUID**
  (exit 2, as in Python without `--profile`; this port lists no contexts):
  `-c proj`, a padded UUID or `-c ''` is refused, where Codex went on
  without the lane and Hermes and OpenClaw ignored it. A braced or
  dashless UUID is written canonically.

- **`$OPENCLAW_STATE_DIR` and `$OPENCLAW_CONFIG_PATH` are read as OpenClaw
  reads them** (python-sdk#279): stripped, and a leading `~` expanded to
  the home directory, where a padded value named another path and `~/oc`
  one under the current directory. `~user/…` is left as written.

- **`setup hermes` notes an existing `mcp_servers:` key, an inline one and
  an unreadable `config.yaml` in Python's words** (python-sdk#279), and
  reads that file as strict UTF-8, as Python does.

- The Codex digest note previews with `kagura-memory guardrails digest …
  --target instructions`, this bin's own command, and the help of `--name`,
  `--context-id`, `--guardrails`, `--api-key-env` and `--dry-run` on the
  harness setups is Python's.

- **An MCP URL whose query `setup` rewrites is written with a lower-case
  scheme**, as Python writes it: `setup codex --mcp-url HTTP://…/mcp -c
  <ctx>` gets `http://…/mcp?guardrails=<ctx>`, as do `setup claude
  --guardrails` or `--tool-profile` and the `?guardrails=` edits of `setup
  hermes|openclaw`, and an empty `#` at the end goes. A URL whose query
  setup leaves alone is still written as given.

- **`files` commands pair the workspace with the credential**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
  as the Python CLI does (its #115): `--context-id` when given, else the
  OAuth profile's workspace, else the `context_id` of the `.kagura.json`
  that holds the key, and the client is built from that same credential.
  A `KAGURA_API_KEY` key now needs `--context-id` (exit 1, in Python's
  words), where it took `.kagura.json`'s `context_id`, a workspace another
  key belongs to.

- **`files delete` prints `Deleted <file_id>` and `files download-url` the
  bare URL**, as the Python CLI does, where they printed JSON.

- **`files upload --remember` writes the Python CLI's memory**: the content
  `` Uploaded file `<name>` (<n> bytes, <type>). Stored as file_object
  <id>. ``, `source_uri` the file's `file://` URI (resolved as Python's
  non-strict `resolve()` does, so a file removed after the upload still
  has one), `source_type` `file`, and `details` with the file's id,
  sha256, size and type; the summary defaults to `File: <name>` from the
  server's filename. The memory client
  resolves its credential as the upload's did, not from `.kagura.json`'s
  key. A write that reports no `memory_id` is a failure, and a failed
  write says `File uploaded (file_id=…), but creating the linked memory
  failed: …`, with a quota refusal's `Resets at:` / `Required plan:` lines.

- **`files upload` checks its options first, as click does**: an invalid
  `--importance` or `--progress` is reported before a missing or wrong
  PATH, and PATH errors read `File '<path>' does not exist.` / `… is a
  directory.`. `--summary` or `--tags` without `--remember` is refused
  (`--summary and --tags require --remember.`, exit 2), where they were
  ignored.

- **`resource import` reads its input as the Python CLI does**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)).
  `--format auto` goes by the file's extension (`.csv`, `.jsonl`, `.json`),
  so stdin needs `--format` (`Cannot detect format. Use --format
  csv|json|jsonl`), where the content was sniffed. `--format json` needs
  an array of objects; a single object is refused. CSV is read as
  Python's `csv.DictReader` reads it: blank lines are skipped, and a
  short row's missing cells are `null`, where they were `""`. Its errors
  are Python's, with exit 1: `Invalid JSON: Expecting value: line 1
  column 1 (char 0)`, `JSON item 0 is not an object: int`, `Invalid JSONL
  at line 2: …`, `No data found in input`, `Row 1: column 'sku' not
  found. Keys: ['name', 'price']`, and `Failed to read input: …` for a
  stdin that cannot be read. `--id-column=` numbers the rows, as in
  Python, where it was refused. The help texts are Python's.

- **`resource import` keeps what the Python CLI keeps of each row**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)).
  A row lists its keys in the order read, integer-like ones included, in
  the `Keys: […]` of an error and in the request body, where `1` and
  `2024` came first. A doc_id taken from a number is Python's `str()` of
  it as written: `1234567890123456789` keeps its digits, where two ids
  past 2^53 rounded to one doc_id and the second row was upserted over the
  first, and `10.0` and `1e20` read `10.0` and `1e+20`, where they read
  `10` and `100000000000000000000`. `NaN`, `Infinity` and `1e400` are read
  as `json.loads` reads them and fail the batch holding them, as the
  Python CLI's request encoding does (`Out of range float values are not
  JSON compliant: nan`, exit 1; the batches before it are sent), rather
  than being sent as `null`. A number in the payload is still sent as
  JavaScript reads it: an integer past 2^53 loses its last digits.

- **`ResourceClient.ingestEvents` and `FilesClient.upload` refuse a 2xx
  answer they cannot read**, with a `KaguraResponseError` in the Python
  SDK's words (`ResourceClient.ingest_events: unexpected server response
  for ResourceEventBatchResponse (…)`): a batch answered with anything but
  a JSON object, and a confirm answered without a string `id`, which were
  returned as the result. The progress stream ends with that `error`, and
  such a confirm is not reported as `confirmed`.

- **`FilesClient` sends a `contextId`'s canonical form and refuses it in
  the Python SDK's words**: a `{braced}`, `urn:uuid:` or dashless UUID is
  sent as `xxxxxxxx-xxxx-…`, where it was sent as typed and met the
  server's 404, and a padded one is refused, with `context_id must be a
  UUID; got '<value>'. …`. A 403's hint names `--context-id`, as
  Python's does.

- **`resource setup` prints the Python CLI's `ResourceSetupResponse`**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)):
  `context_id`, `context_name`, `resource_id`, `token`, `token_id` and
  `warning`, in that order, with `warning` null when the server sends
  none, and without the tool result's `status` and `message`. A result
  missing one of those fields exits 1 with Python's `KaguraResponseError`
  message, which names the fields and never the token. The `--summary`
  note says that only the context's owner can set the summary, and it is
  printed before the configuration is read, so it appears even when that
  then fails.

- **`resource tokens revoke` prints `Token revoked.`**, and **`resource
  schema` prints `No schema registered for this resource.`** when there is
  none, as the Python CLI does
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)).
  They printed `{"status": "success", "token_id": N}` and `null`.

- **Server versions are read as the Python SDK reads them**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)).
  `checkServerVersion()` and `auth login --invite` share one parser:
  `v?MAJOR.MINOR.PATCH` at the start, where `+build`, more `.N`
  components and `.postN` mark a release and anything else after the
  triple a pre-release, which comes before its own version. So
  `checkServerVersion()` now warns on `0.75.0-rc1` and `v0.74.0`, and no
  longer on `0.74`, which it cannot compare; `--invite` against a
  `0.76.0-rc.1` server takes the two steps instead of the hand-off.

- **A `listTags` drill-down names the context with the `context_name`
  the REST tags endpoint sends** (memory-cloud v0.77.0 and later), and
  caches it, so it makes no MCP `list_tags` call for the name. An older
  server's reply, or an empty name, still gets the one lookup.

- **Choice options match case-sensitively where the Python CLI declares
  them so**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
  as click's `Choice` does: `context search-config --reranker`,
  `resource events --op`, `resource ingest --op` and `setup claude
  --scope` now refuse `Voyage`, `UPSERT` or `Project` with exit 2, where
  they took any case. `remember --source-type` still takes any case, as
  Python declares it, now casefolded as click folds it (`ﬁle`, with the
  `fi` ligature, is `file`).

- **The missing-context error reads as the Python CLI's does now**:
  `context_id required. Pass the context ID or set context_id in
  .kagura.json`.

- **Numbers are read as Python's `int()` and `float()` read them**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)):
  digit-group underscores (`--limit 1_000`, `--importance 0.000_5`) and
  any Unicode decimal digit (`١٢`, `１２`) are taken, where they were
  refused (exit 2), and the whitespace around a number is what they skip:
  NEL (`\x85`) is, where it was refused, and a BOM (`\ufeff`) is not, so
  `measure record … $'\ufeff5'` is refused (exit 2), where it was read as
  5.

- **An unknown option gets click's suggestion**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)):
  a long option close to one the command takes is refused as the Python
  CLI refuses it, `No such option: --js Did you mean --json?`, or `No such
  option: --per (Possible options: --end, --period)` for more than one
  (`difflib`'s close matches, as click 8.3 finds them).

- **An option given no value reads as click's error**: `Error: Option '-w'
  requires an argument.`, where it printed `Option -w needs a value.`
  without the `Error:` prefix. One mistake is one error: `--name -bad`,
  whose dash-led value this bin does not take, no longer adds `No such
  option: -b`.

- **An option error wins over `--help`**, before it or after it, as click
  reads the options first: `workspace member list --help --bogus`,
  `workspace --help --bogus` and `--version --bogus` exit 2 with `No such
  option: --bogus`, where they printed the help or the version and exited
  0. `secret exec`, where click passes an unknown option on, still prints
  its help for `secret exec --help --bogus`; a missing value, as in
  `secret exec --help --as`, wins there too. `--invite` on an `auth`
  subcommand other than `login`, which stands for click's `No such option:
  --invite`, wins over `--help` the same way, and is refused as `--invite
  applies only to 'auth login'.` without a value too, where it read as a
  missing value.

### Fixed

- Reject malformed JSON-RPC envelopes in the desktop proxy, count separators
  toward its SSE message size limit, and avoid duplicate initialized
  notifications after session recovery.
- Quote Windows browser URLs for Explorer's argument parser so OAuth links
  containing `=` open the browser instead of the Documents folder. Keep URLs
  out of command shells and encode embedded quotes before verbatim passing.

- **`WorkspaceClient` refuses a `userId` of `.` or `..`**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)).
  Percent-encoding leaves both as they are, and URL resolution then
  dropped or climbed the segment: `removeMember(ws, "..")` sent `DELETE
  /api/v1/workspaces/<ws>`, the workspace itself, and `updateMemberRole`
  a `PUT` there. Every method that takes a `userId` now throws before
  sending anything.

- **`WorkspaceClient.revokeInvitation` and `revokeMemberKey` no longer
  revoke a rounded id**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)).
  A `number` past `Number.MAX_SAFE_INTEGER` may already be a different id
  (`9007199254740993` is `9007199254740992`), and one of `1e21` was sent
  as `1e+21`; such a `number` is now refused, and the id can be passed as
  a `bigint`, which is sent exactly.

- **A `setup hermes|openclaw` warning no longer names a context id it
  dropped**: the URL's `?guardrails=<ctx>` warning quoted the id.

- A relative `$CODEX_HOME`, `$HERMES_HOME` or `$OPENCLAW_*` path is named
  as given in `setup`'s messages, as Python names it, where it read as a
  path under `~` when setup ran from the home directory.

- **A `..` in `$CODEX_HOME`, `$HERMES_HOME` or `$OPENCLAW_STATE_DIR` is
  kept, as Python's pathlib keeps it**: setup folded `~/a/../b` to `~/b`,
  so with `~/a` a link it read the harness's config from, and named,
  another directory than the one the system (and the Python CLI) goes to
  through the link. `setup`'s messages also name a path under the home
  directory as Python does, segment by segment: `~/x/../y/z.md` and
  `~/..notes/A.md`, where the first was folded and the second printed in
  full.

- **A doc_id outside 1-255 characters and a CSV row with more cells than
  the header are refused before anything is sent** (exit 1), where the
  Python CLI stops with a traceback from its event model.

- **A stderr closed early no longer kills the bin**: an `EPIPE` on stderr
  (`… -v 2>&1 | head -1`) is ignored, so the upload or import it was
  reporting on finishes.

- **`resource import -V` above 2^53 is refused for what it is**: `… is too
  large for this CLI to send exactly (at most 9007199254740991).` (exit
  2), where it said the value was not in the range `x>=1`. (The Python
  CLI sends it; a JavaScript number would round it.)

- **Security: the HTTPS check refused too little.**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57))
  A URL that `fetch` reads as plain HTTP to a remote host passed it when
  it was spelled with a leading control character (`\x01http://…`), a
  tab or newline inside (`ht\ttp://…`), no slashes (`http:host`,
  `http:/host`) or backslashes (`http:\\host`), so the clients, `login()`
  and `auth login --server` talked to it unencrypted, credentials
  included. The check now
  reads the URL as a URL parser does, as the Python SDK's does since its
  0.40.1: it drops whitespace and control characters around the URL and
  tabs and newlines inside it, then refuses any `http:` scheme, in any
  case and with or without its slashes, unless the host is `localhost`,
  `127.0.0.1` or `[::1]`. The error shows the URL as it was read.

- **Security: `setup claude` refuses a plain-HTTP URL to a remote host**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
  whether it came from `--mcp-url`, the project's `.kagura.json` or
  `KAGURA_MCP_URL`, before anything is written or run: `Error: Connection
  failed: MCP URL must use HTTPS for security (got: …). HTTP is only
  allowed for localhost development.` (exit 1), the Python CLI's words,
  whose connection test refuses it. It wrote the key into `.mcp.json` and
  `.kagura.json` beside that URL, and Claude Code then sent it in the
  clear. (The 0.11.0 note that Python's `setup claude` does not check was
  wrong.)

- **Security: an OAuth profile's token stays with its own server**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)).
  With no `.kagura.json`, the MCP-backed commands (`recall`, `guardrails
  load`, `measure record|series` and the rest) and `doctor` took the URL
  the config loader fills in, `KAGURA_MCP_URL` or else
  `https://memory.kagura-ai.com/mcp`, as the server, so a profile bound to
  another server had its token sent there. They now leave the URL to the
  credential chain, which pairs each credential with its own, as the REST
  commands already did: an OAuth profile's `mcp_url`, and for
  `KAGURA_API_KEY` still `KAGURA_MCP_URL` or the default. So
  `KAGURA_MCP_URL` no longer redirects an OAuth profile's MCP calls. A
  `.kagura.json`'s `mcp_url` is still used as before. (The Python CLI
  0.40.1 sends the token to the loader's URL.)

- **`setup claude --mcp-url ""` (or `--mcp-url=`) falls back to the
  project's URL**, as Python's `mcp_url or …` does: the `.kagura.json`
  `mcp_url`, then `KAGURA_MCP_URL`, then the default. It wrote `"url": ""`
  into the entry, blanked the project's `mcp_url` and exited 0, and so
  skipped the HTTPS check of the URL it should have used.

- `checkServerVersion()` no longer throws a `TypeError` when the server
  reports a version that is not a string; it returns without a warning.

- `doctor` passes an `mcp_url` written `HTTPS://…` or
  `HTTP://LOCALHOST:…`, which it failed as not HTTPS: it now judges plain
  HTTP with the clients' own check.

- **`resource tokens update` and `resource tokens revoke` act on the
  `TOKEN_ID` typed** ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)):
  it is read as Python's `int()` reads it, so `1_000` is token 1000, where
  it was refused (exit 2), and exactly, as `invite revoke` and `revoke-key`
  read their ids: `9007199254740993` revoked token `9007199254740992`, and
  `1000000000000000000000` was sent as `1e+21`. `ResourceClient.revokeToken`
  and `updateToken` take a `bigint` for such an id, and refuse a `number`
  past `Number.MAX_SAFE_INTEGER` or with a fraction before anything is
  sent, as `WorkspaceClient` does.

- `resource ingest-batch --file` words a file it cannot open as click
  does, and as `resource import --file` does: `Invalid value for '--file'
  / '-f': 'missing.json': No such file or directory`, where it gave Node's
  `ENOENT: no such file or directory, open 'missing.json'`.

- **The daily MCP call cap is a `KaguraQuotaError`**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57),
  as Python #268). A tool that refuses the cap in its reply,
  `rate_limit_exceeded`, used to raise a plain `KaguraError`, with nothing
  to say when the cap resets. It now raises `KaguraQuotaError` with
  `quotaType: "api_mcp_daily"`, `current` and `limit` from the reply's
  `used_today` and `daily_limit`, `resetsAt` the next UTC midnight (in
  Python's `+00:00` form) and a `retryAfter` counting down to it; fields the
  server does send win. The HTTP 429 the rate-limit middleware sends for
  the same cap is still a `KaguraRateLimitError`.

- **An out-of-range option is echoed as click converted it**
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)):
  `files upload --importance 2` is refused as `2.0 is not in the range
  0.0<=x<=1.0.` and `resource events --limit 0101` as `101 is not in the
  range 1<=x<=100.`, where the value was printed as typed.

- `--location` out of range prints the value as the Python CLI does
  (`got 91.0`, `got inf`), where it printed `91`, and `NaN` for `inf`.

- A value quoted in an error escapes what Python's `repr()` escapes beyond
  ASCII too, such as a no-break space (`'a\xa0b'`) or a zero-width space.

- An empty argument (`''`) reaches the command in its place, as click
  passes it through
  ([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)).
  An empty first argument was dropped, so each later one moved up into
  its place: `recall '' -k 5` reported a missing `QUERY`, and a command
  taking three arguments read its second as its first.

## [0.11.0] - 2026-09-24

### Added

- **`auth list --json`**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55))
  emits the Python CLI's payload: one object per profile, in file order,
  with `profile`, `default`, `user_email`, `workspace_name`,
  `workspace_id`, `server`, `scope`, `expired`, `refreshable` and
  `expires_at` (UTC, as Python's `isoformat()` writes it), with non-ASCII
  escaped as `\uXXXX`, as Python's `json.dumps` default writes it (every
  other command prints UTF-8, as Python does there). No token is ever
  included, and with no profile it prints `[]` and exits 0, as Python
  does.

- **`auth status` reports the Claude Code entry in use**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  After the profile blocks it prints the `kagura-memory` entry Claude Code
  uses in the current directory, from the strongest of local, project and
  user scope, and each entry that one hides, in the Python CLI's words:
  refresh-aware for the `kagura-mcp` stdio proxy, legacy static token (with
  the Python CLI's `setup claude --profile` as the way to migrate), or url
  form. It prints nothing when no scope defines one or the one in use is
  no form it knows.

- **`doctor` warns about an unset header variable, and checks
  `kagura-mcp` on `PATH`**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  For each `${VAR}` without a default that a header of the entry in use
  sends and that is unset or empty here, `doctor` warns, in Python's
  words, that Claude Code would send it as literal text. This is the one
  way the new user-scope entry fails. For a `kagura-mcp` stdio entry, which
  the Python CLI's `--profile` setup writes, it passes or fails on whether
  `kagura-mcp` is on `PATH`.

- **`setup claude` accepts the Python CLI's hook, command and
  context-selection flags**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)):
  `--session-hook`, `--no-session-hook`, `--sync-hook`, `--no-sync-hook`,
  `--commands`, `--no-commands` and `--no-auto-context`. This port installs
  no hooks or slash commands and never picks a context, so they change
  nothing, as their help says; a script written for `kagura setup claude`
  no longer fails on an unknown option. A flag that asks for a hook or
  command gets a note saying it did nothing.

- **`recall --rerank` / `--no-rerank`**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  Without either flag no `use_rerank` is sent, so the server (memory-cloud
  v0.69.0+) follows the context's search config. `--rerank` sends
  `use_rerank: true`, which applies only where the context allows
  reranking, and `--no-rerank` sends an explicit `false`, which always
  skips it. The help and examples
  are the Python CLI's. Giving both is a usage error (exit 2), as it
  already is on `context search-config`, where click takes the last one.

- **`context list --name-contains / --summary / --details / --stats`**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)),
  with the Python CLI's help, map to `listContexts`'s `nameContains`,
  `includeSummary`, `includeDetails` and `includeStats`. The first three
  need memory-cloud v0.73.0+; `--stats` works on any server. An empty
  `--name-contains=` lists everything, as in Python. The `contexts` alias
  takes none of these options, as in Python, and its help now says to use
  `context list` for them.

- **`update-memory --dismiss-supersede-candidate`**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55))
  rejects the memory's `supersede_candidate` suggestion (server v0.65.0+;
  older servers drop the flag silently). It needs `--memory-id`: with
  `--external-id` it exits 1 before anything is sent, with the Python
  CLI's message, `--dismiss-supersede-candidate requires --memory-id (not
  --external-id)`. An empty `--external-id=` is refused the same way, as
  `updateMemory` refuses it; the Python CLI lets that one through and
  sends the empty value.

- **`setup codex` and `setup openclaw` take `--api-key-env VAR`**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)),
  as the Python CLI's do (python-sdk#260): the variable the entry reads
  the key from, `KAGURA_API_KEY` by default. It goes into `codex mcp add
  --bearer-token-env-var`, OpenClaw's `Authorization=Bearer ${VAR}`
  header, the printed block and the notes. The name starts with an
  upper-case letter or `_`, and goes on with upper-case letters, digits or
  `_`; any other is a usage error (exit 2) with Python's message.
  `setup hermes` refuses the option (exit 2), since Hermes names the
  variable itself (`MCP_<NAME>_API_KEY`).

- **`setup codex|hermes|openclaw --url-form`**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55))
  is accepted, so a script written for the Python CLI's URL form runs
  here. Every entry this port writes is that form, so the flag changes
  nothing. With it, `--profile` is ignored with a note instead of refused:
  the Python CLI uses it there to check the login, list contexts and fetch
  the `AGENTS.md` export, and this port never contacts the server.

### Changed

- **`setup claude --scope user` keeps the API key off `claude`'s command
  line and out of `~/.claude.json`**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  The entry passed to `claude mcp add-json` carried the key, where any
  local user could read it in the process list while the command ran, and
  Claude Code then stored it in `~/.claude.json`. The entry now sends
  `Authorization: Bearer ${KAGURA_MCP_API_KEY}`, which `add-json` stores as
  written and Claude Code expands from its own environment each time it
  connects: the entry the Python CLI writes (python-sdk#258), so a run of
  either CLI finds the other's entry up to date, where before this CLI
  replaced Python's with a baked key. Export `KAGURA_MCP_API_KEY` where
  Claude Code starts. It is deliberately not `KAGURA_API_KEY`, which the
  SDK ranks above `.kagura.json` and every OAuth profile. Setup's notes
  say where the key now comes from and whether this shell has the
  variable, never printing it, and `applied_with` shows the command as it
  ran. Without `claude` on `PATH`, the printed command names the variable
  as well, rather than expanding `$KAGURA_API_KEY` into the command line
  when pasted. `--scope project` is unchanged: the key stays in
  `.mcp.json` (0600, gitignored), as in Python. `.kagura.json` keeps the
  key at both scopes. **Upgrading:** a user-scope entry an earlier release
  wrote still holds the key in `~/.claude.json` until you re-run
  `kagura-memory setup claude --scope user` with `KAGURA_MCP_API_KEY`
  exported, which replaces it; `doctor` now warns about such an entry.

- **A failed user-scope replace never puts back an entry that holds a
  key** ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  When `add-json` failed after the old entry was removed, the old entry
  went back through `claude`'s argv, and an entry with a baked key took
  that key with it. As in Python, such an entry is not put back. When it
  is not, or putting back an entry without a key fails too, setup prints
  the command that re-adds it, a baked key masked as `<your-api-key>`, and
  the error keeps the first failure and says why the old entry could not
  be restored.

- **Each `auth` subcommand takes only the options it reads**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  The subcommands shared one option set, so `auth status --yes` or
  `auth list --server …` parsed and then did nothing. Each now declares its
  own, as the Python CLI does, so any other option is an unknown option
  (exit 2) and `--help` lists only the subcommand's own. `refresh` keeps
  `--no-browser` for the device flow a widening scope re-runs. `--invite`
  outside `login` is still refused with its own message, its value never
  quoted. The help texts are Python's where the behaviour is the same.

- **An unknown option is reported in click's words**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)):
  `Error: No such option: --x`, where this CLI said `Unknown option: --x`.
  That is the wording of click 8.3, which the Python CLI's lockfile pins;
  click 8.4 and later, which a fresh `pip install kagura-memory` resolves,
  write `Error: No such option '--x'.`. The option is named as click names
  it, without any value written into the token: `--x` for `--x=value` and
  `-x` for `-xVALUE`, where this CLI quoted the whole token, value
  included. A switch given a value (`--json=true`) gets click's `Error:
  Option '--json' does not take a value.`, and an option the root or a
  group does not take (`kagura-memory --x`, `kagura-memory auth --x`) now
  gets the same error line before the help, where it got the help alone.
  The exit code (2) and the help that follows are unchanged. Click's `Did
  you mean …?` suggestion is not reproduced.

- **Short options combine as in click**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)):
  `-k10` is `-k 10`, and switches can share one dash, where this CLI
  refused both as unknown options. In such a group the first letter that
  is no option is reported by itself: `context delete ID -yx` is
  `Error: No such option: -x`. Only the first bad option is reported, as
  click stops at the first error. One case still differs: `-k=5` reads
  `5` here, where click reads `=5`.

- **`auth logout` revokes the token on the server first**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)),
  as the Python CLI does. `POST /api/v1/oauth/revoke` is best effort,
  bounded at 30 seconds: the profile is deleted whatever the server says,
  and a failure prints Python's warning (with `--all`, every profile is
  revoked and a failure is silent, as in Python). A note follows when
  `KAGURA_API_KEY` is still set, and `-y` is now short for `--yes`. The
  confirmation prompt, the exit 0 for a logout that names no profile when
  nothing is stored, and the usage error (exit 2) for `--all` with
  `--profile`, where Python ignores `--profile` and removes every profile,
  stay as they were.

- **Four exit codes follow the Python CLI**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)):
  `auth login --read-only --scope …` exits 1 (was 2), since Python raises a
  `ClickException` there, not a usage error; `auth list` and `auth status`
  with no profile exit 1 with `Error: No profiles. Run: kagura-memory auth
  login` (was 0, the message on stdout); and `doctor` exits 1 (was 0)
  when the entry in use is a `kagura-mcp`
  stdio entry and `kagura-mcp` is not on `PATH`, the new check failing as
  Python's does. That includes an entry that names it by path or through
  a launcher, which `doctor` used to report with a warning (see Fixed).

- **`setup claude` messages follow Python's**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  A fresh user-scope add notes `Added kagura-memory at user scope (…)`,
  and a replacement `Replaced the existing user-scope kagura-memory entry
  (…)`. With the Kagura Memory plugin enabled, the notes add that the
  plugin has one guardrail context for every project and authenticates
  only with a user API key. The help gives the server floors for
  `--guardrails` (memory-cloud v0.74.0+) and `--tool-profile` (v0.73.0+),
  and the profile names the server knows, `full` and `core`. `--guardrails`
  is written `off|CONTEXT_ID`, as in Python and on the other `setup`
  subcommands, and `--profile`'s help says the option is refused: it is
  the Python CLI's `kagura-mcp` entry.

- **`refreshAccessToken`'s non-OAuth failure quotes an
  `error_description`**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  A refresh answered with an `error_description` but no `error` code used to
  end `Body: <the raw JSON>`; it now ends `Body: <the description>`, as the
  Python SDK's does. A body with an `error` code reads as before.

- **`setup codex`, `setup hermes` and `setup openclaw` never see, write,
  print or pass the API key, and write no file**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)),
  as in the Python CLI (python-sdk#260). They wrote the key into Hermes's
  `.env` as `MCP_<NAME>_API_KEY` and into OpenClaw's `.env` as
  `KAGURA_API_KEY`, even a key found only in `KAGURA_API_KEY`, and wrote
  `.kagura.json` with the key (Codex left out only a key it found in
  `KAGURA_API_KEY`) and its `.gitignore` line. None of that happens now.
  A missing key is no longer an error, where these setups exited 1 with
  `no API key`. The entry still only names the variable, and a closing
  note says where to put the key:
  - Codex: `export KAGURA_API_KEY=<your-api-key>` (or the `--api-key-env`
    variable) in the shell profile that starts Codex.
  - Hermes: `MCP_KAGURA_MEMORY_API_KEY=<your-api-key>` in the `.env`
    beside the `config.yaml` setup names, added with an editor.
  - OpenClaw: `KAGURA_API_KEY=<your-api-key>` in `$OPENCLAW_STATE_DIR/.env`
    (default `~/.openclaw/.env`), added with an editor; then
    `openclaw mcp doctor kagura-memory --probe`.

  A `.env` line or `.kagura.json` an earlier release wrote is left as it
  is, and the entries it serves go on working. Remove the key from
  `.kagura.json` if nothing else there needs it, including one that
  `setup codex --api-key` wrote. `--api-key` and `--project-dir` are still
  accepted, so v0.10 scripts run, but they do nothing, and a note says so;
  `--project-dir` no longer has to exist. `--api-key` beside `--profile`
  is still the usage error (exit 2) it was. The configuration is read
  only for the `mcp_url` and `context_id` fallbacks, so with `--mcp-url`,
  a `.kagura.json` that cannot be loaded no longer stops these setups
  (exit 1): they go on with a note, as Python never reads it.
  The JSON report keeps its fields, and `wrote` and `gitignore_added` are
  now empty. `setup claude` still writes `.kagura.json`, with the key, and
  its `.gitignore` line.

- **The `--profile` refusal names the Python command for every harness**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  Python v0.40.0 ships `kagura setup codex|hermes|openclaw --profile`, so
  the refusal says `pip install kagura-memory && kagura setup <harness>
  --profile <p>` for each of them again, or `--url-form` here, where it
  named the Python route for `setup claude` alone. `setup hermes|openclaw
  --profile p --guardrails off` is now the usage error (exit 2) it is in
  Python, where the `--profile` refusal came first and exited 1.

- **A `?guardrails=off` already in the MCP URL is kept on Hermes and
  OpenClaw, with a warning**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)),
  as the Python CLI does: `Warning: --mcp-url has ?guardrails=off, which
  removes the guardrails block from get_context_info: <harness> then gets
  no guardrails from Kagura.` It was a usage error (exit 2), from
  `--mcp-url` or from the configured `mcp_url` alike. `--guardrails off`
  itself is still refused, with Python's sentence: `Hermes Agent does not
  read MCP instructions: its guardrails come only from the guardrails
  block of get_context_info, which --guardrails off removes.`

- **A plain-HTTP MCP URL is refused on the harness setups**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)),
  as in Python: an `--mcp-url` that is `http://` and not localhost exits 2
  with `Invalid value for '--mcp-url': MCP URL must use HTTPS for security
  (got: …). HTTP is only allowed for localhost development.`, since the
  entry sends the key there with every request. A configured `mcp_url`
  like that exits 1 and says to pass `--mcp-url`. `setup claude` does not
  check, as in Python.

- **An existing Hermes or OpenClaw entry stops setup only when that
  harness's CLI is on `PATH`**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  The Python CLI finds those entries only through `hermes mcp list` and
  `openclaw mcp show`, so without the CLI it prints the block and exits 0.
  This port now does the same, where it exited 1. Its scan of the file then
  only adds `in place of the existing one` to the message. A Codex entry
  stops setup either way, since both CLIs read `config.toml` for it. A
  `config.yaml` or `openclaw.json` that cannot be read no longer stops
  setup either (it exited 1), since Python never reads those: a note says
  setup could not look there. An unreadable `config.toml` still stops
  `setup codex`, in Python's words.

- **`--name` takes at most 64 characters, and the message is Python's**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)):
  `Invalid value for '--name': use 1-64 letters, digits, '-' or '_',
  starting with a letter or digit`. The first character still has to be a
  letter or digit, which Python does not require: the name is a bare
  argument to `codex` and `openclaw`, which would read `--help` as an
  option.

- **The harness setups speak in the Python CLI's words**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  The notes, the stderr headings and the errors now follow Python's:
  - An existing entry: `Nothing was written: a kagura-memory entry
    already exists in ~/.codex/config.toml; re-run with --force to replace
    it.`
  - A dry run: `Dry run: nothing is written, run or fetched.` first, then
    `Setup would stop here: …` where a real run would stop, and `Would run:
    <command>`, or `With --force, would run: <command>`. For OpenClaw that
    command is `openclaw mcp set`, the one a `--force` run uses.
  - The printed block: `Setup does not edit ~/.codex/config.toml itself
    (<reason>). Add this kagura-memory entry to it[ in place of the
    existing one]:`.
  - The closing notes of a real or printed run: `Done: codex wrote
    kagura-memory to ~/.codex/config.toml.`, the key note, Codex's `Restart
    Codex (or start a new session) to load the entry.`, OpenClaw's
    Gateway note, and `Check it with: codex mcp get kagura-memory` (`hermes
    mcp test …`, `openclaw mcp doctor … --probe`). A dry run ends before
    them, as in Python.
  - Codex guardrails: the plugin-hooks default says `The plugin's hooks
    deliver guardrails, so the URL gets ?guardrails=off (…)`, and a context
    in the URL gets Python's digest note, with the Python CLI's `kagura
    guardrails digest <uuid> --target instructions` command that previews
    what Codex receives.
  - Hermes and OpenClaw: a `--guardrails` context gets `Warning: … does not
    read MCP instructions, so --guardrails has no effect there and is not
    written.`
  - A failing `codex` or `openclaw`: `` `codex mcp add` failed: <what it
    printed> ``, or `exit code N`, or `timed out after 120s`. Every key
    this process knows of is masked in what it printed: `--api-key`, a
    configured `api_key`, `$KAGURA_API_KEY`, `$KAGURA_MCP_API_KEY` and the
    `--api-key-env` variable, as in what a failing `claude` prints. Both
    now get Python's 120-second timeout, where they got 60. A run that
    reaches it fails as timed out whatever the CLI then exits with, where
    one that caught the signal and exited 0 was reported as done. Every
    harness CLI, `claude` included, is now killed there with SIGKILL, as
    Python kills it, not SIGTERM, together with every process it started:
    on POSIX it runs as the leader of its own process group, and the whole
    group is killed. So a launcher such as the npm `codex`, whose native
    binary inherits the output pipes, no longer keeps setup waiting past
    the timeout, and nothing it started is left running unless a process
    detached itself on purpose. On Windows only the CLI
    itself is killed, and setup returns at the timeout all the same.
  - Hermes is `Hermes Agent`, and paths under the home directory are
    written `~/…`, in messages. The JSON fields keep full paths.
  - `--help` has Python's summaries and option help. `--guardrails` is
    written `off|CONTEXT_ID`, and `--mcp-url` and `--context-id` say what
    they do here.

### Fixed

- **`setup claude` takes a missing key and URL from the project it sets
  up** ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  Without `--api-key` or `--mcp-url`, it took them from the configuration
  this bin's other commands load: the current directory's `.kagura.json`,
  else `~/.kagura.json`. So `setup claude --project-dir ../other`, run
  from one project, wrote this project's key and URL into the other's
  `.kagura.json` and `.mcp.json`, and Claude Code there signed in as the
  wrong identity or workspace. As in the Python CLI, they now come from
  the `.kagura.json` in `--project-dir`, then from `KAGURA_API_KEY` (and
  `KAGURA_MCP_URL`); never from another directory's file. The context id
  falls back the same way.

- **A malformed `.kagura.json` or `.mcp.json` is named, never quoted**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  The errors passed on the `JSON.parse` message, which for an unexpected
  token quotes the text around it, and so could print the first
  characters of an API key: every command that loads the configuration,
  the harness setups included, `setup claude` for either file, and
  `doctor`. They now name the file and, where JSON.parse gives one, the
  position as Python writes it: `Invalid JSON or encoding in .kagura.json
  (expected UTF-8): line 2 column 43`, `refusing to rewrite …/.mcp.json:
  it is not valid JSON`, `.mcp.json is not valid JSON (line 2 column 20)`.

- **`doctor --json` printed `"[Circular]"` for a shared details object**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  The checks about one Claude Code entry shared its `details`, and the
  JSON printer took every object it met twice for a cycle, so the legacy
  `type: "url"` warning had `"details": "[Circular]"`. Each check now has
  its own, and the printer marks only an object that contains itself.

- **`doctor` and `auth status` know a `kagura-mcp` entry by path or
  launcher**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  `doctor` took an entry for the stdio proxy only when its command was
  exactly `kagura-mcp`, so `/venv/bin/kagura-mcp`, `kagura-mcp.exe` and
  `uvx --from kagura-memory kagura-mcp`, which work in Claude Code, were
  reported as no usable entry. One classifier, Python's, now serves
  `setup claude`, `doctor` and `auth status`.

- **Messages name the `.claude.json` actually read**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  With `$CLAUDE_CONFIG_DIR` set, `setup claude` and `doctor` read
  `$CLAUDE_CONFIG_DIR/.claude.json` but still called it `~/.claude.json`.
  They now name it as Python does: under `~` when it is in the home
  directory, by its full path otherwise.

- **A workspace-URL 400/403 from the MCP transport says why**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  memory-cloud answers a `/mcp/w/<workspace>` URL whose workspace id is
  malformed, or that the credential does not belong to, with an OAuth-style
  body, `{"error": "<code>", "error_description": "..."}`, and the shared
  error extractor did not read that shape, so `KaguraClient` threw a bare
  `HTTP 403`. It now reads `error_description` last, after the other five
  shapes, as the Python SDK's `extract_detail` does: `HTTP 403: You are
  not a member of this workspace.` `authorizeDevice` had its own copy of
  that rule and now uses the shared one, with the same messages.

- **README claims that no longer held**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  The bin ports 17 of the Python CLI's 21 top-level commands, counting the
  `contexts` alias, not "17 of 19". `kagura process` was removed from the
  Python SDK in v0.37.0 and is no longer listed as not ported, and
  `doctor` no longer says it lives in the Python package: its `llm` line
  names `ingest` alone. The Python
  commands and options this bin lacks are now listed under **Not ported**:
  `auth create-key` / `list-keys` / `revoke-key`, `workspace member …` /
  `workspace invite …`, `guardrails load` / `digest`, `measure record` /
  `series`, `-v/--verbose` / `--progress` on `files upload` and
  `resource import`, and `--agents-md` on `setup codex`, `setup hermes`
  and `setup openclaw` (`--url-form` and `--api-key-env` are ported now;
  see Added). The intro no longer says every flag name is the Python
  CLI's: the options only this bin has (`secret keygen --reveal`, `-c` on
  `setup`, `--tool-profile` on `setup codex`, and `--no-browser` on `auth
  refresh`) are listed under **Only in this bin**, beside the `--api-key`
  and `--project-dir` the harness
  subcommands now accept and ignore (see Changed). The divergence
  paragraph named one place where this CLI refuses what click accepts, an
  empty `--profile=` or `--scope=`; it now also names `--lock --unlock`,
  `--rerank --no-rerank`, `auth logout --all --profile`,
  `--dismiss-supersede-candidate` beside an empty `--external-id=`, and a
  value that begins with a dash.
  The invite section says that a server older than memory-cloud 0.70.0
  takes no invites.

- **A bad `-i` on `update-memory`, or `-k` on `forget`, is a usage error
  whatever else is wrong**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  click converts a `type=float` or `type=int` option before the command's
  own checks run, so the Python CLI exits 2 with `Invalid value for
  '--importance' / '-i': 'abc' is not a valid float.` even when
  `--memory-id` / `--external-id` (or, for `forget`, `--memory-id` /
  `--query`) is also missing or wrong. This CLI ran those checks first and
  exited 1 with their message; it now converts the option first. A bad
  `-k`, on `forget` or `recall`, is named `'-k'` as click names it, where
  this CLI said `'--k' / '-k'`, naming a long form neither CLI has.

- **`setup hermes` follows Hermes's active profile**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  Hermes keeps `config.yaml` and `.env` in `~/.hermes/profiles/<name>` when
  `~/.hermes/active_profile` names a profile other than `default`. Setup
  read `~/.hermes` instead, so it checked the wrong file for an existing
  entry and named the wrong one. It now finds the home as the Python CLI
  does: `$HERMES_HOME`, else the active profile's, else `~/.hermes`.

- **The Codex plugin-hooks default counts only hooks that read this
  entry**
  ([#55](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/55)).
  Any `kagura-memory-*/config.json` under Codex's plugin data turned
  `setup codex`'s guardrails to `off`, even a directory of that name, and
  even for hooks set up for another table. As in the Python CLI, it now
  takes a `config.json` that is a JSON object of at most 64 KiB, whose
  `mcp_server` (`kagura-memory` when absent) is the `--name` being set up.

## [0.10.1] - 2026-09-23

### Fixed

- **`listTags({ withTags })` now filters**
  ([#47](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/47)).
  The drill-down went to the MCP `list_tags` tool, which has no
  `with_tags` through memory-cloud v0.76.0 and drops arguments it does not
  know. Every drill-down therefore came back as the whole, unfiltered
  vocabulary, with no error. A non-empty `withTags` now calls
  `GET /api/v1/contexts/{id}/tags`, which has had the filter since server
  v0.17.2, with one `with_tags` key per tag. The result has the MCP path's
  shape: `status`, `context_id`, `context_name`, `tags` of `tag`, `count`
  and `last_used_at`, and `total`. The REST route sends no
  `context_name`, so the client looks it up once per context with a
  one-tag `list_tags` call (the same access check as the route, and exempt
  from the MCP daily limit) and keeps it. A plain `listTags` call fills
  the same cache, so the usual browse-then-drill-down flow costs one
  request per drill-down.
  `withTags` values are trimmed and blank ones dropped, as the server does.
  More than 50 tags, or one over 200 characters, now throws before any
  request. A missing or hidden context throws `KaguraNotFoundError`, and a
  value the server refuses throws `KaguraError`, as on the MCP path. A
  plain `listTags` call is unchanged.

- **`setupResource` and `kagura-memory resource setup` work without a
  context name** ([#47](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/47)).
  The server's `setup_resource` requires `name`, but the SDK sent one only
  when given. The docs said the name defaulted to the resource id on the
  server, which was never true. So `setupResource({ resourceId })`,
  `ResourceClient.setupResource` without `contextName`, and every
  `resource setup` run (which has no name flag) were refused with
  `missing_fields`. The name now defaults to `resourceId` on the client.

### Deprecated

- **`createContext`'s `resourceId`, and `summary` on `setupResource` and
  `ResourceClient.setupResource`**
  ([#47](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/47)).
  The server reads neither (`create_context` has no `resource_id` and
  `setup_resource` has no `summary`, through memory-cloud v0.76.0), so both
  were silently dropped. They are no longer sent. The options stay, so
  existing code still compiles. Set them afterwards with
  `updateContext({ contextId, resourceId })` or
  `updateContext({ contextId, summary })`, which is owner-only. `resource
  setup --summary` is still accepted, but it prints a note saying it is
  ignored and names `kagura-memory context update` instead.

## [0.10.0] - 2026-09-23

### Added

- **`auth login --invite` signs a new account up with a beta invite**
  ([#44](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/44)).
  On a deployment that admits new accounts only by invite, a new user who
  started from `auth login` was refused at sign-up even with a valid
  invite: the approval page sends a signed-out visitor to the login page,
  which does not carry one. Only the CLI knows both the invite and the user
  code, so it now builds the link that does both,
  `<frontend>/join/<token>?return_to=%2Fdevice%3Fuser_code%3D<code>`,
  prints it under the code and opens it. The approval URL follows, under
  "If you land on the dashboard instead, approve here:", for a user who is
  already signed in. The flag takes the bare token or the
  `https://…/join/<token>` link it arrived in, and the prompts follow the
  Python CLI's (python-sdk#259).

  Once the device code is issued, an unauthenticated
  `GET /api/v1/system/info`, allowed 5 seconds, decides what is printed.
  memory-cloud v0.76.0 or later, the first release whose `/join` honours
  `return_to` (memory-cloud#1655), gets the one link; `v0.76.0` and
  suffixed versions such as `0.76.0+build.7` count. An older or unparseable
  version, an empty body or a failed request gets two steps: the plain
  `/join/<token>` link, then the approval URL, then how many minutes the
  code has left. A `features` object without `beta_invites: true` gets a
  one-line note and the ordinary prompt. A body with no `features` object
  says nothing about invites, so the version decides.

  `<frontend>` is the approval URL with its final `/device` removed, so a
  frontend under a base path gets `/join` beside `/device`. The CLI takes
  the two steps rather than guess when that URL does not end in `/device`
  (step 1 is then your own link or, for a bare token, the invite you were
  sent), when it is plain HTTP off localhost, and when memory-cloud's
  `/join` would silently drop the `return_to`: a path starting with `//`,
  as a frontend URL configured with a trailing slash produces, or one
  holding a backslash or a control character. A server that omits
  `verification_uri_complete` still gets the code in `return_to`.

  The token is a credential and is handled as one. It is checked before any
  request, and a malformed value exits 2 with `Error: Invalid value for
  '--invite': <reason>`, a reason that never quotes it. A pasted link must
  spell out `://`, since the CLI does not repair `https:/host/…` as a
  browser would, and must pass the `--server` HTTPS rule. A link for a
  different server than the one being logged into aborts before
  `/system/info` is asked and before polling, so no profile is written, and
  the error suggests `--server`. The token is never written to
  `credentials.json` or any other file, and is printed only inside a link.
  Every other `auth` subcommand rejects `--invite` with exit 2. `--invite`
  takes its value even when it begins with `-`, as about one base64url
  token in 64 does.

- **`buildInviteLink(verificationUri, verificationUriComplete, token)`**
  ([#44](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/44))
  builds the same link for an app that embeds `login()`, from its
  `onUserCode`, the first point where both the invite and the code are
  known. It takes the Python SDK's `build_invite_link` arguments in the
  same order and, like it, returns `null` when `/join` cannot be placed or
  would drop `return_to`. It is pure: it does not check the server version,
  and a malformed token throws `KaguraAuthError` without being quoted.

- **`setup codex`, `setup hermes` and `setup openclaw`**
  ([#45](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/45))
  connect OpenAI Codex, Hermes Agent and OpenClaw the way `setup claude`
  connects Claude Code: `.kagura.json` in the project, plus a
  `kagura-memory` entry holding the URL and a Bearer header. The key never
  goes into the harness's config file and is never printed. Codex reads it
  from `KAGURA_API_KEY` in the shell that starts it
  (`bearer_token_env_var`, since Codex rejects an inline `bearer_token` on
  an HTTP server and then fails to load the whole file), and a key found in
  that variable is not copied into `.kagura.json`. Hermes and OpenClaw read
  it from their own `.env` (`MCP_KAGURA_MEMORY_API_KEY`, or
  `MCP_<NAME>_API_KEY` under `--name`, in `$HERMES_HOME/.env`;
  `KAGURA_API_KEY` in `$OPENCLAW_STATE_DIR/.env`, by default
  `~/.openclaw/.env`), which is written 0600 with that one line replaced or
  appended. Every `setup` subcommand takes the key from `--api-key`, then
  from the `api_key` in `.kagura.json`, then from `KAGURA_API_KEY`, so a
  re-run finds a key that the first run left in the variable.

  This package has no TOML, YAML or JSON5 parser and takes no runtime
  dependencies, so it never rewrites those configs. The entry goes in
  through `codex mcp add` or `openclaw mcp add` (`openclaw mcp set` with
  `--force`) when that CLI is on `PATH`, run without a shell; otherwise the
  block is printed on stderr with the file it belongs in, and stdout stays
  one JSON document. On Windows, a CLI installed only as an npm `.cmd` shim
  counts as not found, because Node runs one only through a shell that
  would re-parse the arguments. Hermes always gets the printed block,
  because `hermes mcp add` always prompts; when its `config.yaml` already
  has an `mcp_servers:` key, the block is the `kagura-memory` entry alone,
  indented to go under it, since a second top-level key would replace the
  first and every server in it. OpenClaw's block names
  `$OPENCLAW_CONFIG_PATH` when that is set. An existing entry of the same
  name stops the command with exit 1 unless `--force` is given; `--name`
  renames the entry, and `--dry-run` shows what would be configured without
  writing or running anything. A name must start with a letter or digit,
  and anything else exits 2 before a harness CLI runs: the name is a bare
  argument to `codex` and `openclaw`, which would read `--name=--help` as
  an option, print their help and exit 0 with nothing configured. Hermes
  and OpenClaw do not pass the server's
  instructions to the model, so there `guardrails=off` is refused and a
  guardrails context id is dropped with a note, whether it comes from
  `--guardrails` or from the URL: `off` would also remove the
  `get_context_info` block, the only guardrail lane they have.

- **`setup claude --scope user`**
  ([#45](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/45))
  writes the entry with `claude mcp add-json --scope user kagura-memory
  <json>`, as the Python CLI does (python-sdk#258). `~/.claude.json` also
  holds the rest of Claude Code's state, so this bin reads it and never
  writes it. The entry is an argument, so the key is in that child's
  argument list while it runs; the help says so. An identical user-scope
  entry is left alone and needs no `claude`. A different one is replaced:
  `claude mcp remove --scope user kagura-memory` runs first, and if
  `add-json` then fails, the old entry is put back. Only if that fails too
  does the error say that none is configured, with the command that adds
  the new one. Without `claude` on `PATH`, the commands to run are printed
  and the command exits 1, writing nothing.

- **`--guardrails <context-id|off>` and `--tool-profile <name>`** on
  `setup claude` and `setup codex`
  ([#45](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/45))
  set the entry URL's `guardrails` and `profile` parameters as the Python
  CLI does: an existing value is removed and the new one appended,
  `guardrails` before `profile`, and every other parameter is kept as
  written. `.kagura.json` gets `--mcp-url` as given; the flags' parameters
  go on the entry only. A `--guardrails` value that is neither `off` nor a
  UUID exits 2, since the server silently ignores it, and so does an empty
  `--tool-profile`. On Codex, when neither the flag nor the URL sets
  `guardrails`, it defaults to `off` if the Kagura plugin's Codex hooks are
  on, and otherwise to the `-c` context when that is a UUID. As in the
  Python CLI, `--tool-profile` on a URL with a `?tools=` allowlist, which
  the server applies instead, gets a warning in the notes, and a
  `setup claude` run that leaves out a `guardrails` or `profile` value the
  replaced entry had says so: "Note: the previous project-scope entry also
  had --guardrails off, which this run left out; re-run with it to keep
  it."

- **`setup claude` notices the Kagura Memory plugin.** When
  `claude plugin list --json`, run in `--project-dir`, shows it enabled,
  the notes list the plugin's `server_url` and `context_id` settings to
  enter and, unless the URL already carries `guardrails=off`, recommend
  re-running with `--guardrails off` once its hooks deliver guardrails.
  The URL is not changed for you: `off` also removes the guardrails block
  from `get_context_info`.

- **`recall --trusted-only`**
  ([#45](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/45))
  sends `filters.trust_tier = "trusted"` (server v0.24.0+), so external and
  connector-ingested memories are left out of the results. The Python CLI
  added it for its SessionStart hook; this bin installs no hooks, but
  mirrors the flag and its help so the two CLIs take the same argv.

### Changed

- **The device-flow prompt is worded as the Python CLI's**
  ([#44](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/44)),
  for `auth login` with or without `--invite`, and for an `auth refresh`
  that re-runs the device flow. The code line now starts with `!`
  (`! First copy your one-time code: <code>`), `Then approve at:` reads
  `Open this URL in your browser to approve:`, the `--no-browser` line says
  `polling will continue here` instead of `still polling here`, and a
  browser that cannot be opened gives `Could not auto-open the browser.
  Open the URL above manually. Polling will continue here.` A script that
  scrapes these lines needs updating.

- **`setup claude`'s JSON report gains `harness`, `applied_with`,
  `guardrails` and `notes`**
  ([#45](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/45)),
  the shape every `setup` subcommand prints. The keys it already had stay;
  `mcp_url` is the entry's URL, so it includes the parameters the new
  flags set.

- **`doctor` reports the Claude Code entry in use, whichever scope it is
  in**
  ([#45](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/45)).
  It read only `./.mcp.json`, so a user- or local-scope entry read as
  missing and one scope hiding another went unreported. It now reads the
  same three scopes as `setup claude`, the same way (local scope under the
  git repository root, project scope from the closest `.mcp.json` here or
  in a parent directory, labelled by its path), and reports the entry
  Claude Code uses as `MCP Mode: <mode> (<scope> scope, <file>)`, with
  `scope` and `source` in the check's `details`, plus a warning for each
  entry that one hides, in the Python CLI's words. The other messages
  change too: an
  `info` "No kagura-memory MCP entry found (.mcp.json, ~/.claude.json)"
  when no scope has one, and a `warn` "No usable kagura-memory entry found
  in …" for a `.mcp.json` without one, or for an entry that is neither the
  `kagura-mcp` stdio proxy nor an HTTP entry. A static-token entry passes,
  where Python's `doctor` points at `setup claude --profile`, whose proxy
  this package does not ship. A `.mcp.json` that is not JSON still fails.
  The warning about a legacy `type: "url"` entry names the fix for its
  scope, in the Python CLI's words: re-run `kagura-memory setup claude` for
  project scope (with `--project-dir <dir>` for a parent directory's
  `.mcp.json`), `--scope user` for user scope, and for local scope
  `claude mcp remove --scope local kagura-memory` first.

- **`setup`'s missing-key error names `KAGURA_API_KEY` and no longer
  points at `auth login`**
  ([#45](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/45)).
  An OAuth profile gives `setup` no key, so following that hint changed
  nothing. The error now reads `no API key: pass --api-key, set api_key in
  .kagura.json, or export KAGURA_API_KEY.`, and `setup claude` reads that
  variable when `.kagura.json` has no `api_key`, where it used to stop.

### Fixed

- **`setup claude` wrote an entry that Claude Code skips**
  ([#45](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/45)).
  The `.mcp.json` entry had `type: "url"`, which is not one of Claude
  Code's transports: Claude Code 2.1.280 reports it as
  `Skipped — unknown MCP server type "url"`, and
  `claude mcp get kagura-memory` finds no such server, while the command
  reported success. The entry is now `type: "http"`. Re-run `setup claude`
  to rewrite an existing one; `doctor` warns about a `url` entry and names
  the command for its scope.

- **`setup claude` could report success for an entry that never takes
  effect**
  ([#45](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/45)).
  Claude Code uses the `kagura-memory` entry from the strongest scope
  (local, then project, then user), so one in a stronger scope silently
  hid the entry just written. The command now writes nothing and exits 1,
  printing `claude mcp remove --scope <scope> kagura-memory` for each such
  entry. For the default `--scope project` that is a local-scope entry; for
  `--scope user` a project `.mcp.json` entry, such as the one earlier
  releases wrote, counts too. An entry the new one hides in a weaker scope
  is noted instead. The scopes are read as Claude Code reads them: local
  scope under the git repository root (a linked worktree's main working
  tree), whichever subdirectory setup runs in, and project scope from the
  closest `.mcp.json` that defines the entry, in the project or a parent
  directory. A parent's entry stops `--scope user`, and a `--scope project`
  write below it is noted as hiding it. The printed command starts with a
  `cd` into the directory it acts on (the project, or the one holding the
  `.mcp.json`) when that is not the current one. An `.mcp.json` it cannot
  parse, or whose `mcpServers` is not an object, now also stops the
  command before `.kagura.json` is rewritten rather than after; an array
  there used to lose the entry while the command reported success.

- **A rate-limited device sign-in says how long to wait**
  ([#44](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/44)).
  memory-cloud v0.76.0 limits `POST /api/v1/oauth/device/authorize` per
  client address (memory-cloud#1656), and `authorizeDevice` reported its
  429 as `Device authorization failed (HTTP 429)` with a hint to check the
  client id. It now throws `KaguraAuthError` "Too many sign-in attempts
  from this address (HTTP 429). Retry after N seconds.", with N from a
  numeric `Retry-After` (60 otherwise) and the server's
  `error_description` on a `Server said:` line: the Python CLI's text.
  `login()`, a `refresh()` that re-runs the device flow, and the `auth`
  commands all get it. Other authorize failures quote an RFC 6749
  `error_description` instead of the raw JSON body. The token poll is
  unchanged.

## [0.9.0] - 2026-09-23

### Added

- **Plan, quota, partial-rollback and permission refusals are typed
  errors now, and keep their payload**
  ([#40](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/40)).
  The server has sent machine-readable refusals for a while, but the SDK
  collapsed every MCP code it did not know into a bare `KaguraError` and
  every REST 403 into `KaguraConnectionError("HTTP 403: …")` — a class that
  suggests a network problem — and dropped the fields that said what to do.
  Callers could not tell the daily memory cap from the total one, read a
  reset time, or learn which plan lifts a refusal without parsing prose
  whose wording has already changed once.

  | Class | Raised for | Carries |
  |---|---|---|
  | `KaguraFeatureNotAvailableError` (new) | MCP `plan_required` / `feature_not_available`, REST 403 `FEAT-001` | `feature`, `requiredPlan`, `requiredPlanDisplay`, `currentPlan`, `gate` |
  | `KaguraQuotaError` (extended) | MCP `quota_exceeded` / `CONNECTOR-001`, REST `QUOTA-001` / `QUOTA-002` / `CONNECTOR-001` | the above plus `quotaType`, `current`, `limit`, `usedToday`, `resetsAt` |
  | `KaguraPartialRollbackError` (new) | `rollbackSleepRun` reversing only part of a run | `reportId`, `summary` |
  | `KaguraPermissionError` (new) | MCP `permission_denied`: usually a role too low, but on `updateSearchConfig` also a context that does not exist or that the caller cannot see | `requiredRole` (only some tools send it: `null` on `updateSearchConfig`, `updateContext`, `deleteContext`, the file tools and the analysis tools) |

  All of them extend `KaguraError`, so existing `instanceof KaguraError`
  handling still catches them, and the MCP ones keep the exact message the
  generic mapping produced. `KaguraQuotaError`'s constructor is unchanged
  apart from accepting the new fields in its options; they default to
  `null`, and `retryAfter` is derived from `resetsAt` when no `Retry-After`
  was sent. The option shapes are exported as the types
  `KaguraErrorOptions`, `KaguraGateOptions` and `KaguraQuotaErrorOptions`,
  and `KaguraRestClient` gains a protected `gateRefusal(response)` hook: a
  subclass of your own that overrides `error403` or `error429` should
  return `this.gateRefusal(response)` first when it is not `null`, as the
  built-in clients do, or its plan and quota refusals stay untyped.

- **The class follows memory-cloud v0.75.0's `gate`, not the status or
  the code alone.** v0.75.0 tags every plan and quota refusal with
  `gate` (`plan`, `quota`, `allowlist`, `deployment`) — at the top level of
  an MCP envelope, under `details` on REST — and the SDK reads it first,
  falling back to the code for older servers. From an older server, which
  sends no canonical `current` / `limit`, the counts are read from the
  legacy names each cap sent: `used_today` / `limit_today` (the daily
  memory and analysis quotas), `owned_count` / `cap` (the workspace cap)
  and `active_connectors` / `max_connectors` (the connector seat cap).
  That matters because a 403 is
  not always a plan refusal: the resource-token cap on
  `ResourceClient.createToken` is a `QUOTA-001` that still answers **403**,
  and becomes a `KaguraQuotaError`. v0.75.0 also turned `createContext`'s
  shared-context refusal from a `validation_error` into `plan_required`, so
  it is a `KaguraFeatureNotAvailableError` against a new server. A `FEAT-001` behind an
  `allowlist` or `deployment` switch stays a `KaguraFeatureNotAvailableError` — the class
  an older server's bare `FEAT-001` already gets — with `requiredPlan`
  `null`, because no upgrade lifts it. `gate: "quota"`, by contrast, marks
  every typed cap, including one no tier raises, so an upgrade helps only
  when `requiredPlan` is not `null`. That reading needs a `gate`: with
  none (an older server, or `createContext`'s own context-limit check), a
  `null` `requiredPlan` means the plan is unknown.

  Every REST client's 403 hook checks for a gate refusal before its own
  message, so a plan refusal no longer picks up `FilesClient`'s
  workspace-mismatch hint or the secret store's "you may not have a grant".
  REST 429s were already `KaguraQuotaError`, and stay one even when the body
  reads as a plan refusal; a typed one (the member seat cap is now
  `QUOTA-001` with `quotaType: "members"`) now keeps the server's message
  and its counts. Two 429 paths deliberately keep their class:
  `SecretClient` renders 429 through the generic branch as it always has,
  and `KaguraClient`'s own transport 429 stays `KaguraRateLimitError`. That
  one covers the daily call quota as well as the per-minute limit, so it
  now carries the same fields as `KaguraQuotaError` — `quotaType` is
  `api_mcp_daily` or `api_rest_daily` on a v0.75.0+ quota, and every field
  is `null` on a per-minute limit.

- **A partial `rollbackSleepRun` hands back its summary.** It used to throw
  and lose the `rollback_summary` the README told callers to read.
  `err.summary` is the same `RollbackSummary` a clean run returns, which
  gains `merges_unreversible`, `importance_kept` and `promotions_kept`.
  The report is `failed` afterwards, and the server will not roll back a
  `failed` report again, so there is no retry: the actions listed in
  `err.summary.errors` need handling some other way.

- **`createContext`'s context-limit error carries its counts.** The SDK
  checks `listContexts()` before it calls `create_context`, and throws its
  own `KaguraQuotaError` when `can_create` is false, as the Python SDK
  does. That error now fills in `quotaType: "contexts"`, `current` and
  `limit`. It has no `gate` and no plan fields, because `list_contexts`
  does not send them, so it says less than the server's own context-cap
  refusal, which names the plan that lifts the cap. The server's refusal
  arrives when a concurrent create gets past the check, and when
  `list_contexts` reports `limit: 0` — its answer to a failed quota
  lookup — in which case the pre-check now steps aside and lets
  `create_context` decide, as the Python SDK does.

- **`KaguraClient.loadGuardrails({ contextId, cap? })`**
  ([#41](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/41),
  server v0.74.0+): the guardrail set a client-side tool hook matches
  against, mirroring `loadPinned`. Before this, `load_guardrails` was
  reachable only through `callRawTool`, untyped. It returns two lanes, each
  capped on its own: the pinned set, and every memory carrying
  `details.tool_trigger`. `cap` bounds only the tool-triggered lane, so a
  large pinned set can never crowd guardrails out. `cap` is sent only when
  set, so the server default applies otherwise. Returns a typed
  `LoadGuardrailsResponse`. New model types: `ToolTrigger`, `GuardrailItem`,
  `LoadGuardrailsResponse` and `ContextGuardrails`.

- **`ContextInfo.guardrails`**: the trimmed guardrail block that
  `get_context_info` now returns. It has three states, and the type keeps
  them apart. The key is absent when the MCP URL carries `?guardrails=off`
  or the server is too old to send it. It is `null` when the server's read
  failed, which does not mean the context has no guardrails. Otherwise it is
  a `ContextGuardrails`. The SDK passes the field through unchanged, so a
  failed read is never reported as "no guardrails".

- **The rules for writing a guardrail are now documented**
  (`RememberOptions.details`, `UpdateMemoryOptions.details`, `forget`).
  Writing a `tool_trigger` already worked, because `details` is forwarded
  verbatim, but nothing said the key is reserved. The server validates it on
  write, and only a context editor or above, using a user credential, may
  set, change or delete one. Because `updateMemory({ details })` replaces
  `details` wholesale, leaving `tool_trigger` out silently turns the
  guardrail off. For a caller who may write to the workspace, `forget`
  skips any target it may not delete, or one already gone, instead of
  refusing it; that now includes every guardrail for a caller without
  those rights. So `deleted_count` can be 0 even for an explicit
  `memoryId`. A workspace viewer may not delete at all, and its `forget` is
  refused with `KaguraPermissionError` (`requiredRole: "member"`).

- **Server tool inputs the typed wrappers could not set**
  ([#42](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/42)).
  Each was reachable only through `callRawTool` until now:

  - `listContexts(options?)` takes `nameContains`, `includeSummary` and
    `includeDetails` (server v0.73.0+), and `includeStats`. It still works
    with no argument. A server older than v0.73.0 ignores `nameContains`
    without an error and returns every context, so the filter only narrows
    the list on v0.73.0 and later.
  - `recallUpcoming({ includeDetails })`.
  - `UpdateMemoryOptions.dismissSupersedeCandidate` rejects a
    `supersede_candidate` the server suggested (server v0.65.0+). It needs
    `memoryId`. Combined with `externalId` it throws before any request is
    sent, which matches the server's own rule: an upsert replaces the
    memory, so there is no suggestion left to dismiss.
  - `UpdateSearchConfigOptions` gains `reinforceEnabled`,
    `reinforceMaxBoost`, `reinforceRequireHostArbitration` and
    `routingMode` (new `RoutingMode` type), and the `SearchConfig` model
    gains the same four fields. `updateSearchConfig()` now types the
    `config` it echoes as `SearchConfig`, because that echo is the only
    place the four come back: `getContextInfo()`'s `search_config` leaves
    them out. The `rerankerProvider` doc named `"ollama"`, which the
    server has not accepted since v0.42.0. It now lists `voyage`, `cohere`
    and `self_hosted`.

  Boolean flags are sent only when `true`, as `recall`'s are, because
  `false` is the server default. The search-config fields are sent
  whenever they are defined: new contexts start with reinforce enabled, so
  `reinforceEnabled: false` is the reason to pass it at all.

  **Server v0.73.0 changed two default responses, and upgrading the SDK
  does not change them back.** `list_contexts` items are now
  `{id, name, is_private, is_locked, last_used_at}`; `summary` and
  `embedding_model` come back only with `includeSummary` or
  `includeDetails`. `recall_upcoming` items carry `trigger` instead of
  `details`, so `item.details` is `undefined` unless you pass
  `includeDetails: true`. Code that reads either field from the default
  shape has been getting `undefined` since that server release, and these
  options are how to ask for the fields again.

- **`ListContextsResponse` and `ContextListItem`**, the typed
  `list_contexts` envelope. It includes the optional `hint` that server
  v0.75.0 adds when the caller can see no context. `count` and `total` are
  easy to confuse: `count` is the workspace's quota usage and ignores
  `nameContains`, while `total` is the number of items returned.

- **Fields the server was already sending are typed now**
  ([#43](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/43)).
  The models are interfaces with no runtime validation, so nothing was
  lost at runtime, but a caller had to cast to read these. All of them are
  optional, so a response from an older server still type-checks.

  - `ServerInfo.search_defaults`, a new `SearchDefaults`: the reranker a
    new context starts with (server v0.69.0+). `ServerFeatures` gains the
    eight flags it did not know, `plan_page`, `byok`, `cost_display`,
    `managed_connectors`, `managed_llm`, `referrals`, `beta_invites` and
    `reranking`, plus an index signature, so a flag a later server adds
    still type-checks.
  - `SleepRunStatus` gains `"degraded"` (server v0.43.0+): the run
    finished, but some of its judge-LLM calls failed. `SleepReport` gains
    `llm_call_failures`, the count behind that grade, and
    `SleepReportDetail` gains `merge_retention_result` (server v0.45.0+).
  - `IndexerSkippedReason` gains `"memories_per_day_exceeded"` (server
    v0.68.0+): the workspace's daily memory quota ran out and the batch
    waits for the UTC reset.
  - `Edge.origin` (server v0.52.0+) says who asserted an edge: `hebbian`,
    `semantic` or `declared`. Only `hebbian` edges decay.
  - `MemoryListItem.location` (server v0.54.0+), the coordinates of the
    memory's `details.location`, and
    `AuditVerifyResponse.erasure_pseudonymized` (server v0.55.0+), the audit
    rows whose hash changed because a data erasure pseudonymized them.

  A `switch` over `SleepRunStatus` or `IndexerSkippedReason` that ends in
  an exhaustiveness check stops compiling until it handles the new value,
  which the server has been sending since the versions above.

### Changed

- **REST plan and quota refusals are no longer `KaguraConnectionError`**
  ([#40](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/40)).
  A 403 `FEAT-001`, `QUOTA-001` or `CONNECTOR-001` used to be a
  `KaguraConnectionError`: `HTTP 403: <message>` from the base mapping
  (`ResourceClient`, `AgentsClient`), the server's message from
  `WorkspaceClient`, `HTTP 403: <message>` or the workspace-mismatch hint
  from `FilesClient`, and `Access denied (HTTP 403): …` with the grant text
  from `SecretClient`. It is now a `KaguraFeatureNotAvailableError` or `KaguraQuotaError`
  whose message is the server's own, with no prefix or hint. Code that
  catches `KaguraConnectionError`, or matches `HTTP 403` in the message, on
  these calls stops matching them; catch the typed class, or `KaguraError`.
  A typed 429 on the base mapping stays a `KaguraQuotaError`, but its
  message is now the server's instead of `Quota exceeded. Try again later.`
  A `RATE-001` 429 keeps the server's message too, scrubbed of credential
  markers: the resource events-per-hour quota on
  `ResourceClient.ingestEvent` / `ingestEvents` now reads "Event quota
  exceeded: N/M events per hour".

- **`listContexts()` returns `ListContextsResponse` instead of
  `ToolResult`.** The runtime value is the same object. Code that reads a
  key the type does not declare, or assigns the result to a
  `Record<string, unknown>`, no longer compiles and needs a cast.

- **`MIN_SERVER_VERSION` is `"0.75.0"`**
  ([#43](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/43)),
  up from `"0.17.1"`. The typed surface outgrew 0.17.1 long ago:
  `recallNearby` needs v0.53.0, and the gate-based error classes above read
  a field only v0.75.0 sends. The constant stays advisory. Only
  `checkServerVersion()` reads it, and that call warns on an older server
  and never throws, so nothing refuses to run against one; an older server
  ignores options it predates and leaves out fields it predates, as before.
  The README now says which server version the SDK targets.

- **`UsageInfo.mcp_calls_per_day` is a `UsageQuota`**, `{used, limit}`,
  which is what `get_usage` has always sent. It was typed limit-only, so
  today's call count was unreadable without a cast. Reading `.limit`
  compiles as before; a `UsageInfo` built by hand, such as a test fixture,
  now needs `used`. `UsageQuotaLimitOnly` no longer describes any response.
  It is deprecated but still exported.

- **`ResourceEventRecord.id` is a `string`, not a `number`.** This is a
  correctness fix and it can break a build. The server has always sent the
  event's BigInt id as a decimal string, so that it keeps its precision
  above 2^53 - 1, which means code that treated it as a number was
  already handling a string at runtime. Compare it as a string, or parse it
  with `BigInt()`, not `Number()`. `event_metadata` on the same record is
  typed `| null` too, because the server sends `null` for an event stored
  without metadata. `ResourceEventItem.id`, in `getIndexerStatus`'s
  `recent_events`, stays a number because the server sends a number there.

### Fixed

- **`retryAfter` reads the retry hint a body carries**
  ([#40](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/40)).
  It came only from a `Retry-After` header or from `resetsAt`, so the
  resource events-per-hour quota, which sends neither, left it `null` even
  though the server says to wait an hour. With no header, a 429 now falls
  back to the body's `details.retry_after` (a REST client's
  `KaguraQuotaError`, and `KaguraClient`'s own `KaguraRateLimitError`),
  and an MCP quota refusal to its `retry_after_seconds` (`ingest_events`
  through `callRawTool`).

- **`kagura-memory context search-config --reranker self_hosted`** was
  refused locally ("is not one of 'voyage', 'cohere'") and never reached
  the server, which has accepted `self_hosted` since v0.42.0. The flag now
  takes all three providers, as the Python CLI's does.

- **Docs that no longer matched the server**
  ([#43](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/43)):

  - A soft-deleted memory is kept, but not restorable through the API,
    until the deployment's cleanup window passes
    (`CLEANUP_DELETED_MEMORIES_RETENTION_DAYS`, default 30 days), not for a
    fixed 30 days. Server v0.66.0 made the window
    configurable. Fixed in `forget`, the README and
    `kagura-memory forget --help`.
  - `createContext`'s `embeddingModel` was called immutable. No API call
    changes it, but since server v0.66.0 an operator can migrate a
    context to another model.
  - `RecallOptions.filters` now lists every filter the server accepts,
    including `scope`, `importance`, `tags_normalize` (v0.65.0),
    `source_uri_prefix`, `source_type`, and the `near` / `within` geo
    filters (v0.54.0), and says when `tag_suggestions` comes back.
    `recall()` documents `degraded` and `degraded_reason` (v0.66.0). They
    mark a keyword-only fallback, where an empty result means the search was
    impaired, not that nothing is stored. Only a hybrid search (the
    default) falls back; `searchMode: "semantic"` still fails. In
    `getAgentBootstrap` a keyword-only recall sets both
    `components.recall.degraded` and the envelope's `degraded`, and
    `degraded_reason` tells it apart from a failed component.
  - The `Edge` doc named three edge types the server does not have
    (`semantic_similarity`, `declared_link`, `tag_cooccurrence`) and left
    out four it does. It now lists the server's eight. The test fixture
    that used `semantic_similarity` uses `related_to` now.
  - `rollbackSleepRun` accepts a `degraded` run as well as a `completed`
    one.
  - The per-memory binding filters, `allowed_memory_types` and
    `allowed_source_types`, were described as reserved and always `null`.
    Server v0.51.0 enforces them. The docs now say so, and say that no
    typed option sets them yet.
  - `TagInfo` said MCP `recall` fills `sample_summary` in `related_tags`.
    Since server v0.73.0 those items carry only `tag` and `count`.
  - `SecretValueResponse.ciphertext` stays typed `string` even though the
    server's schema allows `null`. That `null` is reserved for an offload
    that no write path uses yet, and the doc now says so.

## [0.8.1] - 2026-09-23

### Fixed

- **`recall({ useRerank: false })` now turns reranking off instead of being
  dropped**
  ([#37](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/37)):
  since memory-cloud v0.69.0 `use_rerank` has three states: omitted follows
  the context's search config, `false` forces reranking off, and `true` asks
  for it but still needs the context to allow it. The SDK only ever sent
  `true`, so a `false` never reached the wire, and on a context whose search
  config enables reranking the server reranked anyway — the opposite of what
  the caller asked for, paid for in reranker latency and quota, with results
  in a different order than the caller expected.

  `use_rerank` is now sent whenever `useRerank` is not `undefined`, `false`
  included. Leaving it `undefined` still omits it, which is what "follow the
  context default" means. With `contextIds`, the first listed context's
  search config is the one that decides. Against a server older than
  v0.69.0 nothing changes: there an omitted value already meant `false`.
  The Python SDK gets the same fix for `use_rerank=False` (python-sdk#251).

- **An MCP URL with a query broke every REST call**
  ([#38](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/38)):
  server v0.73 reads `?profile=` and `?tools=` off the MCP URL (v0.74 adds
  `?guardrails=`), but a query sitting directly on `/mcp`
  (`https://memory.kagura-ai.com/mcp?profile=core`) was not taken as the end
  of that segment, so the whole URL became the REST base and
  `getServerInfo()` requested `…/mcp?profile=core/api/v1/system/info`. MCP
  tool calls kept working, which hid it; the REST methods on `KaguraClient`,
  every `fromMcpUrl` client and the `login()` device flow did not. The query
  and fragment are now dropped before `/mcp` is stripped, and dropped from a
  URL with no `/mcp` segment too, since they configure the MCP endpoint and
  never the REST API. The MCP URL itself keeps its query, and URLs without
  one derive the same base as before, except that a host literally named
  `mcp` (`https://mcp/mcp`) no longer reads as a `/mcp` segment.

- **A long-lived `KaguraClient` recovers when a server drops its MCP
  session**
  ([#39](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/39)):
  MCP Streamable HTTP requires a server to answer a request naming a session
  it no longer holds with HTTP 404, and the client to send a new
  `initialize`. The server keeps `initialize`-based sessions in memory and
  drops them after an idle hour and on every restart. The client cached the
  session id until `close()`, so against a server that enforces that 404, a
  server process, bot or agent loop that sat idle for an hour or lived
  through a deploy would fail every MCP call from then on with a bare
  `HTTP 404` — which gave no hint that a new client would fix it. A 404 on
  a request that carried a session id now re-opens the session and retries
  the request exactly once; the server rejects the request before dispatch,
  so the retry is safe even for a write. If the retry 404s too, the
  `KaguraConnectionError` says the session expired and the client
  re-initialized once. A 404 on `initialize` itself is not retried, and
  neither is a 404 `-32601` Method-not-found, which is not about the
  session. The currently deployed server (v0.75.0) re-adopts an unknown
  session id instead of answering 404, so against it the recovery never
  fires; it is there for a server that enforces the spec. `close()` during
  an in-flight `initialize` now also wins: the interrupted handshake serves
  only the calls already waiting on it, and the next call opens a fresh
  session.

- **Concurrent calls share one `initialize`.** Calls that found no session
  at the same moment each sent their own handshake, so N parallel first
  calls opened N sessions and kept whichever answered last. They now wait
  on one in-flight `initialize` — on first use, and again when they all hit
  the same expired session. A call whose 404 lands after another call has
  already re-opened the session keeps that session instead of discarding
  it. A failed handshake is not cached: every waiter gets the error and the
  next call tries again.

- **JSON-RPC error bodies carry the server's message.** The MCP transport
  answers a request it rejects before dispatch with a JSON-RPC `error` body
  rather than a `detail` envelope, and the shared error extractor did not
  read that shape, so such an error surfaced as a bare `HTTP <status>`. It
  now ends with the body's `error.message`: a session that stays expired
  across the retry reads `MCP session expired; the client re-initialized
  once and the retry still got HTTP 404: MCP session not found or expired.
  …`. The extractor is shared, so a REST client that meets the same shape
  (from a proxy, say) shows it too; memory-cloud's REST routes never send
  it.

- **`getMemoryStats()` no longer fails with HTTP 400 when called with its
  defaults**
  ([#46](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/46)):
  it sent `sort_by=use_count`, a field memory-cloud
  v0.34.0 (#1046) dropped; the server rejects any sort field outside
  `access_count`, `reference_count`, `importance`, `created_at` and
  `last_used_at`. The default is now `access_count`, the server's own. The
  five fields are exported as `MemoryStatsSortField` and offered as
  completions for `sortBy`, which still takes any `string`.
  `MemoryStatItem` gains an optional `reference_count` (sent by server
  v0.34.0+), and `use_count`, which those servers no longer send, becomes
  optional and deprecated — code that assigns `item.use_count` to a `number`
  now needs a fallback.

## [0.8.0] - 2026-08-01

### Added

- **The `kagura-memory` bin now mirrors the Python `kagura` CLI** — 17 of its
  19 top-level commands, 58 subcommands, up from the five `auth` ones 0.7.0
  shipped. Same subcommand names, same flags and short forms, same JSON on
  stdout, same exit codes (2 for a usage error, 1 for a runtime failure).

  `auth` (now with `list` and `token`), `config show`, `context` +
  `contexts`, `remember`, `recall`, `reference`, `forget`, `update-memory`,
  `explore`, `edge`, `sleep`, `files`, `resource` (including the nested
  `resource tokens` CRUD), `secret`, `doctor`, and `setup claude`.

  Ported from the Python **source**, not its `--help`: help output omits the
  output format and the exit codes, and the version installed here (0.35.0)
  predated the source tree (0.38.0), so it was missing flags that exist —
  `remember --details` and `--location` among them.

- **Output parity was measured, not assumed.** `JSON.stringify(x, null, 2)`
  and `json.dumps(x, indent=2, ensure_ascii=False)` were compared
  byte-for-byte over Japanese text, an em dash, an emoji, an astral-plane
  character, escapes, control characters, nested empty containers, `null`
  and booleans: identical. Three numeric shapes differ and cannot be
  reconciled because they are language-level rather than formatting choices
  — Python `1.0` vs JS `1`, `1e-07` vs `1e-7`, and integers past 2^53, the
  last of which is a property of `JSON.parse` and so of the whole SDK.

- **A per-command flag spec.** Each command declares its own options, so a
  flag that is real elsewhere is still *rejected* here: `recall
  --read-only` is an error rather than a silently ignored switch. The parser
  also learned registered short flags (`-c`, `-m`, `-k`), `-vvv` counts,
  repeatable options (click's `multiple=True`), and short-only options —
  `-k` has no `--k` long form in Python, so it has none here.

- **An RFC 4180 CSV reader** for `resource import`, because Python leans on
  `csv.DictReader` and Node has no equivalent. Quoted fields, `""` escapes,
  embedded commas and newlines, CRLF. A `line.split(",")` would silently
  corrupt any row containing a quoted comma, which is most real exports.

### Fixed

Everything below was caught by review of this release's own diff before it
shipped: an adversarial pass (eight confirmed, one refuted) plus five rounds
of Copilot on the PR (nine findings).

- **REST commands sent credentials to the wrong host and failed for OAuth
  users.** `files`, `resource` and `secret` bare-constructed their clients,
  which never runs the credential chain and never stamps the MCP URL. Three
  consequences: every one of them threw for anyone who authenticated with
  `auth login` rather than a static key; `resource setup` was unusable on
  every invocation; and a self-hosted operator's requests went to
  `https://memory.kagura-ai.com` **carrying their API key** instead of to
  their own server. They now go through `fromMcpUrl`, passing no URL so
  each resolver branch pairs its credential with its own — which is what
  Python does, and why an OAuth profile bound to a non-default server now
  reaches the right host.

- **`secret exec` handed the age private key to the child process.**
  `--as ENV=name` is a scoping mechanism, but the child inherited the whole
  environment including `KAGURA_AGE_IDENTITY` — the key that decrypts every
  *other* secret in the workspace. A vendor tool given one credential got
  the means to read them all. The identity variables are now stripped from
  the child. Python has no such exposure because it reads the key from the
  OS keychain, so nothing is in the environment to inherit.

- **`secret exec` rejected the child's own flags.**
  `secret exec --as A=s -- ls -la` failed with `Unknown option: -la`. Click
  sets `ignore_unknown_options` and `allow_interspersed_args=False` on that
  command for exactly this reason.

- **`resource import` sent every row in one request.** The endpoint accepts
  1-100 events and Python chunks at 100, so any file over 100 rows was
  rejected wholesale. Now chunked, with Python's `{created, failed, total}`
  aggregate rather than a per-batch array — a script must not parse a
  different shape for 99 rows than for 101.

- **`--id-column` fell back to the row number when the column was absent.**
  A typo in the column name imported every row under doc_id `1`, `2`, … and
  reported success; re-running with the name spelled right would then
  insert them all a second time under different ids.

- **Files holding credentials were written world-readable.** `setup claude`
  wrote `.kagura.json` and `.mcp.json` at the umask default, and
  `secret get -o` left plaintext in a pre-existing file at its old mode
  until a later chmod. Both are now 0600 before any bytes land in them, and
  the secret path opens with `O_NOFOLLOW`. `secret get -o` writes raw bytes
  too, so a binary secret is no longer corrupted by U+FFFD substitution.

- **`secret get --output` could truncate the secret.** `fs.writeSync` returns
  the byte count and may be short; nothing checked it, so a partial write
  would have left a silently truncated credential on disk.

- **`--` was not an end-of-options marker.** It was passed through as an
  ordinary positional, so it neither terminated option parsing nor
  disappeared: `recall -- -5` reported `Unknown option: -5`, and there was
  no way to pass a value beginning with a dash. Click terminates parsing
  there on every command.

- **Smaller ones**: `resource ingest --importance abc` sent `null`
  (`Number.parseFloat` yields NaN, which survives an `!== undefined` guard);
  `resource tokens update 42` with no options sent an empty PATCH and exited
  0; `files upload --remember` built its MCP client without `mcp_url`, so
  the upload landed on the configured server and the memory did not; and
  `quote()` claimed to be Python's `repr()` while escaping neither
  backslashes nor control characters, so a Windows path lost its separators
  in error messages and a newline split them across lines.

- **Negative numbers were unreachable as option values.** The parser read
  every dash-prefixed token as "value missing", so `--bm25 -0.1`,
  `--limit -5` and `--min-weight -1` could not be passed. Measured against
  the real Python CLI, which parses them as values. Click is laxer still —
  it consumes whatever follows, so `--reranker -x` sets the value to `-x` —
  but that turns a typo into a silent wrong value, so only the numeric case
  changed; `--profile -h` still reads as "help", not a profile named `-h`.

### Changed

- **Errors now carry click's `Error: ` prefix.** The `auth` commands printed
  a bare message while Python raises `ClickException` there too, which
  renders as `Error: …`. Unifying was the only option that did not leave one
  group spelling failure differently from the other 16. Stderr text only;
  exit codes are unchanged.

### Notes

- **`ingest` and `process` are not ported.** The first needs the
  text-extraction pipeline (PDF, Office, EPUB, audio) plus LLM providers;
  the second needs the litellm-backed agent. Neither exists in this package
  and both would cost the zero-dependency promise. Use the Python CLI.

- **Three deliberate divergences**, each commented where it lives:

  - `config show` does not reproduce Python's mask
    (`key[:8] + "..." + key[-4:]`), whose halves overlap below 12
    characters and render `"abc"` as `"abc...abc"` — printing the whole
    secret twice. A mask that echoes its input is not a mask.
  - `secret` key custody reads the age identity from `KAGURA_AGE_IDENTITY`
    or `KAGURA_AGE_IDENTITY_FILE` and fails closed when neither is set.
    Python uses the OS keychain via `keyring`; Node has no zero-dependency
    equivalent, and `secrets/keyManager.ts` already rejected both a native
    dependency and a plaintext file. **A key custodied by the Python CLI is
    not readable here, and vice versa.**
  - `setup claude --profile` reports that the OAuth path needs Python's
    `kagura-mcp` stdio proxy instead of writing an `.mcp.json` that names a
    binary this package does not install. The `--api-key` path works.

## [0.7.0] - 2026-07-30

### Added

- **`SecretClient` — the zero-knowledge secret store**
  ([#28](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/28)):
  the fourth REST client, and the only member of the
  Files/Resource/Workspace/Secret set that was never ported. The comment on
  `KaguraRestClient` had been naming it as a sibling since 0.1.0 while
  nothing implemented it.

  Full surface: the pubkey registry (`registerPubkey`, `listPubkeys`,
  `listMyPubkeys`, `approvePubkey`, `revokePubkey`), secrets (`putSecret`,
  `putSecretForRecipients`, `listSecrets`, `fetchSecret`, `revokeGrant`,
  `deleteSecret`), and `verifyAudit`. `putSecretForRecipients` enforces the
  server's grant-consistency invariant client-side — every recipient must be
  `active` and must carry a fingerprint matching its own pubkey — and derives
  `recipients_snapshot` and `grant_pubkey_ids` from one list so they agree by
  construction instead of by the caller's care. 403 is mapped to a message
  naming all three of its causes, because the server answers 403 rather than
  404 precisely so the response cannot confirm a secret exists.

- **age crypto behind an optional peer dependency**: `generateKeypair`,
  `recipientFromIdentity`, `fingerprint`, `armorEncode`/`armorDecode`,
  `encrypt`, `decrypt`. Crypto is delegated to
  [`age-encryption`](https://www.npmjs.com/package/age-encryption) (typage,
  by age's author — the counterpart of the `pyrage` binding Python uses),
  declared as an **optional** peer dependency and imported lazily. A plain
  `npm install kagura-memory` still installs nothing; zero runtime
  dependencies stays true, matching how Python gates the same code behind its
  `[secret]` extra. Calling a crypto function without the package raises
  `KaguraCryptoError` naming the install command.

  Interoperability with the Python SDK is verified, not assumed: checked-in
  vectors prove this SDK decrypts pyrage-written ciphertext (grease stanza
  included), derives the same recipient from an identity, computes the same
  fingerprint, and armors byte-identically.

  One divergence was necessary. Recipients are X25519-only in both SDKs, but
  Python gets that from `pyrage.x25519.Recipient.from_str` rejecting anything
  else one line after its regex, while `age-encryption`'s `addRecipient`
  *accepts* `age1pq1…` and `age1tag1…`. Copying Python's regex would have let
  a TypeScript caller write ciphertext the Python CLI could never open, so
  `RECIPIENT_RE` is tightened to bech32's alphabet — which excludes `1`, and
  every non-X25519 form carries a second `1`.

- **`KeyManager` and the `KeyStore` interface** for age private-key custody,
  keyed as `identity:{profile}` exactly as Python keys it, so a shared
  backend interoperates. No default backend ships: Node has no stdlib
  keychain and every option is a native module, so a default would mean
  either a native runtime dependency or the plaintext file Python explicitly
  refuses. Requiring a store keeps custody fail-closed with no insecure
  fallback to reach by accident.

- **`KaguraClient.callRawTool(name, args)`** — call any MCP tool by name.
  `callTool` is private, so before this a tool with no typed wrapper was
  unreachable: `secret_*` was exactly that, and the only workarounds were
  vendoring a patched SDK or hand-rolling JSON-RPC. Typed wrappers remain the
  surface to prefer; this makes the next gap a detour rather than a dead end.

- `KaguraSecretError`, `KaguraCryptoError`, `KaguraKeyCustodyError` — the
  same three-level hierarchy as Python's, so a contract violation is
  catchable separately from a transport failure.

- CI now asserts both halves of "optional": that a bare install of the packed
  tarball has no `age-encryption` and still gives an actionable error, and
  that the crypto round-trips from **both** the ESM and CJS builds once it is
  installed. The CJS half matters because `age-encryption` is ESM-only and
  reached through a native dynamic `import()`; a bundler change that rewrote
  it to `require()` would fail only in the published artifact.

  `npm run test:no-webcrypto` runs the whole suite with `globalThis.crypto`
  deleted — Node 18's world, where WebCrypto is not yet a global. That
  condition broke encryption and keygen while leaving decryption working, an
  asymmetry only one leg of the CI matrix could see; it now reproduces on any
  Node version, locally and in `prepublishOnly`. The SDK installs
  `node:crypto`'s `webcrypto` itself when nothing is there, so
  `engines.node >= 18` stays honest.

### Security

- **A malformed age identity no longer leaks the private key into error
  messages.** `@scure/base`, under `age-encryption`, puts the entire
  offending string in its bech32 errors (`Invalid checksum in
  AGE-SECRET-KEY-1…: expected "…"`). Both `decrypt()` and
  `recipientFromIdentity()` interpolated that into their message and attached
  it as `cause`, which Node prints whenever an error is logged — so a
  single-character typo in a stored identity wrote a reconstructable private
  key to logs, CI output, and any crash reporter. Now a fixed message with no
  interpolation and no cause chain.

  TypeScript-only: `pyrage` answers `invalid Bech32 encoding` and echoes
  nothing, so the Python port is unaffected.

- **`deleteSecret` rejects names that would retarget the request.** `.` and
  `..` are RFC 3986 *unreserved*, so percent-encoding leaves them intact and
  the URL parser then resolves them away:
  `deleteSecret("cloudflare/../openai")` issued
  `DELETE /api/v1/config/secrets/openai`, and `deleteSecret("..")` issued
  `DELETE /api/v1/config/`. On a destructive owner-only operation that is
  worth refusing outright — an empty, `.`, or `..` segment now throws
  `KaguraSecretError` before any request. Dots *inside* a segment
  (`cloudflare/api.token`, `a..b`) are still fine.

  The Python SDK has the same hole (`quote(".", safe="") === "."`) and wants
  the same guard.

## [0.6.0] - 2026-07-28

### Added

- **`RecallOptions.includeSuperseded`**
  ([#25](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/25)):
  `remember({ supersedes })` shipped in 0.5.0 without its read side. The
  whole argument for a supersede edge over `forget()` + `remember()` is
  that history survives — but nothing could ask for it back, so it was
  reachable only by a caller who had kept the old `memoryId`, which is the
  bookkeeping the edge exists to remove. `RememberOptions.supersedes` even
  documented `recall({ includeSuperseded: true })`, an option that did not
  exist; `recall()` builds its arguments from an allowlist, so not even a
  cast got through. Same flag name as the Python SDK's `include_superseded`.

  A guard test now resolves every `` `method({ option })` `` promised in a
  `src/client.ts` doc comment against the option interface that method
  actually takes, so the next such promise fails the build instead of a
  release.

## [0.5.0] - 2026-07-28

> Supersedes 0.4.0, which reached `main` but was never tagged or published
> to npm. Everything that would have been 0.4.0 ships here, so the jump
> from 0.3.0 is a single release.

### Fixed

- **Refreshing a profile with no refresh token no longer round-trips**
  ([#14](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/14)):
  such a profile cannot be refreshed, but the SDK went to the network
  anyway and surfaced the server's `invalid_grant` as "refresh token is no
  longer valid" — describing a token that never existed. Now raises
  `KaguraAuthExpiredError` before the request, naming the real cause.
  Fixed in lockstep with the Python SDK, which shares this credentials
  file and had the same defect (python-sdk#249).

### Added

- **`npx kagura-memory auth …` — an `auth`-only CLI**
  ([#17](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/17)):
  `login`, `refresh`, `status`, `use`, `logout`, with the same flag names
  as the Python CLI's `kagura auth …` and writing the same
  `~/.kagura/credentials.json`. A TypeScript-only team no longer needs a
  Python install just to authenticate a machine.

  Scope is deliberately `auth` only — memory operations stay library-only.
  The credentials file is the artifact both SDKs share, so converging
  there is the point; duplicating the rest of the CLI surface would only
  multiply parity drift.

  Zero runtime dependencies is preserved: argv parsing is hand-rolled, and
  the browser launch shells out to the platform opener. The device code
  and URL are printed unconditionally *before* any launch attempt, so a
  silent or failed browser never leaves the user stuck. `--no-browser`
  suppresses the launch; a non-interactive stdin declines destructive
  prompts rather than hanging, with `--yes` as the explicit opt-in.

- **`refresh()` — explicit profile refresh**
  ([#16](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/16)):
  clients already auto-refresh near expiry, but nothing reachable could
  force a rotation, change scope, or refresh ahead of a long batch.
  `refreshAccessToken` (exported in 0.4.0) is the stateless RFC call and
  writes nothing, and `KaguraOAuth` — which refreshes *and* persists under
  the cross-process lock — was not exported at all. Same shape of gap as
  the login surface in 0.4.0.

  Scope narrowing goes through the refresh grant silently; widening is
  rejected by the server, so `refresh()` falls back to a full device flow
  for consent, matching the Python CLI's `kagura auth refresh --scope`.
  Diverging there would make scope changes behave differently between the
  two SDKs on the credentials file they share.

  Also exports `KaguraOAuth`, `withRefreshed`, `REFRESH_SKEW_SEC`, and the
  `SharedCredentialsState` type.

- **Interactive OAuth login**
  ([#9](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/9)):
  `login()` runs the RFC 8628 Device Authorization Grant end to end
  (authorize → hand the user code to the host app via `onUserCode` →
  poll → persist) and writes `~/.kagura/credentials.json` in exactly the
  format the Python CLI writes, so profiles stay interchangeable. A
  TypeScript-only consumer no longer needs the Python CLI to obtain
  credentials. No terminal IO and no browser launching inside the SDK.
  Nothing is written unless the exchange succeeds, so a failed login never
  disturbs an existing profile.

  Behaviour is aligned with `kagura auth login`, since both SDKs read and
  write the same file: scope defaults to `DEFAULT_SCOPE`
  (`"memory:read memory:write"`) with `READ_ONLY_SCOPE` as the opt-down,
  the new profile does not steal an existing default, and a response with
  no `refresh_token` warns and still persists rather than failing — the
  Python CLI models a non-refreshable profile as a valid degraded state.

  The underlying primitives — `authorizeDevice`, `pollForToken`,
  `refreshAccessToken`, `revokeToken`, `DEFAULT_CLIENT_ID`, the grant-type
  constants — and the credentials store (`loadCredentialsFile`,
  `saveCredentialsFile`, `updateProfile`, `setProfile`, `getProfile`,
  `removeProfile`, `deleteProfile`, `setDefaultProfile`,
  `deleteCredentialsFile`, `defaultCredentialsPath`,
  `emptyCredentialsFile`, `isExpired`) are now exported as well. They
  existed since 0.1.0 but were unreachable — `src/index.ts` re-exported
  neither module.

- **`KaguraClient.recallNearby()`** — the WHERE axis
  ([#5](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/5),
  server origin memory-cloud#1331): a deterministic spatial query over
  `details.location`, nearest first with `distance_m`, mirroring
  `recallUpcoming`. Args `contextId, lat, lon, radiusM = 1000, k = 20`.
  Out-of-range or non-finite coordinates throw locally rather than
  round-tripping to an HTTP 422. Returns a typed `RecallNearbyResponse`
  (following `listTags`, not `recallUpcoming`'s bare `ToolResult`, so
  `distance_m` is reachable without a cast). New model types
  `MemoryLocation`, `NearbyMemory`, `RecallNearbyResponse`.

- **`RememberOptions.supersedes`**
  ([#7](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/7)):
  declare a memory as the newer version of an existing one. The old
  memory is shadowed out of default recall but stays restorable and
  reachable via `recall({ includeSuperseded: true })` and `explore()` —
  unlike `forget()` + `remember()`, which destroys the history.

- **`UpdateMemoryOptions.details`**
  ([#6](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/6)):
  `details` could previously only be written by `remember()`, which left
  the `externalId` upsert path unable to carry it. Note the server
  replaces `details` wholesale — round-trip keys you want to keep.

- **`ListTagsOptions.withTags`**
  ([#8](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/8),
  server origin memory-cloud#830): multi-tag AND drill-down mapped to the
  `with_tags` parameter, for server-side faceted browsing. An empty array
  is a no-op filter and is not sent.

## [0.3.0] - 2026-07-16

### Removed

- **Breaking:** the v0.36-era `KaguraAgent` session-analysis model types
  (`Message`, `Artifact`, `Session`, `MemoryInfo`, `Memory`, `LLMUsage`,
  `MemoryToStore`, `RecallQuery`, `AnalysisResult`, `ExploredMemory`,
  `ProcessResult`). The Python SDK removed the actor and its models in
  v0.37.0 (python-sdk#233 — the actor role lives in the
  [kagura-agent](https://pypi.org/project/kagura-agent/) package); this
  SDK never ported the actor, so the types were dead exports with no
  consumers.

## [0.2.0] - 2026-07-16

### Added

- **Agent control plane** (RFC-0002 P0, memory-cloud **v0.49.0+**;
  [#1](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/1)/
  [#2](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/2)/
  [#3](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/3)):
  - Agent Registry wrappers on `KaguraClient` — `registerAgent`,
    `listAgents`, `getAgent`, `updateAgent` (with the `status`
    kill-switch and `enforcementMode` ramp), `deleteAgent`
    (owner/admin-gated; delete cascades agent-bound API keys).
  - Subtractive context bindings — `bindAgentContext`,
    `listAgentBindings`, `updateAgentBinding`, `unbindAgentContext`
    (`canRead` / `writePolicy` `deny|direct` / `isDefault`;
    `allowedMemoryTypes`/`allowedSourceTypes` reserved for
    memory-cloud#1286).
  - `KaguraClient.getAgentBootstrap()` — one session-start call composing
    context guide + pinned + trusted-only recall + upcoming time memories
    + agent state, fail-soft per component with a `degraded` flag.
  - `AgentsClient` — REST bootstrap fallback
    (`POST /api/v1/agents/{agent_id}/bootstrap`) for API-key-only callers
    such as agent-bound member keys.
  - `Agent`, `AgentBinding`, and `AgentBootstrap*` wire models;
    `agent_not_found`/`binding_not_found` now map to
    `KaguraNotFoundError`. `MIN_SERVER_VERSION` stays 0.17.1 — only this
    surface needs the newer server.

## [0.1.0] - 2026-07-05

Initial release — a TypeScript port of the
[Python SDK](https://github.com/kagura-ai/kagura-memory-python-sdk) core.

### Added

- `KaguraClient` — MCP (JSON-RPC) memory operations: remember, recall,
  explore, reference, forget, and REST GETs.
- `ResourceClient` — REST ingestion of external events (resource tokens).
- `FilesClient` — R2 file uploads with sha256 integrity binding.
- `WorkspaceClient` — workspace members, invitations, and API key management.
- Auth resolution mirroring the Python SDK: explicit `apiKey` >
  `KAGURA_API_KEY` > OAuth profile (`~/.kagura/credentials.json`, shared with
  the Python CLI, with auto-refresh) > `.kagura.json`.
- Typed error hierarchy under `KaguraError` (auth, not-found, rate-limit,
  quota, connection).
- Dual ESM + CJS builds with bundled `.d.ts`; zero runtime dependencies;
  Node.js >= 18.

[Unreleased]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.17.0...HEAD
[0.17.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.14.1...v0.15.0
[0.14.1]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.3.0...v0.5.0
[0.3.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/releases/tag/v0.1.0
