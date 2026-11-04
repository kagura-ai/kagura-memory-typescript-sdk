/**
 * `auth create-key|list-keys|revoke-key` and `workspace invite
 * create|list|revoke` print what the Python CLI prints for the same server
 * response (#102): each case below is a response shaped as memory-cloud
 * v0.89.0+ sends it, with the opaque `akey_…` / `winv_…` ids of
 * memory-cloud#1008, or as an older server does, with an integer id; the
 * requests the Python CLI sent for it; and its stdout, stderr and exit
 * code — recorded from the Python CLI 0.44.0 (click 8.3.3, pydantic
 * 2.13.4) against a fake server sending these exact bytes. The models'
 * `id: int | str` keeps a string id the string (a lax `"7"` included),
 * reads anything else as an int (`true` is 1), and refuses a value neither
 * member takes under each (`id.int: …; id.str: …`).
 */

import { describe, expect, it } from "vitest";

import type { ResolvedAuth } from "../../../src/auth/types.js";
import { runCli, type CliDeps } from "../../../src/cli/run.js";
import { restClientFromAuth } from "../../../src/restBase.js";
import { WorkspaceClient } from "../../../src/workspaceClient.js";
import {
  recordedFetch,
  terminalText,
  type RecordedCase,
  type RecordedRoutes,
  type SentRequest,
} from "../../pythonDumpHarness.js";

interface Case extends RecordedCase {
  /** The requests the Python CLI made, in order. */
  requests: SentRequest[];
}

const CASES: Case[] = [
  {
    name: "auth create-key, a v0.89.0 akey_ id",
    argv: ["auth","create-key","-u","google_2","-n","ci-bot","--expires-days","90","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"POST /api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials/api-keys":{"status":201,"raw":"{\"id\": \"akey_3fJ0kQ7xWm2Lp9RtZa4bNc\", \"name\": \"ci-bot\", \"key_prefix\": \"kagura_3fJ0\", \"plaintext_key\": \"kagura_3fJ0kQ7xWm2Lp9RtZa4bNc_secret\", \"is_visible\": false, \"visibility_expires_at\": null, \"created_at\": \"2026-11-01T00:00:00Z\", \"last_used_at\": null, \"revoked_at\": null, \"expires_at\": \"2027-01-30T00:00:00Z\", \"bound_context_id\": null, \"default_context_id\": null, \"default_context_name\": null, \"agent_id\": null, \"connector_id\": null}"}},
    requests: [{"method":"POST","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials/api-keys","body":"{\"name\":\"ci-bot\",\"expires_days\":90}"}],
    code: 0,
    stdout: "Key akey_3fJ0kQ7xWm2Lp9RtZa4bNc 'ci-bot' for google_2 (prefix=kagura_3fJ0, expires=2027-01-30)\nkagura_3fJ0kQ7xWm2Lp9RtZa4bNc_secret\n",
    stderr: "⚠ Save this key now — it cannot be shown again.\n",
  },
  {
    name: "auth create-key, a lax \"7\" id",
    argv: ["auth","create-key","-u","google_2","-n","n","--expires-days","30","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"POST /api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials/api-keys":{"status":201,"raw":"{\"id\": \"7\", \"name\": \"n\", \"key_prefix\": \"p\", \"plaintext_key\": \"kp\"}"}},
    requests: [{"method":"POST","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials/api-keys","body":"{\"name\":\"n\",\"expires_days\":30}"}],
    code: 0,
    stdout: "Key 7 'n' for google_2 (prefix=p, expires=never)\nkp\n",
    stderr: "⚠ Save this key now — it cannot be shown again.\n",
  },
  {
    name: "auth create-key, an id of null",
    argv: ["auth","create-key","-u","google_2","-n","n","--expires-days","30","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"POST /api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials/api-keys":{"status":201,"raw":"{\"id\": null, \"name\": \"n\", \"key_prefix\": \"p\", \"plaintext_key\": \"kp\"}"}},
    requests: [{"method":"POST","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials/api-keys","body":"{\"name\":\"n\",\"expires_days\":30}"}],
    code: 1,
    stdout: "",
    stderr: "Error: WorkspaceClient.mint_member_key: server returned an unexpected mint response shape, but the key WAS created. Save the plaintext now: kp\n",
  },
  {
    name: "auth list-keys, akey_ ids",
    argv: ["auth","list-keys","-u","google_2","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"GET /api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials":{"status":200,"raw":"{\"api_keys\": [{\"id\": \"akey_3fJ0kQ7xWm2Lp9RtZa4bNc\", \"name\": \"ci-bot\", \"key_prefix\": \"kagura_3fJ0\", \"plaintext_key\": null, \"is_visible\": false, \"visibility_expires_at\": null, \"created_at\": \"2026-11-01T00:00:00Z\", \"last_used_at\": null, \"revoked_at\": null, \"expires_at\": \"2027-01-30T00:00:00Z\", \"bound_context_id\": null, \"default_context_id\": null, \"default_context_name\": null, \"agent_id\": null, \"connector_id\": null}, {\"id\": \"akey_9ZyXwVuTsRqPoNmLkJiHgF\", \"name\": \"old-bot\", \"key_prefix\": \"kagura_3fJ0\", \"plaintext_key\": null, \"is_visible\": false, \"visibility_expires_at\": null, \"created_at\": \"2026-11-01T00:00:00Z\", \"last_used_at\": null, \"revoked_at\": \"2026-11-02T00:00:00Z\", \"expires_at\": \"2027-01-30T00:00:00Z\", \"bound_context_id\": null, \"default_context_id\": null, \"default_context_name\": null, \"agent_id\": null, \"connector_id\": null}], \"target_user_role\": \"member\"}"}},
    requests: [{"method":"GET","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials","body":null}],
    code: 0,
    stdout: "ID                          NAME                     PREFIX             CREATED      EXPIRES      REVOKED\nakey_3fJ0kQ7xWm2Lp9RtZa4bNc ci-bot                   kagura_3fJ0        2026-11-01   2027-01-30   -\nakey_9ZyXwVuTsRqPoNmLkJiHgF old-bot                  kagura_3fJ0        2026-11-01   2027-01-30   2026-11-02\n",
    stderr: "",
  },
  {
    name: "auth list-keys --json, an akey_ id, a lax \"7\" and an integer",
    argv: ["auth","list-keys","-u","google_2","--json","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"GET /api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials":{"status":200,"raw":"{\"api_keys\": [{\"id\": \"akey_3fJ0kQ7xWm2Lp9RtZa4bNc\", \"name\": \"ci-bot\", \"key_prefix\": \"kagura_3fJ0\", \"plaintext_key\": null, \"is_visible\": false, \"visibility_expires_at\": null, \"created_at\": \"2026-11-01T00:00:00Z\", \"last_used_at\": null, \"revoked_at\": null, \"expires_at\": \"2027-01-30T00:00:00Z\", \"bound_context_id\": null, \"default_context_id\": null, \"default_context_name\": null, \"agent_id\": null, \"connector_id\": null}, {\"id\": \"7\", \"name\": \"lax\", \"key_prefix\": \"kagura_3fJ0\", \"plaintext_key\": null, \"is_visible\": false, \"visibility_expires_at\": null, \"created_at\": \"2026-11-01T00:00:00Z\", \"last_used_at\": null, \"revoked_at\": null, \"expires_at\": \"2027-01-30T00:00:00Z\", \"bound_context_id\": null, \"default_context_id\": null, \"default_context_name\": null, \"agent_id\": null, \"connector_id\": null}, {\"id\": 8, \"name\": \"int\", \"key_prefix\": \"p\"}], \"target_user_role\": \"member\"}"}},
    requests: [{"method":"GET","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials","body":null}],
    code: 0,
    stdout: "[\n  {\n    \"id\": \"akey_3fJ0kQ7xWm2Lp9RtZa4bNc\",\n    \"name\": \"ci-bot\",\n    \"key_prefix\": \"kagura_3fJ0\",\n    \"is_visible\": false,\n    \"visibility_expires_at\": null,\n    \"created_at\": \"2026-11-01T00:00:00Z\",\n    \"last_used_at\": null,\n    \"revoked_at\": null,\n    \"expires_at\": \"2027-01-30T00:00:00Z\",\n    \"bound_context_id\": null,\n    \"default_context_id\": null,\n    \"default_context_name\": null,\n    \"agent_id\": null,\n    \"connector_id\": null\n  },\n  {\n    \"id\": \"7\",\n    \"name\": \"lax\",\n    \"key_prefix\": \"kagura_3fJ0\",\n    \"is_visible\": false,\n    \"visibility_expires_at\": null,\n    \"created_at\": \"2026-11-01T00:00:00Z\",\n    \"last_used_at\": null,\n    \"revoked_at\": null,\n    \"expires_at\": \"2027-01-30T00:00:00Z\",\n    \"bound_context_id\": null,\n    \"default_context_id\": null,\n    \"default_context_name\": null,\n    \"agent_id\": null,\n    \"connector_id\": null\n  },\n  {\n    \"id\": 8,\n    \"name\": \"int\",\n    \"key_prefix\": \"p\",\n    \"is_visible\": false,\n    \"visibility_expires_at\": null,\n    \"created_at\": null,\n    \"last_used_at\": null,\n    \"revoked_at\": null,\n    \"expires_at\": null,\n    \"bound_context_id\": null,\n    \"default_context_id\": null,\n    \"default_context_name\": null,\n    \"agent_id\": null,\n    \"connector_id\": null\n  }\n]\n",
    stderr: "",
  },
  {
    name: "auth list-keys, an id of 7.5",
    argv: ["auth","list-keys","-u","google_2","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"GET /api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials":{"status":200,"raw":"{\"api_keys\": [{\"id\": 7.5, \"name\": \"n\", \"key_prefix\": \"p\"}], \"target_user_role\": \"member\"}"}},
    requests: [{"method":"GET","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials","body":null}],
    code: 1,
    stdout: "",
    stderr: "Error: WorkspaceClient.list_member_keys: unexpected server response for MemberAPIKey (id.int: Input should be a valid integer, got a number with a fractional part; id.str: Input should be a valid string). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "auth list-keys, an id of null",
    argv: ["auth","list-keys","-u","google_2","--json","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"GET /api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials":{"status":200,"raw":"{\"api_keys\": [{\"id\": null, \"name\": \"n\", \"key_prefix\": \"p\"}], \"target_user_role\": \"member\"}"}},
    requests: [{"method":"GET","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials","body":null}],
    code: 1,
    stdout: "",
    stderr: "Error: WorkspaceClient.list_member_keys: unexpected server response for MemberAPIKey (id.int: Input should be a valid integer; id.str: Input should be a valid string). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "auth revoke-key akey_",
    argv: ["auth","revoke-key","akey_3fJ0kQ7xWm2Lp9RtZa4bNc","-u","google_2","-y","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"DELETE /api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials/api-keys/akey_3fJ0kQ7xWm2Lp9RtZa4bNc":{"status":200,"raw":"{\"status\": \"deleted\", \"key_id\": \"akey_3fJ0kQ7xWm2Lp9RtZa4bNc\"}"}},
    requests: [{"method":"DELETE","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/members/google_2/credentials/api-keys/akey_3fJ0kQ7xWm2Lp9RtZa4bNc","body":null}],
    code: 0,
    stdout: "Revoked key akey_3fJ0kQ7xWm2Lp9RtZa4bNc of google_2\n",
    stderr: "",
  },
  {
    name: "workspace invite create, a v0.89.0 winv_ id",
    argv: ["workspace","invite","create","new@example.com","-c","22222222-3333-4444-5555-666666666666","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"POST /api/v1/workspaces/11111111-2222-3333-4444-555555555555/invitations":{"status":201,"raw":"{\"id\": \"winv_4hT9xQ2mLp8vZr1sKc3dEf\", \"workspace_id\": \"11111111-2222-3333-4444-555555555555\", \"token\": \"tok_0123456789abcdefghij\", \"email\": \"new@example.com\", \"role\": \"member\", \"invited_by\": \"google_1\", \"expires_at\": \"2026-11-08T00:00:00Z\", \"accepted_at\": null, \"accepted_by\": null, \"created_at\": \"2026-11-01T00:00:00Z\", \"invitation_url\": \"https://memory.kagura-ai.com/invite/tok_0123456789abcdefghij\", \"is_expired\": false, \"is_accepted\": false, \"allowed_context_ids\": [\"22222222-3333-4444-5555-666666666666\"]}"}},
    requests: [{"method":"POST","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/invitations","body":"{\"email\":\"new@example.com\",\"role\":\"member\",\"allowed_context_ids\":[\"22222222-3333-4444-5555-666666666666\"]}"}],
    code: 0,
    stdout: "Invitation winv_4hT9xQ2mLp8vZr1sKc3dEf → new@example.com (role=member, expires=2026-11-08)\nhttps://memory.kagura-ai.com/invite/tok_0123456789abcdefghij\n",
    stderr: "⚠ The invitation URL below is shown once — treat it as a join credential.\n",
  },
  {
    name: "workspace invite create, a lax \"7\" id",
    argv: ["workspace","invite","create","new@example.com","--role","admin","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"POST /api/v1/workspaces/11111111-2222-3333-4444-555555555555/invitations":{"status":201,"raw":"{\"id\": \"7\", \"email\": \"new@example.com\", \"role\": \"admin\", \"invitation_url\": \"https://u\"}"}},
    requests: [{"method":"POST","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/invitations","body":"{\"email\":\"new@example.com\",\"role\":\"admin\"}"}],
    code: 0,
    stdout: "Invitation 7 → new@example.com (role=admin, expires=never)\nhttps://u\n",
    stderr: "⚠ The invitation URL below is shown once — treat it as a join credential.\n",
  },
  {
    name: "workspace invite list, winv_ ids",
    argv: ["workspace","invite","list","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"GET /api/v1/workspaces/11111111-2222-3333-4444-555555555555/invitations":{"status":200,"raw":"[{\"id\": \"winv_4hT9xQ2mLp8vZr1sKc3dEf\", \"workspace_id\": \"11111111-2222-3333-4444-555555555555\", \"token\": null, \"email\": \"new@example.com\", \"role\": \"member\", \"invited_by\": \"google_1\", \"expires_at\": \"2026-11-08T00:00:00Z\", \"accepted_at\": null, \"accepted_by\": null, \"created_at\": \"2026-11-01T00:00:00Z\", \"invitation_url\": null, \"is_expired\": false, \"is_accepted\": false, \"allowed_context_ids\": [\"22222222-3333-4444-5555-666666666666\"]}, {\"id\": \"winv_7Gk2Lm9Np4Qr6St8Uv0WxY\", \"workspace_id\": \"11111111-2222-3333-4444-555555555555\", \"token\": null, \"email\": null, \"role\": \"viewer\", \"invited_by\": \"google_1\", \"expires_at\": null, \"accepted_at\": null, \"accepted_by\": null, \"created_at\": \"2026-11-01T00:00:00Z\", \"invitation_url\": null, \"is_expired\": true, \"is_accepted\": false, \"allowed_context_ids\": [\"22222222-3333-4444-5555-666666666666\"]}]"}},
    requests: [{"method":"GET","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/invitations","body":null}],
    code: 0,
    stdout: "ID                          EMAIL                          ROLE     STATE     EXPIRES\nwinv_4hT9xQ2mLp8vZr1sKc3dEf new@example.com                member   pending   2026-11-08\nwinv_7Gk2Lm9Np4Qr6St8Uv0WxY -                              viewer   expired   never\n",
    stderr: "",
  },
  {
    name: "workspace invite list --json, a winv_ id, a lax \"7\" and an integer",
    argv: ["workspace","invite","list","--json","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"GET /api/v1/workspaces/11111111-2222-3333-4444-555555555555/invitations":{"status":200,"raw":"[{\"id\": \"winv_4hT9xQ2mLp8vZr1sKc3dEf\", \"workspace_id\": \"11111111-2222-3333-4444-555555555555\", \"token\": null, \"email\": \"new@example.com\", \"role\": \"member\", \"invited_by\": \"google_1\", \"expires_at\": \"2026-11-08T00:00:00Z\", \"accepted_at\": null, \"accepted_by\": null, \"created_at\": \"2026-11-01T00:00:00Z\", \"invitation_url\": null, \"is_expired\": false, \"is_accepted\": false, \"allowed_context_ids\": [\"22222222-3333-4444-5555-666666666666\"]}, {\"id\": \"7\", \"workspace_id\": \"11111111-2222-3333-4444-555555555555\", \"token\": null, \"email\": \"new@example.com\", \"role\": \"member\", \"invited_by\": \"google_1\", \"expires_at\": \"2026-11-08T00:00:00Z\", \"accepted_at\": null, \"accepted_by\": null, \"created_at\": \"2026-11-01T00:00:00Z\", \"invitation_url\": null, \"is_expired\": false, \"is_accepted\": false, \"allowed_context_ids\": [\"22222222-3333-4444-5555-666666666666\"]}, {\"id\": 8, \"role\": \"admin\"}]"}},
    requests: [{"method":"GET","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/invitations","body":null}],
    code: 0,
    stdout: "[\n  {\n    \"id\": \"winv_4hT9xQ2mLp8vZr1sKc3dEf\",\n    \"email\": \"new@example.com\",\n    \"role\": \"member\",\n    \"is_accepted\": false,\n    \"is_expired\": false,\n    \"created_at\": \"2026-11-01T00:00:00Z\",\n    \"expires_at\": \"2026-11-08T00:00:00Z\",\n    \"allowed_context_ids\": [\n      \"22222222-3333-4444-5555-666666666666\"\n    ]\n  },\n  {\n    \"id\": \"7\",\n    \"email\": \"new@example.com\",\n    \"role\": \"member\",\n    \"is_accepted\": false,\n    \"is_expired\": false,\n    \"created_at\": \"2026-11-01T00:00:00Z\",\n    \"expires_at\": \"2026-11-08T00:00:00Z\",\n    \"allowed_context_ids\": [\n      \"22222222-3333-4444-5555-666666666666\"\n    ]\n  },\n  {\n    \"id\": 8,\n    \"email\": null,\n    \"role\": \"admin\",\n    \"is_accepted\": false,\n    \"is_expired\": false,\n    \"created_at\": null,\n    \"expires_at\": null,\n    \"allowed_context_ids\": null\n  }\n]\n",
    stderr: "",
  },
  {
    name: "workspace invite list, an id of 7.5",
    argv: ["workspace","invite","list","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"GET /api/v1/workspaces/11111111-2222-3333-4444-555555555555/invitations":{"status":200,"raw":"[{\"id\": 7.5, \"role\": \"admin\"}]"}},
    requests: [{"method":"GET","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/invitations","body":null}],
    code: 1,
    stdout: "",
    stderr: "Error: WorkspaceClient.list_invitations: unexpected server response for WorkspaceInvitation (id.int: Input should be a valid integer, got a number with a fractional part; id.str: Input should be a valid string). The server may be newer than this SDK; upgrading kagura-memory may help.\n",
  },
  {
    name: "workspace invite list, an id of true",
    argv: ["workspace","invite","list","--json","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"GET /api/v1/workspaces/11111111-2222-3333-4444-555555555555/invitations":{"status":200,"raw":"[{\"id\": true, \"role\": \"admin\"}]"}},
    requests: [{"method":"GET","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/invitations","body":null}],
    code: 0,
    stdout: "[\n  {\n    \"id\": 1,\n    \"email\": null,\n    \"role\": \"admin\",\n    \"is_accepted\": false,\n    \"is_expired\": false,\n    \"created_at\": null,\n    \"expires_at\": null,\n    \"allowed_context_ids\": null\n  }\n]\n",
    stderr: "",
  },
  {
    name: "workspace invite revoke winv_",
    argv: ["workspace","invite","revoke","winv_4hT9xQ2mLp8vZr1sKc3dEf","-w","11111111-2222-3333-4444-555555555555"],
    routes: {"DELETE /api/v1/workspaces/11111111-2222-3333-4444-555555555555/invitations/winv_4hT9xQ2mLp8vZr1sKc3dEf":{"status":200,"raw":"{\"success\": true}"}},
    requests: [{"method":"DELETE","path":"/api/v1/workspaces/11111111-2222-3333-4444-555555555555/invitations/winv_4hT9xQ2mLp8vZr1sKc3dEf","body":null}],
    code: 0,
    stdout: "Revoked invitation winv_4hT9xQ2mLp8vZr1sKc3dEf\n",
    stderr: "",
  },
];

/** `KAGURA_API_KEY=k`, as the recordings ran: no workspace bound, so `-w` names it. */
const AUTH: ResolvedAuth = { kind: "static", apiKey: "k", mcpUrl: "https://api.test/mcp", source: "env" };

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  sent: SentRequest[];
}

/** Run `argv` against the recorded routes ({@link recordedFetch}), collecting every request sent. */
async function run(argv: string[], routes: RecordedRoutes): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const sent: SentRequest[] = [];
  const fetch = recordedFetch(routes, sent);
  const deps = {
    write: (line: string) => void out.push(line),
    writeError: (line: string) => void err.push(line),
    confirm: async () => {
      throw new Error("no question expected");
    },
    loadConfig: () => ({ api_key: "k" }),
    resolveAuth: () => AUTH,
    makeWorkspaceClient: (auth: ResolvedAuth | undefined, hint: string | null | undefined) =>
      restClientFromAuth(WorkspaceClient, auth!, { workspaceIdHint: hint ?? null, fetch }),
    makeClient: () => {
      throw new Error("MCP client not expected here");
    },
  } as unknown as CliDeps;
  const code = await runCli(argv, deps);
  return { code, stdout: terminalText(out), stderr: terminalText(err), sent };
}

describe("member key and invitation output with v0.89.0 string ids, byte for byte the Python CLI's (#102)", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const r = await run(c.argv, c.routes);
    expect(r.code).toBe(c.code);
    expect(r.stdout).toBe(c.stdout);
    expect(r.stderr).toBe(c.stderr);
    expect(r.sent).toEqual(c.requests);
  });
});

describe("a listed string id, revoked as printed (#102)", () => {
  const WS = "11111111-2222-3333-4444-555555555555";
  const byName = (name: string) => CASES.find((c) => c.name === name)!;

  it("revokes the `akey_…` id `auth list-keys --json` printed", async () => {
    const listed = byName('auth list-keys --json, an akey_ id, a lax "7" and an integer');
    const keys = JSON.parse((await run(listed.argv, listed.routes)).stdout) as Array<{ id: unknown }>;
    expect(keys.map((k) => k.id)).toEqual(["akey_3fJ0kQ7xWm2Lp9RtZa4bNc", "7", 8]);

    const revoke = byName("auth revoke-key akey_");
    for (const key of keys) {
      const id = String(key.id);
      const route = `DELETE /api/v1/workspaces/${WS}/members/google_2/credentials/api-keys/${id}`;
      const r = await run(["auth", "revoke-key", id, "-u", "google_2", "-y", "-w", WS], {
        [route]: Object.values(revoke.routes)[0]!,
      });
      expect(r).toEqual({
        code: 0,
        stdout: `Revoked key ${id} of google_2\n`,
        stderr: "",
        sent: [{ method: "DELETE", path: route.slice("DELETE ".length), body: null }],
      });
    }
  });

  it("revokes the `winv_…` id `workspace invite list --json` printed", async () => {
    const listed = byName('workspace invite list --json, a winv_ id, a lax "7" and an integer');
    const invitations = JSON.parse((await run(listed.argv, listed.routes)).stdout) as Array<{ id: unknown }>;
    expect(invitations.map((i) => i.id)).toEqual(["winv_4hT9xQ2mLp8vZr1sKc3dEf", "7", 8]);

    for (const invitation of invitations) {
      const id = String(invitation.id);
      const path = `/api/v1/workspaces/${WS}/invitations/${id}`;
      const r = await run(["workspace", "invite", "revoke", id, "-w", WS], {
        [`DELETE ${path}`]: { status: 200, raw: '{"success": true}' },
      });
      expect(r).toEqual({
        code: 0,
        stdout: `Revoked invitation ${id}\n`,
        stderr: "",
        sent: [{ method: "DELETE", path, body: null }],
      });
    }
  });
});
