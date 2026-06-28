/**
 * Citability scoring: does a passage carry verifiable, concrete content
 * (a statistic, a quote, a named/attributed source) or is it generic
 * prose with nothing an AI answer engine could cite as a specific claim.
 *
 * This directly operationalizes the single most evidenced GEO lever found
 * in research: including citations, quotations, and statistics measurably
 * increases visibility in generative engine answers. Pure rule-based
 * detection, no API calls needed.
 */

export type CitabilityResult = {
  hasStatistic: boolean;
  hasQuoteOrAttribution: boolean;
  hasNamedSource: boolean;
  score: number; // 0-100
  signals: string[]; // human-readable list of what was found, for display
};

// Patterns indicating a real statistic: percentages, dollar amounts,
// multi-digit numbers, or a number followed by a unit-like word.
const STAT_PATTERNS = [
  /\d+(\.\d+)?\s*%/, // 60%, 4.6%
  /\$\s?\d[\d,]*(\.\d+)?/, // $4.6 million, $500
  /\b\d{2,}[\d,]*\b/, // any number with 2+ digits (counts, years excluded separately)
  /\b\d+(\.\d+)?\s*(million|billion|thousand|times|percent|years?|months?|days?)\b/i,
];

// Phrases indicating attribution to a real, checkable source.
const ATTRIBUTION_PATTERNS = [
  /according to\s+[\w\s]+(?:,|\.|\s)/i,
  /\bstudy\b.*\b(found|shows|showed|reports?)\b/i,
  /\bresearch\b.*\b(found|shows|showed|indicates?)\b/i,
  /\bsurvey\b.*\b(found|shows|showed)\b/i,
  /["“][^"”]{15,}["”]/, // a quoted span of meaningful length
  /\b(government|statistics canada|cdc|fda|who|health canada|ministry of)\b/i,
];

// A named, specific source/entity reference (organization, named
// publication, named study) -- distinct from a generic "experts say."
const NAMED_SOURCE_PATTERNS = [
  /\b[A-Z][a-z]+ (?:University|Institute|Hospital|Association|Society|Foundation|Department|Ministry)\b/,
  /\b(?:Journal of|the [A-Z][a-z]+ Journal)\b/,
];

export function computeCitability(text: string): CitabilityResult {
  const signals: string[] = [];

  const hasStatistic = STAT_PATTERNS.some((p) => p.test(text));
  if (hasStatistic) signals.push("Contains a number/statistic");

  const hasQuoteOrAttribution = ATTRIBUTION_PATTERNS.some((p) => p.test(text));
  if (hasQuoteOrAttribution) signals.push("Contains a quote or attributed claim");

  const hasNamedSource = NAMED_SOURCE_PATTERNS.some((p) => p.test(text));
  if (hasNamedSource) signals.push("References a named institution/source");

  let score = 0;
  if (hasStatistic) score += 45;
  if (hasQuoteOrAttribution) score += 40;
  if (hasNamedSource) score += 15;

  return {
    hasStatistic,
    hasQuoteOrAttribution,
    hasNamedSource,
    score: Math.min(100, score),
    signals,
  };
}

export type SectionCitability = {
  heading: string;
  citability: CitabilityResult;
};

/**
 * Scores every section of a page for citability, so low-scoring sections
 * (generic prose with nothing checkable) can be flagged as the ones that
 * would benefit most from adding a real statistic or citation.
 */
export function scoreSectionsForCitability(
  sections: { heading: string; bodyText: string }[]
): SectionCitability[] {
  return sections.map((s) => ({
    heading: s.heading,
    citability: computeCitability(s.bodyText),
  }));
}
