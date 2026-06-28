import { ExtractedEntity } from "./entity-extractor";

export type PresenceChecker = {
  isPresent: (term: string) => boolean;
  textIntegrityWarning: string | null;
};

/**
 * Builds a single, reusable presence-checking function from a target
 * page's extracted entities and raw text. This is the ONLY place this
 * logic should exist -- previously it was implemented twice
 * (buildTopKeywords and buildGapReport had separate, supposedly-equivalent
 * copies), which meant the two could silently drift or behave differently
 * if one received degraded input (e.g. text lost/truncated on a
 * server->browser->server round-trip) while the other didn't, producing
 * exactly the kind of contradiction (same term marked both present and
 * missing in different panels) that was reported.
 *
 * Includes a data-integrity guard: if targetText is suspiciously short
 * relative to the page's known word count, that's a signal the text was
 * degraded somewhere upstream (truncation, serialization issue, etc.) --
 * rather than silently producing wrong "missing" verdicts in that case,
 * this surfaces a warning the caller can show to the user.
 */
export function buildPresenceChecker(
  targetEntities: ExtractedEntity[],
  targetText: string,
  targetWordCount?: number
): PresenceChecker {
  const targetNames = new Set(targetEntities.map((e) => e.name.toLowerCase()));
  const targetTextLower = (targetText || "").toLowerCase();

  let textIntegrityWarning: string | null = null;
  if (targetWordCount && targetWordCount > 0) {
    const actualWordCount = targetTextLower.split(/\s+/).filter(Boolean).length;
    // If the text we actually have is less than half the word count the
    // page was originally measured at, something was lost in transit.
    if (actualWordCount < targetWordCount * 0.5) {
      textIntegrityWarning =
        `Target page text appears degraded: expected ~${targetWordCount} words, ` +
        `received ${actualWordCount}. Entity-presence checks for this run may be ` +
        `unreliable. This usually means page content was lost or truncated ` +
        `between steps -- try re-running Step 1 immediately before Step 2.`;
    }
  }

  function isPresent(term: string): boolean {
    const lower = term.toLowerCase();
    if (targetNames.has(lower)) return true;
    if (!targetTextLower) return false;
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`);
    return pattern.test(targetTextLower);
  }

  return { isPresent, textIntegrityWarning };
}
