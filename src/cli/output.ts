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

import { KaguraFeatureNotAvailableError, KaguraQuotaError, excMessage } from "../errors.js";

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

  // The objects from the root down to the one being serialized. Only an
  // object that contains itself is a cycle; one that merely appears twice
  // (two checks sharing a details object) is printed both times, as
  // Python prints it.
  const ancestors: object[] = [];
  function replacer(this: unknown, _key: string, v: unknown): unknown {
    // JSON.stringify throws TypeError on a bigint. A server response can
    // only produce one if a caller passed it in, but a crash with a stack
    // trace is never the right answer to "print this".
    if (typeof v === "bigint") return Number(v);
    if (typeof v !== "object" || v === null) return v;
    // `this` is the object holding `v`: whatever was entered after it has
    // been left.
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(v)) return "[Circular]";
    ancestors.push(v);
    return v;
  }

  const text = JSON.stringify(value, replacer, 2);
  // Still possible: a value that is entirely unserializable (a bare
  // function or symbol) yields undefined from JSON.stringify.
  return text === undefined ? "null" : text;
}

/**
 * Escape every character outside printable ASCII as `\uXXXX`, as
 * `ensure_ascii=True` does, in serialized JSON.
 *
 * Only string contents can hold such a character: JSON's own syntax is
 * ASCII. A character beyond the BMP is two UTF-16 code units, and so two
 * escapes, the surrogate pair Python writes.
 */
function escapeNonAscii(json: string): string {
  return json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * {@link formatJson} with every character outside printable ASCII escaped
 * as `\uXXXX` — Python's `json.dumps` default (`ensure_ascii=True`), for the
 * one payload the Python CLI prints that way: `auth list --json`.
 */
export function formatJsonAscii(value: unknown): string {
  return escapeNonAscii(formatJson(value));
}

/**
 * One line of JSON the way Python's `json.dumps(value)` writes it without
 * `indent`: `", "` between items and `": "` after a key, where
 * `JSON.stringify` writes neither space.
 *
 * `ensureAscii` is Python's `ensure_ascii`, whose default is `True`; it
 * is required here so each caller states which one its Python counterpart
 * passes. Both ported callers pass `False`: the progress NDJSON
 * (`logger.py`) and the `guardrails digest --out` result line, which
 * prints a non-ASCII path as written. Values are made safe as
 * {@link formatJson} makes them.
 */
export function formatJsonLine(value: unknown, options: { ensureAscii: boolean }): string {
  // Round-trip through formatJson first: it already settles bigints,
  // cycles, undefined and toJSON, so the walk below sees plain JSON only.
  const line = compactJson(JSON.parse(formatJson(value)));
  return options.ensureAscii ? escapeNonAscii(line) : line;
}

function compactJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(compactJson).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${compactJson(v)}`);
    return `{${entries.join(", ")}}`;
  }
  return JSON.stringify(value);
}

/** Days in each month of a common year; February gains one in a leap year. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * `YYYY-MM-DD` or `YYYYMMDD`, then optionally any one character and a
 * time — Python 3.11+'s `fromisoformat` takes any separator, not just `T`.
 */
const ISO_DATE = /^(\d{4})(-?)(\d{2})\2(\d{2})(?:.(.*))?$/su;

/** A lone surrogate, which Python cannot encode to UTF-8 outside the separator. */
const LONE_SURROGATE = /[\ud800-\udfff]/u;

const BYTE = { NUL: 0x00, PLUS: 0x2b, COMMA: 0x2c, MINUS: 0x2d, DOT: 0x2e, COLON: 0x3a, Z: 0x5a } as const;

/** One microsecond short of a day: a UTC offset must be strictly inside it. */
const DAY_MICROS = 86_400_000_000;

/**
 * CPython's `parse_digits`: `count` ASCII digits from `at`, or `null` at the
 * first byte that is not one (the NUL after the text included).
 */
function readDigits(bytes: Uint8Array, at: number, count: number): number | null {
  let value = 0;
  for (let k = 0; k < count; k++) {
    const c = bytes[at + k];
    if (c === undefined || c < 0x30 || c > 0x39) return null;
    value = value * 10 + (c - 0x30);
  }
  return value;
}

interface Clock {
  /** CPython's return code: 0 read to the end, 1 stopped short of it, < 0 malformed. */
  status: number;
  hour: number;
  minute: number;
  second: number;
  micro: number;
}

/**
 * CPython's `parse_hh_mm_ss_ff` (Modules/_datetimemodule.c) over the bytes
 * `[start, end)`: `HH[:MM[:SS[{.,}f…]]]` or `HH[MM[SS[{.,}f…]]]`. Ported
 * rather than written as a pattern because its quirks are what Python
 * prints: it returns 1, not an error, when a single byte of anything is
 * left before `end`, which is where the offset starts, so `00:00:00 Z` is
 * read and `00:00:00  Z` is not; and it reads the NUL after the text as
 * its end, as C does.
 *
 * With CPython 3.14's two added refusals — a decimal mark on the hour or
 * minute (`00:00.5`) and a fourth field (`00:00:00:00`) — which 3.11–3.13
 * read, so this reads only what every supported Python reads.
 */
function parseClock(bytes: Uint8Array, start: number, end: number): Clock {
  const fields = [0, 0, 0];
  const failed = (status: number): Clock => ({ status, hour: 0, minute: 0, second: 0, micro: 0 });
  const clock = (status: number, micro = 0): Clock => ({
    status,
    hour: fields[0]!,
    minute: fields[1]!,
    second: fields[2]!,
    micro,
  });

  let p = start;
  let hasSeparator = true;
  for (let i = 0; i < 3; i++) {
    const value = readDigits(bytes, p, 2);
    if (value === null) return failed(-3);
    fields[i] = value;
    p += 2;
    const c = bytes[p++];
    if (i === 0) hasSeparator = c === BYTE.COLON;
    if (p >= end) return clock(c === BYTE.NUL ? 0 : 1);
    if (hasSeparator && c === BYTE.COLON) {
      if (i === 2) return failed(-4);
      continue;
    }
    if (c === BYTE.DOT || c === BYTE.COMMA) {
      if (i < 2) return failed(-3);
      break;
    }
    if (hasSeparator) return failed(-4);
    // No separators: the byte read is the next field's first digit.
    p--;
  }

  // Up to six fraction digits count; any more are skipped.
  const toParse = Math.min(end - p, 6);
  const digits = readDigits(bytes, p, toParse);
  if (digits === null) return failed(-3);
  p += toParse;
  while (bytes[p] !== undefined && bytes[p]! >= 0x30 && bytes[p]! <= 0x39) p++;
  return clock(bytes[p] === BYTE.NUL ? 0 : 1, digits * 10 ** (6 - toParse));
}

/** `+HH:MM[:SS[.ffffff]]` for an offset in microseconds, as `isoformat` writes it. */
function formatOffset(micros: number): string {
  const sign = micros < 0 ? "-" : "+";
  const abs = Math.abs(micros);
  const us = abs % 1_000_000;
  const seconds = Math.floor(abs / 1_000_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const head = `${sign}${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}`;
  if (us !== 0) return `${head}:${pad(seconds % 60)}.${String(us).padStart(6, "0")}`;
  return seconds % 60 !== 0 ? `${head}:${pad(seconds % 60)}` : head;
}

/**
 * Python's `datetime.fromisoformat(text).isoformat()` for an aware
 * datetime, a naive one read as UTC — how the Python CLI prints a quota's
 * `resets_at` — or `null` where `fromisoformat` would raise.
 *
 *   2026-09-26T00:00:00Z        -> 2026-09-26T00:00:00+00:00
 *   2026-09-26T00:00:00.120Z    -> 2026-09-26T00:00:00.120000+00:00
 *   2026-09-26                  -> 2026-09-26T00:00:00+00:00
 *   2026-09-26T09:00:00+09:00   -> 2026-09-26T09:00:00+09:00 (offset kept)
 *
 * So `+00:00`, never `Z`, and six fraction digits (truncated) only when
 * they are not all zero. The server sends the first two forms. The time
 * is read by a port of CPython's C parser, over UTF-8 bytes as it reads
 * them, so its leniencies match too (one byte of anything before the
 * offset, a `.` with no digits before one). Where CPython versions
 * disagree, this reads `null`: hour 24, which 3.14 reads as the next
 * midnight, and the two forms 3.14 refuses (see `parseClock`). Week dates
 * (`2026-W39-5`), which Python also reads, read as `null` here.
 */
export function pythonIsoformat(text: string): string | null {
  const date = ISO_DATE.exec(text);
  if (date === null) return null;
  const [, yearText, , monthText, dayText, timeText] = date;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || month < 1 || month > 12) return null;
  const monthDays = MONTH_DAYS[month - 1]! + (month === 2 && isLeap(year) ? 1 : 0);
  if (day < 1 || day > monthDays) return null;

  let clock: Clock = { status: 0, hour: 0, minute: 0, second: 0, micro: 0 };
  let offset = 0;
  if (timeText !== undefined) {
    // Python sanitizes a surrogate separator, but anywhere after it one
    // fails the UTF-8 encoding `fromisoformat` parses.
    if (LONE_SURROGATE.test(timeText)) return null;
    const encoded = new TextEncoder().encode(timeText);
    // C's NUL terminator, which the parser reads as the end of the text.
    const bytes = new Uint8Array(encoded.length + 1);
    bytes.set(encoded);
    const end = encoded.length;

    // CPython's `parse_isoformat_time`: the offset starts at the first
    // `Z`, `+` or `-`.
    let zone = 0;
    do {
      const c = bytes[zone];
      if (c === BYTE.Z || c === BYTE.PLUS || c === BYTE.MINUS) break;
    } while (++zone < end);

    clock = parseClock(bytes, 0, zone);
    if (clock.status < 0) return null;
    if (zone >= end) {
      // No offset, so the clock must have reached the end.
      if (clock.status === 1) return null;
    } else if (bytes[zone] === BYTE.Z) {
      if (bytes[zone + 1] !== BYTE.NUL) return null;
    } else {
      const tz = parseClock(bytes, zone + 1, end);
      if (tz.status !== 0) return null;
      const sign = bytes[zone] === BYTE.MINUS ? -1 : 1;
      const seconds = tz.hour * 3600 + tz.minute * 60 + tz.second;
      // As C does: a zero whole-second offset is UTC, its fraction dropped.
      offset = seconds === 0 ? 0 : sign * (seconds * 1_000_000 + tz.micro);
      if (Math.abs(offset) >= DAY_MICROS) return null;
    }
    if (clock.hour > 23 || clock.minute > 59 || clock.second > 59) return null;
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  const fraction = clock.micro === 0 ? "" : `.${String(clock.micro).padStart(6, "0")}`;
  return (
    `${yearText}-${monthText}-${dayText}T${pad(clock.hour)}:${pad(clock.minute)}:${pad(clock.second)}` +
    `${fraction}${formatOffset(offset)}`
  );
}

/**
 * The text after `Error: ` for a failed command — a port of the Python
 * CLI's `_cli_error_message` (its #256): the error's message, then for a
 * quota refusal when it resets, and for a quota or feature gate the plan
 * that lifts it, so the operator need not dig them out of the prose.
 *
 *   Daily memory quota exceeded (100/100).
 *     Resets at: 2026-09-26T00:00:00+00:00
 *     Required plan: Pro (pro)
 *
 * The plan reads `display (key)` when the server sent both and they
 * differ, else whichever it sent. `firstLine` replaces the message when a
 * command words the failure itself, keeping the gate lines. As in Python,
 * only `KaguraQuotaError` and `KaguraFeatureNotAvailableError` add lines:
 * a `KaguraRateLimitError` (an HTTP 429 on `KaguraClient`'s transport)
 * prints its message alone.
 */
export function cliErrorMessage(e: unknown, firstLine?: string): string {
  const lines = [firstLine ?? excMessage(e)];
  if (e instanceof KaguraQuotaError && typeof e.resetsAt === "string") {
    // An unparseable value omits the line, as Python's parse drops it.
    const at = pythonIsoformat(e.resetsAt);
    if (at !== null) lines.push(`  Resets at: ${at}`);
  }
  if (e instanceof KaguraQuotaError || e instanceof KaguraFeatureNotAvailableError) {
    const key = e.requiredPlan;
    const display = e.requiredPlanDisplay;
    const plan = display && key && display !== key ? `${display} (${key})` : display || key;
    if (plan) lines.push(`  Required plan: ${plan}`);
  }
  return lines.join("\n");
}
