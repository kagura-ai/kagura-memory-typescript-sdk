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
