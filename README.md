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
| **`AgentsClient`** | REST API | Agent bootstrap for API-key-only callers (no MCP session) |

## Installation

```bash
npm install kagura-memory
```

Requires Node.js >= 18 (native `fetch`). Zero runtime dependencies.

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

#### Logging in from TypeScript

`login()` runs the OAuth 2.0 Device Authorization Grant (RFC 8628) and
writes `~/.kagura/credentials.json` in exactly the format the Python CLI
writes — no Python install needed, and the profile stays interchangeable
between both SDKs.

```ts
import { login, KaguraClient } from "kagura-memory";

const creds = await login({
  // Read-only by default; ask for writes explicitly.
  scope: "memory:read memory:write",
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

Nothing is written unless the exchange succeeds *and* yields a refresh
token, so a failed login never disturbs an existing profile: a denial
throws `KaguraAuthDeniedError`, an unapproved expiry throws
`KaguraAuthExpiredError`, and a response without a `refresh_token` throws
`KaguraAuthError` rather than persisting a profile that could never
auto-refresh.

For a custom flow (your own polling UI, multi-profile management), the
primitives are exported too: `authorizeDevice`, `pollForToken`,
`refreshAccessToken`, `revokeToken`, plus the credentials store
(`loadCredentialsFile`, `updateProfile`, `setDefaultProfile`,
`deleteProfile`, …).

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
exceptions — `KaguraNotFoundError` for missing contexts/memories/reports/
agents/bindings, `KaguraError` otherwise — so you never need to inspect
`result.status`.

## `KaguraClient` method reference

Methods return the parsed server response. Most take a single camelCase
options object; `getAgent`, `deleteAgent`, `listAgentBindings` and
`deleteContext` take the id directly, and the workspace-wide calls
(`listContexts`, `listAgents`, `getUsage`, `getServerInfo`,
`checkServerVersion`, `getEmbeddingStatus`, `listEmbeddingModels`,
`getToolDefinitions`, `close`) take no arguments. The wire stays
snake_case; optional fields are omitted from the request when `undefined`.

### Memories

| Method | What it does |
|--------|--------------|
| `remember` | Store a memory. `details` accepts arbitrary JSON (including `location`, see below); `supersedes` declares this the newer version of an existing memory, shadowing the old one from default recall without destroying it; `deliveryMode: "always"` pins it. |
| `recall` | Hybrid semantic + keyword search. Takes `filters` (`type`, `tags`, `tags_match`, date bounds, `trust_tier`), `searchMode`, `useRerank`, `includeExploreHints`, and `contextIds` for 2–20-context search. |
| `reference` | Full detail for one memory, under `result.memory`. |
| `updateMemory` | Update in place by `memoryId`, or upsert by `externalId`. `details` **replaces** the stored object wholesale — round-trip keys you want to keep. |
| `forget` | Soft-delete (30-day retention) by `memoryId` or by `query`. |
| `listMemories` | Browse with substring, facet, and time-window filters. Omit `contextId` for the caller's cross-context view. |

### Deterministic lanes

These bypass ranking entirely — same inputs, same rows, every call. They are
the counterpart to `recall`'s probabilistic search.

| Method | Axis |
|--------|------|
| `loadPinned` | The complete, unranked `deliveryMode: "always"` set. Bounded: check `truncated` / `total_available` rather than assuming you got everything. |
| `recallUpcoming` | WHEN — `type: "time"` memories whose window overlaps `from`/`until`, soonest first. |
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
| `listContexts` | All contexts, with the workspace's `can_create` quota flag. |
| `createContext` | New context. Throws `KaguraQuotaError` when the workspace limit is reached. `embeddingModel` is immutable afterwards. |
| `getContextInfo` | Metadata plus, by default, a memory-count breakdown. |
| `updateContext` | Change display name, summary, usage guide, visibility, lock. |
| `deleteContext` | Delete by id. Locked contexts are refused. |
| `mergeContexts` | Move memories between contexts. Both must share an embedding model and workspace. |
| `updateSearchConfig` | Hybrid-search weights (must sum to 1.0 ±0.01). Owner/editor only. |
| `setupResource` | Context + resource entity + ingestion token in one transaction. The returned token is plaintext and shown once. |

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
| `rollbackSleepRun` | Reverse a completed run. The server commits per step, so a partial rollback is possible — read the returned summary. |

### Workspace and server

| Method | What it does |
|--------|--------------|
| `getServerInfo` | Version and capabilities. |
| `checkServerVersion` | Compare against `MIN_SERVER_VERSION`. Advisory: logs, never throws. |
| `getUsage` | Workspace quota and usage. |
| `getMemoryStats` | Per-memory usage stats, sortable and paged. |
| `getEmbeddingStatus` / `listEmbeddingModels` | Embedding backend state and the models available for `createContext`. |
| `getToolDefinitions` | Raw MCP `tools/list` output — every tool the server exposes, including any this SDK does not wrap yet. |
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
```

Deployed agents holding only an API key (e.g. an agent-bound member key)
can bootstrap over REST without an MCP session:

```ts
import { AgentsClient } from "kagura-memory";

const agents = AgentsClient.fromMcpUrl();
const bootstrap = await agents.bootstrap({ agentId: "agent-uuid" });
```

Requires memory-cloud **v0.49.0+** — older servers return MCP "tool not
found" / REST 404 on this surface; everything else in the SDK keeps
working against `MIN_SERVER_VERSION`.

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

## Relationship to the Python SDK

This package ports the Python SDK's core (client, auth, REST clients,
models). Not yet ported: the `kagura` CLI, the document-ingestion
pipeline (`FileIngestor`), and the zero-knowledge secrets client.
(`KaguraAgent` was removed from the Python SDK in v0.37.0 — the actor
role lives in the [kagura-agent](https://pypi.org/project/kagura-agent/)
package, so it will not be ported here.) Use the Python SDK for those;
both SDKs share the same credential files and server APIs. See
[`docs/design/2026-07-05-typescript-port-design.md`](docs/design/2026-07-05-typescript-port-design.md)
for the scope decisions.

## Development

```bash
npm install
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # tsup → dist/ (ESM + CJS + d.ts)
```

## License

MIT
