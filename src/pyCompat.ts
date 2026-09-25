/**
 * Python string semantics the SDK and the CLI both have to reproduce:
 * `str.strip()`, `repr()` of a `str`, and the `uuid.UUID` parse behind the
 * Python SDK's `normalize_uuid`.
 *
 * They live outside `cli/` because SDK methods raise Python's exact
 * messages too (`MemoryClient` refuses a non-UUID `context_id` with the
 * text the Python CLI prints), and the SDK must not import from the CLI.
 *
 * @internal Not part of the package's API.
 */

import { pyRepr } from "./python.js";

/**
 * The characters Python's `str.strip()` removes (`str.isspace()`).
 *
 * Not JavaScript's `trim()` set: Python also strips the `\x1c`-`\x1f`
 * separators and NEL (`\x85`), and keeps a BOM (`\ufeff`), which `trim()`
 * removes.
 */
export const PY_SPACE_CLASS =
  "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const PY_STRIP_RE = new RegExp(`^[${PY_SPACE_CLASS}]+|[${PY_SPACE_CLASS}]+$`, "g");

/** Python's `str.strip()` with no argument. */
export function pyStrip(value: string): string {
  return value.replace(PY_STRIP_RE, "");
}

/**
 * Python's `repr()`, shared with the CLI: one implementation, in
 * `python.ts`, so the SDK's and the CLI's messages cannot drift apart.
 */
export { pyRepr };

/**
 * `int(value, 16)` after `uuid.UUID` has cut the string to 32 characters:
 * surrounding whitespace, a `+` sign, a `0x` prefix and single underscores
 * between digits are all accepted, as Python's `int()` accepts them.
 * (Python also maps non-ASCII decimal digits, which this does not.)
 */
const PY_HEX_INT_RE = new RegExp(
  `^[${PY_SPACE_CLASS}]*\\+?(?:0[xX]_?)?([0-9a-fA-F](?:_?[0-9a-fA-F])*)[${PY_SPACE_CLASS}]*$`,
);

/**
 * The canonical form of `value` under Python's `uuid.UUID(value)`, or
 * `null` where that raises.
 *
 * Step for step what CPython does: drop every `urn:` then every `uuid:`,
 * strip braces from both ends, drop every `-`, require exactly 32
 * characters, parse the rest as hex. So `{UUID}`, `urn:uuid:UUID` and the
 * dashless form pass, and a UUID padded with whitespace does not: unlike
 * the SDK's `parseUuid`, nothing is trimmed first.
 */
function pythonUuid(value: string): string | null {
  let hex = value.split("urn:").join("").split("uuid:").join("");
  hex = hex.replace(/^[{}]+|[{}]+$/g, "").split("-").join("");
  // Python's len() counts code points, not UTF-16 units.
  if ([...hex].length !== 32) return null;
  const match = PY_HEX_INT_RE.exec(hex);
  if (match === null) return null;
  const digits = match[1]!.replace(/_/g, "").toLowerCase().padStart(32, "0");
  return (
    `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-` +
    `${digits.slice(16, 20)}-${digits.slice(20)}`
  );
}

/**
 * Return the canonical UUID string, rejecting a non-UUID before it reaches
 * a request — port of the Python SDK's `normalize_uuid`.
 *
 * Normalizing rather than only validating matters: the server would take
 * a `{braced}` or dashless spelling as a different, unknown id and answer
 * with its uniform 404.
 *
 * @param label The parameter name the message uses, e.g. `"context_id"`.
 * @throws Error `<label> must be a UUID, got <repr>`, Python's exact text.
 */
export function normalizeUuid(value: unknown, label: string): string {
  const canonical = typeof value === "string" ? pythonUuid(value) : null;
  if (canonical === null) {
    const shown = typeof value === "string" ? pyRepr(value) : String(value);
    throw new Error(`${label} must be a UUID, got ${shown}`);
  }
  return canonical;
}
