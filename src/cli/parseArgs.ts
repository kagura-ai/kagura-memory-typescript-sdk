/**
 * Minimal argv parser for the `auth` bin.
 *
 * Hand-rolled because this package's zero-runtime-dependency invariant is
 * deliberate — pulling in commander to read six flags would trade that
 * away for very little. Scope is correspondingly small: long flags,
 * `-h`, and positionals. No short-flag clustering, no `--`, no negation.
 *
 * Unknown and value-less flags are *reported* rather than ignored or
 * thrown on, so the caller can print one message listing everything wrong
 * instead of failing on the first problem.
 */

/** Flags that take a value; everything else is a boolean switch. */
const VALUE_FLAGS = new Set(["profile", "server", "scope"]);

/**
 * Boolean switches, so a following token is never mistaken for a value.
 *
 * Only flags a command actually reads belong here: an entry with no
 * implementation is accepted and silently ignored, which is worse than
 * being reported as unknown.
 */
const SWITCHES = new Set(["read-only", "no-browser", "all", "yes", "help"]);

export interface ParsedArgs {
  /** First non-flag token, or `""` when absent. */
  command: string;
  /** Remaining non-flag tokens. */
  positionals: string[];
  /** Boolean switches that were present. */
  flags: Set<string>;
  /** Values for flags in {@link VALUE_FLAGS}. */
  values: Record<string, string | undefined>;
  /** Flags that match neither set, verbatim (e.g. `--porfile`). */
  unknown: string[];
  /** Value flags that ran out of argv before their value. */
  missingValue: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values: Record<string, string | undefined> = {};
  const unknown: string[] = [];
  const missingValue: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "-h") {
      flags.add("help");
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);

    if (VALUE_FLAGS.has(name)) {
      if (eq !== -1) {
        // `--profile=` is an explicit empty value, not a missing one.
        values[name] = token.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      // Any following flag means the value was omitted, not that the flag
      // is the value — `--profile --yes` must not set profile="--yes",
      // and `--profile -h` is a request for help, not a profile named
      // "-h". Short flags count: checking only "--" swallowed them.
      if (next === undefined || next.startsWith("-")) {
        missingValue.push(token);
        continue;
      }
      values[name] = next;
      i++;
      continue;
    }

    if (SWITCHES.has(name)) {
      flags.add(name);
      continue;
    }
    unknown.push(token);
  }

  return {
    command: positionals.shift() ?? "",
    positionals,
    flags,
    values,
    unknown,
    missingValue,
  };
}
