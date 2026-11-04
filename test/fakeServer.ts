import { KaguraClient } from "../src/client.js";

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/**
 * The server's reply to a request naming an MCP session it no longer holds
 * — one dropped after an idle hour or by a restart (#39).
 */
export const SESSION_EXPIRED_BODY = {
  jsonrpc: "2.0",
  error: {
    code: -32603,
    message: "MCP session not found or expired. Please re-initialize your connection.",
    data: { action: "Send a new 'initialize' request without Mcp-Session-Id header" },
  },
  id: null,
};

/** Arguments memory-cloud accepts on every tool without declaring them. */
const ALWAYS_ACCEPTED = new Set(["_meta"]);
/** How many unknown names the refusal echoes back. */
const MAX_UNKNOWN_SHOWN = 10;

/**
 * The `invalid_argument` envelope memory-cloud v0.82.0+ answers when a
 * `tools/call` carries arguments the tool's inputSchema does not declare
 * (memory-cloud#1742; `find_unknown_arguments` in
 * `backend/src/mcp_server/tools/_arg_coercion.py`), or `null` when every
 * argument is declared. The server also suggests the closest declared name
 * for a misspelled one (difflib) and cuts a name past 64 characters; this
 * fake does neither, so `suggestions` is always empty and the names in the
 * message carry no "(did you mean …?)".
 */
export function undeclaredArgumentRefusal(
  tool: string,
  args: Record<string, unknown>,
  declared: readonly string[],
): Record<string, unknown> | null {
  const accepted = new Set(declared);
  const unknown = Object.keys(args)
    .filter((name) => !accepted.has(name) && !ALWAYS_ACCEPTED.has(name))
    .sort();
  if (unknown.length === 0) return null;
  const shown = unknown.slice(0, MAX_UNKNOWN_SHOWN);
  const more = unknown.length - shown.length;
  const listed = shown.map((name) => `'${name}'`).join(", ") + (more > 0 ? ` and ${more} more` : "");
  const allowed = [...declared].sort();
  return {
    status: "error",
    error: "invalid_argument",
    message:
      `${tool} does not accept the ${unknown.length === 1 ? "argument" : "arguments"} ${listed}. ` +
      `Arguments its inputSchema declares: ${allowed.join(", ")}.`,
    unknown_arguments: shown,
    allowed_arguments: allowed,
    suggestions: {},
    help:
      "Remove the unknown arguments or rename them as suggested, then call the " +
      "tool again. tools/list shows each tool's inputSchema.",
  };
}

/**
 * Minimal fake MCP + REST server behind a fetch stub — the TS analogue of
 * the httpx MockTransport used by the Python test suite.
 */
export class FakeServer {
  requests: Recorded[] = [];
  /** Tool name → payload object serialized into content[0].text. */
  toolResults: Record<string, unknown> = {};
  /**
   * Tool name → the argument names its inputSchema declares. A call to a
   * tool listed here that sends any other argument is refused as
   * memory-cloud v0.82.0+ refuses it ({@link undeclaredArgumentRefusal}, in
   * a result flagged `isError`), whatever {@link toolResults} holds; a tool
   * not listed accepts anything, as servers before v0.82.0 did.
   */
  declaredArguments: Record<string, readonly string[]> = {};
  /** Tool name → content[0].text as sent, beating {@link toolResults}. */
  toolTexts: Record<string, string> = {};
  /**
   * Tool name → the content[0].text of each call in turn, beating
   * {@link toolTexts} until it runs out. A text whose `status` is `"error"`
   * comes in a result flagged `isError`, as the server sends it.
   */
  toolTextQueues: Record<string, string[]> = {};
  /** URL path → REST GET JSON response. */
  restResults: Record<string, unknown> = {};
  /** URL path → the REST GET status and exact body, beating {@link restResults}. */
  restResponses: Record<string, { status: number; body: string }> = {};
  /** When set, every request returns this raw response. */
  forcedResponse: Response | null = null;
  sessionId: string | null = "session-123";
  /** Dropped session ids: a request naming one gets a 404 {@link SESSION_EXPIRED_BODY}. */
  expiredSessions = new Set<string>();

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    this.requests.push({ url, method: init?.method ?? "GET", headers, body });

    if (this.forcedResponse) {
      return this.forcedResponse.clone();
    }

    const session = headers["mcp-session-id"];
    if (session !== undefined && this.expiredSessions.has(session)) {
      return new Response(JSON.stringify(SESSION_EXPIRED_BODY), { status: 404 });
    }

    const rpcMethod = body?.method;
    if (rpcMethod === "initialize") {
      const responseHeaders: Record<string, string> = {};
      if (this.sessionId) {
        responseHeaders["mcp-session-id"] = this.sessionId;
      }
      return new Response("{}", { status: 200, headers: responseHeaders });
    }
    if (rpcMethod === "tools/call") {
      const params = body?.params as { name: string; arguments?: Record<string, unknown> };
      const declared = this.declaredArguments[params.name];
      const refusal =
        declared === undefined ? null : undeclaredArgumentRefusal(params.name, params.arguments ?? {}, declared);
      if (refusal !== null) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: JSON.stringify(refusal) }], isError: true },
          }),
          { status: 200 },
        );
      }
      const queued = this.toolTextQueues[params.name]?.shift();
      if (queued !== undefined) {
        let isError = false;
        try {
          isError = (JSON.parse(queued) as { status?: unknown } | null)?.status === "error";
        } catch {
          // A text that is not JSON is sent as given, for the client to refuse.
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: queued }], ...(isError ? { isError: true } : {}) },
          }),
          { status: 200 },
        );
      }
      const payload = this.toolResults[params.name] ?? { status: "success" };
      const text = this.toolTexts[params.name] ?? JSON.stringify(payload);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text }] },
        }),
        { status: 200 },
      );
    }
    if (rpcMethod === "tools/list") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "recall" }] } }),
        { status: 200 },
      );
    }

    // REST GET
    const path = new URL(url).pathname;
    const raw = this.restResponses[path];
    if (raw !== undefined) {
      return new Response(raw.body, { status: raw.status, headers: { "content-type": "application/json" } });
    }
    const payload = this.restResults[path];
    if (payload === undefined) {
      return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  };

  /** Wire body of the Nth tools/call request (0-based among tool calls). */
  toolCallArgs(n = 0): Record<string, unknown> {
    const calls = this.requests.filter((r) => r.body?.method === "tools/call");
    const params = calls[n]?.body?.params as { arguments: Record<string, unknown> };
    return params.arguments;
  }

  /** `[JSON-RPC method, mcp-session-id]` of every request, in order. */
  calls(): Array<[unknown, string | undefined]> {
    return this.requests.map((r) => [r.body?.method, r.headers["mcp-session-id"]]);
  }
}

export function makeClient(server: FakeServer, options: Record<string, unknown> = {}): KaguraClient {
  return new KaguraClient({
    apiKey: "test-key",
    mcpUrl: "https://x.test/mcp",
    fetch: server.fetch,
    ...options,
  });
}

export interface RecordedRest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * Scripted REST fetch stub — the TS analogue of the Python httpx
 * MockTransport. Shared superset of the per-file FakeRest stubs so new
 * REST-client test files stop growing their own copies.
 */
export class FakeRest {
  requests: RecordedRest[] = [];
  status = 200;
  body = "{}";
  responseHeaders: Record<string, string> = {};
  /** When set, fetch throws this instead of responding. */
  error: unknown = null;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    this.requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (this.error !== null) {
      throw this.error;
    }
    // The WHATWG Response constructor forbids a body on null-body statuses
    // (204/205/304); real servers send an empty body there too.
    const nullBodyStatus = this.status === 204 || this.status === 205 || this.status === 304;
    return new Response(nullBodyStatus ? null : this.body, {
      status: this.status,
      headers: this.responseHeaders,
    });
  };
}
