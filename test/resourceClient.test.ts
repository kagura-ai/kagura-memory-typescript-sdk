import { describe, expect, it } from "vitest";

import { KaguraNotFoundError, KaguraQuotaError } from "../src/errors.js";
import { ResourceClient } from "../src/resourceClient.js";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/** Scripted fetch stub — routes by path so a test can script several calls. */
class FakeRest {
  requests: Recorded[] = [];
  /** path (without query) → { status, body } */
  routes: Record<string, { status: number; body: unknown }> = {};
  fallback: { status: number; body: unknown } = { status: 200, body: {} };

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    this.requests.push({ url, method: init?.method ?? "GET", headers, body });

    const path = new URL(url).pathname;
    const route = this.routes[path] ?? this.fallback;
    const nullBody = route.status === 204 || route.status === 304;
    return new Response(nullBody ? null : JSON.stringify(route.body), { status: route.status });
  };

  last(): Recorded {
    return this.requests[this.requests.length - 1]!;
  }
}

function makeClient(server: FakeRest): ResourceClient {
  return new ResourceClient({
    apiKey: "kagura_test",
    baseUrl: "https://x.test",
    fetch: server.fetch,
  });
}

describe("construction", () => {
  it("requires credentials, naming the class and its factory", () => {
    expect(() => new ResourceClient()).toThrow(
      /ResourceClient requires apiKey, or use ResourceClient\.fromMcpUrl/,
    );
  });

  it("mcpUrl is null for bare construction", () => {
    expect(makeClient(new FakeRest()).mcpUrl).toBeNull();
  });

  it("fromMcpUrl derives base URL and stamps the MCP URL", () => {
    const client = ResourceClient.fromMcpUrl({
      apiKey: "k",
      mcpUrl: "https://x.test/mcp/w/ws-1",
    });
    expect(client.baseUrl).toBe("https://x.test");
    expect(client.mcpUrl).toBe("https://x.test/mcp/w/ws-1");
  });
});

describe("token CRUD", () => {
  it("createToken sends resource_id and default quota, returns the body", async () => {
    const server = new FakeRest();
    server.routes["/api/v1/resource-tokens"] = {
      status: 200,
      body: { id: 1, resource_id: "slack", token: "kagura_rt_x" },
    };
    const client = makeClient(server);
    const result = await client.createToken({ resourceId: "slack" });

    expect(result.token).toBe("kagura_rt_x");
    const req = server.last();
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({ resource_id: "slack", quota_events_per_hour: 1000 });
    expect(req.headers.authorization).toBe("Bearer kagura_test");
  });

  it("createToken only sends a description when provided", async () => {
    const server = new FakeRest();
    const client = makeClient(server);
    await client.createToken({ resourceId: "r", description: "CI", quotaEventsPerHour: 500 });
    expect(server.last().body).toEqual({
      resource_id: "r",
      description: "CI",
      quota_events_per_hour: 500,
    });
  });

  it("listTokens builds limit/offset params and passes resource_id filter", async () => {
    const server = new FakeRest();
    server.routes["/api/v1/resource-tokens"] = {
      status: 200,
      body: { tokens: [], total: 0, limit: 50, offset: 0 },
    };
    const client = makeClient(server);
    await client.listTokens({ resourceId: "slack" });
    const url = new URL(server.last().url);
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("resource_id")).toBe("slack");
  });

  it("updateToken sends only the fields set (exclude-none)", async () => {
    const server = new FakeRest();
    server.routes["/api/v1/resource-tokens/7"] = { status: 200, body: { id: 7 } };
    const client = makeClient(server);
    await client.updateToken(7, { quotaEventsPerHour: 2000 });
    const req = server.last();
    expect(req.method).toBe("PATCH");
    expect(req.url).toContain("/api/v1/resource-tokens/7");
    expect(req.body).toEqual({ quota_events_per_hour: 2000 });
  });

  it("revokeToken issues a DELETE and tolerates 204", async () => {
    const server = new FakeRest();
    server.routes["/api/v1/resource-tokens/9"] = { status: 204, body: null };
    const client = makeClient(server);
    await expect(client.revokeToken(9)).resolves.toBeUndefined();
    expect(server.last().method).toBe("DELETE");
  });
});

describe("event ingestion (X-Resource-API-Key)", () => {
  it("ingestEvent serializes the event and sends the resource-key header", async () => {
    const server = new FakeRest();
    server.routes["/api/v1/resources/slack/events"] = {
      status: 200,
      body: { status: "success", event_id: 42 },
    };
    const client = makeClient(server);
    const result = await client.ingestEvent("slack", "rk_secret", {
      op: "upsert",
      docId: "doc-1",
      version: 2,
      payload: { text: "hi" },
    });

    expect(result.event_id).toBe(42);
    const req = server.last();
    expect(req.headers["x-resource-api-key"]).toBe("rk_secret");
    expect(req.headers.authorization).toBe("Bearer kagura_test");
    expect(req.body).toEqual({
      op: "upsert",
      doc_id: "doc-1",
      version: 2,
      payload: { text: "hi" },
      event_metadata: {},
    });
  });

  it("ingestEvents serializes each event and always sends event_metadata", async () => {
    const server = new FakeRest();
    server.routes["/api/v1/resources/slack/events/batch"] = {
      status: 200,
      body: { status: "success", created_count: 2, failed_count: 0 },
    };
    const client = makeClient(server);
    const result = await client.ingestEvents("slack", "rk", [
      { op: "upsert", docId: "a" },
      { op: "delete", docId: "b", eventMetadata: { src: "x" } },
    ]);

    expect(result.created_count).toBe(2);
    expect(server.last().body).toEqual({
      events: [
        { op: "upsert", doc_id: "a", event_metadata: {} },
        { op: "delete", doc_id: "b", event_metadata: { src: "x" } },
      ],
    });
  });
});

describe("resource stats", () => {
  it("getResourceSchema returns null on 404", async () => {
    const server = new FakeRest();
    server.routes["/api/v1/resources/ghost/schema"] = { status: 404, body: { detail: "no" } };
    const client = makeClient(server);
    await expect(client.getResourceSchema("ghost")).resolves.toBeNull();
  });

  it("getResourceSchema passes schema_version and returns the body", async () => {
    const server = new FakeRest();
    server.routes["/api/v1/resources/r/schema"] = {
      status: 200,
      body: { resource_id: "r", schema_version: 3, fields: [] },
    };
    const client = makeClient(server);
    const schema = await client.getResourceSchema("r", 3);
    expect(schema?.schema_version).toBe(3);
    expect(new URL(server.last().url).searchParams.get("schema_version")).toBe("3");
  });

  it("getIndexerStatus surfaces a 404 as KaguraNotFoundError", async () => {
    const server = new FakeRest();
    server.routes["/api/v1/resources/ghost/indexer-status"] = {
      status: 404,
      body: { detail: "unknown resource" },
    };
    const client = makeClient(server);
    await expect(client.getIndexerStatus("ghost")).rejects.toBeInstanceOf(KaguraNotFoundError);
  });

  it("listResourceEvents serializes a Date since to UTC ISO", async () => {
    const server = new FakeRest();
    server.routes["/api/v1/resources/r/events"] = {
      status: 200,
      body: { events: [], next_cursor: null },
    };
    const client = makeClient(server);
    await client.listResourceEvents("r", {
      op: "upsert",
      since: new Date("2026-01-02T03:04:05Z"),
    });
    const url = new URL(server.last().url);
    expect(url.searchParams.get("op")).toBe("upsert");
    expect(url.searchParams.get("since")).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("error mapping", () => {
  it("maps 429 to KaguraQuotaError with retryAfter", async () => {
    const server = new FakeRest();
    server.fetch = async () =>
      new Response(JSON.stringify({ detail: "quota" }), {
        status: 429,
        headers: { "Retry-After": "42" },
      });
    const client = makeClient(server);
    const error = await client.createToken({ resourceId: "r" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraQuotaError);
    expect((error as KaguraQuotaError).retryAfter).toBe(42);
  });
});

describe("setupResource", () => {
  it("throws when the client was not built via fromMcpUrl", async () => {
    const client = makeClient(new FakeRest());
    await expect(client.setupResource({ resourceId: "r" })).rejects.toThrow(/requires MCP URL/);
  });
});
