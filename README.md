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

Three ways to authenticate, in resolution order:

1. **Explicit key** — `new KaguraClient({ apiKey: "kagura_..." })`
2. **Environment** — `KAGURA_API_KEY` (+ optional `KAGURA_MCP_URL`)
3. **OAuth profile** — `~/.kagura/credentials.json`, written by the Python
   CLI's `kagura auth login`. Profiles (`KAGURA_PROFILE` env or
   `{ profile: "name" }`) and auto-refresh work exactly like the Python SDK;
   the credentials file is shared between both SDKs.
4. **Config file** — `.kagura.json` in the working directory or home:

```json
{
  "api_key": "kagura_your_api_key",
  "mcp_url": "https://memory.kagura-ai.com/mcp"
}
```

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

## Agent control plane (memory-cloud v0.49.0+)

`KaguraClient` wraps the RFC-0002 agent platform: the **Agent Registry**
(`registerAgent` / `listAgents` / `getAgent` / `updateAgent` /
`deleteAgent`), subtractive **context bindings** (`bindAgentContext` /
`listAgentBindings` / `updateAgentBinding` / `unbindAgentContext`), and
the session-start **bootstrap** call. Registry and binding methods are
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
