import { KaguraClient } from "../src/client.js";

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/**
 * Minimal fake MCP + REST server behind a fetch stub — the TS analogue of
 * the httpx MockTransport used by the Python test suite.
 */
export class FakeServer {
  requests: Recorded[] = [];
  /** Tool name → payload object serialized into content[0].text. */
  toolResults: Record<string, unknown> = {};
  /** URL path → REST GET JSON response. */
  restResults: Record<string, unknown> = {};
  /** When set, every request returns this raw response. */
  forcedResponse: Response | null = null;
  sessionId: string | null = "session-123";

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

    const rpcMethod = body?.method;
    if (rpcMethod === "initialize") {
      const responseHeaders: Record<string, string> = {};
      if (this.sessionId) {
        responseHeaders["mcp-session-id"] = this.sessionId;
      }
      return new Response("{}", { status: 200, headers: responseHeaders });
    }
    if (rpcMethod === "tools/call") {
      const params = body?.params as { name: string };
      const payload = this.toolResults[params.name] ?? { status: "success" };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
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
