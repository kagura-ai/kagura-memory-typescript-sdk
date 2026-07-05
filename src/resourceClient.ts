/**
 * REST API client for Kagura Memory Cloud Resource Tokens (port of
 * resource_client.py).
 *
 * Handles two authentication modes:
 * - Token CRUD: `Authorization: Bearer <api_key>` (set once in constructor)
 * - Event ingestion: `X-Resource-API-Key` (passed per-call, never stored)
 *
 * All methods may throw:
 * - {@link KaguraAuthError}: Authentication failed (401)
 * - {@link KaguraNotFoundError}: Resource not found (404)
 * - {@link KaguraConnectionError}: Connection or HTTP error
 * - {@link KaguraQuotaError}: Quota exceeded (429)
 */

import type { ResolvedAuth } from "./auth/types.js";
import { KaguraClient } from "./client.js";
import { KaguraAuthError, KaguraNotFoundError } from "./errors.js";
import type {
  IndexerStatusResponse,
  PaginatedResourceTokensResponse,
  ResourceEventBatchResponse,
  ResourceEventResponse,
  ResourceEventsListResponse,
  ResourceImpactResponse,
  ResourceListResponse,
  ResourceSchemaResponse,
  ResourceSetupResponse,
  ResourceTokenCreateResponse,
  ResourceTokenResponse,
} from "./models.js";
import { KaguraRestClient } from "./restBase.js";

/**
 * Message surfaced when `setupResource` is called on an OAuth-resolved
 * client. Defined at module scope so tests can assert against the stable
 * constant instead of pinning a substring of the rendered output.
 *
 * The hint MUST point at a credential source that outranks OAuth in the
 * resolver chain (`env > OAuth profile > .kagura.json`). Suggesting
 * `.kagura.json` is misleading — it ranks BELOW OAuth and would still
 * be skipped while the OAuth profile is present.
 */
export const SETUP_OAUTH_NOT_SUPPORTED_MSG =
  "setupResource() is not yet available in OAuth mode. " +
  "To run it, switch to a credential source that outranks OAuth: " +
  "set KAGURA_API_KEY (and KAGURA_MCP_URL too if your api_key is " +
  "not for the default cloud server — the env branch uses " +
  "KAGURA_MCP_URL or the default URL, not the OAuth profile's " +
  "stored mcp_url) and retry, or remove the active OAuth profile " +
  "(e.g. `kagura auth logout`, or `kagura auth logout --profile <name>` " +
  "for named profiles selected via KAGURA_PROFILE) so .kagura.json " +
  "is consulted. The CRUD/ingest endpoints continue to work in " +
  "OAuth mode.";

export interface CreateTokenOptions {
  /** Resource identifier this token is scoped to. */
  resourceId: string;
  /** Human-readable description. */
  description?: string | null;
  /** Event ingestion quota per hour (1-10000, default 1000). */
  quotaEventsPerHour?: number;
}

export interface ListTokensOptions {
  /** Filter by resource ID. */
  resourceId?: string | null;
  /** Number of tokens per page (1-100, default 50). */
  limit?: number;
  /** Starting offset for pagination (default 0). */
  offset?: number;
}

export interface UpdateTokenOptions {
  /** Updated description. */
  description?: string | null;
  /** Updated quota (1-10000). */
  quotaEventsPerHour?: number | null;
}

export interface ResourceSetupOptions {
  /** Resource identifier for data ingestion. */
  resourceId: string;
  /** Context name (defaults to resourceId server-side). */
  contextName?: string;
  /** Context summary. */
  summary?: string;
  /** Token description. */
  description?: string;
  /** Token quota (1-10000, default 1000). */
  quotaEventsPerHour?: number;
}

/**
 * A single event to ingest (camelCase input for the wire-model
 * `ResourceEventRequest`). Serialized per-field to the snake_case wire
 * shape; unset/null optional fields are omitted, matching the Python
 * `model_dump(exclude_none=True)` semantics (`eventMetadata` defaults to
 * `{}` and is always sent).
 */
export interface ResourceEventInput {
  op: "upsert" | "delete";
  /** Document ID (1-255 chars). */
  docId: string;
  /** Document version (minimum 1). */
  version?: number | null;
  payload?: Record<string, unknown> | null;
  /** Idempotency key (1-255 chars). */
  idempotencyKey?: string | null;
  eventMetadata?: Record<string, unknown>;
  /** Importance score (0.0-1.0). */
  importance?: number | null;
}

export interface ListResourceEventsOptions {
  /** Maximum events per page (1-100, default 50). */
  limit?: number;
  /** Opaque pagination cursor from a prior `next_cursor`. */
  cursor?: string | null;
  /** Filter by operation (`upsert` or `delete`). */
  op?: "upsert" | "delete" | null;
  /** Filter by document ID. */
  docId?: string | null;
  /** Filter by document version. */
  version?: number | null;
  /**
   * Return only events with `created_at` at or after this time
   * (inclusive). A `Date` is serialized to ISO 8601 UTC; a string is
   * passed through as-is (supply ISO 8601).
   */
  since?: Date | string | null;
}

/** Serialize one event to the snake_case wire dict (exclude-none semantics). */
function serializeEvent(event: ResourceEventInput): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    op: event.op,
    doc_id: event.docId,
  };
  if (event.version !== undefined && event.version !== null) {
    wire.version = event.version;
  }
  if (event.payload !== undefined && event.payload !== null) {
    wire.payload = event.payload;
  }
  if (event.idempotencyKey !== undefined && event.idempotencyKey !== null) {
    wire.idempotency_key = event.idempotencyKey;
  }
  // Wire-model default is {} (not null), so the field is always present.
  wire.event_metadata = event.eventMetadata ?? {};
  if (event.importance !== undefined && event.importance !== null) {
    wire.importance = event.importance;
  }
  return wire;
}

/**
 * REST API client for Kagura Memory Cloud Resource Tokens.
 *
 * Extends {@link KaguraRestClient} with the resource-token wire contract;
 * the base's default error hooks already implement this client's mapping
 * (429 → {@link KaguraQuotaError} with `retryAfter`), so no hooks are
 * overridden here.
 */
export class ResourceClient extends KaguraRestClient {
  /**
   * Original MCP URL — `null` until {@link fromResolvedAuth} stamps it.
   * {@link setupResource} needs the ORIGINAL MCP URL, which the REST
   * `baseUrl` no longer carries.
   */
  private mcpUrlValue: string | null = null;

  /** MCP URL captured by `fromMcpUrl` (null for bare construction). */
  get mcpUrl(): string | null {
    return this.mcpUrlValue;
  }

  /**
   * Construct from a pre-resolved auth, stamping the MCP URL.
   *
   * `setupResource()` needs the ORIGINAL MCP URL to build its MCP
   * session — the resolved auth always carries one, whether sourced from
   * the OAuth profile or the priority-4 config.
   */
  protected static override fromResolvedAuth<T extends typeof KaguraRestClient>(
    this: T,
    resolved: ResolvedAuth,
    options: {
      timeoutMs?: number;
      workspaceIdHint?: string | null;
      fetch?: typeof globalThis.fetch;
    } = {},
  ): InstanceType<T> {
    const instance = super.fromResolvedAuth(resolved, options) as InstanceType<T>;
    (instance as unknown as ResourceClient).mcpUrlValue = resolved.mcpUrl.replace(/\/+$/, "");
    return instance;
  }

  // -------------------------------------------------------------------
  // Token CRUD (Bearer auth)
  // -------------------------------------------------------------------

  /**
   * Create a new resource token.
   *
   * @returns Created token including plaintext token (shown only once).
   */
  async createToken(options: CreateTokenOptions): Promise<ResourceTokenCreateResponse> {
    const body: Record<string, unknown> = { resource_id: options.resourceId };
    if (options.description !== undefined && options.description !== null) {
      body.description = options.description;
    }
    body.quota_events_per_hour = options.quotaEventsPerHour ?? 1000;

    const response = await this.request("POST", "/api/v1/resource-tokens", { json: body });
    return this.json(response) as unknown as ResourceTokenCreateResponse;
  }

  /**
   * List resource tokens with optional filtering.
   *
   * @returns Paginated (`limit`/`offset`) list of resource tokens.
   */
  async listTokens(options: ListTokensOptions = {}): Promise<PaginatedResourceTokensResponse> {
    const params: Record<string, unknown> = {
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
    };
    if (options.resourceId !== undefined && options.resourceId !== null) {
      params.resource_id = options.resourceId;
    }

    const response = await this.request("GET", "/api/v1/resource-tokens", { params });
    return this.json(response) as unknown as PaginatedResourceTokensResponse;
  }

  /**
   * Update a resource token's metadata. Only fields that are set are
   * sent on the wire.
   *
   * @param tokenId Token database ID.
   * @returns Updated token metadata.
   */
  async updateToken(
    tokenId: number,
    options: UpdateTokenOptions = {},
  ): Promise<ResourceTokenResponse> {
    const body: Record<string, unknown> = {};
    if (options.description !== undefined && options.description !== null) {
      body.description = options.description;
    }
    if (options.quotaEventsPerHour !== undefined && options.quotaEventsPerHour !== null) {
      body.quota_events_per_hour = options.quotaEventsPerHour;
    }

    const response = await this.request("PATCH", `/api/v1/resource-tokens/${tokenId}`, {
      json: body,
    });
    return this.json(response) as unknown as ResourceTokenResponse;
  }

  /**
   * Revoke (soft-delete) a resource token.
   *
   * @param tokenId Token database ID.
   */
  async revokeToken(tokenId: number): Promise<void> {
    await this.request("DELETE", `/api/v1/resource-tokens/${tokenId}`);
  }

  // -------------------------------------------------------------------
  // Setup helper
  // -------------------------------------------------------------------

  /**
   * Atomically set up a resource for data ingestion (server v0.14+).
   *
   * Calls the server-side atomic `setup_resource` MCP tool which creates
   * Context + Resource entity + token in a single transaction. On
   * failure, no orphan Context rows are left on the server. Requires the
   * client to be created via `fromMcpUrl()`.
   *
   * @returns ResourceSetupResponse with plaintext token (shown only once).
   * @throws Error if the client was not created via `fromMcpUrl()`, or
   *   was constructed via the OAuth resolution path (`setupResource`
   *   currently requires a static apiKey — see
   *   {@link SETUP_OAUTH_NOT_SUPPORTED_MSG}).
   * @throws KaguraAuthError if the Authorization header is missing or
   *   malformed in the static path.
   *
   * Note: Idempotency for repeated calls with the same `resourceId` is
   * not guaranteed; server-side behavior may evolve. Avoid retrying
   * setup for an existing `resourceId` without first verifying state.
   */
  async setupResource(options: ResourceSetupOptions): Promise<ResourceSetupResponse> {
    if (!this.mcpUrlValue) {
      throw new Error(
        "setupResource() requires MCP URL. Create the client via ResourceClient.fromMcpUrl().",
      );
    }

    if (this.oauth !== null) {
      // `KaguraClient` construction below needs a static apiKey; the
      // OAuth AuthProvider cannot be threaded through yet. Surface the
      // workaround instead of failing with a header-scraping error a
      // few lines down.
      throw new Error(SETUP_OAUTH_NOT_SUPPORTED_MSG);
    }

    const auth = await this.auth.getAuthHeader();
    if (!auth.startsWith("Bearer ")) {
      throw new KaguraAuthError("Authorization header missing or invalid");
    }
    const apiKey = auth.slice(7);

    const mcp = new KaguraClient({
      apiKey,
      mcpUrl: this.mcpUrlValue,
      timeoutMs: this.timeoutMs,
      fetch: this.fetchImpl,
    });
    try {
      const result = await mcp.setupResource({
        resourceId: options.resourceId,
        name: options.contextName,
        summary: options.summary,
        description: options.description,
        quotaEventsPerHour: options.quotaEventsPerHour ?? 1000,
      });
      return result as unknown as ResourceSetupResponse;
    } finally {
      await mcp.close();
    }
  }

  // -------------------------------------------------------------------
  // Resource Stats (Bearer auth)
  // -------------------------------------------------------------------

  /**
   * Get impact statistics for a resource.
   *
   * @returns Resource impact stats (token_count, memory_count, schema version).
   */
  async getResourceImpact(resourceId: string): Promise<ResourceImpactResponse> {
    const response = await this.request("GET", `/api/v1/resources/${resourceId}/impact`);
    return this.json(response) as unknown as ResourceImpactResponse;
  }

  /**
   * List all resources in the caller's workspace (server v0.14+).
   *
   * Returns workspace-scoped resources with aggregated stats
   * (token_count, memory_count, current_schema_version, ...). The
   * endpoint is currently non-paginated; the server caps a workspace at
   * well under 50 resources by design.
   *
   * Workspace owners only — non-owners receive 403.
   */
  async listResources(): Promise<ResourceListResponse> {
    const response = await this.request("GET", "/api/v1/resources");
    return this.json(response) as unknown as ResourceListResponse;
  }

  /**
   * Get indexer state and recent ingest events for a resource.
   *
   * `state` is `null` when the indexer has never run for this resource —
   * a normal 200 response, distinct from a 404. `recent_events` is
   * server-capped at 5.
   *
   * @throws KaguraNotFoundError Resource slug does not exist in the
   *   caller's workspace (404; cross-workspace probe protection).
   */
  async getIndexerStatus(resourceId: string): Promise<IndexerStatusResponse> {
    const response = await this.request("GET", `/api/v1/resources/${resourceId}/indexer-status`);
    return this.json(response) as unknown as IndexerStatusResponse;
  }

  /**
   * Get field definitions for a resource.
   *
   * @param schemaVersion Specific schema version to retrieve; omit for
   *   the latest version.
   * @returns Resource schema with field definitions, or `null` if no
   *   schema is registered for the resource.
   */
  async getResourceSchema(
    resourceId: string,
    schemaVersion?: number | null,
  ): Promise<ResourceSchemaResponse | null> {
    const opts: { params?: Record<string, unknown> } = {};
    if (schemaVersion !== undefined && schemaVersion !== null) {
      opts.params = { schema_version: schemaVersion };
    }
    try {
      const response = await this.request("GET", `/api/v1/resources/${resourceId}/schema`, opts);
      return this.json(response) as unknown as ResourceSchemaResponse;
    } catch (e) {
      if (e instanceof KaguraNotFoundError) {
        return null;
      }
      throw e;
    }
  }

  /**
   * List ingested events for a resource (server v0.15+).
   *
   * Mirrors `GET /api/v1/resources/{resource_id}/events`. Results are
   * cursor-paginated: pass the returned `next_cursor` back as `cursor`
   * to fetch the next page (`next_cursor` is `null` on the last page).
   * Note this method uses `limit`/`cursor` pagination, unlike
   * {@link listTokens} which uses `limit`/`offset`.
   *
   * Uses Bearer auth (workspace read), not the `X-Resource-API-Key`
   * ingestion credential. An unknown `resourceId` returns an empty page
   * (`events=[]`, `next_cursor=null`) rather than a 404 — observed
   * against memory-cloud production.
   *
   * @throws KaguraNotFoundError The server returned 404 for this
   *   resource (cross-workspace probe protection); applies only if the
   *   server does respond with 404.
   */
  async listResourceEvents(
    resourceId: string,
    options: ListResourceEventsOptions = {},
  ): Promise<ResourceEventsListResponse> {
    const params: Record<string, unknown> = { limit: options.limit ?? 50 };
    if (options.cursor !== undefined && options.cursor !== null) {
      params.cursor = options.cursor;
    }
    if (options.op !== undefined && options.op !== null) {
      params.op = options.op;
    }
    if (options.docId !== undefined && options.docId !== null) {
      params.doc_id = options.docId;
    }
    if (options.version !== undefined && options.version !== null) {
      params.version = options.version;
    }
    if (options.since !== undefined && options.since !== null) {
      // A Date always serializes to UTC ISO 8601 (`Z` suffix) — the same
      // "naive means UTC" normalization the Python port applies.
      params.since = options.since instanceof Date ? options.since.toISOString() : options.since;
    }

    const response = await this.request("GET", `/api/v1/resources/${resourceId}/events`, {
      params,
    });
    return this.json(response) as unknown as ResourceEventsListResponse;
  }

  // -------------------------------------------------------------------
  // Event Ingestion (X-Resource-API-Key auth)
  // -------------------------------------------------------------------

  /**
   * Ingest a single resource event.
   *
   * @param resourceApiKey Resource API key (`X-Resource-API-Key`
   *   header) — sent per-call, never stored on the client.
   * @returns Ingestion result with `event_id`.
   */
  async ingestEvent(
    resourceId: string,
    resourceApiKey: string,
    event: ResourceEventInput,
  ): Promise<ResourceEventResponse> {
    const response = await this.request("POST", `/api/v1/resources/${resourceId}/events`, {
      json: serializeEvent(event),
      extraHeaders: { "X-Resource-API-Key": resourceApiKey },
    });
    return this.json(response) as unknown as ResourceEventResponse;
  }

  /**
   * Ingest a batch of resource events (1-100; the server validates the
   * bound).
   *
   * @param resourceApiKey Resource API key (`X-Resource-API-Key`
   *   header) — sent per-call, never stored on the client.
   * @returns Batch ingestion result with created/failed counts.
   */
  async ingestEvents(
    resourceId: string,
    resourceApiKey: string,
    events: ResourceEventInput[],
  ): Promise<ResourceEventBatchResponse> {
    const response = await this.request("POST", `/api/v1/resources/${resourceId}/events/batch`, {
      json: { events: events.map(serializeEvent) },
      extraHeaders: { "X-Resource-API-Key": resourceApiKey },
    });
    return this.json(response) as unknown as ResourceEventBatchResponse;
  }
}
