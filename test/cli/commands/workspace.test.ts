/**
 * `kagura-memory workspace …` and `kagura-memory auth create-key|list-keys|
 * revoke-key` — ports of the Python CLI's commands. The cases follow
 * tests/test_cli_workspace.py and tests/test_cli_auth_keys.py; the lines
 * pinned verbatim were produced by the Python declarations under click
 * 8.3.3 and pydantic 2.13.4.
 *
 * The client is the real WorkspaceClient, built from the credential the
 * command resolved, over a fetch stub: what reaches the wire, and the
 * 403 hint the source produces, are the real ones.
 */

import { describe, expect, it } from "vitest";

import type { ResolvedAuth } from "../../../src/auth/types.js";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import type { KaguraConfig } from "../../../src/config.js";
import { KaguraAuthError } from "../../../src/errors.js";
import { restClientFromAuth } from "../../../src/restBase.js";
import { WorkspaceClient } from "../../../src/workspaceClient.js";
import { FakeRest } from "../../fakeServer.js";

const WS = "11111111-2222-3333-4444-555555555555";
const OTHER_WS = "99999999-8888-7777-6666-555555555555";
const OAUTH_WS = "aaaaaaaa-0000-0000-0000-000000000000";
const CTX = "22222222-3333-4444-5555-666666666666";
const PLAINTEXT = "kagura_secret_plaintext_value_0123456789";

const CONFIG: KaguraConfig = { api_key: "kagura_test", mcp_url: "https://test.com/mcp", context_id: WS };

const CONFIG_KEY: ResolvedAuth = {
  kind: "static",
  apiKey: "kagura_test",
  mcpUrl: "https://test.com/mcp",
  source: "config",
};
const ENV_KEY: ResolvedAuth = { ...CONFIG_KEY, apiKey: "kagura_env_key", source: "env" };
const OAUTH: ResolvedAuth = {
  kind: "oauth",
  oauth: { getAuthHeader: async () => "Bearer oauth-token" },
  mcpUrl: "https://test.com/mcp",
  workspaceId: OAUTH_WS,
};

const UPGRADE = "The server may be newer than this SDK; upgrading kagura-memory may help.";

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  rest: FakeRest;
  /** Questions asked, in order. */
  questions: string[];
  /** What was read or built, in order. */
  calls: string[];
  /** The credential and 403 hint each client was built from. */
  built: Array<{ auth: ResolvedAuth | undefined; hint: string | null | undefined }>;
}

function harness(
  options: { config?: KaguraConfig; auth?: ResolvedAuth | Error; confirm?: boolean } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const rest = new FakeRest();
  const questions: string[] = [];
  const calls: string[] = [];
  const built: Harness["built"] = [];
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async (question: string) => {
      questions.push(question);
      return options.confirm ?? true;
    },
    loadConfig: () => {
      calls.push("loadConfig");
      return options.config ?? CONFIG;
    },
    resolveAuth: () => {
      calls.push("resolveAuth");
      const auth = options.auth ?? CONFIG_KEY;
      if (auth instanceof Error) throw auth;
      return auth;
    },
    makeWorkspaceClient: (auth: ResolvedAuth | undefined, hint: string | null | undefined) => {
      calls.push("makeWorkspaceClient");
      built.push({ auth, hint });
      return restClientFromAuth(WorkspaceClient, auth!, { workspaceIdHint: hint ?? null, fetch: rest.fetch });
    },
    makeClient: () => {
      throw new Error("MCP client not expected here");
    },
  } as unknown as CliDeps;
  return { deps, out, err, rest, questions, calls, built };
}

function reply(h: Harness, body: unknown, status = 200): void {
  h.rest.status = status;
  h.rest.body = JSON.stringify(body);
}

function lastRequest(h: Harness) {
  return h.rest.requests[h.rest.requests.length - 1]!;
}

function sentJson(h: Harness): unknown {
  return JSON.parse(lastRequest(h).body!);
}

// ---------------------------------------------------------------------------
// member
// ---------------------------------------------------------------------------

describe("workspace member list", () => {
  it("renders Python's table, padding by code point and never cutting", async () => {
    const h = harness();
    reply(h, [
      { user_id: "google_1", role: "owner", user_email: "o@x.com", user_name: "Owner", joined_at: "2026-06-01T00:00:00Z" },
      { user_id: "google_2", role: "member", user_email: null, joined_at: null },
      { user_id: "google_2_very_long_user_identifier_xx", role: "member", user_email: "" },
      { user_id: "ユーザー", role: "viewer", user_email: "ü@x.com", joined_at: "2026-06-01T23:30:00-05:00" },
    ]);
    expect(await runCli(["workspace", "member", "list"], h.deps)).toBe(0);
    expect(h.out).toEqual([
      [
        "USER                         ROLE     EMAIL                          JOINED",
        "google_1                     owner    o@x.com                        2026-06-01",
        "google_2                     member   -                              -",
        "google_2_very_long_user_identifier_xx member   -                              -",
        // The date in the offset the server wrote, as `.date()` gives it.
        "ユーザー                         viewer   ü@x.com                        2026-06-01",
      ].join("\n"),
    ]);
    expect(h.err).toEqual([]);
    const req = lastRequest(h);
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`https://test.com/api/v1/workspaces/${WS}/members`);
  });

  it("prints the header alone for no members", async () => {
    const h = harness();
    reply(h, []);
    expect(await runCli(["workspace", "member", "list"], h.deps)).toBe(0);
    expect(h.out).toEqual(["USER                         ROLE     EMAIL                          JOINED"]);
  });

  it("prints --json as Python's model dump: every field, in order, defaults filled, extras dropped", async () => {
    const h = harness();
    reply(h, [
      {
        extra: 1,
        credentials_status: {
          api_key_count: 2,
          api_key_visible: false,
          claude_app_visible: true,
          chatgpt_app_visible: false,
          custom_app_count: 0,
        },
        allowed_context_ids: ["c1"],
        joined_at: "2026-06-01T00:00:00Z",
        user_name: "Owner",
        user_email: "o@x.com",
        role: "owner",
        user_id: "google_1",
      },
      { role: "member", user_id: "google_2" },
    ]);
    expect(await runCli(["workspace", "member", "list", "--json"], h.deps)).toBe(0);
    expect(h.out).toEqual([
      [
        "[",
        "  {",
        '    "user_id": "google_1",',
        '    "role": "owner",',
        '    "user_name": "Owner",',
        '    "user_email": "o@x.com",',
        '    "joined_at": "2026-06-01T00:00:00Z",',
        '    "last_login_at": null,',
        '    "allowed_context_ids": [',
        '      "c1"',
        "    ],",
        '    "credentials_status": {',
        '      "api_key_count": 2,',
        '      "api_key_visible": false,',
        '      "claude_app_visible": true,',
        '      "chatgpt_app_visible": false,',
        '      "custom_app_count": 0',
        "    }",
        "  },",
        "  {",
        '    "user_id": "google_2",',
        '    "role": "member",',
        '    "user_name": null,',
        '    "user_email": null,',
        '    "joined_at": null,',
        '    "last_login_at": null,',
        '    "allowed_context_ids": null,',
        '    "credentials_status": null',
        "  }",
        "]",
      ].join("\n"),
    ]);
  });

  it("prints [] for no members under --json", async () => {
    const h = harness();
    reply(h, []);
    expect(await runCli(["workspace", "member", "list", "--json"], h.deps)).toBe(0);
    expect(h.out).toEqual(["[]"]);
  });

  it("refuses a row missing a required field in the Python SDK's words (exit 1)", async () => {
    const h = harness();
    reply(h, [{ user_id: "google_1", role: "owner" }, { user_id: "google_2" }]);
    expect(await runCli(["workspace", "member", "list"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      `Error: WorkspaceClient.list_members: unexpected server response for WorkspaceMember (role: Field required). ${UPGRADE}`,
    ]);
    expect(h.out).toEqual([]);
  });

  it("refuses a row that is no object, and a mistyped field, naming the field only", async () => {
    const a = harness();
    reply(a, ["google_1"]);
    expect(await runCli(["workspace", "member", "list", "--json"], a.deps)).toBe(1);
    expect(a.err).toEqual([
      "Error: WorkspaceClient.list_members: unexpected server response for WorkspaceMember " +
        `(Input should be a valid dictionary or instance of WorkspaceMember). ${UPGRADE}`,
    ]);

    const b = harness();
    reply(b, [{ user_id: "google_1", role: "owner", user_email: 12345 }]);
    expect(await runCli(["workspace", "member", "list"], b.deps)).toBe(1);
    expect(b.err).toEqual([
      "Error: WorkspaceClient.list_members: unexpected server response for WorkspaceMember " +
        `(user_email: Input should be a valid string). ${UPGRADE}`,
    ]);
    expect(b.err.join("\n")).not.toContain("12345");
  });

  // Each text is Python 0.40.1's parse_response for the same row.
  it.each([
    [{ allowed_context_ids: "c1" }, "allowed_context_ids: Input should be a valid list"],
    [{ allowed_context_ids: { a: 1 } }, "allowed_context_ids: Input should be a valid list"],
    [
      { allowed_context_ids: ["c1", 5, null] },
      "allowed_context_ids.1: Input should be a valid string; allowed_context_ids.2: Input should be a valid string",
    ],
    [{ credentials_status: [1] }, "credentials_status: Input should be a valid dictionary"],
    [{ credentials_status: "x" }, "credentials_status: Input should be a valid dictionary"],
    [
      { user_id: 5, allowed_context_ids: "c1", credentials_status: [1] },
      "user_id: Input should be a valid string; allowed_context_ids: Input should be a valid list; " +
        "credentials_status: Input should be a valid dictionary",
    ],
  ])("refuses a list or mapping field of the wrong type, as the model does: %j", async (fields, problems) => {
    const h = harness();
    reply(h, [{ user_id: "google_1", role: "member", ...fields }]);
    expect(await runCli(["workspace", "member", "list", "--json"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      `Error: WorkspaceClient.list_members: unexpected server response for WorkspaceMember (${problems}). ${UPGRADE}`,
    ]);
    expect(h.out).toEqual([]);
  });

  it("keeps a null or well-typed list and mapping as sent", async () => {
    const h = harness();
    reply(h, [
      { user_id: "u1", role: "member", allowed_context_ids: null, credentials_status: null },
      { user_id: "u2", role: "member", allowed_context_ids: ["c1"], credentials_status: { "1": 2 } },
    ]);
    expect(await runCli(["workspace", "member", "list", "--json"], h.deps)).toBe(0);
    const rows = JSON.parse(h.out.join("\n")) as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.allowed_context_ids, r.credentials_status])).toEqual([
      [null, null],
      [["c1"], { "1": 2 }],
    ]);
  });

  it("refuses a body that is no list, as Python's SDK words it", async () => {
    const h = harness();
    reply(h, { members: [] });
    expect(await runCli(["workspace", "member", "list"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: WorkspaceClient.list_members: unexpected server response " +
        `(GET /api/v1/workspaces/${WS}/members: expected a JSON array, got dict). ${UPGRADE}`,
    ]);
  });

  it("targets --workspace / -w over the source's workspace, canonical on the wire", async () => {
    for (const flag of ["--workspace", "-w"]) {
      const h = harness();
      reply(h, []);
      expect(await runCli(["workspace", "member", "list", flag, OTHER_WS.toUpperCase()], h.deps)).toBe(0);
      expect(lastRequest(h).url).toBe(`https://test.com/api/v1/workspaces/${OTHER_WS}/members`);
      // The hint stays the source's own workspace: it describes the key.
      expect(h.built).toEqual([{ auth: CONFIG_KEY, hint: WS }]);
    }
  });

  it("builds the client from the credential it resolved", async () => {
    const h = harness({ auth: OAUTH, config: { context_id: WS } });
    reply(h, []);
    expect(await runCli(["workspace", "member", "list"], h.deps)).toBe(0);
    // An OAuth profile targets its own workspace, never .kagura.json's.
    expect(lastRequest(h).url).toBe(`https://test.com/api/v1/workspaces/${OAUTH_WS}/members`);
    expect(lastRequest(h).headers.authorization).toBe("Bearer oauth-token");
    expect(h.calls).toEqual(["loadConfig", "resolveAuth", "makeWorkspaceClient"]);
  });

  it("refuses extra arguments (exit 2)", async () => {
    const h = harness();
    expect(await runCli(["workspace", "member", "list", "b", "c"], h.deps)).toBe(2);
    expect(h.err).toEqual(["Error: Got unexpected extra arguments (b c)"]);
    expect(h.calls).toEqual([]);
  });
});

describe("workspace member add / set-role", () => {
  it("adds with the given role and prints the response's values", async () => {
    const h = harness();
    reply(h, { user_id: "google_3", role: "viewer", joined_at: "2026-07-03T01:02:03Z" }, 201);
    expect(await runCli(["workspace", "member", "add", "google_3", "--role", "viewer"], h.deps)).toBe(0);
    expect(h.out).toEqual(["Added google_3 as viewer"]);
    const req = lastRequest(h);
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`https://test.com/api/v1/workspaces/${WS}/members`);
    expect(sentJson(h)).toEqual({ user_id: "google_3", role: "viewer" });
  });

  it.each(["owner", "Admin", "MEMBER"])(
    "refuses --role %s as click's case-sensitive Choice does (exit 2), before any credential",
    async (role) => {
      const h = harness();
      expect(await runCli(["workspace", "member", "add", "google_3", "--role", role], h.deps)).toBe(2);
      expect(h.err).toEqual([
        `Error: Invalid value for '--role': '${role}' is not one of 'member', 'admin', 'viewer'.`,
      ]);
      expect(h.calls).toEqual([]);
    },
  );

  it("names the choices when --role is missing", async () => {
    const h = harness();
    expect(await runCli(["workspace", "member", "add", "google_3"], h.deps)).toBe(2);
    expect(h.err).toEqual(["Error: Missing option '--role'. Choose from:\n\tmember,\n\tadmin,\n\tviewer"]);
  });

  it("requires USER_ID", async () => {
    const h = harness();
    expect(await runCli(["workspace", "member", "set-role", "--role", "admin"], h.deps)).toBe(2);
    expect(h.err).toEqual(["Error: Missing argument 'USER_ID'."]);
  });

  it("changes a role with PUT on the percent-encoded member path", async () => {
    const h = harness();
    reply(h, { user_id: "google/2", role: "admin" });
    expect(await runCli(["workspace", "member", "set-role", "google/2", "--role", "admin"], h.deps)).toBe(0);
    expect(h.out).toEqual(["google/2 is now admin"]);
    const req = lastRequest(h);
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(`https://test.com/api/v1/workspaces/${WS}/members/google%2F2`);
    expect(sentJson(h)).toEqual({ role: "admin" });
  });

  it("reads the response as a WorkspaceMember", async () => {
    const h = harness();
    reply(h, { user_id: "google_2" });
    expect(await runCli(["workspace", "member", "set-role", "google_2", "--role", "admin"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      `Error: WorkspaceClient.update_member_role: unexpected server response for WorkspaceMember (role: Field required). ${UPGRADE}`,
    ]);
  });
});

describe("workspace member remove", () => {
  it("asks first, naming the workspace as resolved, and sends nothing on a decline", async () => {
    const h = harness({ confirm: false });
    expect(await runCli(["workspace", "member", "remove", "google_2"], h.deps)).toBe(1);
    expect(h.questions).toEqual([`Remove google_2 from workspace ${WS}?`]);
    // The bin's convention for a declined prompt.
    expect(h.err).toEqual(["Error: Aborted!"]);
    expect(h.rest.requests).toEqual([]);
    expect(h.calls).not.toContain("makeWorkspaceClient");
  });

  it("names a --workspace override in the question as typed, stripped", async () => {
    const h = harness({ confirm: false });
    expect(await runCli(["workspace", "member", "remove", "google_2", "-w", ` ${OTHER_WS} `], h.deps)).toBe(1);
    expect(h.questions).toEqual([`Remove google_2 from workspace ${OTHER_WS}?`]);
  });

  it.each([["--yes"], ["-y"]])("removes without asking under %s", async (yes) => {
    const h = harness();
    h.rest.status = 204;
    expect(await runCli(["workspace", "member", "remove", "google_2", yes], h.deps)).toBe(0);
    expect(h.questions).toEqual([]);
    expect(h.out).toEqual(["Removed google_2"]);
    const req = lastRequest(h);
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe(`https://test.com/api/v1/workspaces/${WS}/members/google_2`);
  });

  it("removes after a yes", async () => {
    const h = harness({ confirm: true });
    h.rest.status = 204;
    expect(await runCli(["workspace", "member", "remove", "google_2"], h.deps)).toBe(0);
    expect(h.out).toEqual(["Removed google_2"]);
  });

  it("refuses a workspace that is no UUID before asking", async () => {
    const h = harness({ confirm: true });
    expect(await runCli(["workspace", "member", "remove", "google_2", "-w", "AUTO"], h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: workspace_id must be a UUID, got 'AUTO'"]);
    expect(h.questions).toEqual([]);
    expect(h.rest.requests).toEqual([]);
  });

  // Recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4):
  // `kagura workspace member remove google_2 -w ' {11111111222233334444555555555555}'`
  // asks "Remove google_2 from workspace 11111111-2222-3333-4444-555555555555? [y/N]:".
  it("asks about the workspace in canonical form, as the request names it", async () => {
    const h = harness({ confirm: true });
    h.rest.status = 204;
    const argv = ["workspace", "member", "remove", "google_2", "-w", ` {${WS.replace(/-/g, "").toUpperCase()}}`];
    expect(await runCli(argv, h.deps)).toBe(0);
    expect(h.questions).toEqual([`Remove google_2 from workspace ${WS}?`]);
    expect(lastRequest(h).url).toBe(`https://test.com/api/v1/workspaces/${WS}/members/google_2`);
  });

  it("asks revoke-key about the workspace in canonical form too", async () => {
    // Python: "Revoke key #42 of google_2 in workspace 11111111-2222-3333-4444-55555555555a?"
    // for -w 'urn:uuid:11111111-2222-3333-4444-55555555555A'.
    const h = harness({ confirm: false });
    const upper = "urn:uuid:11111111-2222-3333-4444-55555555555A";
    expect(await runCli(["auth", "revoke-key", "42", "-u", "google_2", "-w", upper], h.deps)).toBe(1);
    expect(h.questions).toEqual(["Revoke key #42 of google_2 in workspace 11111111-2222-3333-4444-55555555555a?"]);
  });

  it("checks a .kagura.json context_id the same way", async () => {
    const h = harness({ config: { api_key: "k", context_id: "not-a-uuid" } });
    expect(await runCli(["workspace", "member", "remove", "google_2"], h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: workspace_id must be a UUID, got 'not-a-uuid'"]);
    expect(h.questions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// credential-source pairing (#115) and the --workspace guard
// ---------------------------------------------------------------------------

describe("the workspace a command targets", () => {
  it.each(["", "   ", "auto", " auto "])(
    "refuses --workspace %j before reading anything (exit 1)",
    async (value) => {
      const h = harness();
      expect(await runCli(["workspace", "member", "remove", "google_2", "--yes", "--workspace", value], h.deps)).toBe(1);
      expect(h.err).toEqual([
        "Error: --workspace was provided but empty (or 'auto') — refusing to fall back to the " +
          "credential source's workspace. Pass the target workspace UUID.",
      ]);
      expect(h.calls).toEqual([]);
      expect(h.rest.requests).toEqual([]);
    },
  );

  it("refuses an env key without --workspace, naming --workspace, not --context-id", async () => {
    const h = harness({ auth: ENV_KEY, config: { context_id: WS } });
    expect(await runCli(["workspace", "member", "list"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: api_key from KAGURA_API_KEY env has no associated workspace; pass --workspace " +
        "(mixing api_key and OAuth profile's workspace is not allowed — see issue #115).",
    ]);
    expect(h.err.join("\n")).not.toContain("--context-id");
    expect(h.rest.requests).toEqual([]);
  });

  it("refuses an OAuth profile with no workspace bound", async () => {
    const h = harness({ auth: { ...OAUTH, workspaceId: null } as ResolvedAuth });
    expect(await runCli(["auth", "list-keys", "-u", "google_2"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: OAuth profile has no workspace bound. Re-run `kagura-memory auth login` or pass --workspace <uuid>.",
    ]);
  });

  it('refuses a .kagura.json key whose context_id is "auto"', async () => {
    const h = harness({ config: { api_key: "k", context_id: "auto" } });
    expect(await runCli(["workspace", "invite", "list"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      'Error: .kagura.json has api_key but context_id is missing or "auto". Set context_id to the ' +
        "workspace UUID bound to this api_key, or pass --workspace. (Falling back to the OAuth " +
        "profile would mix credential sources — see issue #115.)",
    ]);
  });

  it("reports no credential with the resolver's message", async () => {
    const h = harness({ auth: new KaguraAuthError("No credentials found.\n  Run: kagura auth login") });
    expect(await runCli(["workspace", "member", "list", "-w", WS], h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: No credentials found.\n  Run: kagura auth login"]);
  });

  // Recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4):
  // a non-string context_id in .kagura.json reads as absent (python-sdk #285;
  // Python 0.41.0 failed with "'int' object has no attribute 'strip'").
  const NO_WORKSPACE =
    'Error: .kagura.json has api_key but context_id is missing or "auto". Set context_id to the ' +
    "workspace UUID bound to this api_key, or pass --workspace. (Falling back to the OAuth " +
    "profile would mix credential sources — see issue #115.)";

  it.each([123, ["x"], { a: 1 }])("reads a context_id of %j as absent (exit 1)", async (value) => {
    for (const argv of [
      ["workspace", "member", "list"],
      ["auth", "list-keys", "-u", "google_2"],
      ["auth", "create-key", "-u", "google_2", "-n", "ci", "--expires-days", "90"],
    ]) {
      const h = harness({ config: { api_key: "k", context_id: value } as unknown as KaguraConfig });
      expect(await runCli(argv, h.deps), argv.join(" ")).toBe(1);
      expect(h.err).toEqual([NO_WORKSPACE]);
      expect(h.rest.requests).toEqual([]);
    }
  });

  it("gives no 403 hint for a non-string context_id when -w names the workspace", async () => {
    const h = harness({ config: { api_key: "k", context_id: 123 } as unknown as KaguraConfig });
    reply(h, []);
    expect(await runCli(["workspace", "member", "list", "-w", WS], h.deps)).toBe(0);
    expect(h.built.map((b) => b.hint)).toEqual([null]);
  });
});

describe("a refusal from the server", () => {
  function refusal(message: string): unknown {
    return { error: "AUTH-101", message, details: {} };
  }

  it("hints at the owner key and the .kagura.json workspace on the uniform 403", async () => {
    const h = harness();
    reply(h, refusal("Insufficient permissions"), 403);
    expect(await runCli(["workspace", "member", "list"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: Access denied (HTTP 403): workspace member/invitation/credential management requires " +
        "the workspace OWNER's API key when called programmatically (OAuth tokens are not accepted). " +
        "credential source: .kagura.json (workspace=11111111…) — is this key the workspace owner's?",
    ]);
  });

  it("names an env key without a workspace", async () => {
    const h = harness({ auth: ENV_KEY });
    reply(h, refusal("Insufficient permissions"), 403);
    expect(await runCli(["workspace", "member", "list", "-w", WS], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: Access denied (HTTP 403): workspace member/invitation/credential management requires " +
        "the workspace OWNER's API key when called programmatically (OAuth tokens are not accepted). " +
        "credential source: KAGURA_API_KEY env — is this key the workspace owner's?",
    ]);
  });

  it.each([
    "Owner-API-key member management is disabled on this deployment. Use a workspace-owner session.",
    "Cannot modify your own role. Another administrator must change your role.",
  ])("passes a purpose-built 403 through: %s", async (message) => {
    const h = harness();
    reply(h, refusal(message), 403);
    expect(await runCli(["auth", "create-key", "-u", "google_2", "-n", "ci", "--expires-days", "90"], h.deps)).toBe(1);
    expect(h.err).toEqual([`Error: ${message}`]);
    expect(h.out).toEqual([]);
  });

  it.each([
    "OAuth bearer tokens cannot manage workspace members or credentials. Use a workspace-owner API key.",
    "OAuth bearer tokens cannot mint API keys. Use a workspace-owner API key.",
  ])("gives an OAuth profile's refusal the owner-key hint, as Python does: %s", async (message) => {
    // The server's own sentence names "bearer", which both SDKs drop from
    // any server text as a possible credential echo; the hint takes its
    // place, naming the OAuth profile and its workspace.
    const h = harness({ auth: OAUTH });
    reply(h, refusal(message), 403);
    expect(await runCli(["auth", "create-key", "-u", "google_2", "-n", "ci", "--expires-days", "90"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: Access denied (HTTP 403): workspace member/invitation/credential management requires " +
        "the workspace OWNER's API key when called programmatically (OAuth tokens are not accepted). " +
        "credential source: OAuth profile (~/.kagura/credentials.json) (workspace=aaaaaaaa…) — is this " +
        "key the workspace owner's?",
    ]);
  });

  it("adds the plan line to a plan refusal on invite create", async () => {
    const h = harness();
    reply(
      h,
      {
        error: "FEAT-001",
        message: "Feature 'team_invitations' not available on M plan. Upgrade to L plan to access this feature.",
        details: { gate: "plan", feature: "team_invitations", required_plan: "pro", required_plan_display: "L" },
      },
      403,
    );
    expect(await runCli(["workspace", "invite", "create", "a@b.com", "--role", "admin"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: Feature 'team_invitations' not available on M plan. Upgrade to L plan to access this feature.\n" +
        "  Required plan: L (pro)",
    ]);
  });

  it("passes the server's 404 through, without a stack", async () => {
    const h = harness({ confirm: true });
    reply(h, { error: "RES-001", message: "Invitation not found not found", details: {} }, 404);
    expect(await runCli(["workspace", "invite", "revoke", "7"], h.deps)).toBe(1);
    expect(h.err).toEqual(["Error: Invitation not found not found"]);
  });
});

// ---------------------------------------------------------------------------
// invite
// ---------------------------------------------------------------------------

describe("workspace invite create", () => {
  it("prints the URL once, after the warning on stderr", async () => {
    const h = harness();
    reply(h, {
      id: 7,
      workspace_id: WS,
      email: "new@x.com",
      role: "member",
      token: "tok_0123456789abcdef0123",
      invitation_url: "https://memory.kagura-ai.com/invite/tok",
      is_accepted: false,
      is_expired: false,
      expires_at: "2026-07-10T00:00:00Z",
    });
    expect(
      await runCli(
        ["workspace", "invite", "create", "new@x.com", "--role", "member", "--context", CTX, "--expires-days", "7"],
        h.deps,
      ),
    ).toBe(0);
    expect(h.err).toEqual(["⚠ The invitation URL below is shown once — treat it as a join credential."]);
    expect(h.out).toEqual([
      "Invitation #7 → new@x.com (role=member, expires=2026-07-10)\nhttps://memory.kagura-ai.com/invite/tok",
    ]);
    const req = lastRequest(h);
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`https://test.com/api/v1/workspaces/${WS}/invitations`);
    expect(req.body).toBe(
      JSON.stringify({ email: "new@x.com", role: "member", allowed_context_ids: [CTX], expires_in_days: 7 }),
    );
  });

  it("sends every -c in argv order, canonical, and no expiry unless asked", async () => {
    const h = harness();
    reply(h, { id: 8, email: "v@x.com", role: "viewer", token: "tok_y" });
    expect(
      await runCli(
        ["workspace", "invite", "create", "v@x.com", "--role", "viewer", "-c", `{${CTX.toUpperCase()}}`, "-c", OTHER_WS],
        h.deps,
      ),
    ).toBe(0);
    expect(sentJson(h)).toEqual({ email: "v@x.com", role: "viewer", allowed_context_ids: [CTX, OTHER_WS] });
    // No URL: the token; no expiry: never.
    expect(h.out).toEqual(["Invitation #8 → v@x.com (role=viewer, expires=never)\ntok_y"]);
  });

  it("invites an admin without -c, sending no context grant", async () => {
    const h = harness();
    reply(h, { id: 9, email: null, role: "admin" });
    expect(await runCli(["workspace", "invite", "create", "a@x.com", "--role", "admin"], h.deps)).toBe(0);
    expect(sentJson(h)).toEqual({ email: "a@x.com", role: "admin" });
    // A missing email reads `-` as in `invite list`, as Python 0.41.1+ prints it.
    expect(h.out).toEqual(["Invitation #9 → - (role=admin, expires=never)\n(no url returned)"]);
  });

  it.each([[[]], [["--role", "member"]], [["--role", "viewer"]]])(
    "refuses a member or viewer invitation without -c, naming the flag, before any credential (%j)",
    async (extra) => {
      const h = harness();
      expect(await runCli(["workspace", "invite", "create", "new@x.com", ...extra], h.deps)).toBe(2);
      const role = extra[1] ?? "member";
      expect(h.err).toEqual([
        `Error: --role ${role} requires at least one --context/-c <uuid> (the invitee's context grant).`,
      ]);
      expect(h.err.join("\n")).not.toContain("allowed");
      expect(h.calls).toEqual([]);
    },
  );

  it.each(["14", "07", "7.0"])("refuses --expires-days %s as click's Choice does (exit 2)", async (days) => {
    const h = harness();
    expect(
      await runCli(["workspace", "invite", "create", "a@b.com", "-c", CTX, "--expires-days", days], h.deps),
    ).toBe(2);
    expect(h.err).toEqual([
      `Error: Invalid value for '--expires-days': '${days}' is not one of '7', '30', '90', '365'.`,
    ]);
  });

  // Recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4):
  // `_context_uuids_param` refuses a -c that is no UUID as a usage error,
  // before the config is read, whatever the role.
  it.each([
    [["-c", CTX, "-c", "ctx-1"], "'ctx-1'"],
    [["-c", ` ${CTX}`], `' ${CTX}'`],
    [["-c", ""], "''"],
    [["--role", "admin", "-c", "not-a-uuid"], "'not-a-uuid'"],
  ])("refuses %j before anything is read (exit 2)", async (flags, shown) => {
    const h = harness();
    expect(await runCli(["workspace", "invite", "create", "a@b.com", ...flags], h.deps)).toBe(2);
    expect(h.err).toEqual([`Error: Invalid value for '--context' / '-c': ${shown} is not a valid context UUID.`]);
    expect(h.calls).toEqual([]);
    expect(h.rest.requests).toEqual([]);
  });

  it("reads the response as a WorkspaceInvitation", async () => {
    const h = harness();
    reply(h, { email: "a@b.com", role: "admin", invitation_url: "https://u/secret-join" });
    expect(await runCli(["workspace", "invite", "create", "a@b.com", "--role", "admin"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      `Error: WorkspaceClient.create_invitation: unexpected server response for WorkspaceInvitation (id: Field required). ${UPGRADE}`,
    ]);
    expect(h.out).toEqual([]);
  });
});

describe("workspace invite list", () => {
  const ROWS = [
    {
      id: 7,
      email: "new@x.com",
      role: "member",
      token: "tok_0123456789abcdef0123",
      invitation_url: "https://memory.kagura-ai.com/invite/tok",
      is_accepted: false,
      is_expired: false,
      expires_at: "2026-07-10T00:00:00Z",
    },
    { id: 123456, email: null, role: "admin", is_accepted: true, is_expired: true, expires_at: null },
    { id: 8, email: "old@x.com", role: "viewer", is_expired: true, expires_at: "2026-06-01T00:00:00Z" },
  ];

  it("renders the table, never the token or URL", async () => {
    const h = harness();
    reply(h, ROWS);
    expect(await runCli(["workspace", "invite", "list"], h.deps)).toBe(0);
    expect(h.out).toEqual([
      [
        "ID     EMAIL                          ROLE     STATE     EXPIRES",
        "7      new@x.com                      member   pending   2026-07-10",
        "123456 -                              admin    accepted  never",
        "8      old@x.com                      viewer   expired   2026-06-01",
      ].join("\n"),
    ]);
    expect(h.out.join("\n")).not.toContain("tok_");
    expect(lastRequest(h).url).toBe(`https://test.com/api/v1/workspaces/${WS}/invitations`);
  });

  it.each([
    ["c", "allowed_context_ids: Input should be a valid list"],
    [[1], "allowed_context_ids.0: Input should be a valid string"],
  ])("refuses an allowed_context_ids of %j as Python's model does", async (value, problem) => {
    const h = harness();
    reply(h, [{ id: 1, role: "member", allowed_context_ids: value }]);
    expect(await runCli(["workspace", "invite", "list", "--json"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      `Error: WorkspaceClient.list_invitations: unexpected server response for WorkspaceInvitation (${problem}). ${UPGRADE}`,
    ]);
  });

  it("asks for accepted rows only with --include-accepted", async () => {
    const h = harness();
    reply(h, []);
    expect(await runCli(["workspace", "invite", "list", "--include-accepted"], h.deps)).toBe(0);
    expect(lastRequest(h).url).toBe(`https://test.com/api/v1/workspaces/${WS}/invitations?include_accepted=true`);
  });

  it("prints --json without token or invitation_url, in the model's order, read as pydantic reads it", async () => {
    const h = harness();
    reply(h, [
      {
        id: "7",
        email: "new@x.com",
        role: "member",
        token: "tok",
        invitation_url: "https://u",
        is_accepted: "no",
        is_expired: 0,
        created_at: "2026-07-03T00:00:00Z",
        expires_at: "2026-07-10T00:00:00Z",
        workspace_id: "w",
        invited_by: "u",
        accepted_at: null,
        accepted_by: null,
        allowed_context_ids: ["c1"],
      },
      { id: 8, role: "admin" },
    ]);
    expect(await runCli(["workspace", "invite", "list", "--json"], h.deps)).toBe(0);
    expect(h.out).toEqual([
      [
        "[",
        "  {",
        '    "id": 7,',
        '    "email": "new@x.com",',
        '    "role": "member",',
        '    "is_accepted": false,',
        '    "is_expired": false,',
        '    "created_at": "2026-07-03T00:00:00Z",',
        '    "expires_at": "2026-07-10T00:00:00Z",',
        '    "allowed_context_ids": [',
        '      "c1"',
        "    ]",
        "  },",
        "  {",
        '    "id": 8,',
        '    "email": null,',
        '    "role": "admin",',
        '    "is_accepted": false,',
        '    "is_expired": false,',
        '    "created_at": null,',
        '    "expires_at": null,',
        '    "allowed_context_ids": null',
        "  }",
        "]",
      ].join("\n"),
    ]);
  });
});

describe("workspace invite revoke", () => {
  it.each([
    ["7", 7],
    ["+7", 7],
    [" 7 ", 7],
    ["1_000", 1000],
  ])("revokes %j as the int Python's int() reads", async (raw, id) => {
    const h = harness();
    reply(h, { success: true });
    expect(await runCli(["workspace", "invite", "revoke", raw], h.deps)).toBe(0);
    expect(h.out).toEqual([`Revoked invitation #${id}`]);
    const req = lastRequest(h);
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe(`https://test.com/api/v1/workspaces/${WS}/invitations/${id}`);
  });

  it.each([
    [["9007199254740993"], "9007199254740993"],
    [["1000000000000000000000"], "1000000000000000000000"],
    [["+9_007_199_254_740_993"], "9007199254740993"],
    [["--", "-9007199254740993"], "-9007199254740993"],
  ])("revokes %j exactly, as Python's int is, never a rounded neighbour", async (argv, id) => {
    // A JS number would send 9007199254740992 (another invitation) or 1e+21.
    const h = harness();
    reply(h, { success: true });
    expect(await runCli(["workspace", "invite", "revoke", ...argv], h.deps)).toBe(0);
    expect(lastRequest(h).url).toBe(`https://test.com/api/v1/workspaces/${WS}/invitations/${id}`);
    expect(h.out).toEqual([`Revoked invitation #${id}`]);
  });

  it.each(["abc", "7.0", "0x10"])("refuses INVITATION_ID %j in click's words (exit 2)", async (raw) => {
    const h = harness();
    expect(await runCli(["workspace", "invite", "revoke", raw], h.deps)).toBe(2);
    expect(h.err).toEqual([`Error: Invalid value for 'INVITATION_ID': '${raw}' is not a valid integer.`]);
    expect(h.calls).toEqual([]);
  });

  it("requires INVITATION_ID", async () => {
    const h = harness();
    expect(await runCli(["workspace", "invite", "revoke"], h.deps)).toBe(2);
    expect(h.err).toEqual(["Error: Missing argument 'INVITATION_ID'."]);
  });
});

// ---------------------------------------------------------------------------
// auth create-key | list-keys | revoke-key
// ---------------------------------------------------------------------------

describe("auth create-key", () => {
  const KEY = {
    id: 42,
    name: "ci-bot",
    key_prefix: "kagura_abcdef123",
    plaintext_key: PLAINTEXT,
    is_visible: false,
    visibility_expires_at: null,
    created_at: "2026-07-03T00:00:00Z",
    last_used_at: null,
    revoked_at: null,
    expires_at: "2026-10-01T00:00:00Z",
  };

  it("prints the plaintext once on stdout, after the warning on stderr", async () => {
    const h = harness();
    reply(h, KEY, 201);
    expect(
      await runCli(["auth", "create-key", "--user", "google_2", "--name", "ci-bot", "--expires-days", "90"], h.deps),
    ).toBe(0);
    expect(h.err).toEqual(["⚠ Save this key now — it cannot be shown again."]);
    expect(h.out).toEqual([
      `Key #42 'ci-bot' for google_2 (prefix=kagura_abcdef123, expires=2026-10-01)\n${PLAINTEXT}`,
    ]);
    const req = lastRequest(h);
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`https://test.com/api/v1/workspaces/${WS}/members/google_2/credentials/api-keys`);
    // Nothing but the two fields: no agent_id, auto_hide_minutes or bound_context_id.
    expect(req.body).toBe(JSON.stringify({ name: "ci-bot", expires_days: 90 }));
  });

  it("says so when no plaintext or expiry came back", async () => {
    const h = harness();
    reply(h, { ...KEY, plaintext_key: null, expires_at: null }, 201);
    expect(await runCli(["auth", "create-key", "-u", "google_2", "-n", "ci-bot", "--expires-days", "7"], h.deps)).toBe(0);
    expect(h.out).toEqual(["Key #42 'ci-bot' for google_2 (prefix=kagura_abcdef123, expires=never)\n(no plaintext returned)"]);
  });

  it("salvages the plaintext from a mis-shaped response, without the warning (exit 1)", async () => {
    const h = harness();
    reply(h, { plaintext_key: "kagura_salvaged" }, 201);
    expect(await runCli(["auth", "create-key", "-u", "google_2", "-n", "ci", "--expires-days", "30"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: WorkspaceClient.mint_member_key: server returned an unexpected mint response shape, " +
        "but the key WAS created. Save the plaintext now: kagura_salvaged",
    ]);
    expect(h.out).toEqual([]);
  });

  it("points at list-keys when a mis-shaped response has no plaintext", async () => {
    const h = harness();
    reply(h, { unexpected: true }, 201);
    expect(await runCli(["auth", "create-key", "-u", "google_2", "-n", "ci", "--expires-days", "30"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: WorkspaceClient.mint_member_key: server returned an unexpected mint response shape; " +
        "the key may have been created without displaying its plaintext — check `kagura auth list-keys` " +
        "and revoke/re-mint if present.",
    ]);
  });

  it("reads the response as pydantic's MemberAPIKey does: a string id is an int", async () => {
    // What Python prints for this body (pydantic 2.13.4); a strict type
    // check would have refused it as a mis-shaped mint.
    const h = harness();
    reply(h, { id: "42", name: "n", key_prefix: "p", plaintext_key: "kp" }, 201);
    expect(await runCli(["auth", "create-key", "-u", "u", "-n", "n", "--expires-days", "30"], h.deps)).toBe(0);
    expect(h.err).toEqual(["⚠ Save this key now — it cannot be shown again."]);
    expect(h.out).toEqual(["Key #42 'n' for u (prefix=p, expires=never)\nkp"]);
  });

  it("refuses a plaintext_key that is no string, as the model does, rather than print it", async () => {
    const h = harness();
    reply(h, { id: 42, name: "n", key_prefix: "p", plaintext_key: 5 }, 201);
    expect(await runCli(["auth", "create-key", "-u", "u", "-n", "n", "--expires-days", "30"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: WorkspaceClient.mint_member_key: server returned an unexpected mint response shape; " +
        "the key may have been created without displaying its plaintext — check `kagura auth list-keys` " +
        "and revoke/re-mint if present.",
    ]);
    expect(h.out).toEqual([]);
  });

  it.each([
    [["--name", "ci", "--expires-days", "90"], "Error: Missing option '--user' / '-u'."],
    [["--user", "u", "--expires-days", "90"], "Error: Missing option '--name' / '-n'."],
    [["--user", "u", "--name", "ci"], "Error: Missing option '--expires-days'."],
    [["-u", "u", "-n", "ci", "--expires-days", "4000"], "Error: Invalid value for '--expires-days': 4000 is not in the range 1<=x<=3650."],
    // The value as click converted it.
    [["-u", "u", "-n", "ci", "--expires-days", "+4000"], "Error: Invalid value for '--expires-days': 4000 is not in the range 1<=x<=3650."],
    [["-u", "u", "-n", "ci", "--expires-days", "0"], "Error: Invalid value for '--expires-days': 0 is not in the range 1<=x<=3650."],
    [["-u", "u", "-n", "ci", "--expires-days", "9.5"], "Error: Invalid value for '--expires-days': '9.5' is not a valid integer range."],
    [["-u", "u", "-n", "ci", "--expires-days", "90", "x"], "Error: Got unexpected extra argument (x)"],
  ])("refuses %j in click's words (exit 2), before any credential", async (argv, line) => {
    const h = harness();
    expect(await runCli(["auth", "create-key", ...argv], h.deps)).toBe(2);
    expect(h.err).toEqual([line]);
    expect(h.calls).toEqual([]);
  });

  it("checks the options in declaration order when several are wrong", async () => {
    // A deliberate, minor divergence: click checks the options given on
    // the command line first, in argv order, and would report the range
    // error here; this bin reports the first declared problem.
    const h = harness();
    expect(await runCli(["auth", "create-key", "--expires-days", "4000"], h.deps)).toBe(2);
    expect(h.err).toEqual(["Error: Missing option '--user' / '-u'."]);
  });

  it("takes 1_000 days, as Python's int() does", async () => {
    const h = harness();
    reply(h, KEY, 201);
    expect(await runCli(["auth", "create-key", "-u", "u", "-n", "ci", "--expires-days", "1_000"], h.deps)).toBe(0);
    expect(sentJson(h)).toEqual({ name: "ci", expires_days: 1000 });
  });

  it("is no bare `kagura-memory create-key`", async () => {
    // Only the seven v0.7.0 subcommands keep a bare alias.
    for (const name of ["create-key", "list-keys", "revoke-key"]) {
      const h = harness();
      expect(await runCli([name, "--help"], h.deps)).toBe(2);
      expect(h.err[0]).toBe(`Error: No such command '${name}'.`);
    }
  });
});

describe("auth list-keys", () => {
  const ROWS = [
    {
      id: 42,
      name: "ci-bot",
      key_prefix: "kagura_abcdef123",
      plaintext_key: null,
      is_visible: false,
      created_at: "2026-07-03T01:02:03.123000Z",
      expires_at: "2026-10-01T00:00:00Z",
    },
    {
      id: 1234567,
      name: "a-very-long-key-name-exceeding-24-chars",
      key_prefix: "kagura_0123456789abcdef",
      created_at: null,
      revoked_at: "2026-07-05T00:00:00Z",
    },
  ];

  it("renders the table from the api_keys envelope", async () => {
    const h = harness();
    reply(h, { api_keys: ROWS, target_user_role: "member" });
    expect(await runCli(["auth", "list-keys", "--user", "google_2"], h.deps)).toBe(0);
    expect(h.out).toEqual([
      [
        "ID     NAME                     PREFIX             CREATED      EXPIRES      REVOKED",
        "42     ci-bot                   kagura_abcdef123   2026-07-03   2026-10-01   -",
        "1234567 a-very-long-key-name-exceeding-24-chars kagura_0123456789abcdef -            never        2026-07-05",
      ].join("\n"),
    ]);
    expect(lastRequest(h).url).toBe(`https://test.com/api/v1/workspaces/${WS}/members/google_2/credentials`);
  });

  it("drops plaintext_key from --json even if a server leaked one", async () => {
    const h = harness();
    reply(h, {
      api_keys: [{ ...ROWS[0], plaintext_key: PLAINTEXT, extra: 1, last_used_at: "2026-07-04T00:00:00Z" }],
      target_user_role: "member",
    });
    expect(await runCli(["auth", "list-keys", "-u", "google_2", "--json"], h.deps)).toBe(0);
    expect(h.out).toEqual([
      [
        "[",
        "  {",
        '    "id": 42,',
        '    "name": "ci-bot",',
        '    "key_prefix": "kagura_abcdef123",',
        '    "is_visible": false,',
        '    "visibility_expires_at": null,',
        '    "created_at": "2026-07-03T01:02:03.123000Z",',
        '    "last_used_at": "2026-07-04T00:00:00Z",',
        '    "revoked_at": null,',
        '    "expires_at": "2026-10-01T00:00:00Z",',
        '    "bound_context_id": null',
        "  }",
        "]",
      ].join("\n"),
    ]);
    expect(h.out.join("\n")).not.toContain(PLAINTEXT);
  });

  it("refuses an envelope without an api_keys list, as Python's SDK words it", async () => {
    const h = harness();
    reply(h, { api_keys: null, target_user_role: "member" });
    expect(await runCli(["auth", "list-keys", "-u", "google_2"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: WorkspaceClient.list_member_keys: unexpected server response " +
        `(GET /api/v1/workspaces/${WS}/members/google_2/credentials: expected an object carrying a ` +
        `'api_keys' array). ${UPGRADE}`,
    ]);
  });

  it("names the request's whole path, decoded, as httpx's url.path gives it", async () => {
    // Python prints `resp.request.url.path`: the base URL's /kagura prefix
    // included, and `a%40b` read back as `a@b`.
    const h = harness({ auth: { ...CONFIG_KEY, mcpUrl: "https://test.com/kagura/mcp" } });
    reply(h, { api_keys: null });
    expect(await runCli(["auth", "list-keys", "-u", "a@b"], h.deps)).toBe(1);
    expect(lastRequest(h).url).toBe(`https://test.com/kagura/api/v1/workspaces/${WS}/members/a%40b/credentials`);
    expect(h.err).toEqual([
      "Error: WorkspaceClient.list_member_keys: unexpected server response " +
        `(GET /kagura/api/v1/workspaces/${WS}/members/a@b/credentials: expected an object carrying a ` +
        `'api_keys' array). ${UPGRADE}`,
    ]);
  });

  it("names the field, never the value, of a mis-typed row", async () => {
    const h = harness();
    reply(h, { api_keys: [{ id: 1, name: "k", key_prefix: "p", plaintext_key: 99 }] });
    expect(await runCli(["auth", "list-keys", "-u", "google_2", "--json"], h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: WorkspaceClient.list_member_keys: unexpected server response for MemberAPIKey " +
        `(plaintext_key: Input should be a valid string). ${UPGRADE}`,
    ]);
  });

  it("requires --user", async () => {
    const h = harness();
    expect(await runCli(["auth", "list-keys"], h.deps)).toBe(2);
    expect(h.err).toEqual(["Error: Missing option '--user' / '-u'."]);
  });
});

describe("auth revoke-key", () => {
  it("asks first, naming key, member and workspace, and sends nothing on a decline", async () => {
    const h = harness({ confirm: false });
    expect(await runCli(["auth", "revoke-key", "42", "--user", "google_2"], h.deps)).toBe(1);
    expect(h.questions).toEqual([`Revoke key #42 of google_2 in workspace ${WS}?`]);
    expect(h.err).toEqual(["Error: Aborted!"]);
    expect(h.rest.requests).toEqual([]);
  });

  it.each([["--yes"], ["-y"]])("revokes without asking under %s", async (yes) => {
    const h = harness();
    reply(h, { status: "revoked", key_id: 42 });
    expect(await runCli(["auth", "revoke-key", "+42", "-u", "google_2", yes], h.deps)).toBe(0);
    expect(h.questions).toEqual([]);
    expect(h.out).toEqual(["Revoked key #42 of google_2"]);
    const req = lastRequest(h);
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe(`https://test.com/api/v1/workspaces/${WS}/members/google_2/credentials/api-keys/42`);
  });

  it.each([
    [[], "Error: Missing argument 'KEY_ID'."],
    [["--user", "google_2"], "Error: Missing argument 'KEY_ID'."],
    [["42"], "Error: Missing option '--user' / '-u'."],
    [["abc", "-u", "google_2"], "Error: Invalid value for 'KEY_ID': 'abc' is not a valid integer."],
    [["42", "43", "-u", "google_2"], "Error: Got unexpected extra argument (43)"],
  ])("refuses %j in click's words (exit 2)", async (argv, line) => {
    const h = harness();
    expect(await runCli(["auth", "revoke-key", ...argv], h.deps)).toBe(2);
    expect(h.err).toEqual([line]);
    expect(h.calls).toEqual([]);
  });

  it("asks about, and revokes, the key typed, never a rounded neighbour", async () => {
    // A JS number reads 9007199254740993 as ...992, another key.
    const asked = harness({ confirm: false });
    expect(await runCli(["auth", "revoke-key", "9007199254740993", "-u", "u"], asked.deps)).toBe(1);
    expect(asked.questions).toEqual([`Revoke key #9007199254740993 of u in workspace ${WS}?`]);

    for (const id of ["9007199254740993", "1000000000000000000000"]) {
      const h = harness();
      reply(h, { status: "revoked" });
      expect(await runCli(["auth", "revoke-key", id, "-u", "u", "-y"], h.deps)).toBe(0);
      expect(lastRequest(h).url).toBe(
        `https://test.com/api/v1/workspaces/${WS}/members/u/credentials/api-keys/${id}`,
      );
      expect(h.out).toEqual([`Revoked key #${id} of u`]);
    }
  });

  it("refuses --invite as every auth subcommand but login does", async () => {
    const h = harness();
    expect(await runCli(["auth", "revoke-key", "42", "-u", "u", "--invite", "-Zsecret"], h.deps)).toBe(2);
    expect(h.err).toEqual(["--invite applies only to 'auth login'."]);
    expect(h.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// a user id of . or ..
// ---------------------------------------------------------------------------

describe("a user id of ., .. or nothing", () => {
  // URL resolution drops or climbs such a segment even percent-encoded:
  // `member remove .. --yes` would DELETE /api/v1/workspaces/{ws}, the
  // workspace itself, and an empty one addresses `members/`. Python sends
  // them (a PYBUG); this bin refuses them before anything is read, asked
  // or sent.
  const USER_ID = (id: string) => `Error: Invalid value for 'USER_ID': ${id} is not a valid user id.`;
  const USER = (id: string) => `Error: Invalid value for '--user' / '-u': ${id} is not a valid user id.`;

  it.each([
    [["workspace", "member", "remove", "..", "--yes"], USER_ID("'..'")],
    [["workspace", "member", "remove", "."], USER_ID("'.'")],
    [["workspace", "member", "set-role", "..", "--role", "admin"], USER_ID("'..'")],
    [["workspace", "member", "add", "..", "--role", "member"], USER_ID("'..'")],
    [["auth", "revoke-key", "42", "-u", ".."], USER("'..'")],
    [["auth", "revoke-key", "42", "--user", ".", "--yes"], USER("'.'")],
    [["auth", "list-keys", "-u", "."], USER("'.'")],
    [["auth", "create-key", "-u", "..", "-n", "ci", "--expires-days", "90"], USER("'..'")],
    [["workspace", "member", "remove", "", "--yes"], USER_ID("''")],
    [["workspace", "member", "add", "", "--role", "member"], USER_ID("''")],
    [["auth", "list-keys", "--user="], USER("''")],
  ])("refuses %j in click's words (exit 2), sending nothing", async (argv, line) => {
    const h = harness();
    expect(await runCli(argv, h.deps)).toBe(2);
    expect(h.err).toEqual([line]);
    expect(h.calls).toEqual([]);
    expect(h.questions).toEqual([]);
    expect(h.rest.requests).toEqual([]);
  });

  it.each(["...", "a..b", ".hidden"])("sends %j, a segment URL resolution keeps", async (id) => {
    const h = harness();
    h.rest.status = 204;
    expect(await runCli(["workspace", "member", "remove", id, "--yes"], h.deps)).toBe(0);
    expect(lastRequest(h).url).toBe(`https://test.com/api/v1/workspaces/${WS}/members/${id}`);
    expect(h.out).toEqual([`Removed ${id}`]);
  });

  it("sends a user id with a slash or a query as one segment (#66)", async () => {
    const h = harness();
    h.rest.status = 204;
    expect(await runCli(["workspace", "member", "remove", "a/b?c", "--yes"], h.deps)).toBe(0);
    expect(lastRequest(h).url).toBe(`https://test.com/api/v1/workspaces/${WS}/members/a%2Fb%3Fc`);
  });
});

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

describe("help", () => {
  it("lists workspace at the root, and its two groups", async () => {
    const root = harness();
    expect(await runCli(["--help"], root.deps)).toBe(0);
    expect(root.out.join("\n")).toMatch(
      /^ {2}workspace +Workspace administration \(owner API key required, server v0\.42\.0\+\)\.$/m,
    );

    const h = harness();
    expect(await runCli(["workspace", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/^ {2}invite +Manage workspace invitations\.$/m);
    expect(text).toMatch(/^ {2}member +Manage workspace members\.$/m);
  });

  it.each([
    ["member", ["add", "list", "remove", "set-role"]],
    ["invite", ["create", "list", "revoke"]],
  ])("gives workspace %s Python's second paragraph", async (group, commands) => {
    const h = harness();
    expect(await runCli(["workspace", group, "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain(
      "  Requires the workspace OWNER's static API key — OAuth tokens are\n" +
        "  rejected by the server on this surface.",
    );
    const listed = text.split("Commands:\n")[1]!.split("\n").map((l) => l.trim().split(/\s+/)[0]);
    expect(listed).toEqual(commands);
  });

  it("lists the key commands under auth, with Python's summaries", async () => {
    const h = harness();
    expect(await runCli(["auth", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/^ {2}create-key +Mint an API key for another workspace member \(owner API key required\)\.$/m);
    expect(text).toMatch(/^ {2}list-keys +List a member's API keys — metadata only, never the plaintext\.$/m);
    expect(text).toMatch(/^ {2}revoke-key +Revoke a member's API key by its integer id \(see `list-keys`\)\.$/m);
  });

  it("renders a command's options and one example per line, naming this bin", async () => {
    const h = harness();
    expect(await runCli(["workspace", "invite", "create", "--help"], h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/^Usage: kagura-memory workspace invite create \[OPTIONS\] EMAIL$/m);
    expect(text).toMatch(/^ {6}--role \[member\|admin\|viewer\] +Role granted on accept .*\[default: member\]$/m);
    expect(text).toMatch(/^ {2}-c, --context TEXT +Context UUID the invitee may access/m);
    expect(text).toMatch(/^ {6}--expires-days \[7\|30\|90\|365\] +Expiry preset/m);
    expect(text).toMatch(/^ {2}-w, --workspace TEXT +Workspace UUID \(default: the credential source's workspace\)$/m);
    expect(text).toContain(
      "  Example:\n    kagura-memory workspace invite create new@example.com --role member -c <context-uuid>",
    );
    expect(text).not.toContain("--invite");
  });
});
