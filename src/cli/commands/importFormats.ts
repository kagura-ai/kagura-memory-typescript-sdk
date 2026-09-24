/**
 * Input readers for `kagura-memory resource import` — the body of the
 * Python CLI's `resource_import`, which reads `--file` with `csv.DictReader`
 * or `json.loads`.
 *
 * Neither exists in Node, and this package takes no runtime dependencies,
 * so both are ported here, down to what they accept and how they fail:
 * CSV by the state machine of CPython's `_csv` reader (quoted fields, `""`
 * as a quote, newlines inside quotes, blank lines skipped), JSON by CPython's
 * scanner (`NaN` and `Infinity` read, then refused before sending as the
 * Python CLI refuses them, and Python's error messages with their `line L
 * column C (char N)` position). The position is all an error says about
 * the input: V8's own `JSON.parse` messages quote the text they stopped at.
 * A row keeps its keys in the order read, as Python's dict does.
 *
 * Every failure is Python's `ClickException` (exit 1) in Python's words,
 * except a `--file` that cannot be opened, which click reports while
 * converting the option (exit 2).
 */

import * as fs from "node:fs";

import { excMessage } from "../../errors.js";
import { pyStrip } from "../../pyCompat.js";
import { pyFloatRepr, pyRepr, pyTypeName } from "../../python.js";
import type { CommandDeps } from "../command.js";
import { CliError, CliUsageError } from "../parse.js";

export type ImportFormat = "csv" | "json" | "jsonl";

// ---------------------------------------------------------------------
// Reading --file
// ---------------------------------------------------------------------

/** `--file` once opened: `name` is what format detection reads. */
export interface ImportInput {
  /** The path as given, or `<stdin>` for `-`, as Python's file object names it. */
  name: string;
  /** The whole text, with `\r\n` and `\r` read as `\n`; throws `Failed to read input: …`. */
  read: () => string;
  close: () => void;
}

/** `strerror` for the errors opening a file usually meets; Node's message otherwise. */
const STRERROR: Record<string, string> = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  EISDIR: "Is a directory",
  ENOTDIR: "Not a directory",
  ELOOP: "Too many levels of symbolic links",
  ENAMETOOLONG: "File name too long",
};

function strerror(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return (code !== undefined && STRERROR[code]) || excMessage(e);
}

/** Python's text mode (`newline=None`): every `\r\n` and lone `\r` reads as `\n`. */
function universalNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Open `--file` as click's `File("r")` opens it, while the option is
 * converted: a path that cannot be opened is a usage error naming it, before
 * the format is even looked at. `-` is stdin, read only once the format is
 * known.
 *
 * A path is decoded as strict UTF-8 with its BOM kept, as Python's
 * `open(path)` reads it on a UTF-8 system: bytes that are not UTF-8 fail
 * the read instead of turning into U+FFFD.
 */
export function openImportInput(file: string, readStdin: CommandDeps["readStdin"]): ImportInput {
  if (file === "-") {
    return {
      name: "<stdin>",
      read: () => {
        let text: string | null;
        try {
          text = readStdin({ throwOnError: true });
        } catch (e) {
          throw new CliError(`Failed to read input: ${excMessage(e)}`);
        }
        // A terminal stdin reads as empty ("No data found in input") rather
        // than waiting for typed input.
        return universalNewlines(text ?? "");
      },
      close: () => {},
    };
  }
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (e) {
    throw new CliUsageError(`Invalid value for '--file' / '-f': '${file}': ${strerror(e)}`);
  }
  // POSIX opens a directory for reading; Python's open() refuses it.
  let directory = false;
  try {
    directory = fs.fstatSync(fd).isDirectory();
  } catch {
    // The read reports whatever this was.
  }
  if (directory) {
    fs.closeSync(fd);
    throw new CliUsageError(`Invalid value for '--file' / '-f': '${file}': ${STRERROR.EISDIR}`);
  }
  return {
    name: file,
    read: () => {
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        return universalNewlines(decoder.decode(fs.readFileSync(fd)));
      } catch (e) {
        throw new CliError(`Failed to read input: ${excMessage(e)}`);
      }
    },
    close: () => {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed; nothing was written through it.
      }
    },
  };
}

/**
 * `--format auto`: by the file's extension, as Python decides it — so stdin
 * (`<stdin>`) needs `--format`, and `DATA.CSV` is not detected.
 */
export function detectFormat(name: string): ImportFormat {
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".jsonl")) return "jsonl";
  if (name.endsWith(".json")) return "json";
  throw new CliError("Cannot detect format. Use --format csv|json|jsonl");
}

// ---------------------------------------------------------------------
// JSON: CPython's json.loads
// ---------------------------------------------------------------------

/** A `json.JSONDecodeError`: the message as `str(e)` renders it. */
export class PyJsonError extends Error {
  constructor(msg: string, text: string, index: number) {
    // Python counts positions in code points, where `index` counts UTF-16
    // units; `\n` alone ends a line.
    const before = text.slice(0, index);
    const pos = Array.from(before).length;
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineno = before.split("\n").length;
    const colno = Array.from(before.slice(lineStart)).length + 1;
    super(`${msg}: line ${lineno} column ${colno} (char ${pos})`);
    this.name = "PyJsonError";
  }
}

/** Python's `StopIteration(idx)` from the scanner: no value starts at `index`. */
class NoValue {
  constructor(readonly index: number) {}
}

const JSON_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** The C scanner's number: no leading zeros, and a `.` or exponent only with digits after. */
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/y;

function skipWs(s: string, i: number): number {
  while (i < s.length) {
    const c = s[i];
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") break;
    i++;
  }
  return i;
}

/** `obj[key] = value`, with `__proto__` an own key as `JSON.parse` makes it. */
function setKey(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    obj[key] = value;
  }
}

/**
 * `target` with its keys listed in `order`, the order a Python dict keeps
 * them in. A plain object lists integer-like keys first, whenever they were
 * set (`{"name": 1, "2024": 2}` lists `2024` first); where that would
 * reorder the keys read, a Proxy lists them as read, for everything that
 * lists them: the `Keys: [...]` of an error, `str()`, and the request body.
 */
function inReadOrder<T extends object>(target: T, order: readonly string[]): T {
  const keys = Object.keys(target);
  if (keys.length === order.length && keys.every((key, i) => key === order[i])) return target;
  return new Proxy(target, {
    ownKeys: (t) => {
      const own = Reflect.ownKeys(t);
      const present = new Set<PropertyKey>(own);
      const listed = order.filter((key) => present.has(key));
      const seen = new Set<PropertyKey>(listed);
      // Anything else (the CSV restkey symbol) after, as the target has it.
      return [...listed, ...own.filter((key) => !seen.has(key))];
    },
  });
}

/**
 * What `json.loads` knows about a number that a JS number forgets: the
 * token it was read from, by the object or array holding it, then its key
 * or index. Python makes an `int` of `10` and a `float` of `10.0` or `1e1`,
 * and its int keeps every digit where a JS number keeps 53 bits, so the
 * `str()` a doc_id is made of needs the token.
 */
const NUMBER_TOKENS = new WeakMap<object, Map<string | number, string>>();

/** A token Python reads as a float: one with a fraction or an exponent, or `NaN` / `±Infinity`. */
function isFloatToken(token: string): boolean {
  return !/^-?\d+$/.test(token);
}

function reprAt(container: object, key: string | number, value: unknown): string {
  if (typeof value === "number") {
    const token = NUMBER_TOKENS.get(container)?.get(key);
    if (token !== undefined) {
      // BigInt reads `-0` as the 0 Python's int makes of it.
      return isFloatToken(token) ? pyFloatRepr(Number(token)) : BigInt(token).toString();
    }
  } else if (Array.isArray(value)) {
    return `[${value.map((item, i) => reprAt(value, i, item)).join(", ")}]`;
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const items = Object.keys(record).map((k) => `${pyRepr(k)}: ${reprAt(record, k, record[k])}`);
    return `{${items.join(", ")}}`;
  }
  return pyRepr(value);
}

/**
 * Python's `str()` of `container[key]`, a value read here: the text of a
 * str, else its `repr()`, with each number as Python reads its token
 * (`10.0` and `1e20` stay floats, `1234567890123456789` keeps its digits).
 */
export function pyStrAt(container: object, key: string | number): string {
  const value = (container as Record<string | number, unknown>)[key];
  return typeof value === "string" ? value : reprAt(container, key, value);
}

/** `type(container[key]).__name__`, a number's by its token. */
export function pyTypeNameAt(container: object, key: string | number): string {
  const token = NUMBER_TOKENS.get(container)?.get(key);
  if (token !== undefined) return isFloatToken(token) ? "float" : "int";
  return pyTypeName((container as Record<string | number, unknown>)[key]);
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
 */
export function refuseNonFinite(payloads: readonly unknown[]): void {
  const found = firstNonFinite(payloads);
  if (found !== undefined) {
    throw new CliError(`Out of range float values are not JSON compliant: ${pyFloatRepr(found)}`);
  }
}

/** The four hex digits after the `u` at `uAt`, which must leave text after them. */
function readHex4(s: string, uAt: number): number {
  const first = uAt + 1;
  const hex = s.slice(first, first + 4);
  if (first + 4 >= s.length || !/^[0-9a-fA-F]{4}$/.test(hex)) {
    throw new PyJsonError("Invalid \\uXXXX escape", s, uAt);
  }
  return Number.parseInt(hex, 16);
}

/** `scanstring` from the character after the opening quote; returns the string and the index past its end. */
function scanString(s: string, start: number): [string, number] {
  const begin = start - 1;
  let out = "";
  let end = start;
  for (;;) {
    let next = end;
    while (next < s.length) {
      const code = s.charCodeAt(next);
      if (code === 0x22 || code === 0x5c) break;
      if (code <= 0x1f) throw new PyJsonError("Invalid control character at", s, next);
      next++;
    }
    if (next >= s.length) throw new PyJsonError("Unterminated string starting at", s, begin);
    out += s.slice(end, next);
    if (s[next] === '"') return [out, next + 1];

    const escAt = next + 1;
    if (escAt >= s.length) throw new PyJsonError("Unterminated string starting at", s, begin);
    const esc = s[escAt]!;
    if (esc !== "u") {
      const mapped = JSON_ESCAPES[esc];
      if (mapped === undefined) throw new PyJsonError("Invalid \\escape", s, next);
      out += mapped;
      end = escAt + 1;
      continue;
    }
    const code = readHex4(s, escAt);
    end = escAt + 5;
    // A high surrogate joins a low one escaped right after it.
    if (code >= 0xd800 && code <= 0xdbff && end + 6 < s.length && s[end] === "\\" && s[end + 1] === "u") {
      const low = readHex4(s, end + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        out += String.fromCharCode(code, low);
        end += 6;
        continue;
      }
    }
    out += String.fromCharCode(code);
  }
}

function parseObject(s: string, start: number): [Record<string, unknown>, number] {
  const expectName = "Expecting property name enclosed in double quotes";
  const obj: Record<string, unknown> = {};
  // A repeated key keeps its first place and takes its last value, as in a dict.
  const order: string[] = [];
  const tokens = new Map<string | number, string>();
  let i = skipWs(s, start);
  if (s[i] !== "}") {
    while (i < s.length) {
      if (s[i] !== '"') throw new PyJsonError(expectName, s, i);
      const [key, afterKey] = scanString(s, i + 1);
      i = skipWs(s, afterKey);
      if (s[i] !== ":") throw new PyJsonError("Expecting ':' delimiter", s, i);
      const valueAt = skipWs(s, i + 1);
      const [value, afterValue] = scanOnce(s, valueAt);
      if (!Object.prototype.hasOwnProperty.call(obj, key)) order.push(key);
      setKey(obj, key, value);
      if (typeof value === "number") tokens.set(key, s.slice(valueAt, afterValue));
      else tokens.delete(key);
      i = skipWs(s, afterValue);
      if (s[i] === "}") break;
      if (s[i] !== ",") throw new PyJsonError("Expecting ',' delimiter", s, i);
      const comma = i;
      i = skipWs(s, i + 1);
      if (s[i] === "}") throw new PyJsonError("Illegal trailing comma before end of object", s, comma);
    }
    if (s[i] !== "}") throw new PyJsonError(expectName, s, i);
  }
  const result = inReadOrder(obj, order);
  if (tokens.size > 0) NUMBER_TOKENS.set(result, tokens);
  return [result, i + 1];
}

function parseArray(s: string, start: number): [unknown[], number] {
  const arr: unknown[] = [];
  const tokens = new Map<string | number, string>();
  let i = skipWs(s, start);
  if (s[i] !== "]") {
    while (i < s.length) {
      const [value, after] = scanOnce(s, i);
      if (typeof value === "number") tokens.set(arr.length, s.slice(i, after));
      arr.push(value);
      i = skipWs(s, after);
      if (s[i] === "]") break;
      if (s[i] !== ",") throw new PyJsonError("Expecting ',' delimiter", s, i);
      const comma = i;
      i = skipWs(s, i + 1);
      if (s[i] === "]") throw new PyJsonError("Illegal trailing comma before end of array", s, comma);
    }
    if (s[i] !== "]") throw new PyJsonError("Expecting value", s, i);
  }
  if (tokens.size > 0) NUMBER_TOKENS.set(arr, tokens);
  return [arr, i + 1];
}

/** `scan_once`: the value starting at `i`, and the index past it. */
function scanOnce(s: string, i: number): [unknown, number] {
  switch (s[i]) {
    case '"':
      return scanString(s, i + 1);
    case "{":
      return parseObject(s, i + 1);
    case "[":
      return parseArray(s, i + 1);
    case "n":
      if (s.startsWith("null", i)) return [null, i + 4];
      break;
    case "t":
      if (s.startsWith("true", i)) return [true, i + 4];
      break;
    case "f":
      if (s.startsWith("false", i)) return [false, i + 5];
      break;
    case "N":
      if (s.startsWith("NaN", i)) return [Number.NaN, i + 3];
      break;
    case "I":
      if (s.startsWith("Infinity", i)) return [Number.POSITIVE_INFINITY, i + 8];
      break;
    case "-":
      if (s.startsWith("-Infinity", i)) return [Number.NEGATIVE_INFINITY, i + 9];
      break;
    default:
      break;
  }
  JSON_NUMBER.lastIndex = i;
  const number = JSON_NUMBER.exec(s);
  if (number === null) throw new NoValue(i);
  return [Number(number[0]), i + number[0].length];
}

/**
 * Python's `json.loads(text)`, messages included, as CPython 3.13 and
 * later word them: 3.11 and 3.12 report a trailing comma as `Expecting
 * value` / `Expecting property name enclosed in double quotes` one
 * character later. An object lists its keys in the order read, as a dict
 * does. A number is a JS number, so one past 2^53 loses precision in the
 * payload sent, as in every JSON read here; what Python would print of it
 * comes from its token ({@link pyStrAt}, {@link pyTypeNameAt}).
 *
 * @throws PyJsonError
 */
export function parsePyJson(text: string): unknown {
  if (text.startsWith("\ufeff")) {
    throw new PyJsonError("Unexpected UTF-8 BOM (decode using utf-8-sig)", text, 0);
  }
  let value: unknown;
  let end: number;
  try {
    [value, end] = scanOnce(text, skipWs(text, 0));
  } catch (e) {
    if (e instanceof NoValue) throw new PyJsonError("Expecting value", text, e.index);
    throw e;
  }
  const after = skipWs(text, end);
  if (after !== text.length) throw new PyJsonError("Extra data", text, after);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `--format json`: an array of objects. */
export function parseJsonRows(text: string): Record<string, unknown>[] {
  let data: unknown;
  try {
    data = parsePyJson(text);
  } catch (e) {
    if (e instanceof PyJsonError) throw new CliError(`Invalid JSON: ${e.message}`);
    throw e;
  }
  if (!Array.isArray(data)) throw new CliError("JSON must be an array of objects");
  data.forEach((item, i) => {
    if (!isObject(item)) throw new CliError(`JSON item ${i} is not an object: ${pyTypeNameAt(data, i)}`);
  });
  return data as Record<string, unknown>[];
}

/** `str.splitlines()`: the line boundaries Python knows, not only `\n`. */
const LINE_BREAK = new RegExp(String.raw`\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]`);

/** `--format jsonl`: one object per line, blank lines skipped, lines numbered from 1. */
export function parseJsonl(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  text.split(LINE_BREAK).forEach((raw, index) => {
    const line = pyStrip(raw);
    if (!line) return;
    let value: unknown;
    try {
      value = parsePyJson(line);
    } catch (e) {
      if (e instanceof PyJsonError) throw new CliError(`Invalid JSONL at line ${index + 1}: ${e.message}`);
      throw e;
    }
    if (!isObject(value)) throw new CliError(`JSONL line ${index + 1} is not an object`);
    rows.push(value);
  });
  return rows;
}

// ---------------------------------------------------------------------
// CSV: CPython's csv.reader and csv.DictReader
// ---------------------------------------------------------------------

/** The states of `_csv`'s reader that the default dialect reaches. */
const Csv = {
  StartRecord: 0,
  StartField: 1,
  InField: 2,
  InQuotedField: 3,
  QuoteInQuotedField: 4,
  EatNewline: 5,
} as const;
type CsvState = (typeof Csv)[keyof typeof Csv];

/**
 * `csv.reader(StringIO(text))` with the default dialect: one array per
 * record, `[]` for a blank line. Fed line by line as Python feeds it, so a
 * newline inside quotes stays in the field and a quote left open at the end
 * keeps what it read. Text is read with universal newlines first, as the
 * CLI reads its file.
 */
export function parseCsvRows(text: string): string[][] {
  const src = universalNewlines(text);
  const records: string[][] = [];
  let fields: string[] = [];
  let field = "";
  // Widened: `feed` moves it, which the loop below cannot see.
  let state = Csv.StartRecord as CsvState;
  const save = (): void => {
    fields.push(field);
    field = "";
  };
  // `null` is the end of a line, which `_csv` feeds after each one.
  const feed = (c: string | null): void => {
    const lineEnd = c === "\n" || c === null;
    if (state === Csv.StartRecord) {
      // A blank line is a record of no fields; anything else starts the
      // record's first field.
      if (c === null) return;
      if (c === "\n") {
        state = Csv.EatNewline;
        return;
      }
      state = Csv.StartField;
    }
    switch (state) {
      case Csv.StartField:
        if (lineEnd) {
          save();
          state = c === null ? Csv.StartRecord : Csv.EatNewline;
        } else if (c === '"') {
          state = Csv.InQuotedField;
        } else if (c === ",") {
          save();
        } else {
          field += c;
          state = Csv.InField;
        }
        return;
      case Csv.InField:
        if (lineEnd) {
          save();
          state = c === null ? Csv.StartRecord : Csv.EatNewline;
        } else if (c === ",") {
          save();
          state = Csv.StartField;
        } else {
          field += c;
        }
        return;
      case Csv.InQuotedField:
        if (c === '"') state = Csv.QuoteInQuotedField;
        else if (c !== null) field += c;
        return;
      case Csv.QuoteInQuotedField:
        if (c === '"') {
          // `""` inside quotes is one literal quote.
          field += '"';
          state = Csv.InQuotedField;
        } else if (c === ",") {
          save();
          state = Csv.StartField;
        } else if (lineEnd) {
          save();
          state = c === null ? Csv.StartRecord : Csv.EatNewline;
        } else {
          // Not strict: `"ab"cd` reads `abcd`.
          field += c;
          state = Csv.InField;
        }
        return;
      case Csv.EatNewline:
        if (c === null) state = Csv.StartRecord;
        return;
    }
  };

  let at = 0;
  while (at < src.length) {
    const newline = src.indexOf("\n", at);
    const next = newline === -1 ? src.length : newline + 1;
    for (let k = at; k < next; k++) feed(src[k]!);
    feed(null);
    if (state === Csv.StartRecord) {
      records.push(fields);
      fields = [];
    }
    at = next;
  }
  // Only an open quote survives a line end; at the end of the input it
  // keeps what it read.
  if (state === Csv.InQuotedField) {
    save();
    records.push(fields);
  }
  return records;
}

/**
 * Where `csv.DictReader` files the cells past the last column: its
 * `restkey`, `None`. A symbol, so they never reach a payload.
 */
export const EXTRA_CELLS: unique symbol = Symbol("restkey");

/** A `csv.DictReader` row. */
export type CsvRow = Record<string, string | null> & { [EXTRA_CELLS]?: string[] };

/**
 * `csv.DictReader`: the first record names the columns, blank lines are
 * skipped, a cell a short row lacks reads as `null` (Python's `None`), and
 * the cells a long row has past the last column go under
 * {@link EXTRA_CELLS}.
 */
export function parseCsv(text: string): CsvRow[] {
  const [header, ...records] = parseCsvRows(text);
  if (header === undefined) return [];
  // The row's keys: the header's, a repeated name where it first appears.
  const order = [...new Set(header)];
  const rows: CsvRow[] = [];
  for (const record of records) {
    if (record.length === 0) continue;
    const row: CsvRow = {};
    header.forEach((name, i) => setKey(row, name, i < record.length ? record[i]! : null));
    if (record.length > header.length) row[EXTRA_CELLS] = record.slice(header.length);
    rows.push(inReadOrder(row, order));
  }
  return rows;
}

/** One row to import: a JSON object, or a CSV row with any {@link EXTRA_CELLS}. */
export type ImportRow = Record<string, unknown> & { [EXTRA_CELLS]?: string[] };

/** The rows of `text` in `format`. */
export function parseImportRows(text: string, format: ImportFormat): ImportRow[] {
  if (format === "csv") return parseCsv(text);
  if (format === "jsonl") return parseJsonl(text);
  return parseJsonRows(text);
}
