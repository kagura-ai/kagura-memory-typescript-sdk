/**
 * Minimal argv parser for the `kagura-memory` bin.
 *
 * Hand-rolled because this package's zero-runtime-dependency invariant is
 * deliberate — pulling in commander to read flags would trade that away.
 * Scope is correspondingly small: long flags, registered short flags,
 * repeatable count flags, and positionals. No general short-flag
 * clustering, no `--`, no negation.
 *
 * Each command passes its own {@link ParseSpec}. That is the point: a flag
 * that is real for `auth login` must still be *rejected* by `recall`,
 * which has no such option. A single global flag set would accept it and
 * silently ignore it, which is the failure mode this parser exists to
 * prevent.
 *
 * Unknown and value-less flags are *reported* rather than ignored or
 * thrown on, so the caller can print one message listing everything wrong
 * instead of failing on the first problem.
 */

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
   * repeatable verbosity dial. Defaults to `switch`.
   */
  type?: "value" | "switch" | "count";
  /** One-line description for `--help`. */
  help?: string;
  /** Value placeholder shown in `--help` (default: `TEXT` for value flags). */
  metavar?: string;
  /** Rendered as `[default: …]` in `--help`. */
  defaultLabel?: string;
  /** Reported as missing when absent; see `requireOption`. */
  required?: boolean;
  /**
   * Register only the short form.
   *
   * `kagura recall -k 5` is declared in Python as `@click.option("-k")`
   * with no long form, so `--k` is an unknown option there. Accepting it
   * here would be a superset — small, but the kind of drift that makes
   * "the two CLIs take the same flags" stop being literally true.
   */
  shortOnly?: boolean;
}

export interface ParseSpec {
  flags: readonly FlagSpec[];
}

export interface ParsedArgs {
  /** First non-flag token, or `""` when absent. */
  command: string;
  /** Remaining non-flag tokens. */
  positionals: string[];
  /** Switches that were present, keyed by long name. */
  flags: Set<string>;
  /** Values for `value` flags, keyed by long name. */
  values: Record<string, string | undefined>;
  /** Occurrence counts for `count` flags, keyed by long name; 0 when absent. */
  counts: Record<string, number>;
  /** Flags that match nothing in the spec, verbatim (e.g. `--porfile`). */
  unknown: string[];
  /** Value flags that ran out of argv before their value. */
  missingValue: string[];
}

/** `--help` works on every command, so it never needs declaring. */
const HELP: FlagSpec = { name: "help", type: "switch" };

/**
 * Python's `float()` grammar, shared with `parse.ts`.
 *
 * Lives here because the parser needs it too: a dash-prefixed token that
 * is a number is a *value*, not a flag.
 */
export const PY_FLOAT =
  /^[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)$/i;

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

export function parseArgs(argv: string[], spec: ParseSpec): ParsedArgs {
  const { long, short } = indexSpec(spec);

  const positionals: string[] = [];
  const flags = new Set<string>();
  const values: Record<string, string | undefined> = {};
  const counts: Record<string, number> = {};
  const unknown: string[] = [];
  const missingValue: string[] = [];

  // Registered count flags read as 0 rather than undefined, so callers can
  // compare numerically without a `?? 0` at every use.
  for (const flag of spec.flags) {
    if (flag.type === "count") counts[flag.name] = 0;
  }

  /**
   * Consume the value for `flag`, given how it was written.
   *
   * @returns the number of extra argv tokens eaten (0 or 1), or -1 when the
   *   value was missing.
   */
  const takeValue = (flag: FlagSpec, inline: string | null, next: string | undefined): number => {
    if (inline !== null) {
      // `--profile=` is an explicit empty value, not a missing one.
      values[flag.name] = inline;
      return 0;
    }
    // Any following flag means the value was omitted, not that the flag is
    // the value — `--profile --yes` must not set profile="--yes", and
    // `--profile -h` is a request for help, not a profile named "-h".
    //
    // A negative number is the exception: `--bm25 -0.1` and `--limit -5`
    // are values, and click accepts them. (Click is in fact laxer still —
    // it consumes whatever follows, so `--reranker -x` sets the value to
    // "-x" — but that turns a typo into a silent wrong value, so the
    // stricter rule stays.)
    if (next === undefined || (next.startsWith("-") && next.length > 1 && !PY_FLOAT.test(next))) {
      return -1;
    }
    values[flag.name] = next;
    return 1;
  };

  const record = (flag: FlagSpec, inline: string | null, next: string | undefined, token: string) => {
    if (flag.type === "value") {
      const eaten = takeValue(flag, inline, next);
      if (eaten === -1) {
        missingValue.push(token);
        return 0;
      }
      return eaten;
    }
    if (inline !== null) {
      // `--json=true` is not something this parser understands; accepting
      // it would silently discard the value.
      unknown.push(token);
      return 0;
    }
    if (flag.type === "count") counts[flag.name] = (counts[flag.name] ?? 0) + 1;
    else flags.add(flag.name);
    return 0;
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--" || !token.startsWith("-") || token === "-") {
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
        unknown.push(token);
        continue;
      }
      i += record(flag, inline, argv[i + 1], token);
      continue;
    }

    // --- single dash ------------------------------------------------------
    const eq = token.indexOf("=");
    const body = eq === -1 ? token.slice(1) : token.slice(1, eq);
    const inline = eq === -1 ? null : token.slice(eq + 1);

    if (body === "h" && !long.has("h")) {
      flags.add("help");
      continue;
    }

    const flag = short.get(body);
    if (flag !== undefined) {
      i += record(flag, inline, argv[i + 1], token);
      continue;
    }

    // `-vvv` — repetition of one registered count flag. Only same-letter
    // runs are understood; a mixed cluster like `-vx` is reported rather
    // than half-applied.
    if (inline === null && body.length > 1) {
      const first = body[0]!;
      const repeated = short.get(first);
      if (repeated?.type === "count" && body === first.repeat(body.length)) {
        counts[repeated.name] = (counts[repeated.name] ?? 0) + body.length;
        continue;
      }
    }

    // Silently demoting `-p work` to positionals means the flag is ignored
    // and the command runs with defaults — the same failure mode as an
    // accepted-but-unread switch.
    unknown.push(token);
  }

  return {
    command: positionals.shift() ?? "",
    positionals,
    flags,
    values,
    counts,
    unknown,
    missingValue,
  };
}
