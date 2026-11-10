/**
 * The clients call their fetch as a plain function (#142). A browser's
 * `fetch` throws "Illegal invocation" when its receiver is anything but
 * `undefined` or the global object, which a fetch stored in a field and
 * called as `this.fetchImpl(...)` gets: the client itself.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { KaguraClient } from "../src/client.js";
import { WorkspaceClient } from "../src/workspaceClient.js";

const WS = "11111111-2222-3333-4444-555555555555";

/** A fetch that refuses any receiver a browser's refuses, and records the calls it takes. */
function browserLikeFetch(body: string): { fetch: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = [];
  const fetch = function (this: unknown, input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      return Promise.reject(new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation"));
    }
    urls.push(String(input));
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
  } as typeof globalThis.fetch;
  return { fetch, urls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the fetch receiver (#142)", () => {
  it.each(["the default fetch", "globalThis.fetch passed as the option"])(
    "a REST client calls %s without itself as the receiver",
    async (how) => {
      const stub = browserLikeFetch("[]");
      vi.stubGlobal("fetch", stub.fetch);
      const options = how === "the default fetch" ? {} : { fetch: globalThis.fetch };
      const client = new WorkspaceClient({ baseUrl: "https://x.test", apiKey: "k", ...options });
      expect(await client.listMembers(WS)).toEqual([]);
      expect(stub.urls).toEqual([`https://x.test/api/v1/workspaces/${WS}/members`]);
    },
  );

  it("a session client calls the default fetch without itself as the receiver", async () => {
    const stub = browserLikeFetch(JSON.stringify({ items: [], total: 0, next_cursor: null, retention_days: 90 }));
    vi.stubGlobal("fetch", stub.fetch);
    const client = new WorkspaceClient({ baseUrl: "https://x.test", session: true });
    expect((await client.listOperationHistory(WS)).items).toEqual([]);
    expect(stub.urls).toHaveLength(1);
  });

  it("chooses the fetch when the client is constructed, as before", async () => {
    const first = browserLikeFetch("[]");
    vi.stubGlobal("fetch", first.fetch);
    const client = new WorkspaceClient({ baseUrl: "https://x.test", apiKey: "k" });
    vi.stubGlobal("fetch", browserLikeFetch("[]").fetch);
    await client.listMembers(WS);
    expect(first.urls).toHaveLength(1);
  });

  it.each(["the default fetch", "globalThis.fetch passed as the option"])(
    "the MCP client calls %s without itself as the receiver",
    async (how) => {
      const result = { content: [{ type: "text", text: JSON.stringify({ contexts: [] }) }] };
      const stub = browserLikeFetch(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      vi.stubGlobal("fetch", stub.fetch);
      const options = how === "the default fetch" ? {} : { fetch: globalThis.fetch };
      const client = new KaguraClient({ apiKey: "k", mcpUrl: "https://x.test/mcp", ...options });
      const error = await client.listContexts().then(() => null, (e: unknown) => e);
      // Whatever the scripted replies make of the handshake, no call was
      // refused for its receiver: each reached the stub.
      expect(String(error)).not.toMatch(/Illegal invocation/);
      expect(stub.urls.length).toBeGreaterThan(0);
      expect(stub.urls.every((url) => url === "https://x.test/mcp")).toBe(true);
    },
  );
});
