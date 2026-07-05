/**
 * Tests for WorkspaceClient (#225) — wire shapes, client-side guards,
 * error hints. Port of test_workspace_client.py (client-relevant parts;
 * the pydantic model-shape tests have no TS analogue because responses
 * are cast, not validated).
 *
 * Wire shapes assert the memory-cloud v0.42.0 contract verified against
 * the server source (issues #1164/#1165): canonical error envelope
 * `{"error", "message", "details"}`, integer invitation ids, no
 * invitation `status` field, `DELETE .../invitations/{id}` → 200
 * `{"success": true}`.
 */

import { describe, expect, it } from "vitest";

import {
  KaguraAuthError,
  KaguraConnectionError,
  KaguraError,
  KaguraNotFoundError,
  KaguraQuotaError,
} from "../src/errors.js";
import {
  VALID_ASSIGNABLE_ROLES,
  VALID_INVITE_EXPIRES,
  WorkspaceClient,
} from "../src/workspaceClient.js";

const WS = "11111111-2222-3333-4444-555555555555";

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

function makeClient(server: FakeRest): WorkspaceClient {
  return new WorkspaceClient({
    apiKey: "kagura_test",
    baseUrl: "https://x.test",
    fetch: server.fetch,
  });
}

/** memory-cloud canonical error envelope (v0.42.0). */
function envelope(code: string, message: string): string {
  return JSON.stringify({ error: code, message, details: {} });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (e: unknown) => e,
  );
}

describe("construction", () => {
  it("requires credentials, naming the class and its factory", () => {
    expect(() => new WorkspaceClient()).toThrow(
      /WorkspaceClient requires apiKey, or use WorkspaceClient\.fromMcpUrl/,
    );
  });

  it("rejects plain-HTTP base URLs", () => {
    expect(
      () => new WorkspaceClient({ apiKey: "k", baseUrl: "http://memory.example.com" }),
    ).toThrow(/HTTPS/);
  });

  it("excludes owner from the assignable roles and pins the expiry presets", () => {
    expect(VALID_ASSIGNABLE_ROLES).not.toContain("owner");
    expect([...VALID_ASSIGNABLE_ROLES].sort()).toEqual(["admin", "member", "viewer"]);
    expect([...VALID_INVITE_EXPIRES]).toEqual([7, 30, 90, 365]);
  });
});

describe("members", () => {
  it("listMembers GETs the members path and returns the rows", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify([
      {
        user_id: "u1",
        role: "owner",
        user_email: "o@x.com",
        user_name: "Owner",
        joined_at: "2026-06-01T00:00:00Z",
        credentials_status: { api_key_count: 2 },
        last_login_at: null,
        allowed_context_ids: null,
      },
      { user_id: "u2", role: "member", joined_at: "2026-06-02T00:00:00Z" },
    ]);
    const client = makeClient(server);

    const members = await client.listMembers(WS);
    const req = server.requests[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`https://x.test/api/v1/workspaces/${WS}/members`);
    expect(members.map((m) => m.user_id)).toEqual(["u1", "u2"]);
    expect(members[0]!.role).toBe("owner");
  });

  it("addMember POSTs the snake_case body with the role", async () => {
    const server = new FakeRest();
    server.status = 201;
    server.body = JSON.stringify({
      user_id: "u3",
      role: "admin",
      joined_at: "2026-07-01T00:00:00Z",
    });
    const client = makeClient(server);

    const member = await client.addMember(WS, "u3", "admin");
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(JSON.parse(req.body!)).toEqual({ user_id: "u3", role: "admin" });
    expect(member.role).toBe("admin");
  });

  it("addMember rejects role=owner client-side, before the wire", async () => {
    const server = new FakeRest();
    server.status = 500;
    const client = makeClient(server);

    await expect(client.addMember(WS, "u3", "owner")).rejects.toThrow(/owner/);
    expect(server.requests).toHaveLength(0);
  });

  it("updateMemberRole percent-encodes the userId path segment", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify({
      user_id: "a/b#c",
      role: "member",
      joined_at: "2026-07-01T00:00:00Z",
    });
    const client = makeClient(server);

    await client.updateMemberRole(WS, "a/b#c", "member");
    const req = server.requests[0]!;
    expect(req.method).toBe("PUT");
    expect(req.url).toContain("a%2Fb%23c"); // slash and hash percent-encoded
    expect(JSON.parse(req.body!)).toEqual({ role: "member" });
  });

  it("removeMember resolves on 204 with a DELETE to the member path", async () => {
    const server = new FakeRest();
    server.status = 204;
    server.body = "";
    const client = makeClient(server);

    await expect(client.removeMember(WS, "u2")).resolves.toBeUndefined();
    const req = server.requests[0]!;
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe(`https://x.test/api/v1/workspaces/${WS}/members/u2`);
  });

  it("validates the workspaceId before anything hits the wire", async () => {
    const server = new FakeRest();
    server.status = 500;
    const client = makeClient(server);

    await expect(client.listMembers("../../etc")).rejects.toThrow(/UUID/);
    expect(server.requests).toHaveLength(0);
  });

  it("normalizes braced/uppercase workspace ids to canonical form", async () => {
    const server = new FakeRest();
    server.body = "[]";
    const client = makeClient(server);

    // Windows registry format: braces + uppercase → canonical lowercase
    await client.listMembers("{11111111-2222-3333-4444-555555555555}");
    expect(server.requests[0]!.url).toBe(`https://x.test/api/v1/workspaces/${WS}/members`);
  });
});

describe("invitations", () => {
  it("createInvitation requires a context grant for member/viewer client-side", async () => {
    const server = new FakeRest();
    server.status = 500;
    const client = makeClient(server);

    await expect(client.createInvitation(WS, "new@x.com")).rejects.toThrow(/allowedContextIds/);
    expect(server.requests).toHaveLength(0);
  });

  it("createInvitation rejects a non-preset expiry client-side", async () => {
    const server = new FakeRest();
    server.status = 500;
    const client = makeClient(server);

    await expect(
      client.createInvitation(WS, "new@x.com", { role: "admin", expiresInDays: 14 }),
    ).rejects.toThrow(/7, 30, 90, 365/);
    expect(server.requests).toHaveLength(0);
  });

  it("createInvitation POSTs the full snake_case body and returns the token-bearing row", async () => {
    const server = new FakeRest();
    server.status = 201;
    server.body = JSON.stringify({
      id: 7,
      email: "new@x.com",
      role: "member",
      token: "tok_0123456789abcdef0123",
      invitation_url: "https://memory.kagura-ai.com/invite/tok",
      is_accepted: false,
      is_expired: false,
    });
    const client = makeClient(server);

    const inv = await client.createInvitation(WS, "new@x.com", {
      allowedContextIds: ["ctx-1"],
      expiresInDays: 7,
    });
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`https://x.test/api/v1/workspaces/${WS}/invitations`);
    expect(JSON.parse(req.body!)).toEqual({
      email: "new@x.com",
      role: "member",
      allowed_context_ids: ["ctx-1"],
      expires_in_days: 7,
    });
    expect(inv.id).toBe(7);
    expect(inv.invitation_url).not.toBeNull();
  });

  it("createInvitation for admin sends only email and role", async () => {
    const server = new FakeRest();
    server.status = 201;
    server.body = JSON.stringify({ id: 9, email: "adm@x.com", role: "admin" });
    const client = makeClient(server);

    const inv = await client.createInvitation(WS, "adm@x.com", { role: "admin" });
    expect(JSON.parse(server.requests[0]!.body!)).toEqual({ email: "adm@x.com", role: "admin" });
    expect(inv.id).toBe(9);
  });

  it("listInvitations passes include_accepted=true and omits it by default", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify([
      {
        id: 8,
        email: "x@y.com",
        role: "viewer",
        token: null,
        invitation_url: null,
        is_accepted: true,
        is_expired: false,
      },
    ]);
    const client = makeClient(server);

    const invs = await client.listInvitations(WS, { includeAccepted: true });
    expect(server.requests[0]!.url).toBe(
      `https://x.test/api/v1/workspaces/${WS}/invitations?include_accepted=true`,
    );
    expect(invs[0]!.is_accepted).toBe(true);
    expect(invs[0]!.token).toBeNull();

    await client.listInvitations(WS);
    expect(server.requests[1]!.url).toBe(`https://x.test/api/v1/workspaces/${WS}/invitations`);
  });

  it("revokeInvitation DELETEs by integer id and tolerates the 200 success body", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify({ success: true }); // 200, NOT 204
    const client = makeClient(server);

    await expect(client.revokeInvitation(WS, 7)).resolves.toBeUndefined();
    const req = server.requests[0]!;
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe(`https://x.test/api/v1/workspaces/${WS}/invitations/7`);
  });

  it("destructive ids and expiry require strict integers", async () => {
    const server = new FakeRest();
    server.status = 500;
    const client = makeClient(server);

    await expect(client.revokeInvitation(WS, 7.9)).rejects.toThrow(
      /invitationId must be an integer/,
    );
    await expect(client.revokeMemberKey(WS, "u2", 42.9)).rejects.toThrow(
      /keyId must be an integer/,
    );
    await expect(client.mintMemberKey(WS, "u2", "x", 90.5)).rejects.toThrow(
      /expiresDays must be an integer/,
    );
    expect(server.requests).toHaveLength(0);
  });
});

describe("member API keys", () => {
  it("mintMemberKey POSTs name and expires_days and returns the one-time plaintext", async () => {
    const server = new FakeRest();
    server.status = 201;
    server.body = JSON.stringify({
      id: 42,
      name: "ci-bot",
      key_prefix: "kagura_abcdef123",
      plaintext_key: "kagura_abcdef1234567890",
      is_visible: false,
      visibility_expires_at: null,
      created_at: "2026-07-03T00:00:00Z",
      last_used_at: null,
      revoked_at: null,
      expires_at: "2026-10-01T00:00:00Z",
      bound_context_id: null,
    });
    const client = makeClient(server);

    const key = await client.mintMemberKey(WS, "google_2", "ci-bot", 90);
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(
      `https://x.test/api/v1/workspaces/${WS}/members/google_2/credentials/api-keys`,
    );
    expect(JSON.parse(req.body!)).toEqual({ name: "ci-bot", expires_days: 90 });
    expect(key.id).toBe(42);
    expect(key.plaintext_key).toBe("kagura_abcdef1234567890");
    expect(key.expires_at).not.toBeNull();
  });

  it("mintMemberKey validates the 1-3650 expiry bounds client-side", async () => {
    const server = new FakeRest();
    server.status = 500;
    const client = makeClient(server);

    await expect(client.mintMemberKey(WS, "google_2", "ci-bot", 0)).rejects.toThrow(/1-3650/);
    await expect(client.mintMemberKey(WS, "google_2", "ci-bot", 3651)).rejects.toThrow(/1-3650/);
    expect(server.requests).toHaveLength(0);
  });

  it("salvages the plaintext when the mint response shape drifts", async () => {
    const server = new FakeRest();
    server.status = 201;
    // Server drift: required fields renamed, but the one-time secret is there
    server.body = JSON.stringify({ plaintext_key: "kagura_salvaged_secret" });
    const client = makeClient(server);

    const err = await caught(client.mintMemberKey(WS, "u2", "ci-bot", 30));
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).message).toContain("kagura_salvaged_secret");
  });

  it("points at recovery when the mint shape mismatch has no plaintext", async () => {
    const server = new FakeRest();
    server.status = 201;
    server.body = JSON.stringify({ unexpected: true });
    const client = makeClient(server);

    const err = await caught(client.mintMemberKey(WS, "u2", "ci-bot", 30));
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).message).toMatch(/list-keys/);
  });

  it("listMemberKeys parses the MemberCredentialsResponse envelope", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify({
      api_keys: [
        {
          id: 42,
          name: "ci-bot",
          key_prefix: "kagura_abcdef123",
          plaintext_key: null, // always null programmatically
          is_visible: false,
          created_at: "2026-07-03T00:00:00Z",
          revoked_at: null,
          expires_at: "2026-10-01T00:00:00Z",
        },
      ],
      target_user_role: "member",
    });
    const client = makeClient(server);

    const keys = await client.listMemberKeys(WS, "google_2");
    const req = server.requests[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`https://x.test/api/v1/workspaces/${WS}/members/google_2/credentials`);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.id).toBe(42);
    expect(keys[0]!.plaintext_key).toBeNull();
  });

  it("listMemberKeys guards the api_keys FIELD, not just the envelope", async () => {
    for (const body of ['[1,2]', '{"api_keys":null,"target_user_role":"member"}', '{"api_keys":{"oops":1}}']) {
      const server = new FakeRest();
      server.body = body;
      const client = makeClient(server);
      await expect(client.listMemberKeys(WS, "u2")).rejects.toThrow(/api_keys/);
    }
  });

  it("revokeMemberKey DELETEs the key path and accepts a 200 status body", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify({ status: "revoked", key_id: 42 });
    const client = makeClient(server);

    await expect(client.revokeMemberKey(WS, "google_2", 42)).resolves.toBeUndefined();
    const req = server.requests[0]!;
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe(
      `https://x.test/api/v1/workspaces/${WS}/members/google_2/credentials/api-keys/42`,
    );
  });

  it("percent-encodes the userId segment on the credentials path", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify({ api_keys: [], target_user_role: "member" });
    const client = makeClient(server);

    await client.listMemberKeys(WS, "a/b#c");
    expect(server.requests[0]!.url).toContain("a%2Fb%23c");
  });
});

describe("error mapping (v0.42.0 canonical envelope)", () => {
  it("maps 401 to KaguraAuthError", async () => {
    const server = new FakeRest();
    server.status = 401;
    server.body = envelope("AUTH-100", "Not authenticated");
    const client = makeClient(server);

    await expect(client.listMembers(WS)).rejects.toBeInstanceOf(KaguraAuthError);
  });

  it("appends the owner-key hint to the uniform 403 denial", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = envelope("AUTH-101", "Insufficient permissions");
    const client = makeClient(server);

    const err = await caught(client.listMembers(WS));
    expect(err).toBeInstanceOf(KaguraConnectionError);
    expect((err as KaguraConnectionError).message).toContain("OWNER's API key");
  });

  it("passes a purpose-built 403 message through verbatim", async () => {
    // OAuth rejection / deployment kill-switch messages are already
    // actionable — the client must not rewrite them as a role failure.
    const server = new FakeRest();
    server.status = 403;
    server.body = envelope(
      "AUTH-101",
      "Owner-API-key member management is disabled on this deployment. " +
        "Use a workspace-owner session.",
    );
    const client = makeClient(server);

    const err = await caught(client.listMembers(WS));
    expect(err).toBeInstanceOf(KaguraConnectionError);
    expect((err as KaguraConnectionError).message).toContain("disabled on this deployment");
    expect((err as KaguraConnectionError).message).not.toContain("OWNER's API key");
  });

  it("passes the plan-gate 403 through", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = envelope(
      "HTTP-403",
      "Team invitations require Pro plan. Upgrade your plan to invite team members.",
    );
    const client = makeClient(server);

    const err = await caught(client.createInvitation(WS, "a@b.com", { role: "admin" }));
    expect((err as KaguraConnectionError).message).toContain("Pro plan");
  });

  it("scrubs a 403 detail carrying credential markers, falling back to the hint", async () => {
    // A hostile/buggy 403 echoing credentials must not be printed verbatim.
    const server = new FakeRest();
    server.status = 403;
    server.body = envelope("AUTH-101", "Denied for Authorization: Bearer kagura_leaked_key_value");
    const client = makeClient(server);

    const err = await caught(client.listMembers(WS));
    expect((err as KaguraConnectionError).message).not.toContain("kagura_leaked_key_value");
    expect((err as KaguraConnectionError).message).toContain("OWNER's API key");
  });

  it("names the static credential source and workspace prefix in the uniform-403 hint", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = envelope("AUTH-101", "Insufficient permissions");
    const client = new WorkspaceClient({
      apiKey: "kagura_test",
      baseUrl: "https://x.test",
      fetch: server.fetch,
      authSource: "config",
      workspaceIdHint: WS,
    });

    const err = await caught(client.listMembers(WS));
    const msg = (err as KaguraConnectionError).message;
    expect(msg).toContain("credential source");
    expect(msg).toContain(".kagura.json");
    expect(msg).toContain(WS.slice(0, 8)); // workspace hint prefix, never the full wire value
    expect(msg).not.toContain(WS.slice(0, 12));
  });

  it("surfaces the 404 envelope message as KaguraNotFoundError", async () => {
    // Uniform confinement 404 (#963): workspace-scoped key vs foreign path
    const server = new FakeRest();
    server.status = 404;
    server.body = envelope("RES-001", "Workspace not found");
    const client = makeClient(server);

    const err = await caught(client.listMembers(WS));
    expect(err).toBeInstanceOf(KaguraNotFoundError);
    expect((err as KaguraNotFoundError).message).toBe("Workspace not found");
  });

  it("surfaces a legacy {detail} 404 body", async () => {
    // Some raw-HTTPException 404s still use FastAPI's {"detail": ...}
    const server = new FakeRest();
    server.status = 404;
    server.body = JSON.stringify({ detail: "Invitation 7 not found" });
    const client = makeClient(server);

    const err = await caught(client.revokeInvitation(WS, 7));
    expect(err).toBeInstanceOf(KaguraNotFoundError);
    expect((err as KaguraNotFoundError).message).toBe("Invitation 7 not found");
  });

  it("keeps the server's 429 quota message and Retry-After", async () => {
    const server = new FakeRest();
    server.status = 429;
    server.body = envelope(
      "HTTP-429",
      "Member limit reached (5 seats). Current members: 4, Pending invitations: 1.",
    );
    server.responseHeaders = { "Retry-After": "30" };
    const client = makeClient(server);

    const err = await caught(
      client.createInvitation(WS, "a@b.com", { role: "admin" }),
    );
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect((err as KaguraQuotaError).message).toContain("Member limit reached");
    expect((err as KaguraQuotaError).retryAfter).toBe(30);
  });

  it("names the failing field from a 422 validation envelope", async () => {
    const server = new FakeRest();
    server.status = 422;
    server.body = JSON.stringify({
      error: "VAL-001",
      message: "Request validation failed",
      details: {
        errors: [
          {
            loc: ["body", "role"],
            msg: "Value error, role=owner invitations are not supported",
            type: "value_error",
          },
        ],
      },
    });
    const client = makeClient(server);

    const err = await caught(client.createInvitation(WS, "a@b.com", { role: "admin" }));
    expect(err).toBeInstanceOf(KaguraConnectionError);
    expect((err as KaguraConnectionError).message).toContain("body.role");
  });

  it("maps a non-JSON 200 to KaguraConnectionError", async () => {
    const server = new FakeRest();
    server.body = "<html>maintenance</html>";
    const client = makeClient(server);

    await expect(client.listMembers(WS)).rejects.toThrow(/non-JSON body/);
  });

  it("rejects a non-array body on list endpoints", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify({ oops: true });
    const client = makeClient(server);

    await expect(client.listInvitations(WS)).rejects.toThrow(/expected a JSON array/);
  });

  it("maps other statuses to the generic connection error", async () => {
    const server = new FakeRest();
    server.status = 500;
    server.body = envelope("SYS-001", "boom");
    const client = makeClient(server);

    await expect(client.listMembers(WS)).rejects.toThrow(/HTTP 500: boom/);
  });

  it("wraps network failures as KaguraConnectionError", async () => {
    const server = new FakeRest();
    server.error = new TypeError("fetch failed");
    const client = makeClient(server);

    await expect(client.listMembers(WS)).rejects.toThrow(/Connection failed/);
  });
});
