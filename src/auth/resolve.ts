/**
 * Credential resolution shared by REST/MCP clients in this SDK (port of
 * _auth.py).
 *
 * Centralizes the precedence chain — explicit arg > `KAGURA_API_KEY` env >
 * OAuth profile in `~/.kagura/credentials.json` > `.kagura.json` config —
 * in one module so every client resolves credentials identically.
 *
 * Returns one of two result types (see `types.ts`):
 *
 * - `StaticAuthResult` — long-lived API key, baked into the client's
 *   `Authorization` header at construction.
 * - `OAuthAuthResult` — a `KaguraOAuth` AuthProvider that injects a fresh
 *   access token per request and coordinates refresh via a process-wide
 *   mutex.
 *
 * This module imports only from `auth/credentials`, `config`, and
 * `errors` — never from `http`. The reverse direction (`http` importing
 * `resolve`) must also be avoided so the dependency stays one-way.
 */

import { loadConfig } from "../config.js";
import type { KaguraConfig } from "../config.js";
import { KaguraAuthError } from "../errors.js";
import {
  KaguraOAuth,
  defaultCredentialsPath,
  getSharedState,
  loadCredentialsFile,
} from "./credentials.js";
import type { SharedCredentialsState } from "./credentials.js";
import type { ResolvedAuth } from "./types.js";

export const DEFAULT_MCP_URL = "https://memory.kagura-ai.com/mcp";

/** Kept trivial on purpose; swap the sink here if the SDK ever grows one. */
const logger = {
  warn(message: string): void {
    console.warn(message);
  },
};

// (credentials-file path, profile name) pairs already warned about this
// process, so the multi-profile ambiguity note fires at most once per active
// profile per file per process rather than on every client construction.
// Keyed by path too so two different credential files that share a default
// name (e.g. "default") don't suppress each other.
const warnedProfiles = new Set<string>();

/** Clear the once-per-process ambiguity-warning dedup set (test hook). */
export function resetProfileWarnings(): void {
  warnedProfiles.clear();
}

export interface ResolveAuthOptions {
  apiKey?: string | null;
  mcpUrl?: string | null;
  profile?: string | null;
  /** Pre-loaded `.kagura.json`; skips the priority-4 disk read when set. */
  config?: KaguraConfig | null;
  /** Environment source (default: process.env). */
  env?: Record<string, string | undefined>;
  /** Home directory for `~/.kagura/credentials.json` (default: os.homedir()). */
  home?: string;
}

/** True when `KAGURA_REQUIRE_PROFILE` opts into strict resolution. */
function strictProfileRequired(env: Record<string, string | undefined>): boolean {
  const raw = (env.KAGURA_REQUIRE_PROFILE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Warn (or, under strict mode, raise) on an implicit multi-profile default.
 *
 * Only fires when resolution fell back to `default_profile` (no explicit
 * `profile` arg and no `KAGURA_PROFILE`) AND more than one profile is
 * configured — a single-profile setup is unambiguous and stays silent. The
 * note names the active profile + workspace so a misdirected write to the
 * wrong account is caught. Honors `KAGURA_REQUIRE_PROFILE`.
 */
function checkProfileAmbiguity(
  state: SharedCredentialsState,
  env: Record<string, string | undefined>,
  credentialsPath: string,
): void {
  const cf = loadCredentialsFile(credentialsPath);
  if (Object.keys(cf.profiles).length < 2) {
    return; // single profile: unambiguous
  }

  const name = state.profileName;
  const creds = state.credentials;
  const workspace = creds.workspaceName || creds.workspaceId || "unknown workspace";

  // The strict check runs BEFORE the dedup-set check so a prior non-strict
  // warning can never swallow a strict raise.
  if (strictProfileRequired(env)) {
    const available = Object.keys(cf.profiles).sort().join(", ");
    throw new KaguraAuthError(
      `Multiple profiles configured and none selected; refusing to use the ` +
        `implicit default '${name}' because KAGURA_REQUIRE_PROFILE is set.\n` +
        `  Select one explicitly: kagura auth use <name>, --profile <name>, ` +
        `or KAGURA_PROFILE=<name>\n` +
        `  Available profiles: ${available}`,
    );
  }

  const warnKey = JSON.stringify([state.path, name]);
  if (!warnedProfiles.has(warnKey)) {
    warnedProfiles.add(warnKey);
    logger.warn(
      `kagura: using profile '${name}' (workspace '${workspace}') — set a ` +
        `default with 'kagura auth use <name>' or pass --profile to silence ` +
        `this notice.`,
    );
  }
}

/**
 * Pick a credential source per the documented precedence chain:
 *
 * 1. Explicit `apiKey` argument (non-whitespace) — wins absolutely.
 * 2. `KAGURA_API_KEY` env var, with mcpUrl fallback
 *    `mcpUrl arg > KAGURA_MCP_URL > DEFAULT_MCP_URL`.
 * 3. OAuth profile from credentials.json:
 *    `profile arg > KAGURA_PROFILE > default_profile`. An explicitly named
 *    profile that is missing raises rather than falling through (silently
 *    authenticating with the wrong account is the bug class prevented).
 * 4. Legacy `.kagura.json` (pre-loaded via `options.config` or read from
 *    disk), with the same whitespace-stripped api_key check.
 *
 * Empty / whitespace-only api_keys are treated the same as absent at every
 * step — sending `Authorization: Bearer ` would always 401 and is never
 * what the caller intended.
 *
 * @throws KaguraAuthError when no source produces credentials.
 */
export function resolveAuth(options: ResolveAuthOptions = {}): ResolvedAuth {
  const env = options.env ?? process.env;
  const mcpUrl = options.mcpUrl ?? null;

  // 1. Explicit constructor argument wins absolutely.
  const apiKey = options.apiKey;
  if (apiKey !== undefined && apiKey !== null && apiKey.trim()) {
    return {
      kind: "static",
      apiKey,
      mcpUrl: mcpUrl || DEFAULT_MCP_URL,
      source: "explicit",
    };
  }

  // 2. KAGURA_API_KEY env var (highest auto-resolution priority).
  const envKey = env.KAGURA_API_KEY;
  if (envKey && envKey.trim()) {
    return {
      kind: "static",
      apiKey: envKey,
      mcpUrl: mcpUrl || env.KAGURA_MCP_URL || DEFAULT_MCP_URL,
      source: "env",
    };
  }

  // 3. OAuth profile from credentials.json: explicit > KAGURA_PROFILE > default.
  const targetProfile = options.profile || env.KAGURA_PROFILE || null;
  const credentialsPath = defaultCredentialsPath(options.home);
  const state = getSharedState(credentialsPath, targetProfile);
  if (state !== null) {
    if (targetProfile === null) {
      // No explicit selection — resolution fell back to default_profile.
      // Warn (or hard-error under strict mode) when the default is
      // ambiguous because multiple profiles are configured.
      checkProfileAmbiguity(state, env, credentialsPath);
    }
    return {
      kind: "oauth",
      oauth: new KaguraOAuth(state),
      mcpUrl: mcpUrl || state.credentials.mcpUrl,
      workspaceId: state.credentials.workspaceId || null,
    };
  }
  if (targetProfile) {
    // An explicit profile name (via arg or KAGURA_PROFILE env) was
    // requested but credentials.json has no such profile. Falling through
    // to .kagura.json would silently authenticate with the wrong account,
    // so raise instead.
    const source = options.profile ? "profile argument" : "KAGURA_PROFILE env";
    throw new KaguraAuthError(
      `Profile '${targetProfile}' (from ${source}) not found in credentials.json.\n` +
        `  Run: kagura auth login --profile ${targetProfile}\n` +
        `  Or inspect ~/.kagura/credentials.json to see which profiles exist.`,
    );
  }

  // 4. Legacy .kagura.json (which itself env-falls-back internally).
  const cfg =
    options.config ?? loadConfig({ ...(options.home ? { home: options.home } : {}), env });
  const cfgKey = cfg.api_key;
  if (typeof cfgKey === "string" && cfgKey.trim()) {
    return {
      kind: "static",
      apiKey: cfgKey,
      mcpUrl: mcpUrl || cfg.mcp_url || DEFAULT_MCP_URL,
      source: "config",
    };
  }

  throw new KaguraAuthError(
    "No credentials found.\n" +
      "  Run: kagura auth login\n" +
      "  Or set: KAGURA_API_KEY=<your key>\n" +
      '  Or create: .kagura.json with {"api_key": "..."}',
  );
}
