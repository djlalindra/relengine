/**
 * Information gain via TF-IDF: for each page in a set, finds terms/phrases
 * that page uses that NO other page in the set uses at all. This is the
 * "what does this page uniquely contribute" signal -- a proven factor
 * (pages that merely reformat existing information score near zero on
 * this dimension; original information/analysis is rewarded). Pure
 * computation, no external API calls, so it works even when Vertex
 * embeddings are quota-limited.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "when",
  "at", "by", "for", "with", "about", "against", "between", "into",
  "through", "during", "before", "after", "above", "below", "to", "from",
  "up", "down", "in", "out", "on", "off", "over", "under", "again",
  "further", "once", "here", "there", "all", "any", "both", "each",
  "few", "more", "most", "other", "some", "such", "no", "nor", "not",
  "only", "own", "same", "so", "than", "too", "very", "is", "are", "was",
  "were", "be", "been", "being", "have", "has", "had", "having", "do",
  "does", "did", "doing", "will", "would", "should", "could", "ought",
  "i", "you", "he", "she", "it", "we", "they", "what", "which", "who",
  "whom", "this", "that", "these", "those", "am", "of", "as", "can",
  "your", "our", "their", "his", "her", "its", "us", "them", "my",
]);

function tokenizeRaw(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function isContentWord(token: string): boolean {
  return token.length > 2 && !STOPWORDS.has(token) && !/^\d+$/.test(token);
}

/**
 * Generates unigrams and bigrams from the ORIGINAL word sequence (not a
 * pre-filtered one) so bigrams reflect real adjacency in the source text.
 * Building bigrams from an already-stopword-stripped list would corrupt
 * adjacency -- e.g. "experience WITH anesthesia" would collapse into the
 * fake bigram "experience anesthesia" once "with" is removed first, even
 * though those two words were never actually adjacent. Stopwords are
 * filtered AFTER bigram formation instead, so only genuinely adjacent
 * content-word pairs survive.
 */
function getNgrams(rawTokens: string[]): string[] {
  const ngrams: string[] = [];
  for (const token of rawTokens) {
    if (isContentWord(token)) ngrams.push(token);
  }
  for (let i = 0; i < rawTokens.length - 1; i++) {
    const a = rawTokens[i];
    const b = rawTokens[i + 1];
    if (isContentWord(a) && isContentWord(b)) {
      ngrams.push(`${a} ${b}`);
    }
  }
  return ngrams;
}

export type PageInfoGain = {
  pageIndex: number;
  uniqueTerms: { term: string; count: number }[];
};

/**
 * For each page's text in `pages` (in order), finds terms/phrases that
 * appear in that page and in NO other page in the set. Returns up to
 * `limit` unique terms per page, ranked by frequency within that page.
 */
export function computeInformationGain(
  pages: string[],
  limit: number = 15
): PageInfoGain[] {
  const perPageCounts: Map<string, number>[] = pages.map((text) => {
    const counts = new Map<string, number>();
    const ngrams = getNgrams(tokenizeRaw(text));
    for (const term of ngrams) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    return counts;
  });

  // Document frequency: how many distinct pages contain each term at all.
  const docFrequency = new Map<string, number>();
  for (const counts of perPageCounts) {
    for (const term of counts.keys()) {
      docFrequency.set(term, (docFrequency.get(term) ?? 0) + 1);
    }
  }

  return perPageCounts.map((counts, pageIndex) => {
    const uniqueTerms = Array.from(counts.entries())
      .filter(([term]) => docFrequency.get(term) === 1) // only this page has it
      .filter(([term, count]) => {
        // For single words, require at least 2 occurrences to filter
        // one-off noise; bigrams (more specific by nature) can stand on
        // a single occurrence.
        const isBigram = term.includes(" ");
        return isBigram || count >= 2;
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([term, count]) => ({ term, count }));

    return { pageIndex, uniqueTerms };
  });
}
