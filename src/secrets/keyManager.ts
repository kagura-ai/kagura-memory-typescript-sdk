/**
 * age private-key custody (port of secrets/keymanager.py, #28).
 *
 * The age private key (`AGE-SECRET-KEY-1...`) is the root of trust for the
 * zero-knowledge secret store: whoever holds it can decrypt every ciphertext
 * ever shared with the matching recipient. Custody is therefore abstracted
 * behind {@link KeyStore}, and this module ships **no default backend**.
 *
 * That is the one deliberate divergence from the Python SDK, which defaults
 * to the OS keychain via `keyring`. Node has no stdlib keychain, and every
 * option (`keytar` and friends) is a native module — so a default here would
 * either mean a native runtime dependency, breaking the SDK's zero-dependency
 * promise, or a plaintext file, which Python explicitly refuses. Both are
 * worse than asking the caller for a store, so {@link KeyManager} takes one
 * and the fail-closed property is preserved: there is no insecure fallback
 * to accidentally land in.
 *
 * Wire a `keytar`/`libsecret` backend in an app, or an environment-variable
 * backend in CI where the key already arrives through the secret manager:
 *
 * ```ts
 * const store: KeyStore = {
 *   get: async (name) => process.env[`AGE_KEY_${name.toUpperCase()}`] ?? null,
 *   set: async () => { throw new Error("read-only in CI"); },
 *   delete: async () => {},
 * };
 * const keys = new KeyManager({ store, profile: "ci" });
 * ```
 *
 * A passphrase-encrypted file tier (`age -p` / scrypt) for hosts with no
 * keychain is a deliberate follow-on in both SDKs, not a gap here.
 */

import { KaguraKeyCustodyError } from "../errors.js";
import { fingerprint, generateKeypair, recipientFromIdentity } from "./crypto.js";

/**
 * Minimal secret-at-rest backend: get / set / delete a named string.
 *
 * Async where Python's protocol is sync, because every plausible Node
 * backend (OS keychain bindings, a cloud secret manager) is async and a sync
 * signature would force callers to block or lie.
 *
 * Implementations should throw {@link KaguraKeyCustodyError} when they
 * cannot store the value securely, rather than degrading. `delete` must be
 * idempotent: removing an absent key is success.
 */
export interface KeyStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface KeyManagerOptions {
  /** Custody backend. Required — there is no insecure default. */
  store: KeyStore;
  /** Profile name, matching the credentials profile (default `"default"`). */
  profile?: string;
}

/**
 * Generate and custody the per-profile age keypair.
 *
 * The private key never leaves the store except through
 * {@link KeyManager.getIdentity}, which exists because decryption needs it
 * locally; callers that only register with the server want
 * {@link KeyManager.getRecipient} or {@link KeyManager.fingerprint}.
 *
 * Key names are `identity:{profile}`, byte-identical to Python's, so both
 * SDKs find the same entry in a shared backend.
 */
export class KeyManager {
  private readonly store: KeyStore;
  private readonly profile: string;

  constructor(options: KeyManagerOptions) {
    this.store = options.store;
    this.profile = options.profile ?? "default";
  }

  private get keyName(): string {
    return `identity:${this.profile}`;
  }

  /** True when a private key is already in custody for this profile. */
  async hasKey(): Promise<boolean> {
    return (await this.store.get(this.keyName)) !== null;
  }

  /**
   * Generate a keypair, store the private key, return the public half.
   *
   * @throws KaguraKeyCustodyError if a key already exists for this profile —
   *   overwriting it would silently orphan every ciphertext encrypted to the
   *   old recipient.
   * @throws KaguraCryptoError if `age-encryption` is not installed.
   */
  async enroll(): Promise<{ recipient: string; fingerprint: string }> {
    if (await this.hasKey()) {
      throw new KaguraKeyCustodyError(
        `a key already exists for profile ${JSON.stringify(this.profile)}; refusing to ` +
          "overwrite it. Delete it first, or enroll under a different profile.",
      );
    }
    const { identity, recipient } = await generateKeypair();
    await this.store.set(this.keyName, identity);
    return { recipient, fingerprint: fingerprint(recipient) };
  }

  /**
   * Return the custodied private key.
   *
   * @throws KaguraKeyCustodyError if no key is enrolled for this profile.
   */
  async getIdentity(): Promise<string> {
    const identity = await this.store.get(this.keyName);
    if (identity === null) {
      throw new KaguraKeyCustodyError(
        `no age key in custody for profile ${JSON.stringify(this.profile)}; ` +
          "enroll one first.",
      );
    }
    return identity;
  }

  /** Return the public `age1` recipient derived from the custodied key. */
  async getRecipient(): Promise<string> {
    return recipientFromIdentity(await this.getIdentity());
  }

  /** Return the sha256 fingerprint of this profile's public recipient. */
  async fingerprint(): Promise<string> {
    return fingerprint(await this.getRecipient());
  }

  /** Remove this profile's private key from custody. Idempotent. */
  async delete(): Promise<void> {
    await this.store.delete(this.keyName);
  }
}
