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
