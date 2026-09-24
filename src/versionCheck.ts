/**
 * The SDK's one version parser, for memory-cloud server versions — the
 * port of the Python SDK's `_version.py` (its #280).
 *
 * `KaguraClient.checkServerVersion` and the CLI's invite check
 * (`cli/invite.ts`) both compare a version string with a minimum. They read
 * the string here, so one string gets one verdict, and it is the verdict
 * the Python SDK gives.
 *
 * A version is `v?MAJOR.MINOR.PATCH` at the start of the string, in ASCII
 * digits, with letters read in any case as PEP 440 does (`V1.2.3`,
 * `.POST1`). What follows the triple says whether it is a release or a
 * pre-release:
 *
 * - **Release:** nothing, `+build` (SemVer build metadata, a PEP 440 local
 *   version), more `.N` components (`1.2.3.4`) or `.postN`.
 * - **Pre-release:** anything else, e.g. `-rc1` (SemVer), `rc1` / `a1` /
 *   `.dev1` (PEP 440), or stray text such as `.rc1` or `_x`. That includes
 *   PEP 440's other post-release spellings (`post1`, `-post1`, `-1`, `r1`,
 *   `.rev1`): only `.postN` is read as one.
 *
 * A pre-release of a triple comes before that triple (SemVer §11, PEP 440)
 * and after every lower one. Anything else is unparseable: a non-string,
 * fewer than three components (`0.76`), or text such as `main-abc123`.
 *
 * @internal Not part of the package's API, as `_version.py` is not part of
 *   the Python SDK's.
 */

/**
 * One component: at most 32 significant digits, so a longer one is
 * unparseable, as in Python, whose `int()` would otherwise hit its
 * str-digit limit. Leading zeros are skipped, not counted, as PEP 440 reads
 * them (`1.82.0007` is 1.82.7), and a run of them is a lone 0 so a mismatch
 * backtracks in linear time. `\d` is ASCII-only in JavaScript, which is
 * Python's `re.ASCII`.
 */
const COMPONENT = String.raw`0*([1-9]\d{0,31}|0)`;
/** `(?!\d)` keeps a longer patch from being cut to its first 32 digits. */
const VERSION_RE = new RegExp(String.raw`^v?${COMPONENT}\.${COMPONENT}\.${COMPONENT}(?!\d)`, "i");
/** What may follow the triple of a release; `[\s\S]` is Python's DOTALL `.`. */
const RELEASE_TAIL_RE = /^(?:\.\d+)*(?:\.post\d*)?(?:\+[\s\S]*)?$/i;

/** A `[major, minor, patch]` triple. BigInt: 32 digits exceed 2^53. */
export type VersionTriple = readonly [bigint, bigint, bigint];

function parse(value: unknown): { triple: VersionTriple; prerelease: boolean } | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = VERSION_RE.exec(value);
  if (match === null) {
    return null;
  }
  return {
    triple: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease: !RELEASE_TAIL_RE.test(value.slice(match[0].length)),
  };
}

/**
 * The `[major, minor, patch]` a version string starts with.
 *
 * A pre-release returns its triple too (`"0.76.0-rc1"` gives
 * `[0n, 76n, 0n]`); use {@link meetsMinimum} to compare against a minimum.
 *
 * @param value The version, e.g. `ServerInfo.version`. Any type is accepted.
 * @returns The triple, or `null` when `value` is not a string or does not
 *   start with `v?MAJOR.MINOR.PATCH`.
 */
export function parseVersion(value: unknown): VersionTriple | null {
  return parse(value)?.triple ?? null;
}

/**
 * Whether a version is at least `minimum`.
 *
 * A pre-release of exactly `minimum` is below it (`"0.75.0-rc1"` does not
 * meet `[0, 75, 0]`); a pre-release of a higher triple is above it
 * (`"0.75.1-rc1"` does).
 *
 * @param value The version, e.g. `ServerInfo.version`. Any type is accepted.
 * @param minimum The lowest acceptable release.
 * @returns `true` or `false`, or `null` when `value` is unparseable (see
 *   {@link parseVersion}), so the caller picks its own fallback.
 */
export function meetsMinimum(
  value: unknown,
  minimum: readonly [number | bigint, number | bigint, number | bigint],
): boolean | null {
  const parsed = parse(value);
  if (parsed === null) {
    return null;
  }
  for (let i = 0; i < 3; i++) {
    const have = parsed.triple[i]!;
    const want = BigInt(minimum[i]!);
    if (have !== want) {
      return have > want;
    }
  }
  return !parsed.prerelease;
}

/**
 * {@link parseVersion} for a version constant of the SDK's own, which must
 * parse: a malformed one fails at import, as Python's does, rather than
 * making every comparison against it silently unparseable.
 */
export function requireVersion(value: string, name: string): VersionTriple {
  const triple = parseVersion(value);
  if (triple === null) {
    throw new Error(`${name} is not MAJOR.MINOR.PATCH: ${JSON.stringify(value)}`);
  }
  return triple;
}
