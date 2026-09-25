/**
 * A `datetime` field as pydantic 2 reads it in lax mode and writes it to
 * JSON — the port of what the Python SDK's models do to every timestamp
 * (#66), from speedate's grammar and pydantic-core's fallbacks.
 *
 * Read:
 *
 * - an RFC 3339 string: `YYYY-MM-DD`, then `T`, `t`, a space or `_`, then
 *   `HH:MM`, optionally `:SS` and a fraction after `.` or `,` (digits past
 *   six are dropped), then optionally `Z` / `z` or an offset `±HH:MM` /
 *   `±HHMM`;
 * - a Unix time, as a number or a string of one (`+5`, `-1.5`, `.5`, and
 *   an exponent after a `.`: `1.5e3`, never `1e3`): seconds, or
 *   milliseconds past ±2e10;
 * - failing both, a date alone (`2026-06-01`), read as midnight with no
 *   offset.
 *
 * Written as `YYYY-MM-DDTHH:MM:SS`, `.ffffff` when there are microseconds,
 * then `Z` for a zero offset, `±HH:MM` for another, or nothing.
 *
 *   2026-06-01T09:00:00.5+00:00 -> 2026-06-01T09:00:00.500000Z
 *
 * A value it refuses carries pydantic's message, for the response error.
 *
 * Internal: not exported from the package entry point.
 */

import type { Coerced } from "./responseShape.js";

/** Milliseconds rather than seconds past this magnitude, as speedate reads a Unix time. */
const MS_THRESHOLD = 20_000_000_000;
/** i64, where speedate's `as i64` saturates. */
const I64_MAX = 2n ** 63n - 1n;
/** A float as Rust's standard grammar reads one (lexical's `STANDARD`). */
const FLOAT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** Seconds from 0001-01-01 to the epoch, and to the end of 9999. */
const MIN_SECONDS = -62_135_596_800;
const MAX_SECONDS = 253_402_300_799;

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  micro: number;
  /** Seconds east of UTC, or `null` for none (naive). */
  offset: number | null;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysIn(year: number, month: number): number {
  return MONTH_DAYS[month - 1]! + (month === 2 && isLeap(year) ? 1 : 0);
}

/** `count` ASCII digits at `at`, or `null`. */
function digits(text: string, at: number, count: number): number | null {
  let value = 0;
  for (let i = at; i < at + count; i++) {
    const c = text.charCodeAt(i);
    if (!(c >= 0x30 && c <= 0x39)) return null;
    value = value * 10 + (c - 0x30);
  }
  return value;
}

type DateResult = { ok: true; year: number; month: number; day: number } | { ok: false; msg: string };

/** speedate's `Date::parse_bytes_partial`: the first ten characters, validated. */
function parseDatePrefix(text: string): DateResult {
  if (text.length < 10) return { ok: false, msg: "input is too short" };
  const year = digits(text, 0, 4);
  if (year === null) return { ok: false, msg: "invalid character in year" };
  if (text[4] !== "-") return { ok: false, msg: "invalid date separator, expected `-`" };
  const month = digits(text, 5, 2);
  if (month === null) return { ok: false, msg: "invalid character in month" };
  if (text[7] !== "-") return { ok: false, msg: "invalid date separator, expected `-`" };
  const day = digits(text, 8, 2);
  if (day === null) return { ok: false, msg: "invalid character in day" };
  if (month < 1 || month > 12) return { ok: false, msg: "month value is outside expected range of 1-12" };
  if (day < 1 || day > daysIn(year, month)) return { ok: false, msg: "day value is outside expected range" };
  return { ok: true, year, month, day };
}

/** speedate's RFC 3339 datetime: the parts, or `null` for anything it refuses. */
function parseDateTime(text: string): Parts | null {
  const date = parseDatePrefix(text);
  if (!date.ok || text.length < 11 || !"Tt _".includes(text[10]!)) return null;
  let at = 11;
  const hour = digits(text, at, 2);
  if (hour === null || text[at + 2] !== ":") return null;
  const minute = digits(text, at + 3, 2);
  if (minute === null) return null;
  at += 5;
  let second = 0;
  let micro = 0;
  if (text[at] === ":") {
    const s = digits(text, at + 1, 2);
    if (s === null) return null;
    second = s;
    at += 3;
    if (text[at] === "." || text[at] === ",") {
      at += 1;
      const start = at;
      while (at < text.length && text.charCodeAt(at) >= 0x30 && text.charCodeAt(at) <= 0x39) at++;
      if (at === start) return null;
      micro = Number(text.slice(start, Math.min(at, start + 6)).padEnd(6, "0"));
    }
  }
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offset: number | null = null;
  const sign = text[at];
  if (sign === "Z" || sign === "z") {
    offset = 0;
    at += 1;
  } else if (sign === "+" || sign === "-") {
    const hh = digits(text, at + 1, 2);
    if (hh === null) return null;
    at += 3;
    if (text[at] === ":") at += 1;
    const mm = digits(text, at, 2);
    if (mm === null || hh > 23 || mm > 59) return null;
    at += 2;
    offset = (sign === "-" ? -1 : 1) * (hh * 3600 + mm * 60);
  }
  if (at !== text.length) return null;
  return { year: date.year, month: date.month, day: date.day, hour, minute, second, micro, offset };
}

/**
 * speedate's `float_parse_bytes`: an int, a float, or `null` for neither.
 *
 * The int is `+` or `-`, then ASCII digits, summed in i64 arithmetic that
 * wraps and fails only when the running value turns negative: so 2^64
 * reads as 0, and -2^63 fails. Only when that stops at a `.` is the text
 * read as a float, whole.
 */
function parseNumber(text: string): bigint | number | null {
  if (text === "") return null;
  let value = 0n;
  for (let i = text.length > 1 && (text[0] === "-" || text[0] === "+") ? 1 : 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (!(c >= 0x30 && c <= 0x39)) return text[i] === "." && FLOAT.test(text) ? Number(text) : null;
    value = BigInt.asIntN(64, value * 10n + BigInt(c - 0x30));
    if (value < 0n) return null;
  }
  return text[0] === "-" ? -value : value;
}

/** The calendar parts of a Unix time in UTC, or pydantic's message for one out of range. */
function fromUnix(seconds: number, micro: number): Parts | string {
  if (seconds > MAX_SECONDS) return "dates after 9999 are not supported as unix timestamps";
  if (seconds < MIN_SECONDS) return "dates before 0000 are not supported as unix timestamps";
  const days = Math.floor(seconds / 86_400);
  const rest = seconds - days * 86_400;
  const date = new Date(days * 86_400_000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: Math.floor(rest / 3600),
    minute: Math.floor(rest / 60) % 60,
    second: rest % 60,
    micro,
    offset: 0,
  };
}

/**
 * A whole Unix time plus microseconds, as speedate's `from_timestamp`
 * reads it: seconds, or milliseconds past ±2e10 (rounded toward -∞, so
 * -1 ms is the second before plus 999 ms).
 */
function fromWatershed(timestamp: bigint, extraMicro: number): Parts | string {
  let seconds = timestamp;
  let micro = extraMicro;
  if ((timestamp < 0n ? -timestamp : timestamp) > BigInt(MS_THRESHOLD)) {
    const ms = ((timestamp % 1000n) + 1000n) % 1000n;
    seconds = (timestamp - ms) / 1000n;
    micro += Number(ms) * 1000;
  }
  if (micro >= 1_000_000) {
    seconds += 1n;
    micro -= 1_000_000;
  }
  if (seconds > BigInt(MAX_SECONDS)) return fromUnix(Number.MAX_SAFE_INTEGER, 0);
  if (seconds < BigInt(MIN_SECONDS)) return fromUnix(-Number.MAX_SAFE_INTEGER, 0);
  return fromUnix(Number(seconds), micro);
}

/**
 * A JSON number as pydantic-core's `float_as_datetime` reads it: the floor
 * in seconds (through {@link fromWatershed}), plus the fraction's magnitude
 * in microseconds, or in milliseconds when the number is past ±2e10. So
 * `-1.25` reads as -2 s + 250 ms, and `20000000000.5` as 20000000000 s +
 * 500 µs: pydantic's arithmetic, kept. ±∞ saturates to i64's end, as
 * Rust's `as i64` does: out of range.
 */
function numberTime(value: number): Parts | string {
  if (Number.isSafeInteger(value)) return fromWatershed(BigInt(value), 0);
  if (!Number.isFinite(value)) return fromWatershed(value > 0 ? I64_MAX : -I64_MAX - 1n, 0);
  const scale = Math.abs(value) > MS_THRESHOLD ? 1000 : 1_000_000;
  return fromWatershed(BigInt(Math.floor(value)), Math.round(Math.abs(value - Math.trunc(value)) * scale));
}

/**
 * A numeric string as speedate reads it: an integer through
 * {@link fromWatershed}; a float divided by 1000 past ±2e10, floored to
 * whole seconds, the rest rounded to microseconds, then through the
 * watershed again. A float too big for a double is ±∞, which Rust's
 * `as i64` saturates to i64's end: out of range, not a crash.
 */
function stringTime(value: bigint | number): Parts | string {
  if (typeof value === "bigint") return fromWatershed(value, 0);
  const t = Math.abs(value) > MS_THRESHOLD ? value / 1000 : value;
  if (!Number.isFinite(t)) return fromWatershed(t > 0 ? I64_MAX : -I64_MAX - 1n, 0);
  const seconds = Math.floor(t);
  return fromWatershed(BigInt(seconds), Math.round((t - seconds) * 1_000_000));
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** pydantic's JSON for a datetime. */
function format(p: Parts): string {
  let text =
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    (p.micro === 0 ? "" : `.${pad(p.micro, 6)}`);
  if (p.offset === 0) {
    text += "Z";
  } else if (p.offset !== null) {
    const abs = Math.abs(p.offset);
    text += `${p.offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 3600))}:${pad(Math.floor(abs / 60) % 60)}`;
  }
  return text;
}

/** Python's `datetime`, which has no year 0, where speedate reads one. */
function checked(p: Parts): Coerced<string> {
  if (p.year === 0) return { ok: false, msg: "Input should be a valid datetime, year 0 is out of range" };
  return { ok: true, value: format(p) };
}

/**
 * `value` as a pydantic `datetime` field reads it, in pydantic's JSON form
 * (see the module comment), or pydantic's message for why it cannot be.
 */
export function pydanticDatetime(value: unknown): Coerced<string> {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { ok: false, msg: "Input should be a valid datetime, NaN values not permitted" };
    const parts = numberTime(value);
    return typeof parts === "string"
      ? { ok: false, msg: `Input should be a valid datetime, ${parts}` }
      : checked(parts);
  }
  if (typeof value !== "string") return { ok: false, msg: "Input should be a valid datetime" };

  const parts = parseDateTime(value);
  if (parts !== null) return checked(parts);
  const number = parseNumber(value);
  const unix = number === null ? null : stringTime(number);
  if (unix !== null && typeof unix !== "string") return checked(unix);
  // pydantic's lax fallback: a date, read as midnight with no offset, and
  // the date's error when that fails too. speedate's date reads an integer
  // as a Unix time, but never a decimal, so only an integer's error is the
  // Unix time's.
  const prefix = "Input should be a valid datetime or date";
  if (typeof number === "bigint" && typeof unix === "string") return { ok: false, msg: `${prefix}, ${unix}` };
  const date = parseDatePrefix(value);
  if (!date.ok) return { ok: false, msg: `${prefix}, ${date.msg}` };
  if (value.length > 10) return { ok: false, msg: `${prefix}, unexpected extra characters at the end of the input` };
  return checked({ ...date, hour: 0, minute: 0, second: 0, micro: 0, offset: null });
}
