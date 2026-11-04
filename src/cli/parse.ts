/**
 * Value parsing shared by the data subcommands — the port of `_parse_tags`,
 * `_parse_details`, `_parse_location` and `_build_details` in the Python
 * CLI's `cli.py`, plus the conversions click performs for `type=int`,
 * `type=float`, `click.IntRange` / `click.FloatRange` and `click.Choice`.
 *
 * Every message here is quoted from the Python CLI, or from click 8.3.3,
 * the version its lockfile pins, so an operator moving between the two
 * tools reads the same guidance.
 */

import { JsonDecodeError, parseJsonLossless } from "../losslessJson.js";
import { pyStrip } from "../pyCompat.js";
import { PY_INT, pyBigInt, pyFloat, pyFloatRepr, pyInt, pyRepr, pyTypeName } from "../python.js";
import type { FlagSpec, ParsedArgs } from "./parseArgs.js";

export { PY_INT, pyFloatRepr, pyRepr };

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

/**
 * A click parameter, as its errors name it: an option by its spec, or an
 * argument by its metavar (`"VALUE"`, `"TOKEN_ID"`).
 */
export type Param = FlagSpec | string;

/**
 * `'--importance' / '-i'`, the way click names an option in its errors;
 * `'-k'` for a short-only one, which has no long form to name.
 */
export function flagLabel(flag: FlagSpec): string {
  if (flag.short !== undefined && flag.shortOnly === true) return `'-${flag.short}'`;
  return flag.short === undefined ? `'--${flag.name}'` : `'--${flag.name}' / '-${flag.short}'`;
}

/** {@link flagLabel} for an option, `'VALUE'` for an argument. */
export function paramLabel(param: Param): string {
  return typeof param === "string" ? `'${param}'` : flagLabel(param);
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
 * Coerce a `type=float` option or argument, or raise click's message for it.
 *
 * Python's `float()` grammar (`PY_FLOAT`), not `Number()`, which accepts
 * `0x10` and `""`; underscores between digits are accepted, as Python
 * accepts them.
 */
export function parseFloatOption(param: Param, raw: string): number {
  const value = pyFloat(raw);
  if (value === undefined) {
    throw new CliUsageError(`Invalid value for ${paramLabel(param)}: ${pyRepr(raw)} is not a valid float.`);
  }
  return value;
}

/** Click's error for a value `int()` refuses. */
function notAnInteger(param: Param, raw: string): CliUsageError {
  return new CliUsageError(`Invalid value for ${paramLabel(param)}: ${pyRepr(raw)} is not a valid integer.`);
}

/** Coerce a `type=int` option or argument, or raise click's message for it. */
export function parseIntOption(param: Param, raw: string): number {
  const value = pyInt(raw);
  if (value === undefined) throw notAnInteger(param, raw);
  return value;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** An opaque public id (memory-cloud v0.89.0+): `akey_…`, `rtok_…`, `winv_…`, `skey_…`. */
const STRING_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Coerce a public id argument (`TOKEN_ID`, `INVITATION_ID`, `KEY_ID`).
 *
 * An integer (the servers before memory-cloud v0.89.0) is read exactly, as
 * Python's `int` holds it: a `number` while it is safe, else a `bigint`. A
 * `number` would round `9007199254740993` to a neighbouring id, and the
 * request would revoke or update that one.
 *
 * Anything else is an opaque string id (v0.89.0+, memory-cloud#1008), kept
 * as typed when it starts with a letter and holds only letters, digits,
 * `_` and `-`. The rest (`7.0`, `0x10`, `a/b`, an empty value) is refused
 * in click's words, before anything is read, asked or sent: an integer
 * mistyped is not sent on as a string.
 */
export function parseIdArg(param: Param, raw: string): number | bigint | string {
  const value = pyBigInt(raw);
  if (value !== undefined) return value >= -MAX_SAFE && value <= MAX_SAFE ? Number(value) : value;
  if (STRING_ID.test(raw)) return raw;
  throw new CliUsageError(`Invalid value for ${paramLabel(param)}: ${pyRepr(raw)} is not a valid integer or id.`);
}

/**
 * A string id the command puts in a REST path (`USER_ID`, `FILE_ID`,
 * `--resource-id`), refused as click refuses a bad value (exit 2) when it
 * is `.`, `..` or empty, before anything is read, asked or sent (#66).
 * Percent-encoding leaves all three as they are, and URL resolution then
 * drops or climbs the segment: `files download-url ..` would GET
 * `/api/v1/download-url`. The Python CLI sends them (a PYBUG); the SDK
 * refuses them too (`pathSegment`), and this words it as click would.
 *
 * @param what The id's kind in the message, e.g. `file id`.
 */
export function pathIdParam(param: Param, value: string, what: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new CliUsageError(`Invalid value for ${paramLabel(param)}: ${pyRepr(value)} is not a valid ${what}.`);
  }
  return value;
}

/**
 * Coerce a `click.IntRange` / `click.FloatRange` option.
 *
 * `rangeLabel` is passed rather than derived because click renders the
 * bounds as the Python literals they were declared with: `0.0<=x<=1.0`,
 * where JS would produce `0<=x<=1`.
 *
 * An out-of-range value is printed as click prints it, converted: the
 * int for an IntRange (`+4000` and `04000` both read `4000`), the Python
 * float repr for a FloatRange (`2` reads `2.0`, `1e1` reads `10.0`).
 * NaN is refused as click's `FloatRange` refuses it: `nan is not in the
 * range 0.0<=x<=1.0.` (its comparisons are all false for NaN, and click's
 * range check is written so that this counts as outside the range).
 */
export function parseRanged(
  param: Param,
  raw: string,
  options: { min: number; max: number; rangeLabel: string; integer?: boolean },
): number {
  const integer = options.integer === true;
  const value = integer ? pyInt(raw) : pyFloat(raw);
  if (value === undefined) {
    // A ranged option reports "not a valid float range", not "not a valid
    // float" — click names the *type* it declared, which is the Range.
    throw new CliUsageError(
      `Invalid value for ${paramLabel(param)}: ${pyRepr(raw)} is not a valid ${integer ? "integer" : "float"} range.`,
    );
  }
  if (!(value >= options.min && value <= options.max)) {
    // The exact int, so a value past 2^53 prints the digits it was given
    // rather than a rounded Number.
    const shown = integer ? String(pyBigInt(raw)) : pyFloatRepr(value);
    throw new CliUsageError(
      `Invalid value for ${paramLabel(param)}: ${shown} is not in the range ${options.rangeLabel}.`,
    );
  }
  return value;
}

/**
 * An optional `click.IntRange` / `click.FloatRange` option: `undefined`
 * when the flag was not given, else {@link parseRanged}'s value (or its
 * usage error).
 */
export function optionalRanged(
  args: ParsedArgs,
  flag: FlagSpec,
  options: { min: number; max: number; rangeLabel: string; integer?: boolean },
): number | undefined {
  const raw = args.values[flag.name];
  return raw === undefined ? undefined : parseRanged(flag, raw, options);
}

export interface ChoiceOptions {
  /**
   * Match as `click.Choice(..., case_sensitive=False)` does: casefolded on
   * both sides, returning the declared spelling. Off by default, as it is
   * in click — set it only where the Python declaration says so.
   */
  caseInsensitive?: boolean;
}

/**
 * The characters `str.casefold()` folds into ASCII that `toLowerCase()`
 * leaves alone. The choices are ASCII, so these are the only differences
 * that can decide a match: click takes `JſON` for `json`.
 */
const ASCII_FOLDS: Record<string, string> = {
  "\u00df": "ss",
  "\u017f": "s",
  "\ufb00": "ff",
  "\ufb01": "fi",
  "\ufb02": "fl",
  "\ufb03": "ffi",
  "\ufb04": "ffl",
  "\ufb05": "st",
  "\ufb06": "st",
};

function casefold(value: string): string {
  // The capital sharp s (U+1E9E) lowercases to U+00DF, which the map folds.
  return value.toLowerCase().replace(/[\u00df\u017f\ufb00-\ufb06]/g, (c) => ASCII_FOLDS[c] ?? c);
}

/** The choices as click lists them: casefolded when matching ignores case. */
function shownChoices(choices: readonly string[], options: ChoiceOptions): string[] {
  return options.caseInsensitive === true ? choices.map(casefold) : [...choices];
}

/**
 * Coerce a `click.Choice` option or argument, or raise click's message:
 * `'x' is not one of 'a', 'b'.`, or `'x' is not 'a'.` for a single choice.
 */
export function parseChoice<T extends string>(
  param: Param,
  raw: string,
  choices: readonly T[],
  options: ChoiceOptions = {},
): T {
  const fold = options.caseInsensitive === true ? casefold : (s: string) => s;
  const wanted = fold(raw);
  const match = choices.find((c) => fold(c) === wanted);
  if (match === undefined) {
    const listed = shownChoices(choices, options).map(pyRepr).join(", ");
    const verdict = choices.length === 1 ? `is not ${listed}` : `is not one of ${listed}`;
    throw new CliUsageError(`Invalid value for ${paramLabel(param)}: ${pyRepr(raw)} ${verdict}.`);
  }
  return match;
}

/**
 * Click's error for a required option or argument that was not given:
 * `Missing option '--user' / '-u'.`, and for a Choice the choices, one per
 * line after a tab, comma-separated and with no final period:
 * `Missing option '--role'. Choose from:\n\tmember,\n\tadmin,\n\tviewer`.
 */
export function missingParam(
  param: Param,
  choices?: readonly string[],
  options: ChoiceOptions = {},
): CliUsageError {
  const kind = typeof param === "string" ? "argument" : "option";
  const extra = choices === undefined ? "" : ` Choose from:\n\t${shownChoices(choices, options).join(",\n\t")}`;
  return new CliUsageError(`Missing ${kind} ${paramLabel(param)}.${extra}`);
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
 * The name the CLI has always used for {@link pyRepr}; kept so its
 * callers read as before.
 */
export function quote(value: string): string {
  return pyRepr(value);
}

/** The value `--details`'s error shows (the Python CLI's `_DETAILS_EXAMPLE`). */
const DETAILS_EXAMPLE = `'{"location": {"lat": 35.68, "lon": 139.76}}'`;

/**
 * Parse a JSON *object* option — `--details` by default, `list --filters`
 * too — or `undefined` when it is blank.
 *
 * Port of the Python CLI's `_parse_json_object`, its one parser for every
 * JSON-object flag. Blank means unset rather than a usage error, so
 * `--details "$MAYBE_EMPTY"` behaves. The text is read as `json.loads`
 * reads it ({@link parseJsonLossless}), so a malformed value is refused in
 * its words (`Expecting value: line 1 column 7 (char 6)`). `NaN` and the
 * infinities are JSON to `json.loads`; Python refuses them only when the
 * request is encoded, as {@link refuseNonFinite} does.
 *
 * @param flag The flag named in the error.
 * @param example A valid value, shown after `flag` in the error.
 * @throws CliUsageError (exit 2) if the text is not JSON, or is JSON but
 *   not an object.
 */
export function parseJsonObject(
  raw: string | undefined,
  flag = "--details",
  example = DETAILS_EXAMPLE,
): Record<string, unknown> | undefined {
  if (raw === undefined || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = parseJsonLossless(raw);
  } catch (e) {
    if (!(e instanceof JsonDecodeError)) throw e;
    throw new CliUsageError(`Invalid JSON for ${flag}: ${e.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError(`${flag} must be a JSON object, got ${pyTypeName(parsed)}. Example: ${flag} ${example}`);
  }
  return parsed as Record<string, unknown>;
}

/** The first NaN or ±Infinity in `value`, in the order a request body lists it. */
function firstNonFinite(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? undefined : value;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const items = Array.isArray(value) ? value : Object.keys(record).map((k) => record[k]);
  for (const item of items) {
    const found = firstNonFinite(item);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Refuse payloads that hold a NaN or ±Infinity — which `json.loads` reads,
 * `1e400` included — as the Python CLI's httpx refuses to encode them
 * (`allow_nan=False`), rather than send them as the `null` `JSON.stringify`
 * would make of them. The message is CPython 3.12's and later's; 3.11
 * leaves the value off. An integer too long for a double (over 300
 * digits), which Python would send, is refused the same way: as a JS
 * number it is Infinity too.
 *
 * @throws CliError (exit 1).
 */
export function refuseNonFinite(payloads: readonly unknown[]): void {
  const found = firstNonFinite(payloads);
  if (found !== undefined) {
    throw new CliError(`Out of range float values are not JSON compliant: ${pyFloatRepr(found)}`);
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
 * NaN and would let it through. The value is printed as Python prints the
 * float it parsed: `91.0`, `nan`, `inf`.
 */
function validateLatLon(lat: number, lon: number): void {
  for (const [label, value, limit] of [
    ["lat", lat, 90],
    ["lon", lon, 180],
  ] as const) {
    if (!(value >= -limit && value <= limit)) {
      throw new CliUsageError(
        `--location ${label} must be between -${limit} and ${limit}, got ${pyFloatRepr(value)}`,
      );
    }
  }
}

/**
 * Parse `--location`: `lat,lon` or `lat,lon,label`.
 *
 * Port of `_parse_location`.
 */
export function parseLocation(raw: string | undefined): LocationPayload | undefined {
  // Python's strip(), not trim(): a BOM is kept, and float() refuses it.
  if (raw === undefined || !pyStrip(raw)) return undefined;
  const parts = raw.split(",").map((p) => pyStrip(p));
  if (parts.length !== 2 && parts.length !== 3) {
    throw new CliUsageError(
      `--location must be 'lat,lon' or 'lat,lon,label', got ${quote(raw)}`,
    );
  }
  const [rawLat, rawLon] = parts as [string, string];
  const lat = pyFloat(rawLat);
  const lon = pyFloat(rawLon);
  if (lat === undefined || lon === undefined) {
    throw new CliUsageError(
      `--location lat/lon must be numbers, got ${quote(rawLat)},${quote(rawLon)}`,
    );
  }
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
  const parsed = parseJsonObject(details);
  const loc = parseLocation(location);
  if (loc !== undefined && parsed && "location" in parsed) {
    throw new CliUsageError(
      "--location conflicts with the 'location' key in --details. Use one or the other.",
    );
  }
  // A NaN or infinity the Python CLI fails to send (exit 1) is refused
  // here, after every usage error as there, rather than sent as `null`.
  // Python refuses it at the request, so a missing context comes first.
  if (parsed !== undefined) refuseNonFinite([parsed]);
  return loc === undefined ? parsed : { ...(parsed ?? {}), location: loc };
}
