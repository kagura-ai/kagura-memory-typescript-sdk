/**
 * Tests for WorkspaceClient (#225) — wire shapes, client-side guards,
 * error hints. Port of test_workspace_client.py (client-relevant parts;
 * the pydantic model-shape tests have no TS analogue because responses
 * are cast, not validated — the mint response alone is read as the
 * model reads it).
 *
 * Wire shapes assert the memory-cloud v0.42.0 contract verified against
 * the server source (issues #1164/#1165): canonical error envelope
 * `{"error", "message", "details"}`, integer invitation ids, no
 * invitation `status` field, `DELETE .../invitations/{id}` → 200
 * `{"success": true}`.
 */

import { describe, expect, it } from "vitest";

import {
  KaguraContextNotInAccessListError,
  KaguraPermissionError,
  KaguraResponseError,
  KaguraAuthError,
  KaguraConnectionError,
  KaguraError,
  KaguraNotFoundError,
  KaguraFeatureNotAvailableError,
  KaguraQuotaError,
} from "../src/errors.js";
import {
  readMemberKey,
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

describe("memory-cloud 0.144 member context access", () => {
  it.each([null, [], [WS]])("preserves the explicit access list on add and set: %j", async ids => {
    const server = new FakeRest();
    const client = makeClient(server);
    const row = { user_id: "a/b", role: "viewer", allowed_context_ids: ids };
    server.body = JSON.stringify(row);
    expect(await client.addMember(WS, "a/b", { role: "viewer", allowedContextIds: ids })).toMatchObject(row);
    expect(JSON.parse(server.requests[0]!.body!)).toEqual(row);
    server.body = JSON.stringify({ status: "ok", user_id: "a/b", allowed_context_ids: ids });
    expect((await client.setMemberContextAccess(WS, "a/b", ids)).allowed_context_ids).toEqual(ids);
    expect(server.requests[1]).toMatchObject({ method: "PUT", url: `https://x.test/api/v1/workspaces/${WS}/members/a%2Fb/context-access` });
    expect(JSON.parse(server.requests[1]!.body!)).toEqual({ allowed_context_ids: ids });
  });

  it("keeps [] after a role change and reads null when older servers omit the field", async () => {
    const server = new FakeRest();
    const client = makeClient(server);
    const row = { user_id: "u", role: "viewer" };
    server.body = JSON.stringify({ ...row, allowed_context_ids: [] });
    expect((await client.updateMemberRole(WS, "u", "viewer")).allowed_context_ids).toEqual([]);
    server.body = JSON.stringify(row);
    expect((await client.updateMemberRole(WS, "u", "viewer")).allowed_context_ids).toBeNull();
  });

  it("reads assignable private contexts with the owner key and rejects malformed rows", async () => {
    const server = new FakeRest();
    const client = makeClient(server);
    const context = { id: WS, name: "test", is_private: true, is_own_private: true };
    const row = { user_id: "a/b", role: "member", allowed_context_ids: [], contexts: [context] };
    server.body = JSON.stringify(row);
    expect(await client.getMemberContextAccess(WS, "a/b")).toMatchObject(row);
    expect(server.requests[0]).toMatchObject({ method: "GET", url: `https://x.test/api/v1/workspaces/${WS}/members/a%2Fb/context-access`, headers: { authorization: "Bearer kagura_test" } });
    server.body = JSON.stringify({ ...row, contexts: [{}] });
    await expect(client.getMemberContextAccess(WS, "a/b")).rejects.toBeInstanceOf(KaguraResponseError);
    server.body = JSON.stringify({ ...row, allowed_context_ids: "oops" });
    await expect(client.addMember(WS, "u")).rejects.toBeInstanceOf(KaguraResponseError);
  });

  it("preserves workspace confinement, required role and the deployment refusal", async () => {
    const server = new FakeRest();
    const client = makeClient(server);
    server.status = 404;
    await expect(client.getMemberContextAccess(WS, "u")).rejects.toBeInstanceOf(KaguraNotFoundError);
    server.status = 403;
    server.body = JSON.stringify({ error: "AUTH-003", message: "Insufficient permissions", details: { required_role: "owner" } });
    const denial = await caught(client.setMemberContextAccess(WS, "u", []));
    expect(denial).toBeInstanceOf(KaguraPermissionError);
    expect(denial).toMatchObject({ requiredRole: "owner", code: "AUTH-003" });
    server.body = envelope("AUTH-003", "Owner-API-key member management is disabled on this deployment.");
    const disabled = await caught(client.getMemberContextAccess(WS, "u"));
    expect(disabled).toBeInstanceOf(KaguraPermissionError);
    expect(disabled).toMatchObject({ code: "AUTH-003", requiredRole: null, message: expect.stringMatching(/disabled on this deployment/) });
  });

  it("uses session auth and extends only on explicit request after the typed 409", async () => {
    const server = new FakeRest();
    const client = new WorkspaceClient({ baseUrl: "https://x.test", session: true, fetch: (url, init) => {
      expect(init?.credentials).toBe("include");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return server.fetch(url, init);
    } });
    await expect(client.getMemberContextAccess(WS, "u")).rejects.toBeInstanceOf(KaguraAuthError);
    expect(server.requests).toHaveLength(0);
    const details = { reason: "context_not_in_access_list", context_id: WS, user_id: "u" };
    server.status = 409;
    server.body = JSON.stringify({ error: "RES-002", message: "Context outside list", details });
    const error = await caught(client.addContextMember(WS, "u", "editor"));
    expect(error).toBeInstanceOf(KaguraContextNotInAccessListError);
    expect(error).toMatchObject({ code: "RES-002", details });
    expect(server.requests).toHaveLength(1);
    expect(JSON.parse(server.requests[0]!.body!)).toEqual({ user_id: "u", role: "editor" });
    await expect(client.addContextMember(WS, "u", "editor", { extendAccessList: false })).rejects.toBeInstanceOf(KaguraContextNotInAccessListError);
    expect(JSON.parse(server.requests[1]!.body!)).toEqual({ user_id: "u", role: "editor", extend_access_list: false });
    server.status = 201;
    server.body = JSON.stringify({ user_id: "u", role: "editor", access_list_extended: true });
    expect((await client.addContextMember(WS, "u", "editor", { extendAccessList: true })).access_list_extended).toBe(true);
    expect(server.requests[2]).toMatchObject({ method: "POST", url: `https://x.test/api/v1/contexts/${WS}/members` });
    expect(JSON.parse(server.requests[2]!.body!)).toEqual({ user_id: "u", role: "editor", extend_access_list: true });
  });
});

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

  it.each([
    ["create_invitation", { id: "winv_1", role: 123 }],
    ["list_invitations", [{ id: "winv_1", role: "member", expires_at: "invalid-date" }]],
    ["list_member_keys", { api_keys: [{ id: "akey_1", name: "test", key_prefix: 123 }] }],
  ])("validates %s rows through the Python model", async (operation, body) => {
    const server = new FakeRest();
    server.body = JSON.stringify(body);
    const client = makeClient(server);
    const call = operation === "create_invitation"
      ? client.createInvitation(WS, "new@x.com", { role: "admin" })
      : operation === "list_invitations"
        ? client.listInvitations(WS)
        : client.listMemberKeys(WS, "user-1");
    await expect(call).rejects.toMatchObject({
      name: "KaguraResponseError", operation: `WorkspaceClient.${operation}`,
    });
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
      allowedContextIds: ["22222222-3333-4444-5555-666666666666"],
      expiresInDays: 7,
    });
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`https://x.test/api/v1/workspaces/${WS}/invitations`);
    expect(JSON.parse(req.body!)).toEqual({
      email: "new@x.com",
      role: "member",
      allowed_context_ids: ["22222222-3333-4444-5555-666666666666"],
      expires_in_days: 7,
    });
    expect(inv.id).toBe(7);
    expect(inv.invitation_url).not.toBeNull();
  });

  it("returns Python defaults and coerced invitation fields while dropping unknown fields", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify([{ id: "7", role: "admin", is_accepted: "false", created_at: "2026-07-03T00:00:00+00:00", extra: "ignored" }]);
    const rows = await makeClient(server).listInvitations(WS);
    expect(rows).toEqual([{
      id: "7", email: null, role: "admin", token: null, invitation_url: null,
      is_accepted: false, is_expired: false, created_at: "2026-07-03T00:00:00Z",
      expires_at: null, allowed_context_ids: null,
    }]);
  });

  it("createInvitation refuses a context that is no UUID before any request", async () => {
    // Python's create_invitation raises `allowed_context_ids must be a UUID, got 'ctx-1'`
    // (python-sdk #285: the server answered a non-UUID with HTTP 500).
    const server = new FakeRest();
    const client = makeClient(server);
    await expect(
      client.createInvitation(WS, "new@x.com", { allowedContextIds: ["22222222-3333-4444-5555-666666666666", "ctx-1"] }),
    ).rejects.toThrow("allowedContextIds must be a UUID, got 'ctx-1'");
    await expect(
      client.createInvitation(WS, "adm@x.com", { role: "admin", allowedContextIds: ["nope"] }),
    ).rejects.toThrow("allowedContextIds must be a UUID, got 'nope'");
    expect(server.requests).toHaveLength(0);
  });

  it("createInvitation sends each context in canonical form", async () => {
    const server = new FakeRest();
    server.status = 201;
    server.body = JSON.stringify({ id: 3, email: "v@x.com", role: "viewer" });
    const client = makeClient(server);
    await client.createInvitation(WS, "v@x.com", {
      role: "viewer",
      allowedContextIds: ["{22222222-3333-4444-5555-66666666666A}", "urn:uuid:99999999888877776666555555555555"],
    });
    expect(JSON.parse(server.requests[0]!.body!).allowed_context_ids).toEqual([
      "22222222-3333-4444-5555-66666666666a",
      "99999999-8888-7777-6666-555555555555",
    ]);
  });

  // Recorded from the Python SDK 0.42.0's `normalize_uuid` (`uuid.UUID`):
  // `urn:` and `uuid:` go anywhere, and `int(hex, 16)` takes a `0x`, padding
  // and single underscores once the string is 32 characters long.
  it.each([
    ["0x111111111111111111111111111111", "00111111-1111-1111-1111-111111111111"],
    ["1111urn:1111-2222-3333-4444-555555555555", "11111111-2222-3333-4444-555555555555"],
    ["uuid:urn:11111111222233334444555555555555", "11111111-2222-3333-4444-555555555555"],
    [" 1111111122223333444455555555555", "01111111-1222-2333-3444-455555555555"],
    ["1111_111122223333444455555555555", "01111111-1222-2333-3444-455555555555"],
  ])("createInvitation takes %j as the Python SDK does", async (spelling, canonical) => {
    const server = new FakeRest();
    server.status = 201;
    server.body = JSON.stringify({ id: 3, email: "v@x.com", role: "viewer" });
    const client = makeClient(server);
    await client.createInvitation(WS, "v@x.com", { role: "viewer", allowedContextIds: [spelling] });
    expect(JSON.parse(server.requests[0]!.body!).allowed_context_ids).toEqual([canonical]);
  });

  it("createInvitation refuses a padded canonical UUID, as uuid.UUID does", async () => {
    const server = new FakeRest();
    const client = makeClient(server);
    await expect(
      client.createInvitation(WS, "v@x.com", { role: "viewer", allowedContextIds: [` ${WS}`] }),
    ).rejects.toThrow(`allowedContextIds must be a UUID, got ' ${WS}'`);
    expect(server.requests).toHaveLength(0);
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

  it("refuses a destructive id past Number.MAX_SAFE_INTEGER as a number, which may be another id", async () => {
    // 9007199254740993 arrives here as 9007199254740992: a different key.
    const server = new FakeRest();
    const client = makeClient(server);

    await expect(client.revokeMemberKey(WS, "u2", 9007199254740993)).rejects.toThrow(
      "keyId must be a safe integer or a bigint, got 9007199254740992: a number past " +
        "Number.MAX_SAFE_INTEGER may already be rounded to a different id",
    );
    await expect(client.revokeInvitation(WS, 1e21)).rejects.toThrow(
      /invitationId must be a safe integer or a bigint, got 1e\+21/,
    );
    expect(server.requests).toHaveLength(0);
  });

  it("sends a bigint id exactly, as Python sends its int", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify({ success: true });
    const client = makeClient(server);

    await client.revokeInvitation(WS, 9007199254740993n);
    await client.revokeMemberKey(WS, "u2", 10n ** 21n);
    expect(server.requests.map((r) => r.url)).toEqual([
      `https://x.test/api/v1/workspaces/${WS}/invitations/9007199254740993`,
      `https://x.test/api/v1/workspaces/${WS}/members/u2/credentials/api-keys/1000000000000000000000`,
    ]);
  });

  it("sends string ids (memory-cloud v0.89.0+ `winv_…`, `akey_…`) as encoded path segments", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify({ success: true });
    const client = makeClient(server);

    await client.revokeInvitation(WS, "winv_4hT9xQ2mLp8vZr1sKc3dEf");
    await client.revokeMemberKey(WS, "u2", "akey_4hT9xQ2mLp8vZr1sKc3dEf");
    await client.revokeMemberKey(WS, "u2", "akey_a?b");
    expect(server.requests.map((r) => r.url)).toEqual([
      `https://x.test/api/v1/workspaces/${WS}/invitations/winv_4hT9xQ2mLp8vZr1sKc3dEf`,
      `https://x.test/api/v1/workspaces/${WS}/members/u2/credentials/api-keys/akey_4hT9xQ2mLp8vZr1sKc3dEf`,
      `https://x.test/api/v1/workspaces/${WS}/members/u2/credentials/api-keys/akey_a%3Fb`,
    ]);
  });

  it("refuses an empty, blank, . or .. string id before anything is sent", async () => {
    const server = new FakeRest();
    const client = makeClient(server);

    for (const id of ["", " ", ".", ".."]) {
      await expect(client.revokeInvitation(WS, id)).rejects.toThrow(/^invitationId must be /);
      await expect(client.revokeMemberKey(WS, "u2", id)).rejects.toThrow(/^keyId must be /);
    }
    expect(server.requests).toHaveLength(0);
  });

  it("refuses a user id of ., .. or nothing, which would address a different endpoint", async () => {
    // Percent-encoding leaves both as they are and URL resolution drops or
    // climbs the segment: removeMember(ws, "..") would DELETE the
    // workspace's own URL. An empty one makes `members/`. The Python SDK
    // sends all three.
    const server = new FakeRest();
    const client = makeClient(server);

    for (const id of [".", "..", ""]) {
      const refused = `userId must be a user id, got "${id}": as a URL path segment it would address a different endpoint`;
      await expect(client.removeMember(WS, id)).rejects.toThrow(refused);
      await expect(client.updateMemberRole(WS, id, "admin")).rejects.toThrow(refused);
      await expect(client.addMember(WS, id, "member")).rejects.toThrow(refused);
      await expect(client.mintMemberKey(WS, id, "ci", 30)).rejects.toThrow(refused);
      await expect(client.listMemberKeys(WS, id)).rejects.toThrow(refused);
      await expect(client.revokeMemberKey(WS, id, 42)).rejects.toThrow(refused);
    }
    expect(server.requests).toHaveLength(0);
  });

  it("percent-encodes a user id as one path segment (#66)", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify({ api_keys: [] });
    const client = makeClient(server);

    await client.listMemberKeys(WS, "a/../b?x=1#f");
    expect(server.requests[0]!.url).toBe(
      `https://x.test/api/v1/workspaces/${WS}/members/a%2F..%2Fb%3Fx%3D1%23f/credentials`,
    );
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
    // The Python SDK's words, which the CLI prints; still a plain KaguraError.
    expect((err as KaguraError).message).toBe(
      "WorkspaceClient.mint_member_key: server returned an unexpected mint response shape, " +
        "but the key WAS created. Save the plaintext now: kagura_salvaged_secret",
    );
  });

  it("reads the mint response as pydantic's lax MemberAPIKey: coerced, defaults filled, extras dropped", async () => {
    // `id: int | str` (Python SDK 0.42.1+): pydantic's smart-mode union
    // keeps the string `"42"` a string, where the `int` field made it 42.
    const server = new FakeRest();
    server.status = 201;
    server.body = JSON.stringify({
      id: "42",
      name: "n",
      key_prefix: "p",
      plaintext_key: "kp",
      is_visible: "false",
      // `agent_id` was the extra key here until the model gained it
      // (memory-cloud v0.118.0+, Python SDK 0.43.0); a key no model has now.
      future_field: "extra",
    });
    const client = makeClient(server);

    expect(await client.mintMemberKey(WS, "u2", "n", 30)).toEqual({
      id: "42",
      name: "n",
      key_prefix: "p",
      plaintext_key: "kp",
      is_visible: false,
      visibility_expires_at: null,
      created_at: null,
      last_used_at: null,
      revoked_at: null,
      expires_at: null,
      bound_context_id: null,
      default_context_id: null,
      default_context_name: null,
      agent_id: null,
      connector_id: null,
    });
  });

  it("reads a v0.141.0 key row's default context, agent and connector (memory-cloud v0.118.0+ / v0.129.0+)", async () => {
    const server = new FakeRest();
    server.status = 201;
    // An integer id, as a server before v0.89.0 sends it.
    server.body = JSON.stringify({
      id: 7,
      name: "connector:github",
      key_prefix: "kgr_abc",
      plaintext_key: "kp",
      is_visible: false,
      visibility_expires_at: null,
      created_at: "2026-11-01T00:00:00Z",
      revoked_at: null,
      default_context_id: "11111111-2222-4333-8444-555555555555",
      default_context_name: "dev",
      agent_id: null,
      connector_id: "conn-1",
    });
    const client = makeClient(server);

    const key = await client.mintMemberKey(WS, "u2", "n", 30);
    expect(key).toMatchObject({
      id: 7,
      default_context_id: "11111111-2222-4333-8444-555555555555",
      default_context_name: "dev",
      agent_id: null,
      connector_id: "conn-1",
    });
    expect(Object.keys(key).slice(-5)).toEqual([
      "bound_context_id",
      "default_context_id",
      "default_context_name",
      "agent_id",
      "connector_id",
    ]);
  });

  it("refuses a key row whose connector_id is no string, as the model does", () => {
    expect(() =>
      readMemberKey({ id: 1, name: "n", key_prefix: "p", connector_id: 5 }, "WorkspaceClient.list_member_keys"),
    ).toThrow(
      "WorkspaceClient.list_member_keys: unexpected server response for MemberAPIKey " +
        "(connector_id: Input should be a valid string).",
    );
  });

  it("refuses a mint response whose plaintext_key is no string, as the model does", async () => {
    const server = new FakeRest();
    server.status = 201;
    server.body = JSON.stringify({ id: 42, name: "n", key_prefix: "p", plaintext_key: 5 });
    const client = makeClient(server);

    const err = await caught(client.mintMemberKey(WS, "u2", "n", 30));
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).message).toBe(
      "WorkspaceClient.mint_member_key: server returned an unexpected mint response shape; " +
        "the key may have been created without displaying its plaintext — check " +
        "`kagura auth list-keys` and revoke/re-mint if present.",
    );
  });

  it("points at recovery when the mint shape mismatch has no plaintext", async () => {
    const server = new FakeRest();
    server.status = 201;
    server.body = JSON.stringify({ unexpected: true });
    const client = makeClient(server);

    const err = await caught(client.mintMemberKey(WS, "u2", "ci-bot", 30));
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).message).toBe(
      "WorkspaceClient.mint_member_key: server returned an unexpected mint response shape; " +
        "the key may have been created without displaying its plaintext — check " +
        "`kagura auth list-keys` and revoke/re-mint if present.",
    );
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

  // memory-cloud v0.89.0+ (memory-cloud#1008) sends `akey_…` ids (#102).
  const AKEY = "akey_3fJ0kQ7xWm2Lp9RtZa4bNc";
  const V089_KEY = {
    id: AKEY,
    name: "ci-bot",
    key_prefix: "kagura_3fJ0",
    plaintext_key: "kagura_3fJ0_secret",
    is_visible: false,
    visibility_expires_at: null,
    created_at: "2026-11-01T00:00:00Z",
    last_used_at: null,
    revoked_at: null,
    expires_at: "2027-01-30T00:00:00Z",
    bound_context_id: null,
    default_context_id: null,
    default_context_name: null,
    agent_id: null,
    connector_id: null,
  };

  it("mintMemberKey returns a v0.89.0 `akey_…` id as the string (#102)", async () => {
    const server = new FakeRest();
    server.status = 201;
    server.body = JSON.stringify(V089_KEY);
    const client = makeClient(server);

    const key = await client.mintMemberKey(WS, "google_2", "ci-bot", 90);
    expect(key).toEqual(V089_KEY);
    expect(key.id).toBe(AKEY);
  });

  it("mintMemberKey keeps an integer id an integer, as before v0.89.0", async () => {
    const server = new FakeRest();
    server.status = 201;
    server.body = JSON.stringify({ ...V089_KEY, id: 42 });
    const key = await makeClient(server).mintMemberKey(WS, "google_2", "ci-bot", 90);
    expect(key.id).toBe(42);
  });

  it.each([
    ["7.5", 7.5],
    ["null", null],
  ])("mintMemberKey salvages the plaintext when the id is %s, which neither int nor str takes", async (_label, id) => {
    const server = new FakeRest();
    server.status = 201;
    server.body = JSON.stringify({ ...V089_KEY, id });
    const err = await caught(makeClient(server).mintMemberKey(WS, "u2", "ci-bot", 30));
    expect(err).toBeInstanceOf(KaguraError);
    expect((err as KaguraError).message).toBe(
      "WorkspaceClient.mint_member_key: server returned an unexpected mint response shape, " +
        "but the key WAS created. Save the plaintext now: kagura_3fJ0_secret",
    );
  });

  it("readMemberKey names both members of `int | str` for an id neither takes", () => {
    expect(() => readMemberKey({ id: 7.5, name: "n", key_prefix: "p" }, "WorkspaceClient.list_member_keys")).toThrow(
      "WorkspaceClient.list_member_keys: unexpected server response for MemberAPIKey " +
        "(id.int: Input should be a valid integer, got a number with a fractional part; " +
        "id.str: Input should be a valid string).",
    );
  });

  it("listMemberKeys returns v0.89.0 `akey_…` ids as the strings (#102)", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify({
      api_keys: [
        { ...V089_KEY, plaintext_key: null },
        { ...V089_KEY, id: "akey_9ZyXwVuTsRqPoNmLkJiHgF", plaintext_key: null },
      ],
      target_user_role: "member",
    });
    const keys = await makeClient(server).listMemberKeys(WS, "google_2");
    expect(keys.map((k) => k.id)).toEqual([AKEY, "akey_9ZyXwVuTsRqPoNmLkJiHgF"]);
  });

  it("listMemberKeys guards the api_keys FIELD, not just the envelope", async () => {
    for (const body of ['[1,2]', '{"api_keys":null,"target_user_role":"member"}', '{"api_keys":{"oops":1}}']) {
      const server = new FakeRest();
      server.body = body;
      const client = makeClient(server);
      const err = await caught(client.listMemberKeys(WS, "u2"));
      // Python's `_expect_wrapped_list` words; the class this has always thrown.
      expect(err).toBeInstanceOf(KaguraConnectionError);
      expect((err as Error).message).toBe(
        "WorkspaceClient.list_member_keys: unexpected server response " +
          `(GET /api/v1/workspaces/${WS}/members/u2/credentials: expected an object carrying a ` +
          "'api_keys' array). The server may be newer than this SDK; upgrading kagura-memory may help.",
      );
    }
  });

  it("names the request's whole path, decoded, in a shape error, as httpx's url.path gives it", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify({ api_keys: null });
    const client = new WorkspaceClient({
      apiKey: "kagura_test",
      baseUrl: "https://x.test/kagura",
      fetch: server.fetch,
    });

    const err = await caught(client.listMemberKeys(WS, "a@b"));
    expect(server.requests[0]!.url).toBe(
      `https://x.test/kagura/api/v1/workspaces/${WS}/members/a%40b/credentials`,
    );
    expect((err as Error).message).toBe(
      "WorkspaceClient.list_member_keys: unexpected server response " +
        `(GET /kagura/api/v1/workspaces/${WS}/members/a@b/credentials: expected an object carrying a ` +
        "'api_keys' array). The server may be newer than this SDK; upgrading kagura-memory may help.",
    );
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

  it("maps the v0.75 team-invitations FEAT-001 to KaguraFeatureNotAvailableError", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "FEAT-001",
      message:
        "Feature 'team_invitations' not available on M plan. " +
        "Upgrade to L plan to access this feature.",
      details: {
        gate: "plan",
        feature: "team_invitations",
        required_plan: "pro",
        required_plan_display: "L",
        current_plan: "basic",
      },
    });
    const client = makeClient(server);

    const err = await caught(client.createInvitation(WS, "a@b.com", { role: "admin" }));
    expect(err).toBeInstanceOf(KaguraFeatureNotAvailableError);
    const plan = err as KaguraFeatureNotAvailableError;
    expect(plan.feature).toBe("team_invitations");
    expect(plan.requiredPlanDisplay).toBe("L");
    // The server's own message, without the generic "HTTP 403: " prefix.
    expect(plan.message).toBe(
      "Feature 'team_invitations' not available on M plan. " +
        "Upgrade to L plan to access this feature.",
    );
  });

  it("maps a pre-v0.75 FEAT-001 (public-bound member key) to KaguraFeatureNotAvailableError", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "FEAT-001",
      message: "Public-bound keys require the XL plan.",
      details: { feature: "resources" },
    });
    const client = makeClient(server);

    const err = await caught(client.mintMemberKey(WS, "google_2", "ci", 30));
    expect(err).toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect((err as KaguraFeatureNotAvailableError).feature).toBe("resources");
  });

  it("maps a 403 QUOTA-001 to KaguraQuotaError, not an ownership error", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "QUOTA-001",
      message: "Token limit reached.",
      details: { gate: "quota", quota_type: "resource_tokens", current: 3, limit: 3 },
    });
    const client = makeClient(server);

    const err = await caught(client.listMembers(WS));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect((err as KaguraQuotaError).quotaType).toBe("resource_tokens");
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

  it("scrubs a plan refusal's message carrying credential markers (#40)", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "FEAT-001",
      message: "Not on your plan. Echo: Authorization: Bearer kagura_leaked_key_value",
      details: { gate: "plan", feature: "team_invitations" },
    });
    const client = makeClient(server);

    const err = await caught(client.createInvitation(WS, "a@b.com", { role: "admin" }));
    expect(err).toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect((err as KaguraFeatureNotAvailableError).message).toBe("HTTP 403");
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

  it("reads a 429's details.retry_after when no Retry-After header came", async () => {
    const server = new FakeRest();
    server.status = 429;
    server.body = JSON.stringify({
      error: "RATE-001",
      message: "Too many requests. Please try again later.",
      details: { retry_after: 60 },
    });
    const client = makeClient(server);

    const err = await caught(client.createInvitation(WS, "a@b.com", { role: "admin" }));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect((err as KaguraQuotaError).message).toBe("Too many requests. Please try again later.");
    expect((err as KaguraQuotaError).retryAfter).toBe(60);
  });

  it("keeps a 429 a KaguraQuotaError even when its body reads as a plan refusal (#40)", async () => {
    const server = new FakeRest();
    server.status = 429;
    server.body = JSON.stringify({
      error: "FEAT-001",
      message: "Feature 'team_invitations' not available on M plan.",
      details: { gate: "plan", feature: "team_invitations" },
    });
    const client = makeClient(server);

    const err = await caught(client.createInvitation(WS, "a@b.com", { role: "admin" }));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    expect((err as KaguraQuotaError).message).toBe(
      "Feature 'team_invitations' not available on M plan.",
    );
  });

  it("maps the v0.75 member seat cap (429 QUOTA-001) to a KaguraQuotaError payload", async () => {
    const server = new FakeRest();
    server.status = 429;
    server.body = JSON.stringify({
      error: "QUOTA-001",
      message: "Member limit reached (5 seats). Current members: 4, Pending invitations: 1.",
      details: {
        gate: "quota",
        quota_type: "members",
        current: 5,
        limit: 5,
        required_plan: "pro",
        required_plan_display: "L",
        current_plan: "basic",
      },
    });
    const client = makeClient(server);

    const err = await caught(client.createInvitation(WS, "a@b.com", { role: "admin" }));
    expect(err).toBeInstanceOf(KaguraQuotaError);
    const quota = err as KaguraQuotaError;
    expect(quota.message).toContain("Member limit reached");
    expect(quota.gate).toBe("quota");
    expect(quota.quotaType).toBe("members");
    expect(quota.current).toBe(5);
    expect(quota.limit).toBe(5);
    expect(quota.requiredPlanDisplay).toBe("L");
    // A seat cap does not reset on a timer.
    expect(quota.retryAfter).toBeNull();
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

  it("rejects a non-array body on list endpoints, in the Python SDK's words", async () => {
    for (const [body, type] of [
      [{ oops: true }, "dict"],
      ["x", "str"],
      [null, "NoneType"],
      [1.5, "float"],
    ] as const) {
      const server = new FakeRest();
      server.body = JSON.stringify(body);
      const client = makeClient(server);

      const err = await caught(client.listInvitations(WS, { includeAccepted: true }));
      // The class these methods have always thrown; the query is no part of the path.
      expect(err).toBeInstanceOf(KaguraConnectionError);
      expect((err as Error).message).toBe(
        "WorkspaceClient.list_invitations: unexpected server response " +
          `(GET /api/v1/workspaces/${WS}/invitations: expected a JSON array, got ${type}). ` +
          "The server may be newer than this SDK; upgrading kagura-memory may help.",
      );
    }
    const server = new FakeRest();
    server.body = "{}";
    await expect(makeClient(server).listMembers(WS)).rejects.toThrow(
      `WorkspaceClient.list_members: unexpected server response (GET /api/v1/workspaces/${WS}/members: ` +
        "expected a JSON array, got dict).",
    );
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

// ---------------------------------------------------------------------------
// Workspace operation history (memory-cloud v0.154.0, #136)
// ---------------------------------------------------------------------------

describe("operation history (memory-cloud v0.154.0)", () => {
  const CTX = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const AGENT = "99999999-8888-7777-6666-555555555555";
  const HISTORY = `https://x.test/api/v1/workspaces/${WS}/operation-history`;
  const EVENT = {
    id: "12345678-1234-5678-9abc-def012345678",
    occurred_at: "2026-11-09T10:00:00.123456Z",
    context_id: CTX,
    actor_user_id: "google-oauth2|123",
    actor_name: "Ada",
    subject_user_id: "google-oauth2|456",
    agent_id: AGENT,
    principal_kind: "user",
    credential_id: "akey_abc",
    client_id: "kagura-cli",
    surface: "api",
    operation: "memory.updated",
    target_type: "memory",
    target_id: "m-1",
    outcome: "success",
    count: 1,
    changed_fields: ["summary", "tags"],
  };
  const NULLABLE = [
    "context_id", "actor_user_id", "actor_name", "subject_user_id", "agent_id",
    "credential_id", "client_id", "target_id",
  ] as const;
  const PAGE = { items: [EVENT], total: 1, total_capped: false, next_cursor: null, retention_days: 90 };

  function sessionClient(server: FakeRest): WorkspaceClient {
    return new WorkspaceClient({ baseUrl: "https://x.test", session: true, fetch: server.fetch });
  }

  function query(server: FakeRest, index = 0): URLSearchParams {
    return new URL(server.requests[index]!.url).searchParams;
  }

  it("reads a page over the web session: credentials included, no Authorization header", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify(PAGE);
    const seen: RequestInit[] = [];
    const client = new WorkspaceClient({
      baseUrl: "https://x.test",
      session: true,
      fetch: (url, init) => {
        seen.push(init!);
        return server.fetch(url, init);
      },
    });
    expect(await client.listOperationHistory(WS)).toEqual(PAGE);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ method: "GET", url: HISTORY, body: undefined });
    expect(server.requests[0]!.headers.authorization).toBeUndefined();
    expect(server.requests[0]!.headers["user-agent"]).toMatch(/^kagura-memory-sdk\//);
    expect(seen[0]!.credentials).toBe("include");
    expect(seen[0]!.redirect).toBe("error");
    expect(new Headers(seen[0]!.headers).has("authorization")).toBe(false);
  });

  it("normalizes the workspace id and refuses one that is no UUID before any request", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify(PAGE);
    const client = sessionClient(server);
    await client.listOperationHistory(`{${WS.toUpperCase()}}`);
    expect(server.requests[0]!.url).toBe(HISTORY);
    await expect(client.listOperationHistory("../x")).rejects.toThrow(/workspaceId must be a UUID/);
    expect(server.requests).toHaveLength(1);
  });

  it("reads an empty page, total_capped false when the server leaves it out", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify({ items: [], total: 0, next_cursor: null, retention_days: 90 });
    const page = await sessionClient(server).listOperationHistory(WS);
    expect(page).toEqual({ items: [], total: 0, total_capped: false, next_cursor: null, retention_days: 90 });
  });

  it("keeps a capped total and the add-on retention as sent", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify({ ...PAGE, total: 1000, total_capped: true, retention_days: 455 });
    const page = await sessionClient(server).listOperationHistory(WS);
    expect(page).toMatchObject({ total: 1000, total_capped: true, retention_days: 455 });
  });

  it("sends every filter under its wire name, in canonical form, and nothing else", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify(PAGE);
    const cursor = "WyIyMDI2LTExLTA5VDEwOjAwOjAwWiIsICJhYmMiXQ-_==";
    await sessionClient(server).listOperationHistory(WS, {
      query: "summary",
      contextId: `{${CTX.toUpperCase()}}`,
      actor: "google-oauth2|123",
      agentId: AGENT.replace(/-/g, ""),
      operation: "memory.updated",
      targetType: "memory",
      outcome: "success",
      since: "2026-11-01T00:00:00+09:00",
      until: new Date("2026-11-09T12:00:00.000Z"),
      limit: 100,
      cursor,
    });
    expect(server.requests[0]!.url).toBe(
      `${HISTORY}?query=summary&context_id=${CTX}&actor=google-oauth2%7C123&agent_id=${AGENT}` +
        "&operation=memory.updated&target_type=memory&outcome=success" +
        "&since=2026-11-01T00%3A00%3A00%2B09%3A00&until=2026-11-09T12%3A00%3A00.000Z&limit=100" +
        `&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(query(server).get("cursor")).toBe(cursor);
    expect(query(server).get("since")).toBe("2026-11-01T00:00:00+09:00");
  });

  it("leaves out every option that is not set, and sends no default limit", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify(PAGE);
    const client = sessionClient(server);
    await client.listOperationHistory(WS, {});
    await client.listOperationHistory(WS, {
      query: undefined, contextId: undefined, actor: undefined, agentId: undefined, operation: undefined,
      targetType: undefined, outcome: undefined, since: undefined, until: undefined, limit: undefined,
      cursor: undefined,
    });
    await client.listOperationHistory(WS, { outcome: "denied" });
    expect(server.requests.map((r) => r.url)).toEqual([HISTORY, HISTORY, `${HISTORY}?outcome=denied`]);
  });

  it("passes enum values the SDK does not know through for the server to judge", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify(PAGE);
    await sessionClient(server).listOperationHistory(WS, {
      operation: "future.op", targetType: "secret", outcome: "partial",
    });
    expect([...query(server).entries()]).toEqual([
      ["operation", "future.op"], ["target_type", "secret"], ["outcome", "partial"],
    ]);
  });

  it("reads two pages, handing next_cursor back unchanged", async () => {
    const server = new FakeRest();
    const client = sessionClient(server);
    const cursor = "eyJhdCI6ICIyMDI2LTExLTA5In0+/=";
    server.body = JSON.stringify({ ...PAGE, total: 2, next_cursor: cursor });
    const first = await client.listOperationHistory(WS, { limit: 1, outcome: "success" });
    expect(first.next_cursor).toBe(cursor);
    const second = { ...PAGE, total: 2, items: [{ ...EVENT, id: "22222222-1234-5678-9abc-def012345678" }] };
    server.body = JSON.stringify(second);
    expect(await client.listOperationHistory(WS, { limit: 1, outcome: "success", cursor: first.next_cursor! })).toEqual(second);
    expect(query(server, 0).has("cursor")).toBe(false);
    expect(query(server, 1).get("cursor")).toBe(cursor);
    expect([...query(server, 1).keys()]).toEqual(["outcome", "limit", "cursor"]);
  });

  it("sends a Date as its UTC instant and a string with an offset as written", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify(PAGE);
    const client = sessionClient(server);
    await client.listOperationHistory(WS, { since: new Date(Date.UTC(2026, 10, 1, 8, 30)), until: "2026-11-09T23:59:59.999999-05:00" });
    expect(query(server).get("since")).toBe("2026-11-01T08:30:00.000Z");
    expect(query(server).get("until")).toBe("2026-11-09T23:59:59.999999-05:00");
    await client.listOperationHistory(WS, { since: "2026-11-01T00:00Z", until: "2026-11-01T00:00:00z" });
    expect(query(server, 1).get("since")).toBe("2026-11-01T00:00Z");
    // Equal bounds are a window of one instant, which the server takes.
    await client.listOperationHistory(WS, { since: "2026-11-01T09:00:00+09:00", until: new Date("2026-11-01T00:00:00Z") });
    expect(server.requests).toHaveLength(3);
  });

  it.each([
    ["a naive datetime", "2026-11-01T00:00:00"],
    ["a date alone", "2026-11-01"],
    ["a Unix time", "1762000000"],
    ["text", "yesterday"],
    ["an impossible day", "2026-02-30T00:00:00Z"],
    ["an empty string", ""],
  ])("refuses %s for since/until before any request", async (_label, value) => {
    const server = new FakeRest();
    const client = sessionClient(server);
    await expect(client.listOperationHistory(WS, { since: value })).rejects.toThrow(/since must be an ISO 8601 datetime with a timezone offset/);
    await expect(client.listOperationHistory(WS, { until: value })).rejects.toThrow(/until must be an ISO 8601 datetime with a timezone offset/);
    expect(server.requests).toHaveLength(0);
  });

  it("refuses an invalid Date, a Date outside years 1-9999 and a value that is no time", async () => {
    const server = new FakeRest();
    const client = sessionClient(server);
    await expect(client.listOperationHistory(WS, { since: new Date(Number.NaN) })).rejects.toThrow(/since must be a valid Date/);
    await expect(client.listOperationHistory(WS, { until: new Date(Date.UTC(10000, 0, 1)) })).rejects.toThrow(/until must be a valid Date/);
    await expect(
      client.listOperationHistory(WS, { since: 1762000000 as unknown as string }),
    ).rejects.toThrow(/since must be an ISO 8601 datetime with a timezone offset or a Date/);
    expect(server.requests).toHaveLength(0);
  });

  it("refuses since after until, comparing instants across offsets", async () => {
    const server = new FakeRest();
    const client = sessionClient(server);
    // 10:00+09:00 is 01:00Z, before 02:00Z: accepted.
    server.body = JSON.stringify(PAGE);
    await client.listOperationHistory(WS, { since: "2026-11-09T10:00:00+09:00", until: "2026-11-09T02:00:00Z" });
    expect(server.requests).toHaveLength(1);
    await expect(
      client.listOperationHistory(WS, { since: "2026-11-09T02:00:00Z", until: "2026-11-09T10:00:00+09:00" }),
    ).rejects.toThrow(/since must not be after until/);
    await expect(
      client.listOperationHistory(WS, { since: "2026-11-09T00:00:00.000001Z", until: new Date("2026-11-09T00:00:00Z") }),
    ).rejects.toThrow(/since must not be after until/);
    await expect(
      client.listOperationHistory(WS, { since: new Date("2026-11-10T00:00:00Z"), until: new Date("2026-11-09T00:00:00Z") }),
    ).rejects.toThrow(/since must not be after until/);
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    ["query", 120],
    ["actor", 255],
    ["operation", 40],
    ["cursor", 512],
  ] as const)("bounds %s at %i characters, counted in code points", async (name, max) => {
    const server = new FakeRest();
    server.body = JSON.stringify(PAGE);
    const client = sessionClient(server);
    // Two UTF-16 units each, one code point each, as the server counts.
    const atLimit = "😀".repeat(max);
    await client.listOperationHistory(WS, { [name]: atLimit });
    expect(query(server).get(name)).toBe(atLimit);
    await expect(client.listOperationHistory(WS, { [name]: "a".repeat(max + 1) })).rejects.toThrow(
      new RegExp(`${name} must be at most ${max} characters, got ${max + 1}`),
    );
    await expect(client.listOperationHistory(WS, { [name]: 7 as unknown as string })).rejects.toThrow(
      new RegExp(`${name} must be a string`),
    );
    expect(server.requests).toHaveLength(1);
  });

  it("bounds limit to an integer in 1-100", async () => {
    const server = new FakeRest();
    server.body = JSON.stringify(PAGE);
    const client = sessionClient(server);
    await client.listOperationHistory(WS, { limit: 1 });
    await client.listOperationHistory(WS, { limit: 100 });
    expect([query(server, 0).get("limit"), query(server, 1).get("limit")]).toEqual(["1", "100"]);
    for (const bad of [0, 101, 1.5, Number.NaN, "5" as unknown as number]) {
      await expect(client.listOperationHistory(WS, { limit: bad })).rejects.toThrow(/limit must be an integer between 1 and 100/);
    }
    expect(server.requests).toHaveLength(2);
  });

  it("refuses a contextId or agentId that is no UUID before any request", async () => {
    const server = new FakeRest();
    const client = sessionClient(server);
    await expect(client.listOperationHistory(WS, { contextId: "ctx" })).rejects.toThrow(/contextId must be a UUID/);
    await expect(client.listOperationHistory(WS, { agentId: "agent-1" })).rejects.toThrow(/agentId must be a UUID/);
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    ["an API key", { apiKey: "kagura_test" }],
    ["an OAuth token", { oauth: { getAuthHeader: async () => "Bearer oauth-token" } }],
  ])("refuses a client built with %s before any request", async (_label, credential) => {
    const server = new FakeRest();
    server.body = JSON.stringify(PAGE);
    const client = new WorkspaceClient({ baseUrl: "https://x.test", fetch: server.fetch, ...credential });
    const error = await caught(client.listOperationHistory(WS, { limit: 5 }));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(KaguraError);
    expect((error as Error).message).toBe(
      "WorkspaceClient.listOperationHistory: the operation-history route accepts a signed-in web session only, " +
        "not an API key, OAuth or resource token. Build a session client with " +
        "new WorkspaceClient({ baseUrl, session: true, fetch }), where fetch carries the session cookie.",
    );
    expect(server.requests).toHaveLength(0);
  });

  it("refuses a bearer client from fromMcpUrl before any request, before checking arguments", async () => {
    const server = new FakeRest();
    const client = WorkspaceClient.fromMcpUrl({ apiKey: "kagura_test", mcpUrl: "https://x.test/mcp", fetch: server.fetch, env: {} });
    await expect(client.listOperationHistory("not-a-uuid", { limit: 0 })).rejects.toThrow(/accepts a signed-in web session only/);
    expect(server.requests).toHaveLength(0);
  });

  it("reads nullable fields as null and keeps unknown fields on the page and on items", async () => {
    const server = new FakeRest();
    const item = { ...EVENT, ...Object.fromEntries(NULLABLE.map((key) => [key, null])), changed_fields: [], risk: { level: 2 } };
    const body = { ...PAGE, items: [item], next_cursor: null, export_url: "https://x.test/export", window: [1, 2] };
    server.body = JSON.stringify(body);
    const page = await sessionClient(server).listOperationHistory(WS);
    expect(page).toEqual(body);
    for (const key of NULLABLE) expect(page.items[0]![key]).toBeNull();
    expect(page.items[0]!.risk).toEqual({ level: 2 });
    expect(page.export_url).toBe("https://x.test/export");
  });

  it.each([
    ["no items", { ...PAGE, items: undefined }],
    ["items that are no list", { ...PAGE, items: {} }],
    ["a total that is no integer", { ...PAGE, total: "many" }],
    ["no retention_days", { ...PAGE, retention_days: undefined }],
    ["no next_cursor key", { ...PAGE, next_cursor: undefined }],
    ["an item without its id", { ...PAGE, items: [{ ...EVENT, id: undefined }] }],
    ["an item whose nullable field is absent", { ...PAGE, items: [{ ...EVENT, actor_name: undefined }] }],
    ["an item whose occurred_at is no datetime", { ...PAGE, items: [{ ...EVENT, occurred_at: "soon" }] }],
    ["an item whose changed_fields is no list", { ...PAGE, items: [{ ...EVENT, changed_fields: "summary" }] }],
    ["an item whose count is no integer", { ...PAGE, items: [{ ...EVENT, count: 1.5 }] }],
    ["an array", [PAGE]],
  ])("throws KaguraResponseError for a reply with %s", async (_label, body) => {
    const server = new FakeRest();
    server.body = JSON.stringify(body);
    const error = await caught(sessionClient(server).listOperationHistory(WS));
    expect(error).toBeInstanceOf(KaguraResponseError);
    expect((error as Error).message).toContain("WorkspaceClient.list_operation_history");
  });

  it("maps an expired session to KaguraAuthError naming the history, not an empty page", async () => {
    const server = new FakeRest();
    server.status = 401;
    server.body = envelope("AUTH-001", "Not authenticated");
    const error = await caught(sessionClient(server).listOperationHistory(WS));
    expect(error).toBeInstanceOf(KaguraAuthError);
    expect((error as Error).message).toBe("A signed-in session is required to read workspace operation history.");
    expect(error).toMatchObject({ code: "AUTH-001" });
    // The context-member call keeps its own words.
    await expect(sessionClient(server).addContextMember(CTX, "u", "editor")).rejects.toThrow(
      "A signed-in session is required to add a context member.",
    );
  });

  it("maps the owner/admin refusal to KaguraPermissionError with the required role", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({ error: "AUTH-003", message: "Insufficient permissions", details: { required_role: "admin" } });
    const error = await caught(sessionClient(server).listOperationHistory(WS));
    expect(error).toBeInstanceOf(KaguraPermissionError);
    expect(error).toMatchObject({ code: "AUTH-003", requiredRole: "admin", message: "Insufficient permissions" });
  });

  it("maps v0.154.0's own 401 and uniform 403 bodies, never to an empty page", async () => {
    const server = new FakeRest();
    const client = sessionClient(server);
    // `require_session_auth` without a session: HTTPException(401) in the HTTP-401 envelope.
    server.status = 401;
    server.body = envelope("HTTP-401", "Not authenticated");
    const expired = await caught(client.listOperationHistory(WS));
    expect(expired).toBeInstanceOf(KaguraAuthError);
    expect(expired).toMatchObject({
      code: "HTTP-401",
      message: "A signed-in session is required to read workspace operation history.",
    });
    // `check_workspace_admin`: a role too low, no membership, or no such
    // workspace all answer AuthorizationError, its details stripped.
    server.status = 403;
    server.body = envelope("AUTH-101", "Insufficient permissions");
    const refused = await caught(client.listOperationHistory(WS));
    expect(refused).toBeInstanceOf(KaguraPermissionError);
    expect(refused).toMatchObject({ code: "AUTH-101", requiredRole: null, message: "Insufficient permissions" });
  });

  it("maps a suspended admin seat to KaguraFeatureNotAvailableError for members", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "FEAT-001",
      message: "Members above the plan's seats are paused.",
      details: { gate: "plan", feature: "members", required_plan: "pro", required_plan_display: "L", current_plan: "basic", limit: 3, current: 5 },
    });
    const error = await caught(sessionClient(server).listOperationHistory(WS));
    expect(error).toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect(error).toMatchObject({ feature: "members", code: "FEAT-001" });
  });

  it("returns unknown numeric fields as plain numbers, on the page and on items", async () => {
    const server = new FakeRest();
    server.body = `{"items": [${JSON.stringify(EVENT).slice(0, -1)}, "weight": 2.5, "rank": 7}], ` +
      `"total": 1, "next_cursor": null, "retention_days": 90, "score": 3, "ratio": 0.25}`;
    const page = await sessionClient(server).listOperationHistory(WS);
    for (const value of [page.total, page.retention_days, page.score, page.ratio, page.items[0]!.count, page.items[0]!.weight, page.items[0]!.rank]) {
      expect(typeof value).toBe("number");
    }
    expect(page).toEqual({ ...PAGE, items: [{ ...EVENT, weight: 2.5, rank: 7 }], score: 3, ratio: 0.25 });
  });

  it("maps the plan gate to KaguraFeatureNotAvailableError", async () => {
    const server = new FakeRest();
    server.status = 403;
    server.body = JSON.stringify({
      error: "FEAT-001",
      message: "Feature 'operation_history' not available on M plan. Upgrade to L plan to access this feature.",
      details: { gate: "plan", feature: "operation_history", required_plan: "pro", required_plan_display: "L", current_plan: "basic" },
    });
    const error = await caught(sessionClient(server).listOperationHistory(WS));
    expect(error).toBeInstanceOf(KaguraFeatureNotAvailableError);
    expect(error).toMatchObject({ feature: "operation_history", requiredPlan: "pro", code: "FEAT-001" });
  });

  it("keeps the server's 404 and 422 envelopes", async () => {
    const server = new FakeRest();
    const client = sessionClient(server);
    // memory-cloud v0.153.0 has no such route: Starlette's 404, in its HTTP-404 envelope.
    server.status = 404;
    server.body = envelope("HTTP-404", "Not Found");
    const missing = await caught(client.listOperationHistory(WS));
    expect(missing).toBeInstanceOf(KaguraNotFoundError);
    expect(missing).toMatchObject({ code: "HTTP-404", message: "Not Found" });
    server.status = 422;
    server.body = JSON.stringify({ error: "VAL-001", message: "Invalid operation history cursor", details: { field: "cursor" } });
    const invalid = await caught(client.listOperationHistory(WS, { cursor: "x" }));
    expect(invalid).toBeInstanceOf(KaguraConnectionError);
    expect(invalid).toMatchObject({ code: "VAL-001", details: { field: "cursor" } });
    expect((invalid as Error).message).toBe("HTTP 422: Invalid operation history cursor");
  });
});
