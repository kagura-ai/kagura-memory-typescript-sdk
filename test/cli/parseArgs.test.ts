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

  it("returns no command when none is given", () => {
    expect(parse([]).command).toBeUndefined();
    expect(parse(["--yes"]).command).toBeUndefined();
  });

  it("tells an empty first argument from a missing one", () => {
    // Click passes '' through; `command` must not read it as absent.
    const parsed = parse(["", "b"]);
    expect(parsed.command).toBe("");
    expect(parsed.positionals).toEqual(["b"]);
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

  it.each([
    ["-p", "-p"],
    ["-x", "-x"],
    ["-abc", "-a"],
  ])("reports an unregistered short flag %j rather than treating it as a positional", (flag, name) => {
    const parsed = parse(["login", flag, "work"]);
    expect(parsed.unknown).toEqual([name]);
    expect(parsed.positionals).toEqual(["work"]);
  });

  describe("names an unknown option as click's error does, without any value in the token", () => {
    // Measured against click 8.3.3: "No such option: --bogus" for
    // `--bogus=kg_secret`, and "-x" for `-xVALUE`.
    it.each([
      [["--bogus=kg_secret_key"], "--bogus"],
      [["--bogus="], "--bogus"],
      [["-xkg_secret_key"], "-x"],
      [["-vx"], "-x"],
      [["-h=x"], "-h"],
    ])("%j → %s", (argv, name) => {
      const parsed = parse(["cmd", ...argv]);
      expect(parsed.unknown).toEqual([name]);
      expect(JSON.stringify(parsed)).not.toContain("kg_secret");
    });

    it("reports a switch given a value by its name, as click's 'does not take a value'", () => {
      const parsed = parse(["cmd", "--json=true"]);
      expect(parsed.noValue).toEqual(["--json"]);
      expect(parsed.unknown).toEqual([]);
      expect(parsed.flags.has("json")).toBe(false);
    });
  });

  describe("combines short options as click does", () => {
    const SHORT: ParseSpec = {
      flags: [
        { name: "yes", short: "y", type: "switch" },
        { name: "verbose", short: "v", type: "count" },
        { name: "k", short: "k", type: "value", shortOnly: true },
      ],
    };
    const short = (argv: string[]) => parseArgs(["cmd", ...argv], SHORT);

    it("reads a cluster of switches", () => {
      const parsed = short(["-yvv"]);
      expect(parsed.flags.has("yes")).toBe(true);
      expect(parsed.counts.verbose).toBe(2);
      expect(parsed.unknown).toEqual([]);
    });

    it.each([
      [["-k5"], "5"],
      [["-kabc"], "abc"],
      [["-yk5"], "5"],
      [["-yk", "5"], "5"],
    ])("reads a value option's value from the rest of the token or the next (%j)", (argv, value) => {
      const parsed = short(argv);
      expect(parsed.values.k).toBe(value);
      expect(parsed.unknown).toEqual([]);
      expect(parsed.positionals).toEqual([]);
    });

    it("reads -k=5 as 5, a documented divergence (click reads '=5')", () => {
      const parsed = short(["-k=5"]);
      expect(parsed.values.k).toBe("5");
      expect(parsed.unknown).toEqual([]);
    });

    it("reports a value option at the end of a cluster with nothing after it", () => {
      expect(short(["-yk"]).missingValue).toEqual(["-k"]);
    });

    it("reports the first letter that is no option, as click does for -y=1", () => {
      expect(short(["-y=1"]).unknown).toEqual(["-="]);
      expect(short(["-yx"]).unknown).toEqual(["-x"]);
    });
  });

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

  it("lists every problem in argv order, so the first is the one click reports", () => {
    const parsed = parse(["cmd", "--scope", "-xyz", "--json=1", "--porfile", "--help", "-c"]);
    expect(parsed.problems).toEqual([
      { kind: "missingValue", name: "--scope" },
      { kind: "unknown", name: "-x" },
      { kind: "noValue", name: "--json" },
      { kind: "unknown", name: "--porfile" },
      { kind: "missingValue", name: "-c" },
    ]);
    expect(parsed.unknown).toEqual(["-x", "--porfile"]);
    expect(parsed.noValue).toEqual(["--json"]);
    expect(parsed.missingValue).toEqual(["--scope", "-c"]);
    // --help is still read; the caller decides which wins.
    expect(parsed.flags.has("help")).toBe(true);
    expect(parse(["cmd", "--json"]).problems).toEqual([]);
  });

  it("takes a negative number in any decimal digits as a value, as float() reads it", () => {
    const parsed = parse(["cmd", "--importance", "-\u{661}.\u{665}"]);
    expect(parsed.values.importance).toBe("-\u{661}.\u{665}");
    expect(parsed.problems).toEqual([]);
  });

  // --- negative numbers as values ----------------------------------------

  it.each([
    ["--importance", "-0.5", "importance"],
    ["-i", "-3", "importance"],
    ["--importance", "-1e-2", "importance"],
  ])("accepts a negative number as the value of %s", (flag, value, name) => {
    // Measured against the real Python CLI: `--bm25 -0.1` reaches the range
    // check, so click parsed it as a value. Treating every dash-prefixed
    // token as "value missing" made every negative number unreachable.
    const parsed = parse(["cmd", flag, value]);
    expect(parsed.values[name]).toBe(value);
    expect(parsed.missingValue).toEqual([]);
  });

  it("still refuses a registered flag as a value", () => {
    const parsed = parse(["cmd", "--importance", "--json"]);
    expect(parsed.missingValue).toEqual(["--importance"]);
    expect(parsed.flags.has("json")).toBe(true);
  });

  it("still refuses a non-numeric short token as a value", () => {
    // Click would take "-x" as the value; that turns a typo into a silent
    // wrong value, so this stays stricter on purpose.
    const parsed = parse(["cmd", "--scope", "-x"]);
    expect(parsed.missingValue).toEqual(["--scope"]);
  });

  it("takes a dash-prefixed token as the value of a dashValue flag", () => {
    // An invite token is base64url, so about one in 64 begins with "-".
    // Under the default rule it would be reported as an unknown option —
    // and that error quotes it.
    const spec: ParseSpec = { flags: [{ name: "invite", type: "value", dashValue: true }] };
    const parsed = parseArgs(["login", "--invite", "-AbCdEfGhIjKlMnOpQrSt"], spec);
    expect(parsed.values.invite).toBe("-AbCdEfGhIjKlMnOpQrSt");
    expect(parsed.unknown).toEqual([]);
    expect(parsed.missingValue).toEqual([]);
  });

  it("still reports a dashValue flag at the end of argv as missing its value", () => {
    const spec: ParseSpec = { flags: [{ name: "invite", type: "value", dashValue: true }] };
    expect(parseArgs(["login", "--invite"], spec).missingValue).toEqual(["--invite"]);
  });

  it("gives an optional dashValue flag any next token, and its flagValue only at the end", () => {
    // The refused `--invite` of the other auth subcommands: a dash-led token
    // is still its value, and a bare one is present rather than missing.
    const spec: ParseSpec = { flags: [{ name: "invite", type: "optional", dashValue: true, flagValue: "" }] };
    const dashed = parseArgs(["status", "--invite", "-AbCd", "--help"], spec);
    expect(dashed.values.invite).toBe("-AbCd");
    expect(dashed.problems).toEqual([]);
    expect(dashed.flags.has("help")).toBe(true);
    const bare = parseArgs(["status", "--invite"], spec);
    expect(bare.values.invite).toBe("");
    expect(bare.problems).toEqual([]);
  });

  it("still reports a bare negative number that no option is waiting for", () => {
    // The numeric exception applies only where a value is expected. On its
    // own, `-5` is what click calls "No such option" — reporting it beats
    // demoting it to a positional that some command silently ignores.
    expect(parse(["cmd", "-5"]).unknown).toEqual(["-5"]);
    expect(parse(["cmd", "-5"]).positionals).toEqual([]);
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

  it("reports the unknown letter of a mixed cluster", () => {
    // `-vx` is "verbose, then no such option -x", as click reads it.
    expect(parse(["process", "-vx"]).unknown).toEqual(["-x"]);
  });

  // --- -h ----------------------------------------------------------------

  it("reports -h=x rather than reading it as a request for help", () => {
    // A malformed option is not a help request. The guard used to accept
    // any token whose body was "h", inline value and all.
    const parsed = parse(["cmd", "-h=x"]);
    expect(parsed.flags.has("help")).toBe(false);
    expect(parsed.unknown).toEqual(["-h"]);
  });

  it("lets a command that registers -h keep it", () => {
    // The old guard checked the LONG map for "h", which can never
    // contain a short name — so it was always true and a command could
    // not have reclaimed -h even in principle.
    const withShortH: ParseSpec = {
      flags: [{ name: "height", short: "h", type: "value" }],
    };
    const parsed = parseArgs(["cmd", "-h", "10"], withShortH);
    expect(parsed.values.height).toBe("10");
    expect(parsed.flags.has("help")).toBe(false);
  });

  // --- the -- end-of-options marker --------------------------------------

  it("treats everything after -- as positional, dashes and all", () => {
    // Click terminates option parsing at `--` on every command. Without
    // it there is no way to pass a value that starts with a dash, and
    // `recall -- -5` reported "Unknown option: -5" — measured against the
    // Python CLI, which accepts the same argv.
    const parsed = parse(["recall", "--", "-5", "--json"]);
    expect(parsed.positionals).toEqual(["-5", "--json"]);
    expect(parsed.unknown).toEqual([]);
    expect(parsed.flags.has("json")).toBe(false);
  });

  it("consumes the -- itself rather than passing it on", () => {
    // Keeping it would hand every command an extra argument it did not
    // ask for, which `rejectExtraArgs` then reports.
    expect(parse(["use", "--", "work"]).positionals).toEqual(["work"]);
  });

  it("still parses options that appear before --", () => {
    const parsed = parse(["recall", "--profile", "work", "--", "-5"]);
    expect(parsed.values.profile).toBe("work");
    expect(parsed.positionals).toEqual(["-5"]);
  });

  it("keeps a second -- as a literal positional", () => {
    expect(parse(["cmd", "--", "a", "--", "b"]).positionals).toEqual(["a", "--", "b"]);
  });

  // --- passthrough (stopAtPositional) ------------------------------------

  it("hands everything after the first positional back unparsed", () => {
    const parsed = parseArgs(["--profile", "p", "ls", "-la"], SPEC, { stopAtPositional: true });
    expect(parsed.values.profile).toBe("p");
    expect(parsed.rest).toEqual(["ls", "-la"]);
    // `-la` is the child's flag, not an unknown option of ours.
    expect(parsed.unknown).toEqual([]);
  });

  it("strips a leading -- separator from the remainder", () => {
    const parsed = parseArgs(["--profile", "p", "--", "ls", "-la"], SPEC, { stopAtPositional: true });
    expect(parsed.rest).toEqual(["ls", "-la"]);
  });

  it("keeps a -- that appears inside the remainder", () => {
    // Only the FIRST separator is ours; a second one belongs to the child.
    const parsed = parseArgs(["--", "sh", "-c", "--", "x"], SPEC, { stopAtPositional: true });
    expect(parsed.rest).toEqual(["sh", "-c", "--", "x"]);
  });

  it("leaves rest empty when there is no positional", () => {
    expect(parseArgs(["--profile", "p"], SPEC, { stopAtPositional: true }).rest).toEqual([]);
  });

  it("still reports an unknown option that appears BEFORE the positional", () => {
    const parsed = parseArgs(["--nope", "ls"], SPEC, { stopAtPositional: true });
    expect(parsed.unknown).toEqual(["--nope"]);
  });

  it("does not collect a remainder without the option", () => {
    expect(parseArgs(["ls", "-la"], SPEC).rest).toEqual([]);
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

/** Every positional, the one lifted into `command` included. */
function positionalsOf(parsed: ReturnType<typeof parseArgs>): string[] {
  return parsed.command === undefined ? parsed.positionals : [parsed.command, ...parsed.positionals];
}

describe("parseArgs: an option whose value may be omitted (click is_flag=False, flag_value)", () => {
  // Every row was measured on click 8.3.3 with
  // `@click.option("--agents-md", is_flag=False, flag_value="", metavar="[PATH]")`,
  // except the one marked as a deliberate difference.
  const OPTIONAL: ParseSpec = {
    flags: [
      { name: "agents-md", type: "optional", metavar: "[PATH]" },
      { name: "yes", short: "y", type: "switch" },
      { name: "dry-run", type: "switch" },
    ],
  };
  const parseOptional = (argv: string[]) => parseArgs(argv, OPTIONAL);

  it("is absent when not given", () => {
    expect(parseOptional([]).values["agents-md"]).toBeUndefined();
  });

  it.each([
    [["--agents-md"], ""],
    [["--agents-md", "p.md"], "p.md"],
    [["--agents-md", "-"], "-"],
    [["--agents-md", ""], ""],
    [["--agents-md="], ""],
    [["--agents-md=x.md"], "x.md"],
    [["--agents-md=~/n.md"], "~/n.md"],
  ])("reads %j as %j", (argv, expected) => {
    const parsed = parseOptional(argv);
    expect(parsed.values["agents-md"]).toBe(expected);
    expect(parsed.missingValue).toEqual([]);
    expect(positionalsOf(parsed)).toEqual([]);
  });

  it.each([
    [["--agents-md", "-y"], "yes"],
    [["--agents-md", "--dry-run"], "dry-run"],
  ])("leaves a following option to be parsed as one (%j)", (argv, flag) => {
    const parsed = parseOptional(argv);
    expect(parsed.values["agents-md"]).toBe("");
    expect(parsed.flags.has(flag)).toBe(true);
  });

  it("does not take even a negative number, as click does not", () => {
    // click: `--agents-md -5` is the default path, then "No such option: -5".
    const parsed = parseOptional(["--agents-md", "-5"]);
    expect(parsed.values["agents-md"]).toBe("");
    expect(parsed.unknown).toEqual(["-5"]);
  });

  it("does not take `--`, which still ends the options", () => {
    const parsed = parseOptional(["--agents-md", "--", "-y"]);
    expect(parsed.values["agents-md"]).toBe("");
    expect(parsed.flags.has("yes")).toBe(false);
    expect(positionalsOf(parsed)).toEqual(["-y"]);
  });

  it("takes --flag=VALUE literally even when VALUE begins with a dash", () => {
    // Deliberately not click: click drops `-y` as the value and parses it
    // as an option, so `--agents-md=-y` would silently answer yes.
    const parsed = parseOptional(["--agents-md=-y"]);
    expect(parsed.values["agents-md"]).toBe("-y");
    expect(parsed.flags.has("yes")).toBe(false);
  });

  it("reads as its flagValue when one is declared", () => {
    const spec: ParseSpec = { flags: [{ name: "out", type: "optional", flagValue: "default.md" }] };
    expect(parseArgs(["--out"], spec).values.out).toBe("default.md");
    expect(parseArgs(["--out", "x"], spec).values.out).toBe("x");
  });

  it("works in its short form too", () => {
    const spec: ParseSpec = {
      flags: [
        { name: "agents-md", short: "a", type: "optional" },
        { name: "yes", short: "y", type: "switch" },
      ],
    };
    expect(parseArgs(["-a"], spec).values["agents-md"]).toBe("");
    expect(parseArgs(["-a", "p.md"], spec).values["agents-md"]).toBe("p.md");
    expect(parseArgs(["-ap.md"], spec).values["agents-md"]).toBe("p.md");
    const cluster = parseArgs(["-ya"], spec);
    expect(cluster.flags.has("yes")).toBe(true);
    expect(cluster.values["agents-md"]).toBe("");
  });
});

describe("parseArgs: ignoreUnknownOptions (click ignore_unknown_options=True)", () => {
  // Measured on click 8.3.3 with `--unit` (value), `-y` (switch) and `-u`
  // (value), both short-only, and ignore_unknown_options=True.
  const LOOSE: ParseSpec = {
    flags: [
      { name: "unit", type: "value" },
      { name: "y", short: "y", type: "switch", shortOnly: true },
      { name: "u", short: "u", type: "value", shortOnly: true },
      { name: "json", type: "switch" },
    ],
  };
  const parseLoose = (argv: string[]) => parseArgs(argv, LOOSE, { ignoreUnknownOptions: true });

  it.each([
    [["-3.5"], ["-3.5"]],
    [["C", "pnl", "-120"], ["C", "pnl", "-120"]],
    [["x", "--weight", "--metric=w"], ["x", "--weight", "--metric=w"]],
    [["x", "-x=5"], ["x", "-x=5"]],
    [["--yes"], ["--yes"]],
    [["-"], ["-"]],
    [["x", "--", "-h"], ["x", "-h"]],
  ])("keeps the unknown options of %j whole, in order", (argv, expected) => {
    const parsed = parseLoose(argv);
    expect(positionalsOf(parsed)).toEqual(expected);
    expect(parsed.unknown).toEqual([]);
  });

  it("still reads the declared options wherever they are", () => {
    const parsed = parseLoose(["--unit", "USD", "C", "pnl", "-3.5"]);
    expect(parsed.values.unit).toBe("USD");
    expect(positionalsOf(parsed)).toEqual(["C", "pnl", "-3.5"]);
    const late = parseLoose(["x", "--unit=kg", "-5"]);
    expect(late.values.unit).toBe("kg");
    expect(positionalsOf(late)).toEqual(["x", "-5"]);
  });

  it.each([
    [["x", "-xyz"], "-xz", undefined],
    [["x", "-yx"], "-x", undefined],
    [["x", "-xu", "kg"], "-x", "kg"],
    [["x", "-xukg"], "-x", "kg"],
  ])("splits a short cluster %j as click does", (argv, kept, u) => {
    const parsed = parseLoose(argv);
    expect(positionalsOf(parsed)).toEqual(["x", kept]);
    expect(parsed.flags.has("y")).toBe(argv[1]!.includes("y"));
    expect(parsed.values.u).toBe(u);
  });

  it("keeps -h and --help as help", () => {
    // `-h` is this bin's alias for --help everywhere; click, which has no
    // -h, would keep it as an argument.
    expect(parseLoose(["-h"]).flags.has("help")).toBe(true);
    expect(parseLoose(["x", "--help"]).flags.has("help")).toBe(true);
  });

  it("still reports a switch given a value and a value option with none", () => {
    expect(parseLoose(["--json=1"]).noValue).toEqual(["--json"]);
    expect(parseLoose(["x", "--unit"]).missingValue).toEqual(["--unit"]);
  });

  it("is off by default: -3.5 is then an unknown -3", () => {
    expect(parseArgs(["-3.5"], LOOSE).unknown).toEqual(["-3"]);
  });
});

describe("parseArgs: Python's number grammar for dash tokens", () => {
  it("takes a negative number with underscores as a value", () => {
    const spec: ParseSpec = { flags: [{ name: "limit", type: "value" }] };
    expect(parseArgs(["--limit", "-1_000"], spec).values.limit).toBe("-1_000");
  });
});
