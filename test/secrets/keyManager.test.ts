/**
 * Tests for KeyManager (#28) — custody behaviour with an injected store.
 *
 * The property worth protecting is fail-closed: a store that cannot hold the
 * key securely must surface an error, and an existing key must never be
 * overwritten (that would orphan every ciphertext encrypted to the old
 * recipient).
 */

import { describe, expect, it } from "vitest";

import { KaguraKeyCustodyError } from "../../src/errors.js";
import { fingerprint } from "../../src/secrets/crypto.js";
import { KeyManager, type KeyStore } from "../../src/secrets/keyManager.js";
import { TEST_FINGERPRINT, TEST_IDENTITY, TEST_RECIPIENT } from "./vectors.js";

class MemoryStore implements KeyStore {
  entries = new Map<string, string>();
  deleted: string[] = [];

  async get(name: string): Promise<string | null> {
    return this.entries.get(name) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    this.entries.set(name, value);
  }
  async delete(name: string): Promise<void> {
    this.deleted.push(name);
    this.entries.delete(name);
  }
}

describe("KeyManager", () => {
  it("uses Python's key naming so a shared backend finds the same entry", async () => {
    const store = new MemoryStore();
    await new KeyManager({ store }).enroll();
    await new KeyManager({ store, profile: "work" }).enroll();

    expect([...store.entries.keys()].sort()).toEqual(["identity:default", "identity:work"]);
  });

  it("enrolls a keypair, stores only the private half, returns only the public", async () => {
    const store = new MemoryStore();
    const manager = new KeyManager({ store });
    expect(await manager.hasKey()).toBe(false);

    const { recipient, fingerprint: fp } = await manager.enroll();

    expect(await manager.hasKey()).toBe(true);
    expect(recipient.startsWith("age1")).toBe(true);
    expect(fp).toBe(fingerprint(recipient));
    // What went into custody is the identity, and it is not the public half.
    expect(store.entries.get("identity:default")!.startsWith("AGE-SECRET-KEY-1")).toBe(true);
    expect(recipient.startsWith("AGE-SECRET-KEY")).toBe(false);
  });

  it("refuses to overwrite an existing key", async () => {
    const store = new MemoryStore();
    const manager = new KeyManager({ store });
    const first = await manager.enroll();

    await expect(manager.enroll()).rejects.toBeInstanceOf(KaguraKeyCustodyError);
    await expect(manager.enroll()).rejects.toThrow(/refusing to overwrite/);
    // And the original key is still the one in custody.
    expect(await manager.getRecipient()).toBe(first.recipient);
  });

  it("names the profile when nothing is enrolled", async () => {
    const manager = new KeyManager({ store: new MemoryStore(), profile: "ci" });
    await expect(manager.getIdentity()).rejects.toThrow(/no age key in custody for profile "ci"/);
    await expect(manager.getRecipient()).rejects.toBeInstanceOf(KaguraKeyCustodyError);
    await expect(manager.fingerprint()).rejects.toBeInstanceOf(KaguraKeyCustodyError);
  });

  it("derives the recipient and fingerprint from a custodied key", async () => {
    const store = new MemoryStore();
    await store.set("identity:default", TEST_IDENTITY);
    const manager = new KeyManager({ store });

    expect(await manager.getIdentity()).toBe(TEST_IDENTITY);
    expect(await manager.getRecipient()).toBe(TEST_RECIPIENT);
    expect(await manager.fingerprint()).toBe(TEST_FINGERPRINT);
  });

  it("deletes idempotently", async () => {
    const store = new MemoryStore();
    const manager = new KeyManager({ store, profile: "tmp" });
    await manager.enroll();

    await manager.delete();
    await manager.delete();

    expect(await manager.hasKey()).toBe(false);
    expect(store.deleted).toEqual(["identity:tmp", "identity:tmp"]);
  });

  it("propagates a store that refuses to hold the key", async () => {
    // The fail-closed path: a backend with no secure place to put the key
    // must break enrollment, not fall back to somewhere insecure.
    const failing: KeyStore = {
      get: async () => null,
      set: async () => {
        throw new KaguraKeyCustodyError("no OS keychain backend available");
      },
      delete: async () => {},
    };
    await expect(new KeyManager({ store: failing }).enroll()).rejects.toThrow(
      /no OS keychain backend/,
    );
  });
});
