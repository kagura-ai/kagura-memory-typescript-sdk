/**
 * REST client for the memory guardrail endpoints (server v0.74.0+) — port
 * of memory_client.py.
 *
 * Covers the `/api/v1/memory` tool-guardrail routes (memory-cloud #1619,
 * #1621), authenticated with `APIKeyOrSessionUser`, so a client hook or a
 * setup script holding only an API key (an agent-bound key included,
 * which may read guardrails but never author them) can load them without
 * opening an MCP session:
 *
 * - `POST /guardrails` — the REST twin of the MCP `load_guardrails` tool
 *   (`KaguraClient.loadGuardrails`); same body, same lanes.
 * - `GET /guardrails/digest` — the rendered tool-triggered set for
 *   clients without tool hooks: the `AGENTS.md` export block or a preview
 *   of the MCP server `instructions`, with the `tool_triggered_version` in
 *   a response header.
 *
 * Construction, credential resolution, lifecycle, and the base error
 * mapping live in {@link KaguraRestClient}; this module keeps only the
 * wire calls.
 */

import type {
  GuardrailDigest,
  GuardrailDigestTarget,
  GuardrailItem,
  GuardrailSet,
  ToolTrigger,
} from "./models.js";
import { normalizeUuid } from "./pyCompat.js";
import { KaguraRestClient } from "./restBase.js";
import {
  ResponseReader,
  laxBool,
  laxFloat,
  laxInt,
  laxStr,
  nullable,
  type Loc,
} from "./responseShape.js";

/** The digest response header carrying the served set's `tool_triggered_version`. */
export const GUARDRAIL_VERSION_HEADER = "X-Kagura-Guardrails-Tool-Triggered-Version";

/** `ToolTrigger`'s declared fields; any other key follows them (`extra="allow"`). */
const TRIGGER_FIELDS: readonly string[] = ["tool", "on", "match", "action"];

/**
 * An item's `tool_trigger` as the Python SDK reads it (`_validate_or_none`):
 * a `ToolTrigger`, or `null` for anything that does not validate as one,
 * so a legacy value never fails the read of the whole set.
 *
 * A trigger keeps its declared fields in the model's order, `on`, `match`
 * and `action` defaulted when absent (`match: null` is inserted, as
 * `model_dump` writes it), then any other keys in the order sent.
 * Pydantic's `str` takes strings only, so `tool: 5` is no trigger.
 */
function readToolTrigger(value: unknown): ToolTrigger | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const { tool } = raw;
  const on = raw.on === undefined ? "pre" : raw.on;
  const match = raw.match === undefined ? null : raw.match;
  const action = raw.action === undefined ? "inform" : raw.action;
  if (typeof tool !== "string" || typeof on !== "string" || typeof action !== "string") return null;
  if (match !== null && typeof match !== "string") return null;
  const extra = Object.entries(raw).filter(([key]) => !TRIGGER_FIELDS.includes(key));
  // fromEntries, not assignment: an extra key named `__proto__` stays a key.
  return Object.fromEntries([
    ["tool", tool],
    ["on", on],
    ["match", match],
    ["action", action],
    ...extra,
  ]) as unknown as ToolTrigger;
}

/**
 * One `GuardrailItem`: its eleven fields in the model's order, the
 * optional ones `null` when absent, unknown keys dropped (`extra="ignore"`).
 *
 * The timestamps are passed through as the server sent them (the server
 * writes the ISO form pydantic would print back); every other field is
 * checked and coerced as pydantic's lax mode does.
 */
function readItem(r: ResponseReader, value: unknown, at: Loc): GuardrailItem | null {
  const item = r.object(value, at, "GuardrailItem");
  if (item === null) return null;
  const optional = { at, default: null };
  // Property order is evaluation order: each field is read, and any
  // problem recorded, in the model's order, which is pydantic's.
  return {
    memory_id: r.field(item, "memory_id", laxStr, { at }),
    summary: r.field(item, "summary", laxStr, { at }),
    context_summary: r.field(item, "context_summary", nullable(laxStr), optional),
    type: r.field(item, "type", nullable(laxStr), optional),
    importance: r.field(item, "importance", laxFloat, { at }),
    delivery_mode: r.field(item, "delivery_mode", nullable(laxStr), optional),
    tool_trigger: readToolTrigger(item.tool_trigger),
    source_type: r.field(item, "source_type", nullable(laxStr), optional),
    authored_by_caller: r.field(item, "authored_by_caller", nullable(laxBool), optional),
    created_at: item.created_at ?? null,
    updated_at: item.updated_at ?? null,
  } as GuardrailItem;
}

/**
 * Read a `load_guardrails` payload as Python's `GuardrailSet` model reads
 * it — `parse_response(GuardrailSet, …)` — so a set missing a truncation
 * flag fails instead of reading as complete ("never a silent truncation").
 *
 * The set is the model's: its fifteen fields in its order, `status`
 * `"success"` and the context block `null` when absent, and each item's
 * eleven. Every field is checked in that order and read in pydantic's lax
 * mode (`"50"` is an int, `"yes"` a bool), a bad optional field included
 * (`pinned.0.type: Input should be a valid string`); fields the model
 * does not name are dropped (the MCP tool's `context_display_name`,
 * `context_is_private`, `context_is_locked`), and a `tool_trigger` that
 * does not read as one is `null`. Timestamps pass through as sent.
 *
 * Internal: `MemoryClient.loadGuardrails` and the CLI's `guardrails load`
 * both read the set through it, each with its own operation label.
 *
 * @throws KaguraResponseError labelled `operation`, in the Python SDK's words.
 */
export function parseGuardrailSet(data: unknown, operation: string): GuardrailSet {
  const r = new ResponseReader(operation, "GuardrailSet");
  const obj = r.object(data);
  let set: GuardrailSet | undefined;
  if (obj !== null) {
    const lane = (key: string) =>
      r.list(obj, key, (value, at) => readItem(r, value, at)) as GuardrailItem[];
    // Read in the model's field order: pydantic reports in that order.
    set = {
      status: r.field(obj, "status", laxStr, { default: "success" }),
      format: r.field(obj, "format", laxInt),
      version: r.field(obj, "version", laxStr),
      pinned: lane("pinned"),
      tool_triggered: lane("tool_triggered"),
      total_available: r.field(obj, "total_available", laxInt),
      truncated: r.field(obj, "truncated", laxBool),
      cap: r.field(obj, "cap", laxInt),
      pinned_cap: r.field(obj, "pinned_cap", laxInt),
      pinned_total_available: r.field(obj, "pinned_total_available", laxInt),
      pinned_truncated: r.field(obj, "pinned_truncated", laxBool),
      tool_triggered_total_available: r.field(obj, "tool_triggered_total_available", laxInt),
      tool_triggered_truncated: r.field(obj, "tool_triggered_truncated", laxBool),
      context_id: r.field(obj, "context_id", nullable(laxStr), { default: null }),
      context_name: r.field(obj, "context_name", nullable(laxStr), { default: null }),
    };
  }
  r.check();
  return set!;
}

/** Options for {@link MemoryClient.loadGuardrails}. */
export interface MemoryLoadGuardrailsOptions {
  /**
   * Max tool-triggered memories returned (1-1000; the route answers
   * anything else with a 422). Bounds the `tool_triggered` lane only.
   * Omit for the server default (50).
   */
  cap?: number;
}

/** Options for {@link MemoryClient.getGuardrailDigest}. */
export interface GetGuardrailDigestOptions {
  /**
   * `"export"` (default): the `AGENTS.md` block as `text/markdown` (up to
   * 20 entries and 12,000 characters, empty when the context has none).
   * `"instructions"`: the exact MCP server `instructions` string this
   * credential would receive for this context.
   */
  target?: GuardrailDigestTarget;
  /**
   * `target: "instructions"` only: the MCP URL's `?profile=` value
   * (`full` | `core`), so the truncation note names the tool that URL
   * lists. An empty string is sent as is (the server ignores it).
   */
  profile?: string;
  /** `target: "instructions"` only: the MCP URL's `?tools=` allowlist. */
  tools?: string;
}

/**
 * REST API client for tool guardrails (memory-cloud v0.74.0+).
 *
 * Every method works with an API key; a workspace-scoped key is confined
 * to its workspace and an agent-bound key to its bindings. An OAuth
 * token's REST scope follows the HTTP method instead, so
 * {@link loadGuardrails} — a `POST`, although it only reads — needs
 * `memory:write` (a `--read-only` login gets a 403), while
 * {@link getGuardrailDigest} needs only `memory:read`. A read-only OAuth
 * caller loads the set with the MCP `KaguraClient.loadGuardrails`.
 *
 * All methods may reject with:
 * - `KaguraAuthError` — authentication failed (401)
 * - `KaguraNotFoundError` — context not found (404). The 404 is uniform
 *   (CWE-639): unknown, other-workspace and not-yours contexts are
 *   indistinguishable by design. A server older than v0.74.0 also answers
 *   {@link getGuardrailDigest} with a 404.
 * - `KaguraConnectionError` — invalid arguments (422), an OAuth token
 *   without the scope (403), a server older than v0.74.0 answering
 *   {@link loadGuardrails} (405), or any other HTTP/connection error
 * - `KaguraResponseError` — a 2xx body that does not read as the result
 *   (e.g. a {@link GuardrailSet} missing a truncation flag)
 * - `Error` — `context_id` is not a UUID (thrown before any request, with
 *   the Python SDK's `context_id must be a UUID, got '…'`)
 */
export class MemoryClient extends KaguraRestClient {
  /**
   * Load a context's guardrail set (`POST /api/v1/memory/guardrails`).
   *
   * REST twin of `KaguraClient.loadGuardrails`: the same two independently
   * capped lanes and the same truncation flags; check `pinned_truncated` /
   * `tool_triggered_truncated` before trusting the set as complete. This
   * surface carries no context block, so `context_id` / `context_name`
   * are `null`.
   *
   * The body is read as the Python SDK's `GuardrailSet` model reads it: a
   * set missing a required field, a truncation flag included, or holding
   * a field of the wrong type rejects with a `KaguraResponseError`
   * labelled `MemoryClient.load_guardrails` rather than read as complete.
   * Fields are read in pydantic's lax mode (`"50"` is `50`, `"yes"` is
   * `true`), the model's fields only, in its order, with `null` for an
   * optional one the server left out, and a `tool_trigger` that does not
   * read as a trigger is `null` (skip it).
   */
  async loadGuardrails(
    contextId: string,
    options: MemoryLoadGuardrailsOptions = {},
  ): Promise<GuardrailSet> {
    const body: Record<string, unknown> = { context_id: normalizeUuid(contextId, "context_id") };
    if (options.cap !== undefined && options.cap !== null) {
      body.cap = options.cap;
    }
    const resp = await this.request("POST", "/api/v1/memory/guardrails", { json: body });
    return parseGuardrailSet(this.json(resp), "MemoryClient.load_guardrails");
  }

  /**
   * Render a context's tool guardrails (`GET /api/v1/memory/guardrails/digest`).
   *
   * For clients without tool hooks (Codex cloud, ChatGPT, Claude
   * Desktop): summaries only — never content, details or patterns — from
   * the same trusted-only, binding-filtered read as {@link loadGuardrails}.
   *
   * The body is text, returned as is and never parsed. The version header
   * is only stored (`null` when absent): the SDK never compares versions,
   * because the export block's begin marker embeds the version, so an
   * unchanged set is detected by comparing text.
   *
   * `profile` and `tools` are sent whenever they are given, whatever the
   * target, as Python sends them; the server applies them to
   * `"instructions"` only.
   */
  async getGuardrailDigest(
    contextId: string,
    options: GetGuardrailDigestOptions = {},
  ): Promise<GuardrailDigest> {
    const ctx = normalizeUuid(contextId, "context_id");
    const target = options.target ?? "export";
    const params: Record<string, unknown> = { context_id: ctx, target };
    // `request` drops undefined and null but keeps "": an empty value is
    // still sent, as Python's `is not None` checks send it.
    if (options.profile !== undefined) params.profile = options.profile;
    if (options.tools !== undefined) params.tools = options.tools;
    const resp = await this.request("GET", "/api/v1/memory/guardrails/digest", { params });
    return {
      context_id: ctx,
      target,
      text: resp.text,
      tool_triggered_version: resp.headers.get(GUARDRAIL_VERSION_HEADER),
      content_type: resp.headers.get("content-type"),
    };
  }
}
