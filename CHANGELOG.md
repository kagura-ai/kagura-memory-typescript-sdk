# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0] - 2026-08-01

### Added

- **The `kagura-memory` bin now mirrors the Python `kagura` CLI** — 17 of its
  19 top-level commands, 59 subcommands, up from the five `auth` ones 0.7.0
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
shipped: an adversarial pass (eight confirmed, one refuted) plus two rounds
of Copilot on the PR.

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

[Unreleased]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.3.0...v0.5.0
[0.3.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kagura-ai/kagura-memory-typescript-sdk/releases/tag/v0.1.0
