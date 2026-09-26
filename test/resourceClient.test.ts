import { describe, expect, it } from "vitest";

import {
  KaguraFeatureNotAvailableError,
  KaguraNotFoundError,
  KaguraQuotaError,
  KaguraResponseError,
} from "../src/errors.js";
import { ResourceClient } from "../src/resourceClient.js";
import { FakeServer } from "./fakeServer.js";

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

/** A token as the server sends it: every field ResourceTokenResponse requires. */
const TOKEN = {
  id: 7,
  resource_id: "slack",
  quota_events_per_hour: 1000,
  created_at: "2026-06-01T00:00:00Z",
  is_active: true,
  status: "active",
};
const HINT = "The server may be newer than this SDK; upgrading kagura-memory may help.";

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
      body: { ...TOKEN, id: 1, token: "kagura_rt_x" },
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
    server.fallback = { status: 200, body: { ...TOKEN, token: "t" } };
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
    server.routes["/api/v1/resource-tokens/7"] = { status: 200, body: TOKEN };
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

  it("sends a bigint token id exactly, as Python's int is", async () => {
    const server = new FakeRest();
    server.fallback = { status: 200, body: TOKEN };
    const client = makeClient(server);
    await client.revokeToken(9007199254740993n);
    expect(new URL(server.last().url).pathname).toBe("/api/v1/resource-tokens/9007199254740993");
    await client.updateToken(10n ** 21n, { description: "x" });
    expect(new URL(server.last().url).pathname).toBe("/api/v1/resource-tokens/1000000000000000000000");
  });

  it.each([
    // Already rounded: 9007199254740993 reads as ...992, another token's id.
    [9007199254740992, /tokenId must be a safe integer or a bigint, got 9007199254740992/],
    [1e21, /tokenId must be a safe integer or a bigint, got 1e\+21/],
    [7.9, /tokenId must be an integer, got 7\.9/],
  ])("refuses the token id %s before anything is sent", async (id, message) => {
    const server = new FakeRest();
    const client = makeClient(server);
    await expect(client.revokeToken(id)).rejects.toThrow(message);
    await expect(client.updateToken(id, { description: "x" })).rejects.toThrow(message);
    expect(server.requests).toEqual([]);
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

  it("getResourceSchema refuses a 2xx body that is no object, which only a 404 may mean as none", async () => {
    for (const [body, got] of [
      [null, "Input should be a valid dictionary or instance of ResourceSchemaResponse"],
      [[], "Input should be a valid dictionary or instance of ResourceSchemaResponse"],
      ["x", "Input should be a valid dictionary or instance of ResourceSchemaResponse"],
    ] as const) {
      const server = new FakeRest();
      server.routes["/api/v1/resources/r/schema"] = { status: 200, body };
      const error = await makeClient(server).getResourceSchema("r").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(KaguraResponseError);
      expect((error as Error).message).toBe(
        `ResourceClient.get_resource_schema: unexpected server response for ResourceSchemaResponse (${got}). ` +
          "The server may be newer than this SDK; upgrading kagura-memory may help.",
      );
    }
  });

  it("getResourceSchema passes schema_version and returns the body", async () => {
    const server = new FakeRest();
    server.routes["/api/v1/resources/r/schema"] = {
      status: 200,
      body: { resource_id: "r", schema_version: 3, field_definitions: [], created_at: "2026-06-01T00:00:00Z" },
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

describe("resource ids in the path (#66)", () => {
  const calls: Array<[string, (client: ResourceClient, id: string) => Promise<unknown>]> = [
    ["getResourceImpact", (c, id) => c.getResourceImpact(id)],
    ["getIndexerStatus", (c, id) => c.getIndexerStatus(id)],
    ["getResourceSchema", (c, id) => c.getResourceSchema(id)],
    ["listResourceEvents", (c, id) => c.listResourceEvents(id)],
    ["ingestEvent", (c, id) => c.ingestEvent(id, "rk", { op: "upsert", docId: "d" })],
    ["ingestEvents", (c, id) => c.ingestEvents(id, "rk", [{ op: "upsert", docId: "d" }])],
  ];

  it.each(calls)("%s refuses ., .. and an empty id before sending anything", async (_name, call) => {
    const server = new FakeRest();
    const client = makeClient(server);
    for (const id of [".", "..", ""]) {
      await expect(call(client, id)).rejects.toThrow(
        `resourceId must be a resource id, got ${JSON.stringify(id)}: as a URL path segment it ` +
          "would address a different endpoint",
      );
    }
    expect(server.requests).toHaveLength(0);
  });

  it.each(calls)("%s sends the id as one percent-encoded segment", async (_name, call) => {
    const server = new FakeRest();
    server.fallback = { status: 200, body: { events: [], created_count: 0 } };
    const client = makeClient(server);
    await call(client, "a/../b?x=1#f %").catch(() => undefined);
    expect(server.last().url).toMatch(/^https:\/\/x\.test\/api\/v1\/resources\/a%2F\.\.%2Fb%3Fx%3D1%23f%20%25\//);
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

  it("reads the events-per-hour quota's retry hint from the body on both ingest calls", async () => {
    // The server raises RateLimitError(retry_after=3600) inside the ingest
    // route, and the global handler sends no Retry-After header.
    const server = new FakeRest();
    const quota = {
      status: 429,
      body: {
        error: "RATE-001",
        message: "Event quota exceeded: 10/10 events per hour",
        details: { retry_after: 3600 },
      },
    };
    server.routes["/api/v1/resources/slack/events"] = quota;
    server.routes["/api/v1/resources/slack/events/batch"] = quota;
    const client = makeClient(server);

    for (const call of [
      () => client.ingestEvent("slack", "rk", { op: "upsert", docId: "a" }),
      () => client.ingestEvents("slack", "rk", [{ op: "upsert", docId: "a" }]),
    ]) {
      const error = (await call().catch((e: unknown) => e)) as KaguraQuotaError;
      expect(error).toBeInstanceOf(KaguraQuotaError);
      expect(error.message).toBe("Event quota exceeded: 10/10 events per hour");
      expect(error.retryAfter).toBe(3600);
    }
  });
});

describe("gate refusals on createToken (#40)", () => {
  it("maps 403 FEAT-001 to KaguraFeatureNotAvailableError", async () => {
    const server = new FakeRest();
    server.routes["/api/v1/resource-tokens"] = {
      status: 403,
      body: {
        error: "FEAT-001",
        message: "Feature 'resources' not available on L plan.",
        details: {
          gate: "plan",
          feature: "resources",
          required_plan: "promax",
          required_plan_display: "XL",
          current_plan: "pro",
        },
      },
    };
    const client = makeClient(server);

    const error = await client.createToken({ resourceId: "r" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect((error as KaguraFeatureNotAvailableError).requiredPlan).toBe("promax");
  });

  it("maps the active-token cap (403 QUOTA-001) to KaguraQuotaError", async () => {
    const server = new FakeRest();
    server.routes["/api/v1/resource-tokens"] = {
      status: 403,
      body: {
        error: "QUOTA-001",
        message: "Token limit reached. Your L plan allows 3 active tokens.",
        details: { gate: "quota", quota_type: "resource_tokens", current: 3, limit: 3 },
      },
    };
    const client = makeClient(server);

    const error = await client.createToken({ resourceId: "r" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraQuotaError);
    expect((error as KaguraQuotaError).quotaType).toBe("resource_tokens");
    expect((error as KaguraQuotaError).limit).toBe(3);
  });
});

describe("setupResource", () => {
  it("throws when the client was not built via fromMcpUrl", async () => {
    const client = makeClient(new FakeRest());
    await expect(client.setupResource({ resourceId: "r" })).rejects.toThrow(/requires MCP URL/);
  });

  /** A client whose inner MCP session talks to `server` (#47). */
  function mcpClient(server: FakeServer): ResourceClient {
    return ResourceClient.fromMcpUrl({
      apiKey: "kagura_test",
      mcpUrl: "https://x.test/mcp",
      fetch: server.fetch,
    });
  }

  it("defaults the context name to resourceId, which the server requires (#47)", async () => {
    const server = new FakeServer();
    server.toolResults.setup_resource = {
      status: "success",
      context_id: "c1",
      context_name: "crm",
      resource_id: "crm",
      token: "kagura_rt_x",
      token_id: 3,
    };
    const result = await mcpClient(server).setupResource({ resourceId: "crm" });

    expect(server.toolCallArgs()).toEqual({
      resource_id: "crm",
      name: "crm",
      quota_events_per_hour: 1000,
    });
    expect(result.token).toBe("kagura_rt_x");
    expect(server.requests[0]!.headers.authorization).toBe("Bearer kagura_test");
  });

  it("keeps contextName and does not send the deprecated summary (#47)", async () => {
    const server = new FakeServer();
    server.toolResults.setup_resource = {
      status: "success",
      context_id: "c1",
      context_name: "crm-context",
      resource_id: "crm",
      token: "kagura_rt_x",
      token_id: 3,
    };
    await mcpClient(server).setupResource({
      resourceId: "crm",
      contextName: "crm-context",
      summary: "ignored",
      description: "d",
      quotaEventsPerHour: 50,
    });
    expect(server.toolCallArgs()).toEqual({
      resource_id: "crm",
      name: "crm-context",
      description: "d",
      quota_events_per_hour: 50,
    });
  });
});

describe("readers check the body as Python's _parse does (#69)", () => {
  // Messages recorded from the Python SDK 0.42.0's `parse_response`
  // (pydantic 2.13.4) for the same bodies.
  const calls: Array<[string, string, (c: ResourceClient) => Promise<unknown>, unknown, string]> = [
    ["createToken", "/api/v1/resource-tokens", (c) => c.createToken({ resourceId: "r" }), {},
      "ResourceClient.create_token: unexpected server response for ResourceTokenCreateResponse (id: Field required; resource_id: Field required; quota_events_per_hour: Field required (+4 more))."],
    ["listTokens", "/api/v1/resource-tokens", (c) => c.listTokens(), {},
      "ResourceClient.list_tokens: unexpected server response for PaginatedResourceTokensResponse (tokens: Field required; total: Field required; limit: Field required (+1 more))."],
    ["updateToken", "/api/v1/resource-tokens/7", (c) => c.updateToken(7, { description: "x" }), {},
      "ResourceClient.update_token: unexpected server response for ResourceTokenResponse (id: Field required; resource_id: Field required; quota_events_per_hour: Field required (+3 more))."],
    ["getResourceImpact", "/api/v1/resources/r/impact", (c) => c.getResourceImpact("r"), {},
      "ResourceClient.get_resource_impact: unexpected server response for ResourceImpactResponse (resource_id: Field required; token_count: Field required; memory_count: Field required)."],
    ["listResources", "/api/v1/resources", (c) => c.listResources(), {},
      "ResourceClient.list_resources: unexpected server response for ResourceListResponse (resources: Field required; total: Field required)."],
    ["getIndexerStatus", "/api/v1/resources/r/indexer-status", (c) => c.getIndexerStatus("r"), {},
      "ResourceClient.get_indexer_status: unexpected server response for IndexerStatusResponse (resource_id: Field required)."],
    ["getResourceSchema", "/api/v1/resources/r/schema", (c) => c.getResourceSchema("r"), {},
      "ResourceClient.get_resource_schema: unexpected server response for ResourceSchemaResponse (resource_id: Field required; schema_version: Field required; field_definitions: Field required (+1 more))."],
    ["listResourceEvents", "/api/v1/resources/r/events", (c) => c.listResourceEvents("r"), null,
      "ResourceClient.list_resource_events: unexpected server response for ResourceEventsListResponse (Input should be a valid dictionary or instance of ResourceEventsListResponse)."],
    ["ingestEvent", "/api/v1/resources/r/events", (c) => c.ingestEvent("r", "rk", { op: "upsert", docId: "d" }), {},
      "ResourceClient.ingest_event: unexpected server response for ResourceEventResponse (event_id: Field required)."],
  ];

  it.each(calls)("%s throws KaguraResponseError for a body its model refuses", async (_name, route, call, body, message) => {
    const server = new FakeRest();
    server.routes[route] = { status: 200, body };
    const error = await call(makeClient(server)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraResponseError);
    expect((error as Error).message).toBe(`${message} ${HINT}`);
  });

  it("returns an accepted body as it arrived: extra keys and lax values kept", async () => {
    const server = new FakeRest();
    const body = { ...TOKEN, id: "7", token_hash: "zzz" };
    server.routes["/api/v1/resource-tokens/7"] = { status: 200, body };
    await expect(makeClient(server).updateToken(7, { description: "x" })).resolves.toEqual(body);
  });

  it("setupResource checks the tool's reply as ResourceSetupResponse", async () => {
    const server = new FakeServer();
    server.toolResults.setup_resource = { status: "success" };
    const client = ResourceClient.fromMcpUrl({ apiKey: "kagura_test", mcpUrl: "https://x.test/mcp", fetch: server.fetch });
    const error = await client.setupResource({ resourceId: "crm" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaguraResponseError);
    expect((error as Error).message).toBe(
      "ResourceClient.setup_resource: unexpected server response for ResourceSetupResponse (context_id: Field " +
        `required; context_name: Field required; resource_id: Field required (+2 more)). ${HINT}`,
    );
  });
});
