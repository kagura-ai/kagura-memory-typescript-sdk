import { describe, expect, it } from "vitest";

import { parseArgs, type ParseSpec } from "../../src/cli/parseArgs.js";

/**
 * A spec exercising every flag kind, so the parser's behaviour is pinned
 * independently of whichever commands happen to use it today.
 */
const SPEC: ParseSpec = {
  flags: [
    { name: "profile", type: "value" },
    { name: "scope", type: "value" },
    { name: "context-id", short: "c", type: "value" },
    { name: "importance", short: "i", type: "value" },
    { name: "read-only", type: "switch" },
    { name: "no-browser", type: "switch" },
    { name: "yes", type: "switch" },
    { name: "json", type: "switch" },
    { name: "verbose", short: "v", type: "count" },
  ],
};

const parse = (argv: string[]) => parseArgs(argv, SPEC);

describe("parseArgs", () => {
  it("reads the subcommand and positionals", () => {
    const parsed = parse(["login"]);
    expect(parsed.command).toBe("login");
    expect(parsed.positionals).toEqual([]);

    expect(parse(["use", "work"]).positionals).toEqual(["work"]);
  });

  it("returns an empty command when none is given", () => {
    expect(parse([]).command).toBe("");
  });

  it.each([
    [["login", "--profile", "work"], "work"],
    [["login", "--profile=work"], "work"],
  ])("accepts both --flag value and --flag=value (%j)", (argv, expected) => {
    expect(parse(argv).values.profile).toBe(expected);
  });

  it("treats known switches as booleans", () => {
    const parsed = parse(["login", "--read-only", "--no-browser"]);
    expect(parsed.flags.has("read-only")).toBe(true);
    expect(parsed.flags.has("no-browser")).toBe(true);
    expect(parsed.values.profile).toBeUndefined();
  });

  it("does not swallow the next token after a switch", () => {
    const parsed = parse(["logout", "--yes", "extra"]);
    expect(parsed.flags.has("yes")).toBe(true);
    expect(parsed.positionals).toEqual(["extra"]);
  });

  it("keeps a scope string containing spaces intact", () => {
    const parsed = parse(["login", "--scope", "memory:read memory:write"]);
    expect(parsed.values.scope).toBe("memory:read memory:write");
  });

  it("accepts an empty --flag= value without consuming the next token", () => {
    const parsed = parse(["login", "--profile=", "trailing"]);
    expect(parsed.values.profile).toBe("");
    expect(parsed.positionals).toEqual(["trailing"]);
  });

  it("reports an unknown flag rather than ignoring it", () => {
    expect(parse(["login", "--porfile", "work"]).unknown).toEqual(["--porfile"]);
  });

  it("reports a value flag left without a value", () => {
    expect(parse(["login", "--profile"]).missingValue).toEqual(["--profile"]);
  });

  it.each([
    [["login", "--profile", "-h"], "-h"],
    [["login", "--scope", "-x"], "-x"],
  ])("does not swallow a short flag as a value (%j)", (argv, following) => {
    const parsed = parse(argv);
    expect(parsed.missingValue).toHaveLength(1);
    expect(parsed.values.profile).toBeUndefined();
    expect(parsed.values.scope).toBeUndefined();
    if (following === "-h") {
      expect(parsed.flags.has("help")).toBe(true);
    }
  });

  it.each([["-p"], ["-x"], ["-abc"]])(
    "reports an unregistered short flag %j rather than treating it as a positional",
    (flag) => {
      const parsed = parse(["login", flag, "work"]);
      expect(parsed.unknown).toEqual([flag]);
      expect(parsed.positionals).toEqual(["work"]);
    },
  );

  it("still treats a bare '-' as a positional", () => {
    expect(parse(["use", "-"]).positionals).toEqual(["-"]);
  });

  it("recognizes -h and --help", () => {
    expect(parse(["--help"]).flags.has("help")).toBe(true);
    expect(parse(["login", "-h"]).flags.has("help")).toBe(true);
  });

  // --- registered short flags -------------------------------------------

  it("reads a short value flag", () => {
    expect(parse(["recall", "-c", "ctx-1"]).values["context-id"]).toBe("ctx-1");
  });

  it("stores a short flag's value under its long name only", () => {
    // Commands read options by long name; a second entry keyed by the
    // letter would make `values.c ?? values["context-id"]` necessary at
    // every call site, and forgetting it reads as "flag not passed".
    const parsed = parse(["recall", "-c", "ctx-1"]);
    expect(parsed.values["context-id"]).toBe("ctx-1");
    expect(parsed.values.c).toBeUndefined();
  });

  it("accepts -c=value as well as -c value", () => {
    expect(parse(["recall", "-c=ctx-1"]).values["context-id"]).toBe("ctx-1");
  });

  it("reports a short value flag left without a value", () => {
    expect(parse(["recall", "-c"]).missingValue).toEqual(["-c"]);
  });

  it("does not swallow the token after a short value flag when it is a flag", () => {
    const parsed = parse(["recall", "-c", "--json"]);
    expect(parsed.missingValue).toEqual(["-c"]);
    expect(parsed.flags.has("json")).toBe(true);
  });

  // --- count flags -------------------------------------------------------

  it("counts a repeated flag", () => {
    expect(parse(["process", "-v"]).counts.verbose).toBe(1);
    expect(parse(["process", "-v", "-v", "-v"]).counts.verbose).toBe(3);
  });

  it("counts a clustered repetition of the same letter (-vv, -vvv)", () => {
    expect(parse(["process", "-vv"]).counts.verbose).toBe(2);
    expect(parse(["process", "-vvv"]).counts.verbose).toBe(3);
  });

  it("reports zero for a count flag that was never passed", () => {
    expect(parse(["process"]).counts.verbose).toBe(0);
  });

  it("accepts the long form of a count flag", () => {
    expect(parse(["process", "--verbose", "--verbose"]).counts.verbose).toBe(2);
  });

  it("does not treat a mixed cluster as a count", () => {
    // `-vx` is not "verbose plus x"; this parser deliberately supports only
    // same-letter repetition, so anything else must be reported rather than
    // half-understood.
    const parsed = parse(["process", "-vx"]);
    expect(parsed.unknown).toEqual(["-vx"]);
    expect(parsed.counts.verbose).toBe(0);
  });

  // --- spec isolation ----------------------------------------------------

  it("reports a flag that belongs to a different command's spec", () => {
    // The whole point of per-command specs: `--read-only` is real for
    // `auth login` and must still be rejected by a command that has no
    // such option, rather than accepted and ignored.
    const narrow: ParseSpec = { flags: [{ name: "json", type: "switch" }] };
    expect(parseArgs(["list", "--read-only"], narrow).unknown).toEqual(["--read-only"]);
  });

  it("always accepts --help regardless of the spec", () => {
    const narrow: ParseSpec = { flags: [] };
    expect(parseArgs(["list", "--help"], narrow).flags.has("help")).toBe(true);
  });
});
