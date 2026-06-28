/**
 * Topical Coverage Score: for a given page, what percentage of the
 * overall set's top keywords actually appear on that page (by entity
 * match or raw-text substring, same word-boundary logic used elsewhere
 * in this codebase). Pure computation, no Vertex dependency -- so it
 * keeps working even when embeddings quota is exhausted, and gives a
 * real, deterministic basis for "your page vs. competitor average vs.
 * top competitor" comparison instead of inventing numbers.
 */

function isPresentInText(term: string, textLower: string): boolean {
  if (!textLower) return false;
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b`);
  return pattern.test(textLower);
}

export function computeTopicalCoverageScore(
  pageText: string,
  pageEntityNames: string[],
  topKeywordTerms: string[]
): number {
  if (topKeywordTerms.length === 0) return 0;

  const textLower = pageText.toLowerCase();
  const entityNameSet = new Set(pageEntityNames.map((n) => n.toLowerCase()));

  let matched = 0;
  for (const term of topKeywordTerms) {
    if (entityNameSet.has(term.toLowerCase()) || isPresentInText(term, textLower)) {
      matched++;
    }
  }

  return Math.round((matched / topKeywordTerms.length) * 100);
}
