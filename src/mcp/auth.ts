import { ProxyError } from "./errors.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  getSharedState,
  KaguraOAuth,
  loadCredentialsFile,
  profileNamed,
} from "../auth/credentials.js";
import { login } from "../auth/login.js";
import { DEFAULT_MCP_URL } from "../auth/resolve.js";
import { openBrowser } from "../cli/openBrowser.js";
import { KaguraAuthExpiredError, KaguraAuthDeniedError } from "../errors.js";
import { baseUrlFromMcp, validateHttpsUrl } from "../http.js";

export interface ProxyAuthOptions {
  profile?: string;
  server?: string;
  credentialsPath?: string;
  login?: boolean;
  openBrowser?: boolean;
  loginTimeoutMs?: number;
  signal: AbortSignal;
  fetch?: typeof fetch;
  open?: (url: string) => Promise<boolean>;
  log: (message: string) => void;
}

/** Validate before sending either an access token or a refresh token. */
export function checkedUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new ProxyError(
      "Use an HTTP(S) server URL without embedded credentials or a fragment.",
    );
  }
  validateHttpsUrl(url.href, "Server URL");
  return url;
}

/** Owns the desktop login UX; credential persistence/rotation stays in the SDK. */
export class ProxyAuth {
  readonly mcpUrl: string;
  private readonly profile: string;
  private oauth?: KaguraOAuth;
  private loginAttempt?: Promise<void>;
  private loginAttempted = false;
  private readonly authFetch: typeof fetch;

  constructor(private readonly options: ProxyAuthOptions) {
    const file = loadCredentialsFile(options.credentialsPath);
    this.profile = options.profile || file.defaultProfile;
    const stored = profileNamed(file, this.profile);
    this.mcpUrl = checkedUrl(
      options.server || stored?.mcpUrl || DEFAULT_MCP_URL,
    ).href;
    const base = checkedUrl(baseUrlFromMcp(this.mcpUrl)).href;
    if (
      stored &&
      (checkedUrl(baseUrlFromMcp(stored.mcpUrl)).href !== base ||
        checkedUrl(stored.server).href !== base)
    ) {
      throw new ProxyError(
        "This OAuth profile belongs to a different server. Select a separate --profile for this server.",
      );
    }
    // fetch's timeout signal remains active while the OAuth helper reads the body.
    // Reject redirects: a 307/308 could forward refresh credentials in a POST body.
    this.authFetch = async (input, init) => {
      const timer = AbortSignal.timeout(30_000);
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      const signals = [
        options.signal,
        timer,
        ...(init?.signal ? [init.signal] : []),
      ];
      if (
        !String(input).startsWith(`${base.replace(/\/$/, "")}/api/v1/oauth/`)
      ) {
        throw new ProxyError(
          "OAuth profile server changed. Restart with the correct profile.",
        );
      }
      for (const signal of signals) {
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
      try {
        const response = await (options.fetch ?? fetch)(input, {
          ...init,
          redirect: "error",
          signal: controller.signal,
        });
        // OAuth bodies are small; buffering here also covers body-read stalls.
        const body = await response.arrayBuffer();
        return new Response(body.byteLength ? body : null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } finally {
        for (const signal of signals)
          signal.removeEventListener("abort", abort);
      }
    };
    this.reload();
  }

  private reload(): void {
    const state = getSharedState(this.options.credentialsPath, this.profile);
    if (state) {
      const base = checkedUrl(baseUrlFromMcp(this.mcpUrl)).href;
      if (
        checkedUrl(state.credentials.server).href !== base ||
        checkedUrl(baseUrlFromMcp(state.credentials.mcpUrl)).href !== base
      ) {
        throw new ProxyError(
          "OAuth profile server changed. Restart with the correct profile.",
        );
      }
      this.oauth = new KaguraOAuth(state, { fetch: this.authFetch });
    } else this.oauth = undefined;
  }

  async getAuthHeader(): Promise<string> {
    this.reload();
    if (!this.oauth) await this.authenticate();
    try {
      return await this.oauth!.getAuthHeader();
    } catch (error) {
      if (!(error instanceof KaguraAuthExpiredError)) throw error;
      await this.authenticate();
      return this.oauth!.getAuthHeader();
    }
  }

  async forceRefresh(): Promise<void> {
    this.reload();
    if (!this.oauth) return this.authenticate();
    try {
      await this.oauth.forceRefresh();
    } catch (error) {
      if (!(error instanceof KaguraAuthExpiredError)) throw error;
      await this.authenticate();
    }
  }

  private async authenticate(): Promise<void> {
    if (this.loginAttempt) return this.loginAttempt;
    if (this.options.login === false || this.loginAttempted) {
      throw new ProxyError(
        "Login required. Restart the extension to sign in, or run kagura-memory auth login with the same --profile and --server.",
      );
    }
    this.loginAttempted = true;
    this.loginAttempt = this.deviceLogin().finally(() => {
      this.loginAttempt = undefined;
    });
    return this.loginAttempt;
  }

  private async deviceLogin(): Promise<void> {
    const options = this.options;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, options.loginTimeoutMs ?? 300_000);
    const loginFetch: typeof fetch = (input, init) => {
      controller.signal.throwIfAborted();
      // The outer wrapper bounds body reads; this signal bounds the entire login.
      return this.authFetch(input, { ...init, signal: controller.signal });
    };
    try {
      const stored = profileNamed(loadCredentialsFile(options.credentialsPath), this.profile);
      await login({
        mcpUrl: this.mcpUrl,
        profile: this.profile,
        credentialsPath: options.credentialsPath,
        clientId: stored?.clientId,
        scope: stored?.scope || undefined,
        env: {},
        fetch: loginFetch,
        onWarning: options.log,
        sleep: async (ms) => {
          await delay(ms, undefined, { signal: controller.signal });
        },
        onUserCode: async (auth) => {
          const url = checkedUrl(auth.verificationUriComplete).href;
          options.log(
            `Sign in to Kagura: ${url}\nVerification code: ${auth.userCode}\nApprove in your browser. If the host times out, restart the extension after signing in.`,
          );
          if (
            options.openBrowser !== false &&
            !(await (options.open ?? openBrowser)(url))
          ) {
            options.log(
              "Could not open your browser. Open the sign-in URL above manually.",
            );
          }
        },
      });
      this.reload();
      options.log("Kagura login complete.");
    } catch (error) {
      if (
        controller.signal.aborted ||
        error instanceof KaguraAuthExpiredError
      ) {
        throw new ProxyError(
          "Login timed out or was cancelled. Restart the extension to try again.",
        );
      }
      if (error instanceof KaguraAuthDeniedError) {
        throw new ProxyError(
          "Login was denied. Restart the extension when you are ready to approve access.",
        );
      }
      // OAuth responses may echo tokens: do not copy their bodies into MCP/logs.
      throw new ProxyError(
        "Kagura login failed. Check the configured server and connection, then restart the extension.",
      );
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
    }
  }
}
