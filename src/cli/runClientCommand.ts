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
  const needsContext = options.needsContext ?? true;

  let config: KaguraConfig;
  try {
    config = ctx.loadConfig();
  } catch (e) {
    // A malformed .kagura.json is a real failure; reporting it here beats
    // letting it surface later as an unrelated auth error.
    throw new CliError(excMessage(e));
  }

  let resolvedContext = "";
  if (needsContext) {
    // Python: `context_id or config.get("context_id") or ""`. An empty
    // string is falsy there, so `--context-id=` falls through to the
    // config rather than being sent as a blank context.
    resolvedContext = contextId || config.context_id || "";
    if (!resolvedContext) {
      throw new CliError(NO_CONTEXT_MESSAGE);
    }
  }

  // Python: `api_key=config.get("api_key") or None`. An empty value must be
  // omitted, not forwarded — `Authorization: Bearer ` always 401s, and
  // omitting lets the OAuth profile resolve instead.
  const clientOptions: KaguraClientOptions = {};
  if (config.api_key) clientOptions.apiKey = config.api_key;
  if (config.mcp_url) clientOptions.mcpUrl = config.mcp_url;

  const client = ctx.makeClient(clientOptions);
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
