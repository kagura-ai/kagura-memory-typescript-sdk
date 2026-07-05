# kagura-memory TypeScript SDK — v0.1.0 port design

Date: 2026-07-05
Source: `~/works/kagura-memory-python-sdk` (kagura-memory v0.36.0, ~18k lines)
Goal: TypeScript port of the SDK, installable via `npm install kagura-memory`.

Authored autonomously under a /goal directive; open questions are resolved
here as explicit scope decisions rather than user Q&A.

## Scope — v0.1.0 (this port)

In scope (the "core SDK" — everything a Node/TS agent needs to talk to
Kagura Memory Cloud):

| Python module | TS module | Notes |
|---|---|---|
| `exceptions.py` | `src/errors.ts` | Error class hierarchy (KaguraError…) |
| `config.py` | `src/config.ts` | `.kagura.json` / env loading |
| `_http.py` | `src/http.ts` | URL/detail/status-mapping helpers |
| `_auth.py` | `src/auth/resolve.ts` | Credential precedence chain |
| `auth/credentials.py` | `src/auth/credentials.ts` | `~/.kagura/credentials.json`, profiles, OAuth refresh |
| `auth/device_flow.py` | `src/auth/deviceFlow.ts` | RFC 8628 device flow |
| `_filelock.py` | `src/auth/filelock.ts` | Lock for credentials writes |
| `models.py` | `src/models.ts` | Pydantic models → TS interfaces |
| `client.py` | `src/client.ts` | `KaguraClient` — MCP JSON-RPC + REST GETs |
| `_rest_base.py` | `src/restBase.ts` | Shared REST client spine |
| `files_client.py` | `src/filesClient.ts` | R2 uploads w/ sha256 binding |
| `resource_client.py` | `src/resourceClient.ts` | Resource tokens + events |
| `workspace_client.py` | `src/workspaceClient.ts` | Members/invitations/keys |

Out of scope for v0.1.0 (deliberate, revisit later):

- **`agent.py` (KaguraAgent)** — depends on litellm; a TS equivalent would
  pick a different LLM abstraction. Separate design needed.
- **CLI (`cli.py`, `auth/cli.py`, `doctor.py`, `setup_claude.py`,
  `secrets/cli.py`)** — the goal is an npm *library*; a `kagura` bin can
  layer on top in a later minor. Python CLI remains the tool of record.
- **Ingest pipeline (`ingest/*`)** — extractors need JS parser deps
  (pdfjs, mammoth, …) and LLM providers; large independent effort.
- **Secrets (`secrets/*`)** — age crypto + OS keychain custody need
  careful dependency choices (no home-grown crypto); defer.
- **`mcp_proxy.py`, `logger.py`, `prompts.py`** — CLI/agent support.

## Decisions

1. **Package name `kagura-memory`** (matches PyPI; unclaimed on npm).
   Repo `kagura-memory-typescript-sdk`. License MIT, same author.
2. **Runtime: Node >= 18** — native `fetch`; **zero runtime dependencies**.
   No httpx equivalent, no pydantic equivalent.
3. **No runtime validation layer** (no zod). Python's pydantic models
   become TS interfaces; responses are cast, the server stays the source
   of truth. Non-JSON / error envelopes are still mapped to typed errors
   exactly like the Python `_http.py` / `_rest_base.py` logic.
4. **API shape**: same client names and method names (`remember`,
   `recall`, `listContexts`…), method names camelCased per TS idiom.
   Multi-arg Python signatures become a single required-args +
   options-object signature; option keys are camelCase, converted to the
   snake_case wire keys internally (mirroring Python's `arguments` dicts,
   including "only send non-defaults" behaviors).
5. **Auth parity**: same precedence — explicit `apiKey` > `KAGURA_API_KEY`
   > OAuth profile in `~/.kagura/credentials.json` (profile arg >
   `KAGURA_PROFILE` > default, with the multi-profile ambiguity
   warning and `KAGURA_REQUIRE_PROFILE` strict mode) > `.kagura.json`.
   Credential files are shared with the Python CLI — a `kagura auth
   login` from Python works for the TS SDK unchanged.
6. **Auth abstraction**: httpx.Auth doesn't exist here. An `AuthProvider`
   interface (`getAuthHeader(): Promise<string>`) replaces it; the OAuth
   implementation refreshes within the same skew window and coordinates
   via an in-process mutex keyed by credentials path. Cross-process
   locking uses a lockfile like the Python `_filelock.py`.
7. **Construction is synchronous** (sync fs reads for config/credentials,
   like Python). All network methods are async. `close()` +
   `Symbol.asyncDispose` for lifecycle ( ~ `async with`).
8. **Testability**: every client accepts an optional `fetch`
   implementation in its options (default `globalThis.fetch`) — the TS
   analogue of httpx `MockTransport` used throughout the Python tests.
9. **Build/test toolchain**: tsup (dual ESM + CJS + d.ts), vitest,
   TypeScript strict. `npm pack` + tarball install smoke test is part of
   the verification gate.
10. **Versioning starts at 0.1.0** — this is a new package, not a port of
    the Python version number.

## Architecture

```
src/
  errors.ts        // KaguraError hierarchy
  config.ts        // loadConfig()
  http.ts          // baseUrlFromMcp, extractDetail, validateHttpsUrl,
                   // retryAfterSeconds, raiseForKaguraStatus, SDK_VERSION
  models.ts        // all response/request interfaces
  auth/
    types.ts       // AuthProvider interface, StaticAuth/OAuthAuth results
    filelock.ts    // cross-process lockfile
    credentials.ts // credentials.json load/save, KaguraOAuth (refresh)
    deviceFlow.ts  // device authorization grant
    resolve.ts     // resolveAuth() precedence chain
  client.ts        // KaguraClient (MCP JSON-RPC session + tools + REST GETs)
  restBase.ts      // KaguraRestClient spine (_request, error hooks)
  filesClient.ts   // FilesClient
  resourceClient.ts// ResourceClient
  workspaceClient.ts// WorkspaceClient
  index.ts         // public exports (mirrors Python __init__.py minus
                   // excluded modules)
```

Data flow (KaguraClient): `initialize` JSON-RPC → capture
`mcp-session-id` header → `tools/call` with session header → parse
`result.content[0].text` as JSON → translate `{"status":"error"}`
domain envelopes into `KaguraNotFoundError`/`KaguraError` (#180
semantics preserved).

Error handling parity: 401→KaguraAuthError, 429→KaguraRateLimitError
(client) / KaguraQuotaError (REST spine) with numeric Retry-After,
404→KaguraNotFoundError, other→KaguraConnectionError; detail extraction
handles FastAPI `detail` strings/lists and the canonical
`{error,message,details}` envelope; credential-shaped 403 details are
scrubbed (`sanitizeServerDetail`).

Testing: vitest unit tests per module with a stubbed `fetch`, mirroring
the Python test suite's coverage of: auth precedence chain, session
init + tool call flow, domain-error translation, status mapping,
Retry-After parsing, HTTPS enforcement (incl. the `localhost.evil.com`
prefix-attack cases), config loading, credentials round-trip, and
refresh logic. Target: every exported function has at least one test;
port the load-bearing Python test cases rather than inventing new ones.

## Verification gate (definition of "npm installできる")

1. `npm run build` produces `dist/` with ESM + CJS + `.d.ts`.
2. `npm test` green.
3. `npm pack` → install the tarball into a scratch project →
   `require("kagura-memory")` and `import "kagura-memory"` both resolve,
   expose `KaguraClient`, and `tsc` accepts the types.
