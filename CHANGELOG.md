# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-07-28

### Added

- **Interactive OAuth login**
  ([#9](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/9)):
  `login()` runs the RFC 8628 Device Authorization Grant end to end
  (authorize → hand the user code to the host app via `onUserCode` →
  poll → persist) and writes `~/.kagura/credentials.json` in exactly the
  format the Python CLI writes, so profiles stay interchangeable. A
  TypeScript-only consumer no longer needs the Python CLI to obtain
  credentials. No terminal IO and no browser launching inside the SDK.
  Nothing is written unless the exchange succeeds *and* returns a refresh
  token — a response without one throws `KaguraAuthError` instead of
  persisting a profile that could never auto-refresh — so a failed login
  never disturbs an existing profile.

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

[Unreleased]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/releases/tag/v0.1.0
