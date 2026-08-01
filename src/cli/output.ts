/**
 * Output helpers shared by every `kagura-memory` subcommand.
 *
 * The Python CLI prints results with
 * `click.echo(json.dumps(result, indent=2, ensure_ascii=False))`. The two
 * serializers were compared byte-for-byte on a payload covering Japanese
 * text, an em dash, an emoji, an astral-plane character, escapes, control
 * characters, nested empty containers, null and booleans: identical
 * output. Three numeric shapes differ and cannot be reconciled because
 * they are language-level, not formatting choices:
 *
 *   Python `1.0`                   → JS `1`      (no int/float distinction)
 *   Python `1e-07`                 → JS `1e-7`
 *   integers beyond 2^53           → JS loses precision
 *
 * The last one happens at `JSON.parse` time, so it is a property of the
 * whole SDK rather than of this module.
 */

/**
 * Serialize a value the way the Python CLI does.
 *
 * Total by construction: a command that cannot print its result is worse
 * than one that prints an approximation, so bigints, circular references
 * and `undefined` are handled rather than thrown on.
 */
export function formatJson(value: unknown): string {
  // JSON.stringify(undefined) returns the *value* `undefined`, so writing
  // its result would print the literal text "undefined" — not JSON, and
  // enough to break a consumer piping into jq. Python has no undefined;
  // `null` is the faithful counterpart.
  if (value === undefined) return "null";

  const seen = new WeakSet<object>();
  const replacer = (_key: string, v: unknown): unknown => {
    // JSON.stringify throws TypeError on a bigint. A server response can
    // only produce one if a caller passed it in, but a crash with a stack
    // trace is never the right answer to "print this".
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return v;
  };

  const text = JSON.stringify(value, replacer, 2);
  // Still possible: a value that is entirely unserializable (a bare
  // function or symbol) yields undefined from JSON.stringify.
  return text === undefined ? "null" : text;
}
