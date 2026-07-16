/**
 * Shared request contract for the agent bootstrap surfaces.
 *
 * `KaguraClient.getAgentBootstrap` (MCP tool arguments) and
 * `AgentsClient.bootstrap` (REST JSON body) carry the same seven optional
 * keys; this module keeps the two surfaces in lockstep without the REST
 * client importing the MCP module — the analogue of the Python SDK homing
 * `_bootstrap_payload` in models.py so agents_client.py never imports
 * client.py. `agentId` stays transport-specific (MCP argument vs URL
 * path).
 */

import type { AgentBootstrapComponentName } from "./models.js";

export interface GetAgentBootstrapOptions {
  /** Agent UUID from the registry (required). */
  agentId: string;
  /** Target context UUID. Omit to use the agent's default binding. */
  contextId?: string;
  /**
   * Opaque correlation id (max 128 chars, `[A-Za-z0-9._-]`); echoed in
   * the `correlation` block.
   */
  sessionId?: string;
  /**
   * Recall query (max 1024 chars). Supplying it enables the trusted-only
   * recall component; omit to skip recall — the server never fabricates
   * a query, so the component reports `status="skipped"` even when
   * `include` names it.
   */
  query?: string;
  /** Number of recall results; forwarded to recall's `k` validation. */
  recallK?: number;
  /** Override for the pinned-set cap; clamped server-side to [1, 1000]. */
  pinnedCap?: number;
  /**
   * ISO upper bound for upcoming time memories (the lower bound is
   * always now).
   */
  upcomingUntil?: string;
  /**
   * Component selector — a subset of `"pinned"`, `"recall"`,
   * `"upcoming"`, `"state"`, `"policy"`. Omit for all components.
   */
  include?: AgentBootstrapComponentName[];
}

/**
 * Build the omit-when-undefined bootstrap payload shared by both
 * surfaces — the port of the Python SDK's `_bootstrap_payload`.
 * Internal — not part of the public API surface.
 */
export function buildBootstrapPayload(
  options: Omit<GetAgentBootstrapOptions, "agentId">,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (options.contextId !== undefined) {
    payload.context_id = options.contextId;
  }
  if (options.sessionId !== undefined) {
    payload.session_id = options.sessionId;
  }
  if (options.query !== undefined) {
    payload.query = options.query;
  }
  if (options.recallK !== undefined) {
    payload.recall_k = options.recallK;
  }
  if (options.pinnedCap !== undefined) {
    payload.pinned_cap = options.pinnedCap;
  }
  if (options.upcomingUntil !== undefined) {
    payload.upcoming_until = options.upcomingUntil;
  }
  if (options.include !== undefined) {
    payload.include = options.include;
  }
  return payload;
}
