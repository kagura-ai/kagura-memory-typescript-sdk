/**
 * Value parsing shared by the data subcommands — the port of `_parse_tags`,
 * `_parse_details`, `_parse_location` and `_build_details` in the Python
 * CLI's `cli.py`, plus the numeric coercion click performs for
 * `type=int` / `type=float` options.
 *
 * Every message here is quoted from the Python CLI so an operator moving
 * between the two tools reads the same guidance.
 */

import { PY_FLOAT, type FlagSpec } from "./parseArgs.js";

/**
 * A usage error: bad input, detected before anything is sent.
 *
 * Click exits **2** for these (`UsageError`) and **1** for a runtime
 * failure (`ClickException`); the distinction is worth keeping because a
 * script can tell "I invoked it wrong" from "the call failed".
 */
export class CliUsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** A runtime failure surfaced with click's `ClickException` exit code. */
export class CliError extends Error {
  readonly exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/** `'--importance' / '-i'`, the way click names an option in its errors. */
export function flagLabel(flag: FlagSpec): string {
  return flag.short === undefined ? `'--${flag.name}'` : `'--${flag.name}' / '-${flag.short}'`;
}

/**
 * Split a comma-separated option into a list.
 *
 * Port of `_parse_tags`: strip each item, drop empties, and collapse an
 * all-empty result back to "unset" so the key is omitted from the payload
 * rather than sent as `[]`. A shell expansion of an empty variable is
 * therefore not an error and not a destructive "clear this field".
 */
export function parseTags(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parsed = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * Python's `int()` grammar. The float counterpart lives in `parseArgs.ts`
 * because the parser needs it to tell `-0.1` (a value) from `-x` (a flag).
 *
 * `Number()` is not a substitute for either: it accepts `0x10`, `0b11` and
 * `""`, all of which Python rejects, so the CLI would silently accept
 * input the Python CLI refuses.
 */
const PY_INT = /^[+-]?\d+$/;

/** Coerce a `type=float` option, or raise click's message for it. */
export function parseFloatOption(flag: FlagSpec, raw: string): number {
  const text = raw.trim();
  if (!PY_FLOAT.test(text)) {
    throw new CliUsageError(
      `Invalid value for ${flagLabel(flag)}: ${quote(raw)} is not a valid float.`,
    );
  }
  return Number(text.replace(/^([+-]?)inf(inity)?$/i, "$1Infinity"));
}

/** Coerce a `type=int` option, or raise click's message for it. */
export function parseIntOption(flag: FlagSpec, raw: string): number {
  const text = raw.trim();
  if (!PY_INT.test(text)) {
    throw new CliUsageError(
      `Invalid value for ${flagLabel(flag)}: ${quote(raw)} is not a valid integer.`,
    );
  }
  return Number(text);
}

/**
 * Coerce a `click.IntRange` / `click.FloatRange` option.
 *
 * `rangeLabel` is passed rather than derived because click renders the
 * bounds as the Python literals they were declared with: `0.0<=x<=1.0`,
 * where JS would produce `0<=x<=1`.
 */
export function parseRanged(
  flag: FlagSpec,
  raw: string,
  options: { min: number; max: number; rangeLabel: string; integer?: boolean },
): number {
  const integer = options.integer === true;
  let value: number;
  try {
    value = integer ? parseIntOption(flag, raw) : parseFloatOption(flag, raw);
  } catch {
    // A ranged option reports "not a valid float range", not "not a valid
    // float" — click names the *type* it declared, which is the Range.
    throw new CliUsageError(
      `Invalid value for ${flagLabel(flag)}: ${quote(raw)} is not a valid ${integer ? "integer" : "float"} range.`,
    );
  }
  if (!(value >= options.min && value <= options.max)) {
    throw new CliUsageError(
      `Invalid value for ${flagLabel(flag)}: ${raw.trim()} is not in the range ${options.rangeLabel}.`,
    );
  }
  return value;
}

/** Coerce a `click.Choice` option, matching case-insensitively. */
export function parseChoice<T extends string>(
  flag: FlagSpec,
  raw: string,
  choices: readonly T[],
): T {
  const match = choices.find((c) => c === raw.toLowerCase());
  if (match === undefined) {
    throw new CliUsageError(
      `Invalid value for ${flagLabel(flag)}: ${quote(raw)} is not one of ${choices.map(quote).join(", ")}.`,
    );
  }
  return match;
}

/**
 * Resolve a `--flag / --no-flag` pair into a tri-state.
 *
 * Click models these as one option with `default=None`, so "neither given"
 * has to stay distinguishable from `false` — the key is omitted entirely
 * and the stored value is left alone.
 */
export function pairedFlag(
  present: boolean,
  absent: boolean,
  labels: [string, string],
): boolean | undefined {
  if (present && absent) {
    throw new CliUsageError(`${labels[0]} and ${labels[1]} are mutually exclusive; pick one.`);
  }
  if (present) return true;
  if (absent) return false;
  return undefined;
}

/**
 * Python's `repr()` of a string, which click interpolates into errors.
 *
 * Escapes matter: a value containing a newline would otherwise split the
 * error across lines, and a Windows path would lose its backslashes.
 * Pinned against the real `repr()` output in the tests.
 *
 *   'a\n b'          -> 'a\\n b'          (control characters escaped)
 *   'C:\\Users'      -> 'C:\\\\Users'     (backslash doubled)
 *   "it's"           -> "it's"            (double-quoted to avoid escaping)
 *   "both ' and \""  -> 'both \\' and "'  (single-quoted, apostrophe escaped)
 */
export function quote(value: string): string {
  // Python prefers single quotes, switching to double only when the value
  // contains an apostrophe and no double quote.
  const double = value.includes("'") && !value.includes('"');
  const quoteChar = double ? '"' : "'";

  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quoteChar) out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `${quoteChar}${out}${quoteChar}`;
}

/**
 * Parse `--details`, a JSON *object*.
 *
 * Port of `_parse_details`. Blank means unset rather than a usage error,
 * so `--details "$MAYBE_EMPTY"` behaves.
 */
export function parseDetails(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CliUsageError(
      `Invalid JSON for --details: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError(
      `--details must be a JSON object, got ${jsonTypeName(parsed)}. ` +
        `Example: --details '{"location": {"lat": 35.68, "lon": 139.76}}'`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** The Python type name click reports for a non-object `--details`. */
function jsonTypeName(value: unknown): string {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  switch (typeof value) {
    case "string":
      return "str";
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(value) ? "int" : "float";
    default:
      return typeof value;
  }
}

export interface LocationPayload {
  lat: number;
  lon: number;
  label?: string;
}

/**
 * Reject coordinates the server would reject anyway.
 *
 * The comparison is written as a range containment rather than
 * `value < -limit || value > limit` because the latter evaluates false for
 * NaN and would let it through.
 */
function validateLatLon(lat: number, lon: number): void {
  for (const [label, value, limit] of [
    ["lat", lat, 90],
    ["lon", lon, 180],
  ] as const) {
    if (!(value >= -limit && value <= limit)) {
      throw new CliUsageError(`--location ${label} must be between -${limit} and ${limit}, got ${value}`);
    }
  }
}

/**
 * Parse `--location`: `lat,lon` or `lat,lon,label`.
 *
 * Port of `_parse_location`.
 */
export function parseLocation(raw: string | undefined): LocationPayload | undefined {
  if (raw === undefined || !raw.trim()) return undefined;
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 2 && parts.length !== 3) {
    throw new CliUsageError(
      `--location must be 'lat,lon' or 'lat,lon,label', got ${quote(raw)}`,
    );
  }
  const [rawLat, rawLon] = parts as [string, string];
  if (!PY_FLOAT.test(rawLat) || !PY_FLOAT.test(rawLon)) {
    throw new CliUsageError(
      `--location lat/lon must be numbers, got ${quote(rawLat)},${quote(rawLon)}`,
    );
  }
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  validateLatLon(lat, lon);

  const payload: LocationPayload = { lat, lon };
  if (parts.length === 3 && parts[2]) payload.label = parts[2];
  return payload;
}

/**
 * Combine `--details` and `--location` into one payload.
 *
 * Port of `_build_details`. Supplying both a `location` key inside
 * `--details` and a `--location` is rejected rather than silently
 * resolved, so neither value is quietly dropped.
 */
export function buildDetails(
  details: string | undefined,
  location: string | undefined,
): Record<string, unknown> | undefined {
  const parsed = parseDetails(details);
  const loc = parseLocation(location);
  if (loc === undefined) return parsed;
  if (parsed && "location" in parsed) {
    throw new CliUsageError(
      "--location conflicts with the 'location' key in --details. Use one or the other.",
    );
  }
  return { ...(parsed ?? {}), location: loc };
}
