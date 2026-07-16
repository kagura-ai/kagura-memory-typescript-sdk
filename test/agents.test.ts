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

const CONTEXT_ID = "9c8b7a6d-5e4f-4321-a0b9-c8d7e6f5a4b3";

const BINDING = {
  id: "1b2c3d4e-5f60-4718-92a3-b4c5d6e7f809",
  agent_id: AGENT.id,
  context_id: CONTEXT_ID,
  can_read: true,
  write_policy: "deny",
  is_default: false,
  allowed_memory_types: null,
  allowed_source_types: null,
  created_by: "user-1",
  created_at: "2026-07-16T00:00:00Z",
  updated_at: "2026-07-16T00:00:00Z",
};

describe("bindAgentContext", () => {
  it("sends only the required ids by default and returns the binding", async () => {
    const server = new FakeServer();
    server.toolResults.bind_agent_context = { status: "success", binding: BINDING };
    const client = makeClient(server);

    const binding = await client.bindAgentContext({
      agentId: AGENT.id,
      contextId: CONTEXT_ID,
    });

    expect(server.toolCallArgs()).toEqual({ agent_id: AGENT.id, context_id: CONTEXT_ID });
    expect(binding.id).toBe(BINDING.id);
    expect(binding.write_policy).toBe("deny");
  });

  it("sends the scope trio when provided, including canRead=false", async () => {
    const server = new FakeServer();
    server.toolResults.bind_agent_context = { status: "success", binding: BINDING };
    const client = makeClient(server);

    await client.bindAgentContext({
      agentId: AGENT.id,
      contextId: CONTEXT_ID,
      canRead: false,
      writePolicy: "direct",
      isDefault: true,
    });

    expect(server.toolCallArgs()).toEqual({
      agent_id: AGENT.id,
      context_id: CONTEXT_ID,
      can_read: false,
      write_policy: "direct",
      is_default: true,
    });
  });

  it("throws KaguraConnectionError when the binding envelope is missing", async () => {
    const server = new FakeServer();
    server.toolResults.bind_agent_context = { status: "success" };
    const client = makeClient(server);

    await expect(
      client.bindAgentContext({ agentId: AGENT.id, contextId: CONTEXT_ID }),
    ).rejects.toThrow(KaguraConnectionError);
  });
});

describe("listAgentBindings", () => {
  it("passes agent_id and returns the bindings array", async () => {
    const server = new FakeServer();
    server.toolResults.list_agent_bindings = { status: "success", bindings: [BINDING] };
    const client = makeClient(server);

    const bindings = await client.listAgentBindings(AGENT.id);

    expect(server.toolCallArgs()).toEqual({ agent_id: AGENT.id });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.context_id).toBe(CONTEXT_ID);
  });

  it("returns [] when the bindings key is missing", async () => {
    const server = new FakeServer();
    server.toolResults.list_agent_bindings = { status: "success" };
    const client = makeClient(server);

    expect(await client.listAgentBindings(AGENT.id)).toEqual([]);
  });
});

describe("updateAgentBinding", () => {
  it("sends only the provided scope fields", async () => {
    const server = new FakeServer();
    server.toolResults.update_agent_binding = {
      status: "success",
      binding: { ...BINDING, is_default: true },
    };
    const client = makeClient(server);

    const binding = await client.updateAgentBinding({
      agentId: AGENT.id,
      bindingId: BINDING.id,
      isDefault: true,
    });

    expect(server.toolCallArgs()).toEqual({
      agent_id: AGENT.id,
      binding_id: BINDING.id,
      is_default: true,
    });
    expect(binding.is_default).toBe(true);
  });

  it("throws when no scope field is provided", async () => {
    const server = new FakeServer();
    const client = makeClient(server);

    await expect(
      client.updateAgentBinding({ agentId: AGENT.id, bindingId: BINDING.id }),
    ).rejects.toThrow(/at least one of/);
    expect(server.requests).toHaveLength(0);
  });

  it("maps binding_not_found to KaguraNotFoundError", async () => {
    const server = new FakeServer();
    server.toolResults.update_agent_binding = {
      status: "error",
      error: "binding_not_found",
      message: "Binding not found",
    };
    const client = makeClient(server);

    await expect(
      client.updateAgentBinding({ agentId: AGENT.id, bindingId: BINDING.id, canRead: false }),
    ).rejects.toThrow(KaguraNotFoundError);
  });
});

describe("unbindAgentContext", () => {
  it("returns true when the server confirms without a deleted key", async () => {
    const server = new FakeServer();
    server.toolResults.unbind_agent_context = { status: "success" };
    const client = makeClient(server);

    expect(
      await client.unbindAgentContext({ agentId: AGENT.id, bindingId: BINDING.id }),
    ).toBe(true);
    expect(server.toolCallArgs()).toEqual({ agent_id: AGENT.id, binding_id: BINDING.id });
  });

  it("passes through an explicit deleted flag", async () => {
    const server = new FakeServer();
    server.toolResults.unbind_agent_context = { status: "success", deleted: false };
    const client = makeClient(server);

    expect(
      await client.unbindAgentContext({ agentId: AGENT.id, bindingId: BINDING.id }),
    ).toBe(false);
  });
});

const BOOTSTRAP = {
  status: "success",
  degraded: false,
  agent: {
    agent_id: AGENT.id,
    name: "ci-agent",
    binding: { context_id: CONTEXT_ID, is_default: true },
  },
  context: { id: CONTEXT_ID, name: "kagura-dev" },
  instructions: "Use recall before answering.",
  components: {
    pinned: { status: "ok", memories: [] },
    recall: { status: "skipped", reason: "no query" },
  },
  correlation: { agent_id: AGENT.id, session_id: "run-42" },
  generated_at: "2026-07-16T00:00:00Z",
};

describe("getAgentBootstrap", () => {
  it("sends only agent_id by default and returns the composed envelope", async () => {
    const server = new FakeServer();
    server.toolResults.get_agent_bootstrap = BOOTSTRAP;
    const client = makeClient(server);

    const bootstrap = await client.getAgentBootstrap({ agentId: AGENT.id });

    expect(server.toolCallArgs()).toEqual({ agent_id: AGENT.id });
    expect(bootstrap.agent.agent_id).toBe(AGENT.id);
    expect(bootstrap.agent.binding?.context_id).toBe(CONTEXT_ID);
    expect(bootstrap.components?.recall?.status).toBe("skipped");
    expect(bootstrap.degraded).toBe(false);
  });

  it("maps every optional argument to its snake_case wire name", async () => {
    const server = new FakeServer();
    server.toolResults.get_agent_bootstrap = BOOTSTRAP;
    const client = makeClient(server);

    await client.getAgentBootstrap({
      agentId: AGENT.id,
      contextId: CONTEXT_ID,
      sessionId: "run-42",
      query: "session summary",
      recallK: 7,
      pinnedCap: 50,
      upcomingUntil: "2026-08-01T00:00:00",
      include: ["pinned", "recall"],
    });

    expect(server.toolCallArgs()).toEqual({
      agent_id: AGENT.id,
      context_id: CONTEXT_ID,
      session_id: "run-42",
      query: "session summary",
      recall_k: 7,
      pinned_cap: 50,
      upcoming_until: "2026-08-01T00:00:00",
      include: ["pinned", "recall"],
    });
  });

  it("passes a degraded envelope through untouched", async () => {
    const server = new FakeServer();
    server.toolResults.get_agent_bootstrap = {
      ...BOOTSTRAP,
      degraded: true,
      components: { pinned: { status: "error", error: "timeout" } },
    };
    const client = makeClient(server);

    const bootstrap = await client.getAgentBootstrap({ agentId: AGENT.id });

    expect(bootstrap.degraded).toBe(true);
    expect(bootstrap.components?.pinned?.status).toBe("error");
  });

  it("maps agent_not_found to KaguraNotFoundError", async () => {
    const server = new FakeServer();
    server.toolResults.get_agent_bootstrap = {
      status: "error",
      error: "agent_not_found",
      message: "Agent not found",
    };
    const client = makeClient(server);

    await expect(client.getAgentBootstrap({ agentId: AGENT.id })).rejects.toThrow(
      KaguraNotFoundError,
    );
  });
});
