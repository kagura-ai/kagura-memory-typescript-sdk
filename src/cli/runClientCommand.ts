/**
 * The boilerplate every data subcommand shares — a port of
 * `_run_client_command` in the Python CLI's `cli.py`.
 *
 * Config load, context resolution, client lifecycle, JSON output and
 * error-to-exit-code mapping live here so that the commands themselves are
 * one call each and cannot drift apart in how they report failure.
 */

import type { resolveAuth as resolveAuthImpl } from "../auth/resolve.js";
import type { ResolvedAuth } from "../auth/types.js";
import type { KaguraClient, KaguraClientOptions } from "../client.js";
import { isEnvFallbackConfig, loadConfig as loadConfigImpl, type KaguraConfig } from "../config.js";
import type { FilesClient } from "../filesClient.js";
import type { MemoryClient } from "../memoryClient.js";
import type { ResourceClient } from "../resourceClient.js";
import type { SecretClient } from "../secrets/client.js";
import type { WorkspaceClient } from "../workspaceClient.js";
import { excMessage } from "../errors.js";
import { cliErrorMessage, formatJson } from "./output.js";
import { CliError, CliUsageError } from "./parse.js";

/**
 * Verbatim from the Python CLI's `_require_context_id`, so the fix
 * instruction is identical. It names neither `--context-id` nor a
 * positional argument: commands take the context either way.
 */
export const NO_CONTEXT_MESSAGE =
  "context_id required. Pass the context ID or set context_id in .kagura.json";

export interface ClientCommandContext {
  write: (line: string) => void;
  writeError: (line: string) => void;
  /** Injected so tests need no `.kagura.json` on disk. */
  loadConfig: typeof loadConfigImpl;
  /** Injected so tests can supply a fetch stub. */
  makeClient: (options: KaguraClientOptions) => KaguraClient;
  /**
   * The SDK credential chain (env > OAuth profile > .kagura.json), for a
   * command that has to know which source won before it builds a client:
   * an API key belongs to one workspace, so the workspace a command
   * targets must come from the same source (#115). See
   * `credentialSource.ts`. Injected so tests can fake any source without
   * credential files.
   */
  resolveAuth: typeof resolveAuthImpl;
  /**
   * REST counterparts, for the `files`, `resource`, `secret`, `guardrails`
   * and `workspace` groups.
   *
   * Called with no credential, they run the chain themselves through
   * `fromMcpUrl`, which stamps the MCP URL the chosen branch belongs to.
   * Bare construction would throw without a static api_key — so every
   * REST command would fail for anyone who authenticated with `auth
   * login` — and leave `resource setup` permanently broken, since it needs
   * that stamped URL. Called with the credential from {@link resolveAuth},
   * they are built from exactly that one (and the workspace hint its 403
   * messages show), so a command that paired a workspace with a source
   * talks to the server with that same source.
   *
   * Python is explicit here and carries a note from its own review: pass
   * no mcp_url, so each resolver branch pairs its credential with its own
   * URL source. Forwarding the config file's mcp_url would override an
   * OAuth profile bound to a non-default server.
   */
  makeFilesClient: (auth?: ResolvedAuth, workspaceIdHint?: string | null) => FilesClient;
  makeResourceClient: (auth?: ResolvedAuth) => ResourceClient;
  makeSecretClient: () => SecretClient;
  makeMemoryClient: (auth?: ResolvedAuth) => MemoryClient;
  makeWorkspaceClient: (auth?: ResolvedAuth, workspaceIdHint?: string | null) => WorkspaceClient;
  /**
   * True when stdout is a terminal.
   *
   * The secret commands refuse to print plaintext to one; injected so a
   * test can assert both sides of that guard.
   */
  isTty: () => boolean;
  /**
   * Read all of stdin, or null when it is a terminal. A read that fails is
   * null too, unless `throwOnError` is set: then it throws, so the caller
   * can say why (`resource import`'s `Failed to read input: …`).
   */
  readStdin: (options?: { throwOnError?: boolean }) => string | null;
  /**
   * Run a child with extra environment; resolves to its exit code.
   *
   * `unset` names variables to REMOVE from the inherited environment. It
   * exists for the age identity: a tool handed one secret through `--as`
   * must not also receive the key that decrypts every other secret.
   */
  spawnChild: (
    command: string,
    argv: string[],
    env: Record<string, string>,
    unset: readonly string[],
  ) => Promise<number>;
}

/**
 * Resolve config + context the way `_run_client_command` does, without
 * building an MCP client — the REST groups need the same front half.
 *
 * @throws CliError with the Python message when no context resolves.
 */
export function resolveConfig(
  ctx: ClientCommandContext,
  contextId: string | undefined,
  needsContext = true,
): { config: KaguraConfig; contextId: string } {
  let config: KaguraConfig;
  try {
    config = ctx.loadConfig();
  } catch (e) {
    // A malformed .kagura.json is a real failure; reporting it here beats
    // letting it surface later as an unrelated auth error.
    throw new CliError(excMessage(e));
  }
  if (!needsContext) return { config, contextId: "" };

  // Python: `context_id or config.get("context_id") or ""`. An empty
  // string is falsy there, so `--context-id=` falls through to the config
  // rather than being sent as a blank context.
  const resolved = contextId || config.context_id || "";
  if (!resolved) throw new CliError(NO_CONTEXT_MESSAGE);
  return { config, contextId: resolved };
}

/**
 * The MCP-client options a config produces.
 *
 * Only the MCP client takes options: the REST clients go through
 * `fromMcpUrl`, which resolves everything itself. This one needs a file's
 * `mcp_url` explicitly, and forgetting it silently drops a self-hosted
 * server and sends the call to the default cloud one.
 *
 * Without a `.kagura.json`, nothing: the config is then loadConfig's
 * environment fallback, whose `mcp_url` (`KAGURA_MCP_URL` or the default)
 * would override an OAuth profile's own server, sending the profile's
 * token to the default one, as Python's CLI does. The client's resolver
 * pairs each credential with its own URL instead, and gives
 * `KAGURA_API_KEY` the same `KAGURA_MCP_URL` or default as before.
 */
export function mcpOptions(config: KaguraConfig): KaguraClientOptions {
  const options: KaguraClientOptions = {};
  if (isEnvFallbackConfig(config)) return options;
  // Python: `api_key=config.get("api_key") or None`. An empty value must be
  // omitted, not forwarded — `Authorization: Bearer ` always 401s, and
  // omitting lets the OAuth profile resolve instead.
  if (config.api_key) options.apiKey = config.api_key;
  if (config.mcp_url) options.mcpUrl = config.mcp_url;
  return options;
}

/**
 * Run an operation and print its result, mapping failures the same way
 * `runClientCommand` does. For commands that build their own client.
 */
export async function runAndPrint(
  ctx: ClientCommandContext,
  operation: () => Promise<unknown>,
): Promise<number> {
  try {
    const result = await operation();
    ctx.write(formatJson(result));
    return 0;
  } catch (e) {
    throw e instanceof CliError || e instanceof CliUsageError ? e : new CliError(cliErrorMessage(e));
  }
}

export interface RunClientCommandOptions {
  /**
   * `false` for commands that operate on the workspace rather than one
   * context (`list_contexts`, `get_usage`, …), matching the Python
   * helper's `needs_context` keyword.
   */
  needsContext?: boolean;
}

/**
 * Run one client operation and print it.
 *
 * @returns 0, with the result printed as JSON on stdout.
 * @throws CliError for every expected failure. Reporting is the router's
 *   job so the `Error: ` prefix and the exit code are decided in exactly
 *   one place; Kagura errors carry their own next-step guidance and are
 *   forwarded verbatim rather than as a stack trace, with a quota or plan
 *   refusal's `Resets at:` / `Required plan:` lines (`cliErrorMessage`).
 */
export async function runClientCommand(
  ctx: ClientCommandContext,
  contextId: string | undefined,
  operation: (client: KaguraClient, contextId: string) => Promise<unknown>,
  options: RunClientCommandOptions = {},
): Promise<number> {
  const { config, contextId: resolvedContext } = resolveConfig(
    ctx,
    contextId,
    options.needsContext ?? true,
  );

  const client = ctx.makeClient(mcpOptions(config));
  try {
    const result = await operation(client, resolvedContext);
    ctx.write(formatJson(result));
    return 0;
  } catch (e) {
    throw e instanceof CliError || e instanceof CliUsageError ? e : new CliError(cliErrorMessage(e));
  } finally {
    // The Python helper uses `async with client:`; a leaked MCP session
    // keeps the process alive past the command.
    await client.close();
  }
}
