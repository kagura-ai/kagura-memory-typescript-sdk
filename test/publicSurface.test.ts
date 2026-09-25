/**
 * Guards the package entry point.
 *
 * #9 was not a missing implementation — the device flow and the
 * credentials writer both existed in `src/auth/`, but nothing re-exported
 * them, so a TypeScript-only consumer could not reach them and had to
 * install the Python CLI to log in. These assertions fail if that public
 * surface regresses, which a unit test on the module itself would not
 * catch.
 */

import { describe, expect, it } from "vitest";

import * as sdk from "../src/index.js";
import type {
  ContextGuardrails,
  GetGuardrailDigestOptions,
  GuardrailDigest,
  GuardrailItem,
  GuardrailSet,
  LoadGuardrailsResponse,
  MemoryLoadGuardrailsOptions,
  ToolTrigger,
} from "../src/index.js";

describe("public surface: interactive login (#9)", () => {
  it("exports the one-call login orchestrator", () => {
    expect(typeof sdk.login).toBe("function");
  });

  it.each([
    "authorizeDevice",
    "pollForToken",
    "refreshAccessToken",
    "revokeToken",
  ])("exports the RFC 8628 primitive %s", (name) => {
    expect(typeof (sdk as unknown as Record<string, unknown>)[name]).toBe("function");
  });

  it("exports the profile refresh surface (#16)", () => {
    // refreshAccessToken alone is the stateless RFC call — it writes
    // nothing. Reaching a *stored* profile needs these.
    expect(typeof sdk.refresh).toBe("function");
    expect(typeof sdk.KaguraOAuth).toBe("function");
    expect(typeof sdk.withRefreshed).toBe("function");
    expect(typeof sdk.REFRESH_SKEW_SEC).toBe("number");
  });

  it("exports the invite-link builder next to the primitives (#44)", () => {
    // An app that embeds login() builds the same link the CLI prints, in
    // its own onUserCode.
    expect(typeof sdk.buildInviteLink).toBe("function");
  });

  it("exports the OAuth client constants", () => {
    expect(sdk.DEFAULT_CLIENT_ID).toBe("kagura-cli");
    expect(sdk.DEVICE_FLOW_GRANT_TYPE).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(sdk.REFRESH_TOKEN_GRANT_TYPE).toBe("refresh_token");
  });

  it.each([
    "loadCredentialsFile",
    "saveCredentialsFile",
    "updateProfile",
    "setProfile",
    "getProfile",
    "removeProfile",
    "deleteProfile",
    "setDefaultProfile",
    "deleteCredentialsFile",
    "defaultCredentialsPath",
    "emptyCredentialsFile",
    "isExpired",
  ])("exports the credentials-store function %s", (name) => {
    expect(typeof (sdk as unknown as Record<string, unknown>)[name]).toBe("function");
  });
});

describe("public surface: existing entry points", () => {
  it("still exports the client and REST clients", () => {
    expect(typeof sdk.KaguraClient).toBe("function");
    expect(typeof sdk.KaguraRestClient).toBe("function");
    expect(typeof sdk.FilesClient).toBe("function");
    expect(typeof sdk.ResourceClient).toBe("function");
    expect(typeof sdk.WorkspaceClient).toBe("function");
    expect(typeof sdk.AgentsClient).toBe("function");
    expect(typeof sdk.resolveAuth).toBe("function");
  });
});

describe("public surface: tool guardrails (#41)", () => {
  it("exports loadGuardrails on the client", () => {
    expect(typeof sdk.KaguraClient.prototype.loadGuardrails).toBe("function");
  });

  it("exports the guardrail wire types from the entry point", () => {
    // Compile-time half: these annotations fail typecheck if index.ts
    // stops re-exporting the types.
    const trigger: ToolTrigger = { tool: "Bash" };
    const items: GuardrailItem[] = [];
    const block: ContextGuardrails = {
      items: [],
      total_available: 0,
      truncated: false,
      tool_triggered_version: "",
    };
    const lanes: Pick<LoadGuardrailsResponse, "pinned" | "tool_triggered"> = {
      pinned: items,
      tool_triggered: items,
    };
    expect([trigger.tool, block.truncated, lanes.pinned]).toEqual(["Bash", false, []]);
  });

  it("exports the REST guardrail client and its types", () => {
    expect(sdk.MemoryClient.prototype instanceof sdk.KaguraRestClient).toBe(true);
    expect(typeof sdk.MemoryClient.prototype.getGuardrailDigest).toBe("function");
    expect(typeof sdk.MemoryClient.prototype.loadGuardrails).toBe("function");
    expect(typeof sdk.MemoryClient.fromMcpUrl).toBe("function");
    expect(sdk.GUARDRAIL_VERSION_HEADER).toBe("X-Kagura-Guardrails-Tool-Triggered-Version");

    const options: GetGuardrailDigestOptions = { target: "instructions", profile: "core" };
    const load: MemoryLoadGuardrailsOptions = { cap: 10 };
    const digest: GuardrailDigest = {
      context_id: "c",
      target: "export",
      text: "",
      tool_triggered_version: null,
      content_type: null,
    };
    // The MCP response is a GuardrailSet with the context block added.
    const set: GuardrailSet = {} as LoadGuardrailsResponse;
    expect([options.target, load.cap, digest.text, typeof set]).toEqual([
      "instructions",
      10,
      "",
      "object",
    ]);
  });

  it("keeps the export module and the CLI's REST helper internal", () => {
    const names = Object.keys(sdk);
    for (const name of ["writeGuardrailBlock", "spliceGuardrailBlock", "restClientFromAuth", "normalizeUuid"]) {
      expect(names).not.toContain(name);
    }
  });
});

describe("public surface: secret store (#28)", () => {
  it("exports the fourth REST client", () => {
    // #28 was filed because SecretClient was the one member of the
    // Files/Resource/Workspace/Secret set that never got ported — and
    // `callTool` being private meant there was no way to reach the
    // `secret_*` tools around it either.
    expect(typeof sdk.SecretClient).toBe("function");
    expect(sdk.SecretClient.prototype instanceof sdk.KaguraRestClient).toBe(true);
    expect(typeof sdk.SecretClient.fromMcpUrl).toBe("function");
  });

  it("exports the escape hatch that stops the next gap being a dead end", () => {
    expect(typeof sdk.KaguraClient.prototype.callRawTool).toBe("function");
  });

  it.each([
    "generateKeypair",
    "recipientFromIdentity",
    "fingerprint",
    "armorEncode",
    "armorDecode",
    "encrypt",
    "decrypt",
  ])("exports the crypto primitive %s", (name) => {
    expect(typeof (sdk as unknown as Record<string, unknown>)[name]).toBe("function");
  });

  it("exports the crypto contract constants", () => {
    expect(sdk.MAX_CIPHERTEXT_BYTES).toBe(262144);
    expect(sdk.RECIPIENT_RE).toBeInstanceOf(RegExp);
  });

  it("exports the custody surface", () => {
    expect(typeof sdk.KeyManager).toBe("function");
  });

  it("exports the secret error hierarchy", () => {
    // Catchable separately from transport failures: a fingerprint mismatch
    // is a contract violation, not a network problem.
    expect(sdk.KaguraSecretError.prototype instanceof sdk.KaguraError).toBe(true);
    expect(sdk.KaguraCryptoError.prototype instanceof sdk.KaguraSecretError).toBe(true);
    expect(sdk.KaguraKeyCustodyError.prototype instanceof sdk.KaguraSecretError).toBe(true);
  });
});

describe("public surface: typed gate errors (#40)", () => {
  it.each([
    "KaguraFeatureNotAvailableError",
    "KaguraPartialRollbackError",
    "KaguraPermissionError",
    "KaguraQuotaError",
  ])("exports %s as a KaguraError", (name) => {
    const cls = (sdk as unknown as Record<string, { prototype: unknown }>)[name];
    expect(typeof cls).toBe("function");
    // Existing `catch (e) { if (e instanceof KaguraError) ... }` code must
    // keep catching every one of them.
    expect(cls!.prototype instanceof sdk.KaguraError).toBe(true);
  });
});

describe("public surface: response drift (#57)", () => {
  it("exports KaguraResponseError as a KaguraError, as the Python SDK does", () => {
    expect(typeof sdk.KaguraResponseError).toBe("function");
    expect(sdk.KaguraResponseError.prototype instanceof sdk.KaguraError).toBe(true);
    // Not a transport failure: the call succeeded, and a retry fails alike.
    expect(sdk.KaguraResponseError.prototype instanceof sdk.KaguraConnectionError).toBe(false);
  });
});
