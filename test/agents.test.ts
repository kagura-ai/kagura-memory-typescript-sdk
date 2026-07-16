/**
 * Agent control plane tests (issues #1/#2/#3; server v0.49.0+, RFC-0002).
 */
import { describe, expect, it } from "vitest";

import { KaguraConnectionError, KaguraNotFoundError } from "../src/errors.js";
import { FakeServer, makeClient } from "./fakeServer.js";

const AGENT = {
  id: "6f0d9c2e-8a11-4b3e-9c55-1a2b3c4d5e6f",
  workspace_id: "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
  name: "ci-agent",
  owner_user_id: "user-1",
  status: "active",
  enforcement_mode: "enforce",
  created_at: "2026-07-16T00:00:00Z",
  updated_at: "2026-07-16T00:00:00Z",
};

describe("registerAgent", () => {
  it("sends only the name and returns the created agent", async () => {
    const server = new FakeServer();
    server.toolResults.register_agent = { status: "success", agent: AGENT };
    const client = makeClient(server);

    const agent = await client.registerAgent({ name: "ci-agent" });

    expect(server.toolCallArgs()).toEqual({ name: "ci-agent" });
    expect(agent.id).toBe(AGENT.id);
    expect(agent.status).toBe("active");
  });

  it("includes optional metadata fields only when provided", async () => {
    const server = new FakeServer();
    server.toolResults.register_agent = { status: "success", agent: AGENT };
    const client = makeClient(server);

    await client.registerAgent({
      name: "ci-agent",
      description: "CI bot",
      framework: "claude-code",
      environment: "production",
      version: "1.2.0",
    });

    expect(server.toolCallArgs()).toEqual({
      name: "ci-agent",
      description: "CI bot",
      framework: "claude-code",
      environment: "production",
      version: "1.2.0",
    });
  });

  it("throws KaguraConnectionError when the agent envelope is missing", async () => {
    const server = new FakeServer();
    server.toolResults.register_agent = { status: "success" };
    const client = makeClient(server);

    await expect(client.registerAgent({ name: "ci-agent" })).rejects.toThrow(
      KaguraConnectionError,
    );
  });
});

describe("getAgent", () => {
  it("passes agent_id and returns the agent", async () => {
    const server = new FakeServer();
    server.toolResults.get_agent = { status: "success", agent: AGENT };
    const client = makeClient(server);

    const agent = await client.getAgent(AGENT.id);

    expect(server.toolCallArgs()).toEqual({ agent_id: AGENT.id });
    expect(agent.name).toBe("ci-agent");
  });

  it("maps agent_not_found to KaguraNotFoundError", async () => {
    const server = new FakeServer();
    server.toolResults.get_agent = {
      status: "error",
      error: "agent_not_found",
      message: "Agent not found",
    };
    const client = makeClient(server);

    await expect(client.getAgent(AGENT.id)).rejects.toThrow(KaguraNotFoundError);
  });
});

describe("listAgents", () => {
  it("returns the agents array", async () => {
    const server = new FakeServer();
    server.toolResults.list_agents = { status: "success", agents: [AGENT] };
    const client = makeClient(server);

    const agents = await client.listAgents();

    expect(server.toolCallArgs()).toEqual({});
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("ci-agent");
  });

  it("returns [] when the agents key is missing", async () => {
    const server = new FakeServer();
    server.toolResults.list_agents = { status: "success" };
    const client = makeClient(server);

    expect(await client.listAgents()).toEqual([]);
  });
});

describe("updateAgent", () => {
  it("sends only the provided fields with snake_case names", async () => {
    const server = new FakeServer();
    server.toolResults.update_agent = { status: "success", agent: AGENT };
    const client = makeClient(server);

    await client.updateAgent({
      agentId: AGENT.id,
      status: "suspended",
      enforcementMode: "shadow",
    });

    expect(server.toolCallArgs()).toEqual({
      agent_id: AGENT.id,
      status: "suspended",
      enforcement_mode: "shadow",
    });
  });

  it("sends metadata fields when provided and returns the updated agent", async () => {
    const server = new FakeServer();
    server.toolResults.update_agent = {
      status: "success",
      agent: { ...AGENT, description: "renamed" },
    };
    const client = makeClient(server);

    const agent = await client.updateAgent({
      agentId: AGENT.id,
      name: "ci-agent-2",
      description: "renamed",
      framework: "langgraph",
      environment: "staging",
      version: "2.0.0",
    });

    expect(server.toolCallArgs()).toEqual({
      agent_id: AGENT.id,
      name: "ci-agent-2",
      description: "renamed",
      framework: "langgraph",
      environment: "staging",
      version: "2.0.0",
    });
    expect(agent.description).toBe("renamed");
  });

  it("throws when no update field is provided", async () => {
    const server = new FakeServer();
    const client = makeClient(server);

    await expect(client.updateAgent({ agentId: AGENT.id })).rejects.toThrow(
      /at least one field/,
    );
    expect(server.requests).toHaveLength(0);
  });
});

describe("deleteAgent", () => {
  it("returns true when the server confirms without a deleted key", async () => {
    const server = new FakeServer();
    server.toolResults.delete_agent = { status: "success" };
    const client = makeClient(server);

    expect(await client.deleteAgent(AGENT.id)).toBe(true);
    expect(server.toolCallArgs()).toEqual({ agent_id: AGENT.id });
  });

  it("passes through an explicit deleted flag", async () => {
    const server = new FakeServer();
    server.toolResults.delete_agent = { status: "success", deleted: false };
    const client = makeClient(server);

    expect(await client.deleteAgent(AGENT.id)).toBe(false);
  });

  it("maps agent_not_found to KaguraNotFoundError", async () => {
    const server = new FakeServer();
    server.toolResults.delete_agent = {
      status: "error",
      error: "agent_not_found",
      message: "Agent not found",
    };
    const client = makeClient(server);

    await expect(client.deleteAgent(AGENT.id)).rejects.toThrow(KaguraNotFoundError);
  });
});
