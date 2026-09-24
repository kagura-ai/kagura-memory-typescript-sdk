/**
 * Pairing a REST command's workspace with its credential — the port of
 * `_resolve_cli_auth`, `_resolve_workspace_from_source` and
 * `_bound_workspace_for_hint` in the Python CLI's `cli.py` (issue #115 of
 * the Python SDK).
 *
 * An API key is provisioned for one workspace, so mixing one source's key
 * with another source's workspace is never right: at best a 403, at worst
 * a silent write to the wrong workspace. A command that targets a
 * workspace therefore resolves the credential once, takes the workspace
 * from that same source, and builds its client from that same credential:
 *
 *     const { auth, workspaceId, workspaceIdHint } = pairWorkspaceCredential(deps, flag);
 *     const client = deps.makeFilesClient(auth, workspaceIdHint);
 *
 * Every message is Python's, except that its hint names this bin's
 * `kagura-memory auth login`.
 */

import type { ResolvedAuth } from "../auth/types.js";
import { SOURCE_LABEL } from "../auth/types.js";
import type { KaguraConfig } from "../config.js";
import { excMessage } from "../errors.js";
import { pyStrip } from "../pyCompat.js";
import { CliError } from "./parse.js";
import { resolveConfig, type ClientCommandContext } from "./runClientCommand.js";

/**
 * The `context_id` a `setup claude`-generated `.kagura.json` carries to
 * mean "the workspace the credential source is bound to". Never a
 * workspace in its own right.
 */
export const CONTEXT_ID_AUTO = "auto";

/** `(config.get("context_id") or "").strip()` — a non-string reads as absent. */
function configContext(config: KaguraConfig): string {
  const value = config.context_id;
  return typeof value === "string" ? pyStrip(value) : "";
}

/**
 * Resolve a REST command's credential through the SDK chain (env > OAuth
 * profile > .kagura.json), turning a failure into a CLI error — port of
 * `_resolve_cli_auth`.
 *
 * No `mcpUrl` is passed, so each branch pairs its credential with its own
 * URL (env: `KAGURA_MCP_URL`; OAuth: the profile's stored URL; config:
 * `.kagura.json`'s `mcp_url`). Forwarding the config's `mcp_url` would
 * send an OAuth profile bound to another server to the wrong host.
 *
 * @throws CliError with the resolver's message (exit 1).
 */
export function resolveCliAuth(
  ctx: Pick<ClientCommandContext, "resolveAuth">,
  config: KaguraConfig,
): ResolvedAuth {
  try {
    return ctx.resolveAuth({ apiKey: null, mcpUrl: null, profile: null, config });
  } catch (e) {
    throw new CliError(excMessage(e));
  }
}

/**
 * The workspace a command targets, from the SAME source as its credential
 * — port of `_resolve_workspace_from_source`.
 *
 * 1. An explicit override (`flag`, stripped, and not `auto`) always wins.
 *    It is returned stripped but otherwise as typed; UUID checks are the
 *    caller's.
 * 2. An OAuth profile: the workspace `auth login` stored with it.
 * 3. A `.kagura.json` api_key: that file's `context_id` (not `auto`).
 * 4. A `KAGURA_API_KEY` key: nothing it could be paired with, so the
 *    override is required. `KAGURA_CONTEXT_ID` is never used for it.
 *
 * @param flag The override option the messages name.
 * @throws CliError (exit 1) when no same-source workspace can be formed.
 */
export function resolveWorkspaceFromSource(
  auth: ResolvedAuth,
  config: KaguraConfig,
  explicit: string | null | undefined,
  flag = "--context-id",
): string {
  // Stripped so a padded override behaves: `"  auto  "` is the sentinel,
  // and a padded UUID never carries its spaces downstream.
  if (explicit) {
    const stripped = pyStrip(explicit);
    if (stripped && stripped !== CONTEXT_ID_AUTO) return stripped;
  }

  if (auth.kind === "oauth") {
    if (auth.workspaceId) return auth.workspaceId;
    throw new CliError(
      "OAuth profile has no workspace bound. Re-run `kagura-memory auth login` " +
        `or pass ${flag} <uuid>.`,
    );
  }

  if (auth.source === "config") {
    const fromConfig = configContext(config);
    if (fromConfig && fromConfig !== CONTEXT_ID_AUTO) return fromConfig;
    throw new CliError(
      '.kagura.json has api_key but context_id is missing or "auto". ' +
        "Set context_id to the workspace UUID bound to this api_key, " +
        `or pass ${flag}. (Falling back to the OAuth profile would ` +
        "mix credential sources — see issue #115.)",
    );
  }

  throw new CliError(
    `api_key from ${SOURCE_LABEL[auth.source]} has no associated workspace; pass ${flag} ` +
      "(mixing api_key and OAuth profile's workspace is not allowed — see issue #115).",
  );
}

/**
 * The workspace BOUND to a static key's source, for 403 hints only — port
 * of `_bound_workspace_for_hint`.
 *
 * Only a `.kagura.json` key has one (that file's `context_id`); an env key
 * has none, and an OAuth client takes the profile's own workspace, so both
 * get `null`.
 */
export function boundWorkspaceForHint(auth: ResolvedAuth, config: KaguraConfig): string | null {
  if (auth.kind === "static" && auth.source === "config") {
    const fromConfig = configContext(config);
    if (fromConfig && fromConfig !== CONTEXT_ID_AUTO) return fromConfig;
  }
  return null;
}

/**
 * Refuse an empty or `auto` `--workspace` before anything is resolved —
 * the guard at the top of Python's `_run_workspace_command`.
 *
 * {@link resolveWorkspaceFromSource} reads such a value as "no override"
 * and falls back to the credential's workspace: harmless for `--context-id`,
 * fatal for a destructive workspace command run with `--yes` from a
 * script whose `$WS` happened to be unset.
 *
 * @throws CliError (exit 1).
 */
export function refuseBlankWorkspaceOverride(workspaceId: string | undefined): void {
  if (workspaceId === undefined) return;
  const stripped = pyStrip(workspaceId);
  if (!stripped || stripped === CONTEXT_ID_AUTO) {
    throw new CliError(
      "--workspace was provided but empty (or 'auto') — refusing to fall back to the " +
        "credential source's workspace. Pass the target workspace UUID.",
    );
  }
}

/** A credential, and the workspace paired with it (#115). */
export interface WorkspaceCredential {
  config: KaguraConfig;
  auth: ResolvedAuth;
  /** The workspace to target; `""` when `needsWorkspace` is false. */
  workspaceId: string;
  /** For the client's 403 hints: pass it to `makeFilesClient` / `makeWorkspaceClient`. */
  workspaceIdHint: string | null;
}

export interface PairWorkspaceOptions {
  /** The override option the messages name (default `--context-id`). */
  flag?: string;
  /**
   * Refuse a blank or `auto` override first, before the config is loaded
   * ({@link refuseBlankWorkspaceOverride}) — what the `workspace` commands
   * do. The `files` commands fall back to the source's workspace instead.
   */
  refuseBlankOverride?: boolean;
  /**
   * `false` for operations keyed by something else (a file id): only the
   * credential is resolved, no workspace is paired and no hint is given,
   * as Python's `needs_context=False` does.
   */
  needsWorkspace?: boolean;
}

/**
 * Load the config, resolve the credential once, and pair the workspace
 * with it — the front half of Python's `_run_workspace_command` and
 * `_run_files_command`, in their order.
 *
 * @throws CliError (exit 1) for a bad config file, no credential, or no
 *   workspace the credential's source can supply.
 */
export function pairWorkspaceCredential(
  ctx: ClientCommandContext,
  explicit: string | undefined,
  options: PairWorkspaceOptions = {},
): WorkspaceCredential {
  if (options.refuseBlankOverride) refuseBlankWorkspaceOverride(explicit);
  const { config } = resolveConfig(ctx, undefined, false);
  const auth = resolveCliAuth(ctx, config);
  if (options.needsWorkspace === false) {
    return { config, auth, workspaceId: "", workspaceIdHint: null };
  }
  return {
    config,
    auth,
    workspaceId: resolveWorkspaceFromSource(auth, config, explicit, options.flag),
    workspaceIdHint: boundWorkspaceForHint(auth, config),
  };
}
