/**
 * `difflib.get_close_matches`, the port of what click calls to suggest an
 * option for an unknown one: `No such option: --js Did you mean --json?`.
 *
 * Python's `SequenceMatcher` scores a pair by the characters its matching
 * blocks cover, `2 * M / (len(a) + len(b))`, where the blocks are found by
 * taking the longest common run, then recursing on either side of it. The
 * score depends on which run is taken first among equals, so this follows
 * CPython's `find_longest_match` and `get_matching_blocks` step for step,
 * `autojunk` included, rather than computing a textbook LCS.
 */

/** A matched run: `a[i:i+size] == b[j:j+size]`. */
type Match = [i: number, j: number, size: number];

/**
 * `SequenceMatcher(None, a, b)`'s view of `b`: each element's indexes in
 * `b`, less the "popular" elements `autojunk` purges from a `b` of 200 or
 * more elements (those making up more than 1% of it, plus one).
 */
function indexB(b: readonly string[]): Map<string, number[]> {
  const b2j = new Map<string, number[]>();
  b.forEach((element, j) => {
    const indexes = b2j.get(element);
    if (indexes === undefined) b2j.set(element, [j]);
    else indexes.push(j);
  });
  if (b.length >= 200) {
    const ntest = Math.floor(b.length / 100) + 1;
    for (const [element, indexes] of [...b2j]) {
      if (indexes.length > ntest) b2j.delete(element);
    }
  }
  return b2j;
}

/** `find_longest_match(alo, ahi, blo, bhi)` with no junk function. */
function findLongestMatch(
  a: readonly string[],
  b: readonly string[],
  b2j: Map<string, number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): Match {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    for (const j of b2j.get(a[i]!) ?? []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = newj2len;
  }
  // Extend over the popular elements autojunk left out of b2j (no element
  // is junk here, so CPython's two junk-extension loops never run).
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti -= 1;
    bestj -= 1;
    bestsize += 1;
  }
  while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
    bestsize += 1;
  }
  return [besti, bestj, bestsize];
}

/** The number of elements `get_matching_blocks()` matches. */
function matchedCount(a: readonly string[], b: readonly string[]): number {
  const b2j = indexB(b);
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  let matched = 0;
  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (k === 0) continue;
    matched += k;
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  return matched;
}

/** `SequenceMatcher(None, a, b).ratio()`, over code points as Python iterates a str. */
export function sequenceRatio(a: string, b: string): number {
  const seqA = Array.from(a);
  const seqB = Array.from(b);
  const length = seqA.length + seqB.length;
  return length === 0 ? 1 : (2 * matchedCount(seqA, seqB)) / length;
}

/**
 * `difflib.get_close_matches(word, possibilities, n, cutoff)`: the
 * possibilities scoring at least `cutoff` against `word`, best first, at
 * most `n` of them. Among equal scores the greater string comes first, as
 * `heapq.nlargest` orders the `(score, x)` pairs.
 */
export function getCloseMatches(
  word: string,
  possibilities: Iterable<string>,
  n = 3,
  cutoff = 0.6,
): string[] {
  const scored: Array<[number, string]> = [];
  for (const x of possibilities) {
    // Python's matcher holds `word` as its second sequence.
    const score = sequenceRatio(x, word);
    if (score >= cutoff) scored.push([score, x]);
  }
  scored.sort(([s1, x1], [s2, x2]) => s2 - s1 || (x1 < x2 ? 1 : x1 > x2 ? -1 : 0));
  return scored.slice(0, n).map(([, x]) => x);
}
