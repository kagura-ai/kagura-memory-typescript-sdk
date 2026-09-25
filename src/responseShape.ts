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
import { pyFloatAscii, stripNumberSpace } from "./python.js";

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

/** Pydantic's `int` digits, after strip: `_` between digits, and a zero-only fraction (`"50.0"`). */
const LAX_INT_TEXT = /^[+-]?\d(?:_?\d)*(?:\.0+)?$/;

/**
 * An `int` field: a whole number, a bool, or a string of one (`" 50 "`,
 * `"1_000"`, `"50.0"`), as pydantic 2 accepts them: stripped of the
 * whitespace `int()` skips (NEL, but no BOM), in ASCII digits.
 */
export const laxInt: Coercer<number> = (value) => {
  if (typeof value === "boolean") return ok(value ? 1 : 0);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail("Input should be a finite number");
    if (!Number.isInteger(value)) {
      return fail("Input should be a valid integer, got a number with a fractional part");
    }
    return ok(value + 0);
  }
  if (typeof value === "string") {
    const text = stripNumberSpace(value);
    if (LAX_INT_TEXT.test(text)) return ok(Number(text.replace(/_/g, "")) + 0);
    return fail("Input should be a valid integer, unable to parse string as an integer");
  }
  return fail("Input should be a valid integer");
};

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * {@link laxInt}, exact past 2^53: a string of digits beyond
 * `Number.MAX_SAFE_INTEGER` reads as the `bigint` Python's `int` holds,
 * rather than as a rounded neighbour. memory-cloud sends a resource
 * event's BigInt id as such a string, and the Python model's `int` prints
 * it as a number.
 */
export const laxExactInt: Coercer<number | bigint> = (value) => {
  if (typeof value === "string") {
    const text = stripNumberSpace(value);
    if (LAX_INT_TEXT.test(text)) {
      const exact = BigInt(text.replace(/_/g, "").replace(/\.0+$/, ""));
      return ok(exact >= -MAX_SAFE && exact <= MAX_SAFE ? Number(exact) : exact);
    }
  }
  return laxInt(value);
};

/** A `float` field: a number, a bool, or a string `float()` would read in ASCII digits. */
export const laxFloat: Coercer<number> = (value) => {
  if (typeof value === "boolean") return ok(value ? 1 : 0);
  if (typeof value === "number") return ok(value);
  if (typeof value === "string") {
    const parsed = pyFloatAscii(value);
    return parsed === undefined
      ? fail("Input should be a valid number, unable to parse string as a number")
      : ok(parsed);
  }
  return fail("Input should be a valid number");
};

const TRUE_TEXT = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE_TEXT = new Set(["0", "off", "f", "false", "n", "no"]);

/**
 * A `bool` field: a bool, `0` / `1`, or one of pydantic's words in any
 * case (`"yes"`, `"off"`, `"t"`, …), unstripped.
 */
export const laxBool: Coercer<boolean> = (value) => {
  if (typeof value === "boolean") return ok(value);
  if (typeof value === "number") {
    if (value === 0 || value === 1) return ok(value === 1);
    // A whole number is read and refused; a fraction is not a bool at all.
    return Number.isInteger(value)
      ? fail("Input should be a valid boolean, unable to interpret input")
      : fail("Input should be a valid boolean");
  }
  if (typeof value === "string") {
    const text = value.toLowerCase();
    if (TRUE_TEXT.has(text)) return ok(true);
    if (FALSE_TEXT.has(text)) return ok(false);
    return fail("Input should be a valid boolean, unable to interpret input");
  }
  return fail("Input should be a valid boolean");
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

  /** One field of `obj`, coerced; absent is `Field required` unless it has a default. */
  field<T>(obj: Record<string, unknown>, key: string, coerce: Coercer<T>, options: FieldOptions<T> = {}): T {
    const at = [...(options.at ?? []), key];
    const raw = Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
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
