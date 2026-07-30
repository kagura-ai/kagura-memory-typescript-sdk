/**
 * Cross-implementation age test vectors (#28).
 *
 * `PYRAGE_*` was produced by the **Python SDK** — `pyrage` (the Rust `age`
 * binding) plus `kagura_memory.secrets.crypto.armor_encode` — and is checked
 * in so the TypeScript side proves it can read what the Python CLI writes.
 * Both SDKs read and write the same server, so a typage upgrade that broke
 * that would otherwise surface as a user's secret failing to decrypt.
 *
 * The pyrage ciphertext carries a `-> i'G>L+U-grease` stanza, which the age
 * spec allows an implementation to emit and requires readers to ignore.
 * Keeping this exact blob is the only way to keep testing that.
 *
 * ---------------------------------------------------------------------------
 * The private key below is a THROWAWAY generated for this test file. It
 * guards nothing, has never been registered with any server, and is not
 * reachable from any credential store. It is here because a decryption test
 * vector is not a test vector without the key that opens it.
 * ---------------------------------------------------------------------------
 */

/** Throwaway X25519 identity. See the banner above — this secures nothing. */
export const TEST_IDENTITY =
  "AGE-SECRET-KEY-18L790E7K3SJJY6LE7NM8NHY8UEQR07CJJK7RAFQUT4TUFVV36KPQ6AYQAX";

/** The public recipient derived from {@link TEST_IDENTITY}. */
export const TEST_RECIPIENT = "age1smg2cclzrpqfytprzm62kducs25cm7qca309twlfwv9jqkpglu3s7k0z9n";

/**
 * `sha256_hex(TEST_RECIPIENT)` as **the Python SDK computed it**. Pinned so
 * the two SDKs cannot drift on what a fingerprint is — the server compares
 * these, and `putSecretForRecipients` refuses to encrypt on a mismatch.
 */
export const TEST_FINGERPRINT = "faf8a5dbb0948a46ce0121d9ffc6f415769b17845ee90dabfd914b384f50a76d";

/** Armored age file written by pyrage, encrypted to {@link TEST_RECIPIENT}. */
export const PYRAGE_ARMORED = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSA2R2t4UWJCcEZXSmFXVW05
SmNFWUZtWXk0Nk1uMmtRbytNeVN5anY5V1YwCkp3ZFo4VTZna2dNQWxJOFExaGRF
eTczMFlQdm5IWFJxT256ekJ0ZkFleEkKLT4gaSdHPkwrVS1ncmVhc2UgLSs7bH5P
WzgKckEvdzc0M1ZYZlRscHl3ZnhNOUU1aUN3UHVQQ1RaZEJpWlBOTkVJZ21ZWHhL
ckRLYkpDdGY2VkE5WjhBYzgvdApJcG9nMnRmRktUK0NmZ3BKZFZobnhSYm9DTXlO
Ci0tLSBZY053RVZ4bnJta1JSWktvSmk5SnJiNVdXT1lNV01Mc0orZUsrclljdmRV
CvRB9i7xZ4G2Yz45VK7+a8kECRMnFq+KT6NmgDKG+bay89SY2QqNoUBDvfEQtnJ6
5Pkr
-----END AGE ENCRYPTED FILE-----
`;

/** The plaintext inside {@link PYRAGE_ARMORED}. */
export const PYRAGE_PLAINTEXT = "s3cret-from-pyrage";

/**
 * A binary age file, and the armor **the Python SDK produced for it**
 * byte for byte. Pins the transport encoding (64-column base64, PEM
 * framing, trailing newline) independently of any crypto.
 */
export const RAW_AGE_FILE_B64 =
  "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBGdW1ubXBrcnluQVdxanordWhIK013c1hrTW5KeXlKMXpVNjZFbWY0NUZjCk1CZWNkT2x0bC9pR0tLMTBUVDRYZjZkTktjb2N6ZEVKM0pHRnpYdDZVc28KLS0tIGlEYjB3NzVFRjlxYURQVVZrU2lzNkZ3UnpuNDA0QVN1Y09pdHFheEdoakUKFY/MMmmDooNnMp74MOU/kXdmNSzF0CUhyIXzi5b5LtWP1wtOv530ytXqs2XI2qFfk+I=";

export const PYTHON_ARMOR_OF_RAW = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBGdW1ubXBrcnluQVdxanor
dWhIK013c1hrTW5KeXlKMXpVNjZFbWY0NUZjCk1CZWNkT2x0bC9pR0tLMTBUVDRY
ZjZkTktjb2N6ZEVKM0pHRnpYdDZVc28KLS0tIGlEYjB3NzVFRjlxYURQVVZrU2lz
NkZ3UnpuNDA0QVN1Y09pdHFheEdoakUKFY/MMmmDooNnMp74MOU/kXdmNSzF0CUh
yIXzi5b5LtWP1wtOv530ytXqs2XI2qFfk+I=
-----END AGE ENCRYPTED FILE-----
`;
