/** Low-level client for Kagura Memory Cloud MCP tools (port of client.py). */

import { buildBootstrapPayload } from "./agentBootstrap.js";
import type { GetAgentBootstrapOptions } from "./agentBootstrap.js";
import { resolveAuth } from "./auth/resolve.js";
import type { AuthProvider } from "./auth/types.js";
import {
  excMessage,
  KaguraConnectionError,
  KaguraError,
  KaguraNotFoundError,
  KaguraPartialRollbackError,
  KaguraPermissionError,
  KaguraResponseError,
  // Referenced only from JSDoc {@link} on the plan-gated options.
  KaguraCapacityLockedError,
  KaguraFeatureNotAvailableError,
  KaguraQuotaError,
} from "./errors.js";
import {
  annotateServerError,
  baseUrlFromMcp,
  bodyRetryAfter,
  detailOf,
  gateError,
  isRecord,
  MCP_GATE_CODES,
  mcpEnvelopeFields,
  mcpSessionExpired,
  mcpSessionHeader,
  parseJsonBody,
  SDK_VERSION,
  serverErrorFieldsOf,
  throwForKaguraStatus,
  validateHttpsUrl,
} from "./http.js";
import type {
  Agent,
  AgentBinding,
  AgentBootstrapResponse,
  ContextInfo,
  DuplicatesResponse,
  Edge,
  EmbeddingModelsResponse,
  EmbeddingStatus,
  ListContextsResponse,
  ListTagsResponse,
  LoadGuardrailsResponse,
  MeasurementAggregate,
  MeasurementPeriod,
  MeasurementResult,
  MeasurementSeries,
  MemoryListResponse,
  // Referenced only from JSDoc {@link} on the details/recallNearby options.
  MemoryLocation,
  MemoryStatsResponse,
  // Referenced only from JSDoc {@link} on recallNearby.
  NearbyMemory,
  RecallNearbyResponse,
  RecallResponse,
  // Referenced only from JSDoc {@link} on the recall options.
  RecallResult,
  RecallVerbosity,
  RollbackResult,
  RollbackSummary,
  SearchConfig,
  SeriesBucket,
  ServerInfo,
  SleepReport,
  SleepReportDetail,
  TagInfo,
  // Referenced only from JSDoc {@link} on the details options.
  ToolTrigger,
  UsageInfo,
} from "./models.js";
import { JsonNestingError, parseJsonLossless } from "./losslessJson.js";
import { pathSegment } from "./pathSegment.js";
import { RECALL_FULL_MAX, validateIntRange, validateMaxChars } from "./responseBudget.js";
import {
  DUPLICATES_RESPONSE,
  EMBEDDING_MODELS_RESPONSE,
  EMBEDDING_STATUS,
  MEMORY_STATS_RESPONSE,
  readModel,
  SERVER_INFO,
  type Model,
} from "./pyModels.js";
import { hasLoneSurrogate, STRING_UNICODE } from "./pydanticNumber.js";
import { meetsMinimum, requireVersion } from "./versionCheck.js";
import { pyStrip } from "./pyCompat.js";
// Session tools (#86).
import { KaguraPartialSessionRollbackError } from "./errors.js";
import type {
  BootstrapComponentName,
  BootstrapFormat,
  BootstrapResponse,
  ChangesSinceResponse,
  ForgetBatchResult,
  GuideResponse,
  ListMatchingResponse,
  ListOrderBy,
  RememberBatchResult,
  RevisionsPage,
  SessionRollbackResult,
  SessionRollbackSummary,
  ToolDescriptions,
} from "./models.js";
import {
  BOOTSTRAP_RESPONSE,
  CHANGES_SINCE_RESPONSE,
  FORGET_BATCH_RESULT,
  GUIDE_RESPONSE,
  LIST_MATCHING_RESPONSE,
  REMEMBER_BATCH_RESULT,
  REVISIONS_PAGE,
  SESSION_ROLLBACK_RESULT,
  SESSION_ROLLBACK_SUMMARY,
  TOOL_DESCRIPTIONS,
} from "./pyModels.js";
import { MAX_CHARS_MAX, MAX_CHARS_MIN } from "./responseBudget.js";
import { parseUuid } from "./uuid.js";
import { isSet, pyFloatRepr, pyRepr, pyStr, pyTypeName } from "./python.js";
import {
  ResponseReader,
  laxFloat,
  laxInt,
  laxStr,
  nullable,
  responseShapeError,
  type Coercer,
  type Loc,
} from "./responseShape.js";

/**
 * The memory-cloud server version this SDK targets and was tested against.
 *
 * The check is opt-in: callers must explicitly invoke
 * {@link KaguraClient.checkServerVersion} to log an advisory warning when
 * the connected server is older. Plain construction and tool calls never
 * throw on version mismatch. An older server still answers, but it may
 * silently ignore options it predates, omit fields it predates, and report
 * a tool it predates as not found; the methods say which server version
 * a feature needs.
 */
export const MIN_SERVER_VERSION = "0.75.0";

/** Parsed once, so a malformed {@link MIN_SERVER_VERSION} fails at import. */
const MIN_SERVER_VERSION_TRIPLE = requireVersion(MIN_SERVER_VERSION, "MIN_SERVER_VERSION");

/**
 * The advisory {@link KaguraClient.checkServerVersion} logs: a warning when
 * `version` is below {@link MIN_SERVER_VERSION}, and nothing for one that
 * meets it or cannot be compared. `doctor` gives it after its own read of
 * the body, as Python's `check_server_version` does after its model's.
 *
 * @param warn Where the warning goes (`KaguraClientOptions.warn`); default
 *   `console.warn`.
 * @internal Not exported from the package entry point.
 */
export function warnBelowMinimum(
  version: unknown,
  warn: (message: string) => void = (message) => console.warn(message),
): void {
  if (meetsMinimum(version, MIN_SERVER_VERSION_TRIPLE) === false) {
    warn(
      `Server version ${String(version)} is below the SDK's tested minimum ` +
        `${MIN_SERVER_VERSION}. Some features may not work; older servers ` +
        "may silently ignore unknown parameters.",
    );
  }
}

/**
 * A context id as its path segment in a REST route: percent-encoded, and
 * refused when it is `.`, `..` or empty (#66, see {@link pathSegment}).
 */
function contextSegment(contextId: string): string {
  return pathSegment(contextId, "contextId", "a context id");
}

/** Generic parsed-JSON result of an MCP tool call. */
export type ToolResult = Record<string, unknown>;

export type DeliveryMode = "always" | "on_recall" | "on_trigger";
/** Sort fields `getMemoryStats` accepts on server v0.34.0+ (#1046). */
export type MemoryStatsSortField =
  | "access_count"
  | "reference_count"
  | "importance"
  | "created_at"
  | "last_used_at";
export type SearchMode = "hybrid" | "semantic" | "keyword";
/** Query-intent router gate for a context's recall (`updateSearchConfig`). */
export type RoutingMode = "off" | "log_only" | "active";
export type SourceType = "file" | "url" | "vault" | "api" | "manual";

/** Agent lifecycle state — `updateAgent`'s fail-closed kill switch. */
export type AgentStatus = "active" | "suspended" | "retired";
/** Binding enforcement ramp: `enforce` denies, `shadow` only logs. */
export type AgentEnforcementMode = "shadow" | "enforce";
/**
 * Per-binding write gate: `"deny"` (server default) or `"direct"`.
 * `"staged"` is reserved for a later server phase.
 */
export type AgentWritePolicy = "deny" | "direct";

export interface KaguraClientOptions {
  /** Explicit Kagura API key. When omitted, the resolution chain runs. */
  apiKey?: string;
  /** Explicit MCP URL. When omitted, derived from the credential source. */
  mcpUrl?: string;
  /** Request timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
  /** Named OAuth profile to load (overrides KAGURA_PROFILE and the file default). */
  profile?: string;
  /** Fetch implementation override (for tests; default: globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
  /** Environment source override (for tests; default: process.env). */
  env?: Record<string, string | undefined>;
  /** Home directory override (for tests). */
  home?: string;
  /**
   * Where the client's advisory warnings go — the ones the Python SDK logs
   * on its `kagura_memory` logger: `checkServerVersion`'s below-minimum
   * notice and `listEdges`' cut-direction notice. Default `console.warn`;
   * pass `() => {}` to silence them, or a logger's method to route them.
   */
  warn?: (message: string) => void;
}

export interface RememberOptions {
  contextId: string;
  /** Memory summary (10-500 chars). */
  summary: string;
  content: string;
  /** Memory type; the server validates against its own vocabulary. */
  type?: string;
  /** Importance score (0.0-1.0). */
  importance?: number;
  /**
   * At most 50 tags, each at most 100 characters — the caps memory-cloud
   * v0.82.0+ enforces on a write (#1743), checked before any request on
   * every server.
   */
  tags?: string[];
  /** Origin URI (e.g. `file:///`, `https://`, `vault://`). */
  sourceUri?: string;
  /** Existing memory UUIDs to declare as `declared_link` edges from this memory. */
  linkedMemoryIds?: string[];
  /** Source URIs to resolve into linked memories (unresolved URIs are skipped server-side). */
  linkedSourceUris?: string[];
  /** Origin classification; pairs with sourceUri for downstream filters. */
  sourceType?: SourceType;
  /** Why the memory exists and how to use it (max 2000 chars). */
  contextSummary?: string;
  /**
   * Structured details JSON, stored as-is.
   *
   * A `location: {@link MemoryLocation}` here is what makes the memory
   * reachable from {@link recallNearby}. `lat`/`lon` must be JSON numbers —
   * argument coercion does not recurse into `details`, so string-typed
   * numerics are rejected server-side with HTTP 422.
   *
   * `tool_trigger` is a reserved key: a {@link ToolTrigger} here makes the
   * memory a tool guardrail, served by {@link loadGuardrails}. It is
   * validated on write, and only a context editor or above on a user
   * credential (not an agent one) may set it — otherwise the call throws
   * {@link KaguraError}. The same gate covers changing or deleting a
   * guardrail later. {@link forget} skips one silently rather than throwing
   * when the caller may otherwise write to the workspace; a workspace
   * viewer may not delete anything, and its `forget` throws
   * {@link KaguraPermissionError} instead.
   */
  details?: Record<string, unknown>;
  /** Open-ended context metadata JSON. */
  context?: Record<string, unknown>;
  /**
   * UUID of an existing memory this one replaces.
   *
   * Creates a supersede edge: the old memory is shadowed out of default
   * recall but stays restorable and reachable via
   * `recall({ includeSuperseded: true })` and {@link explore}. Prefer this
   * over {@link forget} + `remember`, which destroys the history.
   */
  supersedes?: string;
  /**
   * When the memory is surfaced. `"on_recall"` (default) leaves it to
   * probabilistic recall; `"always"` pins it so every loadPinned call
   * returns it. Only sent when it differs from the server default.
   */
  deliveryMode?: DeliveryMode;
}

export interface RecallOptions {
  /** Context ID for single-context search. */
  contextId?: string;
  query: string;
  /** Number of results (default 5). */
  k?: number;
  /**
   * AI reranking, tri-state since server v0.69.0. Omit it to follow the
   * context's search config (set via {@link KaguraClient.updateSearchConfig});
   * `true` requests reranking, which applies only when the context enables
   * it and the workspace plan and deployment allow it; `false` skips it for
   * this call. With `contextIds`, the first listed context's config decides.
   * Servers before v0.69.0 rerank only on `true`.
   */
  useRerank?: boolean;
  /**
   * Optional filters, sent in wire form; keys AND together:
   *
   * - `type`, `scope`: exact match.
   * - `tags`: matches any listed tag; `tags_match: "all"` requires every
   *   one. `tags_normalize: true` (server v0.65.0+) also matches spellings
   *   that differ only in case, hyphen/underscore/space or a simple plural.
   * - `importance`: `{ gte | lte | gt | lt: 0.0-1.0 }`.
   * - `created_after` / `created_before` / `updated_after` /
   *   `updated_before`: ISO 8601.
   * - `source_uri_prefix` (e.g. `"vault://my-vault/"`) and `source_type`.
   * - `trust_tier: "trusted"` excludes external/connector-ingested
   *   memories.
   * - `near: { lat, lon, radius_m? }` and `within: { polygon: [{ lat, lon },
   *   ...] }` (server v0.54.0+) keep memories whose `details.location`
   *   falls inside; memories with no location never match.
   *
   * When a tag filter matches nothing, the response can carry
   * `tag_suggestions` (server v0.65.0+): stored tags close to each
   * requested one, as `{ [requestedTag]: ["stored-tag (count)", ...] }`.
   * The filter itself is never widened.
   */
  filters?: Record<string, unknown>;
  searchMode?: SearchMode;
  /** Search across multiple contexts (2-20 IDs); contextId not required then. */
  contextIds?: string[];
  /**
   * Ask for up to 3 graph discovery hints under `explore_hints` — seeds
   * for a follow-up {@link KaguraClient.explore} call.
   *
   * Since server v0.135.0 the server makes them only when the MCP URL
   * lists the `explore` tool, which the bare URL (the core tool profile)
   * does not: add `?add_tools=explore` or `?profile=full` to `mcpUrl` (or
   * `explore` to a `tools=` / `add_tools=` list it already has). On any
   * other URL the call still succeeds and returns `explore_hints_omitted`
   * — a sentence naming that opt-in — in place of `explore_hints`.
   * `explore()` itself is unaffected.
   */
  includeExploreHints?: boolean;
  /**
   * Include memories shadowed by a supersedes edge (default false).
   *
   * Superseded versions are demoted out of results by default; `true`
   * returns them annotated with `superseded_by`, which is what makes the
   * history {@link RememberOptions.supersedes} preserves actually
   * readable — audit and "previous versions of this fact" views. It also
   * turns off `folded`: every version comes back as its own row.
   */
  includeSuperseded?: boolean;
  /**
   * Result detail, `"compact"` or `"full"` (server v0.108.0+). Omit it to
   * get the deployment default — compact unless
   * `MCP_RECALL_DEFAULT_VERBOSITY` says otherwise.
   *
   * A compact hit is `memory_id`, the first 160 characters of `summary`
   * (`summary_cut: true` when it was shortened), `type`, `importance`,
   * `score`, `created_at`, `updated_at` and the content keys
   * (see {@link RecallOptions.full}). `"full"` adds `context_summary`,
   * `scope`, `tags`, `version` (v0.113.0+) and the uncut `summary`; code
   * that reads those from a hit needs it. See {@link RecallResult}.
   */
  verbosity?: RecallVerbosity;
  /**
   * How many of the top results carry `content`, 0-100 (server v0.114.0+).
   * Each carries up to 1,500 characters; a longer one adds
   * `content_truncated: true` and `content_next_offset`
   * ({@link KaguraClient.reference} returns the whole memory). `0`
   * returns summaries only.
   *
   * Omit it to get the deployment default (`MCP_RECALL_DEFAULT_FULL`, 3
   * unless set) — a defaulted `full` puts content on trusted,
   * non-connector rows only, while an explicit value makes every row
   * eligible. Never more than `k`; lowered to fit `maxChars`.
   */
  full?: number;
  /**
   * Response budget in characters, not tokens: 10,000-100,000 (server
   * default 20,000; v0.82.0+). Over budget the server takes `content` off
   * the lowest-ranked rows first (`full_applied` then counts the rows that
   * kept it), then `context_summary` off every row
   * (`context_summary_omitted: true`), then drops the lowest-ranked rows
   * (`truncated: true`; `count` is the rows returned).
   */
  maxChars?: number;
}

export interface UpdateMemoryOptions {
  contextId: string;
  /** UUID of memory to update in-place (provide exactly one of memoryId/externalId). */
  memoryId?: string;
  /** External resource ID for upsert lookup. */
  externalId?: string;
  summary?: string;
  content?: string;
  type?: string;
  importance?: number;
  /**
   * Replaces the list; `[]` clears it. At most 50 tags, each at most 100
   * characters, as for {@link RememberOptions.tags}.
   */
  tags?: string[];
  contextSummary?: string;
  /**
   * Structured details JSON. **Replaces `details` wholesale** — the server
   * does not deep-merge. Round-trip any keys you want to keep (notably
   * `location`, see {@link MemoryLocation}) or they are silently dropped.
   * The CLI's `update-memory --merge-details` does that round-trip for
   * top-level keys.
   *
   * That includes `tool_trigger` ({@link ToolTrigger}): leaving it out of
   * `updateMemory({ details })` turns the memory's guardrail off. The key
   * is reserved and validated on write, and any update to a guardrail
   * memory — not only one that names the key — needs context editor or
   * above on a user credential; see {@link RememberOptions.details}.
   *
   * Omitted from the request when `undefined`; pass `{}` to clear.
   */
  details?: Record<string, unknown>;
  /** `"always"` pins, `"on_recall"` unpins; omit to leave unchanged. */
  deliveryMode?: DeliveryMode;
  /**
   * Reject this memory's current `supersede_candidate` (server v0.65.0+)
   * — for two memories that are deliberately separate, so the suggestion
   * stops resurfacing on recall and reference. Nothing is deleted or
   * shadowed. To accept a candidate instead, create a `"supersedes"` edge.
   *
   * In-place mode only: requires `memoryId`. Only `true` is sent.
   */
  dismissSupersedeCandidate?: boolean;
}

export interface ListContextsOptions {
  /**
   * Only contexts whose name or display name contains this text
   * (case-insensitive, max 100 chars). Sent trimmed, as the server reads
   * it (Python's `str.strip()`), and not at all when blank.
   *
   * Server v0.73.0+. Older servers ignore it without an error and return
   * every context, so do not rely on it to narrow the list there.
   */
  nameContains?: string;
  /**
   * Add each context's `summary`, capped at 300 characters (server
   * v0.73.0+; older servers ignore it but always send the full `summary`).
   */
  includeSummary?: boolean;
  /**
   * Add the full `summary` and `embedding_model`. Large on a big
   * workspace, so pair it with `nameContains`. Wins over `includeSummary`.
   * Server v0.73.0+; older servers ignore it but always send both fields.
   */
  includeDetails?: boolean;
  /** Add `memory_count` per context. Works on every supported server. */
  includeStats?: boolean;
  /**
   * The `next_cursor` of the previous page, with the same `nameContains`
   * (the cursor counts rows of the filtered list). Sent only when set
   * (memory-cloud v0.82.0+; an older server sends every context in one
   * reply and no cursor).
   */
  cursor?: string;
  /**
   * Contexts per page, 1-200 (the server's default is 100). With
   * `includeDetails` and no non-blank `nameContains` the server allows at
   * most 20 (and defaults to 20), and refuses a larger page with
   * `validation_error` rather than clamping it, so that throws here. A
   * page can hold fewer: it also stops at 20,000 characters. Checked
   * before any request and sent only when set.
   *
   * Memory-cloud v0.82.0+ (#1743); an older server ignores it and returns
   * every context. There is no `maxChars` here: no server release declares
   * one on `list_contexts`, and from v0.82.0 an undeclared argument is
   * refused with `invalid_argument`.
   */
  limit?: number;
}

export interface CreateContextOptions {
  /** Context name (lowercase alphanumeric + hyphen/underscore). */
  name: string;
  displayName?: string;
  description?: string;
  /** LLM-oriented summary (200-500 chars). */
  summary?: string;
  /** LLM-oriented memory usage guidelines. */
  usageGuide?: string;
  /**
   * @deprecated The server's `create_context` does not read `resource_id`
   * (memory-cloud through v0.76.0), so this was silently dropped; it is no
   * longer sent (#47). Set it afterwards with
   * `updateContext({ contextId, resourceId })` (owner only), or use
   * {@link KaguraClient.setupResource} for a resource context.
   */
  resourceId?: string;
  /**
   * Privacy flag (default: true). A shared (`false`) context needs the
   * `shared_contexts` feature; from server v0.75.0 a plan without it
   * throws {@link KaguraFeatureNotAvailableError} (older servers: a generic
   * `validation_error`).
   */
  isPrivate?: boolean;
  /**
   * Embedding model; see listEmbeddingModels(). No API call changes it
   * after creation. On server v0.66.0+ a deployment operator can migrate a
   * context to another model.
   */
  embeddingModel?: string;
}

export interface UpdateContextOptions {
  contextId: string;
  displayName?: string;
  description?: string;
  summary?: string;
  usageGuide?: string;
  resourceId?: string;
  /**
   * Public visibility (required for resource tokens). Making a context
   * public is plan-gated on the `public_contexts` feature (server
   * v0.68.0+): `true` on a plan without it throws {@link KaguraFeatureNotAvailableError}.
   */
  isPublic?: boolean;
  /** Locked contexts cannot be deleted. */
  isLocked?: boolean;
}

export interface SetupResourceOptions {
  resourceId: string;
  /**
   * Context name (defaults to `resourceId`). The server requires one; a
   * resource id always passes its context-name rule, up to the 100-character
   * name limit.
   */
  name?: string;
  /**
   * @deprecated The server's `setup_resource` has no summary (memory-cloud
   * through v0.76.0), so this was silently dropped; it is no longer sent
   * (#47). Set it afterwards with
   * `updateContext({ contextId, summary })` on the returned `context_id`
   * (owner only).
   */
  summary?: string;
  /** Token description. */
  description?: string;
  /** Token quota (1-10000, default 1000). */
  quotaEventsPerHour?: number;
}

export interface ListTagsOptions {
  contextId: string;
  /** Maximum tags to return (1-500, default 50). */
  limit?: number;
  /** Minimum memory count per tag (1-10000, default 1). */
  minCount?: number;
  /** Sort order (default "count"). */
  sort?: "count" | "recent" | "alpha";
  /** Case-insensitive prefix filter (max 200 chars). */
  prefix?: string;
  /**
   * Multi-tag AND drill-down: restrict the vocabulary to memories whose
   * tags contain **all** of these values (`tags @> with_tags`), and exclude
   * these values from the returned tags.
   *
   * Combine with `prefix` for server-side faceted browsing — one call per
   * drill-down level, no local index.
   *
   * Values are trimmed and blank ones dropped, as the server does; at most
   * 50 remain, each at most 200 characters, or the call throws before any
   * request. An empty result is a no-op filter and is not sent.
   *
   * A non-empty drill-down is sent to the REST route
   * `GET /api/v1/contexts/{id}/tags`, which has had it since server
   * v0.17.2, on every server: the MCP `list_tags` tool has `with_tags` only
   * from server v0.77.0 (memory-cloud#1669), and an older one silently
   * returns the unfiltered vocabulary (#47). The drill-down can move to MCP
   * once `MIN_SERVER_VERSION` is 0.77.0 or later. The response has the same
   * shape either way. Its `context_name` is the one the REST route
   * sends from server v0.77.0, which the client keeps. From an older
   * server, or when the name is empty or null, the client looks it up once
   * per context with a one-tag `list_tags` call and keeps it; a plain
   * `listTags` call fills the same cache.
   */
  withTags?: string[];
}

export interface ListMemoriesOptions {
  /** Context UUID; omit for the caller's cross-context view. */
  contextId?: string;
  /** Case-insensitive substring filter on summaries (whitespace-only → no filter). */
  q?: string;
  scope?: "working" | "persistent";
  type?: string;
  /** Maximum results (1-500, default 50). */
  limit?: number;
  offset?: number;
  /** Time-window overlap lower bound (naive ISO) for type="time" memories. */
  triggerFrom?: string;
  /** Time-window overlap upper bound (naive ISO). */
  triggerUntil?: string;
  /** "created_at" (default, newest-first) or "trigger_from" (soonest first). */
  orderBy?: "created_at" | "trigger_from";
  /**
   * WHERE-axis bounding box: lower latitude bound in degrees (-90..90).
   *
   * The four bounds may be given in any combination, one-sided included,
   * and **any** of them keeps only memories with a complete
   * `details.location`. Server v0.54.0+ (memory-cloud #1334); an older
   * server ignores them and returns an unfiltered page.
   */
  latMin?: number;
  /** Upper latitude bound (-90..90); see {@link latMin}. */
  latMax?: number;
  /**
   * Lower longitude bound (-180..180). `lonMin > lonMax` selects the box
   * that crosses the antimeridian (`lon >= lonMin OR lon <= lonMax`)
   * rather than an empty one.
   */
  lonMin?: number;
  /** Upper longitude bound (-180..180); see {@link lonMin}. */
  lonMax?: number;
}

export interface RegisterAgentOptions {
  /** Workspace-unique agent name (max 255 chars). */
  name: string;
  /** Free-text description (max 10000 chars). */
  description?: string;
  /** Framework tag, e.g. `"claude-code"`, `"langgraph"` (max 100 chars). */
  framework?: string;
  /** Deployment environment, e.g. `"production"` (max 100 chars). */
  environment?: string;
  /** Agent build/prompt version (max 100 chars). */
  version?: string;
}

export interface UpdateAgentOptions {
  agentId: string;
  /** New workspace-unique name (max 255 chars). */
  name?: string;
  /** New description (max 10000 chars). */
  description?: string;
  /** New framework tag (max 100 chars). */
  framework?: string;
  /** New environment (max 100 chars). */
  environment?: string;
  /** New version (max 100 chars). */
  version?: string;
  /**
   * Lifecycle state — the fail-closed kill switch: `"suspended"` /
   * `"retired"` agents get every key bound to them rejected at verify
   * time.
   */
  status?: AgentStatus;
  /**
   * Binding enforcement ramp. Setting `"enforce"` → `"shadow"` is an
   * audited privilege-widening event (bindings stop being enforced and
   * are only logged).
   */
  enforcementMode?: AgentEnforcementMode;
}

/**
 * The subtractive scope trio shared by {@link BindAgentContextOptions}
 * and {@link UpdateAgentBindingOptions} — the ONE type to extend with the
 * per-memory `allowed_memory_types` / `allowed_source_types` filters.
 * Server v0.51.0 (memory-cloud #1299) enforces them and
 * {@link AgentBinding} reads them back, but no option sets them yet; pass
 * them through `callRawTool` until one does (adding it is non-breaking).
 */
export interface AgentBindingScopeOptions {
  /** Whether the agent may read this context (server default: true). */
  canRead?: boolean;
  /** Write gate (server default: `"deny"`). */
  writePolicy?: AgentWritePolicy;
  /** Mark as the agent's bootstrap default binding (max one per agent). */
  isDefault?: boolean;
}

export interface BindAgentContextOptions extends AgentBindingScopeOptions {
  agentId: string;
  /** Context to bind (must belong to the agent's workspace). */
  contextId: string;
}

export interface UpdateAgentBindingOptions extends AgentBindingScopeOptions {
  agentId: string;
  /** Binding UUID from {@link KaguraClient.listAgentBindings}. */
  bindingId: string;
}

export interface UpdateSearchConfigOptions {
  contextId: string;
  /** Semantic search weight (0.0-1.0); weights must sum to 1.0 (±0.01). */
  semanticWeight?: number;
  /** BM25 keyword search weight (0.0-1.0). */
  bm25Weight?: number;
  /** Candidate fetch multiplier (1-10). */
  fetchFactor?: number;
  /** Enable AI reranking; a `recall` that omits `useRerank` follows it (server v0.69.0+). */
  useRerank?: boolean;
  /**
   * `"voyage"`, `"cohere"`, or `"self_hosted"` (a local OpenAI-compatible
   * backend such as Ollama or vLLM; needs no API key).
   */
  rerankerProvider?: string;
  rerankerModel?: string;
  /**
   * Bounded adoption + feedback re-rank: memories that get referenced and
   * marked helpful gain a small standing boost. New contexts start enabled.
   */
  reinforceEnabled?: boolean;
  /** Bound on the reinforce adjustment (0.0-0.5, server default 0.15). */
  reinforceMaxBoost?: number;
  /**
   * Count only host-arbitrated feedback, so an untrusted agent's own
   * `feedback({ helpful: true })` cannot boost its ranking.
   */
  reinforceRequireHostArbitration?: boolean;
  /**
   * `"off"` (server default); `"log_only"` records the routing decision
   * with no ranking change; `"active"` routes a `recall` that omits
   * `searchMode`. An explicit `searchMode` always wins.
   */
  routingMode?: RoutingMode;
}

export interface RecordMeasurementOptions {
  /** Target context UUID; the series is scoped to it. */
  contextId: string;
  /**
   * Series name, e.g. `"weight_kg"` (1-64 characters). Reuse the exact
   * name to extend a series.
   */
  metric: string;
  /** The observed value: a finite number. NaN and infinity are refused. */
  value: number;
  /**
   * Observation time. A string is sent as given (ISO 8601; naive means
   * **UTC** to the server, not local time), a `Date` as its UTC instant.
   * Omit for "now"; pass it to backdate an import.
   */
  measuredAt?: string | Date;
  /** Display unit, e.g. `"kg"` (1-32 characters). */
  unit?: string;
  /** JSON metadata stored with the observation (device, source, notes). */
  details?: Record<string, unknown>;
}

export interface RecallSeriesOptions {
  contextId: string;
  /** Series name as recorded (1-64 characters). */
  metric: string;
  /** Bucket size. Omit for the server default, `"day"`. */
  period?: MeasurementPeriod;
  /**
   * Per-bucket aggregate; `"last"` is the most recent value in the
   * bucket. Omit for the server default, `"avg"`.
   */
  agg?: MeasurementAggregate;
  /**
   * Window start, inclusive: an ISO 8601 string sent as given (naive =
   * UTC) or a `Date`. Omit for `end` minus 30 days.
   */
  start?: string | Date;
  /**
   * Window end, exclusive (naive = UTC). Omit for "now". The window may
   * span at most 365 days: the server refuses a wider one.
   */
  end?: string | Date;
}

// ---------------------------------------------------------------------------
// Session tools (memory-cloud v0.93.0+, SDK issue #86): options
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  contextId: string;
  /**
   * Start of the `changes` window: ISO 8601 (naive = UTC), a `Date` (sent
   * as its UTC instant), or `"<N>d"` for N days back (`"0d"` to `"999d"`).
   * Omit for the server's `"7d"`.
   */
  since?: string | Date;
  /** The lanes to compose, a non-empty subset of `pinned`, `upcoming`, `changes`. Omit for all. */
  include?: readonly BootstrapComponentName[];
  /**
   * Reply budget in characters, not tokens, 2,000-100,000 (server default
   * 20,000). Over budget the full format first leaves `context_summary`
   * out of the pinned rows (`context_summary_omitted`), then each lane
   * keeps the prefix that fits (`truncated`). Below 10,000 needs
   * memory-cloud v0.115.0+ (#2126); an older server refuses it
   * (`validation_error`).
   */
  maxChars?: number;
  /**
   * `"index"` for pointer rows (pinned keeps its text; guardrail, upcoming
   * and change rows carry an 80-character `summary` with `summary_cut`; no
   * `instructions`) or `"full"`. Omitted, the server picks `"index"` below
   * `maxChars` 10,000 and `"full"` otherwise. Needs memory-cloud v0.115.0+
   * (#2126): v0.93.0-v0.114.x refuse the argument (`invalid_argument`).
   */
  format?: BootstrapFormat;
}

export interface ChangesSinceOptions {
  contextId: string;
  /** Window start, inclusive: ISO 8601 (naive = UTC) or a `Date`. */
  since: string | Date;
  /** Window end, exclusive (later than `since`). Omit for now. */
  until?: string | Date;
  /**
   * Kinds to include, a non-empty subset of `created`, `updated`,
   * `superseded`, `forgotten` — or, with `sessionId` / `byMe`, of
   * `created`, `updated`, `forgotten`, `restored`. Omit for all.
   */
  kinds?: readonly string[];
  /** `next_cursor` of the previous page. */
  cursor?: string;
  /** Changes per page (server default 50, clamped to 1-100). */
  limit?: number;
  /**
   * Only that session's writes — a `session_id` a write returned
   * (memory-cloud v0.113.0+, #2044). Another principal's session lists
   * nothing, unless the caller owns the context.
   */
  sessionId?: string;
  /**
   * `true` lists only the caller's own writes, in any session (memory-cloud
   * v0.114.0+, #2121) — what `rollbackSession({ since })` would address.
   * Sent when set, `false` included.
   */
  byMe?: boolean;
  /** Reply budget in characters, 10,000-100,000 (server default 20,000); a cut page sets `truncated`. */
  maxChars?: number;
}

export interface ListMatchingOptions {
  contextId: string;
  /**
   * Exact-match filters, ANDed: `type`, `scope`, `source_type`,
   * `delivery_mode`, `tags` (+ `tags_match` `any` | `all`,
   * `tags_normalize`), `importance` `{gte|lte|gt|lt}`, `created_after` /
   * `created_before` / `updated_after` / `updated_before` (ISO 8601),
   * `observed_after` / `observed_before` (v0.127.0+), `source_uri_prefix`,
   * `trust_tier: "trusted"`, and `details.<key>` — a scalar matched with
   * its stored JSON type (`2` is not `2.0` or `"2"`; v0.96.0+). The server
   * refuses an unknown filter (`validation_error`). Sent when set, `{}`
   * included.
   */
  filters?: Record<string, unknown>;
  /**
   * `"updated_at"` (server default; a never-edited memory sorts by
   * `created_at`), `"created_at"`, `"importance"` or `"observed_at"`
   * (memory-cloud v0.127.0+, #2330; memories without one go last). The id
   * breaks ties.
   */
  orderBy?: ListOrderBy;
  /** `"asc"` or `"desc"` (server default). */
  direction?: "asc" | "desc";
  /** `next_cursor` of the previous page. */
  cursor?: string;
  /** Memories per page (server default 50, clamped to 1-100). */
  limit?: number;
  /**
   * `true` adds each memory's `details` (dropped first when the reply
   * passes `maxChars`: `details_omitted`). Sent only when `true`.
   */
  includeDetails?: boolean;
  /** Reply budget in characters, 10,000-100,000 (server default 20,000); a cut page sets `truncated`. */
  maxChars?: number;
}

/**
 * One `rememberBatch` item: the server's `remember` arguments by their
 * wire names, as sent — no SDK defaults are added, and an undeclared key
 * fails that item (`invalid_argument`; a whole atomic batch is refused).
 * `summary`, `content` and `type` are required: an item without one fails
 * (`missing_fields`) on every server since v0.93.0. An item may repeat the
 * batch's `context_id` but name no other; `dedupe`, `tags_normalize` and
 * `verbose` are set on the batch, never on an item.
 */
export interface RememberBatchItem {
  summary: string;
  content: string;
  type: string;
  importance?: number;
  tags?: string[];
  source_uri?: string;
  source_type?: SourceType;
  context_summary?: string;
  /** A tool guardrail is `details: { tool_trigger: {...} }`. */
  details?: Record<string, unknown>;
  /** ISO 8601 date or datetime (memory-cloud v0.127.0+). */
  observed_at?: string;
  context?: string;
  delivery_mode?: DeliveryMode;
  linked_memory_ids?: string[];
  linked_source_uris?: string[];
  supersedes?: string;
  context_id?: string;
  [key: string]: unknown;
}

export interface RememberBatchOptions {
  /** Context UUID; it applies to every item. */
  contextId: string;
  /** 1-50 items; see {@link RememberBatchItem}. */
  items: readonly RememberBatchItem[];
  /**
   * `true`: all or nothing — a failing item, or a `dedupe: "check"`
   * candidate, rolls everything back and the other items come back
   * `skipped`. Server default `false`: each item is written and reported
   * on its own.
   */
  atomic?: boolean;
  /**
   * As `remember`'s, applied per item: `"suggest"` (server default),
   * `"check"` (a near-duplicate comes back as a `duplicate_candidate` row
   * instead of being written) or `"off"`.
   */
  dedupe?: "suggest" | "check" | "off";
  /** `true` stores each item's tags under the context's established spelling (reported in `lint`). */
  tagsNormalize?: boolean;
  /** `true` keeps `persistence.detail` on each row. */
  verbose?: boolean;
}

export interface ForgetOptions {
  contextId: string;
  /** UUID of one memory to delete. */
  memoryId?: string;
  /** Search query to find and delete matching memories. */
  query?: string;
  /** Number of memories to delete in query mode (default 10). */
  k?: number;
  /** Not in this mode: see {@link ForgetByIdsOptions}. */
  memoryIds?: undefined;
}

export interface ForgetByIdsOptions {
  contextId: string;
  /**
   * 1-50 distinct memory UUIDs to delete in one call (memory-cloud
   * v0.117.0+, #2127), each exactly as `memoryId` would and committed on
   * its own. Not combined with `memoryId`, `query` or `k`.
   */
  memoryIds: readonly string[];
  memoryId?: undefined;
  query?: undefined;
  k?: undefined;
}

export interface DescribeToolsOptions {
  /** Case-insensitive substring narrowing the hidden-tool list by name, title or summary. */
  query?: string;
  /** Up to 20 tool names whose complete definitions to return instead of the list. */
  names?: readonly string[];
}

export interface ListRevisionsOptions {
  contextId: string;
  memoryId: string;
  /** Events per page (server default 20, clamped to 1-100). */
  limit?: number;
  /** `next_cursor` of the previous page. */
  cursor?: string;
  /** Reply budget in characters, 10,000-100,000 (server default 20,000); a cut page sets `truncated`. */
  maxChars?: number;
}

export interface RollbackSessionOptions {
  contextId: string;
  /**
   * The session whose writes to undo — the `session_id` a `remember` /
   * `updateMemory` / `forget` / `rememberBatch` reply returned.
   */
  sessionId?: string;
  /**
   * Instead of `sessionId`: undo the caller's own writes since then (ISO
   * 8601, naive = UTC, or a `Date`; memory-cloud v0.114.0+, #2121).
   * Preview them with `changesSince({ since, byMe: true })`.
   */
  since?: string | Date;
  /**
   * Window end, exclusive, at most 7 days after `since`. Omit for now, or
   * for the end of the caller's unfinished rollback of a window from the
   * same `since`.
   */
  until?: string | Date;
  /**
   * `true` (default) only plans and changes nothing; `false` rolls back.
   * Always sent, so the plan-only default never depends on the server's.
   */
  dryRun?: boolean;
}

/** The series-name cap the server enforces, in characters (code points). */
const METRIC_MAX_LEN = 64;
/** The unit cap the server enforces, in characters (code points). */
const UNIT_MAX_LEN = 32;

/**
 * Refuse a series name the server would refuse — the Python SDK's
 * `_validate_metric`, with its messages. Python's `len` counts code
 * points, so an emoji is one character, not two.
 */
function validateMetric(metric: unknown): void {
  if (typeof metric !== "string" || metric === "") {
    throw new Error(`metric must be a non-empty string, got ${pyRepr(metric)}`);
  }
  const length = [...metric].length;
  if (length > METRIC_MAX_LEN) {
    throw new Error(`metric must be at most ${METRIC_MAX_LEN} characters, got ${length}`);
  }
}

/**
 * The measurement value to send, or the Python SDK's
 * `_validate_measurement_value` error: a string or a boolean is refused
 * rather than coerced, and NaN or infinity would poison every aggregate
 * of the series. A bigint is Python's int, a number like any other,
 * refused only past the float range.
 */
function measurementValue(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number") {
    throw new Error(`value must be a number, got ${pyTypeName(number)}`);
  }
  if (!Number.isFinite(number)) {
    throw new Error("value must be finite (NaN and infinity are rejected)");
  }
  return number;
}

/**
 * A time argument for a tool that takes ISO 8601 strings — the Python
 * SDK's `_iso_arg`. A string passes untouched for the server to parse. A
 * `Date` has no naive form, so it is sent as its UTC instant
 * (`toISOString()`), which the server reads as the same moment.
 */
function isoArg(value: string | Date, label: string): string {
  if (!(value instanceof Date)) return value;
  // toISOString() throws a bare RangeError on an Invalid Date.
  if (Number.isNaN(value.getTime())) throw new Error(`${label} must be a valid Date`);
  return value.toISOString();
}

/**
 * A `datetime` field of the measurement models, read as the server sent
 * it. The server writes these `Z`-tagged; re-rendering them as pydantic
 * does would reproduce the same text, so the string passes through
 * unchanged and unparsed. A value that is no string at all is refused, as
 * pydantic refuses a null, a bool, a list or an object; a number, which
 * pydantic reads as a Unix time, is refused too, so the field stays the
 * string its type promises.
 */
const datetimeText: Coercer<string> = (value) => {
  if (typeof value !== "string") return { ok: false, msg: "Input should be a valid datetime" };
  // The Python model's datetime field refuses a lone surrogate first (#69).
  return hasLoneSurrogate(value) ? { ok: false, msg: STRING_UNICODE } : { ok: true, value };
};

/**
 * Read a `record_measurement` payload as the Python SDK's
 * `MeasurementResult` model reads it: the model's keys in its order, the
 * `status` and `unit` defaults filled, fields it does not name dropped.
 *
 * @throws KaguraResponseError in the Python SDK's words.
 */
function readMeasurementResult(data: unknown): MeasurementResult {
  const r = new ResponseReader("record_measurement", "MeasurementResult");
  const obj = r.object(data);
  let result: MeasurementResult | undefined;
  if (obj !== null) {
    // In the model's field order: pydantic reports problems in that order.
    result = {
      status: r.field(obj, "status", laxStr, { default: "success" }),
      measurement_id: r.field(obj, "measurement_id", laxStr),
      metric: r.field(obj, "metric", laxStr),
      measured_at: r.field(obj, "measured_at", datetimeText),
      value: r.field(obj, "value", laxFloat),
      unit: r.field(obj, "unit", nullable(laxStr), { default: null }),
    };
  }
  r.check();
  return result!;
}

const ROLLBACK_COUNTS = [
  "edges_deleted",
  "merges_reversed",
  "merges_unreversible",
  "importance_restored",
  "promotions_reversed",
  "importance_kept",
  "promotions_kept",
  "archives_restored",
  "chunks_requeued",
  "points_requeued",
] as const;

/**
 * A partial rollback's `rollback_summary` checked as the Python SDK's
 * `RollbackSummary` model checks it, and returned as it arrived.
 *
 * @throws KaguraResponseError in the Python SDK's words.
 */
function readRollbackSummary(raw: unknown, operation: string): RollbackSummary {
  const r = new ResponseReader(operation, "RollbackSummary");
  const obj = r.object(raw);
  if (obj !== null) {
    for (const key of ROLLBACK_COUNTS) r.field(obj, key, laxInt, { default: 0 });
    r.list(
      obj,
      "errors",
      (item, at) => {
        const checked = laxStr(item);
        if (!checked.ok) r.refuse(at, checked);
      },
      { default: [] },
    );
  }
  r.check();
  return raw as RollbackSummary;
}

/** `CapacityLock`'s counts, in the Python model's declaration order. */
const CAPACITY_LOCK_COUNTS = [
  "memory_count",
  "memory_limit",
  "over_memories",
  "used_bytes",
  "storage_limit_bytes",
  "over_bytes",
] as const;

/**
 * A `get_usage` reply's `capacity_lock` checked as the Python SDK's
 * `UsageInfo.capacity_lock: CapacityLock | None` checks it, and the reply
 * returned as it arrived: absent or `null` is no lock (a server older
 * than v0.99.0, or a workspace within its capacity); an object has every
 * field optional and nullable, the counts integers and `purge_at` a
 * timestamp. The rest of the reply is not checked, as before.
 *
 * @throws KaguraResponseError in the Python SDK's words.
 */
function readUsageInfo(result: ToolResult): UsageInfo {
  const lock = result.capacity_lock;
  if (lock === undefined || lock === null) {
    return result as unknown as UsageInfo;
  }
  const r = new ResponseReader("get_usage", "UsageInfo");
  const at: Loc = ["capacity_lock"];
  const obj = r.object(lock, at, "CapacityLock");
  if (obj !== null) {
    for (const key of CAPACITY_LOCK_COUNTS) r.field(obj, key, nullable(laxInt), { at, default: null });
    r.field(obj, "cleanup_url", nullable(laxStr), { at, default: null });
    r.field(obj, "help", nullable(laxStr), { at, default: null });
    r.field(obj, "purge_at", nullable(datetimeText), { at, default: null });
  }
  r.check();
  return result as unknown as UsageInfo;
}

// ---------------------------------------------------------------------------
// memory-cloud v0.82.0 bounds (#1743): write caps and cursor paging
// ---------------------------------------------------------------------------

/** `remember` / `updateMemory` tag caps (server `MEMORY_TAGS_MAX_COUNT` / `MEMORY_TAG_MAX_CHARS`). */
const MEMORY_TAGS_MAX_COUNT = 50;
const MEMORY_TAG_MAX_CHARS = 100;
/** `setState` value cap (server `STATE_VALUE_MAX_CHARS`), in characters of compact JSON. */
const STATE_VALUE_MAX_CHARS = 16_384;
/** Pages a plain-list method follows before giving up on an unfinished list. */
const MAX_AUTO_PAGES = 50;
/** `list_edges` per-direction clamp (server `LIST_EDGES_MAX_LIMIT`). */
const LIST_EDGES_MAX_LIMIT = 200;
/** `get_sleep_report` envelope keys merged into the flattened report. */
const SLEEP_REPORT_ENVELOPE_KEYS = [
  "actions",
  "action_count",
  "actions_has_more",
  "actions_next_cursor",
  "note",
] as const;

/**
 * Refuse a `tags` list the server would refuse on a write, before any
 * request: more than 50 tags, or a tag longer than 100 characters. Measured
 * as the server measures it, and as Python's `_validate_memory_tags` does:
 * the list as given (no trimming or deduplication) and each tag's length
 * in code points.
 *
 * @throws Error in the Python SDK's words.
 */
function validateMemoryTags(tags: readonly unknown[] | undefined): void {
  if (!Array.isArray(tags)) return;
  if (tags.length > MEMORY_TAGS_MAX_COUNT) {
    throw new Error(`tags accepts at most ${MEMORY_TAGS_MAX_COUNT} tags, got ${tags.length}`);
  }
  let longest = 0;
  for (const tag of tags) {
    if (typeof tag === "string") longest = Math.max(longest, [...tag].length);
  }
  if (longest > MEMORY_TAG_MAX_CHARS) {
    throw new Error(`each tag must be at most ${MEMORY_TAG_MAX_CHARS} characters, got ${longest}`);
  }
}

/** A string's length as Python's `json.dumps(…, ensure_ascii=False)` writes it, quotes included. */
function pyJsonStringChars(text: string): number {
  let chars = 2;
  for (const point of text) {
    const code = point.codePointAt(0) as number;
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      chars += 2;
    } else {
      chars += code < 0x20 ? 6 : 1;
    }
  }
  return chars;
}

/** The characters of a parsed JSON value as Python's compact `json.dumps` writes it. */
function pyCompactJsonChars(value: unknown): number {
  if (value === null) return 4;
  switch (typeof value) {
    case "boolean":
      return value ? 4 : 5;
    case "number": {
      // What the wire carries for this number decides how the server reads
      // it: digits only are an int, anything else a float, which Python
      // writes back as its repr (`1e-05`, not `0.00001`).
      const sent = JSON.stringify(value);
      return /[.eE]/.test(sent) ? pyFloatRepr(value).length : sent.length;
    }
    case "string":
      return pyJsonStringChars(value);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return value.reduce((n: number, item) => n + pyCompactJsonChars(item), 1 + Math.max(value.length, 1));
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.reduce(
    (n, [key, item]) => n + pyJsonStringChars(key) + 1 + pyCompactJsonChars(item),
    1 + Math.max(entries.length, 1),
  );
}

/**
 * Refuse a `setState` value longer than the server's cap, before any
 * request. The length is the server's measure (its `json_chars`: compact
 * JSON, `ensure_ascii=False`, in code points) of the value as this SDK
 * sends it. A value `JSON.stringify` cannot write is not measured: sending
 * it fails as before.
 *
 * @throws Error in the Python SDK's words.
 */
function validateStateValue(value: unknown): void {
  let sent: string | undefined;
  try {
    sent = JSON.stringify(value);
  } catch {
    return;
  }
  if (sent === undefined) return;
  const size = pyCompactJsonChars(JSON.parse(sent));
  if (size > STATE_VALUE_MAX_CHARS) {
    throw new Error(
      `value must be at most ${STATE_VALUE_MAX_CHARS} characters as compact JSON, got ${size}; ` +
        "store large data as a memory and keep its id in the state",
    );
  }
}

/** A row's `id` for de-duplication across pages, or `undefined` when it has none. */
function rowId(row: unknown): unknown {
  if (typeof row !== "object" || row === null) return undefined;
  const id = (row as Record<string, unknown>).id;
  return id === null ? undefined : id;
}

/**
 * Each page of a cursor-paged MCP list tool, in order (memory-cloud
 * v0.82.0+, #1743) — the Python SDK's `_iter_pages`, shared by
 * `listAgents` and `setup`'s context lookup.
 *
 * `fetchPage(undefined)` is the first call, which sends no cursor, so an
 * older server, which pages nothing and sends no `has_more`, answers in
 * one call; each later call is `fetchPage(cursor)` with the `next_cursor`
 * of the page before. The next page is fetched only when the caller asks
 * for it, so a `for await` that stops early sends no further request.
 *
 * @internal Not part of the package's API.
 * @param tool The MCP list tool; also the error's `operation`.
 * @throws KaguraResponseError labelled `tool` when `has_more` comes
 *   without a usable `next_cursor` or with one an earlier page already
 *   sent, or the list is not complete after 50 pages.
 */
export async function* iterPages<T extends object>(
  tool: string,
  fetchPage: (cursor: string | undefined) => Promise<T>,
): AsyncGenerator<T, void, undefined> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_AUTO_PAGES; page++) {
    const result = await fetchPage(cursor);
    yield result;
    const next = result as { has_more?: unknown; next_cursor?: unknown };
    if (next.has_more !== true) return;
    if (typeof next.next_cursor !== "string" || next.next_cursor === "") {
      throw new KaguraResponseError(`${tool}: unexpected server response (has_more without a next_cursor)`, tool);
    }
    if (seen.has(next.next_cursor)) {
      throw new KaguraResponseError(
        `${tool}: unexpected server response (a page repeated an earlier next_cursor)`,
        tool,
      );
    }
    seen.add(next.next_cursor);
    cursor = next.next_cursor;
  }
  throw new KaguraResponseError(`${tool}: the list did not end within ${MAX_AUTO_PAGES} pages`, tool);
}

/**
 * Read a `recall_series` payload as the Python SDK's `MeasurementSeries`
 * model reads it; a missing `series` is `[]`, but a `null` one is drift.
 *
 * @throws KaguraResponseError in the Python SDK's words.
 */
function readMeasurementSeries(data: unknown): MeasurementSeries {
  const r = new ResponseReader("recall_series", "MeasurementSeries");
  const readBucket = (value: unknown, at: Loc): SeriesBucket | null => {
    const item = r.object(value, at, "SeriesBucket");
    if (item === null) return null;
    return {
      bucket: r.field(item, "bucket", datetimeText, { at }),
      value: r.field(item, "value", laxFloat, { at }),
      count: r.field(item, "count", laxInt, { at }),
    };
  };
  const obj = r.object(data);
  let series: MeasurementSeries | undefined;
  if (obj !== null) {
    series = {
      status: r.field(obj, "status", laxStr, { default: "success" }),
      metric: r.field(obj, "metric", laxStr),
      period: r.field(obj, "period", laxStr),
      agg: r.field(obj, "agg", laxStr),
      // Every bucket is an object once check() has passed.
      series: r.list(obj, "series", readBucket, { default: [] }) as SeriesBucket[],
      count: r.field(obj, "count", laxInt),
    };
  }
  r.check();
  return series!;
}

/**
 * Refuse one `listMemories` bbox bound the server would only answer with
 * a 422 — the Python SDK's `validate_coordinate`, with its sentences and
 * the option's TypeScript name. A string is refused rather than coerced,
 * as the server refuses it.
 */
function validateBound(label: string, value: unknown, limit: number): void {
  if (typeof value !== "number") {
    throw new Error(
      `${label} must be a number, got ${pyTypeName(value)} (${pyRepr(value)}). ` +
        "The server rejects string-typed coordinates.",
    );
  }
  // Written as a containment: NaN fails it, where `v < -limit || v > limit`
  // would let NaN through.
  if (!(value >= -limit && value <= limit)) {
    throw new Error(`${label} must be between -${limit} and ${limit}, got ${pyRepr(value)}`);
  }
}

// ---------------------------------------------------------------------------
// Session tools (#86): local checks mirroring the server's own bounds
// ---------------------------------------------------------------------------

/** `bootstrap` lanes (server `COMPONENTS`). */
const BOOTSTRAP_COMPONENTS: readonly BootstrapComponentName[] = ["pinned", "upcoming", "changes"];
const BOOTSTRAP_FORMATS: readonly BootstrapFormat[] = ["full", "index"];
/** `bootstrap`'s own `max_chars` floor (server `BOOTSTRAP_INDEX_MIN_CHARS`, v0.115.0+); `format: "full"` keeps 10,000. */
const BOOTSTRAP_MIN_CHARS = 2_000;
/** `remember_batch` items (server `MAX_BATCH_ITEMS`). */
const BATCH_MAX_ITEMS = 50;
/** The `remember` arguments set once, on the batch, never per item (server `_BATCH_LEVEL`). */
const BATCH_LEVEL_KEYS = ["dedupe", "tags_normalize", "verbose"] as const;
/** `forget({ memoryIds })` ids per call (server `FORGET_MAX_IDS`). */
const FORGET_MAX_IDS = 50;
/** `describe_tools` names / `guide` topics per call (server `MAX_NAMES` / `MAX_TOPICS`). */
const DESCRIBE_MAX_NAMES = 20;
const GUIDE_MAX_TOPICS = 20;

/**
 * A list-of-strings option, copied, or the Python SDK's `_str_list` error
 * naming it. A bare string is refused rather than iterated: spreading
 * `"created"` would send its characters as the list.
 */
function strList(name: string, values: unknown): string[] {
  if (!Array.isArray(values)) {
    throw new Error(`${name} must be a list of strings, not ${pyTypeName(values)}`);
  }
  values.forEach((value: unknown, index) => {
    if (typeof value !== "string") {
      throw new Error(`${name}[${index}] must be a str, got ${pyTypeName(value)}`);
    }
  });
  return [...(values as string[])];
}

/** A list-of-names option the server would refuse past `limit` entries. */
function checkedNames(name: string, values: unknown, limit: number): string[] {
  const names = strList(name, values);
  if (names.length > limit) {
    throw new Error(`${name} holds at most ${limit} names, got ${names.length}`);
  }
  return names;
}

/**
 * The marker {@link pythonOptionNames} sets on a method's options.
 *
 * @internal Not exported from the package entry point.
 */
const PYTHON_OPTION_NAMES: unique symbol = Symbol("kagura.pythonOptionNames");

/**
 * `options`, marked so that the method's local refusals name its options
 * as the Python SDK names them (`max_chars`, `memory_ids`) rather than in
 * camelCase. The CLI passes its options through this, so its `Error:`
 * lines are the Python CLI's while the checks, and their order, stay the
 * client's own.
 *
 * @internal Not exported from the package entry point.
 */
export function pythonOptionNames<T extends object>(options: T): T {
  return { ...options, [PYTHON_OPTION_NAMES]: true };
}

/** An option's name for a local refusal: as given, or snake_case under {@link pythonOptionNames}. */
function optionLabel(options: object, camel: string): string {
  return (options as { [PYTHON_OPTION_NAMES]?: true })[PYTHON_OPTION_NAMES]
    ? camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    : camel;
}

/**
 * Refuse a `forget({ memoryIds })` list the server would refuse, before any
 * request: not 1-50 ids, an id that is not a UUID, or the same id twice,
 * compared as the server compares them — as UUIDs, so two spellings of one
 * id (case, braces) are the same id. The ids go out as given.
 *
 * @param name The option's name in the message.
 */
function checkedMemoryIds(memoryIds: unknown, name: string): string[] {
  const ids = strList(name, memoryIds);
  if (ids.length < 1 || ids.length > FORGET_MAX_IDS) {
    throw new Error(`${name} must hold 1 to ${FORGET_MAX_IDS} ids, got ${ids.length}`);
  }
  const seen = new Set<string>();
  ids.forEach((value, index) => {
    let parsed: string;
    try {
      parsed = parseUuid(value);
    } catch {
      throw new Error(`${name}[${index}] is not a memory UUID`);
    }
    if (seen.has(parsed)) throw new Error(`${name} lists ${parsed} more than once`);
    seen.add(parsed);
  });
  return ids;
}

/** `bootstrap`'s `include`, checked: a non-empty list of known lane names. */
function checkedBootstrapInclude(include: unknown): string[] {
  const lanes = strList("include", include);
  if (lanes.length === 0 || lanes.some((name) => !(BOOTSTRAP_COMPONENTS as readonly string[]).includes(name))) {
    throw new Error(`include must be a non-empty subset of ${BOOTSTRAP_COMPONENTS.join(", ")}`);
  }
  return lanes;
}


/**
 * Refuse a `rememberBatch` `items` list before any request — the Python
 * SDK's `_checked_batch_items`, with its messages. Per-item rules the
 * server reports per item (a missing `summary`, an unknown key) stay the
 * server's. Refused here: not 1-50 items, an item that is no object, the
 * batch-level keys, an item `context_id` other than the batch's, and the
 * tag cap {@link KaguraClient.remember} also checks.
 */
function checkedBatchItems(items: unknown, contextId: string): Record<string, unknown>[] {
  if (!Array.isArray(items)) {
    throw new Error(`items must be a list of dicts, got ${pyTypeName(items)}`);
  }
  if (items.length < 1 || items.length > BATCH_MAX_ITEMS) {
    throw new Error(`items must hold 1 to ${BATCH_MAX_ITEMS} items, got ${items.length}`);
  }
  items.forEach((item: unknown, index) => {
    if (!isRecord(item)) {
      throw new Error(`items[${index}] must be a dict, got ${pyTypeName(item)}`);
    }
    const batchLevel = BATCH_LEVEL_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(item, key));
    if (batchLevel.length > 0) {
      throw new Error(
        `items[${index}] carries ${batchLevel.join(", ")}: set dedupe / tags_normalize / verbose ` +
          "on rememberBatch itself, not on an item",
      );
    }
    if (Object.prototype.hasOwnProperty.call(item, "context_id") && item.context_id !== contextId) {
      throw new Error(
        `items[${index}] carries another context_id: the batch's context_id applies to every item`,
      );
    }
    if (Array.isArray(item.tags)) {
      try {
        validateMemoryTags(item.tags);
      } catch (e) {
        throw new Error(`items[${index}]: ${excMessage(e)}`);
      }
    }
  });
  return [...(items as Record<string, unknown>[])];
}

/** Python's `_opt_int`: an integer, or `null` for anything else (a boolean included). */
function optInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * The error for `rollback_session`'s `partial_rollback` envelope — the
 * Python SDK's `_partial_session_rollback_error`.
 *
 * Not {@link KaguraClient.raiseForMcpError}'s `partial_rollback`: that one
 * reads a Sleep run's `rollback_summary`, which this envelope lacks (the
 * server sends `summary` and `totals`). The partial rollback is already
 * committed, so a field the SDK cannot read is `null` rather than a second
 * error that would hide it.
 */
function partialSessionRollbackError(result: ToolResult): KaguraPartialSessionRollbackError {
  const message = Object.prototype.hasOwnProperty.call(result, "message") ? pyStr(result.message) : "Unknown error";
  let sessionSummary: SessionRollbackSummary | null = null;
  if (result.summary !== undefined && result.summary !== null) {
    try {
      readModel(result.summary, SESSION_ROLLBACK_SUMMARY, "rollback_session");
      sessionSummary = result.summary as SessionRollbackSummary;
    } catch (drift) {
      if (!(drift instanceof KaguraResponseError)) throw drift;
    }
  }
  const err = new KaguraPartialSessionRollbackError(`rollback_session failed (partial_rollback): ${message}`, {
    sessionSummary,
    totals: isRecord(result.totals) ? result.totals : null,
    rollbackId: optInt(result.rollback_id),
    remaining: optInt(result.remaining),
  });
  return annotateServerError(err, "partial_rollback", mcpEnvelopeFields(result));
}

/**
 * `list_contexts`' largest page (server `_LIST_CONTEXTS_MAX_LIMIT`).
 *
 * @internal Shared with the CLI's `context list --limit` range, as the
 *   Python CLI imports `_LIST_CONTEXTS_MAX_LIMIT`; not a package export.
 */
export const LIST_CONTEXTS_MAX_LIMIT = 200;
/**
 * `list_contexts`' largest `include_details` page without a `name_contains`
 * filter (server `_LIST_CONTEXTS_DETAILS_MAX_LIMIT`); a larger one is
 * refused with `validation_error`, not clamped.
 *
 * @internal Shared with the CLI's `context list` usage error, as the
 *   Python CLI imports `_LIST_CONTEXTS_DETAILS_MAX_LIMIT`; not a package
 *   export.
 */
export const LIST_CONTEXTS_DETAILS_MAX_LIMIT = 20;
/** `get_state`'s largest list-mode page (server `STATE_LIST_MAX_LIMIT`). */
const STATE_LIST_MAX_LIMIT = 200;

/**
 * `list_contexts`' `name_contains` as the server reads it — the Python
 * SDK's `_normalize_name_contains`: a string is stripped as Python strips
 * it and a blank one is no filter (`undefined`); `null` is unset; any
 * other value is returned as is, for the server to refuse.
 *
 * @internal Shared with the CLI's `context list`, so the 20-row cap judges
 *   `--name-contains` by the same rule as `listContexts`.
 */
export function normalizeNameContains(value: string | undefined): string | undefined;
export function normalizeNameContains(value: unknown): unknown;
export function normalizeNameContains(value: unknown): unknown {
  if (typeof value === "string") {
    const stripped = pyStrip(value);
    return stripped === "" ? undefined : stripped;
  }
  return value === null ? undefined : value;
}

/**
 * Whether memory-cloud refuses this `list_contexts` page (v0.82.0+, #1743)
 * — the Python SDK's `_details_page_over_cap`: with `include_details` and
 * no filter, more than 20 contexts.
 *
 * @param nameContains The filter as {@link normalizeNameContains} returned
 *   it: only a string is a filter (a blank one is already `undefined`).
 * @internal Shared with the CLI's `context list`, which names its own
 *   flags in the usage error.
 */
export function detailsPageOverCap(
  includeDetails: boolean | undefined,
  nameContains: unknown,
  limit: number | undefined,
): boolean {
  return (
    Boolean(includeDetails) &&
    typeof nameContains !== "string" &&
    limit !== undefined &&
    limit > LIST_CONTEXTS_DETAILS_MAX_LIMIT
  );
}

/**
 * Low-level client for Kagura Memory Cloud MCP tools.
 *
 * All methods may throw KaguraAuthError (authentication failed — also an
 * OAuth token that lacks the scope a tool needs, HTTP 403
 * `insufficient_scope`, memory-cloud v0.79.0+, whose message names the
 * scope), KaguraConnectionError (connection failed; its subclass
 * KaguraServiceUnavailableError for an HTTP 503, with `retryAfter` and
 * `reason`), or KaguraRateLimitError.
 *
 * MCP tool methods additionally translate the server's structured domain
 * errors (`{"status": "error", ...}`) into exceptions rather than
 * returning them as data: a missing context/memory/report throws
 * {@link KaguraNotFoundError}, a plan, quota or capacity refusal its typed
 * error ({@link KaguraFeatureNotAvailableError}, {@link KaguraQuotaError},
 * {@link KaguraCapacityLockedError}), any other domain error throws
 * {@link KaguraError}. Every one keeps the envelope's `error` as `code` and
 * its other fields in `details`; branch on `code`, never on the message.
 * Use try/catch rather than inspecting `result.status`.
 *
 * Authentication resolution order when `apiKey` is omitted:
 * 1. `KAGURA_API_KEY` env var (CI / service accounts always win).
 * 2. The OAuth profile from `~/.kagura/credentials.json`, selected by
 *    `options.profile` or `KAGURA_PROFILE`, falling back to the file's
 *    `default_profile`.
 * 3. `.kagura.json` (cwd or `~/`) plus its own env fallback.
 */
export class KaguraClient {
  readonly mcpUrl: string;
  readonly timeoutMs: number;

  private readonly baseUrl: string;
  private readonly auth: AuthProvider;
  private readonly fetchImpl: typeof globalThis.fetch;
  /** {@link KaguraClientOptions.warn}. */
  private readonly warn: (message: string) => void;
  private sessionId: string | null = null;
  /** The in-flight `initialize`, shared by every caller (see initializeSession). */
  private sessionOpening: Promise<string> | null = null;
  /** Bumped by close(), so a handshake it interrupted cannot re-adopt its session. */
  private sessionEpoch = 0;
  private requestIdCounter = 1;
  /**
   * Context id (lower case) → name, for the `listTags` drill-down (#47):
   * the name its REST route sends from server v0.77.0, else the one a
   * one-tag `list_tags` lookup or a plain `listTags` returned. Safe to
   * keep: the server has no way to rename a context (`update_context`
   * cannot change `name`).
   */
  private readonly contextNames = new Map<string, string>();

  constructor(options: KaguraClientOptions = {}) {
    const resolved = resolveAuth({
      apiKey: options.apiKey ?? null,
      mcpUrl: options.mcpUrl ?? null,
      profile: options.profile ?? null,
      env: options.env,
      home: options.home,
    });

    const strippedUrl = resolved.mcpUrl.replace(/\/+$/, "");
    validateHttpsUrl(strippedUrl, "MCP URL");

    this.mcpUrl = strippedUrl;
    this.baseUrl = baseUrlFromMcp(strippedUrl);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    // Looked up per warning, so a console.warn replaced later still gets it.
    this.warn = options.warn ?? ((message) => console.warn(message));

    if (resolved.kind === "static") {
      // Long-lived API key path: bake the bearer header once.
      const header = `Bearer ${resolved.apiKey}`;
      this.auth = { getAuthHeader: async () => header };
    } else {
      // OAuth path: the provider injects a fresh bearer header per request
      // and coordinates refresh through the shared credentials state.
      this.auth = resolved.oauth;
    }
  }

  /** Get next JSON-RPC request ID. */
  private nextRequestId(): number {
    return this.requestIdCounter++;
  }

  private async post(
    url: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: await this.auth.getAuthHeader(),
      "user-agent": `kagura-memory-sdk/${SDK_VERSION}`,
      ...extraHeaders,
    };
    try {
      return await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new KaguraConnectionError(`Connection failed: ${excMessage(e)}`, { cause: e });
    }
  }

  /**
   * Initialize the MCP session if not already initialized, and return its id.
   *
   * Single-flight: calls that find no session at the same time (on first
   * use, or after all hitting one expired session) share one `initialize`
   * instead of each opening, and orphaning, a session of their own.
   *
   * Callers send the id returned here rather than re-reading `sessionId`:
   * a concurrent expired-session 404 can clear the field in the tick the
   * `await` yields, which would send the request with no session at all.
   */
  private async initializeSession(): Promise<string> {
    if (this.sessionId) {
      return this.sessionId;
    }
    // Dropped once settled, so a failed handshake is retried by the next
    // call rather than replayed to it.
    if (!this.sessionOpening) {
      const opening = this.openSession().finally(() => {
        // close() may have dropped this handshake and a newer one started.
        if (this.sessionOpening === opening) {
          this.sessionOpening = null;
        }
      });
      this.sessionOpening = opening;
    }
    return this.sessionOpening;
  }

  /**
   * Run the `initialize` handshake and keep the session id it returns —
   * unless close() ran meanwhile, in which case the id serves only the
   * calls already waiting on it.
   */
  private async openSession(): Promise<string> {
    const epoch = this.sessionEpoch;
    const body = {
      jsonrpc: "2.0",
      id: this.nextRequestId(),
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "kagura-memory-sdk", version: SDK_VERSION },
      },
    };

    const response = await this.post(this.mcpUrl, body);
    if (!response.ok) {
      throwForKaguraStatus(response.status, response.headers, await this.safeText(response));
    }

    const sessionId = response.headers.get("mcp-session-id");
    if (!sessionId) {
      throw new KaguraConnectionError("No session ID returned from server");
    }
    if (epoch === this.sessionEpoch) {
      this.sessionId = sessionId;
    }
    return sessionId;
  }

  private async safeText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  /**
   * Make a JSON-RPC 2.0 request to the MCP server.
   *
   * MCP Streamable HTTP answers a request naming a session the server has
   * dropped (idle hour, restart) with a 404 and requires a new `initialize`;
   * without recovery a long-lived client would fail every call from then on
   * (#39). The session is re-opened and the request retried exactly once.
   * The server rejects it before dispatch, which makes that retry safe even
   * for a non-idempotent `tools/call`. (As deployed, server v0.75.0
   * re-adopts an unknown session id instead, so against it this never
   * fires.)
   *
   * A `result` that is not an object reads as `{}`; {@link jsonRpcResult}
   * returns it as sent.
   */
  private async makeJsonRpcRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.jsonRpcResult(method, params);
    return typeof result === "object" && result !== null
      ? (result as Record<string, unknown>)
      : {};
  }

  /**
   * {@link makeJsonRpcRequest}'s request, its `result` as sent — Python's
   * `data.get("result", {})`: `{}` when the reply has none, else the value
   * itself, a `null` or a list included, for a caller that reads it as
   * Python's model does.
   */
  private async jsonRpcResult(method: string, params: Record<string, unknown>): Promise<unknown> {
    const sessionId = await this.initializeSession();

    const body = {
      jsonrpc: "2.0",
      id: this.nextRequestId(),
      method,
      params,
    };

    let response = await this.post(this.mcpUrl, body, mcpSessionHeader(sessionId));
    let text = await this.safeText(response);
    if (mcpSessionExpired(response.status, text, sessionId)) {
      // Forget the session only while it is still the stale one: a
      // concurrent call may already have re-opened it, and that one stays.
      if (this.sessionId === sessionId) {
        this.sessionId = null;
      }
      const retrySessionId = await this.initializeSession();
      response = await this.post(this.mcpUrl, body, mcpSessionHeader(retrySessionId));
      text = await this.safeText(response);
      if (mcpSessionExpired(response.status, text, retrySessionId)) {
        const expired = parseJsonBody(text);
        const detail = detailOf(expired);
        const err = new KaguraConnectionError(
          "MCP session expired; the client re-initialized once and the retry still got " +
            (detail ? `HTTP 404: ${detail}` : "HTTP 404"),
        );
        const fields = serverErrorFieldsOf(expired);
        throw fields === null ? err : annotateServerError(err, fields[0], fields[1]);
      }
    }
    if (!response.ok) {
      throwForKaguraStatus(response.status, response.headers, text);
    }

    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (e) {
      throw new KaguraConnectionError(`Invalid response format: ${excMessage(e)}`, { cause: e });
    }
    // Python's `response.json() or {}`: a `null` (or another falsy) body is no result.
    const empty = !parsed || (Array.isArray(parsed) && parsed.length === 0);
    const data = (empty ? {} : parsed) as Record<string, unknown>;
    if (typeof data === "object" && data !== null && "error" in data) {
      // Python: f"MCP error: {error.get('message', error)}" -- str() of
      // whatever the server sent, a present null included.
      const error = data.error;
      const message =
        typeof error === "object" && error !== null && Object.prototype.hasOwnProperty.call(error, "message")
          ? (error as Record<string, unknown>).message
          : error;
      // Streamable HTTP answers a JSON-RPC error in a 200 too: memory-cloud
      // sends a tools/call whose plumbing failed that way, its `data` in
      // the tool-error vocabulary (`error`, `help`, `cause`,
      // `correlation_id`, `retryable`, `outcome`). The class stays
      // Python's, KaguraConnectionError; only a JSON-RPC error object's
      // `data` is read for `code` / `details`.
      const err = new KaguraConnectionError(`MCP error: ${pyStr(message)}`);
      const fields = isRecord(error) ? serverErrorFieldsOf(data) : null;
      throw fields === null ? err : annotateServerError(err, fields[0], fields[1]);
    }

    return typeof data === "object" && data !== null && Object.prototype.hasOwnProperty.call(data, "result")
      ? data.result
      : {};
  }

  /**
   * GET a REST endpoint and parse the JSON body.
   *
   * An array param is sent as one repeated key per item (`?k=a&k=b`), which
   * is how FastAPI reads a `list[str]` query; joined, `a,b` is one value.
   *
   * Without `mcpTool`, every non-2xx goes through the standard status
   * mapping (a 404 is a {@link KaguraConnectionError}). With it, a 404 and a
   * 422 get the classes and messages the MCP path gives that tool's
   * not-found code (`mcpTool.notFoundCode`, e.g. `list_tags`'s
   * `context_not_found`) and `invalid_argument` errors, so a method that
   * moved from MCP to REST throws what it always threw, with that code.
   */
  private async restGet<T>(
    path: string,
    params?: Record<string, unknown>,
    mcpTool?: { operation: string; notFoundCode: string },
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (params) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            query.append(key, String(item));
          }
        } else if (value !== undefined && value !== null) {
          query.set(key, String(value));
        }
      }
      const qs = query.toString();
      if (qs) {
        url += `?${qs}`;
      }
    }

    // Before the try, as post() and restBase do: a refresh that fails is
    // the KaguraAuthExpiredError it is, not a connection failure (#69).
    const authorization = await this.auth.getAuthHeader();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          authorization,
          "user-agent": `kagura-memory-sdk/${SDK_VERSION}`,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new KaguraConnectionError(`Connection failed: ${excMessage(e)}`, { cause: e });
    }

    const text = await this.safeText(response);
    if (!response.ok) {
      if (mcpTool !== undefined) {
        const { operation, notFoundCode } = mcpTool;
        const body = parseJsonBody(text);
        const detail = detailOf(body);
        let mapped: KaguraError | null = null;
        if (response.status === 404) {
          mapped = new KaguraNotFoundError(`${operation}: ${detail || "Not found"}`, {
            code: notFoundCode,
          });
        } else if (response.status === 422) {
          mapped = new KaguraError(`${operation} failed (invalid_argument): ${detail || "HTTP 422"}`, {
            code: "invalid_argument",
          });
        }
        if (mapped !== null) {
          // `code` stays the MCP tool's; the REST body's fields are what
          // the server sent with it (Python's `_rest_get_json`).
          const fields = serverErrorFieldsOf(body);
          throw fields === null ? mapped : annotateServerError(mapped, fields[0], fields[1]);
        }
      }
      throwForKaguraStatus(response.status, response.headers, text);
    }
    // Read as Python's `response.json()` reads it (#69), so a body it
    // refuses reads in its words; its RecursionError is no ValueError, so
    // Python lets it through, and so does this.
    try {
      return parseJsonLossless(text) as T;
    } catch (e) {
      if (e instanceof JsonNestingError) throw e;
      throw new KaguraConnectionError(`Invalid response format: ${excMessage(e)}`, { cause: e });
    }
  }

  /**
   * {@link restGet}, then the body checked against the Python SDK's model
   * for it, as its `_rest_get` parses it (python-sdk #277): a 2xx body the
   * model refuses throws {@link KaguraResponseError} with `operation`
   * (`KaguraClient.<method>`) and the failing fields, never their values.
   * The body is returned as the server sent it: checked, not converted.
   */
  private async restGetChecked<T>(
    path: string,
    model: Model,
    operation: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const body = await this.restGet<unknown>(path, params);
    readModel(body, model, operation);
    return body as T;
  }

  /**
   * Call an MCP tool via JSON-RPC and parse `content[0].text` as JSON.
   *
   * @throws KaguraResponseError when the text is JSON but not an object
   *   (`null`, a list, a scalar): no tool replies with one, and every
   *   caller reads fields of the reply. The Python SDK fails there with an
   *   `AttributeError` (#66).
   */
  private async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const result = await this.makeJsonRpcRequest("tools/call", {
      name: toolName,
      arguments: args,
    });

    const content = result.content;
    if (Array.isArray(content) && content.length > 0) {
      // An item with no text reads as `{}`, as one with a non-string text does.
      const first = content[0] as { text?: unknown } | null;
      const text = typeof first?.text === "string" ? first.text : "{}";
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new KaguraConnectionError(`Invalid response format: ${excMessage(e)}`, {
          cause: e,
        });
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw responseShapeError(
          toolName,
          `tool reply: expected a JSON object, got ${pyTypeName(parsed)}`,
        );
      }
      return parsed as ToolResult;
    }
    return {};
  }

  /**
   * Call an MCP tool and translate domain errors into exceptions.
   *
   * A server `{"status": "error", ...}` response throws
   * KaguraNotFoundError / KaguraError instead of being returned as data.
   */
  private async callToolChecked(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const result = await this.callTool(toolName, args);
    KaguraClient.raiseForMcpError(result, toolName);
    return result;
  }

  /**
   * Call any MCP tool by name — the escape hatch for tools this SDK has no
   * typed wrapper for yet (#28).
   *
   * Everything above is a typed wrapper over a specific tool, and that is
   * still the surface to prefer: wrappers validate arguments locally, map
   * camelCase to the wire's snake_case, and give you a return type. But
   * `callTool` is private, so before this existed one forgotten wrapper left
   * a tool completely unreachable — a caller had to vendor a patched SDK or
   * hand-roll JSON-RPC. `secret_*` was exactly that case.
   *
   * Args are passed through **verbatim**, so they must already be in wire
   * form (`context_id`, not `contextId`), and the result is an untyped
   * `ToolResult`.
   *
   * Domain errors are still translated, so a server `{"status": "error"}`
   * throws rather than coming back as data — but only error codes the SDK
   * recognizes get a specific class. A code from a tool with no wrapper
   * (`secret_not_found`, say) lands on the generic {@link KaguraError}, so
   * branch on its `code` (the envelope's `error`) or add the code to
   * `raiseForMcpError` when you confirm it against the server. Plan, quota
   * and capacity refusals are the exception: a v0.75.0+ server tags them
   * with a `gate`, so they get {@link KaguraFeatureNotAvailableError} /
   * {@link KaguraQuotaError} / {@link KaguraCapacityLockedError} from any tool.
   *
   * Use `getToolDefinitions()` to discover what the connected server offers.
   *
   * @throws Error if `toolName` is empty or whitespace.
   */
  async callRawTool(toolName: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    if (typeof toolName !== "string" || !toolName.trim()) {
      throw new Error("toolName must be a non-empty string");
    }
    return this.callToolChecked(toolName, args);
  }

  /**
   * Translate an MCP tool's structured error response to an SDK error.
   *
   * The server's MCP tools return `{"status": "error", "error": <code>,
   * "message": <str>, ...}` for domain errors the JSON-RPC transport
   * cannot represent. HTTP-level errors are handled by the request layer.
   *
   * Classes are keyed on the code and the envelope's own fields, never on
   * the message, whose wording the server has changed before. Plan and
   * quota refusals go by the envelope's `gate` first (server v0.75.0+),
   * then by the code; their message stays the generic one, so matching on
   * it keeps working. A quota's `retry_after_seconds` (the resource
   * events-per-hour quota on `ingest_events`) becomes its `retryAfter`.
   * The in-band daily MCP call cap, `rate_limit_exceeded`, is a
   * {@link KaguraQuotaError} too: `quotaType` `api_mcp_daily`, `current` /
   * `limit` from its `used_today` / `daily_limit`, and `resetsAt` the next
   * UTC midnight, when the cap resets. The Free capacity lock
   * (`capacity_locked`, memory-cloud v0.99.0+) is
   * {@link KaguraCapacityLockedError}. Every other code is a plain
   * {@link KaguraError} — `payload_too_large` among them (a memory over
   * 1 MB, v0.108.0+, with `limit` / `actual` in `details`).
   *
   * Every error keeps the envelope: `code` is its `error` (`undefined` for
   * an envelope without one, whose message still says `failed (unknown)`)
   * and `details` everything but `status` / `error` / `message` — `help` and, on a server
   * failure, `cause`, `correlation_id`, `retryable` and for a write
   * `outcome` (all v0.78.0+, #1684), which {@link KaguraError} reads as
   * getters.
   */
  private static raiseForMcpError(result: ToolResult, operation: string): void {
    if (result.status !== "error") {
      return;
    }
    // Python: result.get(key, default), then str() of it -- a present null
    // is "None", a number or an object its repr.
    const has = (key: string) => Object.prototype.hasOwnProperty.call(result, key);
    // An envelope without `error` names no code: the message says
    // `(unknown)`, as before, but `code` stays undefined.
    const code = has("error") ? pyStr(result.error) : undefined;
    const message = has("message") ? pyStr(result.message) : "Unknown error";
    throw annotateServerError(
      KaguraClient.mcpError(result, code, message, operation),
      code,
      mcpEnvelopeFields(result),
    );
  }

  /** The error {@link raiseForMcpError} throws, before it keeps the envelope on it. */
  private static mcpError(
    result: ToolResult,
    code: string | undefined,
    message: string,
    operation: string,
  ): KaguraError {
    if (
      code === "report_not_found" ||
      code === "context_not_found" ||
      code === "memory_not_found" ||
      code === "agent_not_found" ||
      code === "binding_not_found" ||
      code === "session_not_found"
    ) {
      return new KaguraNotFoundError(`${operation}: ${message}`);
    }
    const failure = `${operation} failed (${code ?? "unknown"}): ${message}`;
    if (code === "partial_rollback") {
      const reportId = typeof result.report_id === "string" ? result.report_id : null;
      let summary: RollbackSummary;
      try {
        summary = readRollbackSummary(result.rollback_summary, operation);
      } catch (drift) {
        if (!(drift instanceof KaguraResponseError)) throw drift;
        // The partial reversal is already committed; a summary the SDK
        // cannot read must not hide that (Python's #256).
        return new KaguraPartialRollbackError(`${failure} (rollback_summary could not be read)`, reportId, {}, {
          cause: drift,
        });
      }
      return new KaguraPartialRollbackError(failure, reportId, summary);
    }
    const gated = gateError(
      result,
      code ?? null,
      MCP_GATE_CODES,
      failure,
      bodyRetryAfter(result, "retry_after_seconds"),
      mcpEnvelopeFields(result),
    );
    if (gated !== null) {
      return gated;
    }
    if (code === "permission_denied") {
      return new KaguraPermissionError(
        failure,
        typeof result.required_role === "string" ? result.required_role : null,
      );
    }
    return new KaguraError(failure);
  }

  /**
   * Store a memory. Returns the API response with `memory_id`.
   *
   * @throws Error if `tags` holds more than 50 tags or a tag longer than
   *   100 characters (the caps memory-cloud v0.82.0+ enforces), before any
   *   request.
   */
  async remember(options: RememberOptions): Promise<ToolResult> {
    validateMemoryTags(options.tags);
    const args: Record<string, unknown> = {
      context_id: options.contextId,
      summary: options.summary,
      content: options.content,
      type: options.type ?? "note",
      importance: options.importance ?? 0.5,
    };
    if (options.tags !== undefined) {
      args.tags = options.tags;
    }
    if (options.sourceUri !== undefined) {
      args.source_uri = options.sourceUri;
    }
    if (options.sourceType !== undefined) {
      args.source_type = options.sourceType;
    }
    // Only send a non-default delivery_mode; the server applies
    // server_default='on_recall' so omitting it stays forward-compatible.
    if (options.deliveryMode !== undefined && options.deliveryMode !== "on_recall") {
      args.delivery_mode = options.deliveryMode;
    }
    if (options.contextSummary !== undefined) {
      args.context_summary = options.contextSummary;
    }
    if (options.details !== undefined) {
      args.details = options.details;
    }
    if (options.context !== undefined) {
      args.context = options.context;
    }
    if (options.linkedMemoryIds !== undefined) {
      args.linked_memory_ids = options.linkedMemoryIds;
    }
    if (options.linkedSourceUris !== undefined) {
      args.linked_source_uris = options.linkedSourceUris;
    }
    if (options.supersedes !== undefined) {
      args.supersedes = options.supersedes;
    }
    return this.callToolChecked("remember", args);
  }

  /**
   * Search memories. Returns the API response with a `results` list.
   *
   * Since server v0.108.0 a hit is **compact** unless you pass
   * `verbosity: "full"`: a 160-character summary head and no `tags`,
   * `context_summary` or `scope`. Since v0.114.0 the top results also
   * carry `content` unless you pass `full: 0`. `verbosity`, `full` and
   * `maxChars` are sent only when set. From v0.82.0 a server refuses a
   * tool argument it does not declare (`KaguraError`, code
   * `invalid_argument`), so there `verbosity` needs v0.108.0+ and `full`
   * v0.114.0+; a server before v0.82.0 ignores all three. This method
   * never retries without them: the caller decides. (The `recall` command
   * of the `kagura-memory` bin retries once without the ones the refusal
   * lists in `unknown_arguments`.)
   *
   * The result is the server's reply as sent, typed as
   * {@link RecallResponse}; `confidence` comes first, and its `level`
   * (`high` / `moderate` / `low` / `none`) says whether the hits are worth
   * reading.
   *
   * When the semantic half of a hybrid search (the default `searchMode`)
   * is unavailable, server v0.66.0+ falls back to keyword-only search —
   * `searchMode: "semantic"` still fails — and adds `degraded: true` and
   * `degraded_reason` (`"embedding_unavailable"` or
   * `"vector_search_unavailable"`) instead of failing. Both keys are absent
   * on a normal search. A degraded result has a different `confidence`
   * basis, and an empty one means "search impaired", not "nothing stored".
   *
   * @throws Error if `query` is empty/whitespace; if neither `contextId`
   *   nor `contextIds` is provided; if `contextIds` has fewer than 2 or
   *   more than 20 IDs; if `searchMode` is invalid; if `verbosity` is not
   *   `"compact"` / `"full"`; or if `full` (0-100) or `maxChars`
   *   (10,000-100,000) is not an integer in range. Checked before any
   *   request.
   */
  async recall(options: RecallOptions): Promise<RecallResponse> {
    const { query, contextId, contextIds, searchMode } = options;
    if (typeof query !== "string" || !query.trim()) {
      throw new Error("query must be a non-empty string");
    }
    if (contextIds !== undefined) {
      if (contextIds.length < 2 || contextIds.length > 20) {
        throw new Error(`contextIds must contain 2-20 IDs, got ${contextIds.length}`);
      }
    } else if (contextId === undefined) {
      throw new Error("Either contextId or contextIds must be provided");
    }

    const args: Record<string, unknown> = {
      query,
      k: options.k ?? 5,
    };
    if (contextIds !== undefined) {
      args.context_ids = contextIds;
    } else {
      args.context_id = contextId;
    }
    // Send an explicit false: since server v0.69.0 an omitted use_rerank
    // follows the context config, so dropping false would still rerank.
    if (options.useRerank !== undefined) {
      args.use_rerank = options.useRerank;
    }
    if (options.filters && Object.keys(options.filters).length > 0) {
      args.filters = options.filters;
    }
    if (searchMode) {
      if (searchMode !== "hybrid" && searchMode !== "semantic" && searchMode !== "keyword") {
        throw new Error(`Invalid searchMode: ${JSON.stringify(searchMode)}`);
      }
      args.search_mode = searchMode;
    }
    if (options.includeExploreHints) {
      args.include_explore_hints = true;
    }
    if (options.includeSuperseded) {
      args.include_superseded = true;
    }
    const { verbosity, full, maxChars } = options;
    if (isSet(verbosity)) {
      if (verbosity !== "compact" && verbosity !== "full") {
        throw new Error(`verbosity must be 'compact' or 'full', got ${pyRepr(verbosity)}`);
      }
      args.verbosity = verbosity;
    }
    if (isSet(full)) {
      args.full = validateIntRange("full", full, 0, RECALL_FULL_MAX);
    }
    if (isSet(maxChars)) {
      args.max_chars = validateMaxChars(maxChars);
    }
    // The reply as sent: Python returns the dict unchecked too.
    return (await this.callToolChecked("recall", args)) as RecallResponse;
  }

  /**
   * List Time Memories whose scheduled window overlaps a range, soonest
   * first. A deterministic time query over `type="time"` memories — not
   * semantic search, no Hebbian side-effects.
   *
   * Since server v0.73.0 each item carries `trigger` (the memory's
   * `details.trigger`) instead of the full `details` object, so
   * `item.details` is `undefined` by default. Pass `includeDetails: true`
   * to get `details` back, or call {@link reference} for one memory.
   */
  async recallUpcoming(options: {
    contextId: string;
    /** Lower bound as naive ISO, or the literal "now". Omit for no lower bound. */
    from?: string;
    /** Upper bound as naive ISO. Omit for an open-ended future window. */
    until?: string;
    /** Maximum results (default 20, server max 100). */
    k?: number;
    /** Return each item's full `details` instead of its `trigger` (default false). */
    includeDetails?: boolean;
  }): Promise<ToolResult> {
    const args: Record<string, unknown> = {
      context_id: options.contextId,
      k: options.k ?? 20,
    };
    if (options.from !== undefined) {
      args.from = options.from;
    }
    if (options.until !== undefined) {
      args.until = options.until;
    }
    if (options.includeDetails) {
      args.include_details = true;
    }
    return this.callToolChecked("recall_upcoming", args);
  }

  /**
   * List memories near a geographic point, nearest first, each carrying
   * `distance_m`. The WHERE axis — a deterministic spatial query over
   * stored `details.location` coordinates, not semantic search (use
   * {@link recall} for topic search). Mirrors {@link recallUpcoming}.
   *
   * Store a location with
   * `remember({ details: { location: { lat, lon, label } } })`; see
   * {@link MemoryLocation}. Any memory type can carry one.
   *
   * Note: {@link updateMemory} replaces `details` wholesale, so resend
   * `location` when updating details or the memory drops off this axis.
   *
   * `radiusM` is clamped server-side to [1, 1_000_000]; it is forwarded
   * unchanged rather than pre-clamped here, so the server stays the single
   * authority on the bound.
   *
   * Since server v0.82.0 each item carries `location` (the memory's
   * `details.location`) instead of the whole `details`; an older server
   * sends `details`. With `includeDetails: true` the item carries
   * `details` in place of `location`, held to the reply budget (about
   * 20,000 characters): from the last item backwards, an item that does
   * not fit carries `details_omitted: true` and `details_total_chars`
   * instead — read it with {@link reference}. See {@link NearbyMemory}.
   *
   * @throws Error if `lat`/`lon` are not finite numbers in range. The
   *   server rejects these with HTTP 422; failing locally turns the common
   *   swapped-lat/lon mistake into an immediate, named error.
   */
  async recallNearby(options: {
    contextId: string;
    /** Query latitude (-90..90). */
    lat: number;
    /** Query longitude (-180..180). */
    lon: number;
    /** Search radius in meters (default 1000). */
    radiusM?: number;
    /** Maximum results (default 20; the server clamps to 1-100). */
    k?: number;
    /**
     * Return each item's full `details` object in place of its `location`
     * (default false). Details can be large. Sent only when `true`; needs
     * server v0.82.0+, and an older server ignores it and always returns
     * `details`.
     */
    includeDetails?: boolean;
  }): Promise<RecallNearbyResponse> {
    const { lat, lon } = options;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new Error(`lat must be a finite number between -90 and 90, got ${lat}`);
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new Error(`lon must be a finite number between -180 and 180, got ${lon}`);
    }
    const args: Record<string, unknown> = {
      context_id: options.contextId,
      lat,
      lon,
      radius_m: options.radiusM ?? 1000,
      k: options.k ?? 20,
    };
    if (options.includeDetails) {
      args.include_details = true;
    }
    const result = await this.callToolChecked("recall_nearby", args);
    return result as unknown as RecallNearbyResponse;
  }

  /**
   * Append one numeric observation to a metric's series — the HOW-MUCH
   * axis (server v0.54.0+, memory-cloud #1333).
   *
   * Measurements are a lane **separate from memories**: never embedded,
   * never returned by {@link recall}, never merged or rewritten by Sleep
   * consolidation. The lane is append-only: recording the same point
   * twice stores two rows, and there is no delete. Store raw numbers here
   * (weight, revenue, reps) and prose such as "hit goal weight" with
   * {@link remember}; read a series back with {@link recallSeries}.
   *
   * An older server does not know the tool and answers `unknown_tool`,
   * which throws {@link KaguraError}
   * (`record_measurement failed (unknown_tool): Unknown tool: record_measurement`).
   * From server v0.55.0 an operator can set
   * `SLEEP_MEASUREMENT_RETENTION_DAYS` above 0 (default 0, keep forever),
   * and Sleep then **hard-deletes** older observations, which
   * {@link rollbackSleepRun} cannot restore.
   *
   * The result is read as the Python SDK's `MeasurementResult` model
   * reads it: its keys in its order, `unit` `null` when absent, other
   * fields dropped.
   *
   * @throws Error before any request when `metric` is empty or over 64
   *   characters, `value` is not a finite number, `unit` is empty or over
   *   32 characters, or `measuredAt` is an invalid `Date` — the Python
   *   SDK's messages.
   * @throws KaguraNotFoundError if the context is not found (or an agent
   *   binding forbids writing to it).
   * @throws KaguraPermissionError for a read-only viewer.
   * @throws KaguraResponseError if the result is not a `MeasurementResult`
   *   (`operation` `"record_measurement"`).
   */
  async recordMeasurement(options: RecordMeasurementOptions): Promise<MeasurementResult> {
    validateMetric(options.metric);
    const value = measurementValue(options.value);
    const { unit } = options;
    if (
      isSet(unit) &&
      (typeof unit !== "string" || unit === "" || [...unit].length > UNIT_MAX_LEN)
    ) {
      throw new Error(
        `unit must be a non-empty string of at most ${UNIT_MAX_LEN} characters, got ${pyRepr(unit)}`,
      );
    }

    const args: Record<string, unknown> = {
      context_id: options.contextId,
      metric: options.metric,
      value,
    };
    // `is not None`, as Python checks it: an empty `measuredAt` is sent,
    // for the server to refuse.
    if (isSet(options.measuredAt)) {
      args.measured_at = isoArg(options.measuredAt, "measuredAt");
    }
    if (isSet(unit)) {
      args.unit = unit;
    }
    if (isSet(options.details)) {
      args.details = options.details;
    }
    return readMeasurementResult(await this.callToolChecked("record_measurement", args));
  }

  /**
   * Read one metric's series, bucketed by period and aggregated per
   * bucket (server v0.54.0+, memory-cloud #1333).
   *
   * A **deterministic query**, not search, over the lane
   * {@link recordMeasurement} writes. Buckets align to UTC boundaries, so a
   * local day may span two; empty buckets are omitted, oldest first. The
   * result's `count` is the number of buckets, not of observations.
   *
   * Only `metric` is checked locally. The server is the authority on
   * `period`, `agg` and the window: it refuses an unknown value, a start
   * not before the end, and a window over 365 days with a
   * `validation_error` ({@link KaguraError}). An older server answers
   * `unknown_tool`, as for {@link recordMeasurement}.
   *
   * The result is read as the Python SDK's `MeasurementSeries` model
   * reads it: its keys in its order, other fields dropped. `period` and
   * `agg` echo what the server applied, as plain strings.
   *
   * @throws Error before any request when `metric` is empty or over 64
   *   characters, or `start` / `end` is an invalid `Date`.
   * @throws KaguraNotFoundError if the context is not found.
   * @throws KaguraResponseError if the result is not a `MeasurementSeries`
   *   (`operation` `"recall_series"`).
   */
  async recallSeries(options: RecallSeriesOptions): Promise<MeasurementSeries> {
    validateMetric(options.metric);

    const args: Record<string, unknown> = { context_id: options.contextId, metric: options.metric };
    if (isSet(options.period)) {
      args.period = options.period;
    }
    if (isSet(options.agg)) {
      args.agg = options.agg;
    }
    if (isSet(options.start)) {
      args.start = isoArg(options.start, "start");
    }
    if (isSet(options.end)) {
      args.end = isoArg(options.end, "end");
    }
    return readMeasurementSeries(await this.callToolChecked("recall_series", args));
  }

  /**
   * Deterministically load a context's pinned (`delivery_mode="always"`)
   * memories — the complete, unranked pinned set on every call.
   *
   * The set is bounded, never silently dropped: when more pinned memories
   * exist than `cap` or `maxChars` allows, the response `truncated` flag
   * is true and `total_available` reports the real count;
   * `context_summary_omitted: true` says the budget took `context_summary`
   * off the items.
   *
   * @throws Error if `maxChars` is not an integer in 10,000-100,000,
   *   before any request.
   */
  async loadPinned(options: {
    contextId: string;
    /** Override the maximum number returned (1-1000); omit for server default. */
    cap?: number;
    /**
     * Response budget in characters, not tokens: 10,000-100,000 (server
     * default 20,000). Over budget the server leaves `context_summary` out
     * of every item first (`context_summary_omitted: true`), then cuts
     * items from the end (`truncated: true`). Sent only when set; needs
     * server v0.82.0+, and an older server ignores it.
     */
    maxChars?: number;
  }): Promise<ToolResult> {
    const args: Record<string, unknown> = { context_id: options.contextId };
    if (options.cap !== undefined) {
      args.cap = options.cap;
    }
    if (isSet(options.maxChars)) {
      args.max_chars = validateMaxChars(options.maxChars);
    }
    return this.callToolChecked("load_pinned", args);
  }

  /**
   * Deterministically load a context's guardrail set for a client-side
   * hook — {@link loadPinned}'s twin (server v0.74.0+).
   *
   * Two lanes, each capped on its own: `pinned` (`delivery_mode="always"`)
   * and `tool_triggered`, every memory carrying `details.tool_trigger`
   * ({@link ToolTrigger}). `cap` bounds the tool-triggered lane only, so a
   * large pinned set never crowds guardrails out. Trusted-tier rows only;
   * the patterns come back as data — the server never runs them.
   *
   * Never silently dropped: check `tool_triggered_truncated` /
   * `pinned_truncated` before treating the set as complete.
   *
   * @throws Error if `maxChars` is not an integer in 10,000-100,000,
   *   before any request.
   */
  async loadGuardrails(options: {
    contextId: string;
    /** Override the tool-triggered cap (1-1000); omit for server default. */
    cap?: number;
    /**
     * Response budget in characters, not tokens: 10,000-100,000 (server
     * default 20,000). Over budget the server drops the `index` rows
     * (v0.127.0+) first, then leaves `context_summary` out of the pinned
     * items (`context_summary_omitted: true`), then cuts pinned and then
     * tool-triggered items from the end, setting that lane's
     * `*_truncated`. Sent only when set; needs server v0.82.0+, and an
     * older server ignores it. The REST twin
     * (`MemoryClient.loadGuardrails`) takes no `maxChars`.
     */
    maxChars?: number;
  }): Promise<LoadGuardrailsResponse> {
    const args: Record<string, unknown> = { context_id: options.contextId };
    if (options.cap !== undefined) {
      args.cap = options.cap;
    }
    if (isSet(options.maxChars)) {
      args.max_chars = validateMaxChars(options.maxChars);
    }
    const result = await this.callToolChecked("load_guardrails", args);
    return result as unknown as LoadGuardrailsResponse;
  }

  /**
   * Record whether a recalled memory was useful for a query — an
   * append-only usefulness signal, kept in a separate lane from knowledge
   * (never pollutes recall).
   */
  async feedback(options: {
    contextId: string;
    memoryId: string;
    helpful: boolean;
    /** Recall query this feedback is about (max 1024 chars). */
    query?: string;
    /** Free-text note, e.g. why the result was wrong (max 2000 chars). */
    note?: string;
  }): Promise<ToolResult> {
    const args: Record<string, unknown> = {
      context_id: options.contextId,
      memory_id: options.memoryId,
      helpful: options.helpful,
    };
    if (options.query !== undefined) {
      args.query = options.query;
    }
    if (options.note !== undefined) {
      args.note = options.note;
    }
    return this.callToolChecked("feedback", args);
  }

  /**
   * Set ephemeral agent run-state at `(contextId, key)` — a TTL-bounded
   * key/value lane kept separate from memories and excluded from recall.
   * Use remember() for durable knowledge.
   *
   * @throws Error if `value` is longer than 16,384 characters as compact
   *   JSON (the cap memory-cloud v0.82.0+ enforces), before any request.
   */
  async setState(options: {
    contextId: string;
    /** State key (max 255 chars); re-use overwrites. */
    key: string;
    /**
     * Arbitrary JSON value, at most 16,384 characters as compact JSON —
     * measured as the server measures it (`ensure_ascii=False`, no
     * spaces, in code points). Store large data as a memory and keep its
     * id here.
     */
    value: unknown;
    /** TTL in seconds (server clamps to 30 days); omit for no expiry. */
    ttlSeconds?: number;
  }): Promise<ToolResult> {
    validateStateValue(options.value);
    const args: Record<string, unknown> = {
      context_id: options.contextId,
      key: options.key,
      value: options.value,
    };
    if (options.ttlSeconds !== undefined) {
      args.ttl_seconds = options.ttlSeconds;
    }
    return this.callToolChecked("set_state", args);
  }

  /**
   * Read ephemeral agent run-state. Supply `key` to read one value, omit
   * it to list the context's live entries.
   *
   * Since memory-cloud v0.82.0 (#1743) the list is paged in key order, 50
   * entries a page by default (`limit`) within a 20,000-character budget
   * by default (`maxChars`). The reply then carries `has_more` and
   * `next_cursor`; pass `next_cursor` back as `cursor` for the next page.
   * A value too large for the page is named in `omitted_keys` instead
   * (read it by `key`). Older servers return every entry and no paging
   * fields, and ignore `cursor`, `limit` and `maxChars`.
   *
   * @throws Error before any request if `cursor`, `limit` or `maxChars`
   *   is given together with `key`, or `limit` / `maxChars` is not an
   *   integer in range.
   */
  async getState(options: {
    contextId: string;
    /** The state key to read; omit to list the live entries. */
    key?: string;
    /**
     * List mode only: the `next_cursor` of the previous page. Sent only
     * when set (memory-cloud v0.82.0+).
     */
    cursor?: string;
    /**
     * List mode only: entries per page, 1-200 (the server's default is
     * 50). Checked before any request and sent only when set
     * (memory-cloud v0.82.0+).
     */
    limit?: number;
    /**
     * List mode only: the page's budget in characters, not tokens,
     * 10,000-100,000 (the server's default is 20,000). Checked before any
     * request and sent only when set (memory-cloud v0.82.0+).
     */
    maxChars?: number;
  }): Promise<ToolResult> {
    // `null` is unset, as Python's `None` is.
    const { cursor, limit, maxChars } = options;
    const given: Array<[string, unknown]> = [
      ["cursor", cursor],
      ["limit", limit],
      ["maxChars", maxChars],
    ];
    const sent = given.filter(([, value]) => isSet(value)).map(([name]) => name);
    if (isSet(options.key) && sent.length > 0) {
      // The Python SDK 0.44.0's ValueError text, which names each list-mode
      // argument given (`cursor, limit: …`): the server reads them in list
      // mode only, so with a key they would be dropped.
      throw new Error(`${sent.join(", ")}: list mode only; omit key to list the entries`);
    }
    const args: Record<string, unknown> = { context_id: options.contextId };
    if (isSet(options.key)) {
      args.key = options.key;
    }
    if (isSet(cursor)) {
      args.cursor = cursor;
    }
    if (isSet(limit)) {
      args.limit = validateIntRange("limit", limit, 1, STATE_LIST_MAX_LIMIT);
    }
    if (isSet(maxChars)) {
      args.max_chars = validateMaxChars(maxChars);
    }
    return this.callToolChecked("get_state", args);
  }

  // -------------------------------------------------------------------
  // Agent control plane (server v0.49.0+, RFC-0002; issues #1/#2/#3)
  // -------------------------------------------------------------------

  /**
   * Unwrap an object envelope (`agent`, `binding`, `report`, …) from a
   * tool result.
   *
   * Match the Python port's `result["<key>"]`: a missing envelope is a
   * contract violation, surfaced loudly rather than as a partial object.
   */
  private static expectEnvelope(
    result: ToolResult,
    key: string,
    operation: string,
  ): Record<string, unknown> {
    const envelope = result[key];
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
      throw new KaguraConnectionError(
        `Unexpected ${operation} response: missing '${key}' envelope.`,
      );
    }
    return envelope as Record<string, unknown>;
  }

  /**
   * Register an AI agent in the workspace Agent Registry.
   *
   * Calls the `register_agent` MCP tool (server v0.49.0+, RFC-0002 P0-1,
   * memory-cloud #1274) — owner/admin only. An agent is a
   * workspace-scoped registry entry (name unique per workspace) that
   * anchors context bindings, agent-bound credentials,
   * {@link getAgentBootstrap}, and audit correlation — it is a resource,
   * NOT a principal. New agents start with `status="active"` and
   * `enforcement_mode="enforce"`.
   *
   * Requires memory-cloud v0.49.0+ — older servers return an MCP
   * "tool not found" error. That predates {@link MIN_SERVER_VERSION}, so
   * any server {@link checkServerVersion} does not warn about has it.
   *
   * @throws KaguraError on name conflict, agent quota, or insufficient
   *   role (owner/admin required).
   */
  async registerAgent(options: RegisterAgentOptions): Promise<Agent> {
    const args: Record<string, unknown> = { name: options.name };
    if (options.description !== undefined) {
      args.description = options.description;
    }
    if (options.framework !== undefined) {
      args.framework = options.framework;
    }
    if (options.environment !== undefined) {
      args.environment = options.environment;
    }
    if (options.version !== undefined) {
      args.version = options.version;
    }
    const result = await this.callToolChecked("register_agent", args);
    return KaguraClient.expectEnvelope(result, "agent", "register_agent") as unknown as Agent;
  }

  /**
   * Fetch one registered agent by id (owner/admin only).
   *
   * @throws KaguraNotFoundError when the agent does not exist. The 404 is
   *   uniform (CWE-639) — nonexistent and not-yours are indistinguishable
   *   by design, so it does NOT prove the agent is absent.
   */
  async getAgent(agentId: string): Promise<Agent> {
    const result = await this.callToolChecked("get_agent", { agent_id: agentId });
    return KaguraClient.expectEnvelope(result, "agent", "get_agent") as unknown as Agent;
  }

  /**
   * List the workspace's registered agents, newest first (owner/admin
   * only).
   *
   * Since memory-cloud v0.82.0 (#1743) the tool returns 50 agents a page
   * with `has_more` / `next_cursor`; this method follows the cursor and
   * returns every agent, at most 50 pages (an older server answers in one
   * page). The cursor is an offset, so an agent registered or deleted
   * between two calls shifts the rows: an agent an earlier page returned
   * is dropped from a later one (each `id` once), but one deleted between
   * calls can make the next page skip an agent. Each row's `description`
   * is a 200-character preview there, with `description_truncated` set
   * when it was cut — {@link getAgent} returns it whole.
   *
   * @throws KaguraResponseError when a page says `has_more` without a
   *   `next_cursor` or repeats an earlier one, or the list is not complete
   *   after 50 pages.
   */
  async listAgents(): Promise<Agent[]> {
    return (await this.collectPages("list_agents", "agents")) as Agent[];
  }

  /**
   * Every row of a cursor-paged MCP list tool (memory-cloud v0.82.0+,
   * #1743), as Python's `_collect_pages` gathers them.
   *
   * The first call sends no paging argument, so an older server, which
   * pages nothing and sends no `has_more`, answers in one call. Each later
   * call sends only `cursor`, the `next_cursor` of the page before
   * ({@link iterPages}). A row whose `id` an earlier page already returned
   * is dropped (the first occurrence is kept).
   *
   * @throws KaguraResponseError labelled `tool` when `has_more` comes
   *   without a usable `next_cursor` or with one an earlier page already
   *   sent, or the list is not complete after 50 pages.
   */
  private async collectPages(tool: string, key: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    const returnedIds = new Set<unknown>();
    const pages = iterPages(tool, (cursor) => this.callToolChecked(tool, cursor === undefined ? {} : { cursor }));
    for await (const result of pages) {
      const items = Array.isArray(result[key]) ? (result[key] as unknown[]) : [];
      rows.push(...items.filter((row) => !returnedIds.has(rowId(row))));
      for (const row of items) {
        const id = rowId(row);
        if (id !== undefined) returnedIds.add(id);
      }
    }
    return rows;
  }

  /**
   * Update a registered agent, including lifecycle transitions
   * (owner/admin only).
   *
   * `status` is the **fail-closed kill switch**: `"suspended"` /
   * `"retired"` agents cause every key bound to them to be rejected at
   * verify time. Setting `enforcementMode` from `"enforce"` to
   * `"shadow"` is an audited privilege-widening event.
   *
   * Set-only wrapper: omitted fields are left untouched. The server's
   * null-clears-a-metadata-field semantics is not expressible through
   * this wrapper — clear fields via the web UI or the raw API.
   *
   * @throws Error when no update field is provided (the call would be an
   *   empty no-op request).
   */
  async updateAgent(options: UpdateAgentOptions): Promise<Agent> {
    const changes: Record<string, unknown> = {};
    if (options.name !== undefined) {
      changes.name = options.name;
    }
    if (options.description !== undefined) {
      changes.description = options.description;
    }
    if (options.framework !== undefined) {
      changes.framework = options.framework;
    }
    if (options.environment !== undefined) {
      changes.environment = options.environment;
    }
    if (options.version !== undefined) {
      changes.version = options.version;
    }
    if (options.status !== undefined) {
      changes.status = options.status;
    }
    if (options.enforcementMode !== undefined) {
      changes.enforcement_mode = options.enforcementMode;
    }
    if (Object.keys(changes).length === 0) {
      throw new Error("updateAgent requires at least one field to update");
    }
    const result = await this.callToolChecked("update_agent", {
      agent_id: options.agentId,
      ...changes,
    });
    return KaguraClient.expectEnvelope(result, "agent", "update_agent") as unknown as Agent;
  }

  /**
   * Hard-delete an Agent Registry row (owner/admin only). Returns true
   * once the server confirms deletion.
   *
   * Permanent, and cascades every API key bound to the agent
   * (fail-closed). Prefer `updateAgent({status: "retired"})` for
   * operational retirement.
   */
  async deleteAgent(agentId: string): Promise<boolean> {
    const result = await this.callToolChecked("delete_agent", { agent_id: agentId });
    return result.deleted === undefined ? true : Boolean(result.deleted);
  }

  /**
   * Build the omit-when-undefined binding scope trio shared by
   * {@link bindAgentContext} and {@link updateAgentBinding} — the port of
   * the Python SDK's `_binding_scope_payload`. To expose the per-memory
   * filters (server v0.51.0+), extend {@link AgentBindingScopeOptions} and
   * map the new fields here.
   */
  private static bindingScopeArgs(options: AgentBindingScopeOptions): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (options.canRead !== undefined) {
      args.can_read = options.canRead;
    }
    if (options.writePolicy !== undefined) {
      args.write_policy = options.writePolicy;
    }
    if (options.isDefault !== undefined) {
      args.is_default = options.isDefault;
    }
    return args;
  }

  /**
   * Bind an agent to a context — purely subtractive scoping.
   *
   * Calls the `bind_agent_context` MCP tool (server v0.49.0+, RFC-0002
   * P0-2, memory-cloud #1275) — owner/admin only. The effective
   * permission for an agent-bound request is the existing RBAC decision
   * ∩ binding. Under `enforcement_mode="enforce"`, contexts WITHOUT a
   * binding row are denied for the agent (default-deny); under
   * `"shadow"`, violations are only logged.
   *
   * @throws KaguraNotFoundError when the agent or context is not found.
   * @throws KaguraError on duplicate binding or other server-side error.
   */
  async bindAgentContext(options: BindAgentContextOptions): Promise<AgentBinding> {
    const result = await this.callToolChecked("bind_agent_context", {
      agent_id: options.agentId,
      context_id: options.contextId,
      ...KaguraClient.bindingScopeArgs(options),
    });
    return KaguraClient.expectEnvelope(result, "binding", "bind_agent_context") as unknown as AgentBinding;
  }

  /** List an agent's context bindings (owner/admin only). */
  async listAgentBindings(agentId: string): Promise<AgentBinding[]> {
    const result = await this.callToolChecked("list_agent_bindings", { agent_id: agentId });
    const bindings = result.bindings;
    return Array.isArray(bindings) ? (bindings as unknown as AgentBinding[]) : [];
  }

  /**
   * Update a binding's scoping fields (owner/admin only).
   *
   * `context_id` is immutable — {@link unbindAgentContext} and re-
   * {@link bindAgentContext} to re-target. Changes are audited with
   * old→new values.
   *
   * @throws Error when no scoping field is provided (the call would be
   *   an empty no-op request).
   */
  async updateAgentBinding(options: UpdateAgentBindingOptions): Promise<AgentBinding> {
    const changes = KaguraClient.bindingScopeArgs(options);
    if (Object.keys(changes).length === 0) {
      throw new Error(
        "updateAgentBinding requires at least one of canRead, writePolicy, or isDefault",
      );
    }
    const result = await this.callToolChecked("update_agent_binding", {
      agent_id: options.agentId,
      binding_id: options.bindingId,
      ...changes,
    });
    return KaguraClient.expectEnvelope(result, "binding", "update_agent_binding") as unknown as AgentBinding;
  }

  /**
   * Delete a binding — the agent loses that context (owner/admin only).
   * Returns true once the server confirms deletion.
   *
   * Under `enforcement_mode="enforce"` the agent's requests against the
   * unbound context are denied afterwards (uniform `context_not_found`).
   */
  async unbindAgentContext(options: { agentId: string; bindingId: string }): Promise<boolean> {
    const result = await this.callToolChecked("unbind_agent_context", {
      agent_id: options.agentId,
      binding_id: options.bindingId,
    });
    return result.deleted === undefined ? true : Boolean(result.deleted);
  }

  /**
   * Rehydrate an agent's cognitive state in one session-start call.
   *
   * Calls the `get_agent_bootstrap` MCP tool (server v0.49.0+, RFC-0002
   * P0-3, memory-cloud #1276). The server composes existing primitives —
   * context guide + pinned memories ({@link loadPinned}) + a trusted-only
   * {@link recall} (only when `query` is supplied) + upcoming time
   * memories ({@link recallUpcoming}) + the agent-state lane
   * ({@link getState}) — with bounds, ordering, and trust filtering
   * inherited from those standalone tools, not re-specified.
   *
   * Components are **fail-soft**: a failing component reports
   * `{"status": "error", ...}` under `components` while the rest still
   * return, with the top-level `degraded` flag set. Identity and
   * authorization failures are total and throw instead. A keyword-only
   * recall (see {@link recall}) sets the top-level flag too (server
   * v0.66.0+), along with `components.recall.degraded`; its
   * `degraded_reason` tells an impaired recall from a failed component.
   *
   * The REST companion (`POST /api/v1/agents/{agent_id}/bootstrap`) is
   * available via `AgentsClient` for API-key-only callers such as
   * agent-bound member keys.
   *
   * Since server v0.82.0 the reply is held to `maxChars` (default 20,000
   * characters): `context_summary_omitted: true` and a component's
   * `truncated: true` say what the budget took. Since v0.110.0 the recall
   * component's rows are {@link recall}'s `verbosity: "full"` rows without
   * `supersede_candidate` and without content.
   *
   * @throws Error if `maxChars` is not an integer in 10,000-100,000,
   *   before any request.
   * @throws KaguraNotFoundError when the agent or context is not found
   *   (uniform 404 — nonexistent and not-yours are indistinguishable by
   *   design).
   * @throws KaguraError on invalid arguments or other server-side error.
   */
  async getAgentBootstrap(options: GetAgentBootstrapOptions): Promise<AgentBootstrapResponse> {
    const result = await this.callToolChecked("get_agent_bootstrap", {
      agent_id: options.agentId,
      ...buildBootstrapPayload(options),
    });
    return result as unknown as AgentBootstrapResponse;
  }

  /**
   * List the contexts the caller can see, most recently used first.
   *
   * Since server v0.73.0 this is a slim name→id directory: each item is
   * `{id, name, is_private, is_locked, last_used_at}` and carries no
   * `summary` or `embedding_model` unless asked for. Narrow a large
   * workspace with `listContexts({ nameContains, includeDetails: true })`,
   * or read one context in full with {@link getContextInfo}.
   *
   * `count` is workspace quota usage, not the number returned — that is
   * `total`. When the caller can see no context at all, `hint` says how
   * to create one or get access.
   *
   * Since server v0.82.0 (memory-cloud#1743) the directory is paged: 100
   * contexts a page by default (20 with `includeDetails` and no
   * `nameContains`), or `limit`, and a page also stops at the server's
   * 20,000-character budget. That budget is fixed: `list_contexts`
   * declares no `max_chars`. `has_more` says more contexts follow; pass
   * `next_cursor` back as `cursor` for the next page, with the same
   * `nameContains`.
   *
   * The envelope's `limit` is the plan's context maximum, not the page
   * size option of the same name.
   *
   * @throws Error before any request if `limit` is not an integer in
   *   1-200, or is above 20 with `includeDetails` and no non-blank
   *   `nameContains` (the server refuses that page with
   *   `validation_error`).
   */
  async listContexts(options: ListContextsOptions = {}): Promise<ListContextsResponse> {
    const nameContains = normalizeNameContains(options.nameContains);
    let limit: number | undefined;
    if (isSet(options.limit)) {
      limit = validateIntRange("limit", options.limit, 1, LIST_CONTEXTS_MAX_LIMIT);
      if (detailsPageOverCap(options.includeDetails, nameContains, limit)) {
        throw new Error(
          "includeDetails returns full summaries: pass nameContains or a limit of at most " +
            `${LIST_CONTEXTS_DETAILS_MAX_LIMIT}, got ${limit}`,
        );
      }
    }
    const args: Record<string, unknown> = {};
    if (nameContains !== undefined) {
      args.name_contains = nameContains;
    }
    if (options.includeSummary) {
      args.include_summary = true;
    }
    if (options.includeDetails) {
      args.include_details = true;
    }
    if (options.includeStats) {
      args.include_stats = true;
    }
    if (isSet(options.cursor)) {
      args.cursor = options.cursor;
    }
    if (limit !== undefined) {
      args.limit = limit;
    }
    const result = await this.callToolChecked("list_contexts", args);
    return result as unknown as ListContextsResponse;
  }

  /**
   * List the tag vocabulary in a context with usage counts and recency.
   *
   * Call before remember() to reuse existing tag spellings, or before
   * recall() with tag filters. Requires memory-cloud server v0.15.4+.
   * A `withTags` drill-down is sent to the REST tags route rather than MCP
   * (see {@link ListTagsOptions.withTags}); the result has the same shape.
   *
   * @throws Error if `limit`, `minCount`, `prefix` or `withTags` is out of
   *   range, before any request.
   * @throws KaguraNotFoundError if the context does not exist or the caller
   *   cannot see it.
   */
  async listTags(options: ListTagsOptions): Promise<ListTagsResponse> {
    const limit = options.limit ?? 50;
    const minCount = options.minCount ?? 1;
    const prefix = options.prefix ?? "";
    if (limit < 1 || limit > 500) {
      throw new Error(`limit must be between 1 and 500, got ${limit}`);
    }
    if (minCount < 1 || minCount > 10_000) {
      throw new Error(`minCount must be between 1 and 10000, got ${minCount}`);
    }
    if (prefix.length > 200) {
      throw new Error(`prefix must be at most 200 characters, got ${prefix.length}`);
    }
    // Normalized as the server normalizes it, so the limits below judge the
    // list the server would. An empty drill-down matches everything
    // (`tags @> '{}'`), so it is the same as none.
    const withTags = (options.withTags ?? []).map((t) => t.trim()).filter((t) => t !== "");
    if (withTags.length > 50) {
      throw new Error(`withTags accepts at most 50 tags, got ${withTags.length}`);
    }
    // In code points, as the server's len() counts, not UTF-16 units.
    const tooLong = withTags.map((t) => [...t].length).find((n) => n > 200);
    if (tooLong !== undefined) {
      throw new Error(`each withTags value must be at most 200 characters, got ${tooLong}`);
    }
    const sort = options.sort ?? "count";

    if (withTags.length > 0) {
      // MCP list_tags has with_tags only from server v0.77.0
      // (memory-cloud#1669); an older one silently returns the whole
      // vocabulary (#47). REST until MIN_SERVER_VERSION >= 0.77.0.
      return this.listTagsViaRest(options.contextId, {
        limit,
        min_count: minCount,
        sort,
        prefix: prefix || undefined,
        with_tags: withTags,
      });
    }

    const args: Record<string, unknown> = {
      context_id: options.contextId,
      limit,
      min_count: minCount,
      sort,
    };
    if (prefix) {
      args.prefix = prefix;
    }
    const result = await this.callToolChecked("list_tags", args);
    this.rememberContextName(result);
    return result as unknown as ListTagsResponse;
  }

  /**
   * The `listTags` drill-down over `GET /api/v1/contexts/{id}/tags`,
   * reshaped to exactly what MCP `list_tags` returns: the route adds a
   * `sample_summary` (always null) but sends no `status`, and sends
   * `context_name` only from server v0.77.0.
   */
  private async listTagsViaRest(
    contextId: string,
    params: Record<string, unknown>,
  ): Promise<ListTagsResponse> {
    // One segment, so a caller's id cannot add segments to the request path.
    const body = await this.restGet<unknown>(
      `/api/v1/contexts/${contextSegment(contextId)}/tags`,
      params,
      { operation: "list_tags", notFoundCode: "context_not_found" },
    );
    const record =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const rawTags = record.tags;
    if (
      typeof record.context_id !== "string" ||
      !Array.isArray(rawTags) ||
      typeof record.total !== "number"
    ) {
      throw new KaguraConnectionError(
        "Unexpected list_tags response: missing 'context_id', 'tags' or 'total'.",
      );
    }
    const tags: TagInfo[] = rawTags.map((item: unknown) => {
      const tag = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
      if (typeof tag.tag !== "string" || typeof tag.count !== "number") {
        throw new KaguraConnectionError(
          "Unexpected list_tags response: a tag without 'tag' or 'count'.",
        );
      }
      return {
        tag: tag.tag,
        count: tag.count,
        last_used_at: typeof tag.last_used_at === "string" ? tag.last_used_at : null,
      };
    });
    // The name the route sends (server v0.77.0+), else the cache or one
    // MCP lookup, only after the REST call so its error is the one a
    // caller sees. An empty name falls back too, as Python's `or` does.
    let contextName: string;
    if (typeof record.context_name === "string" && record.context_name !== "") {
      contextName = record.context_name;
      this.contextNames.set(record.context_id.toLowerCase(), contextName);
    } else {
      contextName = await this.contextNameFor(record.context_id);
    }
    const result: ToolResult = {
      status: "success",
      context_id: record.context_id,
      context_name: contextName,
      tags,
      total: record.total,
    };
    return result as unknown as ListTagsResponse;
  }

  /**
   * A context's name, from the cache or from one `list_tags` call.
   *
   * `list_tags`, not `get_context_info`: it checks access exactly as the
   * REST tags route does, where `get_context_info` also applies an API
   * key's workspace scope and agent bindings and so can refuse a context
   * the route serves. It is also exempt from the MCP daily limit, and with
   * `limit: 1` it carries one tag.
   */
  private async contextNameFor(contextId: string): Promise<string> {
    const key = contextId.toLowerCase();
    const cached = this.contextNames.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const result = await this.callToolChecked("list_tags", { context_id: contextId, limit: 1 });
    const name = result.context_name;
    if (typeof name !== "string") {
      throw new KaguraConnectionError("Unexpected list_tags response: missing 'context_name'.");
    }
    this.contextNames.set(key, name);
    return name;
  }

  /** Keep the context name an MCP `list_tags` result carries. */
  private rememberContextName(result: ToolResult): void {
    if (typeof result.context_id === "string" && typeof result.context_name === "string") {
      this.contextNames.set(result.context_id.toLowerCase(), result.context_name);
    }
  }

  /**
   * Call tools/list to get available MCP tool definitions (names,
   * descriptions, parameter schemas): the view the MCP URL's query selects
   * (`core` for a bare URL on memory-cloud 0.93.0+).
   *
   * The result is read as the Python SDK's `ToolListResponse` reads it:
   * `tools` a list of objects, each passed through unread, and a result
   * without `tools` lists none.
   *
   * @throws KaguraResponseError The result is not a `tools/list` result —
   *   not an object (`"result": null`), or `tools` not a list of objects
   *   (operation `KaguraClient.get_tool_definitions`, Python's).
   */
  async getToolDefinitions(): Promise<Record<string, unknown>[]> {
    const result = await this.jsonRpcResult("tools/list", {});
    const r = new ResponseReader("KaguraClient.get_tool_definitions", "ToolListResponse");
    const listing = r.object(result);
    const tools =
      listing === null
        ? []
        : r.list(
            listing,
            "tools",
            (value, at) => {
              if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                return value as Record<string, unknown>;
              }
              r.issue(at, "Input should be a valid dictionary");
              return {};
            },
            { default: [] },
          );
    r.check();
    return tools;
  }

  /** Neural graph traversal from a seed memory. */
  async explore(options: {
    contextId: string;
    memoryId: string;
    /** Maximum traversal depth (1-5, default 2). */
    depth?: number;
    /** Minimum edge weight threshold (default 0.05). */
    minWeight?: number;
  }): Promise<ToolResult> {
    return this.callToolChecked("explore", {
      context_id: options.contextId,
      memory_id: options.memoryId,
      depth: options.depth ?? 2,
      min_weight: options.minWeight ?? 0.05,
    });
  }

  /**
   * Get full memory details. Memory data is in `result.memory`.
   */
  async reference(options: { contextId: string; memoryId: string }): Promise<ToolResult> {
    return this.callToolChecked("reference", {
      context_id: options.contextId,
      memory_id: options.memoryId,
    });
  }

  /**
   * Update an existing memory in-place (memoryId) or upsert by external
   * ID (externalId — requires summary, content, and type).
   *
   * Reject a `supersede_candidate` the server suggested with
   * `updateMemory({ memoryId, dismissSupersedeCandidate: true })`.
   *
   * @throws Error unless exactly one of memoryId/externalId is provided,
   *   if `dismissSupersedeCandidate` is combined with `externalId`, or if
   *   `tags` holds more than 50 tags or a tag longer than 100 characters
   *   — each before any request.
   */
  async updateMemory(options: UpdateMemoryOptions): Promise<ToolResult> {
    if (!options.memoryId && !options.externalId) {
      throw new Error("Provide exactly one of memoryId or externalId");
    }
    if (options.memoryId && options.externalId) {
      throw new Error("Provide exactly one of memoryId or externalId");
    }
    // The server rejects this pair too; an upsert replaces the memory, so
    // there is no stored suggestion left to dismiss. Tested for presence,
    // not truthiness, because `""` is still sent as external_id below.
    if (options.dismissSupersedeCandidate && options.externalId !== undefined) {
      throw new Error(
        "dismissSupersedeCandidate requires memoryId; an externalId upsert " +
          "replaces the memory and its suggestion",
      );
    }
    validateMemoryTags(options.tags);

    const args: Record<string, unknown> = { context_id: options.contextId };
    if (options.memoryId !== undefined) {
      args.memory_id = options.memoryId;
    }
    if (options.externalId !== undefined) {
      args.external_id = options.externalId;
    }
    if (options.summary !== undefined) {
      args.summary = options.summary;
    }
    if (options.content !== undefined) {
      args.content = options.content;
    }
    if (options.type !== undefined) {
      args.type = options.type;
    }
    if (options.importance !== undefined) {
      args.importance = options.importance;
    }
    if (options.tags !== undefined) {
      args.tags = options.tags;
    }
    if (options.contextSummary !== undefined) {
      args.context_summary = options.contextSummary;
    }
    if (options.details !== undefined) {
      args.details = options.details;
    }
    if (options.deliveryMode !== undefined) {
      args.delivery_mode = options.deliveryMode;
    }
    if (options.dismissSupersedeCandidate) {
      args.dismiss_supersede_candidate = true;
    }
    return this.callToolChecked("update_memory", args);
  }

  /**
   * Soft-delete memories by a specific memoryId, a list of memoryIds or a
   * search query. The rows are kept, but not restorable through the API,
   * until the deployment's cleanup window passes
   * (`CLEANUP_DELETED_MEMORIES_RETENTION_DAYS`, default 30 days; Sleep
   * retention can purge sooner, and `0` turns the sweep off).
   *
   * The silent skip is per target, for a caller who may write to the
   * workspace: a target that caller may not delete, or one already gone,
   * is skipped rather than refused. Since server v0.74.0 that includes
   * every tool guardrail when the caller is below context editor or on an
   * agent credential. Check `deleted_count`, which can be 0 even for an
   * explicit `memoryId`.
   *
   * A caller who may not write to the workspace at all is refused before
   * any target is looked at, so nothing is skipped silently for it.
   *
   * `memoryIds` (memory-cloud v0.117.0+, #2127) forgets 1-50 distinct ids
   * in one call, each exactly as `memoryId` would and committed on its
   * own, and returns a {@link ForgetBatchResult} with one row per id
   * (`deleted` / `skipped` / `error`). The ids share one time budget (the
   * server's `forget` timeout, v0.118.0+, #2191): an id it did not reach is
   * an `error` row with `error: "not_attempted"` — resend those. `k` is
   * not sent in this mode. An older server refuses the argument
   * (`invalid_argument`, v0.82.0+). Since memory-cloud v0.113.0 (#2044)
   * either reply adds `session_id` when the request has a session (for
   * {@link changesSince} / {@link rollbackSession}).
   *
   * @throws KaguraPermissionError for a workspace viewer, which has
   *   read-only access (`requiredRole: "member"`).
   * @throws Error before any request: neither `memoryId`, `query` nor
   *   `memoryIds` is provided; or `memoryIds` comes with `memoryId`,
   *   `query` or `k`, is not a list of 1-50 strings, holds an id that is
   *   not a UUID or the same id twice.
   * @throws KaguraError with `code` `"batch_failed"` when every one of
   *   `memoryIds` failed, the rows in `details.results`.
   * @throws KaguraResponseError when a `memoryIds` reply does not match
   *   the model (`operation` `"forget"`).
   */
  async forget(options: ForgetByIdsOptions): Promise<ForgetBatchResult>;
  async forget(options: ForgetOptions): Promise<ToolResult>;
  async forget(options: ForgetOptions | ForgetByIdsOptions): Promise<ToolResult | ForgetBatchResult>;
  async forget(options: ForgetOptions | ForgetByIdsOptions): Promise<ToolResult | ForgetBatchResult> {
    if (isSet(options.memoryIds)) {
      const label = (camel: string) => optionLabel(options, camel);
      if (options.memoryId || options.query) {
        throw new Error(`Provide exactly one of ${label("memoryId")}, ${label("memoryIds")} or query`);
      }
      if (isSet(options.k)) {
        throw new Error(`k applies to query mode only, not to ${label("memoryIds")}`);
      }
      const result = await this.callToolChecked("forget", {
        context_id: options.contextId,
        memory_ids: checkedMemoryIds(options.memoryIds, label("memoryIds")),
      });
      readModel(result, FORGET_BATCH_RESULT, "forget");
      return result as unknown as ForgetBatchResult;
    }
    if (!options.memoryId && !options.query) {
      throw new Error("Provide either memoryId or query");
    }
    const args: Record<string, unknown> = { context_id: options.contextId };
    if (options.memoryId) {
      args.memory_id = options.memoryId;
    }
    if (options.query) {
      args.query = options.query;
      args.k = options.k ?? 10;
    }
    return this.callToolChecked("forget", args);
  }

  /**
   * Create a new context in the current workspace.
   *
   * Checks the workspace's context limit first, with a one-row
   * {@link listContexts} page, and throws without calling `create_context`
   * when `can_create` is false — unless `limit` is 0, which is how the server reports that it could
   * not read the quota; `create_context` then decides.
   * That error comes from the SDK, not the server: it carries
   * `quotaType: "contexts"` with `current` / `limit`, but `gate` and the
   * plan fields stay `null` because `list_contexts` does not send them. A
   * `null` `requiredPlan` there means the plan is unknown, not that no plan
   * lifts the cap. The server's own refusal, which names the plan that
   * lifts it, only arrives when a concurrent create gets past the check.
   *
   * @throws KaguraQuotaError when the workspace context limit is reached.
   * @throws KaguraFeatureNotAvailableError for a shared context (`isPrivate: false`) on a
   *   plan without `shared_contexts` (server v0.75.0+).
   */
  async createContext(options: CreateContextOptions): Promise<ToolResult> {
    // Pre-check quota. Match the Python falsy check `not
    // contexts.get("can_create", True)` exactly: `dict.get` substitutes the
    // default ONLY when the key is absent, so a present null/0/""/false
    // (server schema drift, #183) must pass through and be negated as
    // "cannot create" — a nullish-coalescing `?? true` would wrongly treat
    // a present `null` as "can create". count / limit / can_create do not
    // depend on the page, so one row is enough (an older server ignores
    // `limit` and sends every context, as before).
    const contexts = await this.listContexts({ limit: 1 });
    const canCreate = "can_create" in contexts ? contexts.can_create : true;
    // `limit: 0` with `can_create: false` is how list_contexts reports a
    // failed quota lookup (every plan allows at least one context), so the
    // server's own check decides then, as in the Python SDK.
    if (!canCreate && contexts.limit !== 0) {
      // Coerce missing/null count/limit to "?" so schema drift never
      // produces "null/null" in the message; a real 0 is preserved.
      const count = contexts.count ?? null;
      const limit = contexts.limit ?? null;
      // The quotaType/current/limit the server's own refusal would carry.
      // Its gate and plan fields are not in list_contexts, so they stay
      // null: this is the SDK's inference, not the server's gate block.
      // The Python SDK keeps the same pre-check, with no plan fields either.
      throw new KaguraQuotaError(
        `Context limit reached (${count === null ? "?" : String(count)}/` +
          `${limit === null ? "?" : String(limit)}). ` +
          "Delete unused contexts or upgrade your plan.",
        null,
        {
          quotaType: "contexts",
          current: typeof count === "number" ? count : null,
          limit: typeof limit === "number" ? limit : null,
        },
      );
    }

    const args: Record<string, unknown> = {
      name: options.name,
      is_private: options.isPrivate ?? true,
    };
    if (options.displayName !== undefined) {
      args.display_name = options.displayName;
    }
    if (options.description !== undefined) {
      args.description = options.description;
    }
    if (options.summary !== undefined) {
      args.summary = options.summary;
    }
    if (options.usageGuide !== undefined) {
      args.usage_guide = options.usageGuide;
    }
    // `resourceId` is deliberately not sent: create_context does not read
    // it (#47). See CreateContextOptions.resourceId.
    if (options.embeddingModel !== undefined) {
      args.embedding_model = options.embeddingModel;
    }
    return this.callToolChecked("create_context", args);
  }

  /** Soft-delete a context and all its memories. */
  async deleteContext(contextId: string): Promise<ToolResult> {
    return this.callToolChecked("delete_context", { context_id: contextId });
  }

  /** Update an existing context's settings. */
  async updateContext(options: UpdateContextOptions): Promise<ToolResult> {
    const args: Record<string, unknown> = { context_id: options.contextId };
    if (options.displayName !== undefined) {
      args.display_name = options.displayName;
    }
    if (options.description !== undefined) {
      args.description = options.description;
    }
    if (options.summary !== undefined) {
      args.summary = options.summary;
    }
    if (options.usageGuide !== undefined) {
      args.usage_guide = options.usageGuide;
    }
    if (options.resourceId !== undefined) {
      args.resource_id = options.resourceId;
    }
    if (options.isPublic !== undefined) {
      args.is_public = options.isPublic;
    }
    if (options.isLocked !== undefined) {
      args.is_locked = options.isLocked;
    }
    return this.callToolChecked("update_context", args);
  }

  /**
   * Atomically create Context + Resource entity + ingestion token in a
   * single server-side transaction. The returned `token` is plaintext and
   * shown once.
   *
   * Plan-gated on the `resources` feature (server v0.68.0+): a plan
   * without it is refused with nothing created.
   *
   * The context is named `name`, or `resourceId` when `name` is omitted:
   * the server requires a name and refuses the call without one.
   *
   * @throws KaguraFeatureNotAvailableError when the plan lacks `resources`;
   *   `requiredPlanDisplay` names the plan that has it.
   * @throws KaguraQuotaError at the workspace's context or token cap.
   */
  async setupResource(options: SetupResourceOptions): Promise<ToolResult> {
    // `summary` is deliberately not sent: setup_resource has none (#47).
    // See SetupResourceOptions.summary.
    const args: Record<string, unknown> = {
      resource_id: options.resourceId,
      name: options.name ?? options.resourceId,
      quota_events_per_hour: options.quotaEventsPerHour ?? 1000,
    };
    if (options.description !== undefined) {
      args.description = options.description;
    }
    return this.callToolChecked("setup_resource", args);
  }

  /**
   * Merge memories from one context into another. Both contexts must use
   * the same embedding model and belong to the same workspace.
   *
   * @throws Error if sourceId and targetId are the same.
   */
  async mergeContexts(options: {
    sourceId: string;
    targetId: string;
    /** Soft-delete the source context after merge. */
    deleteSource?: boolean;
  }): Promise<ToolResult> {
    if (options.sourceId === options.targetId) {
      throw new Error("sourceId and targetId must be different");
    }
    const args: Record<string, unknown> = {
      source_context_id: options.sourceId,
      target_context_id: options.targetId,
    };
    if (options.deleteSource) {
      args.delete_source = true;
    }
    return this.callToolChecked("merge_contexts", args);
  }

  /**
   * List neural memory edges connected to a memory (outgoing and
   * incoming, deduplicated, heaviest first).
   *
   * Note: the server applies `limit` to outgoing AND incoming queries
   * independently, so the practical maximum returned is `2 * limit`
   * minus dedup overlap.
   *
   * Since memory-cloud v0.82.0 (#1743) each direction is cut at `limit`
   * edges (50 unless set, at most 200). The tool takes no cursor: when a
   * direction held more, its `outgoing_has_more` / `incoming_has_more`
   * flag is set, which this list cannot carry. When the cut came from the
   * server's default (no `limit`) or its 200 clamp, not from the `limit`
   * passed, the client logs a warning through
   * {@link KaguraClientOptions.warn} (default `console.warn`), as the
   * Python SDK logs one on its `kagura_memory` logger. Raise `limit` to get more of
   * them, or raise `minWeight` / narrow `edgeTypes` so the ones that
   * matter fit.
   */
  async listEdges(options: {
    contextId: string;
    memoryId: string;
    /**
     * Minimum edge weight (0.0-3.0, default 0.0). Always sent: since
     * memory-cloud v0.117.0 (#2127) the server's own default is 0.05,
     * which hides weak automatic edges, while this method keeps sending
     * `0.0` (every edge), as on every earlier server.
     */
    minWeight?: number;
    /** Restrict to these edge types; omit for all. */
    edgeTypes?: string[];
    /**
     * Maximum edges per direction (the server clamps it to 1-200). Omit
     * for the server's default: 50 per direction since v0.82.0, no limit
     * before.
     */
    limit?: number;
  }): Promise<Edge[]> {
    const args: Record<string, unknown> = {
      context_id: options.contextId,
      memory_id: options.memoryId,
      min_weight: options.minWeight ?? 0.0,
    };
    if (options.edgeTypes !== undefined) {
      args.edge_types = options.edgeTypes;
    }
    if (options.limit !== undefined) {
      args.limit = options.limit;
    }
    const result = await this.callToolChecked("list_edges", args);
    const edges = Array.isArray(result.edges) ? (result.edges as unknown as Edge[]) : [];
    const cut = (["outgoing", "incoming"] as const).filter((d) => result[`${d}_has_more`] === true);
    // A cut at the caller's own limit is what they asked for: warn only when
    // the server's default or its clamp made it.
    if (cut.length > 0 && (options.limit === undefined || options.limit > LIST_EDGES_MAX_LIMIT)) {
      this.warn(
        `list_edges returned ${edges.length} edges of memory ${options.memoryId}, but more ` +
          `${cut.join(" and ")} edges exist past the per-direction limit: raise limit (max 200), ` +
          "or narrow with min_weight / edge_types",
      );
    }
    return edges;
  }

  /**
   * Create or upsert a neural memory edge from source to target.
   *
   * The server uses `(user_id, source_id, target_id)` as a unique key
   * with max-weight UPSERT semantics — not a pure INSERT.
   *
   * @throws Error if sourceId === targetId (self-loops are rejected).
   */
  async createEdge(options: {
    contextId: string;
    sourceId: string;
    targetId: string;
    /** Edge type label (default "related_to"). */
    edgeType?: string;
    /** Edge weight in [0.0, 3.0] (default 0.5). */
    weight?: number;
    /** Edge confidence in [0.0, 1.0] (default 1.0). */
    confidence?: number;
  }): Promise<Edge> {
    if (options.sourceId === options.targetId) {
      throw new Error("sourceId and targetId must be different (self-loops are not allowed)");
    }
    const result = await this.callToolChecked("create_edge", {
      context_id: options.contextId,
      source_id: options.sourceId,
      target_id: options.targetId,
      edge_type: options.edgeType ?? "related_to",
      weight: options.weight ?? 0.5,
      confidence: options.confidence ?? 1.0,
    });
    return (result.edge ?? result) as unknown as Edge;
  }

  /**
   * Update an existing edge's weight and/or edge type, identified by the
   * `(sourceId, targetId)` pair. Omit a field to leave it unchanged.
   */
  async updateEdge(options: {
    contextId: string;
    sourceId: string;
    targetId: string;
    /** New edge weight in [0.0, 3.0]; omit to keep. */
    weight?: number;
    /** New edge type label; omit to keep. */
    edgeType?: string;
  }): Promise<Edge> {
    const args: Record<string, unknown> = {
      context_id: options.contextId,
      source_id: options.sourceId,
      target_id: options.targetId,
    };
    if (options.weight !== undefined) {
      args.weight = options.weight;
    }
    if (options.edgeType !== undefined) {
      args.edge_type = options.edgeType;
    }
    const result = await this.callToolChecked("update_edge", args);
    return (result.edge ?? result) as unknown as Edge;
  }

  /**
   * Delete the edge between sourceId and targetId. Returns true once the
   * server confirms deletion.
   */
  async deleteEdge(options: {
    contextId: string;
    sourceId: string;
    targetId: string;
  }): Promise<boolean> {
    const result = await this.callToolChecked("delete_edge", {
      context_id: options.contextId,
      source_id: options.sourceId,
      target_id: options.targetId,
    });
    // The server confirms a delete with {"status": "success"} and NO
    // "deleted" key; a missing edge raises above. So reaching here means
    // deletion was confirmed — the default true is load-bearing.
    return result.deleted === undefined ? true : Boolean(result.deleted);
  }

  /**
   * Get workspace usage and quota limits.
   *
   * `capacity_lock` is `null` unless the workspace is over its Free
   * capacity (memory-cloud v0.99.0+), and absent on older servers; while
   * it is set, search and saving throw {@link KaguraCapacityLockedError}.
   *
   * @throws KaguraResponseError when `capacity_lock` does not read as the
   *   Python SDK's `CapacityLock`.
   */
  async getUsage(): Promise<UsageInfo> {
    const result = await this.callToolChecked("get_usage", {});
    return readUsageInfo(result);
  }

  /** Get context information, usage guidelines, and search config. */
  async getContextInfo(options: {
    contextId: string;
    /** Include memory count breakdown (default true). */
    includeDetails?: boolean;
  }): Promise<ContextInfo> {
    const result = await this.callToolChecked("get_context_info", {
      context_id: options.contextId,
      include_details: options.includeDetails ?? true,
    });
    return result as unknown as ContextInfo;
  }

  /**
   * Update a context's search configuration: hybrid weights, reranker,
   * reinforce re-rank, and query routing. Weights must sum to 1.0
   * (±0.01). Requires owner or editor permission. Omitted fields keep
   * their current values.
   *
   * The result echoes the whole configuration after the update under
   * `config`. That is the only place the reinforce and routing fields
   * come back: {@link getContextInfo}'s `search_config` leaves them out.
   *
   * @throws KaguraPermissionError when the caller may not write to the
   *   context, and also when the context does not exist or the caller
   *   cannot see it: the server answers every access failure here with
   *   `permission_denied`, never `context_not_found`, and sends no
   *   `required_role`, so `requiredRole` is `null` whatever the cause.
   */
  async updateSearchConfig(
    options: UpdateSearchConfigOptions,
  ): Promise<ToolResult & { config: SearchConfig }> {
    const args: Record<string, unknown> = { context_id: options.contextId };
    if (options.semanticWeight !== undefined) {
      args.semantic_weight = options.semanticWeight;
    }
    if (options.bm25Weight !== undefined) {
      args.bm25_weight = options.bm25Weight;
    }
    if (options.fetchFactor !== undefined) {
      args.fetch_factor = options.fetchFactor;
    }
    if (options.useRerank !== undefined) {
      args.use_rerank = options.useRerank;
    }
    if (options.rerankerProvider !== undefined) {
      args.reranker_provider = options.rerankerProvider;
    }
    if (options.rerankerModel !== undefined) {
      args.reranker_model = options.rerankerModel;
    }
    if (options.reinforceEnabled !== undefined) {
      args.reinforce_enabled = options.reinforceEnabled;
    }
    if (options.reinforceMaxBoost !== undefined) {
      args.reinforce_max_boost = options.reinforceMaxBoost;
    }
    if (options.reinforceRequireHostArbitration !== undefined) {
      args.reinforce_require_host_arbitration = options.reinforceRequireHostArbitration;
    }
    if (options.routingMode !== undefined) {
      args.routing_mode = options.routingMode;
    }
    const result = await this.callToolChecked("update_search_config", args);
    return result as ToolResult & { config: SearchConfig };
  }

  /**
   * Get server name, version, environment, feature flags, and (server
   * v0.69.0+) the reranker defaults new contexts start with.
   *
   * @throws KaguraResponseError when the body is not a `ServerInfo` as the
   *   Python SDK reads it (operation `KaguraClient.get_server_info`).
   */
  async getServerInfo(): Promise<ServerInfo> {
    return this.restGetChecked<ServerInfo>("/api/v1/system/info", SERVER_INFO, "KaguraClient.get_server_info");
  }

  /**
   * Check the connected server's version against the SDK's tested
   * minimum. Advisory only: logs a warning and never throws on an old
   * version.
   *
   * A `v` prefix, build metadata and pre-release suffixes are read, so
   * `"v0.74.0"` and `"0.75.0-rc1"` (a pre-release of the minimum) both
   * warn. A version with no `MAJOR.MINOR.PATCH` at its start, such as
   * `"0.75"` or `"main-abc123"`, cannot be compared and does not warn. The
   * Python SDK reads it the same way.
   *
   * @throws KaguraResponseError, as {@link getServerInfo} does, when the
   *   body is not a `ServerInfo` (a version that is not a string included).
   */
  async checkServerVersion(): Promise<ServerInfo> {
    const info = await this.getServerInfo();
    warnBelowMinimum(info.version, this.warn);
    return info;
  }

  /**
   * Get embedding queue status for the workspace.
   *
   * @throws KaguraResponseError on a body the Python SDK's model refuses.
   */
  async getEmbeddingStatus(): Promise<EmbeddingStatus> {
    return this.restGetChecked<EmbeddingStatus>(
      "/api/v1/workspace/embedding-status",
      EMBEDDING_STATUS,
      "KaguraClient.get_embedding_status",
    );
  }

  /**
   * Get per-memory usage statistics for a context.
   *
   * @throws KaguraResponseError on a body the Python SDK's model refuses.
   */
  async getMemoryStats(options: {
    contextId: string;
    /**
     * Sort field (default `"access_count"`, the server's own default); see
     * {@link MemoryStatsSortField}. Server v0.34.0 (#1046) dropped
     * `use_count` and answers any field outside that set with HTTP 400.
     */
    sortBy?: MemoryStatsSortField | (string & {});
    /** "asc" or "desc" (default "desc"). */
    sortOrder?: "asc" | "desc";
    /** Maximum results (1-200, default 50). */
    limit?: number;
    offset?: number;
  }): Promise<MemoryStatsResponse> {
    return this.restGetChecked<MemoryStatsResponse>(
      `/api/v1/contexts/${contextSegment(options.contextId)}/memory-stats`,
      MEMORY_STATS_RESPONSE,
      "KaguraClient.get_memory_stats",
      {
        sort_by: options.sortBy ?? "access_count",
        sort_order: options.sortOrder ?? "desc",
        limit: options.limit ?? 50,
        offset: options.offset ?? 0,
      },
    );
  }

  /**
   * Find duplicate memory pairs in a context.
   *
   * @throws KaguraResponseError on a body the Python SDK's model refuses.
   */
  async findDuplicates(options: {
    contextId: string;
    /** Similarity threshold (0.5-1.0, default 0.90). */
    threshold?: number;
    /** Maximum pairs (1-200, default 50). */
    limit?: number;
  }): Promise<DuplicatesResponse> {
    return this.restGetChecked<DuplicatesResponse>(
      `/api/v1/contexts/${contextSegment(options.contextId)}/duplicates`,
      DUPLICATES_RESPONSE,
      "KaguraClient.find_duplicates",
      { threshold: options.threshold ?? 0.9, limit: options.limit ?? 50 },
    );
  }

  /**
   * List memories with optional substring, facet, time-window and
   * bounding-box filters. Without `contextId` this returns the caller's
   * own memories across all contexts. `q` matches summaries only — use
   * recall() for semantic search.
   *
   * The bbox (`latMin`, `latMax`, `lonMin`, `lonMax`; server v0.54.0+)
   * keeps only memories with a location, each item then carrying
   * `location`; `lonMin > lonMax` is the box across the antimeridian. An
   * older server ignores it and returns an unfiltered page.
   *
   * @throws Error before any request if a bbox bound is not a number or
   *   is out of range (±90 for a latitude, ±180 for a longitude), which
   *   the server would only answer with a 422 — the Python SDK's
   *   messages, with the option's name.
   */
  async listMemories(options: ListMemoriesOptions = {}): Promise<MemoryListResponse> {
    const params: Record<string, unknown> = {
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
    };
    if (options.contextId !== undefined) {
      params.context_id = options.contextId;
    }
    // Normalize like the server/frontend: strip and drop whitespace-only.
    const qNormalized = (options.q ?? "").trim();
    if (qNormalized) {
      params.q = qNormalized;
    }
    if (options.scope !== undefined) {
      params.scope = options.scope;
    }
    if (options.type !== undefined) {
      params.type = options.type;
    }
    if (options.triggerFrom !== undefined) {
      params.trigger_from = options.triggerFrom;
    }
    if (options.triggerUntil !== undefined) {
      params.trigger_until = options.triggerUntil;
    }
    if (options.orderBy !== undefined) {
      params.order_by = options.orderBy;
    }
    // `is not None`, as Python checks it: 0 (the equator, the prime
    // meridian) is a bound. Each bound is checked on its own; the pair
    // order is not, since lonMin > lonMax is the antimeridian box.
    for (const [label, key, bound, limit] of [
      ["latMin", "lat_min", options.latMin, 90],
      ["latMax", "lat_max", options.latMax, 90],
      ["lonMin", "lon_min", options.lonMin, 180],
      ["lonMax", "lon_max", options.lonMax, 180],
    ] as const) {
      if (isSet(bound)) {
        validateBound(label, bound, limit);
        params[key] = bound;
      }
    }
    return this.restGet<MemoryListResponse>("/api/v1/memory/list", params);
  }

  /**
   * List recent Sleep Maintenance runs for a context, newest first.
   *
   * Since memory-cloud v0.138.0 (#2219) the tool lists Sleep runs only
   * (`source: "sleep"`) unless `source` says otherwise, and each row
   * carries `source`. Older servers have no filter, may list the rows
   * Memory Analysis writes for its LLM spend among the Sleep runs, and
   * send no `source`.
   */
  async getSleepHistory(options: {
    contextId: string;
    /** Maximum runs (server clamps to 1-50, default 10). */
    limit?: number;
    /**
     * `"sleep"` (Sleep runs, the server's default), `"analysis"` (Memory
     * Analysis spend rows) or `"all"`. Sent only when set (memory-cloud
     * v0.138.0+).
     */
    source?: "sleep" | "analysis" | "all";
  }): Promise<SleepReport[]> {
    const args: Record<string, unknown> = {
      context_id: options.contextId,
      limit: options.limit ?? 10,
    };
    if (options.source !== undefined) {
      args.source = options.source;
    }
    const result = await this.callToolChecked("get_sleep_history", args);
    // Match Python's `result["reports"]`: a missing/malformed key is a
    // contract violation, surfaced loudly rather than as an empty success.
    const reports = result.reports;
    if (!Array.isArray(reports)) {
      throw new KaguraConnectionError(
        "Unexpected get_sleep_history response: missing 'reports' array.",
      );
    }
    return reports as unknown as SleepReport[];
  }

  /**
   * Get a detailed Sleep Maintenance report including the per-action
   * audit log.
   *
   * `context_id` is never sent: besides `report_id`, only the paging
   * options below go out, each only when set. No memory-cloud release
   * declares or reads a `context_id` on `get_sleep_report`, and from
   * v0.82.0 (memory-cloud#1742) the server refuses an argument a tool's
   * schema does not declare, so SDKs up to 0.14.1, which sent one, failed
   * every call there with `invalid_argument` (#79). The server finds the
   * run by `report_id` and, from v0.126.0 (memory-cloud#2315), authorizes
   * the call against the report's own context: read access there is
   * enough.
   *
   * Since memory-cloud v0.82.0 (#1743) `actions` is one page of the run's
   * actions in id order, 50 by default, within a 20,000-character budget:
   * `action_count` is the run's total, and while `actions_has_more` is
   * `true` pass `actions_next_cursor` back as `actionsCursor` for the next
   * page. An action too large for its page comes with `details_omitted`
   * instead of `details`. Older servers send every action at once. An
   * analysis report (`source: "analysis"`) carries a `note` (v0.140.0+,
   * #2547): it records Memory Analysis spend and has no Sleep actions.
   *
   * @throws KaguraNotFoundError when the report does not exist, is not the
   *   caller's, or (memory-cloud v0.126.0+) belongs to a context the caller
   *   cannot read: the server answers `report_not_found` for each.
   */
  async getSleepReport(options: {
    /**
     * Ignored, and optional: the server finds the run by `reportId`. It
     * was required up to 0.14.1, so calls that pass it still compile.
     */
    contextId?: string;
    /** Sleep report UUID, from {@link getSleepHistory}. */
    reportId: string;
    /** The `actions_next_cursor` of the previous page (memory-cloud v0.82.0+). */
    actionsCursor?: string;
    /** Actions per page; the server clamps it to 1-200, default 50 (v0.82.0+). */
    actionsLimit?: number;
    /**
     * Response budget in characters, not tokens: 10,000 to 100,000,
     * default 20,000; the server refuses other values with
     * `validation_error` (v0.82.0+).
     */
    maxChars?: number;
  }): Promise<SleepReportDetail> {
    const args: Record<string, unknown> = { report_id: options.reportId };
    if (options.actionsCursor !== undefined) {
      args.actions_cursor = options.actionsCursor;
    }
    if (options.actionsLimit !== undefined) {
      args.actions_limit = options.actionsLimit;
    }
    if (options.maxChars !== undefined) {
      args.max_chars = options.maxChars;
    }
    const result = await this.callToolChecked("get_sleep_report", args);
    // The MCP tool wraps the report fields under a "report" key; flatten
    // so SleepReportDetail reads naturally without an extra `.report.`,
    // with the envelope's action page and paging keys where it sent them.
    const report = KaguraClient.expectEnvelope(result, "report", "get_sleep_report");
    const envelope = SLEEP_REPORT_ENVELOPE_KEYS.filter((key) =>
      Object.prototype.hasOwnProperty.call(result, key),
    ).map((key) => [key, result[key]] as const);
    return { ...report, ...Object.fromEntries(envelope) } as unknown as SleepReportDetail;
  }

  /**
   * Reverse the effects of a `completed` or `degraded` Sleep Maintenance
   * run; any other status is refused. The server processes actions in
   * reverse order with per-step commits — a partial failure means SOME
   * actions may have been reversed before the error.
   *
   * A partial rollback throws {@link KaguraPartialRollbackError} rather
   * than returning, and its `summary` is the {@link RollbackSummary} a
   * clean run would have returned: the counts say what was reversed, and
   * `summary.errors` names each action that was not (a merge a later write
   * changed is counted in `merges_unreversible` and listed there too). The
   * reversed steps stay committed and the report is marked `failed`.
   *
   * There is no retry: the server rolls back only a `completed` or
   * `degraded` report, so calling this again on a `failed` one is refused
   * with a plain {@link KaguraError} (`invalid_status`). The actions in
   * `err.summary.errors` stay unreversed and need handling some other way.
   *
   * Only `report_id` is sent, as for {@link getSleepReport} (#79). The
   * server finds the run by `report_id` and, from memory-cloud v0.126.0
   * (memory-cloud#2315), authorizes the rollback against the report's own
   * context: it needs the editor or owner role there, and a workspace
   * viewer cannot roll back.
   *
   * @throws KaguraPartialRollbackError when some actions could not be
   *   reversed.
   * @throws KaguraNotFoundError when the report does not exist, is not the
   *   caller's, or (memory-cloud v0.126.0+) belongs to a context the caller
   *   cannot read: the server answers `report_not_found` for each.
   * @throws KaguraPermissionError (`permission_denied`, v0.126.0+) when the
   *   caller can read the report's context but not edit it.
   * @throws KaguraError (`analysis_report`, v0.140.0+, memory-cloud#2547)
   *   for a Memory Analysis report (`source: "analysis"`): it records the
   *   LLM spend of an analysis run and has no Sleep actions to reverse.
   */
  async rollbackSleepRun(options: {
    /**
     * Ignored, and optional: the server finds the run by `reportId`. It
     * was required up to 0.14.1, so calls that pass it still compile.
     */
    contextId?: string;
    /** Sleep report UUID to roll back, from {@link getSleepHistory}. */
    reportId: string;
  }): Promise<RollbackResult> {
    const result = await this.callToolChecked("rollback_sleep_run", {
      report_id: options.reportId,
    });
    return result as unknown as RollbackResult;
  }

  /**
   * List available embedding models with provider info and availability.
   *
   * @throws KaguraResponseError on a body the Python SDK's model refuses.
   */
  async listEmbeddingModels(): Promise<EmbeddingModelsResponse> {
    return this.restGetChecked<EmbeddingModelsResponse>(
      "/api/v1/system/embedding/models",
      EMBEDDING_MODELS_RESPONSE,
      "KaguraClient.list_embedding_models",
    );
  }

  // -------------------------------------------------------------------------
  // Session tools (memory-cloud v0.93.0+, SDK issue #86)
  // -------------------------------------------------------------------------

  /**
   * Open an interactive session on one context in one call.
   *
   * Calls the `bootstrap` MCP tool (memory-cloud v0.93.0+, #1851): the
   * context block, its tool `guardrails`, the trusted pinned set (cap 20),
   * the upcoming Time Memories (k = 20) and the change log since `since`
   * (at most 50), each bounded and **fail-soft** — a failing lane is
   * `status: "error"` while the rest return, with `degraded` set.
   * Deterministic: no recall runs; search by topic with {@link recall} if
   * the change list does not answer the question. Not
   * {@link getAgentBootstrap}, which rehydrates a registered agent.
   *
   * The memory-cloud session-start skill calls it as
   * `bootstrap({ contextId, since: "7d", format: "index", maxChars: 5000 })`.
   *
   * Every option is sent only when set. The reply is returned as sent,
   * once the Python SDK's `BootstrapResponse` model accepts it, with one
   * exception: a `guardrails` block that model cannot read is `null`, as
   * Python reads it. Since memory-cloud v0.142.0 (#2615) `plan_headroom`
   * lists every plan dimension at 80 % or more of its limit.
   *
   * @throws Error before any request: `maxChars` is not an integer in
   *   [2,000, 100,000], `format` is not `"full"` / `"index"`,
   *   `format: "full"` comes with `maxChars` below 10,000, `include` is
   *   empty, not a list of strings or names an unknown lane, or `since` is
   *   an invalid `Date`.
   * @throws KaguraNotFoundError when the context does not exist or is not
   *   accessible.
   * @throws KaguraError for another refusal, e.g. a malformed `since`
   *   (`validation_error`).
   * @throws KaguraResponseError when the reply does not match the model
   *   (`operation` `"bootstrap"`).
   */
  async bootstrap(options: BootstrapOptions): Promise<BootstrapResponse> {
    const args: Record<string, unknown> = { context_id: options.contextId };
    if (isSet(options.since)) {
      args.since = isoArg(options.since, "since");
    }
    if (isSet(options.include)) {
      args.include = checkedBootstrapInclude(options.include);
    }
    const { maxChars, format } = options;
    const maxCharsName = optionLabel(options, "maxChars");
    if (isSet(maxChars)) {
      args.max_chars = validateIntRange(maxCharsName, maxChars, BOOTSTRAP_MIN_CHARS, MAX_CHARS_MAX);
    }
    if (isSet(format)) {
      if (!(BOOTSTRAP_FORMATS as readonly unknown[]).includes(format)) {
        throw new Error(`format must be 'full' or 'index', got ${pyRepr(format)}`);
      }
      if (format === "full" && isSet(maxChars) && maxChars < MAX_CHARS_MIN) {
        throw new Error(
          `format="full" needs ${maxCharsName} of at least ${MAX_CHARS_MIN}; ` +
            'pass format="index" (or omit format) under it',
        );
      }
      args.format = format;
    }
    const result = await this.callToolChecked("bootstrap", args);
    const read = readModel(result, BOOTSTRAP_RESPONSE, "bootstrap");
    // Fail-open, as Python's model reads the block: unreadable is null.
    // Absent (`?guardrails=off`) stays absent.
    if (read.guardrails === null && isSet(result.guardrails)) {
      return { ...result, guardrails: null } as unknown as BootstrapResponse;
    }
    return result as unknown as BootstrapResponse;
  }

  /**
   * List what changed in a context since a time, oldest first.
   *
   * Calls the `changes_since` MCP tool (memory-cloud v0.93.0+, #1852): a
   * deterministic memory-level change log — `created`, `updated` (Sleep
   * maintenance included), `superseded` (with `superseded_by`) and
   * `forgotten` events — keyset-paged. A soft delete logs `forgotten` only
   * (v0.98.0+, #1924), and every event of a memory that is forgotten now
   * has no `summary` (v0.96.0+, #1876). With `sessionId` (v0.113.0+) or
   * `byMe` (v0.114.0+) the log is the revision lane, where `restored` is a
   * kind too. No ranking, no embedding, no Hebbian write. In a private
   * context only the caller's own memories (and a linked account's) are
   * listed. Every option is sent only when set; from memory-cloud v0.82.0 a
   * server older than an option's floor refuses it (`invalid_argument`).
   *
   * Call again with `cursor: result.next_cursor` while `result.has_more`.
   *
   * @throws Error before any request: `maxChars` is out of range, `kinds`
   *   is not a list of strings, or `since` / `until` is an invalid `Date`.
   * @throws KaguraNotFoundError when the context does not exist or is not
   *   accessible.
   * @throws KaguraError for another refusal (`validation_error`: a
   *   malformed time, `until` not after `since`, a bad `kinds` /
   *   `session_id` / `cursor`).
   * @throws KaguraResponseError when the reply does not match the model
   *   (`operation` `"changes_since"`).
   */
  async changesSince(options: ChangesSinceOptions): Promise<ChangesSinceResponse> {
    const args: Record<string, unknown> = {
      context_id: options.contextId,
      since: isoArg(options.since, "since"),
    };
    if (isSet(options.until)) {
      args.until = isoArg(options.until, "until");
    }
    if (isSet(options.kinds)) {
      args.kinds = strList("kinds", options.kinds);
    }
    if (isSet(options.cursor)) {
      args.cursor = options.cursor;
    }
    if (isSet(options.limit)) {
      args.limit = options.limit;
    }
    if (isSet(options.sessionId)) {
      args.session_id = options.sessionId;
    }
    if (isSet(options.byMe)) {
      args.by_me = options.byMe;
    }
    if (isSet(options.maxChars)) {
      args.max_chars = validateMaxChars(options.maxChars);
    }
    const result = await this.callToolChecked("changes_since", args);
    readModel(result, CHANGES_SINCE_RESPONSE, "changes_since");
    return result as unknown as ChangesSinceResponse;
  }

  /**
   * List every live memory of a context that matches exact filters.
   *
   * Calls the `list` MCP tool (memory-cloud v0.93.0+, #1852): no ranking,
   * a stable order and a `total`, e.g. the open backlog
   * `filters: { type: ["tech-debt"], tags: ["status:open"] }` or
   * `{ type: "task", "details.status": "open" }`. Use {@link recall} for
   * meaning.
   *
   * {@link listMemories} is a different call: REST `GET
   * /api/v1/memory/list`, with a summary substring (`q`), a trigger window,
   * a bounding box and the cross-context "my memories" view. This method is
   * MCP and takes `recall`'s exact filter vocabulary plus `details.<key>`
   * equality, orders by `updated_at` / `created_at` / `importance` /
   * `observed_at` and pages with a cursor. In a private context both list
   * only the caller's own memories.
   *
   * Call again with `cursor: result.next_cursor` while `result.has_more`.
   *
   * @throws Error if `maxChars` is out of range, before any request.
   * @throws KaguraNotFoundError when the context does not exist or is not
   *   accessible.
   * @throws KaguraError for another refusal (`validation_error`: an
   *   unknown filter, `order_by` or `direction`).
   * @throws KaguraResponseError when the reply does not match the model
   *   (`operation` `"list"`).
   */
  async listMatching(options: ListMatchingOptions): Promise<ListMatchingResponse> {
    const args: Record<string, unknown> = { context_id: options.contextId };
    if (isSet(options.filters)) {
      args.filters = options.filters;
    }
    if (isSet(options.orderBy)) {
      args.order_by = options.orderBy;
    }
    if (isSet(options.direction)) {
      args.direction = options.direction;
    }
    if (isSet(options.cursor)) {
      args.cursor = options.cursor;
    }
    if (isSet(options.limit)) {
      args.limit = options.limit;
    }
    if (options.includeDetails) {
      args.include_details = true;
    }
    if (isSet(options.maxChars)) {
      args.max_chars = validateMaxChars(options.maxChars);
    }
    const result = await this.callToolChecked("list", args);
    readModel(result, LIST_MATCHING_RESPONSE, "list");
    return result as unknown as ListMatchingResponse;
  }

  /**
   * Store up to 50 memories in one call.
   *
   * Calls the `remember_batch` MCP tool (memory-cloud v0.93.0+, #1853).
   * Each item is validated and limited like a single {@link remember}.
   * Without `atomic` each item is written and reported on its own; with
   * `atomic: true` the batch is one transaction — a failing item, or a
   * `dedupe: "check"` candidate, rolls everything back and the other items
   * come back `skipped`. Items go out as given, by their wire names (see
   * {@link RememberBatchItem}); the batch options are sent only when set.
   *
   * Check `failed` / `candidates` / `skipped` and each row's `status`; on
   * `committed_after_timeout` every item is stored — do not resend.
   *
   * @throws Error before any request: `items` is not a list of 1-50
   *   objects, an item carries `dedupe`, `tags_normalize` or `verbose`
   *   (batch-level here) or a `context_id` other than the batch's, or an
   *   item's `tags` break the 50-tag / 100-character cap.
   * @throws KaguraQuotaError when an atomic batch did not fit the daily
   *   quota (`quota_exceeded`; nothing was written, a smaller batch may
   *   fit).
   * @throws KaguraCapacityLockedError when the workspace is over its Free
   *   capacity.
   * @throws KaguraError when nothing was written: `code` `"batch_failed"`
   *   (every item failed) or `"batch_refused"` (an atomic batch with an
   *   invalid item) carries the per-item rows in `details.results`; a
   *   `dedupe_unavailable` item (the duplicate check is down) is such a row
   *   — retry it or send `dedupe: "off"`. `"timeout"` (an atomic batch
   *   rolled back at its time limit) carries no rows: send fewer items, or
   *   drop `atomic`.
   * @throws KaguraResponseError when the reply does not match the model
   *   (`operation` `"remember_batch"`).
   */
  async rememberBatch(options: RememberBatchOptions): Promise<RememberBatchResult> {
    const args: Record<string, unknown> = {
      context_id: options.contextId,
      items: checkedBatchItems(options.items, options.contextId),
    };
    if (isSet(options.atomic)) {
      args.atomic = options.atomic;
    }
    if (isSet(options.dedupe)) {
      args.dedupe = options.dedupe;
    }
    if (isSet(options.tagsNormalize)) {
      args.tags_normalize = options.tagsNormalize;
    }
    if (isSet(options.verbose)) {
      args.verbose = options.verbose;
    }
    const result = await this.callToolChecked("remember_batch", args);
    readModel(result, REMEMBER_BATCH_RESULT, "remember_batch");
    return result as unknown as RememberBatchResult;
  }

  /**
   * Find the tools this MCP URL's `tools/list` leaves out.
   *
   * Calls the `describe_tools` MCP tool (memory-cloud v0.93.0+, #1849). A
   * profile only shapes `tools/list`: this client can call every tool, but
   * a model behind a mainstream MCP client can call listed tools only, so
   * the reply says which URL query lists more.
   *
   * @throws Error if `names` is not a list of strings or holds more than
   *   20 names, before any request.
   * @throws KaguraResponseError when the reply does not match the model
   *   (`operation` `"describe_tools"`).
   */
  async describeTools(options: DescribeToolsOptions = {}): Promise<ToolDescriptions> {
    const args: Record<string, unknown> = {};
    if (isSet(options.query)) {
      args.query = options.query;
    }
    if (isSet(options.names)) {
      args.names = checkedNames("names", options.names, DESCRIBE_MAX_NAMES);
    }
    const result = await this.callToolChecked("describe_tools", args);
    readModel(result, TOOL_DESCRIPTIONS, "describe_tools");
    return result as unknown as ToolDescriptions;
  }

  /**
   * Read sections of the server's tool manual.
   *
   * Calls the `guide` MCP tool (memory-cloud v0.93.0+, #1850): the
   * walkthroughs the short tool descriptions leave out — how to read a
   * reply, when to pick one tool over another, the write rules. A caller
   * error's `help` often names a topic (`'Manual: guide(["<tool>"])'`).
   * Static text, nothing caller-specific.
   *
   * @param topics Up to 20 tool names (`"recall"`) or `"<tool>.<section>"`
   *   topics. Omit for the server's `["index"]`, which lists them all.
   *   Unknown names come back in `unknown`, not thrown.
   * @throws Error if `topics` is not a list of strings or holds more than
   *   20 names, before any request.
   * @throws KaguraResponseError when the reply does not match the model
   *   (`operation` `"guide"`).
   */
  async guide(topics?: readonly string[]): Promise<GuideResponse> {
    const args: Record<string, unknown> = {};
    if (isSet(topics)) {
      args.topics = checkedNames("topics", topics, GUIDE_MAX_TOPICS);
    }
    const result = await this.callToolChecked("guide", args);
    readModel(result, GUIDE_RESPONSE, "guide");
    return result as unknown as GuideResponse;
  }

  /**
   * Read one memory's revision log, newest first.
   *
   * Calls the `list_revisions` MCP tool (memory-cloud v0.113.0+, #2043):
   * one row per `created` / `updated` (with the fields it changed) /
   * `forgotten` / `restored` event, each with the version after it. Same
   * permission as {@link reference}; a forgotten memory's log is
   * unreadable (`memory_not_found`).
   *
   * @throws Error if `maxChars` is out of range, before any request.
   * @throws KaguraNotFoundError when the memory or context does not exist,
   *   is not accessible, or the memory is forgotten.
   * @throws KaguraResponseError when the reply does not match the model
   *   (`operation` `"list_revisions"`).
   */
  async listRevisions(options: ListRevisionsOptions): Promise<RevisionsPage> {
    const args: Record<string, unknown> = {
      context_id: options.contextId,
      memory_id: options.memoryId,
    };
    if (isSet(options.limit)) {
      args.limit = options.limit;
    }
    if (isSet(options.cursor)) {
      args.cursor = options.cursor;
    }
    if (isSet(options.maxChars)) {
      args.max_chars = validateMaxChars(options.maxChars);
    }
    const result = await this.callToolChecked("list_revisions", args);
    readModel(result, REVISIONS_PAGE, "list_revisions");
    return result as unknown as RevisionsPage;
  }

  /**
   * Plan or undo what one session — or the caller in a window — wrote.
   *
   * Calls the `rollback_session` MCP tool (memory-cloud v0.113.0+, #2044).
   * **Destructive with** `dryRun: false`: per memory, one the session
   * created is forgotten, one it edited gets the values from before its
   * first edit back (a new version), one it forgot is restored and
   * re-embedded. A memory someone else changed since, Sleep merged, a
   * resource row or one the caller may not write (`not_permitted`,
   * v0.134.0+, #2432) is skipped with a cause, never half-reverted. Only
   * the caller's own writes (same user or a linked account, same agent
   * credential); a context owner may name any session. Needs the context
   * editor role. A call handles at most 500 events (100 restores):
   * `status: "in_progress"` with `remaining > 0` means call again with the
   * same arguments. Once complete, further calls are refused
   * (`already_rolled_back`) until new writes land.
   *
   * `dry_run` is always sent, `true` unless `dryRun: false`, so the
   * plan-only default never depends on the server's. `since` / `until`
   * need memory-cloud v0.114.0+ (#2121).
   *
   * @throws Error before any request: neither or both of `sessionId` and
   *   `since` are given, `until` comes without `since`, or a `Date` is
   *   invalid.
   * @throws KaguraNotFoundError for `session_not_found` (no session with
   *   this id the caller may roll back in this context), or a context that
   *   is not accessible.
   * @throws KaguraPartialSessionRollbackError when some items failed this
   *   call; every other item was handled and saved. `sessionSummary` lists
   *   the failures in `errors`; `totals`, `rollbackId` and `remaining` come
   *   with it. Call again with the same arguments to retry the failed
   *   items.
   * @throws KaguraPermissionError for `permission_denied` (below editor).
   * @throws KaguraError with `code` `no_writes_in_window`,
   *   `already_rolled_back` or `validation_error` (e.g. a window wider than
   *   7 days).
   * @throws KaguraResponseError when the reply does not match the model
   *   (`operation` `"rollback_session"`).
   */
  async rollbackSession(options: RollbackSessionOptions): Promise<SessionRollbackResult> {
    const bySession = isSet(options.sessionId);
    const bySince = isSet(options.since);
    if (bySession === bySince) {
      throw new Error("Provide exactly one of sessionId or since");
    }
    if (isSet(options.until) && !bySince) {
      throw new Error("until needs since");
    }
    const args: Record<string, unknown> = {
      context_id: options.contextId,
      dry_run: options.dryRun ?? true,
    };
    if (bySession) {
      args.session_id = options.sessionId;
    }
    if (isSet(options.since)) {
      args.since = isoArg(options.since, "since");
    }
    if (isSet(options.until)) {
      args.until = isoArg(options.until, "until");
    }
    const result = await this.callTool("rollback_session", args);
    if (result.status === "error" && result.error === "partial_rollback") {
      throw partialSessionRollbackError(result);
    }
    KaguraClient.raiseForMcpError(result, "rollback_session");
    readModel(result, SESSION_ROLLBACK_RESULT, "rollback_session");
    return result as unknown as SessionRollbackResult;
  }

  /** Release resources. (fetch has no persistent connection to close; kept for API parity.) */
  async close(): Promise<void> {
    this.sessionEpoch++;
    this.sessionId = null;
    this.sessionOpening = null;
  }
}
