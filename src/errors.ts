/** Custom errors for the Kagura Memory SDK (port of exceptions.py). */

/**
 * Subset of the standard DOM/Node `ErrorOptions`. Declared locally so the
 * published `.d.ts` does not force consumers onto an ES2022 `lib` just to
 * reference our error constructors.
 */
export interface KaguraErrorOptions {
  cause?: unknown;
}

/**
 * Return `String(e)` when non-empty, otherwise the constructor name.
 *
 * Defensive fallback so an unmessaged error still produces a non-empty
 * diagnostic when interpolated into a user-facing error string.
 */
export function excMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message || e.constructor.name;
  }
  const s = String(e);
  return s || (typeof e === "object" && e !== null ? e.constructor.name : "unknown error");
}

/** Base error for the Kagura SDK. */
export class KaguraError extends Error {
  constructor(message: string, options?: KaguraErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Authentication failed. */
export class KaguraAuthError extends KaguraError {}

/**
 * OAuth refresh token expired or invalid.
 *
 * Raised when an attempted refresh returns `invalid_grant` (or the server
 * otherwise indicates that the stored refresh token can no longer be used).
 * The caller must re-authenticate via `kagura auth login`.
 */
export class KaguraAuthExpiredError extends KaguraAuthError {
  readonly expiresAt: Date | null;

  constructor(message: string, expiresAt: Date | null = null, options?: KaguraErrorOptions) {
    super(message, options);
    this.expiresAt = expiresAt;
  }
}

/** User denied authorization at the device-flow consent screen. */
export class KaguraAuthDeniedError extends KaguraAuthError {}

/** Connection to Kagura server failed. */
export class KaguraConnectionError extends KaguraError {}

/** Requested resource not found (HTTP 404). */
export class KaguraNotFoundError extends KaguraError {}

/** Rate limit exceeded. */
export class KaguraRateLimitError extends KaguraError {
  readonly retryAfter: number | null;

  constructor(message: string, retryAfter: number | null = null, options?: KaguraErrorOptions) {
    super(message, options);
    this.retryAfter = retryAfter;
  }
}

/** LLM call failed. */
export class KaguraLLMError extends KaguraError {}

/** Context not found or invalid. */
export class KaguraContextError extends KaguraError {}

/** Resource token quota exceeded (events per hour). */
export class KaguraQuotaError extends KaguraError {
  readonly retryAfter: number | null;

  constructor(message: string, retryAfter: number | null = null, options?: KaguraErrorOptions) {
    super(message, options);
    this.retryAfter = retryAfter;
  }
}

/**
 * Object store rejected an upload with HTTP 400.
 *
 * Raised for any HTTP 400 response from the object store on a presigned
 * PUT — most commonly R2 `BadDigest` (the body's sha256 did not match the
 * value bound into the presigned PUT URL), but also covers other 400
 * causes such as a malformed presigned URL or a Content-Length mismatch.
 */
export class KaguraIntegrityError extends KaguraError {}

/**
 * URL or file fetch failed (SSRF guard, byte cap, redirect loop, etc.).
 *
 * The original URL/path is exposed via the `url` property so callers can
 * present it without re-parsing the message.
 */
export class KaguraFetchError extends KaguraError {
  readonly url: string | null;

  constructor(message: string, url: string | null = null, options?: KaguraErrorOptions) {
    super(message, options);
    this.url = url;
  }
}

/** File ingestion orchestration failed for a non-fetch reason. */
export class KaguraIngestError extends KaguraError {}
