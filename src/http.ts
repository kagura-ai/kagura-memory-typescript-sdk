/** Shared HTTP utilities for Kagura Memory SDK clients (port of _http.py). */

import {
  excMessage,
  KaguraAuthError,
  KaguraCapacityLockedError,
  KaguraConnectionError,
  KaguraError,
  KaguraFeatureNotAvailableError,
  KaguraQuotaError,
  KaguraRateLimitError,
  KaguraServiceUnavailableError,
  KaguraVersionConflictError,
} from "./errors.js";
import type { KaguraCapacityLockedErrorOptions, KaguraQuotaErrorOptions } from "./errors.js";
import { normalizeUuid, PY_SPACE_CLASS, pyRepr, pyStrip } from "./pyCompat.js";
import { pyTypeName } from "./python.js";

export { SDK_VERSION } from "./version.js";

/**
 * Derive the REST API base URL from an MCP URL.
 *
 * Drops the query and fragment, then strips `/mcp` and everything after it
 * (e.g. `/mcp/w/{workspace}`). The query (`?profile=`, `?tools=`,
 * `?add_tools=`, `?guardrails=`, `?context=`) configures the MCP endpoint
 * alone, so it is dropped even from a URL with no `/mcp` segment to strip.
 */
export function baseUrlFromMcp(mcpUrl: string): string {
  // `?` and `#` end the path. Callers strip trailing slashes from the raw
  // URL, which misses a slash sitting before the query (`/?profile=core`).
  const end = mcpUrl.search(/[?#]/);
  const path = end === -1 ? mcpUrl : mcpUrl.slice(0, end).replace(/\/+$/, "");
  // Search the path only: the `//` of `https://mcp/mcp` would otherwise
  // read as a `/mcp` segment and cut the URL down to `https:/`.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(path);
  const from = authority ? authority[0].length : 0;
  const m = /\/mcp(?=\/|$)/.exec(path.slice(from));
  return m ? path.slice(0, from + m.index) : path;
}

// --- The MCP URL's endpoint query ------------------------------------------
//
// memory-cloud reads the MCP URL's query with `parse_qsl(keep_blank_values=
// True)`: `&`-separated, names and values `+`/percent-decoded, a segment
// without `=` a blank value, and the first value of a repeated name wins
// (`select_tool_definitions`, `select_default_context`). Every reader and
// writer of that query below follows it, so the SDK, the bins and the
// server read one URL alike.

interface SplitUrl {
  base: string;
  params: string[];
  fragment: string;
}

/**
 * Split a URL by hand rather than through `URL`: `searchParams` re-encodes
 * every parameter on the way out (`tools=a,b` becomes `tools=a%2Cb`), and
 * the other parameters are meant to be kept as written.
 */
function splitUrl(url: string): SplitUrl {
  const hash = url.indexOf("#");
  const fragment = hash === -1 ? "" : url.slice(hash);
  const rest = hash === -1 ? url : url.slice(0, hash);
  const q = rest.indexOf("?");
  return {
    base: q === -1 ? rest : rest.slice(0, q),
    params: q === -1 ? [] : rest.slice(q + 1).split("&").filter((p) => p !== ""),
    fragment,
  };
}

// `ignoreBOM`: a default TextDecoder drops a U+FEFF at the start of each
// decode, which Python's UTF-8 codec (and so the server) keeps.
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * A name or value as Python's `unquote_plus` reads it: `+` is a space, and
 * each run of `%XX` escapes is decoded as UTF-8, an invalid sequence as
 * U+FFFD, a U+FEFF kept; a `%` not followed by two hex digits stays as
 * written.
 */
function unquotePlus(text: string): string {
  const raw = text.replace(/\+/g, " ");
  return raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) =>
    UTF8.decode(Uint8Array.from({ length: run.length / 3 }, (_, i) => parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16))),
  );
}

/**
 * A value as Python's `urlencode(…, safe=",")` writes it (`quote_plus`):
 * `+` for a space, and `!'()*`, which `encodeURIComponent` leaves bare,
 * escaped; a comma stays literal, which keeps a tool list readable in a
 * stored entry (the server splits the decoded value either way).
 */
function quotePlus(text: string): string {
  return encodeURIComponent(text)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+")
    .replace(/%2C/g, ",");
}

/** A parameter's name, decoded: `guard%72ails` is `guardrails`, as the server reads it. */
function paramName(param: string): string {
  const eq = param.indexOf("=");
  return unquotePlus(eq === -1 ? param : param.slice(0, eq));
}

/** A parameter's value, decoded; `""` for a segment without `=`. */
function paramValue(param: string): string {
  const eq = param.indexOf("=");
  return eq === -1 ? "" : unquotePlus(param.slice(eq + 1));
}

/**
 * A split URL put back together with a new query, as Python's
 * `urlunsplit(urlsplit(url)._replace(query=…))` rebuilds it: the scheme
 * lower-cased (`HTTP://` is written `http://`), no `?` for an empty query
 * and no `#` for an empty fragment. The rest stays as written.
 */
function joinUrl(base: string, params: string[], fragment: string): string {
  const scheme = base.replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, (s) => s.toLowerCase());
  return `${scheme}${params.length > 0 ? `?${params.join("&")}` : ""}${fragment.length > 1 ? fragment : ""}`;
}

/** The first value of each parameter in `params`, by decoded name; see {@link mcpUrlQueryValues}. */
function firstValues(params: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const param of params) {
    const name = paramName(param);
    if (!values.has(name)) values.set(name, paramValue(param));
  }
  return values;
}

/**
 * The first value of each parameter in the URL's query, by decoded name —
 * Python's `mcp_url_query_values`. A blank value is kept: `?profile=` is
 * present (and refused by the server), not absent.
 */
export function mcpUrlQueryValues(url: string): Map<string, string> {
  return firstValues(splitUrl(url).params);
}

/**
 * An MCP URL split once ({@link parseMcpUrl}). The composer and the
 * readers below take one in place of the URL, so a command that reads a
 * URL's query and then sets it splits the URL once.
 */
export interface ParsedMcpUrl {
  /** The URL as given. */
  readonly url: string;
  /** The URL before its query and fragment. */
  readonly base: string;
  /** The query's `&`-separated parameters as written, empty ones dropped. */
  readonly params: readonly string[];
  /** `#` and the fragment; `""` without one. */
  readonly fragment: string;
  /**
   * {@link mcpUrlQueryValues} of the URL: each decoded name's first value.
   * Decoded the first time it is read, so a caller that only rewrites the
   * query ({@link withoutQuery}, {@link withoutQueryParam},
   * {@link mcpUrlWithQuery}) decodes no value.
   */
  readonly query: ReadonlyMap<string, string>;
}

/** An MCP URL, as written or already split by {@link parseMcpUrl}. */
export type McpUrl = string | ParsedMcpUrl;

/**
 * The URL split for {@link mcpUrlWithQuery} and the readers, as the server
 * splits it (see above); an already parsed one comes back as it is.
 */
export function parseMcpUrl(url: McpUrl): ParsedMcpUrl {
  if (typeof url !== "string") return url;
  const { base, params, fragment } = splitUrl(url);
  return parsedUrl(url, base, params, fragment);
}

/** The {@link ParsedMcpUrl} of a URL's parts, its `query` decoded when first read. */
function parsedUrl(url: string, base: string, params: readonly string[], fragment: string): ParsedMcpUrl {
  let query: ReadonlyMap<string, string> | undefined;
  return {
    url,
    base,
    params,
    fragment,
    get query(): ReadonlyMap<string, string> {
      query ??= firstValues(params);
      return query;
    },
  };
}

/**
 * The decoded value of the first `key` in the URL's query — the one the
 * server reads — or undefined. Names compare decoded.
 */
export function queryParam(url: McpUrl, key: string): string | undefined {
  return parseMcpUrl(url).query.get(key);
}

/**
 * Whether the URL's first `guardrails` value is `off`, in any case and
 * trimmed — Python's `mcp_url_guardrails_off`, as memory-cloud's
 * `select_guardrail_context` reads it. `off` turns off both guardrail
 * lanes: the server's digest, and the `guardrails` block of
 * `get_context_info`.
 */
export function mcpUrlGuardrailsOff(url: McpUrl): boolean {
  const first = queryParam(url, "guardrails");
  return first !== undefined && pyStrip(first).toLowerCase() === "off";
}

/**
 * Drop `key` from the URL's query, every occurrence, keeping the other
 * parameters as written and leaving no bare `?` behind — Python's
 * `mcp_url_without_query_param`. Names compare decoded; a URL without the
 * key comes back as written, and one it rewrites is rebuilt as Python's is
 * ({@link joinUrl}).
 */
export function withoutQueryParam(url: McpUrl, key: string): string {
  return splitWithoutQueryParam(url, key).url;
}

/**
 * {@link withoutQueryParam}, still split: for a caller that composes the
 * result next ({@link mcpUrlWithQuery}), so the URL is not split again.
 * Its `url` is what {@link withoutQueryParam} returns.
 */
export function splitWithoutQueryParam(url: McpUrl, key: string): ParsedMcpUrl {
  const parsed = parseMcpUrl(url);
  const { base, params, fragment } = parsed;
  const kept = params.filter((param) => paramName(param) !== key);
  if (kept.length === params.length) return parsed;
  return parsedUrl(joinUrl(base, kept, fragment), base, kept, fragment);
}

/**
 * The URL with its query and fragment dropped, rebuilt as Python's
 * `urlunsplit` rebuilds it ({@link joinUrl}): `HTTPS://` is written
 * `https://`, the rest as written.
 */
export function withoutQuery(url: McpUrl): string {
  return joinUrl(parseMcpUrl(url).base, [], "");
}

/**
 * The most names memory-cloud reads from one `tools` or `add_tools` value
 * (its `MAX_TOOL_NAMES`); the rest is ignored.
 */
export const MAX_ADD_TOOLS = 100;

/**
 * The tool names in a comma-separated `value`, by memory-cloud's
 * `_read_names` rule: each item trimmed, blank names dropped, duplicates
 * removed in order. With `cap`, only the first `cap` items are read (blank
 * ones count), as the server reads them; `null` reads every item.
 */
function toolNames(value: string, cap: number | null): string[] {
  const parts = value.split(",");
  const read = cap === null ? parts : parts.slice(0, cap);
  return [...new Set(read.map(pyStrip).filter((name) => name !== ""))];
}

/** Validate a tool name list for `label` (`add_tools`, `tools`) and join it; {@link normalizeAddTools}. */
function normalizeToolNames(names: readonly string[], label: string): string {
  if (!Array.isArray(names)) {
    // Python's words for a str, which it would read a character at a time;
    // any other non-list is named by its Python type too.
    throw new TypeError(`${label} must be a list of tool names, not a ${pyTypeName(names)}`);
  }
  for (const item of names) {
    // Python's `type(item).__name__`: `got int`, `got NoneType`.
    if (typeof item !== "string") throw new TypeError(`${label} items must be str, got ${pyTypeName(item)}`);
  }
  // Every name is read, not the first 100: a longer list is refused below.
  const unique = toolNames(names.join(","), null);
  const dashed = unique.find((name) => name.startsWith("-"));
  if (dashed !== undefined) throw new Error(`${label} names cannot start with '-': ${pyRepr(dashed)}`);
  if (unique.length > MAX_ADD_TOOLS) {
    throw new Error(`${label} accepts at most ${MAX_ADD_TOOLS} tool names, got ${unique.length}`);
  }
  return unique.join(",");
}

/**
 * Validate `?add_tools=` tool names and join them as the server reads them
 * — Python's `normalize_add_tools`.
 *
 * memory-cloud (v0.129.0+, memory-cloud#2354) adds the names to the profile
 * the URL lists: trimmed, case-sensitive, an unknown one ignored, at most
 * 100 read. An item may itself be comma-separated (`"explore,list_edges"`,
 * as the CLI flags take them); blank names are dropped and duplicates
 * removed, keeping the order. A name starting with `-` is refused: no tool
 * has one, and `kagura-memory-mcp --add-tools -x` in a stored entry would
 * not start.
 *
 * @returns The names joined with `,`; `""` when none is left.
 * @throws TypeError `names` is not an array (a string would be read one
 *   character at a time), or an item is not a string.
 * @throws Error More than 100 names, which the server would cut off, or a
 *   name starting with `-`, in the Python SDK's words.
 */
export function normalizeAddTools(names: readonly string[]): string {
  return normalizeToolNames(names, "add_tools");
}

/**
 * `--add-tools NAME[,NAME...]` values (the flag repeats; each value is
 * comma-separated) as one list — the check Python's `_add_tools_option`
 * (`setup *`, `guardrails digest`) and `kagura-mcp`'s `_add_tools_arg`
 * share, which the CLI and the proxy each wrap in their own usage error.
 * A value naming no tool is a typo, so it is refused rather than dropped;
 * so is a name starting with `-`, and more than 100 names in all.
 *
 * @returns The names, normalized by {@link normalizeAddTools} (`[]` for no
 *   values), or the problem in the Python CLI's words.
 */
export function readAddToolsFlag(values: readonly string[]): { names: string[] } | { problem: string } {
  try {
    if (values.some((item) => !normalizeAddTools([item]))) return { problem: "must name at least one tool" };
    const joined = normalizeAddTools(values);
    return { names: joined ? joined.split(",") : [] };
  } catch (e) {
    return { problem: excMessage(e) };
  }
}

/**
 * Validate a tool profile name (`?profile=`) — Python's
 * `normalize_tool_profile`. memory-cloud knows `core` and `full` and fails
 * `tools/list` for any other name, so that list is left to the server.
 * Refused here is what breaks an entry before the server sees it: a blank
 * name, and one starting with `-`, which a stored proxy argv would read as
 * a flag.
 *
 * @returns The name, trimmed.
 * @throws Error The name is blank or starts with `-`, in the Python SDK's words.
 */
export function normalizeToolProfile(value: string): string {
  const name = pyStrip(value);
  if (!name) throw new Error("tool_profile must not be empty");
  if (name.startsWith("-")) throw new Error(`tool_profile cannot start with '-': ${pyRepr(name)}`);
  return name;
}

/**
 * Validate a `?guardrails=` value: `off` in any case, or a context UUID in
 * any spelling Python's `uuid.UUID` accepts — Python's
 * `normalize_guardrails`. memory-cloud silently ignores any other value, so
 * a typo is refused here instead.
 *
 * @returns `"off"` or the canonical UUID.
 * @throws Error `guardrails must be 'off' or a context UUID, got '…'`.
 */
export function normalizeGuardrails(value: string): string {
  const stripped = pyStrip(value);
  if (stripped.toLowerCase() === "off") return "off";
  try {
    return normalizeUuid(stripped, "guardrails");
  } catch {
    throw new Error(`guardrails must be 'off' or a context UUID, got ${pyRepr(value)}`);
  }
}

/** The endpoint query {@link mcpUrlWithQuery} sets; an undefined key is left as it is. */
export interface McpUrlQuery {
  /** `?guardrails=`: `off` or a context UUID, as {@link normalizeGuardrails} returns it (memory-cloud v0.74.0+). */
  guardrails?: string | undefined;
  /** `?profile=`: the tool profile `tools/list` serves (`core`, `full`; v0.73.0+), validated by {@link normalizeToolProfile}. */
  profile?: string | undefined;
  /** `?tools=`: an allowlist, which the server applies instead of `profile` and `add_tools` (v0.73.0+). A list naming no tool leaves the key alone. */
  tools?: readonly string[] | undefined;
  /** `?add_tools=`: names added to the listed profile (v0.129.0+), validated by {@link normalizeAddTools}. A list naming no tool leaves the key alone. */
  addTools?: readonly string[] | undefined;
  /** `?context=`: the connection's default context, a context UUID written canonically (v0.114.0+). */
  context?: string | undefined;
}

/**
 * The MCP URL with memory-cloud's endpoint query set — the port of
 * Python's `mcp_url_with_query`, so the SDK, both bins and the Python CLI
 * write the same URL for the same flags.
 *
 * A key being set loses every earlier value of it (the server reads only
 * the first it finds) and goes at the end, in the order `guardrails`,
 * `profile`, `tools`, `add_tools`, `context`. Every other parameter is
 * kept as written; an unset key is left alone, and with nothing to set the
 * URL comes back as written. A URL it rewrites is rebuilt as Python's is
 * ({@link joinUrl}), the values form-encoded with commas kept literal.
 * Servers older than a key ignore it.
 *
 * `shown.guardrailsAsIs` is for display only: the `guardrails` value goes
 * in as it is, neither validated nor encoded — a dry run's `<UUID of
 * context VALUE>` placeholder, as the Python CLI shows it. Such a URL is
 * never written or run.
 *
 * `url` may be one {@link parseMcpUrl} already split, so a caller that has
 * read its query (a `?tools=` warning, a `guardrails` check) splits it once.
 *
 * @throws Error `guardrails` is neither `off` nor a context UUID
 *   ({@link normalizeGuardrails}), `profile` is blank or starts with `-`, a
 *   tool name starts with `-` or a list names more than 100, or `context`
 *   is not a UUID.
 * @throws TypeError `tools` / `addTools` is not an array of strings.
 */
export function mcpUrlWithQuery(
  url: McpUrl,
  updates: McpUrlQuery,
  shown: { guardrailsAsIs?: boolean } = {},
): string {
  const set: [string, string][] = [];
  if (updates.guardrails !== undefined) {
    const asIs = shown.guardrailsAsIs === true;
    set.push(["guardrails", asIs ? updates.guardrails : normalizeGuardrails(updates.guardrails)]);
  }
  if (updates.profile !== undefined) set.push(["profile", normalizeToolProfile(updates.profile)]);
  const tools = updates.tools !== undefined ? normalizeToolNames(updates.tools, "tools") : "";
  if (tools) set.push(["tools", tools]);
  const added = updates.addTools !== undefined ? normalizeAddTools(updates.addTools) : "";
  if (added) set.push(["add_tools", added]);
  if (updates.context !== undefined) set.push(["context", normalizeUuid(updates.context, "context")]);
  if (set.length === 0) return typeof url === "string" ? url : url.url;
  const keys = set.map(([key]) => key);
  const { base, params, fragment } = parseMcpUrl(url);
  const kept = params.filter((param) => !keys.includes(paramName(param)));
  const encode = (key: string, value: string): string =>
    key === "guardrails" && shown.guardrailsAsIs === true ? value : quotePlus(value);
  return joinUrl(base, [...kept, ...set.map(([key, value]) => `${key}=${encode(key, value)}`)], fragment);
}

/** The `tools/list` view an MCP URL's query selects ({@link mcpUrlToolView}). */
export interface McpToolView {
  /** The first `profile` value, trimmed; `""` for a blank one, which the server refuses; `null` without one (the server's default, `core` from v0.93.0). */
  profile: string | null;
  /** The names in the first `tools` value; `[]` when it names none, which the server refuses; `null` without one. When set, the server ignores `profile` and `add_tools`. */
  tools: string[] | null;
  /** The names in the first `add_tools` value; `[]` without one or when it names none (it then adds nothing). */
  addTools: string[];
}

/**
 * The `profile` / `tools` / `add_tools` in the URL's query, as the server
 * reads them — Python's `mcp_url_tool_view`, the one reader of a URL's
 * tool view for `setup`, `guardrails digest`, `doctor` and the proxy.
 *
 * It follows memory-cloud's `select_tool_definitions`: the first value of
 * a repeated parameter wins, even a blank one, `profile` is trimmed, and a
 * name list is read as `_read_names` reads it — its first 100
 * comma-separated items, trimmed, blank names dropped, duplicates removed
 * in order. Which parameter wins (`tools` over the other two) is left to
 * the caller.
 *
 * `url` may be one {@link parseMcpUrl} already split: the proxy and
 * `setup` read the view and then compose the same URL.
 */
export function mcpUrlToolView(url: McpUrl): McpToolView {
  return mcpQueryToolView(parseMcpUrl(url).query);
}

/**
 * {@link mcpUrlToolView} of a query {@link mcpUrlQueryValues} already read
 * — Python's `mcp_query_tool_view`, for a caller that reads other
 * parameters of the same URL too, so the query is parsed once.
 */
export function mcpQueryToolView(query: ReadonlyMap<string, string>): McpToolView {
  const profile = query.get("profile");
  const tools = query.get("tools");
  return {
    profile: profile === undefined ? null : pyStrip(profile),
    tools: tools === undefined ? null : toolNames(tools, MAX_ADD_TOOLS),
    addTools: toolNames(query.get("add_tools") ?? "", MAX_ADD_TOOLS),
  };
}

function formatValidationErrors(errors: unknown[]): string {
  // Silent-skip malformed entries so a single bad entry doesn't blank the line.
  const parts: string[] = [];
  for (const entry of errors) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const msg = rec.msg;
    if (typeof msg !== "string" || !msg) {
      continue;
    }
    const loc = rec.loc;
    if (Array.isArray(loc) && loc.length > 0) {
      parts.push(`${loc.map(String).join(".")}: ${msg}`);
    } else {
      parts.push(msg);
    }
  }
  return parts.join("; ");
}

/** The `error` object of a JSON-RPC error body, else `null`. */
function jsonRpcError(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const error = (body as Record<string, unknown>).error;
  return typeof error === "object" && error !== null && !Array.isArray(error)
    ? (error as Record<string, unknown>)
    : null;
}

/**
 * Return a useful server-supplied error string from a response body.
 *
 * Handles six response shapes:
 * - `{"detail": "string"}` — returned as-is (FastAPI HTTPException default).
 * - `{"detail": [{"loc": [...], "msg": "...", ...}, ...]}` — FastAPI's
 *   validation-error format; each entry becomes `"<loc.path>: <msg>"`.
 * - `{"error": "<CODE>", "message": "string", "details": {...}}` — the
 *   memory-cloud canonical envelope; returns `message`, appending
 *   `details.errors` validation entries when present.
 * - `{"jsonrpc": "2.0", "error": {"code": int, "message": "string"}}` — the
 *   MCP transport's 4xx for a request it rejects before dispatch; returns
 *   `error.message`, e.g. the expired-session 404's re-initialize hint.
 * - `{"error": "<code>", "error_description": "string"}` — the OAuth-style
 *   body of the MCP transport's workspace-URL 400/403 (and its 401), and of
 *   the OAuth endpoints; returns `error_description`, e.g. "You are not a
 *   member of this workspace."
 * - Anything else — returns an empty string so callers can fall back.
 */
export function extractDetail(bodyText: string): string {
  return detailOf(parseJsonBody(bodyText));
}

/**
 * {@link extractDetail} of a body already decoded ({@link parseJsonBody}).
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function detailOf(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "";
  }
  const rec = body as Record<string, unknown>;
  const detail = rec.detail;
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    return formatValidationErrors(detail);
  }
  const message = rec.message;
  if (typeof message === "string" && message) {
    const details = rec.details;
    if (typeof details === "object" && details !== null && !Array.isArray(details)) {
      const errors = (details as Record<string, unknown>).errors;
      if (Array.isArray(errors)) {
        const formatted = formatValidationErrors(errors);
        if (formatted) {
          return `${message}: ${formatted}`;
        }
      }
    }
    return message;
  }
  const rpcMessage = jsonRpcError(rec)?.message;
  if (typeof rpcMessage === "string" && rpcMessage) {
    return rpcMessage;
  }
  const description = rec.error_description;
  if (typeof description === "string") {
    return description;
  }
  return "";
}

/** Headers naming the MCP session `sessionId` — none before a session exists. */
export function mcpSessionHeader(sessionId: string | null): Record<string, string> {
  return sessionId ? { "mcp-session-id": sessionId } : {};
}

const JSONRPC_METHOD_NOT_FOUND = -32601;

/**
 * Whether a response says the MCP session a request carried is gone (#39).
 *
 * MCP Streamable HTTP answers a request naming a session the server no
 * longer holds with `404`, and the client must then send a new
 * `initialize`. The server keeps legacy (`initialize`-handshake) sessions
 * in process memory and drops them after an idle hour and on every restart.
 * (As deployed, v0.75.0 re-adopts an unknown session id instead of
 * answering `404`, so against it this never fires; it is reached against a
 * server that enforces the spec.)
 *
 * The one `404` that is not about the session is the stateless 2026-07-28
 * `-32601` Method-not-found reply: that path ignores the session id, so
 * re-initializing would only open an orphan session.
 */
export function mcpSessionExpired(
  status: number,
  body: string | ErrorBody,
  sessionId: string | null,
): boolean {
  if (!sessionId || status !== 404) {
    return false;
  }
  return !(body instanceof ErrorBody ? body : new ErrorBody(body)).methodNotFound;
}

/**
 * Drop server-provided detail strings that contain credential markers.
 *
 * A future server bug echoing back the Bearer header or api_key must not
 * be passed straight to the user. Returns `null` when the detail is empty
 * or unsafe to display.
 */
export function sanitizeServerDetail(detail: string | null | undefined): string | null {
  if (!detail) {
    return null;
  }
  const lowered = detail.toLowerCase();
  if (lowered.includes("bearer") || lowered.includes("authorization") || lowered.includes("api_key=")) {
    return null;
  }
  return detail;
}

/**
 * Parse a numeric `Retry-After` header (delta-seconds), else `null`.
 *
 * Only the integer-seconds form is honored; an HTTP-date `Retry-After`
 * (rare for rate limits) is treated as absent rather than mis-parsed.
 */
export function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("Retry-After");
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
}

/** Error codes of the plan and quota refusals, per surface. */
export interface GateCodes {
  plan: readonly string[];
  quota: readonly string[];
}

/**
 * The daily MCP call cap, which every non-read-only tool checks in-band
 * and answers with an error envelope rather than an HTTP 429. It carries
 * no `gate` and names its counts `used_today` / `daily_limit`; the cap
 * counts calls per UTC day.
 */
export const MCP_DAILY_CAP_CODE = "rate_limit_exceeded";

/**
 * MCP envelope codes. `feature_not_available` is the analysis tools'
 * twin of `plan_required`, as REST `FEAT-001` is of both,
 * `setup_connector` forwards the connector seat cap's REST code
 * `CONNECTOR-001` as is, and {@link MCP_DAILY_CAP_CODE} names one cap, so
 * the code alone makes it a quota.
 */
export const MCP_GATE_CODES: GateCodes = {
  plan: ["plan_required", "feature_not_available"],
  quota: ["quota_exceeded", "CONNECTOR-001", MCP_DAILY_CAP_CODE],
};

/**
 * REST canonical-envelope codes. Beside `QUOTA-001`, the quota family has
 * `QUOTA-002` (embedding spend) and `CONNECTOR-001` (connector seats).
 */
export const REST_GATE_CODES: GateCodes = {
  plan: ["FEAT-001"],
  quota: ["QUOTA-001", "QUOTA-002", "CONNECTOR-001"],
};

/** Python 0.44.0's tier quotas; QUOTA-001 also covers non-tier payload limits. */
const TIER_QUOTA_TYPES = new Set([
  "contexts",
  "members",
  "workspace_limit_reached",
  "memories_per_day",
  "memory_analysis",
  "sleep_enabled_contexts",
  "storage_bytes",
  "agents",
  "resource_tokens",
  "connectors",
  "content_chunk_contexts",
  "llm_selector_contexts",
  "embedding_spend_daily",
  "embedding_spend_monthly",
  "api_mcp_daily",
  "api_rest_daily",
  "api_public_daily",
]);

function stringField(block: Record<string, unknown>, key: string): string | null {
  const value = block[key];
  return typeof value === "string" ? value : null;
}

function numberField(block: Record<string, unknown>, key: string): number | null {
  const value = block[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The first of `keys` that holds a number in `block`, else `null`. */
function firstNumberField(block: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = numberField(block, key);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

/**
 * A retry hint sent in the body rather than as a `Retry-After` header:
 * `block[key]` in whole seconds, rounded up, or `null` when it is absent,
 * not a number, or negative.
 *
 * The resource events-per-hour quota is the case that needs it: REST sends
 * `details.retry_after` with no header, and MCP sends `retry_after_seconds`
 * at the top of the envelope.
 */
export function bodyRetryAfter(block: Record<string, unknown>, key: string): number | null {
  const value = numberField(block, key);
  return value === null || value < 0 ? null : Math.ceil(value);
}

/**
 * Seconds to wait before retrying a REST error response: its numeric
 * `Retry-After` header, else the `details.retry_after` of a canonical
 * error body, else `null`. `body` is the response text, or its
 * {@link ErrorBody} when the caller has one, so the body is not decoded
 * again.
 */
export function responseRetryAfter(headers: Headers, body: string | ErrorBody): number | null {
  return envelopeRetryAfter(headers, typeof body === "string" ? parseErrorEnvelope(body) : body.envelope);
}

/** {@link responseRetryAfter} with the body's envelope already read. */
function envelopeRetryAfter(headers: Headers, envelope: ErrorEnvelope | null): number | null {
  const header = retryAfterSeconds(headers);
  if (header !== null) {
    return header;
  }
  return envelope === null ? null : bodyRetryAfter(envelope.details, "retry_after");
}

/**
 * The Free capacity lock (memory-cloud v0.99.0+, #1941): REST `403
 * CAPACITY-001` with `details.gate === "capacity"`, MCP `capacity_locked`.
 * Either code means the lock on either surface, as in the Python SDK.
 */
const CAPACITY_GATE = "capacity";
const CAPACITY_CODES: readonly string[] = ["capacity_locked", "CAPACITY-001"];

/**
 * Which refusal `block` is: `"capacity"`, `"plan"`, `"quota"`, `"generic"`, or `null`
 * for none of them.
 *
 * `block` holds the gate fields: the MCP envelope itself, or a REST
 * body's `details`. The capacity lock comes first, by its `gate` or its
 * code: it is neither a quota nor a plan gate. Then the `gate`
 * (memory-cloud v0.75.0+) decides whenever it is one the SDK knows,
 * because the code alone can mislead: the resource-token cap is a quota
 * that answers 403, and the connector seat cap keeps a code of its own.
 * `allowlist` and `deployment` are the other two reasons a feature is
 * unavailable, so they count as `"plan"` — the kind an older server's bare
 * `FEAT-001` already gets. With no gate, `code` decides against the
 * surface's `codes`. Ambiguous quota codes also need a known tier quota
 * type or a retry window; otherwise they describe a generic refusal.
 */
function gateKind(
  block: Record<string, unknown>,
  code: string | null,
  codes: GateCodes,
  retryAfter: number | null = null,
): "capacity" | "plan" | "quota" | "generic" | null {
  const gate = stringField(block, "gate");
  if (gate === CAPACITY_GATE || (code !== null && CAPACITY_CODES.includes(code))) {
    return "capacity";
  }
  if (gate === "quota") {
    return "quota";
  }
  if (gate === "plan" || gate === "allowlist" || gate === "deployment") {
    return "plan";
  }
  if (code !== null && codes.quota.includes(code)) {
    if (
      (code === "QUOTA-001" || code === "quota_exceeded") &&
      !TIER_QUOTA_TYPES.has(stringField(block, "quota_type") ?? "") &&
      retryAfter === null
    ) {
      return "generic";
    }
    return "quota";
  }
  if (code !== null && codes.plan.includes(code)) {
    return "plan";
  }
  return null;
}

/**
 * Where a refusal's counts live when the canonical `current` / `limit`
 * are absent: the names servers older than v0.75.0 sent instead (v0.75.0
 * adds the canonical pair and keeps these beside it). The daily memory and
 * analysis quotas send `used_today`, the analysis one with `limit_today`;
 * the workspace cap sends `owned_count` / `cap`, and the connector seat
 * cap `active_connectors` / `max_connectors`.
 */
const LEGACY_CURRENT_KEYS = ["used_today", "owned_count", "active_connectors"] as const;
const LEGACY_LIMIT_KEYS = ["limit_today", "cap", "max_connectors"] as const;

/**
 * The gate payload in `block`, camelCased. Wire keys are snake_case; a
 * missing or wrong-typed one reads as `null` rather than trusting the
 * shape. `current` and `limit` fall back to the legacy count names an
 * older server sent instead.
 */
function gateOptions(block: Record<string, unknown>): KaguraQuotaErrorOptions {
  return {
    gate: stringField(block, "gate"),
    feature: stringField(block, "feature"),
    requiredPlan: stringField(block, "required_plan"),
    requiredPlanDisplay: stringField(block, "required_plan_display"),
    currentPlan: stringField(block, "current_plan"),
    quotaType: stringField(block, "quota_type"),
    current: firstNumberField(block, ["current", ...LEGACY_CURRENT_KEYS]),
    limit: firstNumberField(block, ["limit", ...LEGACY_LIMIT_KEYS]),
    usedToday: numberField(block, "used_today"),
    resetsAt: stringField(block, "resets_at"),
  };
}

/** The next UTC midnight, as Python's `datetime.isoformat()` writes it (`+00:00`). */
function nextUtcMidnight(now: Date): string {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return new Date(midnight).toISOString().replace(".000Z", "+00:00");
}

/**
 * The daily MCP cap's envelope with the canonical quota fields it leaves
 * implicit filled in: `quota_type` `api_mcp_daily`, `current` from
 * `used_today`, `limit` from `daily_limit`, and `resets_at` the next UTC
 * midnight. Whatever the server does send wins, as in Python's
 * `gate_error`.
 */
function withMcpDailyCapFields(block: Record<string, unknown>): Record<string, unknown> {
  return {
    quota_type: "api_mcp_daily",
    current: block.used_today,
    limit: block.daily_limit,
    resets_at: nextUtcMidnight(new Date()),
    ...block,
  };
}

/**
 * A whole number at `block[key]`, else `null` (Python's `_opt_int`): a
 * count the server sent as anything else is dropped rather than trusted.
 */
function intField(block: Record<string, unknown>, key: string): number | null {
  const value = block[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** The capacity lock's figures in `block`, camelCased; a wrong-typed one reads `null`. */
function capacityOptions(block: Record<string, unknown>): KaguraCapacityLockedErrorOptions {
  return {
    cleanupUrl: stringField(block, "cleanup_url"),
    memoryCount: intField(block, "memory_count"),
    memoryLimit: intField(block, "memory_limit"),
    overMemories: intField(block, "over_memories"),
    usedBytes: intField(block, "used_bytes"),
    storageLimitBytes: intField(block, "storage_limit_bytes"),
    overBytes: intField(block, "over_bytes"),
  };
}

/** Envelope keys that frame an MCP refusal rather than describe it. */
const ENVELOPE_KEYS: readonly string[] = ["status", "error", "message"];

/** `record` without the keys in `drop`, as a fresh object. */
function without(record: Record<string, unknown>, drop: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!drop.includes(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * An MCP tool-error envelope without its frame (`status` / `error` /
 * `message`), as a fresh object: what the error's `details` keep.
 *
 * Only the MCP envelope is stripped so: there the whole `result` is the
 * refusal. A REST `details` object, a JSON-RPC `data` and an OAuth body are
 * kept as sent, so a server field that happens to be named `status` or
 * `message` there is not lost.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function mcpEnvelopeFields(result: Record<string, unknown>): Record<string, unknown> {
  return without(result, ENVELOPE_KEYS);
}

/**
 * An OAuth-style error body without its `error` (the code), as a fresh
 * object: `error_description` and whatever else the server sent.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function oauthBodyFields(body: Record<string, unknown>): Record<string, unknown> {
  return without(body, ["error"]);
}

/**
 * Build the typed error for a plan, quota or capacity refusal, or `null` if
 * it is none of them: {@link KaguraCapacityLockedError},
 * {@link KaguraFeatureNotAvailableError} or {@link KaguraQuotaError}, as
 * `gateKind` decides, carrying the payload `block` holds. `retryAfter` is
 * the caller's reading of the response's retry hint; with none, a quota
 * error derives it from `resets_at`. The MCP daily call cap
 * ({@link MCP_DAILY_CAP_CODE}) is the `api_mcp_daily` quota, resetting at
 * the next UTC midnight.
 *
 * The error's `code` is `code`, and its `details` are `details` — by
 * default `block` itself, as the server sent it, before the daily cap's
 * canonical names are filled in. The MCP caller passes the envelope
 * without its frame ({@link mcpEnvelopeFields}); a REST `details` block is
 * kept whole. An ambiguous quota code without quota descriptors returns
 * a plain {@link KaguraError}, matching Python's non-tier payload limits.
 */
export function gateError(
  block: Record<string, unknown>,
  code: string | null,
  codes: GateCodes,
  message: string,
  retryAfter: number | null = null,
  details: Record<string, unknown> = block,
): KaguraError | null {
  if (code === MCP_DAILY_CAP_CODE) {
    block = withMcpDailyCapFields(block);
  }
  const bodyRetry = numberField(block, "retry_after_seconds");
  if (retryAfter === null && bodyRetry !== null && Number.isInteger(bodyRetry)) {
    retryAfter = bodyRetry;
  }
  const kind = gateKind(block, code, codes, retryAfter);
  if (kind === null) {
    return null;
  }
  const server = code === null ? { details } : { code, details };
  if (kind === "generic") {
    return new KaguraError(message, server);
  }
  if (kind === "capacity") {
    return new KaguraCapacityLockedError(message, { ...capacityOptions(block), ...server });
  }
  const options = { ...gateOptions(block), ...server };
  return kind === "plan"
    ? new KaguraFeatureNotAvailableError(message, options)
    : new KaguraQuotaError(message, retryAfter, options);
}

/**
 * Type a refused `expectedVersion` (memory-cloud v0.113.0+, #2043): the
 * port of Python's `version_conflict_error` (its #302), or `null` when the
 * error is something else.
 *
 * MCP answers `version_conflict`; REST answers `RES-002` — a code the
 * files API's sha256 dedup 409 shares — told apart by its
 * `details.reason === "version_conflict"`. The caller keeps the server's
 * `code` and fields on the error ({@link annotateServerError}).
 *
 * @param fields The MCP envelope, or the REST `details`.
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function versionConflictError(
  code: string | null | undefined,
  message: string,
  fields: Record<string, unknown>,
): KaguraVersionConflictError | null {
  if (code === "version_conflict" || (code === "RES-002" && fields.reason === "version_conflict")) {
    return new KaguraVersionConflictError(message);
  }
  return null;
}

/**
 * Keep the server's error `code` and its other fields on `err` (Python's
 * `annotate_server_error`).
 *
 * `code` is the server's error code, `undefined` when it sent none (the
 * error then keeps whatever code it has, usually none). `fields` is what
 * came with it, stored as a copy as given — the REST `details`, a JSON-RPC
 * error's `data` or an OAuth body's other fields ({@link serverErrorFields}
 * reads all three); an MCP envelope is passed through
 * {@link mcpEnvelopeFields} first. A `code` or `details` the error already
 * has (a typed error builds its own) is kept.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function annotateServerError<E extends KaguraError>(
  err: E,
  code: string | undefined,
  fields: Record<string, unknown>,
): E {
  // Written once, here, where the server's answer is read; readonly to callers.
  const target = err as unknown as { code: string | undefined; details: Record<string, unknown> };
  if (target.code === undefined && code !== undefined) {
    target.code = code;
  }
  if (Object.keys(target.details).length === 0) {
    target.details = { ...fields };
  }
  return err;
}

/** @internal */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An error response body decoded as JSON, `undefined` when it is not JSON.
 *
 * Decoded once per error response and handed to the readers below
 * ({@link detailOf}, {@link envelopeOf}, {@link serverErrorFieldsOf}), as
 * {@link throwForKaguraStatus} does.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function parseJsonBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    return undefined;
  }
}

/** `[code, fields]` of an error body: see {@link serverErrorFieldsOf}. */
export type ServerErrorFields = [string, Record<string, unknown>];

/**
 * `[code, fields]` of an error body that names an error code, else `null`
 * (Python's `server_error_fields`).
 *
 * Reads the three shapes memory-cloud answers with: the REST envelope
 * `{"error": <code>, "message": …, "details": {…}}` (`fields` is
 * `details`); a JSON-RPC error whose `data` carries `error` — the `/mcp`
 * transport's refusals and server failures, with `cause`,
 * `correlation_id`, `help` and `retryable` (memory-cloud v0.82.0+, #1742;
 * `fields` is `data` without its `error`, the code itself); and the
 * OAuth-style `{"error": <code>, "error_description": …}` (`fields` is the
 * body without `error`). `fields` is always a fresh object.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function serverErrorFieldsOf(body: unknown): ServerErrorFields | null {
  if (!isRecord(body)) {
    return null;
  }
  const error = body.error;
  if (isRecord(error)) {
    const data = error.data;
    return isRecord(data) && typeof data.error === "string" ? [data.error, without(data, ["error"])] : null;
  }
  if (typeof error !== "string") {
    return null;
  }
  if (isRecord(body.details)) {
    return [error, { ...body.details }];
  }
  return [error, oauthBodyFields(body)];
}

/**
 * {@link serverErrorFieldsOf} of a body still to be decoded.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function serverErrorFields(bodyText: string): ServerErrorFields | null {
  return serverErrorFieldsOf(parseJsonBody(bodyText));
}

const INSUFFICIENT_SCOPE = "insufficient_scope";

/**
 * One item of a `WWW-Authenticate` value: a `name=value` parameter (the
 * value a quoted string, RFC 9110 §11.2, or a bare token), else a bare
 * token — an auth-scheme, or the token68 some schemes carry. One value can
 * hold several challenges: fetch joins repeated headers with ", " (RFC
 * 9110 §11.6.1).
 */
const CHALLENGE_ITEM_RE = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))|([^\s,="]+=*)/g;

/**
 * The parameters of the `WWW-Authenticate: Bearer` challenge in `headers`
 * (RFC 6750 §3), names lower-cased; `{}` when there is none. The Bearer
 * challenge may come after another one (`Basic realm="x", Bearer
 * error=…`, a proxy's challenge joined with the server's).
 */
function bearerChallenge(headers: Headers): Record<string, string> {
  const header = headers.get("WWW-Authenticate");
  if (header === null) {
    return {};
  }
  let params: Record<string, string> | null = null;
  for (const match of header.matchAll(CHALLENGE_ITEM_RE)) {
    const scheme = match[4];
    if (scheme !== undefined) {
      if (params !== null) {
        break; // the next challenge starts: the Bearer one is complete
      }
      if (scheme.toLowerCase() === "bearer") {
        params = {};
      }
    } else if (params !== null) {
      const quoted = match[2];
      params[match[1]!.toLowerCase()] = quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : match[3]!;
    }
  }
  return params ?? {};
}

/**
 * The {@link KaguraAuthError} for a 403 `insufficient_scope`, else `null`
 * (Python's `insufficient_scope_error`).
 *
 * memory-cloud v0.79.0+ (#1686) refuses a `tools/call` whose OAuth token
 * lacks the tool's scope — `memory:read` for the read-only tools, `recall`
 * and `get_agent_bootstrap`, `memory:write` for every other tool — with
 * HTTP 403, a `WWW-Authenticate: Bearer error="insufficient_scope"`
 * challenge and a JSON-RPC error whose `data` names `required_scope`. REST
 * `/api/v1/*` sends the challenge with `scope="<required>"`.
 * `data.required_scope` wins: the `/mcp` challenge's `scope` is the granted
 * scopes plus the required one.
 *
 * The error's `code` is `"insufficient_scope"`, and `details.required_scope`
 * names the scope when it is known.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function insufficientScopeError(headers: Headers, bodyText: string): KaguraAuthError | null {
  return insufficientScopeFrom(headers, serverErrorFields(bodyText));
}

/**
 * {@link insufficientScopeError} with the body's {@link serverErrorFieldsOf}
 * already read.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function insufficientScopeFrom(headers: Headers, fields: ServerErrorFields | null): KaguraAuthError | null {
  const data = fields !== null && fields[0] === INSUFFICIENT_SCOPE ? fields[1] : null;
  const challenge = bearerChallenge(headers);
  if (data === null && challenge.error !== INSUFFICIENT_SCOPE) {
    return null;
  }
  const scope = stringField(data ?? {}, "required_scope") || challenge.scope || null;
  const needs = scope ? `the ${scope} scope` : "a scope";
  const err = new KaguraAuthError(
    `The OAuth sign-in lacks ${needs} this call needs (HTTP 403 insufficient_scope). ` +
      "Run `kagura-memory auth login` to sign in again with it; a `--read-only` login grants " +
      "memory:read only.",
  );
  annotateServerError(err, INSUFFICIENT_SCOPE, data ?? {});
  if (scope) {
    err.details.required_scope = scope;
  }
  return err;
}

/**
 * The {@link KaguraServiceUnavailableError} for an HTTP 503 (Python's
 * `service_unavailable_error`).
 *
 * `retryAfter` is the numeric `Retry-After` header, else a JSON-RPC
 * `data.retry_after_seconds`; `reason` is the REST `details.reason`
 * (`DB-002`, memory-cloud v0.104.0+), else the MCP `cause`, else the error
 * code (`/mcp`'s `temporarily_unavailable`, v0.82.0+). The error keeps the
 * body's code and fields.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function serviceUnavailableError(
  headers: Headers,
  message: string,
  bodyText: string,
): KaguraServiceUnavailableError {
  return serviceUnavailableFrom(headers, message, serverErrorFields(bodyText));
}

/**
 * {@link serviceUnavailableError} with the body's
 * {@link serverErrorFieldsOf} already read.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export function serviceUnavailableFrom(
  headers: Headers,
  message: string,
  fields: ServerErrorFields | null,
): KaguraServiceUnavailableError {
  const code = fields === null ? null : fields[0];
  const data = fields === null ? {} : fields[1];
  const retryAfter = retryAfterSeconds(headers) ?? intField(data, "retry_after_seconds");
  const reason = stringField(data, "reason") || stringField(data, "cause") || code;
  const err = new KaguraServiceUnavailableError(message, { retryAfter, reason });
  return code === null ? err : annotateServerError(err, code, data);
}

/** `HTTP <status>: <detail>`, or the bare status when there is no detail. */
function statusMessage(status: number, detail: string): string {
  // Avoid a doubled "HTTP 500: HTTP 500" when the body carries no detail.
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

/** A canonical REST error body split into its code and details block. */
export interface ErrorEnvelope {
  code: string | null;
  details: Record<string, unknown>;
}

/**
 * Split a canonical `{"error", "message", "details"}` REST body into its
 * code and details block; `null` for any other body.
 */
export function parseErrorEnvelope(bodyText: string): ErrorEnvelope | null {
  return envelopeOf(parseJsonBody(bodyText));
}

/** {@link parseErrorEnvelope} of a body already decoded ({@link parseJsonBody}). */
function envelopeOf(body: unknown): ErrorEnvelope | null {
  if (!isRecord(body)) {
    return null;
  }
  const details = body.details;
  return {
    code: typeof body.error === "string" ? body.error : null,
    details: isRecord(details) ? details : {},
  };
}

// Error bodies are JSON trees. Copy them iteratively so extra OAuth metadata
// cannot turn a known refusal into structuredClone's recursion RangeError.
function copyJsonFields(fields: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  const pending: Array<[object, object]> = [[fields, copy]];
  while (pending.length > 0) {
    const [source, target] = pending.pop()!;
    for (const [key, value] of Object.entries(source)) {
      const nested = typeof value === "object" && value !== null;
      const copied = nested ? (Array.isArray(value) ? [] : {}) : value;
      Object.defineProperty(target, key, { value: copied, writable: true, enumerable: true, configurable: true });
      if (nested) pending.push([value, copied as object]);
    }
  }
  return copy;
}

/**
 * A non-2xx response's body, decoded at most once and read each way the
 * error mapping needs it — Python's `ErrorBody` (python-sdk#311).
 *
 * Nothing is decoded until a reader asks (a 401 never does), and each
 * reader is computed once. The decoded body is never handed out, and each
 * reader that returns part of it returns its own deep copy of that part
 * (Python copies the whole body per reader, `_copy`), so no two readers,
 * and no reader and the body, share a mutable object — as when every
 * reader decoded the body itself. A body that is not JSON reads as
 * nothing in every reader.
 *
 * `KaguraRestClient` builds one per error response (its `errorBody`), and
 * its hooks read that instead of decoding the body again;
 * {@link throwForKaguraStatus} and {@link responseRetryAfter} take one in
 * place of the text.
 *
 * @internal Shared by the SDK's error mapping; not exported from the package.
 */
export class ErrorBody {
  /** The body as received. */
  readonly text: string;
  private decodedBody: { value: unknown } | undefined;
  private detailText: string | undefined;
  private envelopeBlock: ErrorEnvelope | null | undefined;
  private errorFields: ServerErrorFields | null | undefined;
  private oauthFields: { error: string; description: string; fields: Record<string, unknown> } | undefined;

  constructor(text: string) {
    this.text = text;
  }

  /**
   * The body decoded as JSON ({@link parseJsonBody}); `undefined` when it
   * is not JSON. Private, as Python's `_decoded`: the readers below only
   * read it.
   */
  private get decoded(): unknown {
    this.decodedBody ??= { value: parseJsonBody(this.text) };
    return this.decodedBody.value;
  }

  /** The stateless JSON-RPC refusal that must not trigger session renewal. */
  get methodNotFound(): boolean {
    return jsonRpcError(this.decoded)?.code === JSONRPC_METHOD_NOT_FOUND;
  }

  /** Top-level OAuth error fields, without another decode of the response. */
  get oauth(): { error: string; description: string; fields: Record<string, unknown> } {
    if (this.oauthFields !== undefined) return this.oauthFields;
    const body = isRecord(this.decoded) ? this.decoded : {};
    return this.oauthFields = {
      error: typeof body.error === "string" ? body.error : "",
      description: typeof body.error_description === "string" ? body.error_description : "",
      fields: copyJsonFields(oauthBodyFields(body)),
    };
  }

  /** {@link extractDetail} of the body: the server's message, or `""`. */
  get detail(): string {
    this.detailText ??= detailOf(this.decoded);
    return this.detailText;
  }

  /**
   * {@link parseErrorEnvelope} of the body: its code and `details`, or
   * `null` for a body that is no JSON object. `details` is this reader's
   * own copy.
   */
  get envelope(): ErrorEnvelope | null {
    if (this.envelopeBlock === undefined) {
      const envelope = envelopeOf(this.decoded);
      this.envelopeBlock = envelope === null ? null : { code: envelope.code, details: copyJsonFields(envelope.details) };
    }
    return this.envelopeBlock;
  }

  /**
   * {@link serverErrorFields} of the body: `[code, fields]`, or `null` when
   * it names no error code. `fields` is this reader's own copy.
   */
  get fields(): ServerErrorFields | null {
    if (this.errorFields === undefined) {
      const fields = serverErrorFieldsOf(this.decoded);
      this.errorFields = fields === null ? null : [fields[0], copyJsonFields(fields[1])];
    }
    return this.errorFields;
  }
}

/**
 * Translate a non-2xx HTTP response into the matching Kagura error.
 *
 * Maps 401 → KaguraAuthError, a 403 `insufficient_scope` (an OAuth token
 * without the scope the call needs, memory-cloud v0.79.0+, #1686) →
 * KaguraAuthError naming the scope, 429 → KaguraRateLimitError (honoring
 * a numeric `Retry-After` header, else the body's `details.retry_after`),
 * 503 → KaguraServiceUnavailableError (its `Retry-After` and reason), and
 * every other status → KaguraConnectionError. The server-supplied detail
 * is appended when present, otherwise `fallbackMessage` is used so the
 * status is never left bare. The error code and fields the body carried
 * (a JSON-RPC error's `data`, the REST `details`, an OAuth body's fields)
 * are kept as the error's `code` / `details`. The body is decoded once,
 * for every reader: `body` is the response text, or the {@link ErrorBody}
 * a caller that read the body itself already built (Python's `body=`), so
 * it is decoded at most once between them. This function always throws.
 *
 * A 429 that is a typed quota refusal (the daily call quota) keeps its
 * class, which existing handlers catch, but carries the quota's gate
 * payload; any other 429 leaves it `null`.
 */
export function throwForKaguraStatus(
  status: number,
  headers: Headers,
  body: string | ErrorBody,
  fallbackMessage?: string,
): never {
  const read = typeof body === "string" ? new ErrorBody(body) : body;
  const fields = read.fields;
  if (status === 401) {
    const err = new KaguraAuthError("Authentication failed. Check your API key.");
    throw fields === null ? err : annotateServerError(err, fields[0], fields[1]);
  }
  if (status === 403) {
    const scopeError = insufficientScopeFrom(headers, fields);
    if (scopeError !== null) {
      throw scopeError;
    }
  }
  const detail = read.detail || fallbackMessage || "";
  let err: KaguraError;
  if (status === 429) {
    const envelope = read.envelope;
    err = new KaguraRateLimitError(
      `Rate limit exceeded (HTTP 429): ${detail || `HTTP ${status}`}`,
      envelopeRetryAfter(headers, envelope),
      envelope !== null &&
        gateKind(envelope.details, envelope.code, REST_GATE_CODES, envelopeRetryAfter(headers, envelope)) === "quota"
        ? gateOptions(envelope.details)
        : {},
    );
  } else if (status === 503) {
    err = serviceUnavailableFrom(headers, statusMessage(status, detail), fields);
  } else {
    err = new KaguraConnectionError(statusMessage(status, detail));
  }
  throw fields === null ? err : annotateServerError(err, fields[0], fields[1]);
}

// Plain-HTTP is permitted only for genuine loopback hosts. The host token must
// be followed by a boundary — a port (:\d+), a path/query/fragment delimiter,
// or end-of-string — so a prefix-match attack like http://localhost.evil.com
// or a userinfo trick like http://localhost@evil.com cannot smuggle an
// external host past the check (#189).
// Both patterns are case-insensitive: URL parsing lower-cases the scheme
// and host, so `HTTP://EVIL.TEST` is fetched over plaintext exactly like
// `http://evil.test`. A case-sensitive guard would wave it through. Without
// the `u` flag, `/i` never folds a non-ASCII letter to an ASCII one, so no
// Unicode case fold (`ſ` → `s`) spells `localhost`: Python's `re.ASCII`.
// Any `http:` scheme counts, slashes or not: WHATWG parsers (fetch among
// them) read `http:/evil.com`, `http:evil.com` and `http:\\evil.com` as
// `http://evil.com`, and a loopback URL written that way is refused.
const PLAIN_HTTP_RE = /^http:/i;
const LOCALHOST_HTTP_RE = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

/**
 * What a URL parser drops before it reads the scheme: whitespace and C0
 * controls around the URL, and (WHATWG: fetch, browsers, the harnesses
 * `setup` writes for) a tab or newline anywhere in it. The whitespace is
 * Python's `\s`, so the class is Python's `_URL_IGNORED_RE` exactly; it
 * strips some Unicode spaces (U+3000) WHATWG keeps, which only makes the
 * check more conservative.
 */
const URL_SPACE = `\\x00-\\x20${PY_SPACE_CLASS}`;
const URL_IGNORED_RE = new RegExp(`^[${URL_SPACE}]+|[${URL_SPACE}]+$|[\\t\\n\\r]`, "g");

/**
 * Return `url` as a URL parser reads it, before it reads the scheme: the
 * port of the Python SDK's `normalize_url`.
 *
 * Surrounding whitespace and C0 controls go, and so does any tab or
 * newline inside it. Nothing else changes: the scheme and host keep their
 * case.
 */
export function normalizeUrl(url: string): string {
  return url.replace(URL_IGNORED_RE, "");
}

/**
 * Enforce HTTPS except for localhost development.
 *
 * The URL is checked as a parser reads it ({@link normalizeUrl}), the
 * scheme and host in any case: `" HTTP://evil.com"`, `"ht\ttp://evil.com"`
 * and `"http:evil.com"` all reach the network as plain HTTP to `evil.com`,
 * and are all refused (python-sdk#274). The message shows the normalized
 * URL.
 *
 * @throws Error if the URL uses HTTP and is not a loopback host.
 */
export function validateHttpsUrl(url: string, label = "URL"): void {
  // Both patterns are anchored, so without normalizing first they would
  // never match a URL a parser reads as plain HTTP after dropping what
  // surrounds it, and the guard would pass. Normalize here rather than
  // relying on callers to have done it.
  const candidate = normalizeUrl(url);
  if (PLAIN_HTTP_RE.test(candidate) && !LOCALHOST_HTTP_RE.test(candidate)) {
    throw new Error(
      `${label} must use HTTPS for security (got: ${candidate}). ` +
        "HTTP is only allowed for localhost development.",
    );
  }
}
