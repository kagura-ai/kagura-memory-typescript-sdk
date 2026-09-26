/**
 * A string in an `int` or `float` field as pydantic 2 reads it in lax
 * mode: ports of pydantic-core's `str_as_int` / `str_as_float`
 * (`src/input/shared.rs`, pydantic-core 2.46.4) and of the jiter integer
 * reader `str_as_int` calls first (`NumberInt::try_from`, jiter 0.14.0),
 * pinned against pydantic 2.13.4 (#69).
 *
 * Internal: for `responseShape.ts`'s lax coercers, not exported from the
 * package entry point.
 */

import { stripNumberSpace } from "./python.js";

/** Pydantic's `string_unicode`: a `str` holding a lone surrogate, in any field but `str`. */
export const STRING_UNICODE = "Input should be a valid string, unable to parse raw data as a unicode string";
export const INT_PARSING = "Input should be a valid integer, unable to parse string as an integer";
export const INT_PARSING_SIZE = "Unable to parse input string as an integer, exceeded maximum size";
export const FLOAT_PARSING = "Input should be a valid number, unable to parse string as a number";

/** A UTF-16 surrogate with no partner: Python's `str` holds one, UTF-8 cannot. */
const LONE_SURROGATE = /[\u{d800}-\u{dfff}]/u;

/**
 * Whether `text` holds a lone surrogate. pydantic cannot read such a
 * string as a Rust `&str`, so every field but `str` refuses it with
 * {@link STRING_UNICODE} before parsing. A pair (an emoji) is no lone one.
 */
export function hasLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE.test(text);
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

/** The longest integer literal jiter reads: 4,300 bytes, its sign included. */
const MAX_INT_LENGTH = 4300;

type JiterInt = { kind: "int"; value: bigint } | { kind: "range" } | { kind: "invalid" };
const INVALID: JiterInt = { kind: "invalid" };

/**
 * jiter's `NumberInt::try_from(bytes)`: an optional `-`, then `0` alone or
 * a digit run that does not start with `0`, and nothing after it. A run
 * reaching past byte 4,300 is `NumberOutOfRange` whatever follows it; a
 * `.`, `e` or `E` after the run makes it a float, which is refused. Every
 * character it accepts is ASCII, so string indexes are its byte indexes.
 */
function jiterInt(s: string): JiterInt {
  const start = s[0] === "-" ? 1 : 0;
  const first = s[start];
  if (first === "0") {
    const next = s[start + 1];
    if (next === "." || next === "e" || next === "E" || isDigit(next)) return INVALID;
    return start + 1 === s.length ? { kind: "int", value: 0n } : INVALID;
  }
  if (first === undefined || first < "1" || first > "9") return INVALID;
  let end = start + 1;
  while (isDigit(s[end])) end++;
  // jiter checks the length only once the value outgrows an i64 (19
  // digits), which a run of 4,301 bytes always has.
  if (end > MAX_INT_LENGTH) return { kind: "range" };
  if (end !== s.length) return INVALID;
  return { kind: "int", value: BigInt(s) };
}

/**
 * pydantic-core's `strip_underscores`: `s` without its `_`s, or `null`
 * when it has none, starts or ends with one, or has two in a row.
 */
function stripUnderscores(s: string): string | null {
  if (!s.includes("_") || s.startsWith("_") || s.endsWith("_") || s.includes("__")) return null;
  return s.replace(/_/g, "");
}

/**
 * pydantic-core's `strip_leading_zeros`: from the first `1`-`9` or `-`
 * after the leading `0`s and `_`s, from the last character before a `.`,
 * or the last character when nothing else follows; `null` when the string
 * does not start with a digit or `-`, or meets any other character first.
 */
function stripLeadingZeros(s: string): string | null {
  const first = s[0];
  if (first === undefined) return null;
  if ((first >= "1" && first <= "9") || first === "-") return s;
  if (first !== "0") return null;
  for (let i = 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === "0" || c === "_") continue;
    if ((c >= "1" && c <= "9") || c === "-") return s.slice(i);
    if (c === ".") return s.slice(i - 1);
    return null;
  }
  return s.slice(-1);
}

/**
 * pydantic-core's `clean_int_str`, the second try: trimmed, one `+`
 * dropped (not before a `-`), leading zeros and a zero-only fraction
 * (`.0`, `.00`) stripped, then the `_`s. `null` when nothing changed or
 * the string cannot be a number.
 */
function cleanIntStr(text: string): string | null {
  let s = stripNumberSpace(text);
  if (s.startsWith("+")) {
    if (s[1] === "-") return null;
    s = s.slice(1);
  }
  let negative = false;
  if (s.startsWith("-")) {
    if (s[1] === "-" || s[1] === "+") return null;
    negative = true;
    s = s.slice(1);
  }
  const stripped = stripLeadingZeros(s);
  if (stripped === null) return null;
  s = stripped;
  const dot = s.indexOf(".");
  if (dot >= 0) {
    const fraction = s.slice(dot + 1);
    if (fraction.length > 0 && /^0+$/.test(fraction)) s = s.slice(0, dot);
  }
  const bare = stripUnderscores(s);
  if (bare !== null) return negative ? `-${bare}` : bare;
  // Rust compares byte lengths: equal only when nothing was dropped, and
  // then the lengths agree in any unit.
  if (s.length === text.length) return null;
  return negative ? `-${s}` : s;
}

export type IntText = { ok: true; value: bigint } | { ok: false; msg: string };

/**
 * pydantic-core's `str_as_int`: the text as jiter reads it, untrimmed,
 * then, unless jiter found the digit run too long, the
 * {@link cleanIntStr} text as jiter reads that. So `"0-1"` is -1, `"0__7"`
 * is 7 and `" 1_000.00 "` is 1000; a digit run past 4,300 bytes is
 * {@link INT_PARSING_SIZE} as sent, but {@link INT_PARSING} once it had to
 * be trimmed or cleaned. A lone surrogate is {@link STRING_UNICODE}.
 */
export function pydanticIntText(text: string): IntText {
  if (hasLoneSurrogate(text)) return { ok: false, msg: STRING_UNICODE };
  const first = jiterInt(text);
  if (first.kind === "int") return { ok: true, value: first.value };
  if (first.kind === "range") return { ok: false, msg: INT_PARSING_SIZE };
  const cleaned = cleanIntStr(text);
  const second = cleaned === null ? INVALID : jiterInt(cleaned);
  return second.kind === "int" ? { ok: true, value: second.value } : { ok: false, msg: INT_PARSING };
}

/**
 * Rust's `f64::from_str`: a sign, then `inf`, `infinity` or `nan` in any
 * case, or digits with an optional `.` (`1.`, `.5`) and exponent. No
 * whitespace, no `_`.
 */
const RUST_FLOAT = /^[+-]?(?:inf|infinity|nan|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i;

function rustF64(s: string): number | undefined {
  if (!RUST_FLOAT.test(s)) return undefined;
  const bare = s.replace(/^[+-]/, "").toLowerCase();
  if (bare === "nan") return NaN;
  if (bare === "inf" || bare === "infinity") return s.startsWith("-") ? -Infinity : Infinity;
  // Number() reads the rest of this grammar and rounds correctly, as Rust does.
  return Number(s);
}

/**
 * pydantic-core's `str_as_float`: the trimmed text as Rust reads an f64,
 * then the UNtrimmed text without its `_`s, if it has some, none leading
 * or trailing and no two in a row. So `"1_.5"`, `"+_1"` and `"1e_10"`
 * read, and `" 1_000"` and `"1_000\n"` do not (Python's `float()` does the
 * opposite). `undefined` where pydantic refuses it with
 * {@link FLOAT_PARSING}. The caller checks {@link hasLoneSurrogate} first.
 */
export function pydanticFloatText(text: string): number | undefined {
  const first = rustF64(stripNumberSpace(text));
  if (first !== undefined) return first;
  const stripped = stripUnderscores(text);
  return stripped === null ? undefined : rustF64(stripped);
}
