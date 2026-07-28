import { describe, expect, it } from "vitest";

import { parseArgs } from "../../src/cli/parseArgs.js";

describe("parseArgs", () => {
  it("reads the subcommand and positionals", () => {
    const parsed = parseArgs(["login"]);
    expect(parsed.command).toBe("login");
    expect(parsed.positionals).toEqual([]);

    expect(parseArgs(["use", "work"]).positionals).toEqual(["work"]);
  });

  it("returns an empty command when none is given", () => {
    expect(parseArgs([]).command).toBe("");
  });

  it.each([
    [["login", "--profile", "work"], "work"],
    [["login", "--profile=work"], "work"],
  ])("accepts both --flag value and --flag=value (%j)", (argv, expected) => {
    expect(parseArgs(argv).values.profile).toBe(expected);
  });

  it("treats known switches as booleans", () => {
    const parsed = parseArgs(["login", "--read-only", "--no-browser"]);
    expect(parsed.flags.has("read-only")).toBe(true);
    expect(parsed.flags.has("no-browser")).toBe(true);
    expect(parsed.values.profile).toBeUndefined();
  });

  it("does not swallow the next token after a switch", () => {
    // `--read-only` takes no value, so `use` must stay a positional.
    const parsed = parseArgs(["logout", "--yes", "extra"]);
    expect(parsed.flags.has("yes")).toBe(true);
    expect(parsed.positionals).toEqual(["extra"]);
  });

  it("keeps a scope string containing spaces intact", () => {
    const parsed = parseArgs(["login", "--scope", "memory:read memory:write"]);
    expect(parsed.values.scope).toBe("memory:read memory:write");
  });

  it("accepts an empty --flag= value without consuming the next token", () => {
    const parsed = parseArgs(["login", "--profile=", "trailing"]);
    expect(parsed.values.profile).toBe("");
    expect(parsed.positionals).toEqual(["trailing"]);
  });

  it("reports an unknown flag rather than ignoring it", () => {
    expect(parseArgs(["login", "--porfile", "work"]).unknown).toEqual(["--porfile"]);
  });

  it("reports a value flag left without a value", () => {
    expect(parseArgs(["login", "--profile"]).missingValue).toEqual(["--profile"]);
  });

  it.each([
    [["login", "--profile", "-h"], "-h"],
    [["login", "--scope", "-x"], "-x"],
  ])("does not swallow a short flag as a value (%j)", (argv, following) => {
    // `--profile -h` means the value was omitted and help was asked for,
    // not that the profile is named "-h".
    const parsed = parseArgs(argv);
    expect(parsed.missingValue).toHaveLength(1);
    expect(parsed.values.profile).toBeUndefined();
    expect(parsed.values.scope).toBeUndefined();
    if (following === "-h") {
      expect(parsed.flags.has("help")).toBe(true);
    }
  });

  it("recognizes -h and --help", () => {
    expect(parseArgs(["--help"]).flags.has("help")).toBe(true);
    expect(parseArgs(["login", "-h"]).flags.has("help")).toBe(true);
  });
});
