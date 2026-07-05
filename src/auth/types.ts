/**
 * Auth contracts shared by the credential resolver and the HTTP clients.
 *
 * The Python SDK plugs OAuth refresh in via an httpx.Auth subclass; with
 * fetch there is no request-hook layer, so clients instead ask an
 * `AuthProvider` for a fresh `Authorization` header value before each
 * request.
 */

/** Supplies the `Authorization` header value for each request. */
export interface AuthProvider {
  /**
   * Return the current `Authorization` header value (e.g. `Bearer xyz`),
   * refreshing the underlying token first when it is at/near expiry.
   */
  getAuthHeader(): Promise<string>;
}

/**
 * Which precedence branch produced a static auth result. Pairs an api_key
 * with the workspace it was provisioned for (issue #115).
 */
export type StaticSource = "explicit" | "env" | "config";

/** Superset of StaticSource that also covers the OAuth branch. */
export type AuthSource = StaticSource | "oauth";

/**
 * Human-readable label for each credential source — shared by 403 hint
 * formatting so surfaces never drift.
 */
export const SOURCE_LABEL: Record<AuthSource, string> = {
  explicit: "explicit apiKey argument",
  env: "KAGURA_API_KEY env",
  config: ".kagura.json",
  oauth: "OAuth profile (~/.kagura/credentials.json)",
};

/** Long-lived API key resolution result. */
export interface StaticAuthResult {
  kind: "static";
  apiKey: string;
  mcpUrl: string;
  source: StaticSource;
}

/** OAuth credentials.json resolution result. */
export interface OAuthAuthResult {
  kind: "oauth";
  oauth: AuthProvider;
  mcpUrl: string;
  /** Workspace bound to this token pair at resolution time. */
  workspaceId: string | null;
}

export type ResolvedAuth = StaticAuthResult | OAuthAuthResult;
