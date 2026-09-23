/**
 * Wire-format models for the Kagura Memory SDK (port of models.py).
 *
 * These interfaces describe the JSON wire shapes exchanged with the Kagura
 * Memory server, so field names stay snake_case exactly as pydantic
 * serializes them. All `datetime` fields from the Python SDK arrive as
 * ISO 8601 strings on the wire and are typed `string` here.
 *
 * Fields that carry a default in the Python models (including `None`
 * defaults) are optional here — servers may omit them.
 */

// ---------------------------------------------------------------------------
// Embedding model metadata
// ---------------------------------------------------------------------------

/** An embedding model available on the server. */
export interface EmbeddingModel {
  name: string;
  dimensions: number;
  provider: string;
  available: boolean;
}

/** Response from the embedding models endpoint. */
export interface EmbeddingModelsResponse {
  models: EmbeddingModel[];
  default_model: string;
}

// ---------------------------------------------------------------------------
// Server info & usage models (v0.6.1)
// ---------------------------------------------------------------------------

/**
 * Deployment feature flags reported by the server.
 *
 * Each says whether the deployment offers a feature at all, not whether the
 * caller's plan includes it. A v0.75.0 server sends all ten named here; the
 * index signature keeps a flag a later server adds type-checking.
 */
export interface ServerFeatures {
  /** @default false */
  neural_memory?: boolean;
  /** @default false */
  research_tools?: boolean;
  /** The web UI's Plan page (server v0.40.0+). */
  plan_page?: boolean;
  /** Bring-your-own provider keys and the workspace cost dashboard (server v0.42.0+). */
  byok?: boolean;
  /** Whether the web UI shows costs at all (server v0.69.0+). */
  cost_display?: boolean;
  /** Connectors run on a shared managed worker (server v0.59.1+). */
  managed_connectors?: boolean;
  /** Memory Analysis can run without a workspace LLM key (server v0.69.0+). */
  managed_llm?: boolean;
  /** Referral endpoints are enabled (server v0.63.0+). */
  referrals?: boolean;
  /**
   * New accounts are admitted by beta invite (server v0.70.0+);
   * `auth login --invite` reads it.
   */
  beta_invites?: boolean;
  /**
   * Reranking is switched on and its default provider can run (server
   * v0.69.0+). A plan can still exclude it.
   */
  reranking?: boolean;
  [key: string]: boolean | undefined;
}

/**
 * The reranker settings a new context starts with — the deployment default
 * (server v0.69.0+). Provider and model names only; never a URL or a key.
 */
export interface SearchDefaults {
  use_rerank: boolean;
  /** Known values: `voyage`, `cohere`, `self_hosted`. */
  reranker_provider: string;
  reranker_model: string;
}

/** Server information from `/api/v1/system/info`. */
export interface ServerInfo {
  name: string;
  version: string;
  description?: string | null;
  environment?: string | null;
  /** Server v0.69.0+. */
  search_defaults?: SearchDefaults;
  features?: ServerFeatures;
}

/** Usage vs limit for a single resource category. */
export interface UsageQuota {
  used: number;
  limit: number;
  percentage?: number | null;
}

/**
 * Quota with limit only (no usage counter).
 *
 * @deprecated No server response has this shape: `get_usage` sends
 * `mcp_calls_per_day` as `{used, limit}`, now typed {@link UsageQuota}.
 * Kept so existing imports compile.
 */
export interface UsageQuotaLimitOnly {
  limit: number;
}

/** Workspace usage and quota information. */
export interface UsageInfo {
  plan: string;
  memories: UsageQuota;
  contexts: UsageQuota;
  members: UsageQuota;
  /** `used` counts today's MCP calls. */
  mcp_calls_per_day: UsageQuota;
}

/**
 * Hybrid search configuration for a context.
 *
 * `update_search_config` echoes every field under `config`, which
 * `updateSearchConfig()` returns typed. `get_context_info` does not
 * return the reinforce and routing fields (as of server v0.75.0), so they
 * are always absent from `ContextDetail.search_config`; read them from
 * that echo instead.
 */
export interface SearchConfig {
  /** @default 0.6 */
  semantic_weight?: number;
  /** @default 0.4 */
  bm25_weight?: number;
  /** @default 3 */
  fetch_factor?: number;
  /** @default false */
  use_rerank?: boolean;
  /** Known values: `voyage`, `cohere`, `self_hosted`. */
  reranker_provider?: string | null;
  reranker_model?: string | null;
  /** Bounded adoption + feedback re-rank. New contexts start enabled. */
  reinforce_enabled?: boolean;
  /** Bound on the reinforce adjustment, range 0.0-0.5. @default 0.15 */
  reinforce_max_boost?: number;
  /** Count only host-arbitrated feedback toward reinforce. @default false */
  reinforce_require_host_arbitration?: boolean;
  /**
   * Query-intent router: `off`, `log_only`, or `active`. Typed `string`
   * (not a literal union) for forward compatibility; the request-side
   * option uses the closed enum. @default "off"
   */
  routing_mode?: string;
}

/** Context metadata returned by `get_context_info`. */
export interface ContextDetail {
  id: string;
  name: string;
  display_name?: string | null;
  summary?: string | null;
  usage_guide?: string | null;
  /** @default true */
  is_private?: boolean;
  /** @default false */
  is_locked?: boolean;
  embedding_model?: string | null;
  embedding_dimensions?: number | null;
  search_config?: SearchConfig;
}

/** Workspace metadata in context info response. */
export interface WorkspaceInfo {
  id: string;
  name: string;
  description?: string | null;
}

/** Memory statistics for a context. */
export interface ContextStats {
  total_memories: number;
  /** @default 0 */
  working_memories?: number;
  /** @default 0 */
  persistent_memories?: number;
  details?: Record<string, unknown> | null;
}

/** Full response from `get_context_info`. */
export interface ContextInfo {
  /** @default "success" */
  status?: string;
  context: ContextDetail;
  workspace?: WorkspaceInfo | null;
  stats?: ContextStats | null;
  instructions?: string | null;
  /**
   * The context's tool guardrails, trimmed for session start (server
   * v0.74.0+) — the lane for MCP clients without tool hooks.
   *
   * Three states, and they mean different things: the key is **absent**
   * when the endpoint URL carries `?guardrails=off` (a hook client that
   * gets guardrails at the call) or the server predates it; it is
   * **`null`** when the server's guardrail read failed, which is not the
   * same as "no guardrails"; otherwise it is a {@link ContextGuardrails}.
   */
  guardrails?: ContextGuardrails | null;
}

// ---------------------------------------------------------------------------
// Context directory (server v0.73.0+, SDK issue #42)
// ---------------------------------------------------------------------------

/**
 * One entry in a `list_contexts` response.
 *
 * Since server v0.73.0 the default item is the slim name→id row
 * (`id`, `name`, `is_private`, `is_locked`, `last_used_at`). Everything
 * else is opt-in and absent unless its flag was sent: `summary` with
 * `include_summary` (capped at 300 characters) or `include_details` (full,
 * plus `embedding_model`), and `memory_count` with `include_stats`.
 */
export interface ContextListItem {
  id: string;
  name: string;
  is_private: boolean;
  is_locked: boolean;
  /** ISO 8601 datetime string; `null` for a context never used. */
  last_used_at?: string | null;
  summary?: string | null;
  /** Present, and `true`, only on a summary preview that was cut. */
  summary_truncated?: boolean;
  embedding_model?: string | null;
  memory_count?: number;
}

/**
 * Response from `list_contexts`: the contexts the caller can see, most
 * recently used first.
 *
 * `count` is the workspace's quota usage and never tracks `name_contains`;
 * the number of items returned is `total` (server v0.73.0+). `limit` and
 * `can_create` are absent when the caller has no current workspace.
 * `hint` (server v0.75.0+) appears only when the caller can see no context
 * at all, and says how to create one or get access.
 */
export interface ListContextsResponse {
  /** @default "success" */
  status?: string;
  contexts: ContextListItem[];
  count: number;
  total?: number;
  limit?: number;
  can_create?: boolean;
  hint?: string;
}

// ---------------------------------------------------------------------------
// Embedding status models (v0.6.1)
// ---------------------------------------------------------------------------

/** Info about a memory with failed embedding. */
export interface FailedMemoryInfo {
  id: string;
  summary: string;
  embedding_error?: string | null;
  /** ISO 8601 datetime string. */
  created_at: string;
  /** ISO 8601 datetime string. */
  updated_at?: string | null;
}

/** Embedding queue status for the workspace. */
export interface EmbeddingStatus {
  total: number;
  by_status: Record<string, number>;
  failed_memories: FailedMemoryInfo[];
}

// ---------------------------------------------------------------------------
// Memory stats models (v0.6.1)
// ---------------------------------------------------------------------------

/** Per-memory usage statistics. */
export interface MemoryStatItem {
  id: string;
  summary: string;
  type: string;
  importance: number;
  scope: string;
  /**
   * @deprecated Server v0.34.0 (#1046) dropped this always-zero column and
   * no longer sends it; read {@link MemoryStatItem.reference_count} or
   * {@link MemoryStatItem.access_count} instead.
   */
  use_count?: number;
  /** Surfacing count: recall results, explore and reference all count. */
  access_count: number;
  /** Adoption count: only reference() counts (server v0.34.0+, #1046). */
  reference_count?: number;
  /** ISO 8601 datetime string. */
  last_used_at?: string | null;
  embedding_status: string;
  /** ISO 8601 datetime string. */
  created_at: string;
}

/** Response from memory-stats endpoint. */
export interface MemoryStatsResponse {
  memories: MemoryStatItem[];
  total: number;
  sort_by: string;
  sort_order: string;
}

// ---------------------------------------------------------------------------
// Memory list (SDK issue #143; server origin memory-cloud #580)
// ---------------------------------------------------------------------------

/**
 * A single memory row in a paginated `list_memories` response.
 *
 * Mirrors the server's `MemoryListItem` wire shape. `created_at` /
 * `updated_at` are ISO 8601 strings (`Z`-tagged) on the wire.
 */
export interface MemoryListItem {
  id: string;
  summary: string;
  type: string;
  scope: string;
  importance: number;
  /** ISO 8601 datetime string. */
  created_at: string;
  /** ISO 8601 datetime string. */
  updated_at: string;
  /**
   * The memory's `details.location` coordinates, without `label` or
   * `text` (server v0.54.0+); `null` when it has none.
   */
  location?: Pick<MemoryLocation, "lat" | "lon"> | null;
}

/** Paginated response from `list_memories` (`GET /api/v1/memory/list`). */
export interface MemoryListResponse {
  memories?: MemoryListItem[];
  total: number;
  has_more: boolean;
}

// ---------------------------------------------------------------------------
// Duplicate detection models (v0.6.1)
// ---------------------------------------------------------------------------

/** Memory info for duplicate pair display. */
export interface DuplicateMemoryInfo {
  id: string;
  summary: string;
  type: string;
  /** ISO 8601 datetime string. */
  created_at: string;
}

/** A pair of similar memories. */
export interface DuplicatePair {
  memory_a: DuplicateMemoryInfo;
  memory_b: DuplicateMemoryInfo;
  similarity: number;
}

/** Response from duplicate detection endpoint. */
export interface DuplicatesResponse {
  pairs: DuplicatePair[];
  total_pairs: number;
  threshold: number;
  memories_scanned: number;
}

// ---------------------------------------------------------------------------
// Resource Token models
// ---------------------------------------------------------------------------

/** Request model for creating a resource token. */
export interface ResourceTokenCreate {
  /** 1-255 characters. */
  resource_id: string;
  description?: string | null;
  /** Range 1-10000. @default 1000 */
  quota_events_per_hour?: number;
}

/** Request model for updating a resource token. */
export interface ResourceTokenUpdate {
  description?: string | null;
  /** Range 1-10000. */
  quota_events_per_hour?: number | null;
}

/** Resource token metadata (no plaintext token). */
export interface ResourceTokenResponse {
  id: number;
  resource_id: string;
  description?: string | null;
  quota_events_per_hour: number;
  created_by?: string | null;
  /** ISO 8601 datetime string. */
  created_at: string;
  /** ISO 8601 datetime string. */
  last_used_at?: string | null;
  is_active: boolean;
  status: "active" | "revoked";
}

/** Resource token creation response (includes plaintext token, shown once). */
export interface ResourceTokenCreateResponse extends ResourceTokenResponse {
  token: string;
}

/** Paginated list of resource tokens. */
export interface PaginatedResourceTokensResponse {
  tokens: ResourceTokenResponse[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Atomic resource setup response (server v0.14+).
 *
 * Returned by `setup_resource`, which creates a Context, Resource entity,
 * and ingestion token in a single transaction. The plaintext `token` is
 * shown only once — save it immediately.
 */
export interface ResourceSetupResponse {
  context_id: string;
  context_name: string;
  resource_id: string;
  token: string;
  token_id: number;
  warning?: string | null;
}

/** Request model for resource event ingestion. */
export interface ResourceEventRequest {
  op: "upsert" | "delete";
  /** 1-255 characters. */
  doc_id: string;
  /** Minimum 1. */
  version?: number | null;
  payload?: Record<string, unknown> | null;
  /** 1-255 characters. */
  idempotency_key?: string | null;
  event_metadata?: Record<string, unknown>;
  /** Range 0.0-1.0. */
  importance?: number | null;
}

/** Response from single event ingestion. */
export interface ResourceEventResponse {
  /** @default "success" */
  status?: string;
  event_id: number;
  /** @default true */
  queued?: boolean;
  estimated_indexing_time_seconds?: number | null;
}

/** Request model for batch event ingestion (1-100 events). */
export interface ResourceEventBatchRequest {
  events: ResourceEventRequest[];
}

/** Response from batch event ingestion. */
export interface ResourceEventBatchResponse {
  /** @default "success" */
  status?: string;
  created_count: number;
  /** @default 0 */
  failed_count?: number;
  event_ids?: number[];
  errors?: Record<string, unknown>[];
}

/**
 * A single ingested event row returned by `list_resource_events`.
 *
 * Mirrors the server's `ResourceEventRecord` for
 * `GET /api/v1/resources/{resource_id}/events`. This is the full read
 * shape — distinct from `ResourceEventItem`, the 5-field minimal row
 * embedded in `IndexerStatusResponse.recent_events`.
 */
export interface ResourceEventRecord {
  /**
   * The event's BigInt id as a decimal string, so it keeps its precision
   * above 2^53 - 1. Unlike {@link ResourceEventItem.id}, which is a number.
   */
  id: string;
  op: "upsert" | "delete";
  doc_id: string;
  version?: number | null;
  idempotency_key?: string | null;
  importance?: number | null;
  /** ISO 8601 datetime string. */
  created_at?: string | null;
  payload?: Record<string, unknown> | null;
  event_metadata?: Record<string, unknown> | null;
  payload_bytes?: number | null;
  /** True when the server truncated `payload` for size. @default false */
  payload_truncated?: boolean;
}

/**
 * Paginated resource events response.
 *
 * Mirrors the server's `ResourceEventsResponse`: a page of events plus an
 * opaque `next_cursor` (`null` on the last page). Pass the cursor back to
 * `list_resource_events` to page forward. Unlike the `limit`/`offset`
 * token list, events use `limit`/`cursor` pagination.
 */
export interface ResourceEventsListResponse {
  events?: ResourceEventRecord[];
  next_cursor?: string | null;
}

/** Resource impact statistics per resource_id. */
export interface ResourceImpactResponse {
  resource_id: string;
  token_count: number;
  memory_count: number;
  current_schema_version?: number | null;
}

/** Field metadata definition within a resource schema. */
export interface FieldDefinition {
  name: string;
  type: "text" | "number" | "boolean" | "date" | "array" | "object";
  description: string;
  /** @default "public" */
  classification?: "public" | "internal" | "pii" | "confidential";
  /** @default "" */
  index_hint?: string;
  unit?: string | null;
  enum_values?: string[] | null;
  example?: string | null;
  /** @default false */
  required?: boolean;
}

/** Resource schema with field definitions (schema registry). */
export interface ResourceSchemaResponse {
  resource_id: string;
  schema_version: number;
  field_definitions: FieldDefinition[];
  /** ISO 8601 datetime string. */
  created_at: string;
}

// ============================================================================
// Resource list (workspace-scoped, server v0.14+)
// ============================================================================

/** Single resource entry in the workspace resource list. */
export interface ResourceListItem {
  resource_id: string;
  context_id: string;
  context_name: string;
  context_display_name?: string | null;
  token_count: number;
  memory_count: number;
  current_schema_version?: number | null;
  /** ISO 8601 datetime string. */
  created_at: string;
  /** ISO 8601 datetime string. */
  updated_at: string;
}

/** Workspace resource list response (non-paginated; server caps at < 50). */
export interface ResourceListResponse {
  resources: ResourceListItem[];
  total: number;
}

// ============================================================================
// Indexer status (server v0.14+)
// ============================================================================

/**
 * Indexer job status. Mirrors the server-side CHECK constraint on
 * `indexer_state.job_status`.
 */
export type IndexerJobStatus = "idle" | "queued" | "running" | "failed";

/**
 * Reasons the indexer may record under `metrics.skipped_reason` when a run
 * was skipped. Server degrades unknown values to `null` on the wire.
 *
 * `memories_per_day_exceeded` (server v0.68.0+) means the workspace's daily
 * memory quota ran out; the batch waits for the UTC reset.
 */
export type IndexerSkippedReason =
  | "no_pending_events"
  | "schema_not_found"
  | "context_not_found"
  | "empty_valid_points"
  | "resource_entity_missing"
  | "memories_per_day_exceeded";

/** Per-run indexer metrics, flattened from the server JSONB column. */
export interface IndexerStateMetrics {
  /** @default 0 */
  applied_upserts?: number;
  /** @default 0 */
  applied_deletes?: number;
  /** @default 0 */
  errors?: number;
  skipped_reason?: IndexerSkippedReason | null;
}

/** Indexer state snapshot for one resource. */
export interface IndexerState {
  job_status: IndexerJobStatus;
  /** ISO 8601 datetime string. */
  last_run_at?: string | null;
  /** ISO 8601 datetime string. */
  next_run_at?: string | null;
  active_version: number;
  last_offset: number;
  lag_seconds?: number | null;
  metrics: IndexerStateMetrics;
}

/** Single row in the indexer's recent ingest events list. */
export interface ResourceEventItem {
  id: number;
  op: "upsert" | "delete";
  doc_id: string;
  version?: number | null;
  /** ISO 8601 datetime string. */
  created_at?: string | null;
}

/**
 * Response body for `GET /api/v1/resources/{resource_id}/indexer-status`.
 *
 * `state` is `null` when the indexer has never run for this resource (the
 * endpoint still returns 200 in that case). A 404 means the resource slug
 * does not exist in the caller's workspace.
 */
export interface IndexerStatusResponse {
  resource_id: string;
  state?: IndexerState | null;
  recent_events?: ResourceEventItem[];
}

// ---------------------------------------------------------------------------
// Sleep Maintenance (issue #85)
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a Sleep Maintenance run.
 *
 * `degraded` (server v0.43.0+) is a run that finished although some of its
 * judge-LLM calls failed, or (v0.46.0+) although a phase failed; if the
 * judge calls all fail the run is `failed`. A degraded
 * run still made its changes, so it can be rolled back like a `completed`
 * one.
 */
export type SleepRunStatus =
  | "running"
  | "completed"
  | "degraded"
  | "failed"
  | "cancelled"
  | "rolled_back";

/** Summary of a Sleep Maintenance run, returned by `get_sleep_history`. */
export interface SleepReport {
  report_id: string;
  context_id?: string | null;
  status: SleepRunStatus;
  /** ISO 8601 datetime string. */
  started_at?: string | null;
  /** ISO 8601 datetime string. */
  completed_at?: string | null;
  memories_processed: number;
  edges_created: number;
  memories_merged: number;
  memories_promoted: number;
  llm_calls_made: number;
  llm_tokens_used: number;
  /**
   * Judge-LLM calls that raised, across all phases (server v0.43.0+). It
   * can be 0 on a `degraded` run whose grade came from a failed phase.
   *
   * @default 0
   */
  llm_call_failures?: number;
}

/**
 * One audit log entry from a Sleep Maintenance run.
 *
 * `action_type` and `phase` are free-form strings — the server may add new
 * types over time. Known `action_type` values include `create_edge`,
 * `merge`, `update_importance`, `promote`, `archive`, and `flag`.
 * `details` is a generic object whose shape depends on `action_type`.
 */
export interface SleepAction {
  id: string;
  phase: string;
  action_type: string;
  memory_id?: string | null;
  target_id?: string | null;
  details?: Record<string, unknown> | null;
  /** ISO 8601 datetime string. */
  created_at?: string | null;
}

/**
 * Full Sleep Maintenance report with audit log, returned by `get_sleep_report`.
 *
 * Extends `SleepReport` with per-phase result blobs and the per-action
 * audit log. Fields ending in `_result` are server-side phase outputs kept
 * as raw objects because their shape evolves with the maintenance pipeline.
 */
export interface SleepReportDetail extends SleepReport {
  memories_flagged: number;
  embedding_calls_made: number;
  error_message?: string | null;
  edge_discovery_result?: Record<string, unknown> | null;
  dedup_result?: Record<string, unknown> | null;
  importance_result?: Record<string, unknown> | null;
  consolidation_result?: Record<string, unknown> | null;
  reindex_result?: Record<string, unknown> | null;
  /** Server v0.45.0+. */
  merge_retention_result?: Record<string, unknown> | null;
  actions?: SleepAction[];
  action_count: number;
}

/**
 * Per-category counts of actions reversed by `rollback_sleep_run`.
 *
 * A clean rollback returns it in {@link RollbackResult}; a partial one
 * carries it on {@link KaguraPartialRollbackError.summary}.
 */
export interface RollbackSummary {
  /** @default 0 */
  edges_deleted?: number;
  /** @default 0 */
  merges_reversed?: number;
  /**
   * Merges left in place because a later write changed or removed the
   * edge (server v0.61.0+). Each is also listed in `errors`, so a
   * rollback is complete only when this is 0.
   *
   * @default 0
   */
  merges_unreversible?: number;
  /** @default 0 */
  importance_restored?: number;
  /** @default 0 */
  promotions_reversed?: number;
  /**
   * Actions left standing by design — the memory was pinned, forgotten,
   * or removed since the run. Not errors.
   *
   * @default 0
   */
  importance_kept?: number;
  /** See `importance_kept`. @default 0 */
  promotions_kept?: number;
  /** @default 0 */
  archives_restored?: number;
  /** One entry per action that could not be reversed. */
  errors?: string[];
}

/** Result of `rollback_sleep_run` on a successful (no-error) run. */
export interface RollbackResult {
  report_id: string;
  status: SleepRunStatus;
  rollback_summary: RollbackSummary;
}

// ---------------------------------------------------------------------------
// Edge model
// ---------------------------------------------------------------------------

/**
 * A neural memory edge between two memories.
 *
 * Represents a directed link from `source_id` to `target_id` with a
 * semantic `edge_type` and a `weight`/`confidence` pair. The relation
 * (`edge_type`) and who asserted it (`origin`) are separate axes: a
 * `related_to` edge is `declared` when a user created it and `semantic`
 * when Sleep Maintenance found it.
 *
 * Note: `edge_type` is intentionally typed as `string` (not a literal
 * union) because the server's `VALID_EDGE_TYPES` set grows over time. As
 * of server v0.75.0 it has 8 values: `neural_association`, `related_to`,
 * `depends_on`, `learned_from`, `continues_from`, `references_file`,
 * `supersedes` and `contradicts`. The server is the authority on
 * validation.
 */
export interface Edge {
  source_id: string;
  target_id: string;
  edge_type: string;
  /** Range 0.0-3.0. */
  weight: number;
  /** Range 0.0-1.0. */
  confidence: number;
  /**
   * Where the edge came from (server v0.52.0+): `hebbian` (runtime
   * co-activation; the only origin that decays), `semantic` (Sleep
   * Maintenance edge discovery) or `declared` (asserted explicitly — by
   * `create_edge`, `remember`'s `supersedes`, or a connector). Typed
   * `string` for forward compatibility.
   */
  origin?: string;
  /** ISO 8601 datetime string. */
  created_at?: string | null;
  /** ISO 8601 datetime string. */
  last_updated?: string | null;
}

// ---------------------------------------------------------------------------
// Geospatial memories — the WHERE axis (server origin memory-cloud #1331)
// ---------------------------------------------------------------------------

/**
 * A geographic point attached to a memory under `details.location`.
 *
 * This is what makes a memory reachable from `recallNearby()`. Any memory
 * type can carry one; the server validates the shape.
 *
 * `lat`/`lon` are typed `number` deliberately: argument coercion does not
 * recurse into `details`, so string-typed numerics (`"35.68"`) are rejected
 * server-side with HTTP 422 rather than silently parsed.
 *
 * Caveat: `updateMemory()` / PATCH replace `details` wholesale. Resend
 * `location` when updating details, or the memory silently drops off the
 * spatial axis.
 */
export interface MemoryLocation {
  /** Latitude in decimal degrees (-90..90). */
  lat: number;
  /** Longitude in decimal degrees (-180..180). */
  lon: number;
  /** Short human label, e.g. a place name. */
  label?: string;
  /** Free-form descriptive text about the place. */
  text?: string;
}

/**
 * One entry in a `recall_nearby` result list, ordered nearest first.
 *
 * `details` is the memory's full details object; when the memory was
 * stored with a location it contains `location: MemoryLocation`.
 */
export interface NearbyMemory {
  memory_id: string;
  summary: string;
  type: string;
  details?: Record<string, unknown> | null;
  /** Great-circle distance from the query point, in meters. */
  distance_m: number;
}

/** Response from `recall_nearby`: memories near a point, nearest first. */
export interface RecallNearbyResponse {
  status: string;
  results: NearbyMemory[];
  context_id: string;
  context_name: string;
  context_display_name?: string | null;
  context_is_private?: boolean;
  context_is_locked?: boolean;
}

// ---------------------------------------------------------------------------
// Tag vocabulary (server v0.15.4+, SDK issue #620; server origin #614)
// ---------------------------------------------------------------------------

/**
 * A tag with its usage count and last-used timestamp.
 *
 * Mirrors the wire shape of the server's `RelatedTagItem` as emitted by
 * the `list_tags` MCP tool. `sample_summary` from the server-side model is
 * intentionally omitted: neither MCP `list_tags` nor MCP
 * `recall.related_tags` (server v0.73.0+, which sends only `tag` and
 * `count`) populates it; only the REST recall endpoint does.
 */
export interface TagInfo {
  tag: string;
  count: number;
  /** ISO 8601 datetime string. */
  last_used_at?: string | null;
}

/** Response from `list_tags`: tag vocabulary for a context. */
export interface ListTagsResponse {
  context_id: string;
  context_name: string;
  tags?: TagInfo[];
  total: number;
}

// ---------------------------------------------------------------------------
// File objects (server v0.15.1+)
// ---------------------------------------------------------------------------

/**
 * File metadata returned by upload / list / dedup operations.
 *
 * Mirrors the server's `FileObjectOut`. The `workspace_id` field name is
 * preserved on the wire; SDK public methods accept the same value as
 * `context_id` for vocabulary consistency with the rest of the SDK.
 *
 * `status` is typed as `string` (not a literal union) because the server
 * may add new lifecycle states over time. Known values today: `reserved`,
 * `uploaded`, `confirmed`.
 *
 * `context_id` is the owning context a file is bound to for access
 * control (server v0.41.0+). It is `null` for legacy/workspace-scoped
 * files that were uploaded with no binding context — those stay fully
 * listable and accessible to the workspace.
 */
export interface FileObject {
  id: string;
  workspace_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  status: string;
  /** ISO 8601 datetime string. */
  created_at: string;
  /** ISO 8601 datetime string. */
  uploaded_at?: string | null;
  context_id?: string | null;
}

/** Internal response from `POST /api/v1/files/reserve`. */
export interface FileReserveResponse {
  file_id: string;
  upload_url: string;
  /** ISO 8601 datetime string. */
  expires_at: string;
}

/** Internal response from `GET /api/v1/files/{file_id}/download-url`. */
export interface FileDownloadUrlResponse {
  download_url: string;
}

/**
 * Paginated list of files.
 *
 * `next_cursor` is forward-compatible — the current server (memory-cloud
 * v0.15.x) returns at most `limit` items with no cursor field; the SDK
 * preserves the field as `null` so a future server bump can populate it
 * without breaking callers.
 */
export interface FileListResponse {
  files: FileObject[];
  next_cursor?: string | null;
}

// =============================================================================
// File ingestion (Issue #80)
// =============================================================================

/**
 * Cost and token usage for one ingest operation.
 *
 * Used both for dry-run cost estimation (`is_estimate: true`, no network
 * egress to LLM providers) and for the final cost reported by an actual
 * ingestion. `null` token counts indicate the counter could not estimate
 * that field.
 */
export interface CostBreakdown {
  /** @default false */
  is_estimate?: boolean;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  vision_tokens?: number | null;
  est_usd?: number | null;
  text_provider?: string | null;
  vision_provider?: string | null;
}

/**
 * A single per-step failure during ingestion.
 *
 * Best-effort ingestion collects these in `IngestResult.errors` instead of
 * aborting — these records represent recoverable per-section issues.
 */
export interface IngestErrorRecord {
  step: "fetch" | "extract" | "chunk" | "summarize" | "vision" | "remember" | "archive";
  section_index?: number | null;
  message: string;
  exception_type?: string | null;
}

/**
 * Result of a single `kagura ingest` invocation.
 *
 * Best-effort semantics: a non-empty `errors` list does NOT mean the
 * overall ingestion failed — partial successes (e.g. 4 of 5 sections
 * written) still return a populated result with the error recorded.
 * Success means the overview memory was created, i.e.
 * `overview_id != null` (the Python SDK exposes this as a computed
 * `success` property, which has no wire field and is therefore not
 * present here). Downstream sections are guaranteed to reference an
 * existing overview when present.
 */
export interface IngestResult {
  /** @default false */
  is_dry_run?: boolean;
  source_uri: string;
  source_type: "file" | "url";
  overview_id?: string | null;
  section_ids?: string[];
  /**
   * Number of sections detected during dry-run extraction. Populated only
   * on the dry-run path where no memories are written and `section_ids`
   * is empty. `null` on actual ingest runs — use `section_ids.length` then.
   */
  estimated_section_count?: number | null;
  /** @default 0 */
  skipped_images?: number;
  /**
   * `FileObject.id` when the source was archived to R2, else `null`.
   * `null` covers three cases: archival was opt-out, no files client was
   * supplied, or the upload failed (also visible as an
   * `errors[*].step === "archive"` record).
   */
  archived_file_id?: string | null;
  cost: CostBreakdown;
  warnings?: string[];
  errors?: IngestErrorRecord[];
}

// ---------------------------------------------------------------------------
// Workspace member / invitation management (#225, server v0.42.0+)
// ---------------------------------------------------------------------------

/**
 * A workspace member row (#225).
 *
 * The list endpoint populates the display/audit fields (`user_name`,
 * `user_email`, `last_login_at`, `allowed_context_ids`,
 * `credentials_status`); add/set-role responses carry the minimal
 * `user_id`/`role`/`joined_at` shape and leave the rest `null`.
 * `credentials_status` stays an untyped mapping — its inner shape is
 * server-owned display metadata (key counts / visibility booleans) that
 * the SDK forwards without interpreting.
 */
export interface WorkspaceMember {
  user_id: string;
  role: string;
  user_name?: string | null;
  user_email?: string | null;
  /** ISO 8601 datetime string. */
  joined_at?: string | null;
  /** ISO 8601 datetime string. */
  last_login_at?: string | null;
  allowed_context_ids?: string[] | null;
  credentials_status?: Record<string, unknown> | null;
}

/**
 * A workspace invitation (#225).
 *
 * Server shape (`WorkspaceInvitationResponse`): `id` is an INTEGER PK and
 * there is no `status` field — pending is derived from
 * `is_accepted`/`is_expired`. `token`/`invitation_url` are bearer
 * join-credentials: the server nulls them on programmatic LIST responses,
 * so they are optional here and only populated on create.
 */
export interface WorkspaceInvitation {
  id: number;
  email?: string | null;
  role: string;
  token?: string | null;
  invitation_url?: string | null;
  /** @default false */
  is_accepted?: boolean;
  /** @default false */
  is_expired?: boolean;
  /** ISO 8601 datetime string. */
  created_at?: string | null;
  /** ISO 8601 datetime string. */
  expires_at?: string | null;
  allowed_context_ids?: string[] | null;
}

/**
 * A member API key row (#201, server v0.42.0+).
 *
 * Server shape (`MemberAPIKeyResponse`): `id` is an INTEGER PK and the
 * plaintext field is named `plaintext_key` — non-null ONLY in the mint 201
 * response. Owner-provisioned keys are force-hidden at creation, so no
 * later call ever returns the plaintext.
 */
export interface MemberAPIKey {
  id: number;
  name: string;
  key_prefix: string;
  plaintext_key?: string | null;
  /** @default false */
  is_visible?: boolean;
  /** ISO 8601 datetime string. */
  visibility_expires_at?: string | null;
  /** ISO 8601 datetime string. */
  created_at?: string | null;
  /** ISO 8601 datetime string. */
  last_used_at?: string | null;
  /** ISO 8601 datetime string. */
  revoked_at?: string | null;
  /** ISO 8601 datetime string. */
  expires_at?: string | null;
  bound_context_id?: string | null;
}

// ---------------------------------------------------------------------------
// Agent control plane (server v0.49.0+, RFC-0002 P0; SDK issues #1/#2/#3)
// ---------------------------------------------------------------------------

/**
 * A workspace-scoped Agent Registry row (memory-cloud #1274).
 *
 * An agent is a registry entry that anchors context bindings, agent-bound
 * credentials, bootstrap, and audit correlation — it is a resource, NOT a
 * principal (it never authenticates by itself).
 *
 * `status` (`active` | `suspended` | `retired`) is the fail-closed kill
 * switch: suspended/retired agents cause every key bound to them to be
 * rejected at verify time. `enforcement_mode` (`shadow` | `enforce`) is
 * the binding enforcement ramp. Both are typed `string` (not a literal
 * union) for forward compatibility — the server is the authority;
 * request-side options use the closed enums.
 */
export interface Agent {
  id: string;
  workspace_id: string;
  name: string;
  owner_user_id: string;
  status: string;
  enforcement_mode: string;
  description?: string | null;
  framework?: string | null;
  environment?: string | null;
  version?: string | null;
  /** ISO 8601 datetime string. */
  last_seen_at?: string | null;
  /** ISO 8601 datetime string. */
  created_at: string;
  /** ISO 8601 datetime string. */
  updated_at: string;
}

/**
 * An agent→context binding row (memory-cloud #1275).
 *
 * Bindings are **purely subtractive scoping**: the effective permission
 * for an agent-bound request is the existing RBAC decision ∩ binding —
 * `can_read` gates reads, `write_policy` (`deny` | `direct`) gates
 * writes. Under `enforcement_mode="enforce"` contexts WITHOUT a binding
 * row are denied for the agent (default-deny); under `"shadow"`
 * violations are only logged. `is_default` marks the agent's bootstrap
 * default binding (max one per agent).
 *
 * `allowed_memory_types` / `allowed_source_types` narrow which memories
 * the binding may read (server v0.51.0+, memory-cloud #1299): `null` allows
 * all, `[]` denies all. They are enforced under `"enforce"` and
 * only logged under `"shadow"`. The bind options do not set them yet; use
 * `callRawTool` for that.
 */
export interface AgentBinding {
  id: string;
  agent_id: string;
  context_id: string;
  can_read: boolean;
  write_policy: string;
  is_default: boolean;
  allowed_memory_types?: string[] | null;
  allowed_source_types?: string[] | null;
  created_by: string;
  /** ISO 8601 datetime string. */
  created_at: string;
  /** ISO 8601 datetime string. */
  updated_at: string;
}

/**
 * Valid values for `getAgentBootstrap`'s `include` component selector.
 *
 * Mirrors the server's closed component set; the server rejects unknown
 * names with `invalid_arguments`.
 */
export type AgentBootstrapComponentName = "pinned" | "recall" | "upcoming" | "state" | "policy";

/**
 * The context binding a bootstrap resolved (`agent.binding`).
 *
 * `is_default` is true when the context came from the agent's default
 * binding (no explicit `context_id` was passed).
 */
export interface AgentBootstrapBinding {
  context_id: string;
  /** @default false */
  is_default?: boolean;
}

/** Agent identity block in the bootstrap envelope. */
export interface AgentBootstrapAgent {
  agent_id: string;
  name: string;
  binding?: AgentBootstrapBinding | null;
}

/**
 * Correlation block (RFC-0002 P0-4) — session/run/trace identifiers.
 *
 * `session_id` echoes the bootstrap argument when given, else the
 * server's baggage-derived session id. `run_id`/`trace_id`/`span_id` are
 * populated from the per-request correlation context when present.
 */
export interface AgentBootstrapCorrelation {
  agent_id?: string | null;
  session_id?: string | null;
  run_id?: string | null;
  trace_id?: string | null;
  span_id?: string | null;
}

/**
 * One fail-soft component payload in the bootstrap envelope.
 *
 * `status` is `"ok"` (payload inherited from the standalone tool),
 * `"skipped"` (e.g. recall without a `query`, with a `reason`), or
 * `"error"` (that component failed; the rest still return). The rest of
 * the shape belongs to the standalone tools (`load_pinned`, `recall`,
 * `recall_upcoming`, `get_state`) and evolves with them — hence the open
 * index signature.
 */
export interface AgentBootstrapComponent {
  status?: string;
  [key: string]: unknown;
}

/**
 * Composed envelope from `get_agent_bootstrap` (server v0.49.0+).
 *
 * One session-start call that rehydrates an agent's cognitive state by
 * composing existing primitives. Components are **fail-soft**: a failing
 * component reports `status="error"` under `components` while the rest
 * still return, with the top-level `degraded` flag set.
 *
 * A recall that fell back to keyword-only search sets the top-level flag
 * too (server v0.66.0+); `components.recall.degraded_reason` tells that
 * apart from a failed component (`status="error"`).
 *
 * `context` reuses {@link ContextDetail} — the server emits the block
 * byte-compatible with `get_context_info` (`search_config` is not
 * included in bootstrap).
 */
export interface AgentBootstrapResponse {
  /** @default "success" */
  status?: string;
  /** @default false */
  degraded?: boolean;
  agent: AgentBootstrapAgent;
  context?: ContextDetail | null;
  instructions?: string | null;
  components?: Record<string, AgentBootstrapComponent>;
  correlation?: AgentBootstrapCorrelation | null;
  /** ISO 8601 datetime string. */
  generated_at?: string | null;
}

// ---------------------------------------------------------------------------
// Zero-knowledge secret store (#28; server /api/v1/config/secrets, v0.39.0+)
// ---------------------------------------------------------------------------
//
// Field names mirror the server's OpenAPI schema. `status` fields are plain
// strings, not unions of literals, so a status value the server adds later
// does not become a type error in a consumer that only switches on the ones
// it knows.

/** Recipient pubkey metadata. Public material only — never private key bytes. */
export interface PubkeyResponse {
  id: string;
  identity_id: string;
  /** The public age recipient (`age1...`). */
  pubkey: string;
  /** `sha256` hex of {@link PubkeyResponse.pubkey}, as the server computed it. */
  fingerprint: string;
  label?: string | null;
  /** `"pending"` | `"active"` | `"revoked"`. */
  status: string;
  created_at: string;
  attested_at?: string | null;
  revoked_at?: string | null;
}

/** Result of storing a new ciphertext version. */
export interface SecretPutResponse {
  name: string;
  version_number: number;
  status: string;
  rotation_needed: boolean;
}

/** Secret metadata. Never includes the value. */
export interface SecretMetaResponse {
  name: string;
  status: string;
  rotation_needed: boolean;
  current_version?: number | null;
  grant_count: number;
  /**
   * Nullable in practice: the live server returns null for these on some
   * secrets even though its OpenAPI marks them required.
   */
  created_at?: string | null;
  updated_at?: string | null;
}

/** Opaque armored ciphertext returned to a granted caller. The server cannot read it. */
export interface SecretValueResponse {
  name: string;
  version_number: number;
  alg: string;
  /**
   * Armored age ciphertext (`-----BEGIN AGE ENCRYPTED FILE-----`).
   *
   * The server's schema makes this nullable, with exactly one of it and
   * `blob_ref` set, for a planned offload of large values. No write path
   * sets `blob_ref` as of server v0.75.0, so it stays typed `string`.
   */
  ciphertext: string;
  blob_ref?: string | null;
  recipients_snapshot: string[];
  rotation_needed: boolean;
  created_at: string;
}

/** Tamper-evidence check over the secret store's audit chain. */
export interface AuditVerifyResponse {
  valid: boolean;
  entries?: number | null;
  head?: string | null;
  broken_at?: number | null;
  reason?: string | null;
  /**
   * Audit rows whose hash no longer matches because a user's identity was
   * erased from them — expected, not tampering (server v0.55.0+). Present,
   * possibly empty, when `valid` is true; `null` on a failed check.
   */
  erasure_pseudonymized?: number[] | null;
}

// ---------------------------------------------------------------------------
// Tool guardrails (server v0.74.0+, SDK issue #41)
// ---------------------------------------------------------------------------

/**
 * A memory's `details.tool_trigger` — the marking that makes it a tool
 * guardrail, which a client-side hook injects (or, for `action: "block"`,
 * enforces) when a matching tool call happens.
 *
 * `tool` is a regex full-matched against the tool name; `match`, when
 * present, is searched in the call's subject: the command, file path or
 * JSON args for `on: "pre"`, the tool's error or result text for
 * `on: "result"`. The server validates both on write against a safe-regex subset shared by
 * Python and JavaScript and never runs them — matching is the hook's job.
 * `"block"` is only accepted with `on: "pre"` and a specific `match`.
 *
 * `on` and `action` are typed `string` for forward compatibility, and are
 * optional because the server writes the defaults back on save — served
 * triggers always carry them.
 */
export interface ToolTrigger {
  /** Tool-name regex, full match (max 128 chars), e.g. `"Bash|PowerShell"`. */
  tool: string;
  /** `"pre"` (before the call) | `"result"` (on its output). @default "pre" */
  on?: string;
  /** Subject regex, searched (max 200 chars); omit to fire on every `tool` call. */
  match?: string;
  /** `"inform"` | `"block"`. @default "inform" */
  action?: string;
}

/**
 * One entry in either `load_guardrails` list — one shape for both lanes.
 *
 * `summary` is the text a hook injects; never `content`, and never
 * `details` beyond the normalized `tool_trigger`. `authored_by_caller` and
 * `source_type` are provenance, so a hook can label a guardrail someone
 * else wrote.
 */
export interface GuardrailItem {
  memory_id: string;
  summary: string;
  /** Pinned items only; `null` on tool-triggered ones. */
  context_summary?: string | null;
  type: string;
  importance: number;
  delivery_mode: string;
  /**
   * Always `null` on pinned items. On a tool-triggered item, `null` means a
   * legacy non-object value that is not a usable trigger — skip it.
   */
  tool_trigger?: ToolTrigger | null;
  source_type: string;
  authored_by_caller: boolean;
  /** ISO 8601 datetime string. */
  created_at: string;
  /** ISO 8601 datetime string (falls back to `created_at`). */
  updated_at: string;
}

/**
 * Response from `load_guardrails`: a context's guardrail set for a
 * client-side hook, in two independently capped lanes.
 *
 * `pinned` is the `delivery_mode: "always"` set, bounded by `pinned_cap`;
 * `tool_triggered` is every memory carrying `details.tool_trigger`, bounded
 * by `cap` — so a large pinned set can never crowd guardrails out. A memory
 * that is both appears in both lists (dedupe by `memory_id`). Each list is
 * trusted-tier only and ordered importance DESC, created_at ASC, id ASC.
 *
 * The top-level `total_available` / `truncated` / `cap` are the sum /
 * either lane / the tool-triggered cap; the per-lane fields say which half
 * is incomplete. A truncated lane is incomplete protection, never the whole
 * set.
 *
 * `format` is the shared cache/payload format version (additive fields
 * never bump it). `version` is an opaque per-credential hash of the served
 * entries — compare it, don't parse it.
 */
export interface LoadGuardrailsResponse {
  /** @default "success" */
  status?: string;
  format: number;
  version: string;
  pinned: GuardrailItem[];
  tool_triggered: GuardrailItem[];
  total_available: number;
  truncated: boolean;
  /** The tool-triggered cap. */
  cap: number;
  pinned_cap: number;
  pinned_total_available: number;
  pinned_truncated: boolean;
  tool_triggered_total_available: number;
  tool_triggered_truncated: boolean;
  context_id: string;
  context_name: string;
  context_display_name?: string | null;
  context_is_private?: boolean;
  context_is_locked?: boolean;
}

/**
 * The `guardrails` block of `get_context_info` — the tool-triggered set,
 * trimmed for a session-start prompt rather than for a hook.
 *
 * The server currently keeps at most 10 items with summaries cut to 300
 * characters; `truncated` is set when anything was left out. Items carry
 * no trigger patterns, so a hook still needs `loadGuardrails()`.
 *
 * `tool_triggered_version` covers the tool-triggered lane alone, so it is
 * **not** comparable with {@link LoadGuardrailsResponse.version}, which
 * also covers the pinned list.
 */
export interface ContextGuardrails {
  items: Pick<
    GuardrailItem,
    "memory_id" | "summary" | "importance" | "authored_by_caller" | "source_type"
  >[];
  total_available: number;
  truncated: boolean;
  tool_triggered_version: string;
}
