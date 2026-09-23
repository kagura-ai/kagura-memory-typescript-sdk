<p align="center">
  <strong>Kagura Memory SDK for TypeScript</strong> — Node.js client for <a href="https://github.com/kagura-ai/memory-cloud">Kagura Memory Cloud</a>
</p>

## What is this?

This SDK connects your TypeScript/JavaScript code to [Kagura Memory Cloud](https://github.com/kagura-ai/memory-cloud), giving AI agents the ability to **remember, search, and learn** from past interactions. It is a TypeScript port of the [Python SDK](https://github.com/kagura-ai/kagura-memory-python-sdk) core:

| Client | Protocol | Use Case |
|--------|----------|----------|
| **`KaguraClient`** | MCP (JSON-RPC) | Direct memory ops — remember, recall, explore, reference, forget |
| **`ResourceClient`** | REST API | External data ingestion — push data from Slack, CI/CD, CRM into Kagura |
| **`FilesClient`** | REST + presigned PUT | File uploads with sha256 integrity binding (R2) |
| **`WorkspaceClient`** | REST API | Workspace member, invitation, and API key management |
| **`SecretClient`** | REST API | [Zero-knowledge secrets](#zero-knowledge-secrets) — age-encrypted on your machine, opaque to the server |
| **`AgentsClient`** | REST API | Agent bootstrap for API-key-only callers (no MCP session) |

A `kagura-memory` command-line tool ships alongside it, mirroring the Python
CLI's `kagura` command — see [Command line](#command-line).

## Installation

```bash
npm install kagura-memory
```

Requires Node.js >= 18 (native `fetch`). Zero runtime dependencies —
the one optional peer dependency, for
[zero-knowledge secrets](#the-crypto-package-is-opt-in), is never installed
unless you ask for it.

Targets memory-cloud **v0.75.0** (`MIN_SERVER_VERSION`).
`checkServerVersion()` warns, and never throws, on an older server, which
still answers: it ignores options it predates, leaves out fields it
predates, and reports a tool it predates as not found. The method notes
below say which server version a feature needs.

## Quick Start

```ts
import { KaguraClient } from "kagura-memory";

// Credentials resolve automatically: explicit apiKey > KAGURA_API_KEY env
// > OAuth profile (~/.kagura/credentials.json, shared with the Python CLI)
// > .kagura.json
const client = new KaguraClient();

// Store a memory
const stored = await client.remember({
  contextId: "your-context-id",
  summary: "User prefers TypeScript strict mode",
  content: "Enabled strict + noUncheckedIndexedAccess in all new projects.",
  type: "note",
  tags: ["typescript", "preferences"],
});

// Search memories (hybrid semantic + keyword)
const hits = await client.recall({
  contextId: "your-context-id",
  query: "typescript preferences",
  k: 5,
});

for (const memory of hits.results as Array<Record<string, unknown>>) {
  console.log(memory.summary);
}

await client.close();
```

### Authentication

Four ways to authenticate, in resolution order:

1. **Explicit key** — `new KaguraClient({ apiKey: "kagura_..." })`
2. **Environment** — `KAGURA_API_KEY` (+ optional `KAGURA_MCP_URL`)
3. **OAuth profile** — `~/.kagura/credentials.json`, written by `login()`
   (below) or the Python CLI's `kagura auth login`. Profiles
   (`KAGURA_PROFILE` env or `{ profile: "name" }`) and auto-refresh work
   exactly like the Python SDK; the credentials file is shared between both
   SDKs.
4. **Config file** — `.kagura.json` in the working directory or home:

```json
{
  "api_key": "kagura_your_api_key",
  "mcp_url": "https://memory.kagura-ai.com/mcp"
}
```

### Command line

`kagura-memory` mirrors the Python CLI's `kagura` command — same
subcommands, same flag names, same JSON on stdout, same exit codes (2 for
a usage error, 1 for a runtime failure).

```bash
npx kagura-memory --help
```

| Group | Commands |
|---|---|
| `auth` | `login` `logout` `refresh` `status` `use` `list` `token` |
| `context` | `list` `create` `update` `delete` `search-config` (plus the `contexts` alias) |
| memory | `remember` `recall` `reference` `forget` `update-memory` `explore` |
| `edge` | `list` `create` `update` `delete` |
| `sleep` | `history` `report` `rollback` |
| `files` | `upload` `list` `delete` `download-url` |
| `resource` | `tokens {list,create,update,revoke}` `list` `setup` `schema` `stats` `indexer-status` `events` `ingest` `ingest-batch` `import` |
| `secret` | `keygen` `list` `put` `get` `grant` `revoke` `rotate` `delete` `pubkeys` `approve` `audit-verify` `exec` |
| `setup` | `claude` `codex` `hermes` `openclaw` |
| other | `config show` `doctor` |

```bash
npx kagura-memory auth login --profile work --read-only
npx kagura-memory recall "OAuth setup" -c dev -k 10
npx kagura-memory remember -s "FastAPI DI" --content "Use Depends()" --tags "python,fastapi"
npx kagura-memory setup codex --dry-run   # key from .kagura.json or KAGURA_API_KEY
npx kagura-memory doctor
```

The context id comes from `-c/--context-id`, or from `context_id` in
`.kagura.json`. Credentials live in `~/.kagura/credentials.json` and are
shared with the Python CLI, so either tool can create a profile the other
then uses.

**Connecting a harness.** Each `setup` subcommand writes `.kagura.json`
(0600, gitignored) and an MCP entry named `kagura-memory`: the URL plus a
Bearer header. `.kagura.json` gets the URL as given; the parameters that
`--guardrails` and `--tool-profile` set go on the entry's URL only. The
key is never printed, and outside
Claude Code it never goes into the harness's config file. `setup codex`
also leaves a key it found in `KAGURA_API_KEY` out of `.kagura.json`.

| Subcommand | How the entry is applied | Where the key lives |
|---|---|---|
| `setup claude` | `.mcp.json` (`--scope project`, the default), or `claude mcp add-json --scope user …` | in the entry |
| `setup codex` | `codex mcp add … --bearer-token-env-var KAGURA_API_KEY` | `KAGURA_API_KEY`, exported in the shell that starts Codex |
| `setup hermes` | the `config.yaml` block is printed; `hermes mcp add` always prompts | `$HERMES_HOME/.env`, as `MCP_KAGURA_MEMORY_API_KEY` |
| `setup openclaw` | `openclaw mcp add … --transport streamable-http --no-probe` | `~/.openclaw/.env`, as `KAGURA_API_KEY` |

This package has no TOML, YAML or JSON5 parser, so it never rewrites those
files. When the harness's CLI is not on `PATH`, the block is printed on
stderr with the file it belongs in, and stdout stays one JSON document.
On Windows, a CLI installed only as an npm `.cmd` shim counts as not
found: Node runs one only through a shell, which would re-parse the
arguments.

`--guardrails <context-id|off>` sets the URL's `guardrails` parameter on
`setup claude` and `setup codex`. Hermes and OpenClaw do not pass the
server's instructions to the model, so there `off` is refused and a
context id is dropped, whether it comes from the flag or from the URL.
`--tool-profile` (claude, codex) sets `profile` and refuses an empty name.
Both go at the end of the query, `guardrails` first, replacing any value
already there, as the Python CLI writes them. `--name`, `--force` and
`--dry-run` (codex, hermes, openclaw) name the entry, replace an existing
one, and show what would be configured without changing anything.

Claude Code uses the `kagura-memory` entry from the strongest scope
(local > project > user). `setup claude` writes nothing when a stronger
scope already defines one, and prints the `claude mcp remove --scope …`
command for it; an entry the new one hides in a weaker scope is noted.
With `--scope user`, an identical user-scope entry is left as it is and a
different one is replaced: `claude mcp remove` runs before `claude mcp
add-json`, and if the add then fails, the old entry is put back (if that
fails too, the error prints the command to add the new one by hand).
Without `claude` on `PATH`, `--scope user` prints the commands to run and
writes nothing. When the Kagura Memory plugin is enabled, the notes list
the plugin settings to enter. `doctor` reports the entry Claude Code uses
in the current directory, with its scope and file, and warns about each
entry that one hides.

**Not ported.** `kagura ingest` needs the text-extraction pipeline (PDF,
Office, EPUB, audio) and `kagura process` needs the litellm-backed agent;
neither exists in this package and both would cost the zero-dependency
promise. Use the Python CLI for those.

**Three deliberate divergences.**

- `secret` needs the optional `age-encryption` peer (`npm install
  age-encryption`), exactly as Python's `[secret]` extra works. Key
  custody differs: Python uses the OS keychain via `keyring`, which has no
  zero-dependency equivalent in Node, so this CLI reads the age identity
  from `KAGURA_AGE_IDENTITY` or `KAGURA_AGE_IDENTITY_FILE` and fails
  closed when neither is set. **A key custodied by the Python CLI is not
  readable here, and vice versa.**
- `setup … --profile` (the OAuth path) writes an entry that launches
  Python's `kagura-mcp` stdio proxy, which this package does not install;
  every `setup` subcommand reports the fact instead of writing a config
  that would fail at launch. The `--api-key` path works here.
- `config show` does not reproduce Python's key mask
  (`key[:8] + "..." + key[-4:]`), whose halves overlap below 12 characters
  and print the whole secret twice.

One divergence runs the other way, and it is small: `--profile=` and
`--scope=` reject an explicitly empty value, where click would accept it.
An empty profile name would create a nameless profile and an empty scope
would go to the server verbatim. Every other option treats `--flag=` as
Python does.

**Sign-in rate limit.** memory-cloud v0.76.0 and later limit device sign-in
requests per client address. When the server refuses one with HTTP 429,
`auth login` says so and how many seconds to wait (from the `Retry-After`
header, 60 when it is missing), with the server's reason on the next line.
`login()` and `authorizeDevice` throw the same message as a
`KaguraAuthError`.

#### Signing up with an invite

On a deployment that admits new accounts only by beta invite, pass the
invite to `auth login`, either as the bare token or as the
`https://…/join/<token>` link it arrived in:

```bash
npx kagura-memory auth login --invite <link-or-token>
```

Without it, a new user who starts from `auth login` is refused at sign-up:
the approval page sends a signed-out visitor to the login page, which does
not carry an invite. With it, once the device code is issued, the CLI asks
the server how to present the invite (`GET /api/v1/system/info`, which
takes no credentials, allowed 5 seconds):

- **The server supports the hand-off** (memory-cloud 0.76.0 or later,
  `v0.76.0` and build suffixes included): one link,
  `<frontend>/join/<token>?return_to=%2Fdevice%3Fuser_code%3D<code>`, that
  signs up with the invite and lands on the approval page with the code
  filled in. The browser opens that link. Below it, "If you land on the
  dashboard instead, approve here:" and the approval URL cover a user who
  is already signed in.
- **An older or unrecognised version, or the check failed**: two steps, in
  order. The plain `/join/<token>` link, which the browser opens, then the
  approval URL, and how long the code stays valid.
- **The server does not take invites** (a `features` object without
  `beta_invites: true`): a one-line note, then the ordinary prompt. A body
  with no `features` object says nothing about invites, so the version
  decides.

`<frontend>` is the device response's approval URL with its final
`/device` removed, so a frontend under a base path gets its `/join` beside
its `/device`. When that URL does not end in `/device`, the CLI does not
guess where `/join` lives: it takes the two steps, with your own link as
step 1, or tells you to open the invite you were sent when you gave a bare
token. It takes the two steps too when memory-cloud's `/join` would drop
the `return_to` (a path starting with `//`, as a frontend URL configured
with a trailing slash produces, or one holding a backslash or a control
character), which would otherwise leave the new user on the dashboard.

The invite is checked before any request. A malformed one exits 2 with
`Error: Invalid value for '--invite': <reason>`, the Python CLI's reason,
which never quotes the value. A pasted link must be written out in full,
`https://<host>/…/join/<token>` (a browser would repair `https:/host/…`;
the CLI does not), and must be HTTPS, as `--server` must (plain HTTP only
on localhost). A `/join` link is never built on a plain-HTTP frontend: the
token would travel in the clear. A link for a different server than the one
being logged into aborts before the server is asked about invites and
before the device code is polled, so no profile is written; the error
suggests logging in with `--server` instead. The token is never saved, in
`credentials.json` or anywhere else, and never appears in an error message:
it is printed only inside a link. Every other `auth` subcommand rejects
`--invite` with exit 2 rather than ignoring it. `--no-browser` works as it
does without an invite, and when the browser cannot be opened the CLI says
which link above to open by hand.

#### Logging in from TypeScript

`login()` runs the OAuth 2.0 Device Authorization Grant (RFC 8628) and
writes `~/.kagura/credentials.json` in exactly the format the Python CLI
writes — no Python install needed, and the profile stays interchangeable
between both SDKs.

```ts
import { login, KaguraClient } from "kagura-memory";

const creds = await login({
  onUserCode: ({ userCode, verificationUri, verificationUriComplete }) => {
    console.log(`Open ${verificationUri} and enter ${userCode}`);
    // Or, in a desktop app: shell.openExternal(verificationUriComplete)
  },
});

console.log(`Logged in as ${creds.userEmail} (${creds.workspaceName})`);

// Subsequent clients pick the profile up automatically.
const client = new KaguraClient();
```

There is no terminal IO and no browser launching inside the SDK —
`onUserCode` hands the code back and the host app decides how to show it.

Scope defaults to `DEFAULT_SCOPE` (`"memory:read memory:write"`) — the same
default as the CLI's `kagura auth login`, and exactly what the server's
pre-registered `kagura-cli` client is seeded with. Pass
`scope: READ_ONLY_SCOPE` for the CLI's `--read-only` behaviour. The two SDKs
share the credentials file, so a profile should not end up with different
authority depending on which one created it.

The server is resolved as `mcpUrl` > `KAGURA_MCP_URL` > the public default,
matching the CLI's `--server` chain — so a self-hosted deployment is picked
up from the environment. Plain HTTP is rejected for non-loopback hosts: the
flow carries a bearer token.

Nothing is written unless the exchange succeeds, so a failed login never
disturbs an existing profile: a denial throws `KaguraAuthDeniedError` and an
unapproved expiry throws `KaguraAuthExpiredError`. A response with no
`refresh_token` warns and still persists — the Python CLI treats a
non-refreshable profile as a valid degraded state, and the shared file must
mean the same thing to both SDKs. Check the returned `refreshToken` if you
need to react.

For a custom flow (your own polling UI, multi-profile management), the
primitives are exported too: `authorizeDevice`, `pollForToken`,
`refreshAccessToken`, `revokeToken`, plus the credentials store
(`loadCredentialsFile`, `updateProfile`, `setDefaultProfile`,
`deleteProfile`, …).

For a new user holding a beta invite, `buildInviteLink` builds the same
sign-up-and-approve link the CLI's `--invite` prints. It takes the Python
SDK's `build_invite_link` arguments in the same order: the two approval
URLs from the device response, then the invite token. `onUserCode` is the
first point where both are known, so call it there. It is a pure function
and does not check the server version; that check is the CLI's own.

```ts
import { buildInviteLink, login } from "kagura-memory";

const token = "<token>"; // the last path segment of https://…/join/<token>

await login({
  onUserCode: ({ verificationUri, verificationUriComplete }) => {
    // null when /join cannot be placed: the approval URL does not end in
    // /device, is plain HTTP off localhost, or is not a return_to that
    // memory-cloud's /join keeps.
    const link = buildInviteLink(verificationUri, verificationUriComplete, token);
    if (link !== null) console.log(`Sign up and approve: ${link}`);
    // A signed-in user, or a server older than memory-cloud 0.76.0, ends
    // up on the dashboard instead; the pending code is approved here.
    console.log(`Or approve at: ${verificationUriComplete}`);
  },
});
```

A malformed token throws `KaguraAuthError`, whose message never quotes it.

#### Refreshing

Clients auto-refresh as tokens near expiry, so most code never calls this.
`refresh()` covers what skew-driven rotation cannot:

```ts
import { refresh, READ_ONLY_SCOPE } from "kagura-memory";

// Forced rotation — e.g. after an upstream 401, when the token was
// revoked out-of-band and is not yet inside the skew window.
await refresh();

// Narrow an existing grant, no re-consent needed.
await refresh({ scope: READ_ONLY_SCOPE });

// Widening needs fresh consent, so it re-runs the device flow.
await refresh({
  scope: "memory:read memory:write profile:read",
  onUserCode: ({ userCode, verificationUri }) =>
    console.log(`Open ${verificationUri} and enter ${userCode}`),
});
```

The stored refresh token, scope, and workspace identity are preserved when
the server omits them. An expired refresh token throws
`KaguraAuthExpiredError` and leaves the stored profile untouched.

Callers holding their own provider can use `KaguraOAuth` directly — its
`forceRefresh()` is what `refresh()` builds on, including the
cross-process lock and the "another process already rotated" dedup.

### Error handling

All errors extend `KaguraError`:

```ts
import { KaguraNotFoundError, KaguraRateLimitError } from "kagura-memory";

try {
  await client.recall({ contextId, query: "..." });
} catch (e) {
  if (e instanceof KaguraNotFoundError) {
    // context or memory missing
  } else if (e instanceof KaguraRateLimitError) {
    console.log(`retry after ${e.retryAfter}s`);
  }
}
```

Server-side domain errors (`{"status": "error", ...}`) are translated into
exceptions, so you never need to inspect `result.status`. The class is
keyed on the error code and the envelope's fields, never on the message:

| Class | Raised for | Carries |
|-------|------------|---------|
| `KaguraNotFoundError` | missing contexts/memories/reports/agents/bindings (on `updateSearchConfig`, a missing context is a `KaguraPermissionError` instead) | — |
| `KaguraFeatureNotAvailableError` | MCP `plan_required` / `feature_not_available`; REST 403 `FEAT-001` — the plan lacks a feature, or it is switched off | `feature`, `requiredPlan`, `requiredPlanDisplay`, `currentPlan`, `gate` |
| `KaguraQuotaError` | MCP `quota_exceeded` / `CONNECTOR-001`; REST `QUOTA-001`, `QUOTA-002` and `CONNECTOR-001` (the resource-token and connector seat caps answer **403**); any other 429 from a REST client but `SecretClient` | `quotaType`, `current`, `limit`, `usedToday`, `resetsAt`, `retryAfter`, and the plan fields above |
| `KaguraPartialRollbackError` | `rollbackSleepRun` reversed some actions but not all | `reportId`, `summary` |
| `KaguraPermissionError` | MCP `permission_denied` — usually the caller's role is too low. `updateSearchConfig` also sends it for a context that does not exist or that the caller cannot see. Only some tools send a role — `updateSearchConfig`, `updateContext`, `deleteContext`, the file tools and the analysis tools do not — so `requiredRole` is often `null`, and on `updateSearchConfig` it cannot tell a missing context from a role denial | `requiredRole` |
| `KaguraError` | any other code | — |

memory-cloud v0.75.0+ tags every plan and quota refusal with a `gate`
(`plan`, `quota`, `allowlist` or `deployment`), and the SDK chooses the
class from it first, falling back to the code for older servers. The
payload fields are `null` whenever the server did not send them. Against a
server older than v0.75.0, `current` and `limit` are read from the legacy
names the refusal carries instead (`used_today` / `limit_today`,
`owned_count` / `cap`, `active_connectors` / `max_connectors`).

Show `requiredPlanDisplay` (`"XL"`) to a user and decide with
`requiredPlan`, as long as `gate` is set. With a `gate`, both are `null`
when no plan lifts the refusal, which is what an `allowlist` or
`deployment` gate means, and a `quota` gate is set on every typed cap,
including one no tier raises, so an upgrade helps only when `requiredPlan`
is non-null. With no `gate`, a `null` `requiredPlan` means the plan is
unknown, not that no plan lifts it. That covers an older server, and
`createContext`'s own context-limit check, which reads `listContexts()`
and so fills in only `quotaType`, `current` and `limit`.

`retryAfter` is the `Retry-After` header, else the retry hint in the body
(REST `details.retry_after`, MCP `retry_after_seconds`, which is all the
resource events-per-hour quota sends), else it is derived from `resetsAt`
on a time-windowed quota such as `memories_per_day`. It is `null` on a
fixed cap that waiting will not lift.

An HTTP 429 keeps the class it always had on two surfaces.
`KaguraClient`'s own transport raises `KaguraRateLimitError` for the
per-minute rate limit and the daily call quota alike; from v0.75.0 the
quota also sets the `KaguraQuotaError` fields on it (`quotaType` is
`api_mcp_daily` or `api_rest_daily`), and they stay `null` on a
per-minute limit. `SecretClient` renders a 429 as `KaguraConnectionError`.

```ts
import { KaguraFeatureNotAvailableError, KaguraQuotaError } from "kagura-memory";

try {
  await client.setupResource({ resourceId: "crm" });
} catch (e) {
  if (e instanceof KaguraFeatureNotAvailableError) {
    // null when no plan lifts it (allowlist / deployment gate) or, with no gate, unknown.
    console.log(e.requiredPlanDisplay ? `upgrade to ${e.requiredPlanDisplay}` : e.message);
  } else if (e instanceof KaguraQuotaError) {
    console.log(`${e.quotaType}: ${e.current}/${e.limit}`);
  }
}
```

## `KaguraClient` method reference

Methods return the parsed server response. Most take a single camelCase
options object (optional for `listContexts` and `listMemories`);
`getAgent`, `deleteAgent`, `listAgentBindings` and `deleteContext` take
the id directly, and the workspace-wide calls (`listAgents`, `getUsage`,
`getServerInfo`, `checkServerVersion`, `getEmbeddingStatus`,
`listEmbeddingModels`, `getToolDefinitions`, `close`) take no arguments.
The wire stays snake_case; optional fields are omitted from the request
when `undefined`.

### Memories

| Method | What it does |
|--------|--------------|
| `remember` | Store a memory. `details` accepts arbitrary JSON, including `location` (see below) and the reserved `tool_trigger`, which marks a tool guardrail and needs context editor or above on a user (not agent) credential; `supersedes` declares this the newer version of an existing memory, shadowing the old one from default recall without destroying it; `deliveryMode: "always"` pins it. |
| `recall` | Hybrid semantic + keyword search. Takes `filters` (`type`, `scope`, `tags` with `tags_match` and `tags_normalize`, `importance` bounds, created/updated date bounds, `source_uri_prefix`, `source_type`, `trust_tier`, and the `near` / `within` geo filters), `searchMode`, `useRerank`, `includeExploreHints`, `includeSuperseded` (read back what `supersedes` shadowed, annotated with `superseded_by`), and `contextIds` for 2–20-context search. `useRerank` is tri-state (memory-cloud v0.69.0+): omit it to follow the context's search config (the first context's, with `contextIds`), `true` requests reranking where the context allows it, `false` skips it for the call. A tag filter that matches nothing can return `tag_suggestions`. When the semantic half is unavailable, the result is keyword-only and carries `degraded: true` and `degraded_reason` (v0.66.0+) — an empty one then means "search impaired", not "nothing stored". |
| `reference` | Full detail for one memory, under `result.memory`. |
| `updateMemory` | Update in place by `memoryId`, or upsert by `externalId`. `details` **replaces** the stored object wholesale — round-trip keys you want to keep; dropping `tool_trigger` turns a guardrail off. `dismissSupersedeCandidate: true` rejects the server's `supersede_candidate` suggestion; it needs `memoryId` and throws locally with `externalId`. |
| `forget` | Soft-delete by `memoryId` or by `query`. The rows are kept, but not restorable through the API, until the deployment's cleanup window passes (`CLEANUP_DELETED_MEMORIES_RETENTION_DAYS`, default 30 days). For a caller who may write to the workspace, a target it may not delete, or one already gone, is skipped silently — including every guardrail for a caller below context editor or on an agent credential — so `deleted_count` can be 0. A workspace viewer may not delete at all and is refused with `KaguraPermissionError` (`requiredRole: "member"`). |
| `listMemories` | Browse with substring, facet, and time-window filters. Omit `contextId` for the caller's cross-context view. |

### Deterministic lanes

These bypass ranking entirely — same inputs, same rows, every call. They are
the counterpart to `recall`'s probabilistic search.

| Method | Axis |
|--------|------|
| `loadPinned` | The complete, unranked `deliveryMode: "always"` set. Bounded: check `truncated` / `total_available` rather than assuming you got everything. |
| `loadGuardrails` | The set a client-side tool hook matches against (server v0.74.0+): the pinned set plus every memory carrying `details.tool_trigger`, in two separately capped lanes — `cap` bounds only the tool-triggered one, so pins never crowd guardrails out. Check `tool_triggered_truncated` / `pinned_truncated`. |
| `recallUpcoming` | WHEN — `type: "time"` memories whose window overlaps `from`/`until`, soonest first. Items carry `trigger`, not `details` (server v0.73.0+); `includeDetails: true` returns the full `details` object instead. |
| `recallNearby` | WHERE — memories near a point, nearest first with `distance_m`. See [the WHERE axis](#the-where-axis--geospatial-memories). |

### Tags and the neural graph

| Method | What it does |
|--------|--------------|
| `listTags` | Tag vocabulary with counts and recency. `prefix` narrows by spelling; `withTags` is a multi-tag AND drill-down that also excludes those tags from the result — the two compose into server-side faceted browsing with no local index. |
| `explore` | Graph traversal from a seed memory (`depth` 1–5, `minWeight`). |
| `listEdges` | Edges touching a memory, incoming and outgoing, deduplicated. |
| `createEdge` / `updateEdge` / `deleteEdge` | Manual edge curation. `(sourceId, targetId)` is the identity; self-loops are rejected. |
| `findDuplicates` | Near-duplicate pairs above `threshold` (0.5–1.0, default 0.90). |
| `feedback` | Record whether a recalled memory was useful — an append-only signal in its own lane, not a memory edit. |

### Contexts

| Method | What it does |
|--------|--------------|
| `listContexts` | The contexts you can see, most recently used first, as a slim name→id directory (`id`, `name`, `is_private`, `is_locked`, `last_used_at`; server v0.73.0+). `nameContains` filters (server v0.73.0+; older servers ignore it and return every context); `includeSummary` (capped at 300 chars), `includeDetails` (full `summary` + `embedding_model`) and `includeStats` (`memory_count`) add fields. `count` is quota usage and `total` the number returned; `can_create` is the quota flag, and `hint` appears when you can see no context. |
| `createContext` | New context. Throws `KaguraQuotaError` when the workspace limit is reached: the SDK checks `listContexts()` first, so that error carries `quotaType`, `current` and `limit` but no `gate` or plan fields (`requiredPlan` `null` means unknown). Also throws `KaguraFeatureNotAvailableError` for a shared one (`isPrivate: false`) on a plan without shared contexts (server v0.75.0+). `embeddingModel` cannot be changed through the API afterwards (an operator can migrate it server-side, v0.66.0+). |
| `getContextInfo` | Metadata plus, by default, a memory-count breakdown. On server v0.74.0+ also a trimmed `guardrails` block: absent when the MCP URL carries `?guardrails=off`, `null` when the server's read failed. |
| `updateContext` | Change display name, summary, usage guide, visibility, lock. `isPublic: true` is plan-gated and throws `KaguraFeatureNotAvailableError` on a plan without public contexts. |
| `deleteContext` | Delete by id. Locked contexts are refused. |
| `mergeContexts` | Move memories between contexts. Both must share an embedding model and workspace. |
| `updateSearchConfig` | Hybrid-search weights (must sum to 1.0 ±0.01), reranking (`useRerank`, which a `recall` that omits it follows) and the reranker (`voyage`, `cohere` or `self_hosted`), reinforce re-rank (`reinforceEnabled`, `reinforceMaxBoost`, `reinforceRequireHostArbitration`) and query routing (`routingMode`). Owner/editor only; a context that does not exist, or that the caller cannot see, also throws `KaguraPermissionError`. Returns the whole updated `config`, the only place the reinforce and routing fields come back. |
| `setupResource` | Context + resource entity + ingestion token in one transaction. The returned token is plaintext and shown once. Plan-gated: throws `KaguraFeatureNotAvailableError` on a plan without resources. |

### Agent run-state

Ephemeral, TTL-bounded, and excluded from recall — deliberately not memories.

| Method | What it does |
|--------|--------------|
| `setState` / `getState` | Key/value at `(contextId, key)`. Omit `key` on read to list all live keys. |

### Sleep maintenance

| Method | What it does |
|--------|--------------|
| `getSleepHistory` | Recent runs, newest first. |
| `getSleepReport` | One run in detail, including the per-action audit log. |
| `rollbackSleepRun` | Reverse a completed or degraded run. The server commits per step, so a partial rollback is possible: it throws `KaguraPartialRollbackError` instead of returning, and the steps it did reverse stay reversed. There is no retry: the report is now `failed`, and the server will not roll back a `failed` report again. `err.summary` has the same counts a clean run returns, and the actions in `err.summary.errors` were not reversed and need handling some other way. |

### Workspace and server

| Method | What it does |
|--------|--------------|
| `getServerInfo` | Version, deployment feature flags, and (v0.69.0+) the reranker defaults new contexts start with, under `search_defaults`. |
| `checkServerVersion` | Compare against `MIN_SERVER_VERSION` (0.75.0). Advisory: logs, never throws. |
| `getUsage` | Workspace quota and usage: `used` / `limit` for memories, contexts, members and today's MCP calls. |
| `getMemoryStats` | Per-memory usage stats, sortable and paged. |
| `getEmbeddingStatus` / `listEmbeddingModels` | Embedding backend state and the models available for `createContext`. |
| `getToolDefinitions` | Raw MCP `tools/list` output — every tool the server exposes, including any this SDK does not wrap yet. |
| `callRawTool` | Call any MCP tool by name — the escape hatch for tools with no typed wrapper. Args pass through verbatim (wire form: `context_id`, not `contextId`) and the result is untyped. Prefer a wrapper where one exists; use this so a missing one is a detour, not a dead end. |
| `close` | Drop the MCP session. The next call re-initializes automatically. |

Agent Registry and binding methods are covered in
[Agent control plane](#agent-control-plane-memory-cloud-v0490) below.

## Agent control plane (memory-cloud v0.49.0+)

`KaguraClient` wraps the RFC-0002 agent platform: the **Agent Registry**
(`registerAgent` / `listAgents` / `getAgent` / `updateAgent` /
`deleteAgent`), subtractive **context bindings** (`bindAgentContext` /
`listAgentBindings` / `updateAgentBinding` / `unbindAgentContext`), and
the session-start `getAgentBootstrap` call. Registry and binding methods are
**owner/admin-gated** server-side; `deleteAgent` is permanent and
cascades every API key bound to the agent (prefer
`updateAgent({ status: "retired" })` for operational retirement).

```ts
// One-time provisioning (owner/admin): register the agent, bind its context
const agent = await client.registerAgent({ name: "ci-agent", framework: "claude-code" });
await client.bindAgentContext({ agentId: agent.id, contextId: "ctx-uuid", isDefault: true });

// Session start: rehydrate cognitive state in one call
const bootstrap = await client.getAgentBootstrap({
  agentId: agent.id,          // contextId omitted → default binding
  sessionId: "run-42",        // echoed in the correlation block
  query: "session summary",   // enables the trusted-only recall component
});
if (bootstrap.degraded) {
  // some component failed fail-soft; inspect bootstrap.components
}
if (bootstrap.components?.recall?.degraded) {
  // the recall ran keyword-only (degraded_reason says why); this also sets
  // the top-level flag above, since server v0.66.0
}
```

Deployed agents holding only an API key (e.g. an agent-bound member key)
can bootstrap over REST without an MCP session:

```ts
import { AgentsClient } from "kagura-memory";

const agents = AgentsClient.fromMcpUrl();
const bootstrap = await agents.bootstrap({ agentId: "agent-uuid" });
```

Requires memory-cloud **v0.49.0+** — older servers return MCP "tool not
found" / REST 404 on this surface. The SDK as a whole targets v0.75.0
(see [Installation](#installation)).

## The WHERE axis — geospatial memories

Any memory can carry a location under `details.location`, which makes it
reachable from `recallNearby()` — a deterministic spatial query (nearest
first, each result carrying `distance_m`), not semantic search.

```ts
await client.remember({
  contextId,
  summary: "Coffee shop with reliable wifi",
  content: "...",
  details: { location: { lat: 35.6812, lon: 139.7671, label: "Tokyo Station" } },
});

const near = await client.recallNearby({ contextId, lat: 35.68, lon: 139.76, radiusM: 500 });
```

`lat`/`lon` must be JSON **numbers** — argument coercion does not recurse
into `details`, so `"35.68"` is rejected server-side with HTTP 422.
`recallNearby()` returns a typed `RecallNearbyResponse`
(`results[].distance_m`); `MemoryLocation` and `NearbyMemory` are exported
too. Out-of-range coordinates throw locally rather than round-tripping.

> **Gotcha:** `updateMemory()` replaces `details` **wholesale** — the
> server does not deep-merge. Round-trip `location` when updating details
> or the memory silently drops off the spatial axis.

## Zero-knowledge secrets

`SecretClient` is the fourth REST client, alongside Files, Resource and
Workspace. The server stores **only opaque ciphertext**: values are
encrypted to [age](https://age-encryption.org) recipients on your machine
and decrypted there, so a workspace admin — or the server operator — can
enumerate secret names and grants but never read a value.

```ts
import { SecretClient, KeyManager, decrypt } from "kagura-memory";

const secrets = SecretClient.fromMcpUrl();

// One-time: enroll this machine's age key and register the public half.
// `store` is yours to supply — see "Key custody is yours to wire" below.
const keys = new KeyManager({ store: myKeyStore });
const { recipient, fingerprint } = await keys.enroll();
await secrets.registerPubkey(recipient, "ci-runner");
// ...an owner approves it (verify `fingerprint` out of band first).

// Store a value, encrypted to every approved recipient.
const active = (await secrets.listPubkeys()).filter((p) => p.status === "active");
await secrets.putSecretForRecipients({
  name: "openai/api-key",
  plaintext: "sk-live-...",
  recipients: active,
});

// Read it back.
const { ciphertext } = await secrets.fetchSecret("openai/api-key");
const value = await decrypt(ciphertext, await keys.getIdentity());
```

Also: `listSecrets`, `revokeGrant`, `deleteSecret`, `verifyAudit`,
`approvePubkey` / `revokePubkey` / `listMyPubkeys`, and the low-level
`putSecret` when you want to build the grant lists yourself.

Names may contain `/` — `cloudflare/api-token` is addressable, and each
segment is percent-encoded so the separators stay structural. `deleteSecret`
rejects a name with an empty, `.`, or `..` segment rather than encoding it:
those are RFC 3986 *unreserved*, so encoding does not neutralize them and the
URL parser would resolve them away — `cloudflare/../openai` would have
deleted `openai`.

### The crypto package is opt-in

Encryption needs [`age-encryption`](https://www.npmjs.com/package/age-encryption)
(typage, by age's author — the counterpart of the Rust `pyrage` binding the
Python SDK uses). It is an **optional peer dependency**, so a plain
`npm install kagura-memory` still pulls in nothing:

```bash
npm install age-encryption
```

Everything except `putSecretForRecipients`, `encrypt`, `decrypt`,
`generateKeypair` and `recipientFromIdentity` works without it —
including the whole REST surface, `fingerprint()`, and the armor codec. Call
one of those without the package and you get a `KaguraCryptoError` naming
the install command, not a module-resolution stack trace.

> **On Node 18.** This SDK supports Node 18 and CI exercises the crypto
> round-trip there on every push. But `age-encryption`'s `@noble/*`
> dependencies declare `engines.node: ">= 20.19.0"`, so `npm install
> age-encryption` on Node 18 prints `EBADENGINE` warnings, and an
> `engine-strict=true` npmrc will refuse the install outright. It works —
> WebCrypto is not a global before Node 19, so the SDK installs
> `node:crypto`'s `webcrypto` itself — but if you want the warnings gone,
> use Node 20.19+.

Recipients are X25519-only. `age1pq1…` (post-quantum) and plugin
recipients are rejected even though `age-encryption` would accept them,
because `pyrage` cannot read them and the Python CLI has to be able to
decrypt whatever this SDK writes.

### Key custody is yours to wire

Whoever holds the age private key can decrypt every ciphertext ever shared
with the matching recipient, so `KeyManager` takes a `KeyStore` and this SDK
ships **no default backend**:

```ts
interface KeyStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}
```

The Python SDK defaults to the OS keychain via `keyring`. Node has no
stdlib equivalent, and every option is a native module — so a default here
would mean either a native runtime dependency or a plaintext file, and
Python explicitly refuses the latter. Asking you for a store keeps the
fail-closed property with no insecure fallback to land in by accident.
Back it with `keytar`/libsecret in an app, or with the ambient secret
manager in CI. Keys are stored under `identity:{profile}`, the same names
Python uses, so a shared backend interoperates.

## Relationship to the Python SDK

This package ports the Python SDK's core (client, auth, REST clients,
models, the zero-knowledge secret client) and, since 0.8.0, 17 of the
`kagura` CLI's 19 top-level commands — see [Command line](#command-line).

Two things are deliberately not ported, and both would cost the
zero-dependency promise:

- **The document-ingestion pipeline** (`FileIngestor`, `kagura ingest`),
  which needs text extraction from PDF, Office, EPUB and audio plus LLM
  providers.
- **`kagura process`**, which needs the litellm-backed agent.

(`KaguraAgent` was removed from the Python SDK in v0.37.0 — the actor role
lives in the [kagura-agent](https://pypi.org/project/kagura-agent/)
package, so it will not be ported here either.)

Use the Python SDK for those. Both SDKs share the same credential files
and server APIs, so they interoperate — with one exception, noted above:
age private keys are custodied differently and are **not** readable across
the two. See
[`docs/design/2026-07-05-typescript-port-design.md`](docs/design/2026-07-05-typescript-port-design.md)
for the original scope decisions.

## Development

```bash
npm install
npm test                   # vitest
npm run test:no-webcrypto  # the same suite with globalThis.crypto deleted
npm run typecheck          # tsc --noEmit
npm run build              # tsup → dist/ (ESM + CJS + d.ts)
```

`test:no-webcrypto` reproduces Node 18, which has no WebCrypto global —
the crypto path installs `node:crypto`'s `webcrypto` itself, and that used
to break in CI only. `prepublishOnly` runs all four.

## License

MIT
