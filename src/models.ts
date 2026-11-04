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
 * caller's plan includes it. A v0.141.0 server sends all twelve named here;
 * an older one omits the flags it predates, which then read as `false`. The
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
  /**
   * Content chunk vectors are a plan feature with a per-plan context cap
   * (`CONTENT_CHUNKS_REQUIRE_PLAN`; memory-cloud v0.113.0+, #2103; off by
   * default). @default false
   */
  content_chunks_require_plan?: boolean;
  /**
   * The recall LLM selector is a plan feature with a per-plan context cap
   * (`LLM_SELECTOR_REQUIRE_PLAN`; memory-cloud v0.115.0+, #2144; off by
   * default). @default false
   */
  llm_selector_require_plan?: boolean;
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
  /**
   * The terms-of-service version (server v0.77.0+); `null` when the
   * deployment does not record acceptance. Accepting the terms is a web
   * sign-in step and never gates API or MCP calls.
   */
  terms_version?: string | null;
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

/**
 * How far a Free workspace is over its capacity (memory-cloud v0.99.0+,
 * #1941) — the Python SDK's `CapacityLock`.
 *
 * While the workspace is locked, search and saving throw
 * `KaguraCapacityLockedError`; listing, deleting, export and usage keep
 * working. `over_*` is 0 on an axis that is within its limit. Every field
 * is optional so a reply that leaves one out still reads.
 */
export interface CapacityLock {
  /** Live memories in the workspace. */
  memory_count?: number | null;
  /** The effective memory limit. */
  memory_limit?: number | null;
  /** Memories to remove to unlock. */
  over_memories?: number | null;
  /** File bytes the owner can still delete. */
  used_bytes?: number | null;
  /** The effective storage limit in bytes. */
  storage_limit_bytes?: number | null;
  /** File bytes to remove to unlock. */
  over_bytes?: number | null;
  /** The web page to clean up or re-subscribe. */
  cleanup_url?: string | null;
  /**
   * The server's next step: how much to remove and what still works (MCP
   * `get_usage`).
   */
  help?: string | null;
  /**
   * When the workspace's data is deleted if it is still over capacity, an
   * ISO-8601 UTC timestamp (REST `GET /api/v1/workspace/usage/current`
   * only, memory-cloud v0.102.0+). `null` until the daily sweep has seen
   * it and while the deployment cannot purge; it may move later (v0.126.0,
   * #1971).
   */
  purge_at?: string | null;
}

/** Workspace usage and quota information. */
export interface UsageInfo {
  plan: string;
  memories: UsageQuota;
  contexts: UsageQuota;
  members: UsageQuota;
  /** `used` counts today's MCP calls. */
  mcp_calls_per_day: UsageQuota;
  /**
   * `null` unless the workspace is over its Free capacity (memory-cloud
   * v0.99.0+); absent on older servers.
   */
  capacity_lock?: CapacityLock | null;
}

/**
 * Hybrid search configuration for a context.
 *
 * `update_search_config` echoes every field under `config`, which
 * `updateSearchConfig()` returns typed. `get_context_info` does not
 * return the reinforce and routing fields (as of server v0.75.0), so they
 * are always absent from `ContextDetail.search_config`; read them from
 * that echo instead.
 *
 * The content-chunk and LLM-selector fields are absent (`null` in the
 * Python SDK's model) when the reply did not carry them: a server older
 * than the field, or a surface that does not send it. At memory-cloud
 * v0.142.0 `getContextInfo` sends `llm_selector_enabled` /
 * `llm_selector_effective` only; `updateSearchConfig` returns both
 * `*_enabled` / `*_effective` pairs in its `config`.
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
  /**
   * The stored content-chunk opt-in (memory-cloud v0.110.0+, #2015): long
   * `content` (1,500+ characters) is embedded as chunk vectors, so memory
   * content — not only summaries — goes to the embedding and rerank
   * providers.
   */
  content_chunks_enabled?: boolean | null;
  /**
   * Whether the stored flag is acted on: a vector store that keeps chunks
   * (not LanceDB) and, where the deployment gates chunks by plan, a plan
   * slot (v0.113.0+, #2103).
   */
  content_chunks_effective?: boolean | null;
  /** The plan's `max_content_chunk_contexts`; `null` when not gated by plan (v0.113.0+). */
  content_chunks_limit?: number | null;
  /** Contexts of the workspace with the flag on (v0.113.0+). */
  content_chunks_in_use?: number | null;
  /**
   * Why the toggle cannot be turned on, or the chunks are inactive:
   * `unsupported`, `plan`, `cap` or `permission` (v0.113.0+). Typed
   * `string`, so a newer reason passes.
   */
  content_chunks_disabled_reason?: string | null;
  /** Whether the caller may change the flag (v0.112.0+). */
  content_chunks_can_change?: boolean | null;
  /** Whether the vector store keeps chunk vectors — `false` on LanceDB (v0.112.0+). */
  content_chunks_supported?: boolean | null;
  /** Long memories still waiting for their chunks; 0 while the flag is off (v0.112.0+). */
  content_chunks_backfill_pending?: number | null;
  /** Where content goes with chunks on: `openai` or `self_hosted` (v0.112.0+). */
  embedding_provider?: string | null;
  /**
   * The stored recall LLM-selector opt-in (v0.115.0+, #2144): an MCP
   * `recall` may send the context's summaries and attached content to the
   * deployment's judge model.
   */
  llm_selector_enabled?: boolean | null;
  /** Whether recall acts on it — the plan, where the deployment gates it (v0.115.0+). */
  llm_selector_effective?: boolean | null;
  /** The plan's `max_llm_selector_contexts`; `null` when not gated by plan. */
  llm_selector_limit?: number | null;
  /** Contexts of the workspace with the selector on. */
  llm_selector_in_use?: number | null;
  /** `plan`, `cap` or `permission`. */
  llm_selector_disabled_reason?: string | null;
  /** Whether the caller may change it. */
  llm_selector_can_change?: boolean | null;
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
 *
 * Since server v0.82.0 (memory-cloud#1743) the directory is paged: 100
 * contexts a page by default (20 with `include_details` and no
 * `name_contains`), or `listContexts({ limit })`, and a page also stops at
 * the server's 20,000-character budget. `has_more` says more contexts
 * follow; pass `next_cursor` back as `listContexts({ cursor })` for the
 * next page. Both are absent before v0.82.0.
 */
export interface ListContextsResponse {
  /** @default "success" */
  status?: string;
  contexts: ContextListItem[];
  count: number;
  total?: number;
  /** The plan's context maximum, not the page size `listContexts({ limit })` asked for. */
  limit?: number;
  can_create?: boolean;
  /** More contexts follow this page (server v0.82.0+). */
  has_more?: boolean;
  /** The `cursor` that returns the next page; `null` on the last one (server v0.82.0+). */
  next_cursor?: string | null;
  hint?: string;
}

// ---------------------------------------------------------------------------
// Embedding status models (v0.6.1)
// ---------------------------------------------------------------------------

/**
 * Info about a memory with failed embedding.
 *
 * `updated_at` is the memory's last edit (`null` when it was never
 * edited), not the failure time. Since memory-cloud v0.120.0 (#2095) a run
 * whose claim expired on every retry ends `failed` with `embedding_error`
 * starting `claim_expired:`; an admin retry resets it.
 */
export interface FailedMemoryInfo {
  id: string;
  summary: string;
  embedding_error?: string | null;
  /** ISO 8601 datetime string. */
  created_at: string;
  /** ISO 8601 datetime string. */
  updated_at?: string | null;
  /**
   * When the embedding last failed (memory-cloud v0.95.0+, #1868); the
   * server lists the failures latest first by it. `null` on older servers
   * and for a row that failed before the server kept that clock. ISO 8601
   * datetime string.
   */
  embedding_attempted_at?: string | null;
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
  location?: MemoryListItemLocation | null;
  /**
   * When the fact held — the memory's `details.observed_at` (memory-cloud
   * v0.127.0+, #2330) — as the text the server stores, at the precision
   * its writer gave: a date `YYYY-MM-DD` or a UTC datetime
   * `YYYY-MM-DDTHH:MM:SSZ`. It is not parsed into a `Date`, because the
   * two forms are not the same value: the server sorts and filters a date
   * as the start of that UTC day (`2024-03-07` as `2024-03-07T00:00:00Z`),
   * while an exact match on `2024-03-07` finds the date form only. Pad a
   * date with `T00:00:00Z` before comparing it with a datetime. `null`
   * when the memory has none; absent on older servers.
   */
  observed_at?: string | null;
}

/**
 * WHERE-axis coordinates of a {@link MemoryListItem} (server v0.54.0+,
 * memory-cloud #1334), from the memory's `details.location`. The list
 * carries no `label`: read it from `details` with `reference()`.
 */
export type MemoryListItemLocation = Pick<MemoryLocation, "lat" | "lon">;

/** Paginated response from `list_memories` (`GET /api/v1/memory/list`). */
export interface MemoryListResponse {
  memories?: MemoryListItem[];
  total: number;
  has_more: boolean;
}

// ---------------------------------------------------------------------------
// Measurement lane — the HOW-MUCH axis (server v0.54.0+, memory-cloud #1333)
// ---------------------------------------------------------------------------

/**
 * `recallSeries` bucket sizes (request side only): the response echoes
 * the period as a plain string, so a server that grows the set still
 * parses.
 */
export type MeasurementPeriod = "day" | "week" | "month";

/**
 * `recallSeries` per-bucket aggregates (request side only). `"last"` is
 * the most recent value in the bucket by `measured_at`.
 */
export type MeasurementAggregate = "avg" | "min" | "max" | "sum" | "count" | "last";

/**
 * One observation as `recordMeasurement` stored it.
 *
 * Measurements are a lane separate from memories: never embedded, never
 * returned by `recall()`, never merged or rewritten by Sleep
 * consolidation. Keys come in the Python model's order; fields the model
 * does not name are dropped.
 */
export interface MeasurementResult {
  /** `"success"`, also when the server leaves it out. */
  status: string;
  measurement_id: string;
  metric: string;
  /**
   * The observation time stored, as the server sent it: ISO 8601,
   * `Z`-tagged UTC, "now" when the call left it out.
   */
  measured_at: string;
  /** Exact `NUMERIC` at rest, a float on the wire. */
  value: number;
  /** `null` when the observation has no unit. */
  unit: string | null;
}

/** One non-empty time bucket of a {@link MeasurementSeries}. */
export interface SeriesBucket {
  /** The UTC start of the period, ISO 8601 as the server sent it. */
  bucket: string;
  /** The aggregate over the bucket (a float, even for `agg: "count"`). */
  value: number;
  /** Observations in the bucket. */
  count: number;
}

/**
 * A metric's series, bucketed by `period` and aggregated by `agg`.
 * Keys come in the Python model's order; fields it does not name are
 * dropped.
 */
export interface MeasurementSeries {
  /** `"success"`, also when the server leaves it out. */
  status: string;
  metric: string;
  /** The period the server applied, its default included. */
  period: string;
  /** The aggregate the server applied, its default included. */
  agg: string;
  /** Non-empty buckets, oldest first; `[]` for an empty window. */
  series: SeriesBucket[];
  /**
   * The number of buckets, not of observations: sum `series[].count`
   * for those.
   */
  count: number;
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
  /** An integer before memory-cloud v0.89.0, an opaque `rtok_…` string from v0.89.0 on. */
  id: number | string;
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
  /** An integer before memory-cloud v0.89.0, an opaque `rtok_…` string from v0.89.0 on. */
  token_id: number | string;
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

/**
 * Single resource entry in the workspace resource list.
 *
 * `context_id` and `context_name` are `null` for a resource whose contexts
 * have all been deleted while it still holds active tokens (server
 * v0.94.0+, kagura-ai/memory-cloud#1863): the server lists such a row only
 * so those tokens stay reachable (`ResourceClient.listTokens`), and
 * revoking the resource's last token (`ResourceClient.revokeToken`)
 * removes the row. `context_display_name` is `null` then too, and whenever
 * the context has no display name. The server resolves such a resource's
 * impact, schema and indexer-status reads through a live context, so they
 * answer 404: `getResourceImpact` and `getIndexerStatus` throw
 * `KaguraNotFoundError` and `getResourceSchema` returns `null`.
 * `listResourceEvents` still returns its events.
 */
export interface ResourceListItem {
  resource_id: string;
  context_id?: string | null;
  context_name?: string | null;
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
 * `plan_suspended` (the plan no longer carries this ingest) and
 * `memory_limit_exceeded` (the workspace memory limit is reached) arrived
 * in server v0.99.0 (memory-cloud #1939).
 */
export type IndexerSkippedReason =
  | "no_pending_events"
  | "schema_not_found"
  | "context_not_found"
  | "empty_valid_points"
  | "resource_entity_missing"
  | "memories_per_day_exceeded"
  | "plan_suspended"
  | "memory_limit_exceeded";

/** Per-run indexer metrics, flattened from the server JSONB column. */
export interface IndexerStateMetrics {
  /** @default 0 */
  applied_upserts?: number;
  /** @default 0 */
  applied_deletes?: number;
  /** @default 0 */
  errors?: number;
  /**
   * Events that failed and were neither run again nor cleared by an
   * operator, capped at 20 (memory-cloud v0.135.0+, #2254). An event below
   * `last_offset` is not retried: an operator rewinds the indexer to
   * replay it. Since v0.139.0 (#2477) the count stays until an operator
   * clears or rewinds it (v0.135.0-v0.138.x emptied it on the next clean
   * batch). `0` on older servers.
   *
   * @default 0
   */
  failed_events?: number;
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

/**
 * Known values of {@link SleepReport.source} (memory-cloud v0.138.0+,
 * #2219).
 *
 * `sleep` is a Sleep Maintenance run; `analysis` is the row a Memory
 * Analysis run writes to record its LLM spend: no Sleep phase ran under
 * it, it has no Sleep actions and `rollback_sleep_run` refuses it with
 * `analysis_report` (v0.140.0+, #2547). Documents the known values only:
 * the field is typed `string`.
 */
export type SleepReportSource = "sleep" | "analysis";

/**
 * Summary of a Sleep Maintenance run, returned by `get_sleep_history`.
 *
 * `llm_calls_made` counts successful calls only since memory-cloud
 * v0.112.0 (#2060), so it reads lower than an older server's count for
 * the same traffic.
 */
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
   * `null` (or absent) from servers older than v0.43.0, as the Python
   * SDK's `int | None` reads it, and in replies that carry `null`.
   *
   * @default null
   */
  llm_call_failures?: number | null;
  /**
   * `"sleep"` or `"analysis"` (memory-cloud v0.138.0+, #2219; see
   * {@link SleepReportSource}); absent on older servers. Typed `string`
   * for forward compatibility.
   */
  source?: string | null;
}

/**
 * One audit log entry from a Sleep Maintenance run.
 *
 * `action_type` and `phase` are free-form strings — the server may add new
 * types over time. Known `action_type` values include `create_edge`,
 * `merge`, `update_importance`, `promote`, `archive`, and `flag`.
 * `details` is a generic object whose shape depends on `action_type`.
 *
 * An action too large for its page (memory-cloud v0.82.0+, #1743) comes
 * without `details`: `details_omitted` is `true` and `details_total_chars`
 * gives the size it would have had.
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
  /** `details` was left out of this page (server v0.82.0+). @default false */
  details_omitted?: boolean;
  /** The size `details` would have had, set with `details_omitted` (server v0.82.0+). */
  details_total_chars?: number | null;
}

/**
 * Full Sleep Maintenance report with audit log, returned by `get_sleep_report`.
 *
 * Extends `SleepReport` with per-phase result blobs and the per-action
 * audit log. Fields ending in `_result` are server-side phase outputs kept
 * as raw objects because their shape evolves with the maintenance pipeline.
 *
 * Since memory-cloud v0.82.0 (#1743) `actions` is one page of the run's
 * actions in id order: `action_count` is the run's total,
 * `actions_has_more` says more actions follow, and `actions_next_cursor`
 * is the `actionsCursor` for the next page (`null` on the last page).
 * Older servers send every action and neither paging field. `note`
 * (v0.140.0+, #2547) is set on an analysis report (`source: "analysis"`):
 * Memory Analysis spend with no Sleep actions, so there is nothing to roll
 * back.
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
  /** More actions follow this page (server v0.82.0+). @default false */
  actions_has_more?: boolean;
  /** The `actionsCursor` for the next page; `null` on the last one (server v0.82.0+). */
  actions_next_cursor?: string | null;
  /** Set on an analysis report (server v0.140.0+). */
  note?: string | null;
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
  /**
   * Restored memories whose content chunks could not be written during
   * the rollback and were queued for the embedding sweep to rebuild
   * (server v0.112.0+, #2061). The restore itself went through, so these
   * are not errors.
   *
   * @default 0
   */
  chunks_requeued?: number;
  /**
   * Restored memories whose vector was queued for a rebuild (server
   * v0.112.0+, #2065). Not errors either.
   *
   * @default 0
   */
  points_requeued?: number;
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
 * Since memory-cloud v0.82.0 (#1743) an item carries `location` — the
 * memory's `details.location` — and no `details`. With
 * `recallNearby({ includeDetails: true })` it carries the full `details`
 * object instead (`details.location` is inside it), held to the reply
 * budget (about 20,000 characters): from the last item backwards, an item
 * that does not fit carries `details_omitted: true` and
 * `details_total_chars` in place of `details` — read it with `reference()`.
 * An older server always sends `details` and no `location`.
 */
export interface NearbyMemory {
  memory_id: string;
  summary: string;
  type: string;
  /** The memory's `details.location` (server v0.82.0+, without `includeDetails`). */
  location?: MemoryLocation | null;
  /** The whole details object: with `includeDetails`, or from a server before v0.82.0. */
  details?: Record<string, unknown> | null;
  /** `true` when `details` did not fit the reply budget (with `includeDetails`). */
  details_omitted?: boolean;
  /** The size of the omitted `details`, in characters of JSON. */
  details_total_chars?: number;
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
// Recall results (memory-cloud v0.82.0 / v0.108.0 / v0.114.0, SDK issue #82)
// ---------------------------------------------------------------------------

/**
 * Valid `recall` `verbosity` values (memory-cloud v0.108.0+, #2002;
 * request side only).
 *
 * `"compact"` is the server default: a 160-character `summary` head and no
 * `tags`, `context_summary` or `scope`. `"full"` adds those, `version`
 * (v0.113.0+) and the uncut `summary`.
 */
export type RecallVerbosity = "compact" | "full";

/**
 * `recall`'s relevance verdict, the reply's first key: read `level` before
 * the hits. `"none"` / `"low"` mean probably not stored here; `"high"` /
 * `"moderate"` that the hits are worth reading — the content is still the
 * source of truth.
 */
export interface RecallConfidence {
  /** `"high"`, `"moderate"`, `"low"` or `"none"`. */
  level: string;
  top_score?: number | null;
  prominence?: number | null;
  relative_margin?: number | null;
  result_count: number;
  rationale: string;
}

/**
 * A near-duplicate this memory may supersede — a suggestion, never an edge.
 * Accept it by creating a `"supersedes"` edge; reject it with
 * `updateMemory({ memoryId, dismissSupersedeCandidate: true })`.
 *
 * Since memory-cloud v0.109.0 (#2016) `detected_at` is absent rather than
 * `null` when it has no value, and `verified` is a key only when `true`:
 * the deployment's judge (`SUPERSEDE_VERIFY_MODE=llm`) confirmed that this
 * memory replaces the candidate. Keys a newer server adds pass through.
 */
export interface SupersedeCandidate {
  memory_id: string;
  summary: string;
  similarity: number;
  /** ISO 8601. Absent when unset (v0.109.0+); older servers send `null`. */
  detected_at?: string | null;
  /** `true` when judge-verified (v0.109.0+); absent otherwise. */
  verified?: boolean;
  [key: string]: unknown;
}

/**
 * What the recall LLM selector did to the page (memory-cloud v0.115.0+,
 * #2144) — only on a context with `llm_selector_enabled`.
 *
 * `applied: true` carries `model`, `kept` / `dropped` (rows left and
 * removed) and `dropped_memory_ids` (at most 20, page order);
 * `applied: false` carries only `reason` (`timeout`, `provider_error`,
 * `invalid_answer`, `daily_cap`, `too_large`, `no_provider`,
 * `counter_unavailable`, `inactive`), and the page is the unselected one.
 */
export interface RecallSelector {
  applied: boolean;
  model?: string;
  kept?: number;
  dropped?: number;
  dropped_memory_ids?: string[];
  reason?: string;
}

/**
 * One `recall` hit. Which keys it has depends on `verbosity` (memory-cloud
 * v0.108.0+, #2002). A key that does not apply is left out: `context_summary`
 * and the annotations since v0.73.0, an empty `tags` since v0.93.0. Older
 * servers send `null` / `[]` for them, so test them for truthiness, not for
 * `undefined`. `updated_at` is `null` on a memory never edited.
 *
 * - **compact** (the server default): `memory_id`, the first 160
 *   characters of `summary` (`summary_cut: true` when it was shortened),
 *   `type`, `importance`, `score`, `created_at` and `updated_at`.
 * - **full** (`verbosity: "full"`, and every server before v0.108.0): the
 *   uncut `summary` plus `context_summary`, `scope`, `tags` and `version`
 *   (v0.113.0+).
 * - Both: `content` on the top `full` rows (v0.114.0+, up to 1,500
 *   characters; `content_truncated` / `content_next_offset` when cut,
 *   `spans` when the LLM selector cut it to passages, v0.115.0+),
 *   `observed_at` (v0.127.0+), `superseded_by`, `contradicts`,
 *   `supersede_candidate` and `folded` (v0.114.0+).
 */
export interface RecallResult {
  memory_id: string;
  /** The uncut summary on `verbosity: "full"`, else at most 160 characters. */
  summary: string;
  /** `true` when `summary` is a cut head (compact only). */
  summary_cut?: boolean;
  /** Up to 1,500 characters of content, on the top `full` rows (v0.114.0+). */
  content?: string;
  /** `true` when `content` was cut at 1,500 characters. */
  content_truncated?: boolean;
  /**
   * Where the rest of the content starts — the server `reference` tool's
   * `content_offset`. `reference()` reads the whole memory.
   */
  content_next_offset?: number;
  /**
   * Verbatim passages the LLM selector kept (v0.115.0+, #2144): character
   * offsets into the stored content, `end` exclusive.
   */
  spans?: Array<{ start: number; end: number }>;
  type: string;
  importance: number;
  score: number | null;
  /** `verbosity: "full"` only. */
  context_summary?: string | null;
  /** `verbosity: "full"` only. */
  scope?: string;
  /**
   * ISO 8601, on both shapes: compact rows carry it from v0.108.0 (the
   * server CHANGELOG lists it as full-only there; its code and tests do not).
   */
  created_at?: string;
  /** ISO 8601; `null` on a memory never edited. */
  updated_at?: string | null;
  /** When the fact held, a date or a UTC datetime (v0.127.0+, #2330). */
  observed_at?: string;
  /** The memory's version, `verbosity: "full"` only (v0.113.0+). */
  version?: number;
  /** `verbosity: "full"` only; absent when the memory has none. */
  tags?: string[];
  /** Set only under `includeSuperseded: true`. */
  superseded_by?: string | null;
  contradicts?: string[] | null;
  supersede_candidate?: SupersedeCandidate | null;
  /**
   * Judge-verified older versions of the same fact, folded under this, the
   * newest, row (v0.114.0+, #2123). `includeSuperseded: true` turns
   * folding off.
   */
  folded?: { count: number; memory_ids: string[] };
  [key: string]: unknown;
}

/**
 * Response from `recall`. Optional keys are absent when they do not apply.
 *
 * Over `maxChars` the server takes `content` off the lowest-ranked rows
 * first (`full_applied` then counts the rows that kept it), then
 * `context_summary` off every row (`context_summary_omitted: true`), then
 * drops the lowest-ranked rows (`truncated: true`; `count` is the rows
 * returned).
 */
export interface RecallResponse {
  confidence?: RecallConfidence;
  status: string;
  results: RecallResult[];
  count: number;
  /** The LLM selector's report (v0.115.0+). */
  selector?: RecallSelector;
  /** Rows that kept their content after `maxChars` took some (v0.114.0+). */
  full_applied?: number;
  /** `true` when `maxChars` took `context_summary` off every row (v0.82.0+). */
  context_summary_omitted?: boolean;
  /** `true` when `maxChars` dropped rows (v0.82.0+). */
  truncated?: boolean;
  /** Omitted when empty since v0.93.0. */
  related_tags?: Array<Pick<TagInfo, "tag" | "count">>;
  /**
   * Seeds for `explore()`, with `includeExploreHints`. Since v0.135.0
   * (#2470) only on an MCP URL that lists `explore`.
   */
  explore_hints?: Array<{ memory_id: string; reason: string }>;
  /**
   * In place of `explore_hints` on a URL that does not list `explore`
   * (v0.135.0+): a sentence naming the opt-in.
   */
  explore_hints_omitted?: string;
  /** Stored tags close to each requested one, when a tag filter matched nothing (v0.65.0+). */
  tag_suggestions?: Record<string, string[]>;
  /** `true` when the semantic half was unavailable and the results are keyword-only (v0.66.0+). */
  degraded?: boolean;
  degraded_reason?: string | null;
  context_id?: string | null;
  context_name?: string | null;
  context_display_name?: string | null;
  context_is_private?: boolean | null;
  context_is_locked?: boolean | null;
  [key: string]: unknown;
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

/**
 * Response from `list_tags`: tag vocabulary for a context.
 *
 * `has_more` (memory-cloud v0.82.0+, #1743) is `true` when more tags
 * matched than this reply holds: the MCP tool returns at most 200 tags
 * whatever the `limit`. There is no cursor — narrow with `prefix` or
 * `minCount`. Absent (read it as `false`) on a `withTags` drill-down,
 * whose REST route returns up to `limit` tags and reports nothing, and on
 * older servers.
 */
export interface ListTagsResponse {
  context_id: string;
  context_name: string;
  tags?: TagInfo[];
  total: number;
  /** @default false */
  has_more?: boolean;
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
 *
 * `allowed_context_ids` is the member's context access list. Since
 * memory-cloud v0.126.0 it applies on every context path: an owner or
 * admin reaches every shared context, a member or viewer exactly what the
 * list names, and with no list (`null`) a viewer reaches every shared
 * context and a member none.
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
  /**
   * `true` for a member past the seats the workspace's plan carries
   * (memory-cloud v0.100.0+, #1943): every workspace route refuses them
   * (`403 FEAT-001`, `feature: members`) until the plan carries enough
   * seats or a member is removed. The owner always has a seat. `false` on
   * older servers.
   *
   * @default false
   */
  seat_paused?: boolean;
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
  /** An integer before memory-cloud v0.89.0, an opaque `winv_…` string from v0.89.0 on. */
  id: number | string;
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
 * Server shape (`MemberAPIKeyResponse`): `id` is an integer before
 * memory-cloud v0.89.0 and an opaque `akey_…` string from v0.89.0 on; the
 * plaintext field is named `plaintext_key` — non-null ONLY in the mint 201
 * response. Owner-provisioned keys are force-hidden at creation, so no
 * later call ever returns the plaintext.
 *
 * `default_context_id` / `default_context_name` (memory-cloud v0.118.0+,
 * #2188) are the key's MCP default context; the name is `null` when none
 * is set or the caller cannot read that context. `agent_id` (v0.118.0+)
 * is set when the key is bound to an agent (such a key carries no default
 * context: the agent's default binding applies). `connector_id`
 * (v0.129.0+, #2299) is set when the key is a connector's shared key. All
 * four are `null` for an ordinary key and on older servers.
 */
export interface MemberAPIKey {
  id: number | string;
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
  default_context_id?: string | null;
  default_context_name?: string | null;
  agent_id?: string | null;
  connector_id?: string | null;
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
 *
 * In a `listAgents` row (memory-cloud v0.82.0+, #1743) `description` is a
 * 200-character preview, with `description_truncated` set when it was
 * cut; `KaguraClient.getAgent` returns it whole.
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
  /** `description` is a cut preview (a `listAgents` row, server v0.82.0+). @default false */
  description_truncated?: boolean;
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
  /**
   * `true` when the reply budget (`maxChars`, server v0.82.0+) took
   * `context_summary` off the component items; each component it then cut
   * items from says `truncated: true`. Absent otherwise.
   */
  context_summary_omitted?: boolean;
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
  /**
   * Subject regex, searched (max 200 chars); omit to fire on every `tool`
   * call. A trigger read by `MemoryClient.loadGuardrails` has `null` here
   * when it has none, as the Python SDK's model reads it: test for a
   * string, not for `undefined`. Leave it out when writing one — the
   * server refuses `"match": null`.
   */
  match?: string | null;
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
 *
 * Every field but `memory_id`, `summary` and `importance` is optional in
 * the Python SDK's model: `MemoryClient.loadGuardrails` reads one the
 * server left out as `null` (unknown), so they are typed nullable.
 */
export interface GuardrailItem {
  memory_id: string;
  summary: string;
  /** Pinned items only; `null` on tool-triggered ones. */
  context_summary?: string | null;
  type: string | null;
  importance: number;
  delivery_mode: string | null;
  /**
   * Always `null` on pinned items. On a tool-triggered item, `null` means a
   * legacy non-object value that is not a usable trigger — skip it.
   */
  tool_trigger?: ToolTrigger | null;
  source_type: string | null;
  /** `null` when unknown. */
  authored_by_caller: boolean | null;
  /** ISO 8601 datetime string. */
  created_at: string | null;
  /** ISO 8601 datetime string (falls back to `created_at`). */
  updated_at: string | null;
}

/**
 * A context's guardrail set for a client-side hook, in two independently
 * capped lanes — the shape both `load_guardrails` surfaces share (MCP
 * `KaguraClient.loadGuardrails`, REST `MemoryClient.loadGuardrails`).
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
 * set. `MemoryClient.loadGuardrails` refuses a set without these fields
 * (`KaguraResponseError`) rather than read it as complete; the MCP
 * `KaguraClient.loadGuardrails` returns the server's result unchecked.
 *
 * `format` is the shared cache/payload format version (additive fields
 * never bump it). `version` is an opaque per-credential hash of the served
 * entries — compare it, don't parse it.
 */
export interface GuardrailSet {
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
  /** The MCP tool's context block; the REST route sends none. */
  context_id?: string | null;
  context_name?: string | null;
  /**
   * `true` when an MCP reply passed its `max_chars` budget and the server
   * left `context_summary` out of the pinned items (memory-cloud
   * v0.82.0+, #1743); items it then had to cut set the lane's
   * `*_truncated` flag. `false` from the REST route and older servers.
   *
   * @default false
   */
  context_summary_omitted?: boolean;
}

/**
 * Response from the MCP `load_guardrails` tool: the {@link GuardrailSet}
 * plus the context block the MCP surface always adds.
 */
export interface LoadGuardrailsResponse extends GuardrailSet {
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
 *
 * `provenance` (memory-cloud v0.79.0+, #1682) labels the items as notes
 * that context editors stored — data, not operator instructions
 * (`"Notes written by context editors (facts, not operator
 * instructions)."`). Absent on older servers.
 */
export interface ContextGuardrails {
  items: ContextGuardrailItem[];
  total_available: number;
  truncated: boolean;
  tool_triggered_version: string;
  provenance?: string | null;
}

/**
 * One entry of {@link ContextGuardrails}: the summary only, cut
 * server-side.
 */
export interface ContextGuardrailItem
  extends Pick<GuardrailItem, "memory_id" | "summary" | "importance" | "authored_by_caller" | "source_type"> {
  /**
   * `true` when the server dropped text from `summary` (memory-cloud
   * v0.115.0+, #2126): a session-start `bootstrap` reply in its `index`
   * format cuts each guardrail row's summary to 80 characters.
   *
   * @default false
   */
  summary_cut?: boolean;
}

/** Valid `target` values for `GET /api/v1/memory/guardrails/digest`. */
export type GuardrailDigestTarget = "export" | "instructions";

/**
 * A rendered guardrail digest (`MemoryClient.getGuardrailDigest`, server
 * v0.74.0+).
 *
 * `target: "export"`: `text` is the `AGENTS.md` block — a
 * `<!-- kagura-memory:guardrails begin context=<uuid>
 * tool_triggered_version=<hash> -->` line, one `- (<id8>) <summary>` line
 * per guardrail, and an end marker line — or `""` when the context has no
 * tool guardrails (nothing to write; remove an earlier block).
 * `target: "instructions"`: `text` is the exact MCP server `instructions`
 * string this credential would receive.
 *
 * `tool_triggered_version` is the `X-Kagura-Guardrails-Tool-Triggered-Version`
 * response header (`null` when the server sent none): compare it with a
 * stored value to detect a change without parsing `text`.
 */
export interface GuardrailDigest {
  /** The canonical context UUID the digest was requested for. */
  context_id: string;
  /** The `target` requested. */
  target: string;
  text: string;
  tool_triggered_version: string | null;
  content_type: string | null;
}
