import { describe, expect, it, vi } from "vitest";
import {
  isMessage,
  isRequest,
  McpTransport,
  rpcError,
} from "../../src/mcp/transport.js";
import type { RpcMessage } from "../../src/mcp/transport.js";

const init: RpcMessage = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};
const call: RpcMessage = {
  jsonrpc: "2.0",
  id: "call",
  method: "tools/call",
  params: { name: "future_tool", arguments: { text: "日本語" } },
};
function response(
  id: unknown,
  result: unknown = {},
  session?: string,
): Response {
  return Response.json(
    { jsonrpc: "2.0", id, result },
    { headers: session ? { "mcp-session-id": session } : {} },
  );
}
function setup(responses: Response[], options: { timeoutMs?: number } = {}) {
  const calls: RequestInit[] = [];
  const auth = {
    getAuthHeader: vi.fn(async () => "Bearer test"),
    forceRefresh: vi.fn(async () => {}),
  };
  const fetcher = vi.fn(async (_url: unknown, request?: RequestInit) => {
    calls.push(request!);
    const next = responses.shift();
    if (!next) throw new Error("Unexpected request");
    return next;
  }) as unknown as typeof fetch;
  const transport = new McpTransport({
    url: "https://example.test/mcp",
    auth,
    fetch: fetcher,
    signal: new AbortController().signal,
    ...options,
  });
  const output: RpcMessage[] = [];
  const emit = (message: RpcMessage): void => {
    output.push(message);
  };
  return { transport, calls, auth, output, emit, fetcher };
}

describe("transparent MCP transport", () => {
  it("accepts CR-only SSE and multiline data fields", async () => {
    const s = setup([
      new Response(
        'data: {"jsonrpc":"2.0",\rdata: "id":"call","result":{}}\r\r',
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    ]);
    await s.transport.forward(call, s.emit);
    expect(s.output).toEqual([{ jsonrpc: "2.0", id: "call", result: {} }]);
  });

  it("coalesces concurrent session recovery without replaying initialization twice", async () => {
    let initialized = 0;
    let notified = 0;
    const transport = new McpTransport({
      url: "https://example.test/mcp",
      signal: new AbortController().signal,
      auth: {
        getAuthHeader: async () => "Bearer test",
        forceRefresh: async () => {},
      },
      fetch: async (_url, request) => {
        const message = JSON.parse(String(request?.body));
        const headers = new Headers(request?.headers);
        if (message.method === "initialize") {
          initialized++;
          // Yield so both expired requests reach recovery before it completes.
          await new Promise((resolve) => setTimeout(resolve, 10));
          return response(
            message.id,
            { protocolVersion: "2025-06-18" },
            `session-${initialized}`,
          );
        }
        if (message.method === "notifications/initialized") {
          notified++;
          return new Response(null, { status: 202 });
        }
        if (headers.get("mcp-session-id") === "session-1")
          return new Response(null, { status: 404 });
        return response(message.id);
      },
    });
    const output: RpcMessage[] = [];
    await transport.forward(init, (r) => {
      output.push(r);
    });
    await Promise.all(
      ["first", "second"].map((id) =>
        transport.forward({ ...call, id }, (r) => {
          output.push(r);
        }),
      ),
    );
    expect(initialized).toBe(2);
    expect(notified).toBe(1);
    expect(output.map((r) => r.id)).toEqual([0, "first", "second"]);
  });

  it("forwards host responses while a replayed initialize stream is waiting", async () => {
    let initialized = 0;
    let stream: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const transport = new McpTransport({
      url: "https://example.test/mcp",
      signal: new AbortController().signal,
      auth: {
        getAuthHeader: async () => "Bearer test",
        forceRefresh: async () => {},
      },
      timeoutMs: 1000,
      fetch: async (_url, request) => {
        const message = JSON.parse(String(request?.body));
        if (message.method === "initialize") {
          if (++initialized === 1)
            return response(0, { protocolVersion: "2025-06-18" }, "old");
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller;
                controller.enqueue(
                  encoder.encode(
                    'data: {"jsonrpc":"2.0","id":"server","method":"ping"}\n\n',
                  ),
                );
              },
            }),
            {
              headers: {
                "Content-Type": "text/event-stream",
                "mcp-session-id": "new",
              },
            },
          );
        }
        if (message.id === "server") {
          expect(new Headers(request?.headers).get("mcp-session-id")).toBe("new");
          stream.enqueue(
            encoder.encode(
              'data: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18"}}\n\n',
            ),
          );
          stream.close();
          return new Response(null, { status: 202 });
        }
        if (message.method === "notifications/initialized")
          return new Response(null, { status: 202 });
        if (new Headers(request?.headers).get("mcp-session-id") === "old")
          return new Response(null, { status: 404 });
        return response(message.id);
      },
    });
    let replied: Promise<void> | undefined;
    await transport.forward(init, () => {});
    const output: RpcMessage[] = [];
    await transport.forward(call, (message) => {
      if (message.method === "ping")
        replied = transport.forward(
          { jsonrpc: "2.0", id: message.id, result: {} },
          () => {},
        );
      else output.push(message);
    });
    await replied;
    expect(output).toEqual([{ jsonrpc: "2.0", id: "call", result: {} }]);
  });
  it("forwards unknown tools unchanged, negotiates headers, preserves IDs and Unicode", async () => {
    const s = setup([
      response(
        0,
        { protocolVersion: "2025-06-18", capabilities: {} },
        "session-one",
      ),
      new Response(null, { status: 202 }),
      response("call", { content: [{ type: "text", text: "日本語" }] }),
    ]);
    await s.transport.forward(init, s.emit);
    await s.transport.forward(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      s.emit,
    );
    await s.transport.forward(call, s.emit);
    expect(JSON.parse(String(s.calls[2]!.body))).toEqual(call);
    expect(s.calls[0]!.headers).not.toHaveProperty("Mcp-Session-Id");
    expect(s.calls[2]!.headers).toMatchObject({
      "Mcp-Session-Id": "session-one",
      "MCP-Protocol-Version": "2025-06-18",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer test",
    });
    expect(s.calls.every((r) => r.redirect === "error")).toBe(true);
    expect(s.output.map((r) => r.id)).toEqual([0, "call"]);
  });

  it("passes Cloud JSON-RPC errors and data without rewriting", async () => {
    const error = {
      jsonrpc: "2.0",
      id: "call",
      error: { code: -32003, message: "quota", data: { gate: "plan" } },
    };
    const s = setup([Response.json(error, { status: 403 })]);
    await s.transport.forward(call, s.emit);
    expect(s.output).toEqual([error]);
  });

  it("forces a refresh once on 401, without retrying rejected credentials forever", async () => {
    const s = setup([
      new Response(null, { status: 401 }),
      new Response(null, { status: 401 }),
    ]);
    await expect(s.transport.forward(call, s.emit)).rejects.toThrow(
      "Authentication rejected",
    );
    expect(s.auth.forceRefresh).toHaveBeenCalledTimes(1);
    expect(s.calls).toHaveLength(2);
  });

  it("uses the rotated token after 401", async () => {
    const s = setup([new Response(null, { status: 401 }), response("call")]);
    s.auth.getAuthHeader
      .mockResolvedValueOnce("Bearer old")
      .mockResolvedValueOnce("Bearer new");
    await s.transport.forward(call, s.emit);
    expect(s.calls[1]!.headers).toHaveProperty("Authorization", "Bearer new");
  });

  it("replays initialize then initialized on session 404 and retries once", async () => {
    const s = setup([
      response(0, { protocolVersion: "2025-06-18" }, "old"),
      new Response(null, { status: 404 }),
      response(0, { protocolVersion: "2025-06-18" }, "new"),
      new Response(null, { status: 202 }),
      response("call"),
    ]);
    await s.transport.forward(init, s.emit);
    await s.transport.forward(call, s.emit);
    expect(s.calls.map((r) => JSON.parse(String(r.body)).method)).toEqual([
      "initialize",
      "tools/call",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(s.calls[2]!.headers).not.toHaveProperty("Mcp-Session-Id");
    expect(s.calls[4]!.headers).toHaveProperty("Mcp-Session-Id", "new");
    expect(s.output.map((m) => m.id)).toEqual([0, "call"]);
  });

  it("does not replay writes after 500, network failure or 404 without a session", async () => {
    for (const status of [404, 500, 429]) {
      const s = setup([new Response("failure", { status })]);
      await expect(s.transport.forward(call, s.emit)).rejects.toThrow();
      expect(s.calls).toHaveLength(1);
    }
  });

  it("rejects a second session 404 without another reinitialization", async () => {
    const s = setup([
      response(0, { protocolVersion: "2025-06-18" }, "old"),
      new Response(null, { status: 404 }),
      response(0, {}, "new"),
      new Response(null, { status: 202 }),
      new Response(null, { status: 404 }),
    ]);
    await s.transport.forward(init, s.emit);
    await expect(s.transport.forward(call, s.emit)).rejects.toThrow();
    expect(s.calls).toHaveLength(5);
  });

  it("streams split UTF-8 SSE notifications and server requests, cancels after the response", async () => {
    let cancelled = false;
    const messages = [
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { message: "日本語" },
      },
      { jsonrpc: "2.0", id: "server", method: "ping" },
      { jsonrpc: "2.0", id: "call", result: {} },
    ];
    const bytes = new TextEncoder().encode(
      ": keepalive\r\n\r\n" +
        messages
          .map((m) => `event: message\r\ndata: ${JSON.stringify(m)}\r\n\r\n`)
          .join(""),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const s = setup([
      new Response(stream, {
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      }),
    ]);
    await s.transport.forward(call, s.emit);
    expect(s.output).toEqual(messages);
    expect(cancelled).toBe(true);
  });

  it("never responds to notifications or client responses, even on upstream failure", async () => {
    const s = setup([
      Response.json({ ignored: true }),
      new Response(null, { status: 202 }),
      new Response(null, { status: 500 }),
    ]);
    await s.transport.forward(
      { jsonrpc: "2.0", method: "notifications/cancelled" },
      s.emit,
    );
    await s.transport.forward(
      { jsonrpc: "2.0", id: "server", result: {} },
      s.emit,
    );
    await expect(
      s.transport.forward(
        { jsonrpc: "2.0", method: "notifications/cancelled" },
        s.emit,
      ),
    ).rejects.toThrow();
    expect(s.output).toEqual([]);
  });

  it("requires a correlated response and rejects invalid JSON-RPC", async () => {
    for (const r of [
      new Response(null, { status: 202 }),
      Response.json([]),
      Response.json({ hello: "world" }),
    ]) {
      const s = setup([r]);
      await expect(s.transport.forward(call, s.emit)).rejects.toThrow();
    }
  });

  it("bounds stalled HTTP and aborts the fetch", async () => {
    const transport = new McpTransport({
      url: "https://example.test/mcp",
      auth: {
        getAuthHeader: async () => "Bearer fake",
        forceRefresh: async () => {},
      },
      signal: new AbortController().signal,
      timeoutMs: 10,
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          ),
        ),
    });
    await expect(transport.forward(call, () => {})).rejects.toThrow(
      "timed out",
    );
  });
});

it("recognizes message kinds and retains zero/null/string IDs in errors", () => {
  expect(isMessage(init)).toBe(true);
  expect(isRequest(init)).toBe(true);
  expect(isRequest({ jsonrpc: "2.0", method: "ping" })).toBe(false);
  expect(isMessage({ jsonrpc: "2.0", id: {}, method: "ping" })).toBe(false);
  for (const id of [0, null, "x"]) expect(rpcError(id, "failure").id).toBe(id);
});
