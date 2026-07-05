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

/** A message in a conversation session. */
export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

/** An artifact attached to a session (code, document, etc.). */
export interface Artifact {
  type: "code" | "document" | "error" | "config";
  content: string;
  source?: string | null;
  language?: string | null;
}

/** A conversation session with messages and optional artifacts. */
export interface Session {
  messages: Message[];
  artifacts?: Artifact[];
}

/** Information about a remembered memory. */
export interface MemoryInfo {
  memory_id: string;
  summary: string;
}

/** A recalled memory with relevance score. */
export interface Memory {
  memory_id: string;
  summary: string;
  score: number;
}

/** LLM token usage statistics. */
export interface LLMUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  model: string;
}

/** A memory to be stored, as determined by LLM analysis. */
export interface MemoryToStore {
  /** 1-250 characters. */
  summary: string;
  content: string;
  /** @default "note" */
  type?: "code" | "note" | "decision" | "bug-fix" | "feature" | "learning";
  /** Range 0.0-1.0. @default 0.5 */
  importance?: number;
  tags?: string[];
}

/** A recall query, as determined by LLM analysis. */
export interface RecallQuery {
  query: string;
  /** @default "" */
  reason?: string;
  filters?: Record<string, unknown> | null;
}

/** Internal model for LLM analysis results. */
export interface AnalysisResult {
  should_remember: boolean;
  memories_to_store?: MemoryToStore[];
  should_recall: boolean;
  recall_queries?: RecallQuery[];
  llm_usage?: LLMUsage | null;
}

/** Memory discovered through explore operation. */
export interface ExploredMemory {
  memory_id: string;
  summary: string;
  /** @default 0.0 */
  activation?: number;
  /** @default 0 */
  hop?: number;
}

/** Result of processing a session. */
export interface ProcessResult {
  remembered?: MemoryInfo[];
  recalled?: Memory[];
  explored?: ExploredMemory[];
  context_used: string;
  actions?: string[];
  llm_usage?: LLMUsage | null;
}

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

/** Feature flags reported by the server. */
export interface ServerFeatures {
  /** @default false */
  neural_memory?: boolean;
  /** @default false */
  research_tools?: boolean;
}

/** Server information from `/api/v1/system/info`. */
export interface ServerInfo {
  name: string;
  version: string;
  description?: string | null;
  environment?: string | null;
  features?: ServerFeatures;
}

/** Usage vs limit for a single resource category. */
export interface UsageQuota {
  used: number;
  limit: number;
  percentage?: number | null;
}

/** Quota with limit only (no usage counter). */
export interface UsageQuotaLimitOnly {
  limit: number;
}

/** Workspace usage and quota information. */
export interface UsageInfo {
  plan: string;
  memories: UsageQuota;
  contexts: UsageQuota;
  members: UsageQuota;
  mcp_calls_per_day: UsageQuotaLimitOnly;
}

/** Hybrid search configuration for a context. */
export interface SearchConfig {
  /** @default 0.6 */
  semantic_weight?: number;
  /** @default 0.4 */
  bm25_weight?: number;
  /** @default 3 */
  fetch_factor?: number;
  /** @default false */
  use_rerank?: boolean;
  reranker_provider?: string | null;
  reranker_model?: string | null;
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
  use_count: number;
  access_count: number;
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
  id: number;
  op: "upsert" | "delete";
  doc_id: string;
  version?: number | null;
  idempotency_key?: string | null;
  importance?: number | null;
  /** ISO 8601 datetime string. */
  created_at?: string | null;
  payload?: Record<string, unknown> | null;
  event_metadata?: Record<string, unknown>;
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
 */
export type IndexerSkippedReason =
  | "no_pending_events"
  | "schema_not_found"
  | "context_not_found"
  | "empty_valid_points"
  | "resource_entity_missing";

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

export type SleepRunStatus = "running" | "completed" | "failed" | "cancelled" | "rolled_back";

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
  actions?: SleepAction[];
  action_count: number;
}

/** Per-category counts of actions reversed by `rollback_sleep_run`. */
export interface RollbackSummary {
  /** @default 0 */
  edges_deleted?: number;
  /** @default 0 */
  merges_reversed?: number;
  /** @default 0 */
  importance_restored?: number;
  /** @default 0 */
  promotions_reversed?: number;
  /** @default 0 */
  archives_restored?: number;
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
 * semantic `edge_type` and a `weight`/`confidence` pair. Edges are created
 * either by users (manual curation) or by server-side processes (Sleep
 * Maintenance, k-NN seeding, declared links, tag co-occurrence).
 *
 * Note: `edge_type` is intentionally typed as `string` (not a literal
 * union) because the server's `VALID_EDGE_TYPES` set is open-ended and
 * grows with new auto-discovery processes (currently 7 values:
 * `neural_association`, `related_to`, `depends_on`, `learned_from`,
 * `semantic_similarity`, `declared_link`, `tag_cooccurrence`). The server
 * is the authority on validation.
 */
export interface Edge {
  source_id: string;
  target_id: string;
  edge_type: string;
  /** Range 0.0-3.0. */
  weight: number;
  /** Range 0.0-1.0. */
  confidence: number;
  /** ISO 8601 datetime string. */
  created_at?: string | null;
  /** ISO 8601 datetime string. */
  last_updated?: string | null;
}

// ---------------------------------------------------------------------------
// Tag vocabulary (server v0.15.4+, SDK issue #620; server origin #614)
// ---------------------------------------------------------------------------

/**
 * A tag with its usage count and last-used timestamp.
 *
 * Mirrors the wire shape of the server's `RelatedTagItem` as emitted by
 * the `list_tags` MCP tool. `sample_summary` from the server-side model is
 * intentionally omitted because `list_tags` does not populate it (only
 * `recall.related_tags` does). The schema is otherwise aligned so callers
 * can unify their tag-info type between the two surfaces.
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
