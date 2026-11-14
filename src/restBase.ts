/**
 * Shared construction/auth/lifecycle/error spine for Kagura REST clients
 * (port of _rest_base.py).
 *
 * FilesClient, ResourceClient, SecretClient, and WorkspaceClient would
 * otherwise carry near-verbatim copies of the same scaffolding — and the
 * Python copies had already drifted (403 credential scrubbing and the
 * OAuth-aware 401 hint existed in some clients but not others).
 * {@link KaguraRestClient} owns the spine once; each client keeps only its
 * wire-contract differences via the `error401`/`error403`/`error429`
 * builder hooks.
 *
 * Invariants the base enforces for every client:
 *
 * - credentials are required up front (`apiKey` or an `AuthProvider`) with
 *   an actionable error naming the class's factory;
 * - HTTPS-only base URLs (loopback exempt) via `validateHttpsUrl`;
 * - the API key is baked into the `Authorization` header closure exactly
 *   once and never stored as an instance field;
 * - every request carries `User-Agent: kagura-memory-sdk/<version>` and an
 *   `AbortSignal.timeout` deadline.
 */

import { resolveAuth } from "./auth/resolve.js";
import type { AuthProvider, AuthSource, ResolvedAuth } from "./auth/types.js";
import {
  excMessage,
  KaguraAuthError,
  KaguraConnectionError,
  KaguraError,
  KaguraFileBlockedError,
  KaguraFileScanPendingError,
  KaguraNotFoundError,
  KaguraQuotaError,
} from "./errors.js";
import {
  annotateServerError,
  baseUrlFromMcp,
  ErrorBody,
  gateError,
  insufficientScopeFrom,
  responseRetryAfter,
  REST_GATE_CODES,
  retryAfterSeconds,
  sanitizeServerDetail,
  SDK_VERSION,
  serviceUnavailableFrom,
  validateHttpsUrl,
  versionConflictError,
} from "./http.js";
import type { ServerErrorFields } from "./http.js";
import { JsonNestingError, parseJsonLossless } from "./losslessJson.js";
import { pathSegment } from "./pathSegment.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Strictly require an integer — no float truncation, no string parse.
 *
 * Truncating `7.9` would silently target a DIFFERENT resource id on a
 * destructive endpoint (the TS signature says `number`, which admits
 * floats), so fail loudly instead. The same goes for a whole number past
 * `Number.MAX_SAFE_INTEGER`: `9007199254740993` is already
 * `9007199254740992` by the time it gets here, a different id than the
 * one meant. Such an id is passed as a `bigint`, which is exact, as
 * Python's `int` is.
 *
 * Internal: the REST clients' id arguments; not exported from the package.
 */
export function requireInt<T extends number | bigint>(value: T, label: string): T {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer, got ${JSON.stringify(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `${label} must be a safe integer or a bigint, got ${String(value)}: a number past ` +
        "Number.MAX_SAFE_INTEGER may already be rounded to a different id",
    );
  }
  return value;
}

/**
 * A public id as one REST path segment: an integer (the servers before
 * memory-cloud v0.89.0) or an opaque string (v0.89.0+, `akey_…`, `rtok_…`,
 * `winv_…`, `skey_…`; memory-cloud#1008).
 *
 * An integer goes through {@link requireInt}, so it is still exact. A
 * string must have something besides whitespace and is percent-encoded
 * whole by `pathSegment`, which also refuses `.` and `..`. Anything else
 * throws before a request is sent.
 *
 * Internal: the REST clients' id arguments; not exported from the package.
 */
export function requirePublicId(value: number | bigint | string, label: string): string {
  if (typeof value === "string") {
    if (value.trim() === "") {
      throw new Error(`${label} must be a non-empty id, got ${JSON.stringify(value)}`);
    }
    return pathSegment(value, label, "an id");
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(requireInt(value, label));
  }
  throw new Error(`${label} must be an integer or a string id, got ${JSON.stringify(value)}`);
}

/** Default REST API origin when no MCP URL or base URL is supplied. */
export const DEFAULT_REST_BASE_URL = "https://memory.kagura-ai.com";

export interface KaguraRestClientOptions {
  /**
   * Kagura API key (Bearer token). Required unless `oauth` is supplied.
   * For credential resolution (the auto chain env → `~/.kagura/
   * credentials.json` → `.kagura.json`), use `fromMcpUrl` — a bare
   * constructor deliberately does not read disk state.
   */
  apiKey?: string;
  /** REST API base URL without path (default: {@link DEFAULT_REST_BASE_URL}). */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
  /**
   * Pre-built OAuth provider. `fromMcpUrl` passes one when the resolver
   * picked an OAuth profile; it injects a fresh access token per request.
   */
  oauth?: AuthProvider;
  /**
   * Provenance tag from `resolveAuth`; clients use it to flavor 403
   * hints (issue #115).
   */
  authSource?: AuthSource;
  /**
   * Workspace UUID associated with the credential source — hint display
   * only, never sent on the wire.
   */
  workspaceIdHint?: string | null;
  /** Fetch implementation override (for tests; default: globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
}

export interface FromMcpUrlOptions {
  /** Explicit Kagura API key. Skips the resolution chain. */
  apiKey?: string;
  /**
   * Explicit MCP URL. When omitted, the resolved credential source's
   * stored URL is used (default `https://memory.kagura-ai.com/mcp`).
   */
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
}

/**
 * Envelope returned by {@link KaguraRestClient.request} for 2xx responses,
 * and handed to the error hooks for any other.
 *
 * Beyond the `{status, headers, text}` triple, it carries the request
 * method and path so {@link KaguraRestClient.json} / `expectList` can name
 * the endpoint in shape-mismatch diagnostics (the Python port reads these
 * off `resp.request`; fetch's `Response` has no such back-pointer).
 */
export interface RestResponse {
  /** True for routes authenticated by an existing web session. */
  session?: boolean;
  status: number;
  headers: Headers;
  text: string;
  method: HttpMethod;
  /**
   * The request URL's path as the Python SDK names it (httpx's
   * `url.path`): the whole path, a base URL's own prefix included, with
   * `%XX` escapes decoded — `/kagura/api/v1/…/members/a@b/credentials`.
   */
  path: string;
  /**
   * A non-2xx response's body, decoded at most once — the `body` Python's
   * `_request` hands every hook (python-sdk#311). Set by
   * {@link KaguraRestClient.request} and read through
   * {@link KaguraRestClient.errorBody}, so a hook handed a copy of the
   * response (`{...response}`) reads the same decoded body. Absent on a
   * 2xx response.
   */
  errorBody?: ErrorBody;
}

/**
 * Python's `urllib.parse.unquote`, which httpx's `URL.path` applies: each
 * run of `%XX` escapes decoded as UTF-8, a byte that is no UTF-8 as
 * U+FFFD, and anything else (`%zz`, a lone `%`) kept as it is.
 */
function pyUnquote(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = Uint8Array.from(run.slice(1).split("%"), (hex) => parseInt(hex, 16));
    // ignoreBOM keeps a leading U+FEFF, which Python does not strip either.
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  });
}

/**
 * The path a request went to, for diagnostics: {@link RestResponse.path}.
 * Parsed as fetch parses it, so dot segments are resolved as they were on
 * the wire; `fallback` (the path as the client wrote it) for a URL that
 * does not parse, which fetch would have refused already.
 */
function requestPath(url: string, fallback: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return fallback;
  }
  return pyUnquote(pathname);
}

/**
 * Options for {@link restClientFromAuth} — the ones the protected
 * {@link KaguraRestClient.fromResolvedAuth} takes.
 *
 * @internal Shared with the CLI; not part of the package's API.
 */
export interface FromResolvedAuthOptions {
  timeoutMs?: number;
  /** Workspace bound to a static key's source, for 403 hints only (#115). */
  workspaceIdHint?: string | null;
  fetch?: typeof globalThis.fetch;
}

/** Request payload context threaded to the 401 and 403 hooks (subclass hints only). */
export interface RequestContext {
  typedPermissionErrors?: boolean;
  /**
   * What a session route's call does, for its 401 message
   * (`"read workspace operation history"`); set with `session`.
   */
  sessionAction?: string;
  requestJson: Record<string, unknown> | undefined;
  requestParams: Record<string, unknown> | undefined;
}

/**
 * Build `Client` from a credential the caller already resolved — the CLI's
 * one door to the protected {@link KaguraRestClient.fromResolvedAuth}.
 *
 * A command runner resolves the credential once so it can take the
 * workspace from the same source (#115), and must then build its client
 * from exactly that credential rather than resolve a second time. This
 * calls `Client.fromResolvedAuth` instead of re-implementing it, so a
 * subclass override stays in the path: `ResourceClient` stamps the MCP URL
 * `setupResource` needs there.
 *
 * @internal Shared with the CLI; not part of the package's API. The entry
 * point does not export it, and the factory it reaches stays `protected`
 * so the published declarations are unchanged.
 */
export function restClientFromAuth<T extends typeof KaguraRestClient>(
  Client: T,
  resolved: ResolvedAuth,
  options: FromResolvedAuthOptions = {},
): InstanceType<T> {
  // The cast only lifts `protected` for this call; the method is invoked
  // on `Client` itself so the polymorphic `this` still picks the subclass.
  const factory = (
    Client as unknown as {
      fromResolvedAuth: (
        this: T,
        resolved: ResolvedAuth,
        options: FromResolvedAuthOptions,
      ) => InstanceType<T>;
    }
  ).fromResolvedAuth;
  return factory.call(Client, resolved, options);
}

/** `typeof`-style name for shape-mismatch diagnostics (`null` → "null"). */
function jsonTypeName(value: unknown): string {
  return value === null ? "null" : typeof value;
}

/**
 * Base class for the Kagura REST API clients.
 *
 * Subclasses add their domain methods on top of {@link request} and
 * override the `error*` builder hooks where their contract differs. The
 * default hooks implement the majority behavior:
 *
 * - 401 → {@link KaguraAuthError} with an OAuth-aware recovery hint
 * - 403 `insufficient_scope` (an OAuth token without the scope the method
 *   needs, memory-cloud v0.79.0+) → {@link KaguraAuthError} naming the
 *   scope, before any client's 403 hook
 * - 403 → {@link KaguraCapacityLockedError} for the Free capacity lock
 *   (`CAPACITY-001`, `details.gate === "capacity"`, v0.99.0+),
 *   {@link KaguraFeatureNotAvailableError} / {@link KaguraQuotaError} for a
 *   plan or quota refusal (see {@link gateRefusal}), else the generic
 *   `HTTP 403: <detail>` mapping
 * - 404 → {@link KaguraNotFoundError} (server detail or "Not found")
 * - 429 → {@link KaguraQuotaError} with a tolerant `Retry-After` (else the
 *   body's `details.retry_after`), carrying the refusal's gate payload
 *   when the body has one
 * - 503 (`DB-002`, the database unavailable) →
 *   {@link KaguraServiceUnavailableError} with `retryAfter` from
 *   `Retry-After` and `reason` from `details.reason`
 * - a refused `expectedVersion` (memory `PATCH`'s `409 RES-002` with
 *   `details.reason === "version_conflict"`, v0.113.0+, #2043) →
 *   {@link KaguraVersionConflictError}, whatever the status and before
 *   every hook
 * - a download the malware scan holds (`409 SCAN-001`, memory-cloud
 *   v0.160.0+, #565) → {@link KaguraFileScanPendingError} with `retryAfter`
 *   from `Retry-After`, and one it blocked (`409 SCAN-002`) →
 *   {@link KaguraFileBlockedError}; both are {@link KaguraConnectionError}s,
 *   the class such a 409 had before
 * - other statuses → {@link KaguraConnectionError}, e.g. the files API's
 *   sha256 dedup `409 RES-002` (no `reason`)
 * - transport errors → {@link KaguraConnectionError}
 * - whatever the class, an error built from a response keeps the body's
 *   error code as `code` and its `details` (the REST envelope's `details`,
 *   or an OAuth-style body's fields) as `details` — set by {@link request},
 *   so every hook's error gets them too
 *
 * The error body is decoded once, however many hooks read it: they read
 * it through {@link errorBody}, never from `response.text`.
 */
export class KaguraRestClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;

  /** Supplies the Authorization header for every request (static or OAuth). */
  private readonly bearer: AuthProvider | null;
  protected get auth(): AuthProvider {
    if (this.bearer === null) {
      throw new KaguraAuthError("This operation requires a bearer credential. Use a workspace-owner API key.");
    }
    return this.bearer;
  }
  /** Non-null exactly when constructed in OAuth mode (flavors the 401 hint). */
  protected readonly oauth: AuthProvider | null;
  /** Which resolution branch produced the credentials (403 hint flavoring). */
  protected readonly authSource: AuthSource | null;
  /** Workspace bound to the credential source — display only. */
  protected readonly workspaceIdHint: string | null;
  protected readonly fetchImpl: typeof globalThis.fetch;
  /**
   * `true` when constructed in session mode: the client holds no bearer
   * credential, and its session routes rely on the caller's web session.
   */
  protected readonly sessionMode: boolean;

  /**
   * Initialize with a static API key or a pre-built OAuth provider.
   *
   * @throws Error if neither `apiKey` nor `oauth` is given, or the base
   *   URL is plain HTTP on a non-loopback host.
   */
  constructor(options: KaguraRestClientOptions = {}, mode: "bearer" | "session" = "bearer") {
    if (mode === "bearer" && options.apiKey === undefined && options.oauth === undefined) {
      const name = new.target.name;
      throw new Error(
        `${name} requires apiKey, or use ${name}.fromMcpUrl(...) to resolve ` +
          "credentials from environment, OAuth profile, or .kagura.json.",
      );
    }

    const strippedUrl = (options.baseUrl ?? DEFAULT_REST_BASE_URL).replace(/\/+$/, "");
    validateHttpsUrl(strippedUrl, "Base URL");
    this.baseUrl = strippedUrl;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    // Chosen now, called as a plain function: a browser's fetch throws
    // "Illegal invocation" when the client is its receiver (#142).
    const fetchFn = options.fetch ?? globalThis.fetch;
    this.fetchImpl = (input, init) => fetchFn(input, init);

    this.sessionMode = mode === "session";
    if (mode === "session") {
      this.bearer = null;
      this.oauth = null;
    } else if (options.oauth !== undefined) {
      // OAuth path: the provider injects a fresh access_token per request
      // and coordinates refresh via the shared credentials state.
      this.bearer = options.oauth;
      this.oauth = options.oauth;
    } else {
      // Static path: bake the bearer header once, in a closure — the key
      // is never stored as an instance field.
      const header = `Bearer ${options.apiKey}`;
      this.bearer = { getAuthHeader: async () => header };
      this.oauth = null;
    }
    this.authSource = options.authSource ?? null;
    this.workspaceIdHint = options.workspaceIdHint ?? null;
  }

  // -------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------

  /**
   * Create a client by resolving credentials from the SDK chain.
   *
   * Precedence: explicit `apiKey` > `KAGURA_API_KEY` env > OAuth profile
   * from `~/.kagura/credentials.json` > `.kagura.json`. The REST
   * `baseUrl` is derived from the resolved MCP URL (strips `/mcp` and any
   * `/mcp/w/{workspaceId}` suffix, and drops any query such as
   * `?profile=core`); a static key bakes the Bearer header
   * once, an OAuth profile installs an auto-refreshing `AuthProvider`.
   *
   * Declared with a polymorphic `this` so every subclass inherits a
   * factory returning its own type: `FilesClient.fromMcpUrl(...)` is a
   * `FilesClient`.
   */
  static fromMcpUrl<T extends typeof KaguraRestClient>(
    this: T,
    options: FromMcpUrlOptions = {},
  ): InstanceType<T> {
    const resolved = resolveAuth({
      apiKey: options.apiKey ?? null,
      mcpUrl: options.mcpUrl ?? null,
      profile: options.profile ?? null,
      env: options.env,
      home: options.home,
    });
    return this.fromResolvedAuth(resolved, {
      timeoutMs: options.timeoutMs,
      fetch: options.fetch,
    });
  }

  /**
   * Construct from a pre-resolved auth — internal CLI helper.
   *
   * Shared by {@link fromMcpUrl} (SDK entry) and CLI command runners,
   * which resolve once so apiKey and workspace can be paired from the
   * same credential source (#115).
   *
   * `workspaceIdHint` threads the workspace bound to a static apiKey into
   * the client for 403 hint display. On the OAuth branch the resolver
   * already carries `workspaceId`, so the hint is taken from there and
   * the option is ignored.
   */
  protected static fromResolvedAuth<T extends typeof KaguraRestClient>(
    this: T,
    resolved: ResolvedAuth,
    options: {
      timeoutMs?: number;
      workspaceIdHint?: string | null;
      fetch?: typeof globalThis.fetch;
    } = {},
  ): InstanceType<T> {
    const baseUrl = baseUrlFromMcp(resolved.mcpUrl.replace(/\/+$/, ""));
    const shared: KaguraRestClientOptions = { baseUrl };
    if (options.timeoutMs !== undefined) {
      shared.timeoutMs = options.timeoutMs;
    }
    if (options.fetch !== undefined) {
      shared.fetch = options.fetch;
    }
    if (resolved.kind === "static") {
      return new this({
        ...shared,
        apiKey: resolved.apiKey,
        authSource: resolved.source,
        workspaceIdHint: options.workspaceIdHint ?? null,
      }) as InstanceType<T>;
    }
    return new this({
      ...shared,
      oauth: resolved.oauth,
      authSource: "oauth",
      workspaceIdHint: resolved.workspaceId,
    }) as InstanceType<T>;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  /** Release resources. (fetch has no persistent pool to close; kept for API parity.) */
  async close(): Promise<void> {
    // No-op by design; subclasses with real resources override.
  }

  // -------------------------------------------------------------------
  // Request spine
  // -------------------------------------------------------------------

  /**
   * Make an authenticated request with standard error mapping.
   *
   * Returns the {@link RestResponse} envelope for 2xx; throws the mapped
   * {@link KaguraError} for any other status and wraps transport/abort
   * failures in {@link KaguraConnectionError}.
   */
  protected async request(
    method: HttpMethod,
    path: string,
    opts: {
      json?: Record<string, unknown>;
      params?: Record<string, unknown>;
      extraHeaders?: Record<string, string>;
      session?: boolean;
      /** What the call does, for a session route's 401 message ({@link RequestContext.sessionAction}). */
      sessionAction?: string;
      typedPermissionErrors?: boolean;
    } = {},
  ): Promise<RestResponse> {
    let url = `${this.baseUrl}${path}`;
    if (opts.params) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(opts.params)) {
        if (value !== undefined && value !== null) {
          query.set(key, String(value));
        }
      }
      const qs = query.toString();
      if (qs) {
        url += `?${qs}`;
      }
    }

    const headers: Record<string, string> = {
      ...(opts.session ? {} : { authorization: await this.auth.getAuthHeader() }),
      "user-agent": `kagura-memory-sdk/${SDK_VERSION}`,
    };
    const init: RequestInit = {
      ...(opts.session ? { credentials: "include", redirect: "error" } as const : {}),
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.json);
    }
    // Extra headers merge last so a caller can override a default —
    // mirrors httpx's per-request header precedence in the Python port.
    Object.assign(headers, opts.extraHeaders);

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (e) {
      throw new KaguraConnectionError(`Connection failed: ${excMessage(e)}`, { cause: e });
    }

    const envelope: RestResponse = {
      ...(opts.session ? { session: true } : {}),
      status: response.status,
      headers: response.headers,
      text: await this.safeText(response),
      method,
      path: requestPath(url, path),
    };
    if (response.status < 200 || response.status >= 300) {
      // Decoded once, for the scope and 503 errors and the annotation
      // below, and carried on the response for every hook.
      envelope.errorBody = new ErrorBody(envelope.text);
      const fields = envelope.errorBody.fields;
      const err = this.mapStatusError(
        envelope,
        {
          requestJson: opts.json,
          requestParams: opts.params,
          ...(opts.typedPermissionErrors ? { typedPermissionErrors: true } : {}),
          ...(opts.sessionAction === undefined ? {} : { sessionAction: opts.sessionAction }),
        },
        fields,
      );
      // One place for every hook: a typed error keeps what it already set.
      throw fields === null ? err : annotateServerError(err, fields[0], fields[1]);
    }
    return envelope;
  }

  private async safeText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  /**
   * The {@link ErrorBody} of the error `response`: its body decoded at
   * most once, however many hooks read it — Python's `ErrorBody`, which
   * `_request` builds and hands to every hook (python-sdk#311). A hook
   * reads the server's detail, envelope and fields here rather than
   * decoding `response.text` again.
   *
   * {@link request} sets {@link RestResponse.errorBody}, and a copy of the
   * response carries it along. A response without one, or whose `text` is
   * not the one it decoded (a hook rebuilt it with other text), gets a new
   * one, kept on the response for the next reader.
   */
  protected errorBody(response: RestResponse): ErrorBody {
    if (response.errorBody === undefined || response.errorBody.text !== response.text) {
      response.errorBody = new ErrorBody(response.text);
    }
    return response.errorBody;
  }

  /**
   * Build the Kagura error for a non-2xx response.
   *
   * Hooks RETURN the error rather than throwing it so {@link request}
   * owns the single throw site — one uniform chain and a compiler-checked
   * `KaguraError` contract on every hook.
   */
  protected mapStatusError(
    response: RestResponse,
    context: RequestContext,
    fields: ServerErrorFields | null = this.errorBody(response).fields,
  ): KaguraError {
    const conflict = this.versionConflictRefusal(response, fields);
    if (conflict !== null) {
      return conflict;
    }
    const scan = this.fileScanRefusal(response, fields);
    if (scan !== null) {
      return scan;
    }
    const status = response.status;
    if (status === 401) {
      return this.error401(response, context);
    }
    if (status === 403) {
      return insufficientScopeFrom(response.headers, fields) ?? this.error403(response, context);
    }
    if (status === 404) {
      return new KaguraNotFoundError(this.errorBody(response).detail || "Not found");
    }
    if (status === 429) {
      return this.error429(response);
    }
    if (status === 503) {
      const detail = this.errorBody(response).detail;
      return serviceUnavailableFrom(response.headers, detail ? `HTTP 503: ${detail}` : "HTTP 503", fields);
    }
    return this.genericError(response);
  }

  // ---- per-status hooks (override where the wire contract differs) ----

  /** 401 → auth error with a recovery hint matching the auth mode. */
  protected error401(_response: RestResponse, _context?: RequestContext): KaguraError {
    const hint =
      this.oauth !== null
        ? "Re-run `kagura auth login` or inspect ~/.kagura/credentials.json."
        : "Check your API key.";
    return new KaguraAuthError(`Authentication failed. ${hint}`);
  }

  /**
   * 403 → a plan or quota refusal's typed error, else the generic
   * mapping; clients with a richer story (workspace hints, secret
   * existence-hiding) override this, asking {@link gateRefusal} first.
   */
  protected error403(response: RestResponse, context: RequestContext): KaguraError {
    return this.gateRefusal(response) ?? this.genericError(response);
  }

  /**
   * 429 → quota error with a tolerant `Retry-After` parse, falling back to
   * the body's `details.retry_after` when there is no header. A typed
   * refusal (the member seat cap, a daily quota) keeps the server's
   * message and adds its gate payload. A `RATE-001` body (the resource
   * events-per-hour quota, which sends its retry hint only in the body)
   * keeps the server's message too, scrubbed of credential markers; any
   * other 429 gets the fixed text. A 429 stays a {@link KaguraQuotaError}
   * even when its body reads as a plan refusal.
   */
  protected error429(response: RestResponse): KaguraError {
    const gated = this.gateRefusal(response);
    if (gated instanceof KaguraQuotaError) {
      return gated;
    }
    const body = this.errorBody(response);
    const serverMessage = body.envelope?.code === "RATE-001" ? sanitizeServerDetail(body.detail) : null;
    return new KaguraQuotaError(
      serverMessage ?? "Quota exceeded. Try again later.",
      responseRetryAfter(response.headers, body),
    );
  }

  /**
   * A plan, quota or capacity refusal → its typed error; `null` for any
   * other body.
   *
   * memory-cloud v0.75.0 annotates every such refusal with `details.gate`,
   * and the class follows the gate rather than the status: the
   * resource-token cap is a quota that answers 403, and the Free capacity
   * lock (`403 CAPACITY-001`, `gate: "capacity"`, v0.99.0+) is
   * {@link KaguraCapacityLockedError}. An older server sends
   * no gate, so the `FEAT-001` / `QUOTA-001` / `QUOTA-002` /
   * `CONNECTOR-001` code decides. A body that is neither (a role denial, a
   * pre-v0.75 `HTTP-403` plan message) gets `null`, and the hook maps it
   * as it always did.
   *
   * Every 403 hook, the subclass overrides included, asks this first, so
   * a plan refusal never reads as a credential problem; so does every 429
   * hook but SecretClient's, which keeps 429 generic by design, and a 429
   * hook keeps only a {@link KaguraQuotaError}. The message is the
   * server's own, scrubbed of credential markers: it names the feature or
   * cap and the plan that lifts it.
   */
  protected gateRefusal(response: RestResponse): KaguraError | null {
    const body = this.errorBody(response);
    const envelope = body.envelope;
    if (envelope === null) {
      return null;
    }
    return gateError(
      envelope.details,
      envelope.code,
      REST_GATE_CODES,
      sanitizeServerDetail(body.detail) ?? `HTTP ${response.status}`,
      responseRetryAfter(response.headers, body),
    );
  }

  /**
   * A refused `expectedVersion` → {@link KaguraVersionConflictError}; `null`
   * for any other body (Python's `_version_conflict_error`, its #302).
   *
   * Memory `PATCH` answers `409 RES-002` with `details.reason ===
   * "version_conflict"` (memory-cloud v0.113.0+, #2043). The files API's
   * dedup `409 RES-002` has no such reason and stays the generic error
   * `FilesClient.upload` reads its `existing_file` from. The message is the
   * server's own, scrubbed of credential markers.
   *
   * @param fields The body's decoded `[code, details]`
   *   ({@link mapStatusError}'s), so any other error returns here without
   *   reading the body again; only a conflict reads its message, from the
   *   same decoded body ({@link errorBody}).
   */
  protected versionConflictRefusal(response: RestResponse, fields: ServerErrorFields | null): KaguraError | null {
    if (fields === null || fields[0] !== "RES-002" || fields[1].reason !== "version_conflict") {
      return null;
    }
    return versionConflictError(
      fields[0],
      sanitizeServerDetail(this.errorBody(response).detail) ?? `HTTP ${response.status}`,
      fields[1],
    );
  }

  /**
   * A download the malware scan holds → its typed error; `null` for any
   * other response (the Python SDK's `_file_scan_error`, its #337).
   *
   * From memory-cloud v0.160.0 (#565), with upload scanning on,
   * `GET /api/v1/files/{id}/download-url` answers `409 SCAN-001` while the
   * file's scan is pending (`Retry-After: 30`) and `409 SCAN-002` once the
   * scan blocked it, each with `details` `{file_id, scan_status}`; an
   * `infected` file is refused with scanning off too. Read by status and
   * code only, so a 404 stays {@link KaguraNotFoundError} (the server
   * checks access first) and the files API's dedup `409 RES-002` stays the
   * generic error `FilesClient.upload` reads its `existing_file` from. The
   * message is `HTTP 409: ` and the server's own, scrubbed of credential
   * markers; {@link request} keeps the code and `details` on the error.
   *
   * @param fields The body's decoded `[code, details]` ({@link mapStatusError}'s).
   */
  protected fileScanRefusal(response: RestResponse, fields: ServerErrorFields | null): KaguraError | null {
    if (response.status !== 409 || fields === null) {
      return null;
    }
    const code = fields[0];
    if (code !== "SCAN-001" && code !== "SCAN-002") {
      return null;
    }
    const detail = sanitizeServerDetail(this.errorBody(response).detail);
    const message = detail ? `HTTP 409: ${detail}` : "HTTP 409";
    return code === "SCAN-001"
      ? new KaguraFileScanPendingError(message, { retryAfter: retryAfterSeconds(response.headers) })
      : new KaguraFileBlockedError(message);
  }

  /** Any other status → `HTTP <status>: <detail>` connection error. */
  protected genericError(response: RestResponse): KaguraError {
    const detail = this.errorBody(response).detail;
    const msg = detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`;
    return new KaguraConnectionError(msg);
  }

  // -------------------------------------------------------------------
  // Response-body helpers
  // -------------------------------------------------------------------

  /**
   * Parse a 2xx body as JSON, mapping garbage to a Kagura error.
   *
   * A proxy/CDN can 200 with an HTML maintenance page; that must not
   * surface as a raw `SyntaxError`. The body is read as Python's
   * `resp.json()` reads it (`parseJsonLossless`, #69): `NaN` and
   * `Infinity` are numbers, and the key order and number literals are
   * kept for the typed readers and the CLI's dumps. A body nested past
   * `MAX_JSON_DEPTH` is Python's `RecursionError`, which `_json` does not
   * catch: it is thrown as it is.
   */
  protected json(response: RestResponse): unknown {
    try {
      return parseJsonLossless(response.text);
    } catch (e) {
      if (e instanceof JsonNestingError) throw e;
      throw new KaguraConnectionError(
        `Server returned a non-JSON body (HTTP ${response.status}) for ` +
          `${response.method} ${response.path}.`,
        { cause: e },
      );
    }
  }

  /** Parse a 2xx body that the contract says is a JSON array. */
  protected expectList(response: RestResponse): unknown[] {
    const payload = this.json(response);
    if (!Array.isArray(payload)) {
      throw new KaguraConnectionError(
        `Unexpected response shape for ${response.method} ${response.path}: ` +
          `expected a JSON array, got ${jsonTypeName(payload)}.`,
      );
    }
    return payload;
  }
}
