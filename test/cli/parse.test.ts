import { describe, expect, it } from "vitest";

import {
  CliUsageError,
  buildDetails,
  flagLabel,
  parseDetails,
  parseFloatOption,
  parseIntOption,
  parseLocation,
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
});

describe("flagLabel", () => {
  it("names both forms when a short flag exists", () => {
    expect(flagLabel(IMPORTANCE)).toBe("'--importance' / '-i'");
  });

  it("names only the long form otherwise", () => {
    expect(flagLabel(CONTENT)).toBe("'--content'");
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
    ["91,0", "lat must be between -90 and 90, got 91"],
    ["-91,0", "lat must be between -90 and 90, got -91"],
    ["0,181", "lon must be between -180 and 180, got 181"],
  ])("rejects out-of-range %j", (raw, expected) => {
    expect(() => parseLocation(raw)).toThrow(`--location ${expected}`);
  });

  it("rejects NaN, which a naive range comparison lets through", () => {
    // `value < -limit || value > limit` is false for NaN. The check is
    // written as range containment precisely so this fails.
    expect(() => parseLocation("nan,0")).toThrow("--location lat must be between -90 and 90");
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
