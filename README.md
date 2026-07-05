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
exceptions — `KaguraNotFoundError` for missing contexts/memories/reports,
`KaguraError` otherwise — so you never need to inspect `result.status`.

## Relationship to the Python SDK

This package ports the Python SDK's core (client, auth, REST clients,
models). Not yet ported: the `kagura` CLI, `KaguraAgent` (LLM-driven
memory), the document-ingestion pipeline (`FileIngestor`), and the
zero-knowledge secrets client. Use the Python SDK for those; both SDKs
share the same credential files and server APIs. See
`docs/superpowers/specs/2026-07-05-typescript-port-design.md` for the
scope decisions.

## Development

```bash
npm install
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # tsup → dist/ (ESM + CJS + d.ts)
```

## License

MIT
