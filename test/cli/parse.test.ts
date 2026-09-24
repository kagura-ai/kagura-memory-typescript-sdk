import { describe, expect, it } from "vitest";

import {
  CliUsageError,
  buildDetails,
  flagLabel,
  missingParam,
  paramLabel,
  parseChoice,
  parseDetails,
  parseFloatOption,
  parseIdArg,
  parseIntOption,
  parseLocation,
  parseRanged,
  parseTags,
  quote,
} from "../../src/cli/parse.js";

const IMPORTANCE = { name: "importance", short: "i", type: "value" } as const;
const CONTENT = { name: "content", type: "value" } as const;

describe("parseTags", () => {
  it("splits on commas and strips each item", () => {
    expect(parseTags("python, fastapi ,  auth")).toEqual(["python", "fastapi", "auth"]);
  });

  it.each([[undefined], [""], [" "], [","], [" , , "]])(
    "returns undefined for %j so the key is omitted rather than cleared",
    (raw) => {
      // Python's `_parse_tags` collapses an all-empty result back to None.
      // Sending [] would clear the field server-side — a destructive
      // reading of what is usually an unset shell variable.
      expect(parseTags(raw)).toBeUndefined();
    },
  );

  it("drops empty items but keeps the rest", () => {
    expect(parseTags("a,,b,")).toEqual(["a", "b"]);
  });
});

describe("parseFloatOption", () => {
  it.each([
    ["0.5", 0.5],
    ["1", 1],
    [" 2.5 ", 2.5],
    ["-3", -3],
    ["+1.5", 1.5],
    [".5", 0.5],
    ["1e3", 1000],
    ["1E-2", 0.01],
  ])("accepts %j", (raw, expected) => {
    expect(parseFloatOption(IMPORTANCE, raw)).toBe(expected);
  });

  it.each([["0x10"], ["0b11"], [""], ["abc"], ["1,5"], ["--"], ["1 2"]])(
    "rejects %j the way Python's float() does",
    (raw) => {
      // `Number("0x10")` is 16 and `Number("")` is 0; using it directly
      // would silently accept input the Python CLI refuses.
      expect(() => parseFloatOption(IMPORTANCE, raw)).toThrow(CliUsageError);
    },
  );

  it("uses click's message and exit code 2", () => {
    try {
      parseFloatOption(IMPORTANCE, "abc");
      expect.unreachable();
    } catch (e) {
      expect((e as CliUsageError).message).toBe(
        "Invalid value for '--importance' / '-i': 'abc' is not a valid float.",
      );
      expect((e as CliUsageError).exitCode).toBe(2);
    }
  });

  it("does not clamp an out-of-range importance", () => {
    // Python declares plain `type=float`, not FloatRange — 5.0 reaches the
    // server, which is what rejects it. A local clamp would diverge.
    expect(parseFloatOption(IMPORTANCE, "5.0")).toBe(5);
    expect(parseFloatOption(IMPORTANCE, "-3")).toBe(-3);
  });
});

describe("parseIntOption", () => {
  const K = { name: "depth", short: "d", type: "value" } as const;

  it.each([
    ["5", 5],
    [" 10 ", 10],
    ["-2", -2],
  ])("accepts %j", (raw, expected) => {
    expect(parseIntOption(K, raw)).toBe(expected);
  });

  it.each([["1.5"], ["abc"], [""], ["0x10"]])("rejects %j", (raw) => {
    expect(() => parseIntOption(K, raw)).toThrow(CliUsageError);
  });

  it("uses click's integer message", () => {
    expect(() => parseIntOption(K, "x")).toThrow(
      "Invalid value for '--depth' / '-d': 'x' is not a valid integer.",
    );
  });

  it.each([
    ["1_000", 1000],
    ["+7", 7],
    ["04000", 4000],
  ])("accepts %j as Python's int() does", (raw, expected) => {
    expect(parseIntOption(K, raw)).toBe(expected);
  });

  it.each([["_1"], ["1_"], ["1__0"]])("rejects the misplaced underscore in %j", (raw) => {
    expect(() => parseIntOption(K, raw)).toThrow(CliUsageError);
  });

  it("names an argument by its metavar", () => {
    // `@click.argument("invitation_id", type=int)`.
    expect(() => parseIntOption("INVITATION_ID", "7.0")).toThrow(
      "Invalid value for 'INVITATION_ID': '7.0' is not a valid integer.",
    );
  });

  // Click's INT is Python's int(): its whitespace, not trim()'s, and any
  // decimal digit (Python 0.40.1 with click 8.3.3 accepts or refuses each).
  it.each([
    ["\u{661}", 1],
    ["\u{ff11}\u{ff12}", 12],
    ["\u{85}5", 5],
  ])("accepts %j as Python's int() does", (raw, expected) => {
    expect(parseIntOption(K, raw)).toBe(expected);
  });

  it("refuses a BOM, which Python's int() does not strip", () => {
    expect(() => parseIntOption(K, "\u{feff}5")).toThrow(
      "Invalid value for '--depth' / '-d': '\\ufeff5' is not a valid integer.",
    );
  });
});

describe("parseIdArg", () => {
  it.each([
    ["42", 42],
    ["1_000", 1000],
    [" 9007199254740991 ", 9007199254740991],
    ["\u{661}\u{662}", 12],
  ])("reads %j as the safe number %s", (raw, expected) => {
    expect(parseIdArg("TOKEN_ID", raw)).toBe(expected);
  });

  it("keeps an id past 2^53 exact, as a bigint, where a number would round it", () => {
    expect(parseIdArg("TOKEN_ID", "9007199254740993")).toBe(9007199254740993n);
    expect(parseIdArg("TOKEN_ID", "1000000000000000000000")).toBe(10n ** 21n);
    expect(parseIdArg("TOKEN_ID", "-9007199254740993")).toBe(-9007199254740993n);
  });

  it.each([["abc"], ["1.0"], [""], ["\u{feff}5"]])("refuses %j in click's words", (raw) => {
    expect(() => parseIdArg("TOKEN_ID", raw)).toThrow(/^Invalid value for 'TOKEN_ID': .* is not a valid integer\.$/);
  });
});

describe("parseFloatOption: Python's float() grammar", () => {
  it.each([
    ["1_000.5", 1000.5],
    ["1e1_0", 1e10],
    ["inf", Infinity],
  ])("accepts %j", (raw, expected) => {
    expect(parseFloatOption(IMPORTANCE, raw)).toBe(expected);
  });

  it("names an argument by its metavar", () => {
    // `measure record`'s `@click.argument("value", type=float)`.
    expect(() => parseFloatOption("VALUE", "heavy")).toThrow(
      "Invalid value for 'VALUE': 'heavy' is not a valid float.",
    );
  });
});

describe("parseRanged", () => {
  // Every expected message below is click 8.3.3's own output.
  const DAYS = { name: "expires-days", type: "value" } as const;
  const IMP = { name: "importance", type: "value" } as const;
  const intRange = (raw: string) =>
    parseRanged(DAYS, raw, { min: 1, max: 3650, rangeLabel: "1<=x<=3650", integer: true });
  const floatRange = (raw: string) => parseRanged(IMP, raw, { min: 0, max: 1, rangeLabel: "0.0<=x<=1.0" });

  it.each([
    ["+4000", "4000"],
    ["04000", "4000"],
    ["0", "0"],
    ["-0", "0"],
    // BigInt: the digits as given, not a rounded 1e+20.
    ["99999999999999999999", "99999999999999999999"],
  ])("prints the converted int for an out-of-range %j", (raw, shown) => {
    expect(() => intRange(raw)).toThrow(
      `Invalid value for '--expires-days': ${shown} is not in the range 1<=x<=3650.`,
    );
  });

  it.each([
    ["2", "2.0"],
    ["1e1", "10.0"],
    ["1_0", "10.0"],
    ["1.5", "1.5"],
    ["1e16", "1e+16"],
    ["inf", "inf"],
    ["-inf", "-inf"],
    ["1e400", "inf"],
  ])("prints the Python float repr for an out-of-range %j", (raw, shown) => {
    expect(() => floatRange(raw)).toThrow(
      `Invalid value for '--importance': ${shown} is not in the range 0.0<=x<=1.0.`,
    );
  });

  it("refuses nan, which click's FloatRange lets through", () => {
    // Every comparison with NaN is false, so click never reports it.
    expect(() => floatRange("nan")).toThrow(
      "Invalid value for '--importance': nan is not in the range 0.0<=x<=1.0.",
    );
  });

  it.each([
    [" 7 ", 7],
    ["1_000", 1000],
  ])("accepts %j", (raw, expected) => {
    expect(intRange(raw)).toBe(expected);
  });

  it.each([["abc"], ["9.5"], ["1__0"]])("names the range type for the unparseable %j", (raw) => {
    expect(() => intRange(raw)).toThrow(
      `Invalid value for '--expires-days': ${quote(raw)} is not a valid integer range.`,
    );
  });

  it("names the float range type too", () => {
    expect(() => floatRange("abc")).toThrow(
      "Invalid value for '--importance': 'abc' is not a valid float range.",
    );
  });

  it("accepts the bounds and what lies between", () => {
    expect(floatRange("0")).toBe(0);
    expect(floatRange("1e-5")).toBe(0.00001);
    expect(intRange("3650")).toBe(3650);
  });
});

describe("parseChoice", () => {
  const ROLE = { name: "role", type: "value" } as const;
  const ROLES = ["member", "admin", "viewer"] as const;

  it("matches case-sensitively by default, as click.Choice does", () => {
    expect(parseChoice(ROLE, "admin", ROLES)).toBe("admin");
    expect(() => parseChoice(ROLE, "Admin", ROLES)).toThrow(
      "Invalid value for '--role': 'Admin' is not one of 'member', 'admin', 'viewer'.",
    );
  });

  it("does not read a number choice as a number", () => {
    const DAYS = { name: "expires-days", type: "value" } as const;
    const EXPIRES = ["7", "30", "90", "365"] as const;
    expect(() => parseChoice(DAYS, "07", EXPIRES)).toThrow(
      "Invalid value for '--expires-days': '07' is not one of '7', '30', '90', '365'.",
    );
    expect(() => parseChoice(DAYS, "14", EXPIRES)).toThrow("'14' is not one of");
  });

  it("matches casefolded with caseInsensitive, returning the declared spelling", () => {
    const PROGRESS = { name: "progress", type: "value" } as const;
    const CHOICES = ["rich", "json", "none"] as const;
    expect(parseChoice(PROGRESS, "JSON", CHOICES, { caseInsensitive: true })).toBe("json");
    // str.casefold() folds the long s; click takes this spelling too.
    expect(parseChoice(PROGRESS, "J\u017fON", CHOICES, { caseInsensitive: true })).toBe("json");
    expect(() => parseChoice(PROGRESS, "bad", CHOICES, { caseInsensitive: true })).toThrow(
      "Invalid value for '--progress': 'bad' is not one of 'rich', 'json', 'none'.",
    );
  });

  it("uses the singular wording for a single choice", () => {
    expect(() => parseChoice({ name: "one", type: "value" }, "x", ["only"])).toThrow(
      "Invalid value for '--one': 'x' is not 'only'.",
    );
  });

  it("quotes the value as repr() does", () => {
    expect(() => parseChoice(ROLE, "it's", ROLES)).toThrow(`Invalid value for '--role': "it's" is not one of`);
  });

  it("names an argument by the label it is given", () => {
    expect(() => parseChoice("{codex|claude}", "x", ["codex", "claude"])).toThrow(
      "Invalid value for '{codex|claude}': 'x' is not one of 'codex', 'claude'.",
    );
  });
});

describe("missingParam", () => {
  it("lists a Choice's choices one per line, after a tab", () => {
    expect(missingParam({ name: "role", type: "value" }, ["member", "admin", "viewer"]).message).toBe(
      "Missing option '--role'. Choose from:\n\tmember,\n\tadmin,\n\tviewer",
    );
  });

  it("lists casefolded choices for a case-insensitive Choice, as click normalizes them", () => {
    expect(
      missingParam({ name: "progress", type: "value" }, ["Rich", "json"], { caseInsensitive: true }).message,
    ).toBe("Missing option '--progress'. Choose from:\n\trich,\n\tjson");
  });

  it("names an option and an argument as click does, and exits 2", () => {
    const option = missingParam({ name: "user", short: "u", type: "value" });
    expect(option.message).toBe("Missing option '--user' / '-u'.");
    expect(option.exitCode).toBe(2);
    expect(missingParam("KEY_ID").message).toBe("Missing argument 'KEY_ID'.");
  });

  it("labels a parameter the way click's errors do", () => {
    expect(paramLabel("VALUE")).toBe("'VALUE'");
    expect(paramLabel({ name: "unit", type: "value" })).toBe("'--unit'");
  });
});

describe("flagLabel", () => {
  it("names both forms when a short flag exists", () => {
    expect(flagLabel(IMPORTANCE)).toBe("'--importance' / '-i'");
  });

  it("names only the long form otherwise", () => {
    expect(flagLabel(CONTENT)).toBe("'--content'");
  });

  it("names only the short form of a short-only option, which has no long one", () => {
    // click's `@click.option("-k", type=int)`: "Invalid value for '-k'".
    expect(flagLabel({ name: "k", short: "k", type: "value", shortOnly: true })).toBe("'-k'");
  });
});

describe("quote", () => {
  // Vectors captured from the real repr() on CPython 3.13. Click
  // interpolates these into its error messages, so a divergence here shows
  // up in every "Invalid value for ..." the two CLIs print.
  it.each([
    ["plain", "'plain'"],
    ["a\nb", "'a\\nb'"],
    ["a\tb", "'a\\tb'"],
    ["C:\\Users\\x", "'C:\\\\Users\\\\x'"],
    ["it's", '"it\'s"'],
    ['say "hi"', '\'say "hi"\''],
    ['both \' and "', '\'both \\\' and "\''],
    ["\u0000ctrl", "'\\x00ctrl'"],
  ])("matches Python repr for %j", (input, expected) => {
    expect(quote(input)).toBe(expected);
  });

  it("escapes what str.isprintable() rejects beyond ASCII too", () => {
    // CPython 3.12: repr('a\xa0b') == "'a\\xa0b'".
    expect(quote("a\u00a0b")).toBe("'a\\xa0b'");
    expect(quote("zero\u200bwidth")).toBe("'zero\\u200bwidth'");
  });

  it("never emits a raw newline, which would split the error message", () => {
    // A raw newline would break the error across lines and any script
    // grepping for it.
    expect(quote("a\nb")).not.toContain("\n");
  });
});


describe("parseDetails", () => {
  it("parses a JSON object", () => {
    expect(parseDetails('{"a": 1}')).toEqual({ a: 1 });
  });

  it("accepts an explicit empty object", () => {
    // `--details '{}'` yields {} and IS sent, unlike a blank string.
    expect(parseDetails("{}")).toEqual({});
  });

  it.each([[undefined], [""], ["   "]])("treats %j as unset", (raw) => {
    expect(parseDetails(raw)).toBeUndefined();
  });

  it("rejects malformed JSON with exit code 2", () => {
    const run = () => parseDetails("{not json");
    expect(run).toThrow(CliUsageError);
    expect(run).toThrow(/^Invalid JSON for --details: /);
  });

  it.each([
    ["[1,2]", "list"],
    ['"s"', "str"],
    ["3", "int"],
    ["3.5", "float"],
    ["true", "bool"],
    ["null", "NoneType"],
  ])("rejects non-object JSON %j naming the Python type (%s)", (raw, typeName) => {
    expect(() => parseDetails(raw)).toThrow(`--details must be a JSON object, got ${typeName}.`);
  });
});

describe("parseLocation", () => {
  it("parses lat,lon", () => {
    expect(parseLocation("35.68,139.76")).toEqual({ lat: 35.68, lon: 139.76 });
  });

  it("parses lat,lon,label and strips whitespace", () => {
    expect(parseLocation(" 35.68 , 139.76 , Tokyo HQ ")).toEqual({
      lat: 35.68,
      lon: 139.76,
      label: "Tokyo HQ",
    });
  });

  it("omits an empty third field rather than sending an empty label", () => {
    expect(parseLocation("35.68,139.76,")).toEqual({ lat: 35.68, lon: 139.76 });
  });

  it.each([[undefined], [""], ["  "]])("treats %j as unset", (raw) => {
    expect(parseLocation(raw)).toBeUndefined();
  });

  it.each([["35.68"], ["1,2,3,4"]])("rejects the wrong arity %j", (raw) => {
    expect(() => parseLocation(raw)).toThrow("--location must be 'lat,lon' or 'lat,lon,label'");
  });

  it("rejects non-numeric coordinates", () => {
    expect(() => parseLocation("a,b")).toThrow("--location lat/lon must be numbers, got 'a','b'");
  });

  it.each([
    // Python prints the float it parsed: 91.0, not 91.
    ["91,0", "lat must be between -90 and 90, got 91.0"],
    ["-91,0", "lat must be between -90 and 90, got -91.0"],
    ["0,181", "lon must be between -180 and 180, got 181.0"],
    ["inf,0", "lat must be between -90 and 90, got inf"],
    ["1e400,0", "lat must be between -90 and 90, got inf"],
  ])("rejects out-of-range %j with Python's message", (raw, expected) => {
    try {
      parseLocation(raw);
      expect.unreachable();
    } catch (e) {
      expect((e as CliUsageError).message).toBe(`--location ${expected}`);
    }
  });

  it("rejects NaN, which a naive range comparison lets through", () => {
    // `value < -limit || value > limit` is false for NaN. The check is
    // written as range containment precisely so this fails.
    expect(() => parseLocation("nan,0")).toThrow("--location lat must be between -90 and 90, got nan");
  });

  it("reads underscores as Python's float() does", () => {
    expect(parseLocation("3_5.5,1_0")).toEqual({ lat: 35.5, lon: 10 });
  });

  // Each as Python 0.40.1's _parse_location reads it: str.strip(), then float().
  it("strips each part as Python's str.strip() does, and reads any decimal digit", () => {
    expect(parseLocation("\u{1c}35,139")).toEqual({ lat: 35, lon: 139 });
    expect(parseLocation("\u{663}\u{665},139")).toEqual({ lat: 35, lon: 139 });
    expect(parseLocation("35,139,\u{1c}Tokyo\u{1f}")).toEqual({ lat: 35, lon: 139, label: "Tokyo" });
    expect(() => parseLocation("\u{feff}35,139")).toThrow(
      "--location lat/lon must be numbers, got '\\ufeff35','139'",
    );
  });

  it("accepts the exact boundaries", () => {
    expect(parseLocation("90,180")).toEqual({ lat: 90, lon: 180 });
    expect(parseLocation("-90,-180")).toEqual({ lat: -90, lon: -180 });
  });
});

describe("buildDetails", () => {
  it("returns details alone when no location is given", () => {
    expect(buildDetails('{"a":1}', undefined)).toEqual({ a: 1 });
  });

  it("returns location alone when no details are given", () => {
    expect(buildDetails(undefined, "35.68,139.76")).toEqual({
      location: { lat: 35.68, lon: 139.76 },
    });
  });

  it("merges the two", () => {
    expect(buildDetails('{"a":1}', "35.68,139.76")).toEqual({
      a: 1,
      location: { lat: 35.68, lon: 139.76 },
    });
  });

  it("refuses to silently drop either location", () => {
    expect(() => buildDetails('{"location":{"lat":1,"lon":2}}', "35.68,139.76")).toThrow(
      "--location conflicts with the 'location' key in --details. Use one or the other.",
    );
  });

  it("returns undefined when both are absent", () => {
    expect(buildDetails(undefined, undefined)).toBeUndefined();
  });
});
