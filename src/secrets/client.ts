/**
 * REST client for the Kagura zero-knowledge secret store
 * (port of secrets/client.py, #28).
 *
 * Talks to `/api/v1/config/secrets` on memory-cloud (v0.39.0+). This is a
 * pure wire layer: it sends and receives **only armored ciphertext** and
 * public metadata, never holds the age private key (that is
 * {@link KeyManager}'s job), and never sees plaintext. The one exception is
 * {@link SecretClient.putSecretForRecipients}, which encrypts locally before
 * handing the ciphertext to {@link SecretClient.putSecret} — the plaintext
 * still never reaches the wire.
 *
 * Construction mirrors {@link FilesClient} / {@link ResourceClient} /
 * {@link WorkspaceClient} so all four REST clients share one shape;
 * `SecretClient.fromMcpUrl(...)` resolves credentials the same way.
 */

import { KaguraConnectionError, KaguraError, KaguraSecretError } from "../errors.js";
import { extractDetail } from "../http.js";
import type {
  AuditVerifyResponse,
  PubkeyResponse,
  SecretMetaResponse,
  SecretPutResponse,
  SecretValueResponse,
} from "../models.js";
import {
  KaguraRestClient,
  type RequestContext,
  type RestResponse,
} from "../restBase.js";
import { encrypt, fingerprint } from "./crypto.js";

const BASE = "/api/v1/config/secrets";

/**
 * REST client for the secret store's pubkey registry and secret endpoints.
 *
 * Every method may throw {@link KaguraAuthError} (401),
 * {@link KaguraNotFoundError} (404), or {@link KaguraConnectionError} for
 * other HTTP and network failures — including the 400 the server returns
 * when a put's grant set is inconsistent, and the 403 described below.
 */
export class SecretClient extends KaguraRestClient {
  // ---- KaguraRestClient hooks -----------------------------------------

  /**
   * 403 → an actionable message instead of a bare `HTTP 403`.
   *
   * The server answers 403, not 404, for a secret the caller may not read,
   * so that the response does not reveal whether the secret exists. That
   * means a 403 here has three possible causes and the message has to name
   * all of them rather than guess.
   */
  protected override error403(response: RestResponse, _context: RequestContext): KaguraError {
    const detail = extractDetail(response.text);
    const base =
      "Access denied (HTTP 403): you may not have a grant on this secret, " +
      "it may not exist, or you lack permission for this operation.";
    return new KaguraConnectionError(detail ? `${base} (${detail})` : base);
  }

  /**
   * 429 → the generic `HTTP 429` mapping, not {@link KaguraQuotaError}.
   *
   * Deliberate divergence from the base class, preserved from the Python
   * port: the secret surface has always rendered 429 through the generic
   * branch, and changing it would silently reclassify errors for existing
   * callers on a file both SDKs share.
   */
  protected override error429(response: RestResponse): KaguraError {
    return this.genericError(response);
  }

  // -- pubkey registry ---------------------------------------------------

  /** Register a public age recipient. Lands in `pending` until an owner approves it. */
  async registerPubkey(pubkey: string, label?: string): Promise<PubkeyResponse> {
    const body: Record<string, unknown> = { pubkey };
    if (label !== undefined) {
      body.label = label;
    }
    const response = await this.request("POST", `${BASE}/pubkeys`, { json: body });
    return this.json(response) as PubkeyResponse;
  }

  /** List every pubkey in the workspace (owner/admin view). */
  async listPubkeys(): Promise<PubkeyResponse[]> {
    const response = await this.request("GET", `${BASE}/pubkeys`);
    return this.expectList(response) as PubkeyResponse[];
  }

  /** List the caller's own pubkeys. */
  async listMyPubkeys(): Promise<PubkeyResponse[]> {
    const response = await this.request("GET", `${BASE}/pubkeys/me`);
    return this.expectList(response) as PubkeyResponse[];
  }

  /** Approve a pending pubkey (owner only; TOFU attestation). */
  async approvePubkey(pubkeyId: string): Promise<PubkeyResponse> {
    const response = await this.request("POST", `${BASE}/pubkeys/${pubkeyId}/approve`);
    return this.json(response) as PubkeyResponse;
  }

  /** Revoke a pubkey (owner only). */
  async revokePubkey(pubkeyId: string): Promise<PubkeyResponse> {
    const response = await this.request("POST", `${BASE}/pubkeys/${pubkeyId}/revoke`);
    return this.json(response) as PubkeyResponse;
  }

  // -- secrets -----------------------------------------------------------

  /**
   * Store a new ciphertext version (low-level).
   *
   * The server enforces `set(recipientsSnapshot) === {fingerprint(pk) for pk
   * in grantPubkeyIds}` and answers 400 on mismatch. Prefer
   * {@link putSecretForRecipients}, which derives both lists from one
   * recipient set so they match by construction.
   */
  async putSecret(options: {
    name: string;
    /** Armored age ciphertext. This client never encrypts for you here. */
    ciphertext: string;
    recipientsSnapshot: string[];
    grantPubkeyIds: string[];
  }): Promise<SecretPutResponse> {
    const response = await this.request("POST", BASE, {
      json: {
        name: options.name,
        ciphertext: options.ciphertext,
        recipients_snapshot: options.recipientsSnapshot,
        grant_pubkey_ids: options.grantPubkeyIds,
      },
    });
    return this.json(response) as SecretPutResponse;
  }

  /** List secret metadata. Never includes values. */
  async listSecrets(): Promise<SecretMetaResponse[]> {
    const response = await this.request("GET", BASE);
    return this.expectList(response) as SecretMetaResponse[];
  }

  /**
   * Fetch a secret's armored ciphertext.
   *
   * The name travels in the body, not the path, so names containing `/`
   * (e.g. `cloudflare/api-token`) need no escaping here.
   */
  async fetchSecret(name: string, versionNumber?: number): Promise<SecretValueResponse> {
    const body: Record<string, unknown> = { name };
    if (versionNumber !== undefined) {
      body.version_number = versionNumber;
    }
    const response = await this.request("POST", `${BASE}/fetch`, { json: body });
    return this.json(response) as SecretValueResponse;
  }

  /**
   * Revoke one recipient's grant on a secret. Flags `rotation_needed`.
   *
   * Revoking does **not** invalidate copies already fetched. To contain a
   * leak: rotate the upstream credential, then re-encrypt to the remaining
   * recipients with {@link putSecretForRecipients}.
   */
  async revokeGrant(name: string, recipientPubkeyId: string): Promise<SecretMetaResponse> {
    const response = await this.request("POST", `${BASE}/revoke-grant`, {
      json: { name, recipient_pubkey_id: recipientPubkeyId },
    });
    return this.json(response) as SecretMetaResponse;
  }

  /**
   * Hard-delete a secret and all its versions and grants (owner only).
   *
   * The server appends a `delete` entry to the tamper-evident audit chain
   * *before* removal, so {@link verifyAudit} still passes afterwards.
   *
   * **Cleanup, not a security control.** Removing the stored ciphertext
   * neither un-shares a value a recipient already fetched nor rotates the
   * live upstream credential. To contain a leak, rotate first, then delete.
   *
   * @param name Slash-containing names are addressable: each path segment
   *   is percent-encoded individually so the `/` separators stay structural
   *   and the server's `{name:path}` converter still routes on them.
   */
  async deleteSecret(name: string): Promise<void> {
    const encoded = name
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    await this.request("DELETE", `${BASE}/${encoded}`);
  }

  /** Verify the tamper-evident audit chain (owner/admin). */
  async verifyAudit(): Promise<AuditVerifyResponse> {
    const response = await this.request("GET", `${BASE}/audit/verify`);
    return this.json(response) as AuditVerifyResponse;
  }

  // -- high-level orchestration ------------------------------------------

  /**
   * Encrypt `plaintext` to `recipients` and store it in one call.
   *
   * Enforces the server's grant-consistency invariant client-side, before
   * the network: every recipient must be `active` and must carry a
   * fingerprint matching its own pubkey. `recipients_snapshot` and
   * `grant_pubkey_ids` are then derived 1:1 from the same list, so the two
   * sets agree by construction rather than by the caller's care.
   *
   * The fingerprint check is the one that matters for security: it is what
   * stops the client from encrypting to a pubkey the server has swapped
   * under a fingerprint the caller verified out of band.
   *
   * Requires the optional `age-encryption` package (see
   * {@link ./crypto.js | crypto}); every other method on this client works
   * without it.
   *
   * @throws KaguraSecretError on an empty recipient list, a non-active
   *   recipient, or a pubkey/fingerprint mismatch.
   * @throws KaguraCryptoError if `age-encryption` is missing or encryption
   *   fails.
   */
  async putSecretForRecipients(options: {
    name: string;
    plaintext: Uint8Array | string;
    recipients: PubkeyResponse[];
  }): Promise<SecretPutResponse> {
    const { name, recipients } = options;
    if (recipients.length === 0) {
      throw new KaguraSecretError("at least one recipient is required to put a secret");
    }
    for (const r of recipients) {
      if (r.status !== "active") {
        throw new KaguraSecretError(
          `recipient ${r.pubkey} is not active (status=${JSON.stringify(r.status)}); ` +
            "grants require an owner-approved (active) pubkey",
        );
      }
      if (fingerprint(r.pubkey) !== r.fingerprint) {
        throw new KaguraSecretError(
          `pubkey/fingerprint mismatch for recipient ${r.id} — refusing to ` +
            "encrypt to a pubkey whose advertised fingerprint is inconsistent",
        );
      }
    }

    const plaintext =
      typeof options.plaintext === "string"
        ? new TextEncoder().encode(options.plaintext)
        : options.plaintext;
    const ciphertext = await encrypt(
      plaintext,
      recipients.map((r) => r.pubkey),
    );
    return this.putSecret({
      name,
      ciphertext,
      recipientsSnapshot: recipients.map((r) => r.fingerprint),
      grantPubkeyIds: recipients.map((r) => r.id),
    });
  }
}
