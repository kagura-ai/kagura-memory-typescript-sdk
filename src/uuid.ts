/**
 * Internal UUID parsing/validation — the analogue of Python's `uuid.UUID`.
 *
 * Not part of the public API surface; used by FilesClient (validate-only).
 */

const CANONICAL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a UUID in any of the spellings Python's `uuid.UUID` tolerates
 * (canonical, `{braces}`, `urn:uuid:` prefix, dashless 32-hex) and return
 * the canonical lowercase 8-4-4-4-12 form.
 *
 * @throws Error if the input is not a UUID.
 */
export function parseUuid(value: string): string {
  if (typeof value !== "string") {
    throw new Error(`expected a UUID string, got ${typeof value}`);
  }
  let hex = value.trim().toLowerCase();
  if (hex.startsWith("urn:uuid:")) {
    hex = hex.slice("urn:uuid:".length);
  }
  if (hex.startsWith("{") && hex.endsWith("}")) {
    hex = hex.slice(1, -1);
  }
  hex = hex.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`invalid UUID: ${value}`);
  }
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/** True when `value` is any parseable UUID spelling. */
export function isUuid(value: string): boolean {
  if (CANONICAL_RE.test(value)) {
    return true;
  }
  try {
    parseUuid(value);
    return true;
  } catch {
    return false;
  }
}
