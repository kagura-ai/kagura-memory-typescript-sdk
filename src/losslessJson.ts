/**
 * The JSON reader for server responses: it reads a body as Python's
 * `json.loads` reads it, and keeps what `JSON.parse` loses (#69).
 *
 * `JSON.parse` lists an object's array-index keys (`"0"`–`"4294967294"`)
 * first and in numeric order, and makes every number literal a double: an
 * int past 2^53 loses its last digits, `-0` and `-0.0` read the same, and
 * `1e20` cannot be told from `100000000000000000000`. Python keeps the
 * server's key order, reads an int literal exactly and tells an int literal
 * from a float one, and pydantic's verdicts follow from that.
 *
 * {@link parseJsonLossless} returns the plain values `JSON.parse` returns,
 * so every public return type stays what it was, and records the rest
 * beside them, keyed by the object or array holding it:
 *
 * - an object's keys in the order written, when it has an array-index key
 *   ({@link orderedEntries});
 * - each number literal, as a {@link JsonNumber} ({@link valueAt}).
 *
 * What it accepts and refuses, and the messages, are CPython 3.11's
 * `json.loads` (its C scanner): `NaN`, `Infinity` and `-Infinity` read as
 * those floats; a syntax error is a {@link JsonDecodeError} worded as
 * Python's (`Expecting value: line 1 column 1 (char 0)`), as is an int
 * literal of more than {@link INT_MAX_STR_DIGITS} digits; a body nested
 * deeper than {@link MAX_JSON_DEPTH} containers is a
 * {@link JsonNestingError} with Python's RecursionError message.
 *
 * Internal: for the REST clients, the typed readers (`pyModels.ts`,
 * `responseShape.ts`) and the CLI's dumps (`cli/modelDump.ts`); not
 * exported from the package entry point.
 */

import { KaguraError } from "./errors.js";

/**
 * The deepest nesting read, containers counted from the body itself. The
 * Python CLI 0.42.0 reads 973 and fails on the 974th (measured on
 * `resource events|stats|list` and `files list`): Python's limit is its
 * recursion limit less the stack already in use, so it is the CLI's.
 */
export const MAX_JSON_DEPTH = 973;

/** Python's `sys.get_int_max_str_digits()` default: the longest int literal `int()` converts. */
export const INT_MAX_STR_DIGITS = 4300;

/**
 * A number literal of a body, as the server wrote it.
 *
 *   new JsonNumber("9007199254740993")  // isInt, value 9007199254740992
 *   new JsonNumber("-0.0")              // a float, value -0
 *   new JsonNumber("NaN")               // a float, value NaN
 */
export class JsonNumber {
  /**
   * `true` for an int literal, which Python's `json.loads` reads as an
   * exact `int`: an optional `-` and digits, no fraction and no exponent.
   * `false` for a float literal (`1.0`, `1e5`) and for `NaN`, `Infinity`
   * and `-Infinity`.
   */
  readonly isInt: boolean;
  /**
   * What `JSON.parse` makes of it, and Python's float for a float
   * literal: `Number(text)`, so `-0` is `-0`, `1e400` is `Infinity` and a
   * long int literal is its nearest double.
   */
  readonly value: number;

  constructor(
    /** The literal as written: `-0`, `1e20`, `2.50`, `NaN`. */
    readonly text: string,
  ) {
    this.isInt = INT_LITERAL.test(text);
    this.value = Number(text);
  }

  /** The exact integer of an int literal (`-0` is `0n`). @throws RangeError for a float literal. */
  bigint(): bigint {
    if (!this.isInt) throw new RangeError(`${this.text} is not an int literal`);
    return BigInt(this.text);
  }
}

const INT_LITERAL = /^-?\d+$/;

/** A body `json.loads` refuses, worded as Python words it (its `str()`). */
export class JsonDecodeError extends SyntaxError {
  constructor(message: string) {
    super(message);
    this.name = "JsonDecodeError";
  }
}

/**
 * A body nested deeper than {@link MAX_JSON_DEPTH} containers: Python's
 * `RecursionError`, which no caller maps to a non-JSON error, so it is
 * printed as it is (`maximum recursion depth exceeded while decoding a
 * JSON array from a unicode string`).
 */
export class JsonNestingError extends KaguraError {}

interface Source {
  /** The keys in the order written, first occurrences only; kept only for an object with an array-index key. */
  keys?: readonly string[];
  /** Key (an array's index as a string) → the number literal written there. */
  numbers?: Map<string, JsonNumber>;
}

const SOURCES = new WeakMap<object, Source>();

/**
 * `text` read as Python's `json.loads(text)` reads it, as the plain values
 * `JSON.parse` would give (with `NaN` and the infinities for those
 * literals), the key order and number literals recorded beside them.
 *
 * @throws JsonDecodeError for a body Python refuses as a `ValueError`.
 * @throws JsonNestingError for a body nested past {@link MAX_JSON_DEPTH}.
 */
export function parseJsonLossless(text: string): unknown {
  return new Reader(text).decode();
}

/**
 * `container[key]`, own properties only (`undefined` otherwise), with a
 * number the body wrote there as its {@link JsonNumber}. A value changed
 * since it was read is returned as it now is.
 */
export function valueAt(container: object, key: string | number): unknown {
  if (!Object.prototype.hasOwnProperty.call(container, key)) return undefined;
  const value = (container as Record<string, unknown>)[key as string];
  if (typeof value !== "number") return value;
  const literal = SOURCES.get(container)?.numbers?.get(String(key));
  return literal !== undefined && Object.is(literal.value, value) ? literal : value;
}

/** A {@link JsonNumber} as the plain number `JSON.parse` gives; any other value as it is. */
export function jsonValue(value: unknown): unknown {
  return value instanceof JsonNumber ? value.value : value;
}

/**
 * `Object.entries(obj)` in the order the body wrote the keys, which is
 * Python's dict order: `{"b": 1, "2": 2}` gives `b` first, where
 * `Object.entries` gives `2` first. Keys added since it was read follow,
 * in `Object.keys` order; an object not read from a body is
 * `Object.entries(obj)`.
 */
export function orderedEntries(obj: object): [string, unknown][] {
  const record = obj as Record<string, unknown>;
  const keys = SOURCES.get(obj)?.keys;
  if (keys === undefined) return Object.entries(record);
  const out: [string, unknown][] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (Object.prototype.propertyIsEnumerable.call(record, key)) {
      out.push([key, record[key]]);
      seen.add(key);
    }
  }
  for (const key of Object.keys(record)) {
    if (!seen.has(key)) out.push([key, record[key]]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The reader: a port of CPython 3.11's json.decoder / Modules/_json.c
// ---------------------------------------------------------------------------

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

/** JSON's whitespace, the only whitespace `json.loads` skips. */
function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/** An array index, a key V8 lists before the others. */
function isArrayIndex(key: string): boolean {
  if (!isDigit(key.charCodeAt(0))) return false;
  if (key.length > 1 && key.charCodeAt(0) === 0x30) return false;
  return /^\d+$/.test(key) && Number(key) < 4294967295;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
}

/** `obj[key] = value`, with `__proto__` an own key as `JSON.parse` makes it. */
function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = value;
  }
}

/**
 * Python's `JSONDecodeError` text: `msg: line L column C (char N)`, where
 * N counts code points, as a Python `str` index does.
 */
function decodeError(msg: string, doc: string, pos: number): JsonDecodeError {
  let char = 0;
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < pos; i++) {
    const c = doc.charCodeAt(i);
    if (c === 0x0a) {
      line++;
      lastNewline = char;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < pos) {
      const next = doc.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    char++;
  }
  return new JsonDecodeError(`${msg}: line ${line} column ${char - lastNewline} (char ${char})`);
}

class Reader {
  /** Where the value read last ends. */
  private end = 0;
  /** The containers open around the reader. */
  private depth = 0;

  constructor(private readonly s: string) {}

  /** `JSONDecoder.decode`: one value between optional whitespace, nothing after it. */
  decode(): unknown {
    const value = this.value(this.skip(0));
    const end = this.skip(this.end);
    if (end !== this.s.length) this.fail("Extra data", end);
    return jsonValue(value);
  }

  private skip(i: number): number {
    const s = this.s;
    while (i < s.length && isSpace(s.charCodeAt(i))) i++;
    return i;
  }

  private fail(msg: string, pos: number): never {
    throw decodeError(msg, this.s, pos);
  }

  /** `scan_once_unicode`: the value at `i`, a number as its {@link JsonNumber}. */
  private value(i: number): unknown {
    const s = this.s;
    switch (s.charCodeAt(i)) {
      case 0x22: // "
        return this.string(i + 1);
      case 0x7b: // {
        return this.object(i + 1);
      case 0x5b: // [
        return this.array(i + 1);
      case 0x6e: // n
        if (s.startsWith("null", i)) {
          this.end = i + 4;
          return null;
        }
        break;
      case 0x74: // t
        if (s.startsWith("true", i)) {
          this.end = i + 4;
          return true;
        }
        break;
      case 0x66: // f
        if (s.startsWith("false", i)) {
          this.end = i + 5;
          return false;
        }
        break;
      case 0x4e: // N
        if (s.startsWith("NaN", i)) return this.constant("NaN", i);
        break;
      case 0x49: // I
        if (s.startsWith("Infinity", i)) return this.constant("Infinity", i);
        break;
      case 0x2d: // -
        if (s.startsWith("-Infinity", i)) return this.constant("-Infinity", i);
        break;
    }
    return this.number(i);
  }

  private constant(text: string, i: number): JsonNumber {
    this.end = i + text.length;
    return new JsonNumber(text);
  }

  /**
   * `_match_number_unicode`: `-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?`, the
   * longest match; nothing there is `Expecting value`.
   */
  private number(start: number): JsonNumber {
    const s = this.s;
    const last = s.length - 1;
    let i = start;
    if (s.charCodeAt(i) === 0x2d) {
      i++;
      if (i > last) this.fail("Expecting value", start);
    }
    const first = s.charCodeAt(i);
    if (first >= 0x31 && first <= 0x39) {
      i++;
      while (i <= last && isDigit(s.charCodeAt(i))) i++;
    } else if (first === 0x30) {
      i++;
    } else {
      this.fail("Expecting value", start);
    }
    if (i < last && s.charCodeAt(i) === 0x2e && isDigit(s.charCodeAt(i + 1))) {
      i += 2;
      while (i <= last && isDigit(s.charCodeAt(i))) i++;
    }
    const e = s.charCodeAt(i);
    if (i < last && (e === 0x65 || e === 0x45)) {
      const eStart = i;
      i++;
      const sign = s.charCodeAt(i);
      if (i < last && (sign === 0x2d || sign === 0x2b)) i++;
      while (i <= last && isDigit(s.charCodeAt(i))) i++;
      if (!isDigit(s.charCodeAt(i - 1))) i = eStart;
    }
    const text = s.slice(start, i);
    this.end = i;
    const literal = new JsonNumber(text);
    if (literal.isInt) {
      const digits = text.charCodeAt(0) === 0x2d ? text.length - 1 : text.length;
      if (digits > INT_MAX_STR_DIGITS) {
        throw new JsonDecodeError(
          `Exceeds the limit (${INT_MAX_STR_DIGITS} digits) for integer string conversion: ` +
            `value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`,
        );
      }
    }
    return literal;
  }

  /**
   * `scanstring_unicode`: the string whose opening quote ends at `start`.
   * A `\uXXXX` escape is its UTF-16 code unit, so a surrogate pair written
   * as two escapes is the character Python joins it into.
   */
  private string(start: number): string {
    const s = this.s;
    const len = s.length;
    const begin = start - 1;
    let out = "";
    let end = start;
    for (;;) {
      let next = end;
      let c = 0;
      for (; next < len; next++) {
        c = s.charCodeAt(next);
        if (c === 0x22 || c === 0x5c) break;
        if (c <= 0x1f) this.fail("Invalid control character at", next);
      }
      if (next >= len) this.fail("Unterminated string starting at", begin);
      if (next !== end) out += s.slice(end, next);
      if (c === 0x22) {
        this.end = next + 1;
        return out;
      }
      // A backslash at `next`.
      if (next + 1 === len) this.fail("Unterminated string starting at", begin);
      const escape = s[next + 1]!;
      if (escape !== "u") {
        const char = ESCAPES[escape];
        if (char === undefined) this.fail("Invalid \\escape", next);
        out += char;
        end = next + 2;
        continue;
      }
      if (next + 6 >= len) this.fail("Invalid \\uXXXX escape", next + 1);
      let code = 0;
      for (let k = next + 2; k < next + 6; k++) {
        const digit = hexValue(s.charCodeAt(k));
        if (digit < 0) this.fail("Invalid \\uXXXX escape", next + 1);
        code = code * 16 + digit;
      }
      out += String.fromCharCode(code);
      end = next + 6;
    }
  }

  private enter(kind: "array" | "object"): void {
    if (++this.depth > MAX_JSON_DEPTH) {
      throw new JsonNestingError(
        `maximum recursion depth exceeded while decoding a JSON ${kind} from a unicode string`,
      );
    }
  }

  /** `JSONObject`: the object whose `{` ends at `start`. */
  private object(start: number): Record<string, unknown> {
    this.enter("object");
    const s = this.s;
    const obj: Record<string, unknown> = {};
    const keys: string[] = [];
    let indexKey = false;
    let numbers: Map<string, JsonNumber> | undefined;
    let end = start;
    if (s.charCodeAt(end) !== 0x22) {
      end = this.skip(end);
      if (s.charCodeAt(end) === 0x7d) {
        this.depth--;
        this.end = end + 1;
        return obj;
      }
      if (s.charCodeAt(end) !== 0x22) this.fail("Expecting property name enclosed in double quotes", end);
    }
    end += 1;
    for (;;) {
      const key = this.string(end);
      end = this.end;
      if (s.charCodeAt(end) !== 0x3a) {
        end = this.skip(end);
        if (s.charCodeAt(end) !== 0x3a) this.fail("Expecting ':' delimiter", end);
      }
      let value = this.value(this.skip(end + 1));
      end = this.end;
      if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        keys.push(key);
        if (!indexKey && isArrayIndex(key)) indexKey = true;
      }
      if (value instanceof JsonNumber) {
        (numbers ??= new Map()).set(key, value);
        value = value.value;
      } else {
        numbers?.delete(key);
      }
      setOwn(obj, key, value);
      end = this.skip(end);
      const c = s.charCodeAt(end);
      end += 1;
      if (c === 0x7d) break;
      if (c !== 0x2c) this.fail("Expecting ',' delimiter", end - 1);
      end = this.skip(end) + 1;
      if (s.charCodeAt(end - 1) !== 0x22) this.fail("Expecting property name enclosed in double quotes", end - 1);
    }
    this.depth--;
    this.end = end;
    if (indexKey || numbers !== undefined) {
      SOURCES.set(obj, { ...(indexKey ? { keys } : {}), ...(numbers !== undefined ? { numbers } : {}) });
    }
    return obj;
  }

  /** `JSONArray`: the array whose `[` ends at `start`. */
  private array(start: number): unknown[] {
    this.enter("array");
    const s = this.s;
    const arr: unknown[] = [];
    let numbers: Map<string, JsonNumber> | undefined;
    let end = this.skip(start);
    if (s.charCodeAt(end) === 0x5d) {
      this.depth--;
      this.end = end + 1;
      return arr;
    }
    for (;;) {
      let value = this.value(end);
      end = this.end;
      if (value instanceof JsonNumber) {
        (numbers ??= new Map()).set(String(arr.length), value);
        value = value.value;
      }
      arr.push(value);
      end = this.skip(end);
      const c = s.charCodeAt(end);
      end += 1;
      if (c === 0x5d) break;
      if (c !== 0x2c) this.fail("Expecting ',' delimiter", end - 1);
      end = this.skip(end);
    }
    this.depth--;
    this.end = end;
    if (numbers !== undefined) SOURCES.set(arr, { numbers });
    return arr;
  }
}
