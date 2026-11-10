# SDK ↔ memory-cloud Compatibility

## 0.18.0

**Min memory-cloud:** 0.75.0 — checked against memory-cloud up to **0.144.0** (parity target: the Python SDK and CLI 0.44.0, checked up to 0.142.0).

### Event dates (#137)

`listMatching({ orderBy: "event_start" })` (and `kagura-memory list --order-by
event_start`), `recall`'s `eventAfter` / `eventBefore` and the `event_after` /
`event_before` keys of `listMatching`'s `filters` need memory-cloud **0.152.0**
([memory-cloud#2722](https://github.com/kagura-ai/memory-cloud/issues/2722),
[#2724](https://github.com/kagura-ai/memory-cloud/issues/2724)). `event_after`
is inclusive and `event_before` exclusive; a memory matches when its event range
(`details.event_start` / `event_end`) overlaps the window, and a memory without
an event date never matches. A datetime `event_after` counts as its UTC day and
a datetime `event_before` past midnight as the day after it. Memories without
an event date sort last under `event_start`, in both directions. Both are
sent only when set. `eventAfter` / `eventBefore` go in `filters`, a free-form
object, so a server before 0.152.0 ignores them and filters nothing. A
deployment upgraded from an earlier version gets the Qdrant payload indexes for
`event_start` / `event_end` only from 0.152.1
([memory-cloud#2729](https://github.com/kagura-ai/memory-cloud/issues/2729)).
Python SDK/CLI 0.44.0 and 0.45.x have no event options; `list --order-by` here
accepts `event_start`, which Python's `--order-by` refuses. The typed response
fields (`event_start`, `event_end`, `event_weekday`, `observed_weekday`,
`event_unresolved`) are not modelled; they pass through at runtime.

### Files list filters (#138)

`FilesClient.list({ scope, bindingContextId })` and `kagura-memory files list
--scope [all|workspace] --binding-context-id ID` need memory-cloud **0.145.0**
([memory-cloud#2632](https://github.com/kagura-ai/memory-cloud/issues/2632)).
`scope` is `all` (the default: the unchanged listing) or `workspace` (only
workspace-shared files, those bound to no context); `bindingContextId` is the
wire `context_id`, intersected with the caller's accessible contexts before the
limit. `scope: "workspace"` together with `bindingContextId` is a 422 on the
server and is refused before the request here. Both are sent only when set.
**A server before 0.145.0 ignores query parameters it does not know, as it
ignores `cursor`, and returns the unfiltered listing; the caller cannot tell
from the reply that the filter was not applied.** Python SDK/CLI 0.44.0 and
0.45.x have no `files list` filters.

### Plugin `server_url` keeps `context=` (#139)

The default-context line of the kagura-memory plugin's SessionStart hook needs
memory-cloud **0.149.0** and the plugin of that release
([memory-cloud#2690](https://github.com/kagura-ai/memory-cloud/issues/2690)):
the hook prints it only when the first `context=` of the plugin's `server_url`
is its `context_id`, compared as UUIDs in any case, and prints nothing
otherwise. `setup claude` therefore keeps `context=<id>` in the `server_url` it
prints when the MCP URL's first `context=` is the context it prints as
`context_id`, written lower-case and dashed, before `guardrails=off`
(`profile`, `add_tools`, `tools` and `guardrails=<context-id>` are still
dropped). With no `-c`, a context that is not a UUID, or a `context=` naming
another context, the printed URL is what it was. A plugin before 0.149.0 does
not read `context=`. This follows the plugin's own setup guide (`context=` must
stay when the MCP URL carries it and it is the plugin's context); Python SDK
0.45.1's `_plugin_server_url` still drops `context=`, a documented difference,
not a Python port.

### CLI help pages

`list --help` and `files list --help` no longer match Python 0.44.0 (the
`--order-by` choice names `event_start`; the two new `files list` options) and
are recorded in [the exception fixture](../test/cli/typescriptHelp111.json).
Of the 94 supported help pages, 48 now match Python and 46 retain a documented
difference (the 0.17.0 counts were 50 and 44).

## 0.17.0

**Min memory-cloud:** 0.75.0 — checked against memory-cloud up to **0.144.0** (parity target: the Python SDK and CLI 0.44.0, checked up to 0.142.0).

The SDK, CLI and MCPB require Node.js >=22.12.0. CI tests the exact floor and Node 22/24, including strict installation of the packaged SDK.

### Member context access (#121)

The owner-key workspace member add, context-access GET/PUT and session-based
context member add follow the [memory-cloud v0.144.0 routes](https://github.com/kagura-ai/memory-cloud/tree/v0.144.0/backend/src/api/routes).
New request fields are omitted unless supplied. A deployment can disable owner-key
management; a key bound to another workspace receives the server's uniform 404.
Python SDK/CLI v0.44.0 does not expose these APIs. The Python port is tracked in
[python-sdk#326](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/326).
The TypeScript SDK exposes these calls as library methods.

### CLI presentation parity (#111)

The common help renderer follows Python SDK 0.44.0 with Click 8.3.3 at an
explicit width of 80 columns: wrapped option descriptions, a maximum
30-character label column, numeric range metavars and annotations, required
markers, and abbreviated group summaries. Range bounds are declared once for
both validation and help. Terminal width is fixed; unlike Click's terminal
auto-detection, resizing the terminal does not change this CLI's output.

All 94 supported command/group/root help pages are recorded and checked.
50 match Python after replacing the executable name **before** wrapping;
44 retain existing command descriptions or SDK-specific surfaces. The
[complete per-command difference list](cli-help-differences.md) names the
affected options and links the exact outputs. Python's optional root `ingest`
command is not implemented. Separate positive/negative switch help rows,
default wording and the Node setup/auth/secret descriptions remain documented
differences; this release does not claim identical help for those pages.

Usage errors now print `Usage: …`, `Try '… --help' for help.`, a blank line,
and `Error: …`, without the full help page. This includes `resource import`
and `resource ingest-batch` file-open failures. As in Click 8.3.3,
`BadOptionUsage` errors (a missing option value or a value on a switch)
have no command context and print only `Error: …`. Tests replay full stderr,
stdout and exit codes with `test/pythonDumpHarness.ts`.

Remaining invocation/error differences are intentional and unchanged:

- This bin is `kagura-memory`, accepts `-h`, root `help`, and the existing bare
  auth aliases. Python uses `kagura` and normally only `--help`.
- Auth flags marked `rejectEmpty` reject empty profile/server/scope values.
  `--invite` on an auth command other than `login` gives an explicit login-only
  hint and never echoes the token, rather than Python's unknown-option text.
- Mutually exclusive flag pairs (for example `--rerank --no-rerank`, context
  lock/unlock, and auth scope/read-only) are rejected where Python may keep the
  last switch. `secret exec` rejects an unknown flag before the child name
  unless help was requested; Python treats it as the child command.
- Native JSON parser diagnostics, local filesystem/OS errors, and SDK-specific
  setup/auth validation retain JavaScript/Node wording. Missing-file comparison
  uses the same normalized message; other OS-specific failures can differ.
  Setup's unsupported Python hooks/process forms are described in its help.
- Integers that cannot be sent exactly as a JavaScript number and non-finite
  JSON numbers are refused locally; their messages differ from Python's
  arbitrary-precision/non-finite handling. Existing command validation order
  and SDK-specific error hints are not changed by the shared formatter.

The Python fixtures can be regenerated from the repository root with
`uv run --no-project --isolated --with "kagura-memory[secret]==0.44.0" --with click==8.3.3 python test/cli/recordClick111.py`.

## 0.16.0

**Min memory-cloud:** 0.75.0 — checked against memory-cloud up to
**0.143.0** (parity target: the Python SDK and CLI 0.44.0, checked up to
0.142.0). No new server surface is introduced. Node.js >=20.19.0 remains
supported.

This release fixes existing authentication, error handling, response validation,
CLI behavior and Windows checkout reliability. Python parity remains 0.44.0;
the server floor remains 0.75.0 and Node.js remains >=20.19.0.

CLI-wide help wrapping/range labels and usage-error formatting (#111), the
Node 22/Vitest 5 migration (#115), and member context-access APIs (#121) are
deferred to v0.17.0. In particular, `sleep rollback --help` uses the corrected
Python text but retains the existing formatter's wrapping and column spacing;
its functional output, prompts and partial rollback dumps are checked exactly.

### Quota classification (#113)

The quota classifier matches Python SDK 0.44.0's `_http.gate_error`.
The REST status hooks keep their own mappings, so the HTTP status and entry
point also determine the exception class.

| Entry point and refusal | Error class |
| --- | --- |
| Shared gate classifier, `QUOTA-001` / `quota_exceeded` with `gate=quota`, a known tier `quota_type`, or an integer retry window | `KaguraQuotaError` |
| Shared gate classifier, those codes without any of those descriptors | `KaguraError` |
| Shared gate classifier, `QUOTA-002` / `CONNECTOR-001` | `KaguraQuotaError` |
| REST base client HTTP 429, with or without quota descriptors | `KaguraQuotaError` |
| REST base client HTTP 402, with or without quota descriptors | `KaguraConnectionError` |

All paths retain the server's `code`, `details`, `help`, and `correlationId`.
The Python reference is the
[`v0.44.0` source](https://github.com/kagura-ai/kagura-memory-python-sdk/tree/v0.44.0/src/kagura_memory).

### Credential concurrency and auth token (#112)

The credentials JSON format is unchanged, but concurrent writers must use
the same **portable lock-v1 protocol**. This SDK now exclusively creates
`credentials.json.lock-v1` (0600), holds it across read/refresh/save, and
removes only its own lock. It polls every 50 ms for at most 90 seconds using
a monotonic deadline. A lock is **never** broken because of its age: a paused
process can resume after any interval. A 30-second refresh deadline covers
both headers and body and aborts the transport; even a custom fetch that
ignores abort cannot keep the caller waiting indefinitely.

Python SDK **0.44.0** instead keeps an OS advisory lock on the persistent
`credentials.json.lock` inode. Older TypeScript clients use an incompatible
exclusive-create protocol on that same name. Neither may concurrently share
a credentials file with lock-v1 clients. This SDK detects an existing legacy
`.lock` and refuses writes rather than unlinking it; that check cannot prevent
an old client from starting later. The corresponding Python implementation,
cross-language tests, and eventual shared-support version are tracked in
[python-sdk#327](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/327).
No released Python shared-support floor is claimed yet.

**Migration and crash recovery:**

1. Stop every CLI, proxy, application and SDK process using this credentials
   file, including background clients. Upgrade all writers or give incompatible
   clients separate credential files. Do not restart old and new writers on
   the same file.
2. Once all users of the file are stopped, manually retire the legacy `.lock`
   marker (for example, move it aside). This SDK never removes it automatically.
   Python's marker persists even after a normal exit, so its presence alone
   does not prove a process is live.
3. A crashed lock-v1 owner leaves `.lock-v1` behind. Waiters time out and name
   that file. After confirming **all** clients are stopped, remove that
   abandoned lock and restart compatible clients. Neither mtime nor a guessed
   PID lifetime is sufficient reason to remove a lock while clients run.
4. Retain `credentials.json.revocations-v1`: it is logout history, not a lock.
   Deleting it can let a cached credential recreate a removed profile.

Logout writes an atomic 0600 revocation sidecar before deleting a profile or
the whole file. It contains only `{version: 1, all: boolean, profiles: string[]}`,
not tokens. A missing disk profile with a matching or all-profile revocation
cannot be refreshed from cached credentials. Existing disk profiles, explicit
login, and recovery from an unsaved refresh while the disk profile still
exists remain supported. An unreadable revocation record fails closed before
refreshing a missing profile. Both refresh-first and logout-first orderings
are tested. Scope-widening refresh waits for consent outside the lock, then
compares the original token pair under lock before saving; logout or another
profile replacement wins, and the obsolete grant is not cached as an unsaved
refresh. Explicit login can still recreate the profile.
**`deleteCredentialsFile()` is now asynchronous: use
`await deleteCredentialsFile(path)` and handle its failure.**

`auth token` now refreshes at the five-minute boundary and writes its absolute
expiry and human-readable remaining time to stderr, with only the token on
stdout. Fresh, near-expiry, expired and refresh-token-less outputs are recorded
from Python 0.44.0/Click 8.3.3 at a fixed clock in `test/cli/authToken112.json`.
Login pre-reads credentials before authorization and rechecks under lock on
save; no lock is held during user consent. A generic 401 preserves OAuth,
REST and JSON-RPC server error fields using the shared single-decode reader.
These changes introduce no server version requirement.

Which memory-cloud server each release of the `kagura-memory` npm package
needs, and the newest one it was checked against: one section per release,
newest first. Each surface newer than the SDK-wide floor carries its own
floor in the section of the release that added it. A new release adds its
section at the top, and the
[README](../README.md#relationship-to-the-python-sdk) names the current
parity target. The Python SDK keeps the same record for its own releases
in
[its `docs/compatibility.md`](https://github.com/kagura-ai/kagura-memory-python-sdk/blob/main/docs/compatibility.md).

`MIN_SERVER_VERSION` (exported from the package, defined in
`src/client.ts`) is **0.75.0**, the floor this SDK is tested against, and
it is **advisory**: no SDK method checks the server version before a call.
`KaguraClient.checkServerVersion()` reads `GET /api/v1/system/info` and,
for an older server, warns through the client's `warn` option (default
`console.warn`) and returns; it never throws because a version is old.
Two CLI commands do stop on an old server: `kagura-memory doctor` fails
one below `MIN_SERVER_VERSION` (`Version: 0.74.0 is below minimum
0.75.0`, exit 1), and `setup codex|hermes|openclaw --url-form --oauth`
stops (exit 1, nothing run or written) on a server below the 0.77.0 its
keyless entry needs, or one whose version it cannot confirm (see 0.14.0
below). `checkServerVersion()` and `doctor` read a version as the
Python SDK does: a `v` prefix and `+build` metadata are ignored, a
pre-release sorts below its release (`0.75.0-rc1` is below 0.75.0), and a
version that does not start with `MAJOR.MINOR.PATCH` (`0.75`,
`main-abc123`) is not compared, so nothing is logged and `doctor` reports
it as `info`. A mismatch therefore surfaces **at call time**, in one of
three ways: a tool the server does not have is a `KaguraError` ("tool not
found"); an argument a server before 0.82.0 does not know is ignored,
silently; and from 0.82.0
([memory-cloud#1742](https://github.com/kagura-ai/memory-cloud/issues/1742))
a server refuses an argument its tool schema does not declare with
`invalid_argument` (a `KaguraError` whose `code` is `"invalid_argument"`
and whose `details.unknown_arguments` names it). An option a caller can
set that is newer than 0.75.0 is sent only when the caller sets it, so a
call that does not use one is unaffected; the floors below say which
server a call that does use one needs. The few arguments the SDK and CLI
send unasked are listed below, with why each is safe on an older server.
A field a newer server adds to a reply is optional in the
types and read with the Python model's default, so an older server's reply
still reads.

**Why `MIN_SERVER_VERSION` stays 0.75.0 for 0.15.0**
([#93](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/93)).
The Python SDK keeps an advisory 0.17.1; this SDK raised its own to 0.75.0
in 0.9.0
([#43](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/43))
because its typed plan and quota errors read the `gate` field only 0.75.0
sends. Nothing in 0.15.0 needs a higher floor for the SDK as a whole.
Apart from the four sends below, each new method, option, flag, query key
and header is used only when the caller asks for it, and a server that
predates one ignores it (before 0.82.0) or refuses that one call (from
0.82.0; a query key or header is always ignored); the rest of the SDK
works on 0.75.0 as before. The four sends nobody asks for are each safe on
every server:

- `createContext`'s quota pre-check always asks `list_contexts` for
  `limit: 1`. `list_contexts` declares `limit` from 0.82.0, the release
  that starts refusing undeclared arguments, so a server either takes it
  (one row) or ignores it (every context, as before 0.15.0).
- `rollbackSession` always sends `dry_run`, `true` unless the caller
  passes `dryRun: false`. The tool declares it from the release that adds
  the tool (0.113.0); an older server answers "tool not found" whatever
  is sent.
- `setup claude`'s context-name lookup sends `name_contains` (0.73.0) and
  a `cursor` (0.82.0) only after a first page that says `has_more`, which
  only 0.82.0 and later send, so both reach only servers that declare
  them; the first page sends nothing new.
- `auth logout`, for a profile that holds both tokens, sends a second
  revoke request (the access token after the refresh token) with the same
  form body as the first (`token`, `client_id`). It is a REST route, not
  a tool, and carries no new field: 0.82.0 and later answer it with
  nothing left to revoke, an older server revokes the access token.

`getSleepReport` / `rollbackSleepRun` now send less (`report_id` alone).
Raising the floor to the newest surface (0.142.0) would only make
`checkServerVersion()` warn and `doctor` fail on every server where
everything but the newest surfaces works.

**Reading a section.** Its first paragraph, **Min memory-cloud**, is the
floor: the memory-cloud release the SDK as a whole needs
(`MIN_SERVER_VERSION`), the newest release that SDK release was checked
against ("checked against memory-cloud up to …", recorded from 0.14.0 on),
and, after "Per-surface", the newer release a method, option, CLI command
or flag needs. A floor holds from that SDK release on, and a surface a
newer section does not name keeps the floor an older section gave it. The
rest of the section is that release's notes, one paragraph per theme. A
bare version number is a memory-cloud release; SDK and Python SDK
releases are named as such.

## 0.15.0

**Min memory-cloud:** 0.75.0 — checked against memory-cloud up to
**0.143.0** (parity target: the Python SDK and CLI 0.44.0, checked up to
0.142.0). Per-surface: 0.78.0 the error envelope of a failed tool (`help`,
`serverCause`, `correlationId`, `retryable`, `outcome`; `code` and
`details` are read from every server), the device-flow refusals and
`reference({ contentOffset, detailsOffset, contextOffset, fields,
maxChars })`; 0.79.0 the scope 403
as `KaguraAuthError`; 0.82.0 `maxChars` (`recall`, `loadPinned`,
`loadGuardrails`, `getAgentBootstrap`, `AgentsClient.bootstrap`,
`getSleepReport`), `recallNearby({ includeDetails })`, the cursors and
page sizes (`listContexts({ cursor, limit })`, `getState({ cursor, limit,
maxChars })`, `getSleepReport({ actionsCursor, actionsLimit })`, `context
list --limit/--cursor`, `sleep report --actions-cursor/--actions-limit`),
the `listEdges` warning, `KaguraServiceUnavailableError` and the
`invalid_argument` refusal of an undeclared argument; 0.89.0 the
`akey_…` / `winv_…` ids in `mintMemberKey` and the CLI's key and
invitation readers; 0.93.0 `bootstrap`, `changesSince`, `listMatching`,
`rememberBatch`, `describeTools`, `guide`, `kagura-memory
bootstrap|changes|list`, `remember({ dedupe, tagsNormalize, verbose })`
and the `core` default tool listing; 0.94.0 a resource-list row with
`null` contexts; 0.99.0 `KaguraCapacityLockedError`; 0.108.0 `recall({
verbosity })` and `payload_too_large`; 0.110.0 `contentChunksEnabled`;
0.113.0 `expectedVersion`, `reference({ version })`, `listRevisions`,
`rollbackSession` and `changesSince({ sessionId })`; 0.114.0 `recall({
full })`, `?context=` (`setup claude --context`, `kagura-memory-mcp
--context`), `Kagura-Session-Id` (`kagura-memory-mcp --session-id`),
`changesSince({ byMe })` and the `rollbackSession` window; 0.115.0
`bootstrap({ format })`, a `bootstrap` `maxChars` below 10,000 and
`llmSelectorEnabled`; 0.117.0 `forget({ memoryIds })` / `forget --ids`;
0.126.0 `acceptSupersedeCandidate` and the permission model; 0.127.0
`observedAt`, `observedAfter` / `observedBefore` and `listMatching({
orderBy: "observed_at" })`; 0.129.0 `?add_tools=` (`--add-tools` on
`setup` and `kagura-memory-mcp`, `getGuardrailDigest({ addTools })`);
0.135.0 the `explore` opt-in for `explore_hints`; 0.137.0 `acceptance` on
`reference`; 0.138.0 `getSleepHistory({ source })` and the `edge_exists`
acceptance reason; 0.140.0 `addTags` / `removeTags` / `detailsPatch` and
the one-call `--merge-details`; 0.142.0 `plan_headroom`, `acceptance` on
recall rows and `not_writable` for a guardrail

**Checked against memory-cloud up to 0.143.0**
([#93](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/93),
with [#76](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/76)
and [#79](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/79)–[#92](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/92),
[#102](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/102)).
Per-surface floors are in the **Min memory-cloud** line; every other
surface keeps its floor from the sections below. memory-cloud 0.143.0
changes nothing a client sees (rotatable keys for stored secrets, runtime
and dev image targets,
[memory-cloud#2394](https://github.com/kagura-ai/memory-cloud/issues/2394),
[#2620](https://github.com/kagura-ai/memory-cloud/issues/2620)), so the
Python SDK 0.44.0, checked up to 0.142.0, is the parity target unchanged.

**Typed errors**
([#84](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/84);
[python-sdk#299](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/299)).
Every error built from a server body keeps the server's `code`, and the
rest of its envelope in `details`. From 0.78.0
([memory-cloud#1684](https://github.com/kagura-ai/memory-cloud/issues/1684))
a failed tool sends `help` and, for a server failure, `cause`
(`serverCause`), `correlation_id`, `retryable` and `outcome`; from 0.82.0
([memory-cloud#1742](https://github.com/kagura-ai/memory-cloud/issues/1742))
the `/mcp` transport's own JSON-RPC errors do too. On an older server they
read `null`. A 403 `insufficient_scope` is a `KaguraAuthError` naming the
scope (0.79.0,
[memory-cloud#1686](https://github.com/kagura-ai/memory-cloud/issues/1686);
an older server has no scopes). An HTTP 503 is a
`KaguraServiceUnavailableError`, a `KaguraConnectionError` subclass, with
`retryAfter` and `reason` (0.82.0; the REST `DB-002` reasons from 0.104.0,
[memory-cloud#1980](https://github.com/kagura-ai/memory-cloud/issues/1980),
`deadlock` from 0.105.0,
[memory-cloud#1985](https://github.com/kagura-ai/memory-cloud/issues/1985));
an older server's 503 is typed too, with whatever it sent. The Free
capacity lock is a `KaguraCapacityLockedError`, and `getUsage()` returns
`capacity_lock` (0.99.0,
[memory-cloud#1941](https://github.com/kagura-ai/memory-cloud/issues/1941);
`purge_at` on the REST usage route from 0.102.0,
[memory-cloud#1969](https://github.com/kagura-ai/memory-cloud/issues/1969)).
`FEAT-001` names `members` / `contexts` from 0.100.0
([memory-cloud#1943](https://github.com/kagura-ai/memory-cloud/issues/1943)).
`payload_too_large` (0.108.0,
[memory-cloud#2003](https://github.com/kagura-ai/memory-cloud/issues/2003))
replaces the untyped 1 MB refusal on MCP: a plain `KaguraError` with
`limit` / `actual` in `details`. The device flow reads an RFC 6749
`device/authorize` refusal as a coded `KaguraAuthError` (0.78.0,
[memory-cloud#1671](https://github.com/kagura-ai/memory-cloud/issues/1671))
and keeps polling on `temporarily_unavailable` (0.84.0,
[memory-cloud#1770](https://github.com/kagura-ai/memory-cloud/issues/1770)).
`kagura-memory doctor` warns about a static key without the `kagura_`
prefix, which 0.119.0 and later route as an OAuth token
([memory-cloud#1994](https://github.com/kagura-ai/memory-cloud/issues/1994));
the check is client-side, so it shows on every server. No new argument is
sent here, so no server refuses or ignores anything new.

**Recall shape**
([#82](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/82);
[python-sdk#298](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/298)).
From 0.108.0 a hit is compact by default
([memory-cloud#2002](https://github.com/kagura-ai/memory-cloud/issues/2002)):
a 160-character summary head without `tags`, `context_summary` or
`scope`. Compact rows carry `created_at` from 0.108.0, and full rows
`version` from 0.113.0
([memory-cloud#2043](https://github.com/kagura-ai/memory-cloud/issues/2043)).
From 0.114.0 the top hits on MCP also carry `content`
([memory-cloud#2124](https://github.com/kagura-ai/memory-cloud/issues/2124));
from 0.115.0 the deployment sets how many (`MCP_RECALL_DEFAULT_FULL`, 3)
and rows may carry `selector` / `spans`
([memory-cloud#2140](https://github.com/kagura-ai/memory-cloud/issues/2140),
[#2144](https://github.com/kagura-ai/memory-cloud/issues/2144)).
`recall({ verbosity, full, maxChars })` asks for another shape: `maxChars`
needs 0.82.0
([memory-cloud#1743](https://github.com/kagura-ai/memory-cloud/issues/1743)),
`verbosity` 0.108.0 and `full` 0.114.0. 0.82.0–0.107.x refuse `verbosity`
and 0.82.0–0.113.x refuse `full` (`invalid_argument`); older servers
ignore all three. `kagura-memory recall --verbosity/--full/--max-chars`
retries once without the flags a refusal names, so it runs on every
server. `maxChars` on `loadPinned`, MCP `loadGuardrails`,
`getAgentBootstrap` and `AgentsClient.bootstrap`, and `recallNearby({
includeDetails })` (items carry `location` in place of `details` from
0.82.0), need 0.82.0; REST `MemoryClient.loadGuardrails` has no
`max_chars` through 0.143.0. `supersede_candidate.verified` comes from
0.109.0
([memory-cloud#2016](https://github.com/kagura-ai/memory-cloud/issues/2016)),
`observed_at` on rows from 0.127.0
([memory-cloud#2330](https://github.com/kagura-ai/memory-cloud/issues/2330)),
and from 0.135.0 `explore_hints` only on an MCP URL that lists `explore`
([memory-cloud#2470](https://github.com/kagura-ai/memory-cloud/issues/2470)),
otherwise `explore_hints_omitted`.

**Session tools**
([#86](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/86);
[python-sdk#301](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/301)).
`bootstrap()`, `changesSince()`, `listMatching()` (the MCP `list` tool),
`rememberBatch()`, `describeTools()` and `guide()`, with `kagura-memory
bootstrap`, `changes` and `list`, need 0.93.0
([memory-cloud#1849](https://github.com/kagura-ai/memory-cloud/issues/1849)–[#1853](https://github.com/kagura-ai/memory-cloud/issues/1853));
an older server answers "tool not found". `listRevisions()` and
`rollbackSession()` need 0.113.0
([memory-cloud#2043](https://github.com/kagura-ai/memory-cloud/issues/2043),
[#2044](https://github.com/kagura-ai/memory-cloud/issues/2044)), and
`forget({ memoryIds })` / `kagura-memory forget --ids` 0.117.0
([memory-cloud#2127](https://github.com/kagura-ai/memory-cloud/issues/2127);
`not_attempted` rows from 0.118.0,
[memory-cloud#2191](https://github.com/kagura-ai/memory-cloud/issues/2191)):
0.82.0–0.116.x refuse `memory_ids`, and an older server ignores it and
answers the single form, which `forget` then refuses as
`KaguraResponseError`. `bootstrap({ format })` and a `maxChars` below
10,000 need 0.115.0
([memory-cloud#2126](https://github.com/kagura-ai/memory-cloud/issues/2126));
0.93.0–0.114.x refuse `format` (`invalid_argument`) and the smaller
budget (`validation_error`). On `changesSince`, `sessionId` and the
`restored` kind need 0.113.0, and `byMe` 0.114.0
([memory-cloud#2121](https://github.com/kagura-ai/memory-cloud/issues/2121)),
as does `rollbackSession`'s `since` / `until` window; a forgotten memory's
events carry no `summary` from 0.96.0
([memory-cloud#1876](https://github.com/kagura-ai/memory-cloud/issues/1876)).
`rememberBatch` counts `skipped` apart from `failed` and reports
`committed_after_timeout` from 0.96.0
([memory-cloud#1873](https://github.com/kagura-ai/memory-cloud/issues/1873)).
`listMatching({ orderBy: "observed_at" })` and the `observed_after` /
`observed_before` filters need 0.127.0
([memory-cloud#2330](https://github.com/kagura-ai/memory-cloud/issues/2330);
`validation_error` before). `listRevisions` may name the `erasure` writer
from 0.123.0
([memory-cloud#2244](https://github.com/kagura-ai/memory-cloud/issues/2244)),
and `rollbackSession` the `not_permitted` skip cause from 0.134.0
([memory-cloud#2432](https://github.com/kagura-ai/memory-cloud/pull/2432)).
`rollbackSession` always sends `dry_run`, `true` by default. A partial
run is a `KaguraPartialSessionRollbackError`, and `session_not_found` a
`KaguraNotFoundError`. Every option is sent only when set, so a call that
uses none of the newer ones works on every server that has the tool.

**Write and read arguments**
([#87](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/87);
[python-sdk#302](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/302)).
Unless noted, a server from 0.82.0 that predates an argument refuses it
(`invalid_argument`) and an older one ignores it. `remember({ observedAt
})`, `updateMemory({ observedAt })` and `remember|update-memory
--observed-at` need 0.127.0
([memory-cloud#2330](https://github.com/kagura-ai/memory-cloud/issues/2330));
recall's `observedAfter` / `observedBefore` go in `filters`, a free-form
object, so before 0.127.0 every server ignores them and filters nothing.
`remember({ dedupe, tagsNormalize, verbose })`, `updateMemory({ verbose
})` and `remember --dedupe/--tags-normalize` need 0.93.0
([memory-cloud#1853](https://github.com/kagura-ai/memory-cloud/issues/1853),
[#1851](https://github.com/kagura-ai/memory-cloud/issues/1851)).
`updateMemory({ addTags, removeTags, detailsPatch })` and `update-memory
--add-tag/--remove-tag/--details-patch` need 0.140.0
([memory-cloud#2585](https://github.com/kagura-ai/memory-cloud/issues/2585)),
and so does the one-call `update-memory --merge-details`, which falls
back to `reference()` and a second write where the server refuses the
patch (0.82.0–0.139.x) or ignores it (before 0.82.0, confirmed with `GET
/api/v1/system/info`). `updateMemory({ expectedVersion })`, `reference({
version })`, `version` on replies, `KaguraVersionConflictError` and
`update-memory --expected-version` need 0.113.0
([memory-cloud#2043](https://github.com/kagura-ai/memory-cloud/issues/2043);
before 0.82.0 it is ignored and guards nothing), as does `session_id` on
write replies
([memory-cloud#2044](https://github.com/kagura-ai/memory-cloud/issues/2044)).
`updateMemory({ acceptSupersedeCandidate })` and `update-memory
--accept-supersede-candidate` need 0.126.0
([memory-cloud#2308](https://github.com/kagura-ai/memory-cloud/issues/2308)).
`reference({ contentOffset, detailsOffset, contextOffset, fields,
maxChars })` and the bounded-reply keys need 0.78.0
([memory-cloud#1685](https://github.com/kagura-ai/memory-cloud/issues/1685)),
which predates the 0.82.0 refusal, so every server that refuses an
undeclared argument declares them. `summary_truncated` /
`summary_original_length` on `remember` come from 0.108.0
([memory-cloud#2003](https://github.com/kagura-ai/memory-cloud/issues/2003)).
`updateSearchConfig({ contentChunksEnabled })` and `context search-config
--[no-]content-chunks` need 0.110.0
([memory-cloud#2015](https://github.com/kagura-ai/memory-cloud/issues/2015);
refused on a LanceDB deployment from 0.112.0, plan-gated from 0.113.0
when `CONTENT_CHUNKS_REQUIRE_PLAN=true`), and `llmSelectorEnabled` /
`--[no-]llm-selector` 0.115.0
([memory-cloud#2144](https://github.com/kagura-ai/memory-cloud/issues/2144)).

**Models, cursors and caps**
([#85](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/85);
[python-sdk#299](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/299)).
The response fields from 0.79.0 to 0.141.0 are typed, each optional with
the Python model's default: `ContextGuardrails.provenance` from 0.79.0
([memory-cloud#1682](https://github.com/kagura-ai/memory-cloud/issues/1682));
the `has_more` / `*_omitted` / `*_truncated` flags of `ListTagsResponse`,
`ListContextsResponse`, `SleepReportDetail`, `SleepAction`, `Agent` and
`GuardrailSet` from 0.82.0; `FailedMemoryInfo.embedding_attempted_at`
from 0.95.0; the `plan_suspended` / `memory_limit_exceeded` skip reasons
from 0.99.0; `WorkspaceMember.seat_paused` from 0.100.0; the
`SearchConfig` `content_chunks_*` fields from 0.110.0–0.113.0, with
`RollbackSummary.chunks_requeued` / `points_requeued` from 0.112.0;
`llm_selector_*` and `ContextGuardrailItem.summary_cut` from 0.115.0;
`MemberAPIKey.default_context_id` / `default_context_name` / `agent_id`
from 0.118.0 and `connector_id` from 0.129.0; `MemoryListItem.observed_at`
from 0.127.0; `IndexerStateMetrics.failed_events` from 0.135.0;
`SleepReport.source` from 0.138.0; and `SleepReportDetail.note` from
0.140.0. `listContexts({ cursor })` and `getState({ cursor })` take the
0.82.0 cursors
([memory-cloud#1743](https://github.com/kagura-ai/memory-cloud/issues/1743)),
and `listAgents` follows them; it sends nothing new, so it works on every
server. So do `getSleepReport({ actionsCursor, actionsLimit, maxChars })`
and `sleep report --actions-cursor/--actions-limit`; a server before
0.82.0 ignores them and sends every action. `getSleepHistory({ source })`
and `sleep history --source` need 0.138.0
([memory-cloud#2219](https://github.com/kagura-ai/memory-cloud/issues/2219)),
where the default lists Sleep runs only; 0.82.0–0.137.x refuse `source`.
The 0.82.0 write caps are checked locally on every server: 50 tags of 100
characters on `remember` / `updateMemory`, 16,384 characters for a
`setState` value. `listEdges` keeps sending `min_weight: 0.0` (the
server's default is 0.05 from 0.117.0,
[memory-cloud#2127](https://github.com/kagura-ai/memory-cloud/issues/2127))
and warns through the client's `warn` option when the server cut a
direction (the 0.82.0 `*_has_more` flags).

**List paging**
([#89](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/89);
[python-sdk#315](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/315)).
`listContexts({ limit })` and `context list --limit` take 1-200 contexts a
page (0.82.0,
[memory-cloud#1743](https://github.com/kagura-ai/memory-cloud/issues/1743));
with `includeDetails` and no non-blank `nameContains` at most 20, refused
before any request, since the server refuses more. `context list
--cursor` pages on, and a cut page prints `has_more` / `next_cursor` on
stderr with the command for the next page, so stdout stays the JSON;
`kagura-memory contexts` names the `context list --cursor` call when more
follow. `getState({ limit, maxChars })` (list mode) takes 1-200 entries
and 10,000-100,000 characters. `nameContains` (0.73.0) is sent trimmed,
and a blank one not at all, and `createContext`'s quota pre-check asks
`list_contexts` for one row. `listContexts` has no `maxChars`: no release
through 0.143.0 declares `max_chars` on `list_contexts`, so 0.82.0 and
later would refuse it. Servers before 0.82.0 ignore these arguments:
`listContexts` returns every context and `getState` every entry.

**MCP URL options and the tool-view reader**
([#83](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/83),
[#91](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/91);
[python-sdk#300](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/300),
[#311](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/311)).
From 0.93.0 a bare `/mcp` lists the `core` profile
([memory-cloud#1849](https://github.com/kagura-ai/memory-cloud/issues/1849);
21 tools on 0.141.0, where `?profile=full` lists 72). A profile is a view,
not an authorization boundary: `tools/call` reaches every tool, so no
`KaguraClient` method is affected. `setup claude|codex|hermes|openclaw
--add-tools` and `kagura-memory-mcp --add-tools` write `?add_tools=`, and
`MemoryClient.getGuardrailDigest({ addTools })` / `guardrails digest
--add-tools` preview that view's instructions (0.129.0,
[memory-cloud#2354](https://github.com/kagura-ai/memory-cloud/issues/2354)).
`setup claude --context` and `kagura-memory-mcp --context` write
`?context=` (0.114.0,
[memory-cloud#2125](https://github.com/kagura-ai/memory-cloud/issues/2125)),
and `kagura-memory-mcp --session-id` (default `$KAGURA_MCP_SESSION_ID`)
sends `Kagura-Session-Id` on every upstream request (0.114.0,
[memory-cloud#2122](https://github.com/kagura-ai/memory-cloud/issues/2122)).
`kagura-memory-mcp` also takes `--tool-profile` (`?profile=`, 0.73.0,
[memory-cloud#1601](https://github.com/kagura-ai/memory-cloud/issues/1601))
and `--guardrails` (`?guardrails=`, 0.74.0,
[memory-cloud#1621](https://github.com/kagura-ai/memory-cloud/issues/1621)).
`doctor`'s last check reports the `tools/list` view of the CLI's MCP URL
(`profile core (default)` on 0.93.0 and later, `no ?profile=` before).
From 0.135.0 `explore` is not in `core`
([memory-cloud#2470](https://github.com/kagura-ai/memory-cloud/issues/2470)),
so `recall`'s `explore_hints` need `?add_tools=explore` or
`?profile=full`. None of these is a tool argument, so `invalid_argument`
never applies: a server older than a query key or header ignores it.
`setup`, `kagura-memory-mcp`, `doctor` and the digest preview read the
URL's query as the server does (the first value wins, even a blank one,
trimmed), `setup claude`'s re-run note names a `?tools=` allowlist the new
entry drops, and `getToolDefinitions()` refuses a malformed `tools/list`
result with `KaguraResponseError`, all client-side.

**Setup context lookup**
([#90](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/90);
[python-sdk#309](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/309)).
`setup claude` resolves a context name (from `--context-id`,
`.kagura.json`'s `context_id` or `KAGURA_CONTEXT_ID`) through
`list_contexts` on the setup key: the first page on any server, then the
exact name with `name_contains` (0.73.0) and the `cursor` (0.82.0) when
the first page says `has_more`, which only 0.82.0 and later send, so both
go only to servers that declare them. Before 0.82.0 the first page is
every context, and no second request is sent. A dashed UUID checks the
first page too: a matching ID or exact name wins, otherwise it is used
as an ID without further pages (#116). No context sends no request, and
neither does `setup codex|hermes|openclaw --dry-run`.
Claude setup validates the resolved ID against ASCII letters, digits,
hyphens and underscores before writing. UUID normalization accepts Unicode
decimal digits as Python does, including non-BMP mathematical digits;
the digit repertoire follows Node's ICU Unicode version, which can differ
from Python's. Harness UUID normalization and dry-run placeholders remain
separate from Claude's resolved-ID validation.

**Auth**
([#81](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/81),
[#92](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/92);
[python-sdk#312](https://github.com/kagura-ai/kagura-memory-python-sdk/pull/312),
[#313](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/313)).
`auth logout` revokes the profile's refresh token, then its access token,
on every server: 0.82.0 and later revoke both with the first request
([memory-cloud#1741](https://github.com/kagura-ai/memory-cloud/issues/1741)),
an older server each as it is sent. Every refresh takes the cross-process
lock and re-reads `credentials.json` first, which matters because a
refresh token is single-use from 0.79.0
([memory-cloud#1686](https://github.com/kagura-ai/memory-cloud/issues/1686));
this is client-side and the same on every server. `auth refresh --help`
cites 0.83.0
([memory-cloud#1738](https://github.com/kagura-ai/memory-cloud/issues/1738)):
a password reset revokes every OAuth token.

**Fixes for every server**
([#79](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/79),
[#80](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/80),
[#102](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/102);
[python-sdk#296](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/296),
[#297](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/297),
[#294](https://github.com/kagura-ai/kagura-memory-python-sdk/pull/294)).
`getSleepReport`, `rollbackSleepRun` and `sleep report|rollback` send
`report_id` alone. SDKs up to 0.14.1 also sent `context_id`, which no
release declares there: 0.82.0 and later refused every call, and older
servers ignored it. From 0.126.0
([memory-cloud#2315](https://github.com/kagura-ai/memory-cloud/pull/2315))
the server authorizes these tools against the report's own context (read
access for a report, the editor or owner role for a rollback), and from
0.140.0
([memory-cloud#2547](https://github.com/kagura-ai/memory-cloud/issues/2547))
`rollbackSleepRun` refuses a Memory Analysis report with
`analysis_report`. `ResourceListItem.context_id` / `context_name` may be
`null` from 0.94.0
([memory-cloud#1863](https://github.com/kagura-ai/memory-cloud/issues/1863)),
for a resource whose contexts were all deleted while it still holds active
tokens. `mintMemberKey` and the CLI's key and invitation readers read the
`akey_…` / `winv_…` ids of 0.89.0 and later
([memory-cloud#1008](https://github.com/kagura-ai/memory-cloud/issues/1008)),
an older server's integer as the integer, and a numeric-string id stays a
string.

**Permission model**
([#85](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/85),
README and docs only). From 0.126.0 an owner or admin reaches every shared
context, and a member or viewer exactly its `allowed_context_ids`; with no
list a viewer reaches every shared context and a member none. A context
outside the list is `KaguraNotFoundError`, and a workspace viewer is
read-only. Resource tokens are workspace-scoped from 0.94.0
([memory-cloud#1863](https://github.com/kagura-ai/memory-cloud/issues/1863)),
and another workspace's token is `KaguraNotFoundError` from 0.97.0
([memory-cloud#1919](https://github.com/kagura-ai/memory-cloud/issues/1919));
`deleteContext` soft-deletes a context's files and `mergeContexts({
deleteSource: true })` moves them from 0.101.0
([memory-cloud#1960](https://github.com/kagura-ai/memory-cloud/issues/1960));
a `supersedes` edge needs both memories to be the caller's from 0.132.0
([memory-cloud#2313](https://github.com/kagura-ai/memory-cloud/issues/2313)).
The README's "Permission model" section has the rest.

**Plan headroom and supersede acceptance**
([#88](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/88);
[python-sdk#314](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/314)).
From 0.142.0 a `bootstrap`, `rememberBatch`, `remember` or `updateMemory`
success may carry `plan_headroom`
([memory-cloud#2615](https://github.com/kagura-ai/memory-cloud/issues/2615)):
one entry per plan dimension (`memories`, `memories_per_day`,
`mcp_calls_per_day`) at 80 % (`warning`) or 95 % (`critical`) of its
effective limit, with `used`, `limit`, `percentage`, `remedies`, `help`,
`plan` when the server knows it and `resets_at` on the daily caps. It is
absent below 80 %. All four type it as `PlanHeadroomNotice[]`, read
fail-open: an entry the SDK cannot read is dropped and the call still
succeeds. The Python SDK's `remember` / `update_memory` return their reply
as an unchecked dict, so for a malformed notice only, Python keeps what
`remember` / `updateMemory` drop here; the CLI's `remember`,
`update-memory` and `files upload --remember` print the reply as sent.
`supersede_candidate.acceptance` (`{ allowed, reason? }`, the
`SupersedeAcceptance` type) says whether the caller may accept the
suggestion: on `reference` from 0.137.0
([memory-cloud#2427](https://github.com/kagura-ai/memory-cloud/issues/2427);
`not_writable`, `not_owner`, `newer_candidate`), with `edge_exists` from
0.138.0
([memory-cloud#2518](https://github.com/kagura-ai/memory-cloud/issues/2518)),
and on every `recall` row that carries a suggestion from 0.142.0
([memory-cloud#2508](https://github.com/kagura-ai/memory-cloud/issues/2508)).
From 0.142.0 a memory carrying `details.tool_trigger` reports the
guardrail gate the accept runs first as `not_writable`
([memory-cloud#2614](https://github.com/kagura-ai/memory-cloud/issues/2614)).
Both keys are response-only, so every server takes these calls; an older
server never sends them.

**Runtime**
([#76](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/76)).
Node.js 20.19.0 or later; this changes nothing on the server side.
`MIN_SERVER_VERSION` stays **0.75.0**.

## 0.14.1

**Min memory-cloud:** 0.75.0 — checked against memory-cloud up to
**0.77.0**, as this release's README states. Per-surface: 0.89.0 the
string public ids (`rtok_…`, `winv_…`, `akey_…`)

**String public ids.** memory-cloud 0.89.0
([memory-cloud#1008](https://github.com/kagura-ai/memory-cloud/issues/1008))
makes resource-token, invitation and member-key ids opaque prefixed
strings and answers an integer path id with HTTP 422.
`ResourceClient.updateToken` / `revokeToken`,
`WorkspaceClient.revokeInvitation` / `revokeMemberKey` and the CLI's
`resource tokens update|revoke`, `workspace invite revoke` and `auth
revoke-key` take the string id; integer ids work as before against older
servers. Two readers still refused a string id (the member-key reader of
`mintMemberKey`, `auth create-key` and `auth list-keys`, and the CLI's
invitation reader), which 0.15.0 fixes
([#102](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/102)).
`MIN_SERVER_VERSION` stays **0.75.0**.

## 0.14.0

**Min memory-cloud:** 0.75.0 — checked against memory-cloud up to
**0.77.0**, the first release that records it (parity target: the Python
SDK and CLI 0.42.0). Per-surface: 0.77.0 `setup codex|hermes|openclaw
--url-form --oauth`

**Harness OAuth URL form**
([python-sdk#282](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/282)).
`setup codex|hermes|openclaw --url-form --oauth --mcp-url URL` writes an
entry with no key, which the harness signs in to itself; it needs the
OAuth client registration memory-cloud 0.77.0 opens to those harnesses
([memory-cloud#1657](https://github.com/kagura-ai/memory-cloud/issues/1657)).
Setup first sends one unauthenticated `GET /api/v1/system/info` and stops
(exit 1), having run and written nothing, on an older server or a version
it cannot confirm; `--dry-run` sends no request. **`update-memory
--details/--location/--merge-details`**
([python-sdk#247](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/247))
work on any server. From 0.78.0
([memory-cloud#1685](https://github.com/kagura-ai/memory-cloud/issues/1685))
a `reference` reply can leave a large `details` out, and `--merge-details`
then stops without writing. **Model checks**
([python-sdk#277](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/277)):
`getServerInfo`, `checkServerVersion`, `getEmbeddingStatus`,
`getMemoryStats`, `findDuplicates` and `listEmbeddingModels` check the
body against the Python model; client-side, any server.
`MIN_SERVER_VERSION` stays **0.75.0**.

## 0.13.0

**Min memory-cloud:** 0.75.0. Per-surface: 0.77.0
`ServerInfo.terms_version`

`ServerInfo.terms_version` (memory-cloud 0.77.0,
[memory-cloud#1665](https://github.com/kagura-ai/memory-cloud/issues/1665))
is the deployment's terms-of-service version, `null` when it does not
record acceptance and on an older server. The resource and files commands
print the Python CLI's model dumps
([#66](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/66)),
client-side. `MIN_SERVER_VERSION` stays **0.75.0**.

## 0.12.0

**Min memory-cloud:** 0.75.0. Per-surface: 0.42.0 the `workspace` group
and `auth create-key|list-keys|revoke-key`; 0.54.0 `recordMeasurement` /
`recallSeries` (`measure record|series`) and the `listMemories` bounding
box; 0.74.0 `guardrails load|digest`, `MemoryClient` and `setup
codex|hermes|openclaw --agents-md`; 0.77.0 the REST tags route's
`context_name` for a `listTags` drill-down

The CLI reaches every Python CLI command but `ingest`
([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)).
The `workspace` group and the `auth` key commands take only the workspace
owner's static API key. Before 0.77.0 a `listTags` drill-down names the
context with one MCP `list_tags` call. `checkServerVersion()` and
`doctor` read server versions as the Python SDK reads them.
`MIN_SERVER_VERSION` stays **0.75.0**.

## 0.11.0

**Min memory-cloud:** 0.75.0. Per-surface: 0.65.0 `update-memory
--dismiss-supersede-candidate`; 0.69.0 `recall --rerank/--no-rerank`;
0.73.0 `context list --name-contains/--summary/--details`

`--stats` works on any server. Without `--rerank` or `--no-rerank`, a
0.69.0 server follows the context's search config. An older server drops
`--dismiss-supersede-candidate` silently, and one older than 0.73.0
ignores `--name-contains` and lists every context.
`MIN_SERVER_VERSION` stays **0.75.0**.

## 0.10.1

**Min memory-cloud:** 0.75.0. Per-surface: 0.17.2 `listTags({ withTags })`
(now the REST tags route)

A `listTags` drill-down went to the MCP `list_tags` tool, which has no
`with_tags` through 0.76.0 and drops arguments it does not know, so every
drill-down returned the whole vocabulary. It now calls the REST tags
route, which has had the filter since 0.17.2.
`createContext`'s `resourceId` and `setupResource`'s `summary` are no
longer sent: no server through 0.76.0 reads them.
`MIN_SERVER_VERSION` stays **0.75.0**.

## 0.10.0

**Min memory-cloud:** 0.75.0. Per-surface: 0.24.0 `recall
--trusted-only`; 0.70.0 `auth login --invite` (`features.beta_invites`),
0.76.0 its one-link hand-off and the device sign-in 429; 0.73.0 `setup
claude|codex --tool-profile`; 0.74.0 `setup claude|codex --guardrails`

A server older than 0.70.0 takes no invites; before 0.76.0
([memory-cloud#1655](https://github.com/kagura-ai/memory-cloud/issues/1655))
`auth login --invite` shows two steps instead of one link. From 0.76.0
([memory-cloud#1656](https://github.com/kagura-ai/memory-cloud/issues/1656))
device sign-in is rate-limited per address, and the 429 says how long to
wait. A server ignores a `?profile=` or `?guardrails=` it predates.
`MIN_SERVER_VERSION` stays **0.75.0**.

## 0.9.0

**Min memory-cloud:** 0.75.0, raised from 0.17.1
([#43](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/43)).
Per-surface: 0.65.0 `updateMemory({ dismissSupersedeCandidate })`; 0.73.0
`listContexts({ nameContains, includeSummary, includeDetails })` and
`recallUpcoming({ includeDetails })`; 0.74.0 `loadGuardrails`; 0.75.0
the `gate`-typed plan and quota errors and the `list_contexts` `hint`

`MIN_SERVER_VERSION` moved to 0.75.0 because the typed surface had
outgrown 0.17.1: the gate-based error classes read a field only 0.75.0
sends, and `recallNearby` (0.5.0) needs 0.53.0. It stays advisory. Fields
the server was already sending are typed, with their own floors:
`SleepRunStatus` `"degraded"` 0.43.0, `merge_retention_result` 0.45.0,
`Edge.origin` 0.52.0, `MemoryListItem.location` 0.54.0,
`erasure_pseudonymized` 0.55.0, `memories_per_day_exceeded` 0.68.0 and
`ServerInfo.search_defaults` 0.69.0. memory-cloud 0.73.0 slimmed the
default `list_contexts` and `recall_upcoming` rows; the new options ask
for the fields again.

## 0.8.1

**Min memory-cloud:** 0.17.1. Per-surface: 0.34.0 the `getMemoryStats`
sort fields; 0.69.0 `recall({ useRerank: false })`

From 0.69.0 `use_rerank` has three states (omitted follows the context's
search config), so `false` is now sent; before 0.69.0 nothing changes.
`getMemoryStats` sorts by `access_count` by default, since 0.34.0 dropped
`use_count`.

## 0.1.0 – 0.8.0

**Min memory-cloud:** 0.17.1. Per-surface: 0.49.0 the agent control plane
(0.2.0)

The record runs out here: the changelog of these releases names no other
server floor. The agent registry, the context bindings,
`getAgentBootstrap` and `AgentsClient` (0.2.0) need 0.49.0; 0.9.0's entry
gives `recallNearby` (0.5.0) 0.53.0.
