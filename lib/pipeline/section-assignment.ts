import { PageSection } from "./content-extractor";
import { getEmbeddings, cosineSimilarity } from "./embeddings-client";
import { EntityGap } from "./gap-report";
import { PassageMatch } from "./embeddings-client";

export type SectionAssignment = {
  sectionIndex: number; // -1 means "no good match -- needs a new section"
  sectionHeading: string;
  score: number;
};

export type AssignedGaps = {
  entityAssignments: (EntityGap & SectionAssignment)[];
  passageAssignments: (PassageMatch & SectionAssignment)[];
};

const MATCH_THRESHOLD_EMBEDDING = 0.55;

function matchAgainstSections(
  itemEmbeddings: number[][],
  sectionEmbeddings: number[][],
  sections: PageSection[]
): SectionAssignment[] {
  return itemEmbeddings.map((itemVec) => {
    let bestIndex = -1;
    let bestScore = 0;
    sectionEmbeddings.forEach((sectionVec, i) => {
      const score = cosineSimilarity(itemVec, sectionVec);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    });
    if (bestScore < MATCH_THRESHOLD_EMBEDDING) bestIndex = -1;
    return {
      sectionIndex: bestIndex,
      sectionHeading: bestIndex >= 0 ? sections[bestIndex].heading : "(new section needed)",
      score: bestScore,
    };
  });
}

/**
 * Assigns each missing entity and uncovered passage to the real target
 * page section it's most related to, using Vertex embeddings, so rewrite
 * suggestions can say "add X to section Y" deterministically instead of
 * an LLM guessing section boundaries from a flat text blob.
 *
 * Everything here runs SEQUENTIALLY, not concurrently, and section
 * embeddings are computed exactly ONCE and reused for both entity and
 * passage matching. An earlier version fired 4 concurrent embedding
 * requests (entities-vs-sections and passages-vs-sections each making
 * their own separate section-embedding call), which multiplies demand
 * against an already-limited Vertex quota at exactly the moment quota
 * pressure is highest -- the opposite of what you want when the system
 * is already retrying through quota exhaustion. Serializing this, and
 * halving the redundant section re-embedding, meaningfully reduces total
 * API pressure per run.
 *
 * No fallback to a lesser method on failure -- if Vertex embeddings fail
 * (e.g. quota exhausted even after retries), this throws and the caller
 * surfaces a clear error.
 */
export async function assignGapsToSections(
  sections: PageSection[],
  missingEntities: EntityGap[],
  uncoveredPassages: PassageMatch[],
  onWait?: (message: string) => void
): Promise<AssignedGaps> {
  const entityItems = missingEntities.map((e) => ({ text: e.name }));
  const passageItems = uncoveredPassages.map((p) => ({ text: p.competitorChunk }));

  if (sections.length === 0) {
    return {
      entityAssignments: missingEntities.map((e) => ({
        ...e,
        sectionIndex: -1,
        sectionHeading: "(new section needed)",
        score: 0,
      })),
      passageAssignments: uncoveredPassages.map((p) => ({
        ...p,
        sectionIndex: -1,
        sectionHeading: "(new section needed)",
        score: 0,
      })),
    };
  }

  const sectionTexts = sections.map((s) => `${s.heading}. ${s.bodyText}`.slice(0, 2000));

  // One embedding call for sections, reused for both comparisons below --
  // not re-embedded per comparison.
  const sectionEmbeddings = await getEmbeddings(sectionTexts, onWait);

  // Sequential, not Promise.all -- avoids stacking concurrent requests
  // against the same quota window.
  const entityEmbeddings = await getEmbeddings(entityItems.map((i) => i.text), onWait);
  const entityAssignmentsRaw = matchAgainstSections(entityEmbeddings, sectionEmbeddings, sections);

  const passageEmbeddings = await getEmbeddings(passageItems.map((i) => i.text), onWait);
  const passageAssignmentsRaw = matchAgainstSections(passageEmbeddings, sectionEmbeddings, sections);

  return {
    entityAssignments: missingEntities.map((e, i) => ({ ...e, ...entityAssignmentsRaw[i] })),
    passageAssignments: uncoveredPassages.map((p, i) => ({ ...p, ...passageAssignmentsRaw[i] })),
  };
}
