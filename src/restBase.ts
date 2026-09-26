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
  KaguraNotFoundError,
  KaguraQuotaError,
} from "./errors.js";
import {
  baseUrlFromMcp,
  extractDetail,
  gateError,
  parseErrorEnvelope,
  responseRetryAfter,
  REST_GATE_CODES,
  sanitizeServerDetail,
  SDK_VERSION,
  validateHttpsUrl,
} from "./http.js";
import { JsonNestingError, parseJsonLossless } from "./losslessJson.js";

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
 * Envelope returned by {@link KaguraRestClient.request} for 2xx responses.
 *
 * Beyond the `{status, headers, text}` triple, it carries the request
 * method and path so {@link KaguraRestClient.json} / `expectList` can name
 * the endpoint in shape-mismatch diagnostics (the Python port reads these
 * off `resp.request`; fetch's `Response` has no such back-pointer).
 */
export interface RestResponse {
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

/** Request payload context threaded to the 403 hook (subclass hints only). */
export interface RequestContext {
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
 * - 403 → {@link KaguraFeatureNotAvailableError} / {@link KaguraQuotaError} for a plan
 *   or quota refusal (see {@link gateRefusal}), else the generic
 *   `HTTP 403: <detail>` mapping
 * - 404 → {@link KaguraNotFoundError} (server detail or "Not found")
 * - 429 → {@link KaguraQuotaError} with a tolerant `Retry-After` (else the
 *   body's `details.retry_after`), carrying the refusal's gate payload
 *   when the body has one
 * - other statuses → {@link KaguraConnectionError}
 * - transport errors → {@link KaguraConnectionError}
 */
export class KaguraRestClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;

  /** Supplies the Authorization header for every request (static or OAuth). */
  protected readonly auth: AuthProvider;
  /** Non-null exactly when constructed in OAuth mode (flavors the 401 hint). */
  protected readonly oauth: AuthProvider | null;
  /** Which resolution branch produced the credentials (403 hint flavoring). */
  protected readonly authSource: AuthSource | null;
  /** Workspace bound to the credential source — display only. */
  protected readonly workspaceIdHint: string | null;
  protected readonly fetchImpl: typeof globalThis.fetch;

  /**
   * Initialize with a static API key or a pre-built OAuth provider.
   *
   * @throws Error if neither `apiKey` nor `oauth` is given, or the base
   *   URL is plain HTTP on a non-loopback host.
   */
  constructor(options: KaguraRestClientOptions = {}) {
    if (options.apiKey === undefined && options.oauth === undefined) {
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
    this.fetchImpl = options.fetch ?? globalThis.fetch;

    if (options.oauth !== undefined) {
      // OAuth path: the provider injects a fresh access_token per request
      // and coordinates refresh via the shared credentials state.
      this.auth = options.oauth;
      this.oauth = options.oauth;
    } else {
      // Static path: bake the bearer header once, in a closure — the key
      // is never stored as an instance field.
      const header = `Bearer ${options.apiKey}`;
      this.auth = { getAuthHeader: async () => header };
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
      authorization: await this.auth.getAuthHeader(),
      "user-agent": `kagura-memory-sdk/${SDK_VERSION}`,
    };
    const init: RequestInit = {
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
      status: response.status,
      headers: response.headers,
      text: await this.safeText(response),
      method,
      path: requestPath(url, path),
    };
    if (response.status < 200 || response.status >= 300) {
      throw this.mapStatusError(envelope, {
        requestJson: opts.json,
        requestParams: opts.params,
      });
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
   * Build the Kagura error for a non-2xx response.
   *
   * Hooks RETURN the error rather than throwing it so {@link request}
   * owns the single throw site — one uniform chain and a compiler-checked
   * `KaguraError` contract on every hook.
   */
  protected mapStatusError(response: RestResponse, context: RequestContext): KaguraError {
    const status = response.status;
    if (status === 401) {
      return this.error401(response);
    }
    if (status === 403) {
      return this.error403(response, context);
    }
    if (status === 404) {
      return new KaguraNotFoundError(extractDetail(response.text) || "Not found");
    }
    if (status === 429) {
      return this.error429(response);
    }
    return this.genericError(response);
  }

  // ---- per-status hooks (override where the wire contract differs) ----

  /** 401 → auth error with a recovery hint matching the auth mode. */
  protected error401(response: RestResponse): KaguraError {
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
    const serverMessage =
      parseErrorEnvelope(response.text)?.code === "RATE-001"
        ? sanitizeServerDetail(extractDetail(response.text))
        : null;
    return new KaguraQuotaError(
      serverMessage ?? "Quota exceeded. Try again later.",
      responseRetryAfter(response.headers, response.text),
    );
  }

  /**
   * A plan or quota refusal → its typed error; `null` for any other body.
   *
   * memory-cloud v0.75.0 annotates every such refusal with `details.gate`,
   * and the class follows the gate rather than the status: the
   * resource-token cap is a quota that answers 403. An older server sends
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
    const envelope = parseErrorEnvelope(response.text);
    if (envelope === null) {
      return null;
    }
    return gateError(
      envelope.details,
      envelope.code,
      REST_GATE_CODES,
      sanitizeServerDetail(extractDetail(response.text)) ?? `HTTP ${response.status}`,
      responseRetryAfter(response.headers, response.text),
    );
  }

  /** Any other status → `HTTP <status>: <detail>` connection error. */
  protected genericError(response: RestResponse): KaguraError {
    const detail = extractDetail(response.text);
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
