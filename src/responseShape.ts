/**
 * Reading a 2xx response the SDK did not expect — a port of the Python
 * SDK's `parse_response`, `response_shape_error` and
 * `_format_validation_errors` (`_http.py`, its #250).
 *
 * Python validates a response against a pydantic model. This SDK has no
 * models at runtime, so a method that checks its response reads the fields
 * it needs through a {@link ResponseReader}, which records each problem in
 * pydantic's words at pydantic's location, and coerces a scalar as
 * pydantic's lax mode does (`"50"` is an int). The error then reads as
 * Python's does:
 *
 *   record_measurement: unexpected server response for MeasurementResult
 *   (measured_at: Field required). The server may be newer than this SDK;
 *   upgrading kagura-memory may help.
 *
 * Messages name fields, never values: a response can carry secret
 * ciphertext or a key's plaintext. Internal: exported for the SDK's
 * methods and the CLI, not from the package entry point.
 */

import { KaguraResponseError } from "./errors.js";
import { JsonNumber, valueAt } from "./losslessJson.js";
import {
  FLOAT_PARSING,
  hasLoneSurrogate,
  pydanticFloatText,
  pydanticIntText,
  STRING_UNICODE,
} from "./pydanticNumber.js";

/** Python's `_UPGRADE_HINT`, the last sentence of every response error. */
export const UPGRADE_HINT = "The server may be newer than this SDK; upgrading kagura-memory may help.";

/** At most this many problems are listed; the rest are counted. */
const MAX_LISTED = 3;

/** Where a problem is: the keys and list indexes from the payload's root. */
export type Loc = readonly (string | number)[];

export interface ResponseIssue {
  loc: Loc;
  /** Pydantic's message, e.g. `Field required` or `Input should be a valid list`. */
  msg: string;
}

/**
 * `a.0.b: msg; c: msg` — each problem at its dotted location, or the
 * message alone for the payload itself.
 */
export function formatResponseIssues(issues: readonly ResponseIssue[]): string {
  return issues.map(({ loc, msg }) => (loc.length > 0 ? `${loc.join(".")}: ${msg}` : msg)).join("; ");
}

/**
 * The error for a payload that failed its model: Python's `parse_response`.
 *
 * `model` is the Python model's name (`MeasurementSeries`), so both SDKs
 * name the same thing.
 */
export function responseModelError(
  operation: string,
  model: string,
  issues: readonly ResponseIssue[],
): KaguraResponseError {
  let listed = formatResponseIssues(issues.slice(0, MAX_LISTED));
  if (issues.length > MAX_LISTED) listed += ` (+${issues.length - MAX_LISTED} more)`;
  return new KaguraResponseError(
    `${operation}: unexpected server response for ${model} (${listed}). ${UPGRADE_HINT}`,
    operation,
  );
}

/**
 * The error for an envelope mis-shaped before any model sees it: Python's
 * `response_shape_error`. `problem` describes the shape only, e.g.
 * `GET /x: expected a JSON array, got dict`.
 */
export function responseShapeError(operation: string, problem: string): KaguraResponseError {
  return new KaguraResponseError(
    `${operation}: unexpected server response (${problem}). ${UPGRADE_HINT}`,
    operation,
  );
}

/** A coerced value, or pydantic's message for why it could not be. */
export type Coerced<T> = { ok: true; value: T } | { ok: false; msg: string };

/** One field type's lax-mode conversion. */
export type Coercer<T> = (value: unknown) => Coerced<T>;

const ok = <T>(value: T): Coerced<T> => ({ ok: true, value });
const fail = (msg: string): Coerced<never> => ({ ok: false, msg });

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** pydantic's bound for a float read as an `int`: an i64 holds less than 2^63. */
const INT_FROM_FLOAT_LIMIT = 2 ** 63;

/**
 * A whole number as the SDK returns one: a `number` up to
 * `Number.MAX_SAFE_INTEGER`, the exact `bigint` past it.
 */
export function exactInt(value: bigint): number | bigint {
  return value >= -MAX_SAFE && value <= MAX_SAFE ? Number(value) : value;
}

/**
 * A JavaScript number in an `int` field, as pydantic's `float_as_int`
 * reads a float: finite and whole (`-0` is 0), else refused in its words.
 */
function wholeNumber(value: number): Coerced<number> {
  if (!Number.isFinite(value)) return fail("Input should be a finite number");
  if (!Number.isInteger(value)) {
    return fail("Input should be a valid integer, got a number with a fractional part");
  }
  return ok(value + 0);
}

/**
 * An `int` field given a number literal of the body (#69), as pydantic
 * reads what `json.loads` made of it: an int literal exactly (`-0` is 0,
 * 309 digits are 309 digits); a float literal when it is finite, whole and
 * of magnitude below 2^63 (`1e18` is 10^18, `1e20` is refused).
 */
function intFromLiteral(literal: JsonNumber): Coerced<number | bigint> {
  if (literal.isInt) return ok(exactInt(literal.bigint()));
  const whole = wholeNumber(literal.value);
  if (!whole.ok) return whole;
  if (Math.abs(whole.value) >= INT_FROM_FLOAT_LIMIT) {
    return fail("Unable to parse input string as an integer, exceeded maximum size");
  }
  return ok(exactInt(BigInt(whole.value)));
}

/**
 * An `int` field: a whole number, a bool, or a string pydantic-core's
 * `str_as_int` reads (`" 50 "`, `"1_000"`, `"50.0"`, `"0-1"`; see
 * `pydanticNumber.ts`). A number literal ({@link JsonNumber}) is read as
 * {@link laxExactInt} reads it, then as the nearest `number`. A value
 * past 2^53 is the nearest double, and one of 2^1024 or more (309 digits)
 * is `Infinity`: the fields read with laxInt are typed `number` (README
 * "Reading responses"); {@link laxExactInt} keeps them exact.
 */
export const laxInt: Coercer<number> = (value) => {
  if (value instanceof JsonNumber) {
    const result = intFromLiteral(value);
    return result.ok ? ok(Number(result.value)) : result;
  }
  if (typeof value === "boolean") return ok(value ? 1 : 0);
  if (typeof value === "number") return wholeNumber(value);
  if (typeof value === "string") {
    const result = pydanticIntText(value);
    return result.ok ? ok(Number(result.value)) : fail(result.msg);
  }
  return fail("Input should be a valid integer");
};

/**
 * {@link laxInt}, exact past 2^53: a string whose value is beyond
 * `Number.MAX_SAFE_INTEGER` reads as the `bigint` Python's `int` holds,
 * rather than as a rounded neighbour. memory-cloud sends a resource
 * event's BigInt id as such a string, and the Python model's `int` prints
 * it as a number. So does an int literal of the body
 * ({@link JsonNumber}): `9007199254740993` reads `9007199254740993n`.
 */
export const laxExactInt: Coercer<number | bigint> = (value) => {
  if (value instanceof JsonNumber) return intFromLiteral(value);
  if (typeof value === "string") {
    const result = pydanticIntText(value);
    return result.ok ? ok(exactInt(result.value)) : fail(result.msg);
  }
  return laxInt(value);
};

/**
 * A `float` field: a number, a bool, or a string pydantic-core's
 * `str_as_float` reads. A float literal ({@link JsonNumber}) is its value (`-0.0`
 * stays `-0`, `NaN` stays NaN); an int literal is Python's `float(int)`:
 * the nearest double, `-0` is `0`, and one past the largest double is
 * refused.
 */
export const laxFloat: Coercer<number> = (value) => {
  if (value instanceof JsonNumber) {
    if (!value.isInt) return ok(value.value);
    const float = value.value + 0;
    return Number.isFinite(float) ? ok(float) : fail("Input should be a valid number");
  }
  if (typeof value === "boolean") return ok(value ? 1 : 0);
  if (typeof value === "number") return ok(value);
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) return fail(STRING_UNICODE);
    const parsed = pydanticFloatText(value);
    return parsed === undefined ? fail(FLOAT_PARSING) : ok(parsed);
  }
  return fail("Input should be a valid number");
};

const TRUE_TEXT = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE_TEXT = new Set(["0", "off", "f", "false", "n", "no"]);

const BOOL_TYPE = "Input should be a valid boolean";
const BOOL_PARSING = "Input should be a valid boolean, unable to interpret input";
/** 2^63: pydantic-core's `float_as_int` takes a whole float strictly inside +/-2^63 only. */
const I64_BOUND = 2 ** 63;
const I64_MIN = -(2n ** 63n);
const I64_END = 2n ** 63n;

/**
 * A float in a `bool` field, as pydantic's `validate_bool` reads one:
 * `0` and `1` (`1.0` too) are bools, another whole number strictly inside
 * +/-2^63 is read and refused, anything else (a fraction, 2^63 or more,
 * NaN, an infinity) is no bool at all.
 */
function boolFromFloat(value: number): Coerced<boolean> {
  if (value === 0 || value === 1) return ok(value === 1);
  return Number.isInteger(value) && value > -I64_BOUND && value < I64_BOUND ? fail(BOOL_PARSING) : fail(BOOL_TYPE);
}

/**
 * A JSON number literal in a `bool` field, as pydantic reads what
 * `json.loads` makes of it: an int literal inside the i64 range is `0`,
 * `1` or read and refused (`int_as_bool`), one outside it is no bool; any
 * other literal (`.`, `e`, `E`) is a float ({@link boolFromFloat}).
 */
export function boolFromNumberLiteral(text: string): Coerced<boolean> {
  if (!/^-?\d+$/.test(text)) return boolFromFloat(Number(text));
  const value = BigInt(text);
  if (value === 0n || value === 1n) return ok(value === 1n);
  return value >= I64_MIN && value < I64_END ? fail(BOOL_PARSING) : fail(BOOL_TYPE);
}

/**
 * A `bool` field: a bool, a number {@link boolFromFloat} accepts, or one
 * of pydantic's words in any case (`"yes"`, `"off"`, `"t"`, …),
 * unstripped. A number literal of the body ({@link JsonNumber}) is read
 * as the literal it is ({@link boolFromNumberLiteral}); a JavaScript
 * number cannot tell the int literal 9223372036854775807 from 2^63, so a
 * plain `number` is read as the float it rounds to.
 */
export const laxBool: Coercer<boolean> = (value) => {
  if (value instanceof JsonNumber) return boolFromNumberLiteral(value.text);
  if (typeof value === "boolean") return ok(value);
  if (typeof value === "number") return boolFromFloat(value);
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) return fail(STRING_UNICODE);
    const text = value.toLowerCase();
    if (TRUE_TEXT.has(text)) return ok(true);
    if (FALSE_TEXT.has(text)) return ok(false);
    return fail(BOOL_PARSING);
  }
  return fail(BOOL_TYPE);
};

/** A `str` field: strings only; pydantic does not stringify a number. */
export const laxStr: Coercer<string> = (value) =>
  typeof value === "string" ? ok(value) : fail("Input should be a valid string");

/** `T | None`: `null` passes, anything else is the inner type's. */
export function nullable<T>(coerce: Coercer<T>): Coercer<T | null> {
  return (value) => (value === null ? ok(null) : coerce(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface FieldOptions<T> {
  /** The location of the object holding the field (default: the root). */
  at?: Loc;
  /** The value when the key is absent; without one, absent is `Field required`. */
  default?: T;
}

/**
 * Reads a response the way one pydantic model validates it: every problem
 * is recorded, in the order read, and {@link ResponseReader.check} throws
 * them as one {@link KaguraResponseError}.
 *
 * Read the fields in the model's declaration order, so the problems come
 * out in pydantic's order. A value read after a problem was recorded for
 * it is meaningless; nothing read may be used until `check()` has passed.
 *
 *   const r = new ResponseReader("recall_series", "MeasurementSeries");
 *   const obj = r.object(raw);
 *   const metric = obj && r.field(obj, "metric", laxStr);
 *   r.check();
 */
export class ResponseReader {
  private readonly issues: ResponseIssue[] = [];

  constructor(
    readonly operation: string,
    readonly model: string,
  ) {}

  /** Record a problem the typed readers do not cover. */
  issue(loc: Loc, msg: string): void {
    this.issues.push({ loc, msg });
  }

  /**
   * `value` as an object, or `null` with pydantic's `model_type` problem:
   * `Input should be a valid dictionary or instance of <model>`.
   */
  object(value: unknown, at: Loc = [], model: string = this.model): Record<string, unknown> | null {
    if (isObject(value)) return value;
    this.issue(at, `Input should be a valid dictionary or instance of ${model}`);
    return null;
  }

  /**
   * One field of `obj`, coerced; absent is `Field required` unless it has a
   * default. A number the body wrote there reaches `coerce` as its
   * {@link JsonNumber} (`losslessJson.ts`); a coercer returns a plain value.
   */
  field<T>(obj: Record<string, unknown>, key: string, coerce: Coercer<T>, options: FieldOptions<T> = {}): T {
    const at = [...(options.at ?? []), key];
    const raw = valueAt(obj, key);
    if (raw === undefined) {
      if ("default" in options) return options.default as T;
      this.issue(at, "Field required");
      return undefined as T;
    }
    const result = coerce(raw);
    if (result.ok) return result.value;
    this.issue(at, result.msg);
    return undefined as T;
  }

  /**
   * A list field, each item read by `item` at its own location
   * (`series.0`); anything but an array is `Input should be a valid list`.
   */
  list<T>(
    obj: Record<string, unknown>,
    key: string,
    item: (value: unknown, at: Loc) => T,
    options: FieldOptions<T[]> = {},
  ): T[] {
    const at = [...(options.at ?? []), key];
    const raw = Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
    if (raw === undefined) {
      if ("default" in options) return options.default as T[];
      this.issue(at, "Field required");
      return [];
    }
    if (!Array.isArray(raw)) {
      this.issue(at, "Input should be a valid list");
      return [];
    }
    return raw.map((value, index) => item(value, [...at, index]));
  }

  /** Throw every recorded problem as one error; a no-op when there is none. */
  check(): void {
    if (this.issues.length > 0) throw responseModelError(this.operation, this.model, this.issues);
  }
}
