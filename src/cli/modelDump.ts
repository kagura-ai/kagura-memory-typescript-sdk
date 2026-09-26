/**
 * Printing a REST result the way the Python CLI prints a pydantic model:
 * `result.model_dump_json(indent=2)` (#66).
 *
 * The payload is first read through the Python model (`pyModels.ts`), so
 * what prints is the model's keys in its order, defaults filled and
 * unknown keys dropped; {@link formatModelJson} then writes it as
 * pydantic's JSON does, a float field as a float (`1.0`).
 *
 * Inside an untyped mapping (an event's `payload`, a batch's `errors`) a
 * body read by `parseJsonLossless` prints as Python read it (#69): its
 * keys in the order the server wrote them, an int literal exactly and a
 * float literal as a float (`1e16` as `1e+16`, `-0.0` as `-0.0`).
 * {@link formatDumpsJson} writes the same values as Python's `json.dumps`
 * does, for the one result the Python CLI prints that way from a model's
 * values, `resource import`'s summary.
 */

import { JsonNumber, orderedEntries, valueAt } from "../losslessJson.js";
import { PyFloat, UNTYPED } from "../pyModels.js";
import { pyFloatRepr } from "../python.js";
import { CliError } from "./parse.js";

/**
 * The most non-empty containers pydantic nests in an untyped value, the
 * value itself the first; one more fails the dump with {@link DEPTH_EXCEEDED}.
 * Measured on pydantic 2.13.4: typed levels and empty containers do not count.
 */
const MAX_UNTYPED_DEPTH = 255;
const DEPTH_EXCEEDED = "Error serializing to JSON: ValueError: Circular reference detected (depth exceeded)";

/** What differs between pydantic's JSON and `json.dumps`'s. */
interface Style {
  /** A float's text. */
  float(value: number): string;
  /** Whether an untyped value nested past {@link MAX_UNTYPED_DEPTH} fails, as pydantic's serializer does. */
  limitDepth: boolean;
}

/**
 * A float as pydantic's JSON writes it: the shortest digits that round-trip
 * (the digits JavaScript picks), in fixed notation from 1e-5 up to 1e16
 * with `.0` on a whole number, else as `1e-6` / `1e+16` (no padding). NaN
 * and the infinities are `null`, pydantic's default.
 *
 *   1 -> 1.0    0.00001 -> 0.00001    0.000001 -> 1e-6    1e16 -> 1e+16
 */
export function pydanticFloat(value: number): string {
  if (!Number.isFinite(value)) return "null";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  // With no argument, toExponential gives the shortest round-trip digits.
  const [mantissa, exp] = value.toExponential().split("e") as [string, string];
  const exponent = Number(exp);
  if (exponent < -5 || exponent >= 16) {
    return `${mantissa}e${exponent < 0 ? "-" : "+"}${Math.abs(exponent)}`;
  }
  // String() writes fixed notation over all of 1e-7..1e21.
  const fixed = String(value);
  return fixed.includes(".") ? fixed : `${fixed}.0`;
}

/**
 * A float as Python's `json.dumps` writes it: its `repr` (`1e-07`,
 * `1e+16`, `1.0`), and `NaN`, `Infinity` and `-Infinity` for the others
 * (`allow_nan=True`, the default).
 *
 *   1 -> 1.0    1e-7 -> 1e-07    1e16 -> 1e+16    NaN -> NaN
 */
export function dumpsFloat(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return pyFloatRepr(value);
}

const PYDANTIC: Style = { float: pydanticFloat, limitDepth: true };
const JSON_DUMPS: Style = { float: dumpsFloat, limitDepth: false };

/** A JSON number of an untyped value, its literal unknown: an integer as its digits, else a float. */
function anyNumber(value: number, style: Style): string {
  if (!Number.isFinite(value)) return style.float(value);
  // BigInt, not String: String(1e21) is "1e+21", Python's int is not.
  return Number.isInteger(value) ? BigInt(value).toString() : style.float(value);
}

/** A number literal as Python read it: an int literal's exact digits (`-0` is `0`), else a float. */
function literal(value: JsonNumber, style: Style): string {
  return value.isInt ? value.bigint().toString() : style.float(value.value);
}

/**
 * `value` as `model_dump_json(indent=2)` writes it: two-space indentation,
 * `": "` after a key, `[]` and `{}` for empty containers, and strings as
 * `JSON.stringify` escapes them, which is what pydantic escapes (the
 * control characters, `"` and `\`; nothing past ASCII). A {@link PyFloat}
 * prints as a float, a `bigint` as its digits, and a mapping read from a
 * body in its keys' order with its number literals (see the header).
 *
 * @throws CliError with pydantic's message when an untyped value nests
 *   deeper than pydantic writes (see {@link MAX_UNTYPED_DEPTH}).
 */
export function formatModelJson(value: unknown): string {
  return write(value, "", null, PYDANTIC);
}

/**
 * `value` as `json.dumps(value, indent=2, ensure_ascii=False)` writes it:
 * {@link formatModelJson}'s layout and strings, a float as Python's
 * `repr` (`1e-07`, `NaN`), and no depth limit of its own.
 */
export function formatDumpsJson(value: unknown): string {
  return write(value, "", null, JSON_DUMPS);
}

/** One level further into an untyped value, or `null` outside one. */
function enter(depth: number | null): number | null {
  if (depth === null) return null;
  if (depth >= MAX_UNTYPED_DEPTH) throw new CliError(DEPTH_EXCEEDED);
  return depth + 1;
}

/** `depth`: the non-empty containers entered inside an untyped value, or `null` outside one. */
function write(value: unknown, indent: string, depth: number | null, style: Style): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof PyFloat) return style.float(value.value);
  if (value instanceof JsonNumber) return literal(value, style);
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return value.toString();
    case "number":
      return anyNumber(value, style);
    case "object":
      break;
    default:
      return "null";
  }
  const inner = `${indent}  `;
  const outer = style.limitDepth && depth === null && UNTYPED.has(value) ? 0 : depth;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const next = enter(outer);
    const items = value.map((_item, index) => inner + write(valueAt(value, index), inner, next, style));
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  const entries = orderedEntries(value);
  if (entries.length === 0) return "{}";
  const next = enter(outer);
  const lines = entries.map(
    ([key]) => `${inner}${JSON.stringify(key)}: ${write(valueAt(value, key), inner, next, style)}`,
  );
  return `{\n${lines.join(",\n")}\n${indent}}`;
}
