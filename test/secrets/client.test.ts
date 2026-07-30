/**
 * Tests for SecretClient (#28) — wire shapes, the 403/429 hooks, path
 * encoding, and the client-side grant-consistency guards.
 *
 * Wire assertions mirror secrets/client.py against the memory-cloud v0.39.0+
 * `/api/v1/config/secrets` contract, because the two SDKs read and write the
 * same secrets: a snake_case field name that drifts here silently produces a
 * secret the Python CLI cannot use.
 */

import { describe, expect, it } from "vitest";

import {
  KaguraAuthError,
  KaguraConnectionError,
  KaguraNotFoundError,
  KaguraQuotaError,
  KaguraSecretError,
} from "../../src/errors.js";
import { SecretClient } from "../../src/secrets/client.js";
import type { PubkeyResponse } from "../../src/models.js";
import { TEST_FINGERPRINT, TEST_IDENTITY, TEST_RECIPIENT } from "./vectors.js";
import { decrypt } from "../../src/secrets/crypto.js";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Scripted fetch stub; `bodies` is consumed in order, falling back to `body`. */
class FakeRest {
  requests: Recorded[] = [];
  status = 200;
  body = "{}";
  bodies: string[] = [];
  responseHeaders: Record<string, string> = {};

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
    const body = this.bodies.length > 0 ? this.bodies.shift()! : this.body;
    return new Response(this.status === 204 ? null : body, {
      status: this.status,
      headers: this.responseHeaders,
    });
  };

  /** Parsed JSON body of the Nth request. */
  json(n = 0): Record<string, unknown> {
    return JSON.parse(this.requests[n]!.body!) as Record<string, unknown>;
  }

  /** Path (and query) of the Nth request, base URL stripped. */
  path(n = 0): string {
    return this.requests[n]!.url.replace("https://api.test", "");
  }
}

function makeClient(rest: FakeRest): SecretClient {
  return new SecretClient({ apiKey: "k", baseUrl: "https://api.test", fetch: rest.fetch });
}

const PUBKEY: PubkeyResponse = {
  id: "pk-1",
  identity_id: "id-1",
  pubkey: TEST_RECIPIENT,
  fingerprint: TEST_FINGERPRINT,
  status: "active",
  created_at: "2026-07-30T00:00:00Z",
};

describe("SecretClient construction", () => {
  it("shares the REST client spine", () => {
    expect(() => new SecretClient({})).toThrow(
      /SecretClient requires apiKey, or use SecretClient\.fromMcpUrl/,
    );
    expect(() => new SecretClient({ apiKey: "k", baseUrl: "http://evil.test" })).toThrow(
      /Base URL must use HTTPS/,
    );
    expect(typeof SecretClient.fromMcpUrl).toBe("function");
  });
});

describe("pubkey registry", () => {
  it("registers a pubkey and omits the label when unset", async () => {
    const rest = new FakeRest();
    const client = makeClient(rest);
    await client.registerPubkey(TEST_RECIPIENT, "laptop");
    await client.registerPubkey(TEST_RECIPIENT);

    expect(rest.path(0)).toBe("/api/v1/config/secrets/pubkeys");
    expect(rest.requests[0]!.method).toBe("POST");
    expect(rest.json(0)).toEqual({ pubkey: TEST_RECIPIENT, label: "laptop" });
    expect(rest.json(1)).not.toHaveProperty("label");
  });

  it("lists workspace and caller pubkeys from distinct endpoints", async () => {
    const rest = new FakeRest();
    rest.body = JSON.stringify([PUBKEY]);
    const client = makeClient(rest);

    expect(await client.listPubkeys()).toHaveLength(1);
    expect(await client.listMyPubkeys()).toHaveLength(1);
    expect(rest.path(0)).toBe("/api/v1/config/secrets/pubkeys");
    expect(rest.path(1)).toBe("/api/v1/config/secrets/pubkeys/me");
  });

  it("approves and revokes by pubkey id", async () => {
    const rest = new FakeRest();
    rest.body = JSON.stringify(PUBKEY);
    const client = makeClient(rest);
    await client.approvePubkey("pk-1");
    await client.revokePubkey("pk-1");

    expect(rest.path(0)).toBe("/api/v1/config/secrets/pubkeys/pk-1/approve");
    expect(rest.path(1)).toBe("/api/v1/config/secrets/pubkeys/pk-1/revoke");
    expect(rest.requests.every((r) => r.method === "POST")).toBe(true);
  });

  it("rejects a non-array body where the contract says list", async () => {
    const rest = new FakeRest();
    rest.body = JSON.stringify({ pubkeys: [] });
    await expect(makeClient(rest).listPubkeys()).rejects.toThrow(/expected a JSON array/);
  });
});

describe("secrets", () => {
  it("puts a ciphertext version with snake_case wire fields", async () => {
    const rest = new FakeRest();
    const client = makeClient(rest);
    await client.putSecret({
      name: "openai/key",
      ciphertext: "-----BEGIN AGE ENCRYPTED FILE-----\nAAAA\n-----END AGE ENCRYPTED FILE-----\n",
      recipientsSnapshot: [TEST_FINGERPRINT],
      grantPubkeyIds: ["pk-1"],
    });

    expect(rest.path()).toBe("/api/v1/config/secrets");
    expect(rest.json()).toEqual({
      name: "openai/key",
      ciphertext: "-----BEGIN AGE ENCRYPTED FILE-----\nAAAA\n-----END AGE ENCRYPTED FILE-----\n",
      recipients_snapshot: [TEST_FINGERPRINT],
      grant_pubkey_ids: ["pk-1"],
    });
  });

  it("fetches by name in the body, not the path", async () => {
    const rest = new FakeRest();
    rest.body = JSON.stringify({ name: "a/b", ciphertext: "x" });
    const client = makeClient(rest);
    await client.fetchSecret("cloudflare/api-token");
    await client.fetchSecret("cloudflare/api-token", 3);

    // Body-carried names are why a '/' needs no escaping on this endpoint.
    expect(rest.path(0)).toBe("/api/v1/config/secrets/fetch");
    expect(rest.json(0)).toEqual({ name: "cloudflare/api-token" });
    expect(rest.json(1)).toEqual({ name: "cloudflare/api-token", version_number: 3 });
  });

  it("lists metadata and verifies the audit chain", async () => {
    const rest = new FakeRest();
    rest.bodies = [JSON.stringify([]), JSON.stringify({ valid: true, entries: 4 })];
    const client = makeClient(rest);

    expect(await client.listSecrets()).toEqual([]);
    expect(await client.verifyAudit()).toEqual({ valid: true, entries: 4 });
    expect(rest.path(0)).toBe("/api/v1/config/secrets");
    expect(rest.path(1)).toBe("/api/v1/config/secrets/audit/verify");
  });

  it("revokes one recipient's grant", async () => {
    const rest = new FakeRest();
    rest.body = JSON.stringify({ name: "n", rotation_needed: true });
    await makeClient(rest).revokeGrant("openai/key", "pk-2");

    expect(rest.path()).toBe("/api/v1/config/secrets/revoke-grant");
    expect(rest.json()).toEqual({ name: "openai/key", recipient_pubkey_id: "pk-2" });
  });

  it("percent-encodes each delete path segment but keeps the slashes", async () => {
    const rest = new FakeRest();
    rest.status = 204;
    const client = makeClient(rest);
    await client.deleteSecret("cloudflare/api token");
    await client.deleteSecret("plain");

    // The separators stay structural so the server's {name:path} converter
    // still routes; only the segment contents are escaped.
    expect(rest.path(0)).toBe("/api/v1/config/secrets/cloudflare/api%20token");
    expect(rest.path(1)).toBe("/api/v1/config/secrets/plain");
    expect(rest.requests[0]!.method).toBe("DELETE");
  });

  it("escapes a segment that would otherwise inject a path", async () => {
    const rest = new FakeRest();
    rest.status = 204;
    await makeClient(rest).deleteSecret("a#b?c");
    expect(rest.path()).toBe("/api/v1/config/secrets/a%23b%3Fc");
  });
});

describe("error mapping", () => {
  it("gives 403 an actionable message naming all three causes", async () => {
    const rest = new FakeRest();
    rest.status = 403;
    rest.body = JSON.stringify({ detail: "no grant" });
    const error = await makeClient(rest)
      .fetchSecret("x")
      .catch((e: unknown) => e);

    // 403-not-404 is deliberate on the server: a 404 would confirm the
    // secret exists. The message must not pretend to know which cause it is.
    expect(error).toBeInstanceOf(KaguraConnectionError);
    const message = (error as Error).message;
    expect(message).toMatch(/Access denied \(HTTP 403\)/);
    expect(message).toMatch(/may not have a grant/);
    expect(message).toMatch(/may not exist/);
    expect(message).toMatch(/lack permission/);
    expect(message).toMatch(/\(no grant\)/);
  });

  it("still reads as 403 when the body carries no detail", async () => {
    const rest = new FakeRest();
    rest.status = 403;
    rest.body = "";
    await expect(makeClient(rest).listSecrets()).rejects.toThrow(/Access denied \(HTTP 403\)/);
  });

  it("maps 429 through the generic branch, not KaguraQuotaError", async () => {
    const rest = new FakeRest();
    rest.status = 429;
    rest.body = JSON.stringify({ detail: "slow down" });
    const error = await makeClient(rest)
      .listSecrets()
      .catch((e: unknown) => e);

    // Preserved from the Python port on purpose: promoting this to
    // KaguraQuotaError would reclassify errors for existing callers.
    expect(error).not.toBeInstanceOf(KaguraQuotaError);
    expect(error).toBeInstanceOf(KaguraConnectionError);
    expect((error as Error).message).toBe("HTTP 429: slow down");
  });

  it("keeps the inherited 401 and 404 mappings", async () => {
    const rest = new FakeRest();
    rest.status = 401;
    await expect(makeClient(rest).listSecrets()).rejects.toBeInstanceOf(KaguraAuthError);

    const notFound = new FakeRest();
    notFound.status = 404;
    notFound.body = JSON.stringify({ detail: "no such secret" });
    await expect(makeClient(notFound).deleteSecret("x")).rejects.toBeInstanceOf(
      KaguraNotFoundError,
    );
  });
});

describe("putSecretForRecipients", () => {
  it("encrypts locally and derives both grant lists from one recipient set", async () => {
    const rest = new FakeRest();
    rest.body = JSON.stringify({ name: "n", version_number: 1 });
    await makeClient(rest).putSecretForRecipients({
      name: "openai/key",
      plaintext: "sk-live-abc",
      recipients: [PUBKEY],
    });

    const sent = rest.json();
    expect(sent.name).toBe("openai/key");
    expect(sent.recipients_snapshot).toEqual([TEST_FINGERPRINT]);
    expect(sent.grant_pubkey_ids).toEqual(["pk-1"]);

    // The plaintext must never appear on the wire, and what does appear must
    // decrypt back to it with the recipient's identity.
    expect(rest.requests[0]!.body).not.toContain("sk-live-abc");
    const plaintext = await decrypt(sent.ciphertext as string, TEST_IDENTITY);
    expect(new TextDecoder().decode(plaintext)).toBe("sk-live-abc");
  });

  it("accepts raw bytes as well as a string", async () => {
    const rest = new FakeRest();
    rest.body = JSON.stringify({ name: "n", version_number: 1 });
    await makeClient(rest).putSecretForRecipients({
      name: "n",
      plaintext: new Uint8Array([0, 1, 2, 255]),
      recipients: [PUBKEY],
    });

    const plaintext = await decrypt(rest.json().ciphertext as string, TEST_IDENTITY);
    expect(Array.from(plaintext)).toEqual([0, 1, 2, 255]);
  });

  it("refuses an empty recipient list before the network", async () => {
    const rest = new FakeRest();
    await expect(
      makeClient(rest).putSecretForRecipients({ name: "n", plaintext: "v", recipients: [] }),
    ).rejects.toBeInstanceOf(KaguraSecretError);
    expect(rest.requests).toHaveLength(0);
  });

  it("refuses a recipient that is not active", async () => {
    const rest = new FakeRest();
    for (const status of ["pending", "revoked"]) {
      await expect(
        makeClient(rest).putSecretForRecipients({
          name: "n",
          plaintext: "v",
          recipients: [{ ...PUBKEY, status }],
        }),
      ).rejects.toThrow(/is not active/);
    }
    expect(rest.requests).toHaveLength(0);
  });

  it("refuses a pubkey whose advertised fingerprint is inconsistent", async () => {
    // The security-relevant check: a server that swapped the pubkey under a
    // fingerprint the caller verified out of band must not get a ciphertext.
    const rest = new FakeRest();
    await expect(
      makeClient(rest).putSecretForRecipients({
        name: "n",
        plaintext: "v",
        recipients: [{ ...PUBKEY, fingerprint: "0".repeat(64) }],
      }),
    ).rejects.toThrow(/pubkey\/fingerprint mismatch/);
    expect(rest.requests).toHaveLength(0);
  });

  it("checks every recipient, not just the first", async () => {
    const rest = new FakeRest();
    await expect(
      makeClient(rest).putSecretForRecipients({
        name: "n",
        plaintext: "v",
        recipients: [PUBKEY, { ...PUBKEY, id: "pk-2", status: "pending" }],
      }),
    ).rejects.toThrow(/is not active/);
    expect(rest.requests).toHaveLength(0);
  });
});
