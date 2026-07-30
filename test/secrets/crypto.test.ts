/**
 * Tests for the age crypto primitives (#28).
 *
 * The load-bearing ones are the cross-implementation vectors: this SDK and
 * the Python SDK read and write the same secret store, so "typage and pyrage
 * agree" is a contract, not an implementation detail. See `vectors.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { KaguraCryptoError } from "../../src/errors.js";
import {
  armorDecode,
  armorEncode,
  decrypt,
  encrypt,
  fingerprint,
  generateKeypair,
  MAX_CIPHERTEXT_BYTES,
  recipientFromIdentity,
  RECIPIENT_RE,
  resetAgeCache,
} from "../../src/secrets/crypto.js";
import {
  PYRAGE_ARMORED,
  PYRAGE_PLAINTEXT,
  PYTHON_ARMOR_OF_RAW,
  RAW_AGE_FILE_B64,
  TEST_FINGERPRINT,
  TEST_IDENTITY,
  TEST_RECIPIENT,
} from "./vectors.js";

const decode = (u: Uint8Array): string => new TextDecoder().decode(u);

describe("cross-implementation parity with the Python SDK", () => {
  it("decrypts a ciphertext pyrage wrote, grease stanza and all", async () => {
    const plaintext = await decrypt(PYRAGE_ARMORED, TEST_IDENTITY);
    expect(decode(plaintext)).toBe(PYRAGE_PLAINTEXT);
  });

  it("derives the same recipient from an identity", async () => {
    expect(await recipientFromIdentity(TEST_IDENTITY)).toBe(TEST_RECIPIENT);
  });

  it("computes the fingerprint the server and Python compare against", () => {
    expect(fingerprint(TEST_RECIPIENT)).toBe(TEST_FINGERPRINT);
  });

  it("armors a binary age file byte-identically to Python", () => {
    const raw = new Uint8Array(Buffer.from(RAW_AGE_FILE_B64, "base64"));
    expect(armorEncode(raw)).toBe(PYTHON_ARMOR_OF_RAW);
  });

  it("produces ciphertext for the same recipient Python granted", async () => {
    // Round-trips through our own decrypt; the pyrage direction is covered
    // above, so together these close the loop in both directions.
    const armored = await encrypt(new TextEncoder().encode("both ways"), [TEST_RECIPIENT]);
    expect(armored.startsWith("-----BEGIN AGE ENCRYPTED FILE-----\n")).toBe(true);
    expect(decode(await decrypt(armored, TEST_IDENTITY))).toBe("both ways");
  });
});

describe("armor codec", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(Array.from(armorDecode(armorEncode(bytes)))).toEqual(Array.from(bytes));
  });

  it("wraps base64 at 64 columns", () => {
    const armored = armorEncode(new Uint8Array(200));
    const body = armored.trim().split("\n").slice(1, -1);
    expect(body.length).toBeGreaterThan(1);
    for (const line of body.slice(0, -1)) {
      expect(line.length).toBe(64);
    }
    expect(body[body.length - 1]!.length).toBeLessThanOrEqual(64);
  });

  it("emits no blank body line for empty input", () => {
    expect(armorEncode(new Uint8Array())).toBe(
      "-----BEGIN AGE ENCRYPTED FILE-----\n-----END AGE ENCRYPTED FILE-----\n",
    );
    expect(armorDecode(armorEncode(new Uint8Array())).length).toBe(0);
  });

  it("tolerates CRLF and surrounding blank space", () => {
    const armored = armorEncode(new Uint8Array([7, 7, 7]));
    const messy = `\n\n  ${armored.replace(/\n/g, "\r\n")}  \n`;
    expect(Array.from(armorDecode(messy))).toEqual([7, 7, 7]);
  });

  it("rejects a missing PEM header or footer", () => {
    expect(() => armorDecode("not armored at all")).toThrow(/missing PEM header\/footer/);
    expect(() => armorDecode("-----BEGIN AGE ENCRYPTED FILE-----\nAAAA\n")).toThrow(
      /missing PEM header\/footer/,
    );
  });

  it("rejects a corrupt body instead of silently truncating it", () => {
    // Buffer.from(..., "base64") discards junk characters, which would hand
    // back a short "plaintext" rather than failing. Python passes
    // validate=True for the same reason.
    const bad =
      "-----BEGIN AGE ENCRYPTED FILE-----\nAAAA!!!!\n-----END AGE ENCRYPTED FILE-----\n";
    expect(() => armorDecode(bad)).toThrow(KaguraCryptoError);
    expect(() => armorDecode(bad)).toThrow(/invalid base64/);
  });

  it("rejects a body whose length is not a base64 multiple", () => {
    const bad = "-----BEGIN AGE ENCRYPTED FILE-----\nAAA\n-----END AGE ENCRYPTED FILE-----\n";
    expect(() => armorDecode(bad)).toThrow(/invalid base64/);
  });
});

describe("RECIPIENT_RE", () => {
  it("accepts a plain X25519 recipient", () => {
    expect(RECIPIENT_RE.test(TEST_RECIPIENT)).toBe(true);
  });

  it("rejects a trailing newline", () => {
    // JavaScript's `$` does not match before a final newline (Python's does,
    // which is why the Python port needs \Z). This pins the property so a
    // future regex tidy-up cannot quietly reintroduce the hole.
    expect(RECIPIENT_RE.test(`${TEST_RECIPIENT}\n`)).toBe(false);
  });

  it("rejects malformed recipients", () => {
    for (const bad of [
      "AGE-SECRET-KEY-1SOMETHING",
      "age1UPPERCASE0000000000000000000",
      "age1short",
      "",
      "age1",
      `age1${"q".repeat(111)}`,
    ]) {
      expect(RECIPIENT_RE.test(bad)).toBe(false);
    }
  });

  it("rejects non-X25519 recipients that age-encryption would accept", () => {
    // The reason the character class is bech32's alphabet rather than
    // Python's [0-9a-z]: `age-encryption`'s addRecipient dispatches these to
    // HybridRecipient/TagRecipient and encrypts happily, but pyrage is
    // X25519-only, so the Python CLI could never open the result. Every one
    // of these carries a second `1`, which bech32 forbids in the data part.
    for (const bad of [
      "age1pq1qsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqxqmyfk6ka",
      "age1tag1qsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqxqmyfk6",
      "age1tagpq1qsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqxqmyf",
      "age1yubikey1qwt50d05nh5vutpdzmlg5wn80xq5negm4uj9ghv0snvdd3jse3tm7x",
    ]) {
      expect(RECIPIENT_RE.test(bad)).toBe(false);
    }
  });

  it("excludes exactly the four characters bech32 omits", () => {
    for (const ch of ["1", "b", "i", "o"]) {
      expect(RECIPIENT_RE.test(`age1${ch.repeat(30)}`)).toBe(false);
    }
    // ...and accepts the rest of the alphabet, so the class is not simply
    // over-restrictive.
    for (const ch of "qpzry9x8gf2tvdw0s3jn54khce6mua7l") {
      expect(RECIPIENT_RE.test(`age1${ch.repeat(30)}`)).toBe(true);
    }
  });
});

describe("encrypt / decrypt", () => {
  it("round-trips through a freshly generated keypair", async () => {
    const { identity, recipient } = await generateKeypair();
    expect(identity.startsWith("AGE-SECRET-KEY-1")).toBe(true);
    expect(RECIPIENT_RE.test(recipient)).toBe(true);

    const armored = await encrypt(new TextEncoder().encode("hello"), [recipient]);
    expect(decode(await decrypt(armored, identity))).toBe("hello");
  });

  it("encrypts to multiple recipients, each of whom can open it", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const armored = await encrypt(new TextEncoder().encode("shared"), [a.recipient, b.recipient]);

    expect(decode(await decrypt(armored, a.identity))).toBe("shared");
    expect(decode(await decrypt(armored, b.identity))).toBe("shared");
  });

  it("refuses an empty recipient list", async () => {
    await expect(encrypt(new Uint8Array([1]), [])).rejects.toThrow(
      /at least one recipient is required/,
    );
  });

  it("refuses a malformed recipient before touching the crypto", async () => {
    await expect(encrypt(new Uint8Array([1]), ["not-an-age-key"])).rejects.toThrow(
      /malformed age recipient/,
    );
  });

  it("rejects one malformed recipient even when others are valid", async () => {
    await expect(encrypt(new Uint8Array([1]), [TEST_RECIPIENT, "bogus"])).rejects.toThrow(
      /malformed age recipient/,
    );
  });

  it("refuses to encrypt to a post-quantum recipient the Python SDK could not read", async () => {
    // The whole point of the tightened RECIPIENT_RE: without it,
    // age-encryption would encrypt to this and produce a secret that
    // `kagura secret get` on the Python side can never open.
    await expect(
      encrypt(new Uint8Array([1]), [
        "age1pq1qsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqxqmyfk6ka",
      ]),
    ).rejects.toThrow(/malformed age recipient/);
  });

  it("reports a bad identity distinctly from a failed decryption", async () => {
    await expect(decrypt(PYRAGE_ARMORED, "not-an-identity")).rejects.toThrow(
      /invalid age identity/,
    );

    const other = await generateKeypair();
    await expect(decrypt(PYRAGE_ARMORED, other.identity)).rejects.toThrow(
      /age decryption failed/,
    );
  });

  it("enforces the size cap on the way in", async () => {
    const oversized = "x".repeat(MAX_CIPHERTEXT_BYTES + 1);
    await expect(decrypt(oversized, TEST_IDENTITY)).rejects.toThrow(/exceeds the .* cap/);
  });

  it("enforces the size cap on the way out", async () => {
    // Armor inflates by 4/3; a plaintext comfortably over 3/4 of the cap
    // cannot fit. The check exists because the server would reject it.
    const big = new Uint8Array(MAX_CIPHERTEXT_BYTES);
    await expect(encrypt(big, [TEST_RECIPIENT])).rejects.toThrow(/exceeds the .* cap/);
  });

  it("measures the inbound cap in bytes, not UTF-16 code units", async () => {
    // A multi-byte string can sit under the cap by `.length` while being
    // several times over it by bytes. The check has to agree with what its
    // own message claims, and it must be the cap that rejects this — not
    // armor parsing incidentally noticing the input is not base64.
    const multibyte = "あ".repeat(MAX_CIPHERTEXT_BYTES / 2);
    expect(multibyte.length).toBeLessThan(MAX_CIPHERTEXT_BYTES);
    expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(MAX_CIPHERTEXT_BYTES);

    await expect(decrypt(multibyte, TEST_IDENTITY)).rejects.toThrow(/exceeds the .* cap/);
  });

  it("accepts an armored ciphertext exactly at the cap boundary", async () => {
    // Guards against an off-by-one turning the cap into a rejection of
    // legitimate values: the check is `>`, not `>=`.
    const atCap = "y".repeat(MAX_CIPHERTEXT_BYTES);
    await expect(decrypt(atCap, TEST_IDENTITY)).rejects.toThrow(/missing PEM header\/footer/);
  });
});

describe("Node 18: no WebCrypto global", () => {
  // WebCrypto only became a global in Node 19. CI on Node 18 failed with
  // "crypto.getRandomValues must be defined" on every encrypt and keygen
  // while decryption passed, because only the former need randomness. The
  // SDK declares engines.node >= 18, so simulate the absence here rather
  // than relying on the matrix to notice a regression.
  // Not `!`-asserted: on Node 18 there is no such property, so the
  // descriptor really is undefined — and an earlier version of this test
  // crashed on exactly that, on exactly the Node version it was written for.
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as { crypto?: unknown }).crypto;
    } else {
      Object.defineProperty(globalThis, "crypto", original);
    }
    resetAgeCache();
  });

  it("generates and encrypts with no crypto global present", async () => {
    delete (globalThis as { crypto?: unknown }).crypto;
    resetAgeCache();
    expect(globalThis.crypto).toBeUndefined();

    const { identity, recipient } = await generateKeypair();
    const armored = await encrypt(new TextEncoder().encode("node18"), [recipient]);

    expect(decode(await decrypt(armored, identity))).toBe("node18");
    // The shim installed it rather than merely working around it once.
    expect(typeof globalThis.crypto.getRandomValues).toBe("function");
  });

  it("leaves an existing crypto global alone", async () => {
    // Install our own object rather than reading whatever the runtime
    // happens to provide: on Node 18 nothing is there to start with, so an
    // ambient sentinel would make this assert against undefined. Methods are
    // bound so age still works through it and the identity check is real.
    const { webcrypto } = await import("node:crypto");
    const sentinel = {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      subtle: webcrypto.subtle,
      // Not the DOM `Crypto` type: this package's tsconfig has no DOM lib,
      // so that name does not exist here.
    } as unknown as typeof globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: sentinel, configurable: true });
    resetAgeCache();

    await generateKeypair();

    expect(globalThis.crypto).toBe(sentinel);
  });

  it("keeps it configurable so a host can still substitute its own", async () => {
    delete (globalThis as { crypto?: unknown }).crypto;
    resetAgeCache();
    await generateKeypair();

    expect(Object.getOwnPropertyDescriptor(globalThis, "crypto")!.configurable).toBe(true);
  });
});

describe("fingerprint", () => {
  it("is sha256 hex of the UTF-8 recipient string", () => {
    // Independent of the age package — this must keep working on a bare
    // install, since SecretClient's grant check calls it.
    expect(fingerprint("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(fingerprint(TEST_RECIPIENT)).toHaveLength(64);
  });
});
