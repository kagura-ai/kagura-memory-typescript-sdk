/**
 * The boilerplate every data subcommand shares — a port of
 * `_run_client_command` in the Python CLI's `cli.py`.
 *
 * Config load, context resolution, client lifecycle, JSON output and
 * error-to-exit-code mapping live here so that the commands themselves are
 * one call each and cannot drift apart in how they report failure.
 */

import type { KaguraClient, KaguraClientOptions } from "../client.js";
import { loadConfig as loadConfigImpl, type KaguraConfig } from "../config.js";
import type { FilesClient } from "../filesClient.js";
import type { ResourceClient } from "../resourceClient.js";
import type { SecretClient } from "../secrets/client.js";
import { excMessage } from "../errors.js";
import { formatJson } from "./output.js";
import { CliError, CliUsageError } from "./parse.js";

/** Verbatim from the Python CLI, so the fix instruction is identical. */
export const NO_CONTEXT_MESSAGE = "context_id required. Use --context-id or set in .kagura.json";

export interface ClientCommandContext {
  write: (line: string) => void;
  writeError: (line: string) => void;
  /** Injected so tests need no `.kagura.json` on disk. */
  loadConfig: typeof loadConfigImpl;
  /** Injected so tests can supply a fetch stub. */
  makeClient: (options: KaguraClientOptions) => KaguraClient;
  /** REST counterparts, for the `files`, `resource` and `secret` groups. */
  makeFilesClient: (options: RestClientOptions) => FilesClient;
  makeResourceClient: (options: RestClientOptions) => ResourceClient;
  makeSecretClient: (options: RestClientOptions) => SecretClient;
  /**
   * True when stdout is a terminal.
   *
   * The secret commands refuse to print plaintext to one; injected so a
   * test can assert both sides of that guard.
   */
  isTty: () => boolean;
  /** Read all of stdin, or null when it is a terminal / already closed. */
  readStdin: () => string | null;
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

/** What the CLI passes to a REST client; a subset of its options. */
export interface RestClientOptions {
  apiKey?: string;
  baseUrl?: string;
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

/** The REST-client options a config produces, empties omitted. */
export function restOptions(config: KaguraConfig): RestClientOptions {
  const options: RestClientOptions = {};
  if (config.api_key) options.apiKey = config.api_key;
  return options;
}

/**
 * The MCP-client options a config produces.
 *
 * Separate from {@link restOptions} because the MCP client also needs
 * `mcp_url`: passing it the REST options would silently drop a
 * self-hosted server and send the call to the default cloud one.
 */
export function mcpOptions(config: KaguraConfig): KaguraClientOptions {
  // Python: `api_key=config.get("api_key") or None`. An empty value must be
  // omitted, not forwarded — `Authorization: Bearer ` always 401s, and
  // omitting lets the OAuth profile resolve instead.
  const options: KaguraClientOptions = {};
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
    throw e instanceof CliError || e instanceof CliUsageError ? e : new CliError(excMessage(e));
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
 *   forwarded verbatim rather than as a stack trace.
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
    throw e instanceof CliError || e instanceof CliUsageError ? e : new CliError(excMessage(e));
  } finally {
    // The Python helper uses `async with client:`; a leaked MCP session
    // keeps the process alive past the command.
    await client.close();
  }
}
