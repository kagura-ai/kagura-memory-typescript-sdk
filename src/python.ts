/**
 * The Python value semantics this SDK reproduces: `repr()` and type names
 * for the messages the Python SDK and CLI interpolate values into, and the
 * grammar of `int()` / `float()` for the numbers they accept.
 *
 * Click quotes every rejected value with `repr()` (`'abc' is not a valid
 * integer.`), and the SDK's own argument checks do too (`metric must be a
 * non-empty string, got ''`). Outside `cli/` because both the bin and the
 * library need it, and the library must not import from the bin.
 */

/** Digits with single underscores between them (PEP 515), as `int()` and `float()` take them. */
const DIGITS = String.raw`\d(?:_?\d)*`;

/**
 * Python's `int()` grammar for a string, once its surrounding whitespace
 * is stripped and its digits are ASCII ({@link pyBigInt} does both): a
 * sign, then digits, with `_` allowed between two of them (`1_000`, never
 * `_1`, `1_` or `1__0`).
 *
 * `Number()` is not a substitute: it accepts `0x10`, `0b11` and `""`, all
 * of which Python rejects.
 */
export const PY_INT = new RegExp(`^[+-]?${DIGITS}$`);

/**
 * Python's `float()` grammar, likewise: decimal and exponent forms with
 * the same underscore rule in every digit run (`1_000.5`, `1e1_0`), and
 * `inf`, `infinity` and `nan` in any case.
 */
export const PY_FLOAT = new RegExp(
  `^[+-]?(?:${DIGITS}(?:\\.(?:${DIGITS})?)?(?:[eE][+-]?${DIGITS})?|\\.${DIGITS}(?:[eE][+-]?${DIGITS})?|inf(?:inity)?|nan)$`,
  "i",
);

/**
 * The whitespace `int()` and `float()` skip around a number: ASCII's tab,
 * newline, `\v`, `\f`, `\r` and space, and every character past ASCII
 * that `str.isspace()` accepts (NEL, the no-break and ideographic spaces).
 *
 * Neither `trim()`'s set, which removes a BOM (U+FEFF), where `int()`
 * refuses one, and keeps NEL, nor `str.strip()`'s, which also removes the
 * `\x1c`-`\x1f` separators `int()` refuses. Pydantic's lax mode skips the
 * same set around a number (Rust's `trim()`).
 */
const NUMBER_SPACE = "\\t\\n\\v\\f\\r \\x85\\xa0\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}";
/** One such character; each is one UTF-16 unit. */
const NUMBER_SPACE_RE = new RegExp(`^[${NUMBER_SPACE}]$`, "u");

/**
 * `text` without the whitespace `int()` and `float()` skip around a number.
 * Scanned in from both ends, in linear time: a regex's trailing-run
 * alternative is retried at every position, which is quadratic in a run of
 * spaces between two characters.
 */
export function stripNumberSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && NUMBER_SPACE_RE.test(text[start]!)) start++;
  while (end > start && NUMBER_SPACE_RE.test(text[end - 1]!)) end--;
  return text.slice(start, end);
}

const DECIMAL_DIGIT_RE = /\p{Nd}/gu;
const IS_DECIMAL_DIGIT_RE = /^\p{Nd}$/u;

/**
 * The value of a decimal digit (`\p{Nd}`). Unicode encodes each set of
 * decimal digits as ten consecutive code points, 0 to 9, some sets back to
 * back (the mathematical digits), so the value is the distance from the
 * start of the run, modulo ten.
 */
function digitValue(digit: string): number {
  const code = digit.codePointAt(0)!;
  let start = code;
  while (IS_DECIMAL_DIGIT_RE.test(String.fromCodePoint(start - 1))) start -= 1;
  return (code - start) % 10;
}

/**
 * The text `int()` and `float()` parse: stripped as they strip it, and
 * every decimal digit past ASCII (Arabic-Indic, full-width, …) read as its
 * ASCII digit, as CPython's `_PyUnicode_TransformDecimalAndSpaceToASCII`
 * reads it. Digits follow the Unicode version of Node's ICU, which may
 * differ from Python's by a release.
 */
function numberText(text: string): string {
  return stripNumberSpace(text).replace(DECIMAL_DIGIT_RE, (d) =>
    d.length === 1 && d <= "9" ? d : String(digitValue(d)),
  );
}

/**
 * `int(text)`, exactly, or `undefined` where Python raises `ValueError`.
 * A `bigint`, as Python's `int` is: `9007199254740993` keeps its last digit.
 */
export function pyBigInt(text: string): bigint | undefined {
  const t = numberText(text);
  return PY_INT.test(t) ? BigInt(t.replace(/_/g, "")) : undefined;
}

/**
 * `int(text)`, or `undefined` where Python raises `ValueError`. A value past
 * `Number.MAX_SAFE_INTEGER` is the nearest `number`; {@link pyBigInt} keeps
 * it exact. There is no `-0`: Python's int has no negative zero.
 */
export function pyInt(text: string): number | undefined {
  const value = pyBigInt(text);
  return value === undefined ? undefined : Number(value);
}

/** `float()` of text already stripped and in ASCII digits. */
function floatOf(t: string): number | undefined {
  if (!PY_FLOAT.test(t)) return undefined;
  // Number() reads "nan" as NaN already, but not "inf" or "infinity".
  return Number(t.replace(/_/g, "").replace(/^([+-]?)inf(inity)?$/i, "$1Infinity"));
}

/** `float(text)`, or `undefined` where Python raises `ValueError`. */
export function pyFloat(text: string): number | undefined {
  return floatOf(numberText(text));
}

/**
 * `float(text)` for ASCII digits only, the way pydantic's lax mode reads a
 * string as a `float`: stripped as `float()` strips it, but `"٣"` is no
 * number there.
 */
export function pyFloatAscii(text: string): number | undefined {
  return floatOf(stripNumberSpace(text));
}

/**
 * The characters `str.isprintable()` rejects, which `repr()` escapes: the
 * "Other" categories (Cc, Cf, Cs, Co, Cn) and the separators (Zl, Zp, Zs),
 * the ASCII space excepted. Unassigned code points (Cn) follow the Unicode
 * version of Node's ICU, which may differ from Python's by a release.
 */
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** `\xhh`, `\uhhhh` or `\Uhhhhhhhh`, the shortest form Python uses for the code point. */
function escapeCodePoint(code: number): string {
  if (code < 0x100) return `\\x${code.toString(16).padStart(2, "0")}`;
  if (code < 0x10000) return `\\u${code.toString(16).padStart(4, "0")}`;
  return `\\U${code.toString(16).padStart(8, "0")}`;
}

/**
 * Python's `repr()` of a string.
 *
 * Escapes matter: a value containing a newline would otherwise split the
 * error across lines, and a Windows path would lose its backslashes.
 * Pinned against the real `repr()` output in the tests.
 *
 *   'a\n b'          -> 'a\\n b'          (control characters escaped)
 *   'C:\\Users'      -> 'C:\\\\Users'     (backslash doubled)
 *   "it's"           -> "it's"            (double-quoted to avoid escaping)
 *   "both ' and \""  -> 'both \\' and "'  (single-quoted, apostrophe escaped)
 *   'a\u00a0b'       -> 'a\\xa0b'         (non-printable beyond ASCII too)
 */
function reprString(value: string): string {
  // Python prefers single quotes, switching to double only when the value
  // contains an apostrophe and no double quote.
  const double = value.includes("'") && !value.includes('"');
  const quoteChar = double ? '"' : "'";

  let out = "";
  // By code point, as Python iterates a str; a lone surrogate arrives as
  // itself and is escaped as the Cs character it is.
  for (const ch of value) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quoteChar) out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch !== " " && NON_PRINTABLE.test(ch)) out += escapeCodePoint(ch.codePointAt(0)!);
    else out += ch;
  }
  return `${quoteChar}${out}${quoteChar}`;
}

/** Python's `str.isprintable()`: true when `repr()` would escape no character of `text`. */
export function pyIsPrintable(text: string): boolean {
  for (const ch of text) {
    if (ch !== " " && NON_PRINTABLE.test(ch)) return false;
  }
  return true;
}

/** `reprlib.Repr`'s defaults in CPython 3.11. */
const REPRLIB = { maxlevel: 6, maxlist: 6, maxdict: 4, maxstring: 30, maxlong: 40, maxother: 30 } as const;

/** reprlib's cut: the first `i` and last `j` code points of `s` around `...`, when `s` is over `max`. */
function reprlibCut(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  const i = Math.max(0, Math.floor((max - 3) / 2));
  const j = Math.max(0, max - 3 - i);
  return `${chars.slice(0, i).join("")}...${chars.slice(chars.length - j).join("")}`;
}

/** `x[start:]` of a Python sequence: a negative start counts from the end. */
function pySliceFrom<T>(items: T[], start: number): T[] {
  return items.slice(start < 0 ? Math.max(0, items.length + start) : start);
}

/**
 * `reprlib.repr(value)` with the default `Repr` (CPython 3.11) — for a
 * value a server sent, printed where Python prints it so: strings cut to 30
 * characters, ints to 40, other scalars to 30, lists to 6 items, dicts to 4
 * sorted keys, 6 levels deep. Dict keys are sorted by UTF-16 code unit,
 * which differs from Python's code-point order only for astral characters.
 */
export function reprlibRepr(value: unknown): string {
  return reprlibValue(value, REPRLIB.maxlevel);
}

function reprlibValue(value: unknown, level: number): string {
  if (typeof value === "string") {
    // Port of Repr.repr_str: repr the head; when that is too long, repr
    // head + tail and cut that.
    const chars = [...value];
    const max = REPRLIB.maxstring;
    const s = pyRepr(chars.slice(0, max).join(""));
    if ([...s].length <= max) return s;
    const i = Math.max(0, Math.floor((max - 3) / 2));
    const j = Math.max(0, max - 3 - i);
    const again = [...pyRepr([...chars.slice(0, i), ...pySliceFrom(chars, chars.length - j)].join(""))];
    return `${again.slice(0, i).join("")}...${pySliceFrom(again, again.length - j).join("")}`;
  }
  if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value))) {
    return reprlibCut(pyRepr(value), REPRLIB.maxlong);
  }
  if (Array.isArray(value)) {
    if (level <= 0 && value.length > 0) return "[...]";
    const pieces = value.slice(0, REPRLIB.maxlist).map((item) => reprlibValue(item, level - 1));
    if (value.length > REPRLIB.maxlist) pieces.push("...");
    return `[${pieces.join(", ")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length === 0) return "{}";
    if (level <= 0) return "{...}";
    const pieces = keys
      .slice(0, REPRLIB.maxdict)
      .map((key) => `${reprlibValue(key, level - 1)}: ${reprlibValue(record[key], level - 1)}`);
    if (keys.length > REPRLIB.maxdict) pieces.push("...");
    return `{${pieces.join(", ")}}`;
  }
  // A float, a bool, None: Repr.repr_instance.
  return reprlibCut(pyRepr(value), REPRLIB.maxother);
}

/**
 * Python's `repr()` of a float: the shortest digits that round-trip (the
 * same digits JS picks), in fixed notation from 1e-4 up to 1e16 and with a
 * trailing `.0` when it is whole, else in exponent notation with a signed,
 * two-digit exponent.
 *
 *   2 -> '2.0'    1e16 -> '1e+16'    0.00001 -> '1e-05'    NaN -> 'nan'
 *
 * Click prints a `FloatRange` value this way (`2.0 is not in the range
 * 0.0<=x<=1.0.`), and so does any f-string of a float.
 */
export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";

  // With no argument, toExponential gives the shortest round-trip digits.
  const [mantissa, exp] = value.toExponential().split("e") as [string, string];
  const exponent = Number(exp);
  if (exponent < -4 || exponent >= 16) {
    const sign = exponent < 0 ? "-" : "+";
    return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  // JS writes fixed notation over all of 1e-7..1e21, which covers this range.
  const fixed = String(value);
  return fixed.includes(".") ? fixed : `${fixed}.0`;
}

/**
 * Python's `repr()` of a JSON-shaped value.
 *
 * A string as above; `None`, `True` and `False`; a whole number as a
 * Python int (JSON cannot tell `5` from `5.0` apart once parsed, and an
 * int is what Python's `json.loads` makes of `5`), any other number as a
 * float; lists and dicts as Python prints them, `[...]` / `{...}` for one
 * that contains itself.
 */
export function pyRepr(value: unknown): string {
  return reprValue(value, []);
}

function reprValue(value: unknown, ancestors: object[]): string {
  if (typeof value === "string") return reprString(value);
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    // BigInt, not String: String(1e21) is "1e+21", Python's int is not.
    return Number.isInteger(value) ? BigInt(value).toString() : pyFloatRepr(value);
  }
  if (typeof value !== "object") return String(value);

  if (Array.isArray(value)) {
    if (ancestors.includes(value)) return "[...]";
    const inner = [...ancestors, value];
    return `[${value.map((item) => reprValue(item, inner)).join(", ")}]`;
  }
  if (ancestors.includes(value)) return "{...}";
  const inner = [...ancestors, value];
  const entries = Object.entries(value).map(([k, v]) => `${reprString(k)}: ${reprValue(v, inner)}`);
  return `{${entries.join(", ")}}`;
}

/**
 * Python's `bool()` of a decoded JSON value: `None`, `False`, `0`, `""`,
 * `[]` and `{}` are false, anything else is true.
 */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * `type(value).__name__` of the Python value a JSON-shaped value would be:
 * `str`, `bool`, `int`, `float`, `list`, `dict` or `NoneType`.
 */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  switch (typeof value) {
    case "string":
      return "str";
    case "boolean":
      return "bool";
    case "bigint":
      return "int";
    case "number":
      return Number.isInteger(value) ? "int" : "float";
    case "object":
      return "dict";
    default:
      return typeof value;
  }
}
