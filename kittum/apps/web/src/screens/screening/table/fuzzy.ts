// The table's quick search: every word of the query must occur in the record. A word matches the
// title, authors, or journal as written or with a typo or two (by edit distance on whole words),
// and the abstract as written. Accents and case do not matter. Our own small matcher: a library
// would bring ranking we do not want for a list a reviewer sorts themselves.

/** A record's text, prepared once for every query. */
export interface Haystack {
  /** Title, authors, and journal, normalized. */
  readonly short: string;
  readonly words: ReadonlyArray<string>;
  /** The abstract, normalized. */
  readonly long: string;
}

const normalize = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const WORD = /[\p{L}\p{N}]+/gu;

export const haystack = (short: ReadonlyArray<string>, long: string): Haystack => {
  const text = normalize(short.join(" \u0001 "));
  return { short: text, words: [...new Set(text.match(WORD) ?? [])], long: normalize(long) };
};

/** The edit distance between `a` and `b` if it is at most `limit`, else `limit + 1`. Adjacent
 * swaps count as one edit. */
export const distance = (a: string, b: string, limit: number): number => {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(
        (previous[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d = Math.min(d, (before[j - 2] ?? 0) + 1);
      row.push(d);
      best = Math.min(best, d);
    }
    if (best > limit) return limit + 1;
    before = previous;
    previous = row;
  }
  return previous[b.length] ?? limit + 1;
};

/** Typos allowed in a word of the query: none in short words, where a typo is another word. */
const tolerance = (word: string) => (word.length < 5 ? 0 : word.length < 9 ? 1 : 2);

/**
 * A matcher for `query`: a score above zero for a record that matches every word, higher for
 * matches in the title, authors, or journal than in the abstract; zero otherwise. Null for an
 * empty query.
 */
export const matcher = (query: string): ((h: Haystack) => number) | null => {
  const terms = [...new Set(normalize(query).match(WORD) ?? [])];
  if (terms.length === 0) return null;
  return (h) => {
    let score = 0;
    for (const term of terms) {
      if (h.short.includes(term)) {
        score += 3;
        continue;
      }
      const limit = tolerance(term);
      // A typo: the term against each word, or against the start of a longer word.
      if (
        limit > 0 &&
        h.words.some(
          (w) =>
            distance(term, w, limit) <= limit ||
            (w.length > term.length && distance(term, w.slice(0, term.length), limit) <= limit),
        )
      ) {
        score += 2;
        continue;
      }
      if (h.long.includes(term)) {
        score += 1;
        continue;
      }
      return 0;
    }
    return score;
  };
};
