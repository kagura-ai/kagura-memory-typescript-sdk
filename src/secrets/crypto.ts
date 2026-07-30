/**
 * age (X25519) crypto primitives for the zero-knowledge secret client
 * (port of secrets/crypto.py, #28).
 *
 * All cryptography is delegated to `age-encryption`
 * ([typage](https://github.com/FiloSottile/typage), by age's author) — the
 * TypeScript counterpart of the audited `pyrage` binding the Python SDK
 * uses. Nothing here implements crypto.
 *
 * **`age-encryption` is an optional peer dependency.** The base SDK ships
 * with zero runtime dependencies and that is a promise, not an accident, so
 * the crypto package is opt-in exactly as it is in Python (`pip install
 * 'kagura-memory[secret]'`). It is loaded lazily on first use; without it,
 * {@link encrypt} and {@link decrypt} throw a {@link KaguraCryptoError}
 * naming the install command. Everything that does not need it —
 * {@link fingerprint}, {@link armorEncode}, {@link armorDecode}, and the
 * whole of {@link SecretClient} except `putSecretForRecipients` — keeps
 * working on a bare install.
 *
 * Armoring is implemented here rather than taken from `age-encryption`, for
 * the same reason the Python port implements it: it is a transport encoding
 * (base64 + PEM framing), not crypto, and keeping it dependency-free means a
 * caller can inspect or relay a ciphertext without installing the crypto
 * package at all.
 *
 * Contract invariants enforced here, all three verified against the Python
 * SDK by round-tripping real ciphertext in both directions:
 *
 * - `fingerprint(pubkey) === sha256_hex(pubkey)` over the `age1` string;
 * - recipients match {@link RECIPIENT_RE} (plain X25519, no plugins);
 * - armored ciphertext is `<=` {@link MAX_CIPHERTEXT_BYTES}.
 */

import { createHash } from "node:crypto";

import { excMessage, KaguraCryptoError } from "../errors.js";

/**
 * Plain X25519 age recipient. Plugin recipients (`age1yubikey1...`), the
 * post-quantum hybrid form (`age1pq1...`), and tag recipients
 * (`age1tag1...`) are all rejected: the server contract is X25519-only, and
 * more importantly the Python SDK — which reads the same secrets — cannot
 * decrypt anything else.
 *
 * The character class is bech32's 32-symbol alphabet, which excludes `1`,
 * `b`, `i` and `o`. That one detail is what does the work: every non-X25519
 * form carries a second `1` (its plugin/type separator), so excluding `1`
 * from the data part rejects the whole family without a prefix allowlist to
 * keep up to date.
 *
 * This is deliberately **stricter than Python's `RECIPIENT_RE`**
 * (`^age1[0-9a-z]{20,110}\\Z`), which does match `age1pq1...`. Python is
 * still safe because the very next line hands the string to
 * `pyrage.x25519.Recipient.from_str`, which refuses anything but X25519.
 * The TypeScript equivalent does not: `age-encryption`'s `addRecipient`
 * *accepts* `age1pq1...` and would happily produce ciphertext the Python CLI
 * cannot open. Matching Python's effective behaviour therefore means
 * tightening the regex, not copying it.
 *
 * Unlike Python's `$`, JavaScript's `$` does not match before a final
 * newline, so `age1...\n` is rejected here without needing `\Z`. There is a
 * test pinning that, because it is the kind of thing a "harmless" regex
 * tidy-up silently reverses.
 */
export const RECIPIENT_RE = /^age1[02-9ac-hj-np-z]{20,110}$/;

/** Server cap on stored ciphertext (256 KiB). `blob_ref` (R2) is future work. */
export const MAX_CIPHERTEXT_BYTES = 262144;

const ARMOR_BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
const ARMOR_END = "-----END AGE ENCRYPTED FILE-----";

/** Minimal shape this module uses from `age-encryption`. */
interface AgeModule {
  generateX25519Identity(): Promise<string>;
  identityToRecipient(identity: string): Promise<string>;
  Encrypter: new () => {
    addRecipient(s: string): void;
    encrypt(file: Uint8Array): Promise<Uint8Array>;
  };
  Decrypter: new () => {
    addIdentity(s: string): void;
    decrypt(file: Uint8Array): Promise<Uint8Array>;
  };
}

let agePromise: Promise<AgeModule> | null = null;

/**
 * Make `globalThis.crypto` exist, for Node 18.
 *
 * WebCrypto only became a global in Node 19. `age-encryption` reaches
 * `@noble/*`, which reads `globalThis.crypto.getRandomValues` for the file
 * key and for keygen — so on Node 18 every encrypt and every
 * {@link generateKeypair} fails with "crypto.getRandomValues must be
 * defined", while decryption (which needs no randomness) works fine. CI
 * caught exactly that asymmetry.
 *
 * `package.json` says `engines.node >= 18`, so the fix belongs here rather
 * than in the engines field: `node:crypto` has exposed `webcrypto` since
 * Node 15, and installing it is precisely what Node 19+ does for you.
 *
 * Scoped as tightly as a global assignment can be: only when nothing is
 * there, only on the way into the crypto package, and `configurable` so a
 * host that wants its own implementation can still replace it.
 */
async function ensureWebCrypto(): Promise<void> {
  if (globalThis.crypto !== undefined) {
    return;
  }
  const { webcrypto } = await import("node:crypto");
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

/**
 * Load `age-encryption` on first use.
 *
 * @throws KaguraCryptoError if the optional peer dependency is not installed.
 */
async function loadAge(): Promise<AgeModule> {
  agePromise ??= (async () => {
    // Kept outside the try below so a WebCrypto problem is never reported as
    // "the package is not installed" — the two need different fixes.
    await ensureWebCrypto();
    try {
      return (await import("age-encryption")) as AgeModule;
    } catch (e) {
      throw new KaguraCryptoError(
        "The secret store needs the optional 'age-encryption' package, which " +
          "is not installed. The base SDK has zero runtime dependencies, so " +
          "the crypto package is opt-in.\n" +
          "  Install it with:  npm install age-encryption\n" +
          `  (original error: ${excMessage(e)})`,
        { cause: e },
      );
    }
  })().catch((e: unknown) => {
    // Never memoize a failure: a caller who installs the package mid-process,
    // or a host that supplies its own WebCrypto after the first attempt,
    // must get a real retry rather than the cached rejection.
    agePromise = null;
    throw e;
  });
  return agePromise;
}

/** Reset the memoized module handle. Test seam; not part of the public API. */
export function resetAgeCache(): void {
  agePromise = null;
}

/**
 * Generate a fresh X25519 age keypair.
 *
 * @returns `identity` — the `AGE-SECRET-KEY-1...` private key, to be placed
 *   in custody (see {@link KeyManager}) and never sent anywhere — and
 *   `recipient`, the public `age1...` string registered with the server.
 *
 * Python returns these as a `(identity, recipient)` tuple; the object form
 * here is the same two values, named, so the order cannot be swapped at a
 * call site.
 */
export async function generateKeypair(): Promise<{ identity: string; recipient: string }> {
  const age = await loadAge();
  const identity = await age.generateX25519Identity();
  return { identity, recipient: await age.identityToRecipient(identity) };
}

/**
 * Derive the public `age1` recipient from an `AGE-SECRET-KEY-1` identity.
 *
 * @throws KaguraCryptoError if `identity` is not a valid age identity.
 */
export async function recipientFromIdentity(identity: string): Promise<string> {
  const age = await loadAge();
  try {
    return await age.identityToRecipient(identity);
  } catch (e) {
    throw identityParseError(e);
  }
}

/**
 * The error for a malformed `AGE-SECRET-KEY-1` string — deliberately
 * carrying **nothing** from the underlying failure.
 *
 * `@scure/base`, under `age-encryption`, puts the whole offending string in
 * its bech32 messages:
 *
 *     Invalid checksum in AGE-SECRET-KEY-18L790E7K3SJJY...: expected "zshwqn"
 *
 * Interpolating that — or attaching it as `cause`, which Node prints when
 * an error is logged — writes the private key into logs, CI output, and
 * whatever error reporter is downstream. The cause chain is dropped for the
 * same reason; nothing about a malformed string is worth that.
 *
 * Note this is a TypeScript-only hazard: `pyrage` answers "invalid Bech32
 * encoding" and echoes nothing, so the Python port interpolates its error
 * safely. Verified against both implementations rather than assumed.
 */
function identityParseError(_cause: unknown): KaguraCryptoError {
  return new KaguraCryptoError(
    "invalid age identity: the identity string is not a well-formed " +
      "AGE-SECRET-KEY-1 value. The underlying parser error is withheld " +
      "because it echoes the input, which would write the private key to " +
      "logs.",
  );
}

/**
 * The server fingerprint: `sha256` hex of the recipient string.
 *
 * Mirrors Python's `hashlib.sha256(pubkey.encode("utf-8")).hexdigest()`
 * exactly, so a locally computed value can be compared against
 * `PubkeyResponse.fingerprint` byte for byte. Needs no crypto package —
 * `node:crypto` is enough.
 */
export function fingerprint(pubkey: string): string {
  return createHash("sha256").update(pubkey, "utf8").digest("hex");
}

/** Wrap a binary age file in RFC 7468 PEM armor (64-column base64). */
export function armorEncode(binary: Uint8Array): string {
  const b64 = Buffer.from(binary).toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  // An empty body would otherwise emit a blank line, which is not valid PEM.
  const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return `${ARMOR_BEGIN}\n${body}${ARMOR_END}\n`;
}

/**
 * Reverse {@link armorEncode}. Tolerant of CRLF and surrounding blanks.
 *
 * @throws KaguraCryptoError if the input is not a well-formed armored age file.
 */
export function armorDecode(armored: string): Uint8Array {
  const lines = armored
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (lines.length < 2 || lines[0] !== ARMOR_BEGIN || lines[lines.length - 1] !== ARMOR_END) {
    throw new KaguraCryptoError("not an armored age file (missing PEM header/footer)");
  }
  const body = lines.slice(1, -1).join("");
  // Buffer.from(..., "base64") silently discards non-base64 characters, so
  // validate first — Python passes validate=True for the same reason. A
  // corrupt body must be an error, not a shorter plaintext.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 !== 0) {
    throw new KaguraCryptoError("corrupt armored age body: invalid base64");
  }
  return new Uint8Array(Buffer.from(body, "base64"));
}

/**
 * Encrypt `plaintext` to one or more age recipients; return armored age.
 *
 * @throws KaguraCryptoError on empty or malformed recipients, an age
 *   failure, or an armored result over {@link MAX_CIPHERTEXT_BYTES}.
 */
export async function encrypt(plaintext: Uint8Array, recipients: string[]): Promise<string> {
  if (recipients.length === 0) {
    throw new KaguraCryptoError("at least one recipient is required to encrypt");
  }
  for (const r of recipients) {
    if (!RECIPIENT_RE.test(r)) {
      throw new KaguraCryptoError(`malformed age recipient: ${JSON.stringify(r)}`);
    }
  }

  const age = await loadAge();
  let binary: Uint8Array;
  try {
    const encrypter = new age.Encrypter();
    for (const r of recipients) {
      encrypter.addRecipient(r);
    }
    binary = await encrypter.encrypt(plaintext);
  } catch (e) {
    throw new KaguraCryptoError(`age encryption failed: ${excMessage(e)}`, { cause: e });
  }

  const armored = armorEncode(binary);
  // Armor is ASCII, so byte length and character count agree; measured in
  // bytes to match Python's `len(armored.encode("ascii"))`.
  const size = Buffer.byteLength(armored, "ascii");
  if (size > MAX_CIPHERTEXT_BYTES) {
    throw new KaguraCryptoError(
      `ciphertext is ${size} bytes, exceeds the ${MAX_CIPHERTEXT_BYTES}-byte cap`,
    );
  }
  return armored;
}

/**
 * Decrypt an armored age ciphertext with an `AGE-SECRET-KEY-1` identity.
 *
 * @throws KaguraCryptoError on input over the size cap, malformed armor, a
 *   bad identity, or a decrypt failure (wrong identity / corrupt ciphertext).
 */
export async function decrypt(armored: string, identity: string): Promise<Uint8Array> {
  // Inbound cap first, symmetric with encrypt, so an oversized blob is
  // rejected before armor parsing walks the whole string.
  //
  // Measured in bytes, not `armored.length`. Python writes `len(armored)`,
  // which counts code points, and for valid input the two agree exactly —
  // armor is ASCII — so this is identical in both SDKs for anything that
  // could actually decrypt. It differs only for input that is already
  // invalid, where a byte count is both truer to the message and stricter.
  const size = Buffer.byteLength(armored, "utf8");
  if (size > MAX_CIPHERTEXT_BYTES) {
    throw new KaguraCryptoError(
      `ciphertext is ${size} bytes, exceeds the ${MAX_CIPHERTEXT_BYTES}-byte cap`,
    );
  }
  const binary = armorDecode(armored);
  const age = await loadAge();

  // Split from the decrypt below so a bad identity string does not get
  // reported as "decryption failed" — `addIdentity` parses eagerly, and the
  // two causes need different fixes. Same split as Python's
  // `Identity.from_str` / `pyrage.decrypt` pair.
  const decrypter = new age.Decrypter();
  try {
    decrypter.addIdentity(identity);
  } catch (e) {
    // Message and cause both withheld — see identityParseError.
    throw identityParseError(e);
  }

  try {
    return await decrypter.decrypt(binary);
  } catch (e) {
    throw new KaguraCryptoError(`age decryption failed: ${excMessage(e)}`, { cause: e });
  }
}
