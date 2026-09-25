/**
 * The SDK's one version parser (`src/versionCheck.ts`), a port of the
 * Python SDK's `_version.py` (its #280).
 *
 * `checkServerVersion` and the CLI's invite check each parsed version
 * strings their own way, so one string could get two verdicts. The table
 * below is Python's `tests/test_version.py`, where the parsing rules live;
 * the per-caller tests only check how each caller reads the answer.
 */

import { describe, expect, it } from "vitest";

import { meetsMinimum, parseVersion, requireVersion } from "../src/versionCheck.js";

type Triple = [bigint, bigint, bigint];

const t = (major: number | bigint, minor: number, patch: number): Triple => [
  BigInt(major),
  BigInt(minor),
  BigInt(patch),
];

// [value, parseVersion(value), isRelease]. `isRelease` is null for an
// unparseable value; otherwise it is what meetsMinimum(value, own triple)
// returns: a release meets its own triple, a pre-release comes before it.
const TABLE: [unknown, Triple | null, boolean | null][] = [
  ["0.76.0", t(0, 76, 0), true],
  ["v0.76.0", t(0, 76, 0), true],
  ["V0.76.0", t(0, 76, 0), true], // PEP 440 reads letters case-insensitively
  ["0.75.12", t(0, 75, 12), true],
  ["20260924.1.0", t(20260924, 1, 0), true],
  // Leading zeros are skipped, as PEP 440 reads them, and do not count
  // towards the 32-digit cap below.
  ["0.076.00", t(0, 76, 0), true],
  ["0".repeat(40) + "1.2.3", t(1, 2, 3), true],
  ["1.2." + "0".repeat(40) + "3", t(1, 2, 3), true],
  ["0".repeat(5000) + ".0.0", t(0, 0, 0), true],
  ["1".repeat(32) + ".0.0", t(BigInt("1".repeat(32)), 0, 0), true],
  // Build metadata / PEP 440 local version: a release.
  ["1.0.0+build", t(1, 0, 0), true],
  ["0.76.0+build.7", t(0, 76, 0), true],
  // Extra numeric components and post-releases: a release of the triple.
  ["1.2.3.4", t(1, 2, 3), true],
  ["1.2.3.4.5", t(1, 2, 3), true],
  ["1.82.7.post1", t(1, 82, 7), true],
  ["1.82.7.post", t(1, 82, 7), true],
  ["1.82.7.POST1", t(1, 82, 7), true],
  ["1.82.7.post1+local", t(1, 82, 7), true],
  // SemVer pre-release: anything after "-".
  ["0.76.0-rc1", t(0, 76, 0), false],
  ["0.76.1-rc1", t(0, 76, 1), false],
  ["0.16.9-beta", t(0, 16, 9), false],
  ["0.76.0-1", t(0, 76, 0), false],
  // PEP 440 pre-release: a letter right after the patch, or .devN.
  ["0.76.0rc1", t(0, 76, 0), false],
  ["0.76.0a1", t(0, 76, 0), false],
  ["0.76.0b2", t(0, 76, 0), false],
  ["0.76.0.dev1", t(0, 76, 0), false],
  // Any other text after the triple also counts as a pre-release.
  ["0.76.0.rc1", t(0, 76, 0), false],
  ["0.76.0_x", t(0, 76, 0), false],
  ["0.76.0 ", t(0, 76, 0), false],
  ["1.2.3.4rc1", t(1, 2, 3), false],
  ["1.82.7.post1.dev1", t(1, 82, 7), false],
  // Unparseable.
  ["0.76", null, null],
  ["main-abc123", null, null],
  ["unknown", null, null],
  ["", null, null],
  [" 0.76.0", null, null], // the triple must start the string
  ["vv0.76.0", null, null],
  ["0.76.x", null, null],
  ["\uff10.76.0", null, null], // FULLWIDTH DIGIT ZERO: ASCII digits only
  ["0.76.\u0663", null, null], // ARABIC-INDIC DIGIT THREE
  ["1".repeat(33) + ".0.0", null, null], // 33 significant digits
  ["0.76." + "0".repeat(40) + "1".repeat(33), null, null],
  ["1".repeat(5000) + ".0.0", null, null], // Python's int() limit: null, never a throw
  ["0.76." + "1".repeat(5000), null, null],
  [null, null, null],
  [undefined, null, null],
  [76, null, null],
  [new TextEncoder().encode("0.76.0"), null, null], // Python's b"0.76.0"
  [[0, 76, 0], null, null],
];

/** A test name for a table value: JSON, cut short (some are 5000 digits). */
function label(value: unknown): string {
  const text = value instanceof Uint8Array ? "bytes" : String(JSON.stringify(value));
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

const ROWS = TABLE.map(([value, triple, isRelease]) => [label(value), value, triple, isRelease] as const);

describe("parseVersion", () => {
  it.each(ROWS)("reads %s", (_, value, triple) => {
    expect(parseVersion(value)).toEqual(triple);
  });
});

describe("meetsMinimum", () => {
  it.each(ROWS)("answers %s at its own triple", (_, value, triple, isRelease) => {
    // With no triple to compare against, use one the value cannot reach.
    expect(meetsMinimum(value, triple ?? t(0, 0, 0))).toBe(isRelease);
  });

  it.each([
    ["0.17.0-rc1", false],
    ["0.17.1-rc1", false], // a pre-release of the minimum comes before it
    ["0.17.1.dev1", false],
    ["0.17.0", false],
    ["0.9.99", false], // compared as numbers, not as text
    ["v0.16.0", false],
    ["0.17.1", true],
    ["v0.17.1", true],
    ["0.17.1+build", true],
    ["0.17.1.post1", true],
    // Only the dotted ".postN" is a post-release. PEP 440's other spellings
    // of 0.17.1.post1 fall under "any other text", so they come before the
    // minimum, the conservative side.
    ["0.17.1post1", false],
    ["0.17.1-post1", false],
    ["0.17.1_post1", false],
    ["0.17.1-1", false],
    ["0.17.1r1", false],
    ["0.17.1.rev1", false],
    ["0.17.2-rc1", true], // a pre-release of a higher triple is above it
    ["0.17.2post1", true],
    ["0.17.10", true],
    ["0.100.0", true],
    ["1.0.0-rc1", true],
    ["unknown", null],
    ["0.17", null],
    ["", null],
    [null, null],
  ] as const)("answers %j against 0.17.1 with %j", (value, expected) => {
    expect(meetsMinimum(value, [0, 17, 1])).toBe(expected);
  });

  // PEP 440's own ordering (`packaging.version.Version(v) >= Version("0.17.1")`,
  // which Python's test asks packaging for) agrees for these spellings. Its
  // other post-release spellings do not: they come before the minimum (above).
  it.each([
    ["0.17.1", true],
    ["v0.17.1", true],
    ["0.17.1rc1", false],
    ["0.17.1a1", false],
    ["0.17.1b2", false],
    ["0.17.1.dev1", false],
    ["0.17.1.post1", true],
    ["0.17.1+local", true],
    ["0.17.0", false],
    ["0.17.2rc1", true],
    ["0.17.2.dev0", true],
    ["0.17.10", true],
    ["0.9.99", false],
    ["1.0.0", true],
    ["0.017.001", true],
    ["0.17.0001rc1", false],
  ] as const)("agrees with PEP 440 that %j >= 0.17.1 is %j", (value, expected) => {
    expect(meetsMinimum(value, [0, 17, 1])).toBe(expected);
  });

  it("compares components past 2^53 exactly", () => {
    const big = "9007199254740993"; // 2^53 + 1, which a Number rounds to 2^53
    expect(meetsMinimum(`${big}.0.0`, [BigInt("9007199254740992"), 0n, 0n])).toBe(true);
    expect(meetsMinimum(`${big}.0.0`, [BigInt(big), 0n, 0n])).toBe(true);
    expect(meetsMinimum(`${big}.0.0-rc1`, [BigInt(big), 0n, 0n])).toBe(false);
  });

  it("stays fast on adversarial input", () => {
    // A run of leading zeros is one lone 0, so a mismatch backtracks in
    // linear time rather than trying every split of the run.
    const started = Date.now();
    expect(meetsMinimum("0".repeat(100_000) + "x", [0, 0, 0])).toBeNull();
    expect(meetsMinimum("1." + "0".repeat(100_000) + "x", [0, 0, 0])).toBeNull();
    expect(meetsMinimum("1.2." + "0".repeat(100_000) + "x", [1, 2, 0])).toBe(false);
    expect(meetsMinimum("v0.0.0" + ".0".repeat(50_000) + "x", [0, 0, 0])).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("requireVersion", () => {
  it("parses the SDK's own constants", () => {
    expect(requireVersion("0.75.0", "MIN_SERVER_VERSION")).toEqual(t(0, 75, 0));
  });

  it("fails loudly on a malformed constant rather than comparing nothing", () => {
    expect(() => requireVersion("0.75", "MIN_SERVER_VERSION")).toThrow(
      'MIN_SERVER_VERSION is not MAJOR.MINOR.PATCH: "0.75"',
    );
  });
});
