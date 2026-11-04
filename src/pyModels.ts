/**
 * The Python SDK's response models (`models.py`), declared as data, and a
 * reader that validates a payload the way pydantic validates it (#66).
 *
 * A model is its fields in declaration order, each with its type and its
 * default. {@link readModel} reads a payload through one: the model's keys
 * in its order, defaults filled for the keys the server left out, unknown
 * keys dropped, and each value as the model's type makes it (an int field
 * sent as `"12"` reads `12`, a float field reads as a {@link PyFloat}). A
 * payload the model refuses is Python's `KaguraResponseError`, naming the
 * fields in pydantic's words and never their values.
 *
 * A timestamp is read and rewritten as pydantic does it
 * (`pydanticDatetime.ts`): `2026-06-01T09:00:00.5+00:00` reads
 * `2026-06-01T09:00:00.500000Z`. memory-cloud already writes that form, so
 * its timestamps pass through unchanged.
 *
 * A payload read by `parseJsonLossless` (`losslessJson.ts`) keeps its
 * number literals, and the readers see them as pydantic sees what
 * `json.loads` made of them (#69): an int field sent `9007199254740993`
 * reads exactly, `1e20` there is refused (`Unable to parse input string as
 * an integer, exceeded maximum size`), and a float field sent `-0` reads
 * `0.0`. An untyped mapping keeps the literals and the key order for the
 * dump (`cli/modelDump.ts`).
 *
 * Internal: for the SDK's own checks and the CLI's dumps
 * (`cli/modelDump.ts`), not exported from the package entry point.
 */

import { JsonNumber, jsonValue, orderedEntries, valueAt } from "./losslessJson.js";
import { pydanticDatetime } from "./pydanticDatetime.js";
import { hasLoneSurrogate, STRING_UNICODE } from "./pydanticNumber.js";
import {
  intOrStr,
  laxBool,
  laxExactInt,
  laxFloat,
  laxStr,
  ResponseReader,
  type Coerced,
  type Loc,
} from "./responseShape.js";

/**
 * The `dict[str, Any]` values {@link readModel} has read: pydantic writes
 * them by inference, under a nesting limit `formatModelJson` keeps.
 */
export const UNTYPED = new WeakSet<object>();

/**
 * A value read from a `float` field, so it prints as one: `1.0`, where a
 * JavaScript number that happens to be whole would print `1`. `toJSON`
 * keeps it a plain number for any other serializer.
 */
export class PyFloat {
  constructor(readonly value: number) {}

  toJSON(): number {
    return this.value;
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** A field's type, as its pydantic annotation declares it. */
export type Kind =
  | "str"
  | "int"
  /**
   * `int | str`, as pydantic's smart-mode union reads it ({@link intOrStr}):
   * a string stays the string (`"7"` stays `"7"`), anything else is read
   * as `int` (`7.0` is 7), an int past 2^53 exactly. A public id
   * (memory-cloud#1008): an integer before server v0.89.0, an opaque
   * prefixed string (`rtok_…`) from v0.89.0 on.
   */
  | "intOrStr"
  | "float"
  | "bool"
  | "datetime"
  /** `dict[str, Any]`: an object, its contents untouched. */
  | "dict"
  /** `dict[str, T]`: an object whose every value is read as `T`. */
  | { dictOf: Kind }
  | { literal: readonly string[] }
  | { list: Kind }
  | { model: Model }
  /** `T | None`. */
  | { nullable: Kind }
  /**
   * `Model | None` read fail-open, as the Python SDK's `_validate_or_none`
   * reads it: a value the model refuses is `None` (`null`), never a
   * problem of the enclosing reply.
   */
  | { orNone: Model }
  /**
   * `list[Model] | None` read fail-open, as the Python SDK's `PlanHeadroom`
   * field type reads it (`_plan_headroom_or_none`): an entry the model
   * refuses is dropped, and a value that is not a list, or keeps no entry,
   * is `None` (`null`) — never a problem of the enclosing reply.
   */
  | { failOpenList: Model };

export interface Field {
  key: string;
  kind: Kind;
  /** The value when the key is absent (a fresh one each read); without it, absent is `Field required`. */
  default?: () => unknown;
}

export interface Model {
  /** The Python model's name, for its `KaguraResponseError`. */
  name: string;
  fields: readonly Field[];
  /**
   * `"allow"` for a model with `extra="allow"`: a key it does not declare
   * is kept after its fields, in the body's order and as sent, where pydantic
   * keeps it (`model_extra`) and dumps it. Unknown keys are dropped otherwise.
   */
  extra?: "allow";
}

const required = (key: string, kind: Kind): Field => ({ key, kind });
/** A field with a default; a list or mapping default is a fresh copy each read, as `default_factory` gives. */
const optional = (key: string, kind: Kind, value: unknown = null): Field => ({
  key,
  kind,
  default: () => (typeof value === "object" && value !== null ? structuredClone(value) : value),
});
const nullable = (kind: Kind): Kind => ({ nullable: kind });
const listOf = (kind: Kind): Kind => ({ list: kind });

/** `Literal[…]`'s message: `Input should be 'a', 'b' or 'c'`. */
function literalMessage(values: readonly string[]): string {
  const quoted = values.map((v) => `'${v}'`);
  const last = quoted.pop()!;
  return `Input should be ${quoted.length > 0 ? `${quoted.join(", ")} or ${last}` : last}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerced(r: ResponseReader, at: Loc, result: Coerced<unknown>): unknown {
  if (result.ok) return result.value;
  r.refuse(at, result);
  return undefined;
}

/** `int | str` with the int kept exact, as a number literal of the body reaches it. */
const exactIntOrStr = intOrStr(laxExactInt);

/**
 * `raw` read as `kind`. A number literal (`valueAt`'s `JsonNumber`) reaches
 * the int, float and bool readers as it is; every other type sees the plain
 * value `JSON.parse` gives.
 */
function readValue(r: ResponseReader, kind: Kind, raw: unknown, at: Loc): unknown {
  const value = jsonValue(raw);
  switch (kind) {
    case "str":
      return coerced(r, at, laxStr(value));
    case "int":
      return coerced(r, at, laxExactInt(raw));
    case "intOrStr":
      return coerced(r, at, exactIntOrStr(raw));
    case "float": {
      const result = laxFloat(raw);
      return coerced(r, at, result.ok ? { ok: true, value: new PyFloat(result.value) } : result);
    }
    case "bool":
      return coerced(r, at, laxBool(raw));
    case "datetime":
      return coerced(r, at, pydanticDatetime(value));
    case "dict":
      if (isObject(value)) {
        UNTYPED.add(value);
        return value;
      }
      r.issue(at, "Input should be a valid dictionary");
      return undefined;
  }
  if ("nullable" in kind) return value === null ? null : readValue(r, kind.nullable, raw, at);
  if ("orNone" in kind) return readOrNull(r.operation, kind.orNone, value);
  if ("failOpenList" in kind) {
    return readableReads(value, kind.failOpenList, r.operation)?.map(([, read]) => read) ?? null;
  }
  if ("dictOf" in kind) {
    if (!isObject(value)) {
      r.issue(at, "Input should be a valid dictionary");
      return undefined;
    }
    // In the body's key order (Python's dict order), each value with its
    // number literal, as a list item or a field reaches its reader.
    const out: Record<string, unknown> = {};
    for (const [key] of orderedEntries(value)) {
      out[key] = readValue(r, kind.dictOf, valueAt(value, key), [...at, key]);
    }
    return out;
  }
  if ("literal" in kind) {
    if (typeof value === "string" && hasLoneSurrogate(value)) {
      r.issue(at, STRING_UNICODE);
      return undefined;
    }
    if (typeof value === "string" && kind.literal.includes(value)) return value;
    r.issue(at, literalMessage(kind.literal));
    return undefined;
  }
  if ("list" in kind) {
    if (!Array.isArray(value)) {
      r.issue(at, "Input should be a valid list");
      return undefined;
    }
    return value.map((_item, index) => readValue(r, kind.list, valueAt(value, index), [...at, index]));
  }
  return readFields(r, kind.model, value, at);
}

/** A value pydantic keeps as it is (`Any`, an extra key): untouched, a container marked {@link UNTYPED}. */
function untyped(raw: unknown): unknown {
  // A JsonNumber stays one, so the dump prints the literal the body wrote.
  if ((isObject(raw) && !(raw instanceof JsonNumber)) || Array.isArray(raw)) UNTYPED.add(raw);
  return raw;
}

/**
 * `raw` read as `model` on a reader of its own, so what the model refuses
 * stays out of the enclosing reply's problems: `null` when it refuses it
 * (or `raw` is `null`), as the Python SDK's `_validate_or_none` reads a
 * block the server serves fail-open.
 */
function readOrNull(operation: string, model: Model, raw: unknown): Record<string, unknown> | null {
  const value = jsonValue(raw);
  if (value === null) return null;
  const own = new ResponseReader(operation, model.name);
  const read = readFields(own, model, value, []);
  try {
    own.check();
  } catch {
    return null;
  }
  return read ?? null;
}

/**
 * The entries of `value` that `model` reads, each as `[index, read]` in
 * order, or `undefined` where a `failOpenList` field reads `null`: `value`
 * is not a list, or no entry reads. Python's `_plan_headroom_or_none`,
 * shared by that reader kind (the reads) and {@link readableEntries} (the
 * entries as sent).
 */
function readableReads(
  value: unknown,
  model: Model,
  operation: string,
): Array<[index: number, read: Record<string, unknown>]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: Array<[number, Record<string, unknown>]> = [];
  value.forEach((_entry, index) => {
    const read = readOrNull(operation, model, valueAt(value, index));
    if (read !== null) kept.push([index, read]);
  });
  return kept.length > 0 ? kept : undefined;
}

/**
 * What a `failOpenList` field keeps of `value`, as sent: the entries
 * `model` reads, or `undefined` where the field reads `null` (`value` is
 * not a list, or no entry reads). For the client, which returns a reply as
 * sent once its model accepted it.
 */
export function readableEntries(value: unknown, model: Model, operation: string): unknown[] | undefined {
  return readableReads(value, model, operation)?.map(([index]) => (value as unknown[])[index]);
}

function readFields(r: ResponseReader, model: Model, raw: unknown, at: Loc): Record<string, unknown> | undefined {
  const obj = r.object(raw, at, model.name);
  if (obj === null) return undefined;
  const out: Record<string, unknown> = {};
  for (const field of model.fields) {
    const value = valueAt(obj, field.key);
    if (value === undefined) {
      if (field.default !== undefined) {
        out[field.key] = field.default();
      } else {
        r.issue([...at, field.key], "Field required");
      }
      continue;
    }
    out[field.key] = readValue(r, field.kind, value, [...at, field.key]);
  }
  if (model.extra === "allow") {
    const declared = new Set(model.fields.map((field) => field.key));
    for (const [key] of orderedEntries(obj)) {
      if (!declared.has(key)) out[key] = untyped(valueAt(obj, key));
    }
  }
  return out;
}

/**
 * `raw` read as `model` reads it, ready for {@link formatModelJson}: the
 * model's keys in its order, defaults filled, unknown keys dropped.
 *
 * @param operation The Python label of the call that returned it
 *   (`ResourceClient.list_tokens`), for the error.
 * @throws KaguraResponseError with every problem, as pydantic lists them.
 */
export function readModel(raw: unknown, model: Model, operation: string): Record<string, unknown> {
  const r = new ResponseReader(operation, model.name);
  const out = readFields(r, model, raw, []);
  r.check();
  return out!;
}

// ---------------------------------------------------------------------------
// The Python SDK's models (models.py), fields in declaration order
// ---------------------------------------------------------------------------

export const RESOURCE_SETUP_RESPONSE: Model = {
  name: "ResourceSetupResponse",
  fields: [
    required("context_id", "str"),
    required("context_name", "str"),
    required("resource_id", "str"),
    required("token", "str"),
    required("token_id", "intOrStr"),
    optional("warning", nullable("str")),
  ],
};

const TOKEN_FIELDS: readonly Field[] = [
  required("id", "intOrStr"),
  required("resource_id", "str"),
  optional("description", nullable("str")),
  required("quota_events_per_hour", "int"),
  optional("created_by", nullable("str")),
  required("created_at", "datetime"),
  optional("last_used_at", nullable("datetime")),
  required("is_active", "bool"),
  required("status", { literal: ["active", "revoked"] }),
];

export const RESOURCE_TOKEN_RESPONSE: Model = { name: "ResourceTokenResponse", fields: TOKEN_FIELDS };

export const RESOURCE_TOKEN_CREATE_RESPONSE: Model = {
  name: "ResourceTokenCreateResponse",
  fields: [...TOKEN_FIELDS, required("token", "str")],
};

export const PAGINATED_RESOURCE_TOKENS_RESPONSE: Model = {
  name: "PaginatedResourceTokensResponse",
  fields: [
    required("tokens", listOf({ model: RESOURCE_TOKEN_RESPONSE })),
    required("total", "int"),
    required("limit", "int"),
    required("offset", "int"),
  ],
};

export const RESOURCE_EVENT_RESPONSE: Model = {
  name: "ResourceEventResponse",
  fields: [
    optional("status", "str", "success"),
    required("event_id", "int"),
    optional("queued", "bool", true),
    optional("estimated_indexing_time_seconds", nullable("int")),
  ],
};

export const RESOURCE_EVENT_BATCH_RESPONSE: Model = {
  name: "ResourceEventBatchResponse",
  fields: [
    optional("status", "str", "success"),
    required("created_count", "int"),
    optional("failed_count", "int", 0),
    optional("event_ids", listOf("int"), []),
    optional("errors", listOf("dict"), []),
  ],
};

const OP: Kind = { literal: ["upsert", "delete"] };

const RESOURCE_EVENT_RECORD: Model = {
  name: "ResourceEventRecord",
  fields: [
    required("id", "int"),
    required("op", OP),
    required("doc_id", "str"),
    optional("version", nullable("int")),
    optional("idempotency_key", nullable("str")),
    optional("importance", nullable("float")),
    optional("created_at", nullable("datetime")),
    optional("payload", nullable("dict")),
    optional("event_metadata", "dict", {}),
    optional("payload_bytes", nullable("int")),
    optional("payload_truncated", "bool", false),
  ],
};

export const RESOURCE_EVENTS_LIST_RESPONSE: Model = {
  name: "ResourceEventsListResponse",
  fields: [
    optional("events", listOf({ model: RESOURCE_EVENT_RECORD }), []),
    optional("next_cursor", nullable("str")),
  ],
};

export const RESOURCE_IMPACT_RESPONSE: Model = {
  name: "ResourceImpactResponse",
  fields: [
    required("resource_id", "str"),
    required("token_count", "int"),
    required("memory_count", "int"),
    optional("current_schema_version", nullable("int")),
  ],
};

const FIELD_DEFINITION: Model = {
  name: "FieldDefinition",
  fields: [
    required("name", "str"),
    required("type", { literal: ["text", "number", "boolean", "date", "array", "object"] }),
    required("description", "str"),
    optional("classification", { literal: ["public", "internal", "pii", "confidential"] }, "public"),
    optional("index_hint", "str", ""),
    optional("unit", nullable("str")),
    optional("enum_values", nullable(listOf("str"))),
    optional("example", nullable("str")),
    optional("required", "bool", false),
  ],
};

export const RESOURCE_SCHEMA_RESPONSE: Model = {
  name: "ResourceSchemaResponse",
  fields: [
    required("resource_id", "str"),
    required("schema_version", "int"),
    required("field_definitions", listOf({ model: FIELD_DEFINITION })),
    required("created_at", "datetime"),
  ],
};

const RESOURCE_LIST_ITEM: Model = {
  name: "ResourceListItem",
  fields: [
    required("resource_id", "str"),
    // `str | None = None` (Python SDK 0.42.2): null on a context-less row, see ResourceListItem.
    optional("context_id", nullable("str")),
    optional("context_name", nullable("str")),
    optional("context_display_name", nullable("str")),
    required("token_count", "int"),
    required("memory_count", "int"),
    optional("current_schema_version", nullable("int")),
    required("created_at", "datetime"),
    required("updated_at", "datetime"),
  ],
};

export const RESOURCE_LIST_RESPONSE: Model = {
  name: "ResourceListResponse",
  fields: [required("resources", listOf({ model: RESOURCE_LIST_ITEM })), required("total", "int")],
};

const INDEXER_STATE_METRICS: Model = {
  name: "IndexerStateMetrics",
  fields: [
    optional("applied_upserts", "int", 0),
    optional("applied_deletes", "int", 0),
    optional("errors", "int", 0),
    optional("failed_events", "int", 0),
    optional("skipped_reason", nullable("str")),
  ],
};

const INDEXER_STATE: Model = {
  name: "IndexerState",
  fields: [
    required("job_status", "str"),
    optional("last_run_at", nullable("datetime")),
    optional("next_run_at", nullable("datetime")),
    required("active_version", "int"),
    required("last_offset", "int"),
    optional("lag_seconds", nullable("float")),
    required("metrics", { model: INDEXER_STATE_METRICS }),
  ],
};

const RESOURCE_EVENT_ITEM: Model = {
  name: "ResourceEventItem",
  fields: [
    required("id", "int"),
    required("op", OP),
    required("doc_id", "str"),
    optional("version", nullable("int")),
    optional("created_at", nullable("datetime")),
  ],
};

export const INDEXER_STATUS_RESPONSE: Model = {
  name: "IndexerStatusResponse",
  fields: [
    required("resource_id", "str"),
    optional("state", nullable({ model: INDEXER_STATE })),
    optional("recent_events", listOf({ model: RESOURCE_EVENT_ITEM }), []),
  ],
};

export const FILE_OBJECT: Model = {
  name: "FileObject",
  fields: [
    required("id", "str"),
    required("workspace_id", "str"),
    required("filename", "str"),
    required("content_type", "str"),
    required("size_bytes", "int"),
    required("sha256", "str"),
    required("status", "str"),
    required("created_at", "datetime"),
    optional("uploaded_at", nullable("datetime")),
    optional("context_id", nullable("str")),
  ],
};

export const FILE_RESERVE_RESPONSE: Model = {
  name: "FileReserveResponse",
  fields: [required("file_id", "str"), required("upload_url", "str"), required("expires_at", "datetime")],
};

export const FILE_LIST_RESPONSE: Model = {
  name: "FileListResponse",
  fields: [required("files", listOf({ model: FILE_OBJECT })), optional("next_cursor", nullable("str"))],
};

const SERVER_FEATURES: Model = {
  name: "ServerFeatures",
  fields: [
    optional("neural_memory", "bool", false),
    optional("research_tools", "bool", false),
    optional("plan_page", "bool", false),
    optional("byok", "bool", false),
    optional("cost_display", "bool", false),
    optional("managed_connectors", "bool", false),
    optional("managed_llm", "bool", false),
    optional("referrals", "bool", false),
    optional("beta_invites", "bool", false),
    optional("reranking", "bool", false),
    optional("content_chunks_require_plan", "bool", false),
    optional("llm_selector_require_plan", "bool", false),
  ],
};

/**
 * `/api/v1/system/info`, checked (not converted) as Python's
 * `get_server_info` does: its `ServerFeatures` keeps flags it does not
 * know (`extra="allow"`), which {@link readModel} would drop.
 */
export const SERVER_INFO: Model = {
  name: "ServerInfo",
  fields: [
    required("name", "str"),
    required("version", "str"),
    optional("description", nullable("str")),
    optional("environment", nullable("str")),
    optional("search_defaults", nullable("dict")),
    optional("terms_version", nullable("str")),
    optional("features", { model: SERVER_FEATURES }, {}),
  ],
};

export const FILE_DOWNLOAD_URL_RESPONSE: Model = {
  name: "FileDownloadUrlResponse",
  fields: [required("download_url", "str")],
};

const FAILED_MEMORY_INFO: Model = {
  name: "FailedMemoryInfo",
  fields: [
    required("id", "str"),
    required("summary", "str"),
    optional("embedding_error", nullable("str")),
    required("created_at", "datetime"),
    optional("updated_at", nullable("datetime")),
    optional("embedding_attempted_at", nullable("datetime")),
  ],
};

/** `/api/v1/workspace/embedding-status`, checked as `get_embedding_status` parses it. */
export const EMBEDDING_STATUS: Model = {
  name: "EmbeddingStatus",
  fields: [
    required("total", "int"),
    required("by_status", { dictOf: "int" }),
    required("failed_memories", listOf({ model: FAILED_MEMORY_INFO })),
  ],
};

/**
 * Python's `MemoryStatItem`, with one deliberate difference: `use_count`
 * is optional. memory-cloud v0.34.0 (#1046) dropped it, and the Python
 * SDK 0.42.0 still requires it, so it refuses every non-empty page.
 */
const MEMORY_STAT_ITEM: Model = {
  name: "MemoryStatItem",
  fields: [
    required("id", "str"),
    required("summary", "str"),
    required("type", "str"),
    required("importance", "float"),
    required("scope", "str"),
    optional("use_count", "int", 0),
    required("access_count", "int"),
    optional("last_used_at", nullable("datetime")),
    required("embedding_status", "str"),
    required("created_at", "datetime"),
  ],
};

/** `/api/v1/contexts/{id}/memory-stats`, checked as `get_memory_stats` parses it. */
export const MEMORY_STATS_RESPONSE: Model = {
  name: "MemoryStatsResponse",
  fields: [
    required("memories", listOf({ model: MEMORY_STAT_ITEM })),
    required("total", "int"),
    required("sort_by", "str"),
    required("sort_order", "str"),
  ],
};

const DUPLICATE_MEMORY_INFO: Model = {
  name: "DuplicateMemoryInfo",
  fields: [required("id", "str"), required("summary", "str"), required("type", "str"), required("created_at", "datetime")],
};

const DUPLICATE_PAIR: Model = {
  name: "DuplicatePair",
  fields: [
    required("memory_a", { model: DUPLICATE_MEMORY_INFO }),
    required("memory_b", { model: DUPLICATE_MEMORY_INFO }),
    required("similarity", "float"),
  ],
};

/** `/api/v1/contexts/{id}/duplicates`, checked as `find_duplicates` parses it. */
export const DUPLICATES_RESPONSE: Model = {
  name: "DuplicatesResponse",
  fields: [
    required("pairs", listOf({ model: DUPLICATE_PAIR })),
    required("total_pairs", "int"),
    required("threshold", "float"),
    required("memories_scanned", "int"),
  ],
};

const EMBEDDING_MODEL: Model = {
  name: "EmbeddingModel",
  fields: [required("name", "str"), required("dimensions", "int"), required("provider", "str"), required("available", "bool")],
};

/** `/api/v1/system/embedding/models`, checked as `list_embedding_models` parses it. */
export const EMBEDDING_MODELS_RESPONSE: Model = {
  name: "EmbeddingModelsResponse",
  fields: [required("models", listOf({ model: EMBEDDING_MODEL })), required("default_model", "str")],
};

// Sleep Maintenance (`get_sleep_history` / `get_sleep_report`), for the
// `sleep history` / `sleep report` dumps.

const SLEEP_REPORT_FIELDS: readonly Field[] = [
  required("report_id", "str"),
  optional("context_id", nullable("str")),
  required("status", "str"),
  optional("started_at", nullable("datetime")),
  optional("completed_at", nullable("datetime")),
  required("memories_processed", "int"),
  required("edges_created", "int"),
  required("memories_merged", "int"),
  required("memories_promoted", "int"),
  required("llm_calls_made", "int"),
  required("llm_tokens_used", "int"),
  optional("llm_call_failures", nullable("int")),
  optional("source", nullable("str")),
];

/** One `get_sleep_history` row, as Python's `SleepReport` reads it. */
export const SLEEP_REPORT: Model = { name: "SleepReport", fields: SLEEP_REPORT_FIELDS };

const SLEEP_ACTION: Model = {
  name: "SleepAction",
  fields: [
    required("id", "str"),
    required("phase", "str"),
    required("action_type", "str"),
    optional("memory_id", nullable("str")),
    optional("target_id", nullable("str")),
    optional("details", nullable("dict")),
    optional("created_at", nullable("datetime")),
    optional("details_omitted", "bool", false),
    optional("details_total_chars", nullable("int")),
  ],
};

/**
 * A `get_sleep_report` reply flattened as `getSleepReport` returns it (the
 * `report` block plus the envelope's paging keys), as Python's
 * `SleepReportDetail` reads it.
 */
export const SLEEP_REPORT_DETAIL: Model = {
  name: "SleepReportDetail",
  fields: [
    ...SLEEP_REPORT_FIELDS,
    required("memories_flagged", "int"),
    required("embedding_calls_made", "int"),
    optional("error_message", nullable("str")),
    optional("edge_discovery_result", nullable("dict")),
    optional("dedup_result", nullable("dict")),
    optional("merge_retention_result", nullable("dict")),
    optional("importance_result", nullable("dict")),
    optional("consolidation_result", nullable("dict")),
    optional("reindex_result", nullable("dict")),
    optional("actions", listOf({ model: SLEEP_ACTION }), []),
    required("action_count", "int"),
    optional("actions_has_more", "bool", false),
    optional("actions_next_cursor", nullable("str")),
    optional("note", nullable("str")),
  ],
};

// Session tools (memory-cloud v0.93.0+, #86): the Python SDK 0.44.0's
// models for bootstrap, changes_since, list, remember_batch, forget by ids,
// describe_tools, guide, list_revisions and rollback_session.

/** A model's defaults as one object: what a `default_factory=Model` field holds. */
function defaultsOf(model: Model): Record<string, unknown> {
  return Object.fromEntries(model.fields.map((field) => [field.key, field.default!()]));
}

const SEARCH_CONFIG: Model = {
  name: "SearchConfig",
  fields: [
    optional("semantic_weight", "float", 0.6),
    optional("bm25_weight", "float", 0.4),
    optional("fetch_factor", "int", 3),
    optional("use_rerank", "bool", false),
    optional("reranker_provider", nullable("str")),
    optional("reranker_model", nullable("str")),
    optional("content_chunks_enabled", nullable("bool")),
    optional("content_chunks_effective", nullable("bool")),
    optional("content_chunks_limit", nullable("int")),
    optional("content_chunks_in_use", nullable("int")),
    optional("content_chunks_disabled_reason", nullable("str")),
    optional("content_chunks_can_change", nullable("bool")),
    optional("content_chunks_supported", nullable("bool")),
    optional("content_chunks_backfill_pending", nullable("int")),
    optional("embedding_provider", nullable("str")),
    optional("llm_selector_enabled", nullable("bool")),
    optional("llm_selector_effective", nullable("bool")),
    optional("llm_selector_limit", nullable("int")),
    optional("llm_selector_in_use", nullable("int")),
    optional("llm_selector_disabled_reason", nullable("str")),
    optional("llm_selector_can_change", nullable("bool")),
  ],
};

const CONTEXT_DETAIL: Model = {
  name: "ContextDetail",
  fields: [
    required("id", "str"),
    required("name", "str"),
    optional("display_name", nullable("str")),
    optional("summary", nullable("str")),
    optional("usage_guide", nullable("str")),
    optional("is_private", "bool", true),
    optional("is_locked", "bool", false),
    optional("embedding_model", nullable("str")),
    optional("embedding_dimensions", nullable("int")),
    // `Field(default_factory=SearchConfig)`: absent is the defaults, not `{}`.
    { key: "search_config", kind: { model: SEARCH_CONFIG }, default: () => defaultsOf(SEARCH_CONFIG) },
  ],
};

const CONTEXT_GUARDRAIL_ITEM: Model = {
  name: "ContextGuardrailItem",
  fields: [
    required("memory_id", "str"),
    required("summary", "str"),
    optional("summary_cut", "bool", false),
    optional("importance", nullable("float")),
    optional("authored_by_caller", nullable("bool")),
    optional("source_type", nullable("str")),
  ],
};

const CONTEXT_GUARDRAILS: Model = {
  name: "ContextGuardrails",
  fields: [
    required("items", listOf({ model: CONTEXT_GUARDRAIL_ITEM })),
    required("total_available", "int"),
    required("truncated", "bool"),
    optional("tool_triggered_version", nullable("str")),
    optional("provenance", nullable("str")),
  ],
};

/** `_ContextEcho`'s fields, which come first in every model that extends it. */
const CONTEXT_ECHO_FIELDS: readonly Field[] = [
  optional("context_id", nullable("str")),
  optional("context_name", nullable("str")),
  optional("context_display_name", nullable("str")),
  optional("context_is_private", nullable("bool")),
  optional("context_is_locked", nullable("bool")),
];

/** One `plan_headroom` entry, as Python's `PlanHeadroomNotice` reads it (memory-cloud v0.142.0+, #2615). */
export const PLAN_HEADROOM_NOTICE: Model = {
  name: "PlanHeadroomNotice",
  fields: [
    required("dimension", "str"),
    required("level", "str"),
    required("used", "int"),
    required("limit", "int"),
    required("percentage", "float"),
    optional("plan", nullable("str")),
    optional("remedies", listOf("str"), []),
    optional("help", nullable("str")),
    optional("resets_at", nullable("datetime")),
  ],
};

/**
 * `plan_headroom: PlanHeadroom = None`: the notices read fail-open, as the
 * server serves them — an entry `PlanHeadroomNotice` refuses is dropped,
 * and absent, a value that is not a list or one with no readable entry
 * reads `null` (#88).
 */
const PLAN_HEADROOM: Field = optional("plan_headroom", { failOpenList: PLAN_HEADROOM_NOTICE });

const CHANGE_EVENT: Model = {
  name: "ChangeEvent",
  fields: [
    required("memory_id", "str"),
    required("kind", "str"),
    required("at", "datetime"),
    optional("summary", nullable("str")),
    optional("summary_cut", "bool", false),
    optional("superseded_by", nullable("str")),
  ],
};

const BOOTSTRAP_LANE_FIELDS: readonly Field[] = [
  required("status", "str"),
  optional("error", nullable("str")),
  optional("truncated", "bool", false),
];

const BOOTSTRAP_PINNED_LANE: Model = {
  name: "BootstrapPinnedLane",
  extra: "allow",
  fields: [
    ...BOOTSTRAP_LANE_FIELDS,
    optional("memories", listOf("dict"), []),
    optional("total_available", nullable("int")),
    optional("cap", nullable("int")),
  ],
};

const BOOTSTRAP_UPCOMING_LANE: Model = {
  name: "BootstrapUpcomingLane",
  extra: "allow",
  // `from` is the wire key; the Python model's `from_` dumps by alias.
  fields: [...BOOTSTRAP_LANE_FIELDS, optional("results", listOf("dict"), []), optional("from", nullable("str"))],
};

const BOOTSTRAP_CHANGES_LANE: Model = {
  name: "BootstrapChangesLane",
  extra: "allow",
  fields: [
    ...BOOTSTRAP_LANE_FIELDS,
    optional("changes", listOf({ model: CHANGE_EVENT }), []),
    optional("has_more", "bool", false),
    optional("next_cursor", nullable("str")),
  ],
};

const BOOTSTRAP_COMPONENTS: Model = {
  name: "BootstrapComponents",
  extra: "allow",
  fields: [
    optional("pinned", nullable({ model: BOOTSTRAP_PINNED_LANE })),
    optional("upcoming", nullable({ model: BOOTSTRAP_UPCOMING_LANE })),
    optional("changes", nullable({ model: BOOTSTRAP_CHANGES_LANE })),
  ],
};

/** A `bootstrap` reply, as Python's `BootstrapResponse` reads it (dumped by alias). */
export const BOOTSTRAP_RESPONSE: Model = {
  name: "BootstrapResponse",
  fields: [
    ...CONTEXT_ECHO_FIELDS,
    optional("status", "str", "success"),
    optional("format", nullable("str")),
    optional("degraded", "bool", false),
    optional("context", nullable({ model: CONTEXT_DETAIL })),
    optional("instructions", nullable("str")),
    // Fail-open, as the server serves the block: unreadable is `null`.
    optional("guardrails", { orNone: CONTEXT_GUARDRAILS }),
    required("components", { model: BOOTSTRAP_COMPONENTS }),
    optional("since", nullable("datetime")),
    optional("generated_at", nullable("datetime")),
    optional("context_summary_omitted", "bool", false),
    PLAN_HEADROOM,
  ],
};

/** A `changes_since` reply, as Python's `ChangesSinceResponse` reads it. */
export const CHANGES_SINCE_RESPONSE: Model = {
  name: "ChangesSinceResponse",
  fields: [
    ...CONTEXT_ECHO_FIELDS,
    optional("status", "str", "success"),
    required("changes", listOf({ model: CHANGE_EVENT })),
    optional("count", nullable("int")),
    required("has_more", "bool"),
    optional("next_cursor", nullable("str")),
    optional("since", nullable("datetime")),
    optional("until", nullable("datetime")),
    optional("session_id", nullable("str")),
    optional("by_me", "bool", false),
    optional("truncated", "bool", false),
  ],
};

/** A `list` reply, as Python's `ListMatchingResponse` reads it. */
export const LIST_MATCHING_RESPONSE: Model = {
  name: "ListMatchingResponse",
  fields: [
    ...CONTEXT_ECHO_FIELDS,
    optional("status", "str", "success"),
    required("memories", listOf("dict")),
    optional("count", nullable("int")),
    required("total", "int"),
    required("has_more", "bool"),
    optional("next_cursor", nullable("str")),
    optional("order_by", nullable("str")),
    optional("direction", nullable("str")),
    optional("truncated", "bool", false),
    optional("details_omitted", "bool", false),
  ],
};

const REMEMBER_BATCH_ITEM_RESULT: Model = {
  name: "RememberBatchItemResult",
  extra: "allow",
  fields: [
    required("index", "int"),
    required("status", "str"),
    optional("memory_id", nullable("str")),
    optional("scope", nullable("str")),
    optional("error", nullable("str")),
    optional("message", nullable("str")),
    optional("candidate", nullable("dict")),
    optional("persistence", nullable("dict")),
    optional("lint", nullable(listOf("dict"))),
    optional("summary_truncated", "bool", false),
    optional("summary_original_length", nullable("int")),
  ],
};

/** A `remember_batch` reply, as Python's `RememberBatchResult` reads it. */
export const REMEMBER_BATCH_RESULT: Model = {
  name: "RememberBatchResult",
  fields: [
    ...CONTEXT_ECHO_FIELDS,
    optional("status", "str", "success"),
    required("results", listOf({ model: REMEMBER_BATCH_ITEM_RESULT })),
    required("count", "int"),
    required("succeeded", "int"),
    optional("candidates", "int", 0),
    required("failed", "int"),
    optional("skipped", "int", 0),
    optional("committed_after_timeout", "bool", false),
    optional("message", nullable("str")),
    optional("session_id", nullable("str")),
    PLAN_HEADROOM,
  ],
};

const FORGET_ID_RESULT: Model = {
  name: "ForgetIdResult",
  extra: "allow",
  fields: [
    required("memory_id", "str"),
    required("status", "str"),
    optional("error", nullable("str")),
    optional("message", nullable("str")),
    optional("correlation_id", nullable("str")),
  ],
};

/** A `forget({ memoryIds })` reply, as Python's `ForgetBatchResult` reads it. */
export const FORGET_BATCH_RESULT: Model = {
  name: "ForgetBatchResult",
  fields: [
    ...CONTEXT_ECHO_FIELDS,
    optional("status", "str", "success"),
    required("deleted_count", "int"),
    optional("memory_ids", listOf("str"), []),
    required("results", listOf({ model: FORGET_ID_RESULT })),
    required("count", "int"),
    required("succeeded", "int"),
    required("skipped", "int"),
    required("failed", "int"),
    optional("session_id", nullable("str")),
  ],
};

/** A `describe_tools` reply, as Python's `ToolDescriptions` reads it. */
export const TOOL_DESCRIPTIONS: Model = {
  name: "ToolDescriptions",
  extra: "allow",
  fields: [
    optional("status", "str", "success"),
    optional("tools", listOf("dict"), []),
    optional("count", nullable("int")),
    optional("listed", listOf("str"), []),
    optional("definitions", listOf("dict"), []),
    optional("unknown", listOf("str"), []),
    optional("url", "dict", {}),
    optional("url_error", nullable("str")),
    optional("hint", nullable("str")),
  ],
};

const GUIDE_TOPIC: Model = { name: "GuideTopic", fields: [required("topic", "str"), required("text", "str")] };

/** A `guide` reply, as Python's `GuideResponse` reads it. */
export const GUIDE_RESPONSE: Model = {
  name: "GuideResponse",
  fields: [
    optional("status", "str", "success"),
    required("topics", listOf({ model: GUIDE_TOPIC })),
    optional("unknown", listOf("str"), []),
    optional("hint", nullable("str")),
  ],
};

const MEMORY_REVISION: Model = {
  name: "MemoryRevision",
  fields: [
    required("version", "int"),
    required("kind", "str"),
    required("at", "datetime"),
    optional("changed_fields", listOf("str"), []),
    required("writer", "str"),
    required("by_you", "bool"),
    optional("agent_id", nullable("str")),
    optional("session_id", nullable("str")),
  ],
};

/** A `list_revisions` reply, as Python's `RevisionsPage` reads it. */
export const REVISIONS_PAGE: Model = {
  name: "RevisionsPage",
  fields: [
    ...CONTEXT_ECHO_FIELDS,
    optional("status", "str", "success"),
    required("memory_id", "str"),
    required("current_version", "int"),
    required("revisions", listOf({ model: MEMORY_REVISION })),
    optional("count", nullable("int")),
    required("has_more", "bool"),
    optional("next_cursor", nullable("str")),
    optional("truncated", "bool", false),
  ],
};

const SESSION_ROLLBACK_ITEM: Model = {
  name: "SessionRollbackItem",
  extra: "allow",
  fields: [
    required("memory_id", "str"),
    required("kind", "str"),
    required("action", "str"),
    optional("cause", nullable("str")),
    optional("fields", listOf("str"), []),
    optional("unforget", "bool", false),
  ],
};

/** A `rollback_session` call's `summary`, as Python's `SessionRollbackSummary` reads it. */
export const SESSION_ROLLBACK_SUMMARY: Model = {
  name: "SessionRollbackSummary",
  extra: "allow",
  fields: [
    optional("forgotten", "int", 0),
    optional("restored", "int", 0),
    optional("updated_restored", "int", 0),
    optional("skipped", "int", 0),
    optional("failed", "int", 0),
    optional("chunks_requeued", "int", 0),
    optional("points_requeued", "int", 0),
    optional("skipped_items", listOf("dict"), []),
    optional("errors", listOf("str"), []),
  ],
};

/** A `rollback_session` reply, as Python's `SessionRollbackResult` reads it. */
export const SESSION_ROLLBACK_RESULT: Model = {
  name: "SessionRollbackResult",
  fields: [
    ...CONTEXT_ECHO_FIELDS,
    required("status", "str"),
    required("dry_run", "bool"),
    optional("session_id", nullable("str")),
    optional("since", nullable("datetime")),
    optional("until", nullable("datetime")),
    optional("until_from", nullable("str")),
    optional("events", "int", 0),
    optional("remaining", "int", 0),
    optional("rollback_id", nullable("int")),
    optional("plan", nullable({ dictOf: "int" })),
    optional("items", listOf({ model: SESSION_ROLLBACK_ITEM }), []),
    optional("items_truncated", "bool", false),
    optional("rollback_status", nullable("str")),
    optional("summary", nullable({ model: SESSION_ROLLBACK_SUMMARY })),
    optional("totals", nullable("dict")),
    optional("help", nullable("str")),
  ],
};
