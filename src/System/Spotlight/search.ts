// How Spotlight ranks what it finds. Pure, so search.check.ts can run it in Node.

/** Something to find: its title first, then other words it answers to. */
export interface Searchable {
  title: string;
  /** Weaker than the title: keywords, the app a command or window belongs to. */
  also?: readonly string[];
}

/**
 * How well one query word fits one text, 0 for not at all: the whole of it,
 * its start, the start of one of its words, anywhere in it, or its words'
 * initials ("nt" for New Todo).
 */
function fit(word: string, text: string): number {
  const t = text.toLowerCase();
  if (t === word) return 100;
  if (t.startsWith(word)) return 80;
  const words = t.split(/[\s\-_./]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(word))) return 60;
  if (word.length >= 2 && t.includes(word)) return 40;
  const initials = words.map((w) => w[0]).join("");
  if (word.length >= 2 && initials.startsWith(word)) return 30;
  return 0;
}

/**
 * Every word of the query has to fit somewhere; the score adds up how well.
 * The title counts in full, the rest for less. 0: not a match.
 */
export function score(query: string, item: Searchable): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let total = 0;
  for (const word of words) {
    const best = Math.max(
      fit(word, item.title),
      ...(item.also ?? []).map((text) => fit(word, text) * 0.7),
    );
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

/** The matches, best first; ties keep their order. */
export function rank<T extends Searchable>(query: string, items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index, score: score(query, item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
