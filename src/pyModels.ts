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

import { jsonValue, valueAt } from "./losslessJson.js";
import { pydanticDatetime } from "./pydanticDatetime.js";
import { hasLoneSurrogate, STRING_UNICODE } from "./pydanticNumber.js";
import {
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
  | "float"
  | "bool"
  | "datetime"
  /** `dict[str, Any]`: an object, its contents untouched. */
  | "dict"
  | { literal: readonly string[] }
  | { list: Kind }
  | { model: Model }
  /** `T | None`. */
  | { nullable: Kind };

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
  r.issue(at, result.msg);
  return undefined;
}

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
    required("token_id", "int"),
    optional("warning", nullable("str")),
  ],
};

const TOKEN_FIELDS: readonly Field[] = [
  required("id", "int"),
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
    required("context_id", "str"),
    required("context_name", "str"),
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
  ],
};

/**
 * `/api/v1/system/info`, read here only to check the body as Python's
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
