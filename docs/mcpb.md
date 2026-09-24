# Kagura Memory for Claude Desktop

This extension connects Claude Desktop to Kagura Memory Cloud. It requires a
Kagura account with workspace access and a Claude Desktop version that supports
MCPB extensions on Windows or macOS. Claude Desktop supplies Node.js; Python,
npm and a globally installed Kagura CLI are not needed to run the bundle.

## Install and sign in

1. Download `kagura-memory-VERSION.mcpb` and its SHA-256 checksum from the
   [GitHub release](https://github.com/kagura-ai/kagura-memory-typescript-sdk/releases).
   Before the first release containing this feature, build it from source below
   or use the `MCPB` artifact attached to the pull request's CI run.
2. Open the `.mcpb` file with Claude Desktop and accept installation. Keep
   **OAuth profile** as `desktop` and **Kagura MCP server** as
   `https://memory.kagura-ai.com/mcp`, or configure your own HTTPS MCP endpoint.
3. Enable the extension. On first connection your browser opens. Sign in,
   confirm the displayed device code, select the intended workspace and approve.
   The consent screen determines the access you grant.
4. If Claude reports a connection timeout while you are signing in, restart the
   extension. A completed login is saved and reused on the next connection.
5. Ask Claude to list your Kagura contexts, then recall a memory from one of them.

The extension forwards requests to the configured server, including memory
content and search queries. It does not store memories locally. OAuth credentials
are stored in `~/.kagura/credentials.json`, shared with the Python and TypeScript
CLIs. File permissions are restricted where supported; on Windows they inherit
your user's filesystem ACLs. Treat this file as a secret. Uninstalling the
extension does not delete the shared profile or revoke its grant.

## Profiles and connection failures

- To reuse an existing login, choose that profile name and its matching server.
  Use a different profile when connecting to a different server/account. A server
  override cannot reuse a profile from another server.
- An expired refresh token starts one new browser login per process. Denial,
  expiry or connection errors stop that attempt; restart to try again. It will
  not repeatedly open browser tabs. Default login deadline: five minutes.
- If no browser opens, the host's MCP logs contain a verification URL and code.
  Open that URL manually. Authentication prompts and diagnostics use stderr;
  stdout contains only MCP messages.
- If the host cannot keep the first-login connection open, users with npm can
  authenticate before enabling the extension:
  `npx kagura-memory auth login --profile desktop --server https://memory.kagura-ai.com/mcp`.
- Use `kagura-memory auth logout --profile desktop` (if the CLI is installed)
  to revoke the grant (best effort) and remove that shared profile. Use your
  server's account settings if revocation fails. Restart the extension to sign in again.
- Self-hosted installations need a registered device-flow client compatible
  with the Kagura CLI. Configure HTTPS; plain HTTP is accepted only on loopback
  for development. Redirects are rejected; enter the final MCP endpoint.

## Standalone stdio command

The npm package also installs `kagura-memory-mcp` (separate from Python's
`kagura-mcp`). Run `kagura-memory-mcp --help` for options. It uses the credentials
file's default profile when `--profile` is omitted. `--no-login` disables device
login; `--no-browser` leaves manual URL/code login available. `--credentials`
selects an alternate credentials file; `--login-timeout` controls the deadline.
Proxy options are explicit: API-key environment variables and project-local
`.kagura.json` are not used. Endpoint query options can be included in `--server`.

The bridge forwards Cloud tools and schemas without a local registry. It handles
JSON and POST SSE responses, including progress and server requests, refreshes
once after HTTP 401, and reinitializes once after a session HTTP 404. It does not
retry ambiguous network failures or server errors, which could duplicate writes.
Each HTTP request has a 60-second deadline. Closing stdin stops pending work.
Standalone GET event subscriptions and SSE reconnection/replay are not supported.

## Build and automated validation

```sh
npm ci
npm run typecheck
npm test
npm run test:no-webcrypto
npm run build:mcpb
npm run test:mcpb
```

The bundle is written to `artifacts/` alongside a SHA-256 checksum. The build
validates the manifest with the pinned official MCPB schema, bundles the proxy
as one CommonJS file, and packs only the manifest, server, license and this guide.
Version comes from `package.json`. Fixed ZIP timestamps, permissions and entry
order make repeated builds reproducible. No runtime dependencies are bundled.

`test:mcpb` extracts the actual archive to a temporary directory outside the
checkout and launches the manifest entrypoint against a local mock OAuth/MCP
server. It checks first login, profile reuse, tools/list and tools/call, SSE,
refresh, session recovery, errors and stdout hygiene. CI runs this on Windows and
macOS. It does not sign in to a real account or automate Claude Desktop's UI.

## Desktop release checklist

Record OS, Claude Desktop version, bundle SHA-256 and result for each platform:

- Install the packed bundle on Windows and macOS without Python/global CLI.
- Fresh profile: browser opens, correct code/workspace is shown, approval connects.
- Deny login and retry by restarting; complete a login after a host timeout.
- Restart with an existing profile: no unnecessary browser prompt.
- Discover tools, list contexts and recall in the intended workspace.
- Expired access token refreshes; revoked grant offers fresh consent.
- Uninstall/reinstall behavior preserves shared credentials as documented.

Automated smoke tests do not replace these host checks. Keep an unverified
platform marked pending in the PR until someone records its actual result.
