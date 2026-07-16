/**
 * REST client for the agent bootstrap surface (issue #3, server
 * v0.49.0+) — port of the Python SDK's agents_client.py bootstrap call.
 *
 * The `get_agent_bootstrap` MCP tool has a REST companion —
 * `POST /api/v1/agents/{agent_id}/bootstrap` (RFC-0002 P0-3, memory-cloud
 * #1276) — authenticated with `APIKeyOrSessionUser`, so it accepts
 * agent-bound member keys: a deployed agent can rehydrate its cognitive
 * state without opening an MCP session. POST-for-read follows the
 * server's `POST /api/v1/memory/pinned` precedent.
 *
 * Construction, credential resolution, lifecycle, and the base error
 * mapping live in {@link KaguraRestClient}; this module keeps only the
 * bootstrap wire call. The registry/binding CRUD is MCP-only in this SDK
 * (KaguraClient) — provisioning is an operator task that has an MCP
 * session available.
 */

import { buildBootstrapPayload } from "./agentBootstrap.js";
import type { GetAgentBootstrapOptions } from "./agentBootstrap.js";
import type { AgentBootstrapResponse } from "./models.js";
import { KaguraRestClient } from "./restBase.js";
import { parseUuid } from "./uuid.js";

/**
 * REST API client for agent bootstrap (memory-cloud v0.49.0+).
 *
 * Use this surface when the caller holds an API key but no MCP session —
 * e.g. an agent-bound member key minted for a deployed agent. Against an
 * older server the route 404s.
 *
 * All methods may reject with:
 * - `KaguraAuthError` — authentication failed (401)
 * - `KaguraConnectionError` — invalid arguments (400) or any other
 *   HTTP/connection error
 * - `KaguraNotFoundError` — agent or context not found (404). The 404 is
 *   uniform (CWE-639) — nonexistent and not-yours are indistinguishable
 *   by design, so a 404 does NOT prove the agent is absent.
 * - `KaguraQuotaError` — rate limit exceeded (429)
 */
export class AgentsClient extends KaguraRestClient {
  /**
   * Rehydrate an agent's cognitive state at session start.
   *
   * REST companion to `KaguraClient.getAgentBootstrap` — same options,
   * same composed envelope, same fail-soft component semantics (see that
   * method for the full contract).
   */
  async bootstrap(options: GetAgentBootstrapOptions): Promise<AgentBootstrapResponse> {
    let agentId: string;
    try {
      agentId = parseUuid(options.agentId);
    } catch {
      // Normalize instead of interpolating the raw input: a non-UUID
      // would otherwise reach the URL path and surface as a misleading
      // uniform 404 (or worse, a path traversal attempt).
      throw new Error(`agentId must be a UUID, got ${JSON.stringify(options.agentId)}`);
    }
    const resp = await this.request("POST", `/api/v1/agents/${agentId}/bootstrap`, {
      json: buildBootstrapPayload(options),
    });
    return this.json(resp) as AgentBootstrapResponse;
  }
}
