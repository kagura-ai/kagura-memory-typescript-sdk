# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  it from their own `.env` (`MCP_KAGURA_MEMORY_API_KEY` in
  `$HERMES_HOME/.env`, `KAGURA_API_KEY` in `~/.openclaw/.env`), which is
  written 0600 with that one line replaced or appended.

  This package has no TOML, YAML or JSON5 parser and takes no runtime
  dependencies, so it never rewrites those configs. The entry goes in
  through `codex mcp add` or `openclaw mcp add` (`openclaw mcp set` with
  `--force`) when that CLI is on `PATH`, run without a shell; otherwise the
  block is printed on stderr with the file it belongs in, and stdout stays
  one JSON document. On Windows, a CLI installed only as an npm `.cmd` shim
  counts as not found, because Node runs one only through a shell that
  would re-parse the arguments. Hermes always gets the printed block,
  because `hermes mcp add` always prompts. An existing entry of the same
  name stops the command with exit 1 unless `--force` is given; `--name`
  renames the entry, and `--dry-run` shows what would be configured without
  writing or running anything. Hermes and OpenClaw do not pass the server's
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
  on, and otherwise to the `-c` context when that is a UUID.

- **`setup claude` notices the Kagura Memory plugin.** When
  `claude plugin list --json`, run in `--project-dir`, shows it enabled,
  the notes list the plugin's `server_url` and `context_id` settings to
  enter and, unless the URL already carries `guardrails=off`, recommend
  re-running with `--guardrails off` once its hooks deliver guardrails.
  The URL is not changed for you: `off` also removes the guardrails block
  from `get_context_info`.

- **`recall --trusted-only`**
  ([#45](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/45))
  sends `filters.trust_tier = "trusted"`, so external and
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
  same three scopes as `setup claude` and reports the entry Claude Code
  uses as `MCP Mode: <mode> (<scope> scope, <file>)`, with `scope` and
  `source` in the check's `details`, plus a warning for each entry that one
  hides, in the Python CLI's words. The other messages change too: an
  `info` "No kagura-memory MCP entry found (.mcp.json, ~/.claude.json)"
  when no scope has one, and a `warn` "No usable kagura-memory entry found
  in …" for a `.mcp.json` without one, or for an entry that is neither the
  `kagura-mcp` stdio proxy nor an HTTP entry. A static-token entry passes,
  where Python's `doctor` points at `setup claude --profile`, whose proxy
  this package does not ship. A `.mcp.json` that is not JSON still fails.

### Fixed

- **`setup claude` wrote an entry that Claude Code skips**
  ([#45](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/45)).
  The `.mcp.json` entry had `type: "url"`, which is not one of Claude
  Code's transports: Claude Code 2.1.280 reports it as
  `Skipped — unknown MCP server type "url"`, and
  `claude mcp get kagura-memory` finds no such server, while the command
  reported success. The entry is now `type: "http"`. Re-run `setup claude`
  to rewrite an existing one; `doctor` warns about a `url` entry and says
  so.

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
  is noted instead. An `.mcp.json` it cannot parse now also stops the
  command before `.kagura.json` is rewritten rather than after.

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

[Unreleased]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.3.0...v0.5.0
[0.3.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/releases/tag/v0.1.0
