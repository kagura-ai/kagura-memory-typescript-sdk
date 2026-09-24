/**
 * Minimal argv parser for the `kagura-memory` bin.
 *
 * Hand-rolled because this package's zero-runtime-dependency invariant is
 * deliberate — pulling in commander to read flags would trade that away.
 * Scope is correspondingly small: long flags, registered short flags
 * (combined as click combines them: `-yv`, `-k5`), repeatable count and
 * multiple flags, options whose value may be omitted, positionals, and
 * `--` as the end-of-options marker. No negation.
 *
 * Each command passes its own {@link ParseSpec}. That is the point: a flag
 * that is real for `auth login` must still be *rejected* by `recall`,
 * which has no such option. A single global flag set would accept it and
 * silently ignore it, which is the failure mode this parser exists to
 * prevent.
 *
 * Unknown and value-less flags are *reported* rather than ignored or
 * thrown on, in argv order, so the caller can report the first as click
 * does, even when `--help` follows it. They are reported by the name
 * click's error gives them, never with a value written into the token.
 */

import { PY_FLOAT, pyFloat } from "../python.js";

/**
 * One option a command accepts.
 *
 * Help text lives here rather than in a parallel table so a flag is
 * declared exactly once: a spec entry with no help line, or a help line
 * for a flag that was never registered, is not a state this can reach.
 */
export interface FlagSpec {
  /** Long name, written without the leading `--`. */
  name: string;
  /** Optional single-character alias, written without the leading `-`. */
  short?: string;
  /**
   * `value` takes an argument, `switch` is a boolean, `count` is a
   * repeatable verbosity dial, `multiple` accumulates every occurrence
   * (click's `multiple=True`), `optional` takes an argument that may be
   * left out (click's `is_flag=False, flag_value=…`, as in
   * `--agents-md [PATH]`). Defaults to `switch`.
   *
   * An `optional` flag given alone reads as {@link FlagSpec.flagValue}.
   * Given `--flag VALUE`, it takes the next token only when that does not
   * look like an option, as click decides it: a token of more than one
   * character that begins with `-` is left to be parsed as the next option
   * (even `-5`), and a lone `-` is taken. `--flag=VALUE` takes VALUE
   * literally, even when it begins with `-`, where click drops such a
   * value and parses it as an option instead (`--agents-md=-y` would
   * silently set `-y`).
   */
  type?: "value" | "switch" | "count" | "multiple" | "optional";
  /** What an `optional` flag given without a value reads as (default `""`). */
  flagValue?: string;
  /** One-line description for `--help`. */
  help?: string;
  /** Value placeholder shown in `--help` (default: `TEXT` for value flags). */
  metavar?: string;
  /** Rendered as `[default: …]` in `--help`. */
  defaultLabel?: string;
  /** Reported as missing when absent; see `requireOption`. */
  required?: boolean;
  /**
   * Reject `--flag=` (an explicitly empty value).
   *
   * Off by default, because Python accepts an empty value everywhere and
   * several options *rely* on it: `--context-id=` falls through to the
   * config via Python's `or` chain, and `--tags=` / `--details=` treat
   * blank as unset so an unset shell variable is not a hard error.
   *
   * On only where an empty value would do damage rather than nothing —
   * `--profile=` would create a nameless profile and `--scope=` would send
   * an empty scope to the server. That is a deliberate divergence from
   * click, inherited from the auth-only bin, and it stays scoped to the
   * flags that motivated it.
   */
  rejectEmpty?: boolean;
  /**
   * Register only the short form.
   *
   * `kagura recall -k 5` is declared in Python as `@click.option("-k")`
   * with no long form, so `--k` is an unknown option there. Accepting it
   * here would be a superset — small, but the kind of drift that makes
   * "the two CLIs take the same flags" stop being literally true.
   */
  shortOnly?: boolean;
  /**
   * Take the next token as the value even when it begins with a dash.
   *
   * For `--invite`: an invite token is base64url, so about one in 64
   * starts with `-`. Under the default rule `--invite -Ab…` reads as a
   * missing value followed by short options: the token — a sign-up
   * credential — read a letter at a time, and its first letter that is no
   * option named in the error. Click consumes whatever
   * follows a value option anyway; this restores that for the one flag
   * whose values need it, and the flag's own validation catches a flag
   * that was swallowed by mistake. On an `optional` flag it takes any next
   * token the same way, and reads as {@link FlagSpec.flagValue} only when
   * none follows.
   */
  dashValue?: boolean;
  /**
   * Parse the flag but leave it out of `--help`.
   *
   * For a flag a command declares only to refuse it: `--invite` on the
   * `auth` subcommands other than `login`. Parsed, its value is consumed
   * rather than read as options of its own when it begins with `-`;
   * listed, it would advertise an option the command does not take.
   */
  hidden?: boolean;
  /**
   * Declared only to be refused: given at all, with a value or without,
   * the command prints this line and exits 2 before anything else runs,
   * `--help` included, as click's "No such option" would.
   */
  refusal?: string;
}

export interface ParseSpec {
  flags: readonly FlagSpec[];
}

export interface ParseOptions {
  /**
   * Stop parsing options at the first positional and hand the remainder
   * back untouched in {@link ParsedArgs.rest}.
   *
   * This is click's `allow_interspersed_args=False` +
   * `ignore_unknown_options=True`, which `secret exec` needs: the tokens
   * after the command name belong to the *child*, so `-la` in
   * `secret exec --as A=s -- ls -la` is an argument to `ls`, not an
   * unknown option of ours.
   */
  stopAtPositional?: boolean;
  /**
   * Keep an option the spec does not declare as a positional, whole,
   * instead of reporting it: click's `ignore_unknown_options=True`, which
   * `measure record` needs so that `-3.5` is a VALUE rather than an
   * unknown `-3`. A long token is kept as written, `--metric=x` included.
   * A short cluster is read as click reads it: its declared letters still
   * act, and the rest are kept together as one `-` token (`-3.5` whole;
   * `-yx` sets `-y` and keeps `-x`). `-h` alone still asks for help, and
   * `--` still ends the options.
   */
  ignoreUnknownOptions?: boolean;
}

/** One option problem in argv, of the three kinds click's parser raises. */
export interface ParseProblem {
  /**
   * `unknown`: no such option; `noValue`: a switch given a value
   * (`--json=true`); `missingValue`: an option that takes a value, given
   * none.
   */
  kind: "unknown" | "noValue" | "missingValue";
  /** The option as click's error names it, as typed: `--porfile`, `-x`, `-w`. */
  name: string;
}

export interface ParsedArgs {
  /**
   * First non-flag token, or `undefined` when there is none. An empty
   * argument (`''`) is a token like any other, as click passes it through.
   */
  command: string | undefined;
  /** Remaining non-flag tokens. */
  positionals: string[];
  /** Switches that were present, keyed by long name. */
  flags: Set<string>;
  /** Values for `value` flags, keyed by long name. */
  values: Record<string, string | undefined>;
  /** Accumulated values for `multiple` flags, keyed by long name. */
  many: Record<string, string[]>;
  /** Occurrence counts for `count` flags, keyed by long name; 0 when absent. */
  counts: Record<string, number>;
  /**
   * Options that match nothing in the spec, by the name click's "No such
   * option" gives: `--porfile` for `--porfile=work`, and `-x` for `-xVALUE`
   * or `-yx` (the first letter of a short cluster that is not an option).
   * Never with a value: one written into the token can be a credential.
   */
  unknown: string[];
  /** Switches given a value, `--json=true`, by name: click's "does not take a value". */
  noValue: string[];
  /** Value flags that ran out of argv before their value. */
  missingValue: string[];
  /**
   * Every entry of {@link ParsedArgs.unknown}, {@link ParsedArgs.noValue}
   * and {@link ParsedArgs.missingValue}, in argv order: click stops at the
   * first, so that is the one to report.
   */
  problems: ParseProblem[];
  /**
   * Unparsed remainder, when `stopAtPositional` was set. Empty otherwise.
   * A leading `--` separator is stripped; anything after it is verbatim.
   */
  rest: string[];
}

/** `--help` works on every command, so it never needs declaring. */
const HELP: FlagSpec = { name: "help", type: "switch" };

/**
 * Python's `float()` grammar, which the parser needs: a dash-prefixed
 * token that is a number is a *value*, not a flag. Defined with the other
 * Python semantics in `python.ts`.
 */
export { PY_FLOAT };

/** Option types that take an argument, always or when one is given. */
function takesValue(flag: FlagSpec): boolean {
  return flag.type === "value" || flag.type === "multiple" || flag.type === "optional";
}

interface Index {
  long: Map<string, FlagSpec>;
  short: Map<string, FlagSpec>;
}

function indexSpec(spec: ParseSpec): Index {
  const long = new Map<string, FlagSpec>([[HELP.name, HELP]]);
  const short = new Map<string, FlagSpec>();
  for (const flag of spec.flags) {
    if (flag.shortOnly !== true) long.set(flag.name, flag);
    if (flag.short !== undefined) short.set(flag.short, flag);
  }
  return { long, short };
}

export function parseArgs(
  argv: string[],
  spec: ParseSpec,
  options: ParseOptions = {},
): ParsedArgs {
  const { long, short } = indexSpec(spec);
  const stopAtPositional = options.stopAtPositional === true;
  const ignoreUnknown = options.ignoreUnknownOptions === true;
  let rest: string[] = [];

  const positionals: string[] = [];
  const flags = new Set<string>();
  const values: Record<string, string | undefined> = {};
  const counts: Record<string, number> = {};
  const many: Record<string, string[]> = {};
  // In argv order; `unknown`, `noValue` and `missingValue` are its slices.
  const problems: ParseProblem[] = [];
  const problem = (kind: ParseProblem["kind"], name: string) => void problems.push({ kind, name });
  const named = (kind: ParseProblem["kind"]) => problems.filter((p) => p.kind === kind).map((p) => p.name);

  // Registered count and multiple flags read as 0 / [] rather than
  // undefined, so callers can use them without a `?? 0` at every site.
  for (const flag of spec.flags) {
    if (flag.type === "count") counts[flag.name] = 0;
    if (flag.type === "multiple") many[flag.name] = [];
  }

  /**
   * Consume the value for `flag`, given how it was written.
   *
   * @returns the number of extra argv tokens eaten (0 or 1), or -1 when the
   *   value was missing.
   */
  const store = (flag: FlagSpec, value: string) => {
    if (flag.type === "multiple") many[flag.name]!.push(value);
    else values[flag.name] = value;
  };

  const takeValue = (flag: FlagSpec, inline: string | null, next: string | undefined): number => {
    if (inline !== null) {
      // `--profile=` is an explicit empty value, not a missing one.
      store(flag, inline);
      return 0;
    }
    // Any following flag means the value was omitted, not that the flag is
    // the value — `--profile --yes` must not set profile="--yes", nor
    // `--profile -h` a profile named "-h". The flag is reported as missing
    // its value; the token is read as what it looks like.
    //
    // A negative number is the exception: `--bm25 -0.1` and `--limit -5`
    // are values, and click accepts them. (Click is in fact laxer still —
    // it consumes whatever follows, so `--reranker -x` sets the value to
    // "-x" — but that turns a typo into a silent wrong value, so the
    // stricter rule stays.)
    if (
      next === undefined ||
      (flag.dashValue !== true && next.startsWith("-") && next.length > 1 && pyFloat(next) === undefined)
    ) {
      return -1;
    }
    store(flag, next);
    return 1;
  };

  const record = (flag: FlagSpec, inline: string | null, next: string | undefined, token: string) => {
    if (flag.type === "optional") {
      if (inline !== null) {
        store(flag, inline);
        return 0;
      }
      if (next === undefined || (flag.dashValue !== true && next.startsWith("-") && next.length > 1)) {
        store(flag, flag.flagValue ?? "");
        return 0;
      }
      store(flag, next);
      return 1;
    }
    if (flag.type === "value" || flag.type === "multiple") {
      const eaten = takeValue(flag, inline, next);
      if (eaten === -1) {
        problem("missingValue", token);
        return 0;
      }
      return eaten;
    }
    if (inline !== null) {
      // `--json=true`: accepting it would silently discard the value.
      // Named without it, as click names it.
      problem("noValue", token.slice(0, token.indexOf("=")));
      return 0;
    }
    if (flag.type === "count") counts[flag.name] = (counts[flag.name] ?? 0) + 1;
    else flags.add(flag.name);
    return 0;
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--") {
      if (stopAtPositional) {
        // Everything from here belongs to whoever we are handing off to.
        rest = argv.slice(i + 1);
        break;
      }
      // Click's end-of-options marker, on every command: what follows is
      // positional even when it starts with a dash, which is the only way
      // to pass `-5` or a filename beginning with one. The `--` itself is
      // consumed rather than kept, or every command would see an extra
      // argument it did not ask for.
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      if (stopAtPositional) {
        rest = argv.slice(i);
        break;
      }
      // A bare `-` is a conventional stdin placeholder, not a flag.
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inline = eq === -1 ? null : token.slice(eq + 1);
      const flag = long.get(name);
      if (flag === undefined) {
        if (ignoreUnknown) positionals.push(token);
        // `--x=value` is reported as `--x`: the value may be a secret.
        else problem("unknown", `--${name}`);
        continue;
      }
      i += record(flag, inline, argv[i + 1], token);
      continue;
    }

    // --- single dash ------------------------------------------------------
    const eq = token.indexOf("=");
    const body = eq === -1 ? token.slice(1) : token.slice(1, eq);
    const inline = eq === -1 ? null : token.slice(eq + 1);

    // `-h` is reserved for help on every command; no command registers it
    // for anything else. The `inline` check matters: `-h=x` is a malformed
    // option, not a request for help, and must fall through to be
    // reported.
    if (body === "h" && inline === null && !short.has("h")) {
      flags.add("help");
      continue;
    }

    // `-c value`, `-c=value`.
    const flag = short.get(body);
    if (flag !== undefined && (inline === null || takesValue(flag))) {
      i += record(flag, inline, argv[i + 1], token);
      continue;
    }

    // Anything else is read letter by letter, as click reads it: each a
    // registered switch or count (`-yv`, `-vvv`), until one that takes a
    // value, which takes the rest of the token (`-k5`) or else the next
    // one. The first letter that is no option is reported by itself, `-x`,
    // never with the rest of the token, which may be a value. Silently
    // demoting `-p work` to positionals instead would mean the flag is
    // ignored and the command runs with defaults — the same failure mode
    // as an accepted-but-unread switch.
    // By code point, as click reads a Python string. With
    // ignoreUnknownOptions, click collects the letters that are no option
    // and keeps them, rejoined behind one `-`, as a positional.
    const letters = Array.from(token.slice(1));
    const ignored: string[] = [];
    for (let at = 0; at < letters.length; at++) {
      const letter = letters[at]!;
      const option = short.get(letter);
      if (option === undefined) {
        if (ignoreUnknown) {
          ignored.push(letter);
          continue;
        }
        problem("unknown", `-${letter}`);
        break;
      }
      if (takesValue(option)) {
        const attached = letters.slice(at + 1).join("");
        i += record(option, attached === "" ? null : attached, argv[i + 1], `-${letter}`);
        break;
      }
      record(option, null, undefined, `-${letter}`);
    }
    if (ignored.length > 0) positionals.push(`-${ignored.join("")}`);
  }

  return {
    command: positionals.shift(),
    positionals,
    flags,
    values,
    counts,
    many,
    unknown: named("unknown"),
    noValue: named("noValue"),
    missingValue: named("missingValue"),
    problems,
    rest,
  };
}
