/**
 * Tests for AgentsClient (#3) — the REST fallback for agent bootstrap
 * (`POST /api/v1/agents/{agent_id}/bootstrap`, server v0.49.0+). Wire
 * shapes mirror the Python SDK's AgentsClient bootstrap tests.
 */

import { describe, expect, it } from "vitest";

import { AgentsClient } from "../src/agentsClient.js";
import { KaguraNotFoundError } from "../src/errors.js";

const AGENT_ID = "6f0d9c2e-8a11-4b3e-9c55-1a2b3c4d5e6f";
const CONTEXT_ID = "9c8b7a6d-5e4f-4321-a0b9-c8d7e6f5a4b3";

const BOOTSTRAP_BODY = {
  status: "success",
  degraded: false,
  agent: {
    agent_id: AGENT_ID,
    name: "ci-agent",
    binding: { context_id: CONTEXT_ID, is_default: true },
  },
  components: { pinned: { status: "ok", memories: [] } },
  correlation: { agent_id: AGENT_ID, session_id: "run-42" },
};

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Scripted fetch stub — the TS analogue of the Python httpx MockTransport. */
class FakeRest {
  requests: Recorded[] = [];
  status = 200;
  body = JSON.stringify(BOOTSTRAP_BODY);

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
    return new Response(this.body, { status: this.status });
  };
}

function makeClient(server: FakeRest): AgentsClient {
  return new AgentsClient({
    apiKey: "kagura_test",
    baseUrl: "https://x.test",
    fetch: server.fetch,
  });
}

describe("construction", () => {
  it("requires credentials, naming the class and its factory", () => {
    expect(() => new AgentsClient()).toThrow(
      /AgentsClient requires apiKey, or use AgentsClient\.fromMcpUrl/,
    );
  });
});

describe("bootstrap", () => {
  it("POSTs the bootstrap path with an empty JSON body by default", async () => {
    const server = new FakeRest();
    const client = makeClient(server);

    const bootstrap = await client.bootstrap({ agentId: AGENT_ID });

    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`https://x.test/api/v1/agents/${AGENT_ID}/bootstrap`);
    expect(req.body).toBe("{}");
    expect(req.headers.authorization).toBe("Bearer kagura_test");
    expect(bootstrap.agent.name).toBe("ci-agent");
    expect(bootstrap.agent.binding?.is_default).toBe(true);
  });

  it("normalizes non-canonical agent UUID spellings into the path", async () => {
    const server = new FakeRest();
    const client = makeClient(server);

    await client.bootstrap({ agentId: AGENT_ID.toUpperCase().replace(/-/g, "") });

    expect(server.requests[0]!.url).toBe(`https://x.test/api/v1/agents/${AGENT_ID}/bootstrap`);
  });

  it("rejects a non-UUID agentId before any request is sent", async () => {
    const server = new FakeRest();
    const client = makeClient(server);

    await expect(client.bootstrap({ agentId: "../../evil" })).rejects.toThrow(/UUID/i);
    expect(server.requests).toHaveLength(0);
  });

  it("sends every optional argument under its snake_case wire name", async () => {
    const server = new FakeRest();
    const client = makeClient(server);

    await client.bootstrap({
      agentId: AGENT_ID,
      contextId: CONTEXT_ID,
      sessionId: "run-42",
      query: "session summary",
      recallK: 7,
      pinnedCap: 50,
      upcomingUntil: "2026-08-01T00:00:00",
      include: ["pinned", "state"],
    });

    expect(JSON.parse(server.requests[0]!.body!)).toEqual({
      context_id: CONTEXT_ID,
      session_id: "run-42",
      query: "session summary",
      recall_k: 7,
      pinned_cap: 50,
      upcoming_until: "2026-08-01T00:00:00",
      include: ["pinned", "state"],
    });
  });

  it("maps a 404 to KaguraNotFoundError", async () => {
    const server = new FakeRest();
    server.status = 404;
    server.body = JSON.stringify({ detail: "Agent not found" });
    const client = makeClient(server);

    await expect(client.bootstrap({ agentId: AGENT_ID })).rejects.toThrow(KaguraNotFoundError);
  });
});
