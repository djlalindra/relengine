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

async function assignByEmbeddings(
  sections: PageSection[],
  items: { text: string }[],
  onWait?: (message: string) => void
): Promise<SectionAssignment[]> {
  const sectionTexts = sections.map((s) => `${s.heading}. ${s.bodyText}`.slice(0, 2000));
  const itemTexts = items.map((i) => i.text);

  const [sectionEmbeddings, itemEmbeddings] = await Promise.all([
    getEmbeddings(sectionTexts, onWait),
    getEmbeddings(itemTexts, onWait),
  ]);

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
 * No fallback to a lesser method on failure -- if Vertex embeddings fail
 * (e.g. quota exhausted), this throws and the caller surfaces a clear
 * error. getEmbeddings already retries with extended backoff (up to ~2
 * minutes) before giving up, so a genuine failure here means Vertex is
 * unavailable well beyond a normal transient blip, not that the system
 * gave up early.
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

  const [entityAssignmentsRaw, passageAssignmentsRaw] = await Promise.all([
    assignByEmbeddings(sections, entityItems, onWait),
    assignByEmbeddings(sections, passageItems, onWait),
  ]);

  return {
    entityAssignments: missingEntities.map((e, i) => ({ ...e, ...entityAssignmentsRaw[i] })),
    passageAssignments: uncoveredPassages.map((p, i) => ({ ...p, ...passageAssignmentsRaw[i] })),
  };
}
