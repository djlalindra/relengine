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
  usedFallback: boolean;
  fallbackReason?: string;
};

const MATCH_THRESHOLD_EMBEDDING = 0.55;
const MATCH_THRESHOLD_KEYWORD = 0.06;

/**
 * Simple word-overlap score between two strings (Jaccard-style on
 * significant words), used as a fallback when embeddings aren't
 * available (e.g. Vertex quota exceeded). Not as semantically precise as
 * embeddings, but deterministic, free, and always works.
 */
function keywordOverlapScore(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function assignByKeywordOverlap(
  sections: PageSection[],
  items: { text: string }[]
): SectionAssignment[] {
  return items.map((item) => {
    let bestIndex = -1;
    let bestScore = 0;
    sections.forEach((section, i) => {
      const score = keywordOverlapScore(
        item.text,
        `${section.heading} ${section.bodyText}`
      );
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    });
    if (bestScore < MATCH_THRESHOLD_KEYWORD) bestIndex = -1;
    return {
      sectionIndex: bestIndex,
      sectionHeading: bestIndex >= 0 ? sections[bestIndex].heading : "(new section needed)",
      score: bestScore,
    };
  });
}

async function assignByEmbeddings(
  sections: PageSection[],
  items: { text: string }[]
): Promise<SectionAssignment[]> {
  const sectionTexts = sections.map((s) => `${s.heading}. ${s.bodyText}`.slice(0, 2000));
  const itemTexts = items.map((i) => i.text);

  const [sectionEmbeddings, itemEmbeddings] = await Promise.all([
    getEmbeddings(sectionTexts),
    getEmbeddings(itemTexts),
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
 * page section it's most related to, so rewrite suggestions can say
 * "add X to section Y" deterministically instead of an LLM guessing
 * section boundaries from a flat text blob.
 *
 * Tries embeddings first (more semantically accurate). If that fails for
 * any reason (e.g. Vertex quota exceeded -- a known live issue), falls
 * back to keyword-overlap matching so the feature still produces real,
 * useful output rather than failing the whole request.
 */
export async function assignGapsToSections(
  sections: PageSection[],
  missingEntities: EntityGap[],
  uncoveredPassages: PassageMatch[]
): Promise<AssignedGaps> {
  const entityItems = missingEntities.map((e) => ({ text: e.name }));
  const passageItems = uncoveredPassages.map((p) => ({ text: p.competitorChunk }));

  if (sections.length === 0) {
    // Nothing to assign against -- everything needs a new section.
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
      usedFallback: false,
    };
  }

  try {
    const [entityAssignmentsRaw, passageAssignmentsRaw] = await Promise.all([
      assignByEmbeddings(sections, entityItems),
      assignByEmbeddings(sections, passageItems),
    ]);

    return {
      entityAssignments: missingEntities.map((e, i) => ({ ...e, ...entityAssignmentsRaw[i] })),
      passageAssignments: uncoveredPassages.map((p, i) => ({ ...p, ...passageAssignmentsRaw[i] })),
      usedFallback: false,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown embeddings error.";
    const entityAssignmentsRaw = assignByKeywordOverlap(sections, entityItems);
    const passageAssignmentsRaw = assignByKeywordOverlap(sections, passageItems);

    return {
      entityAssignments: missingEntities.map((e, i) => ({ ...e, ...entityAssignmentsRaw[i] })),
      passageAssignments: uncoveredPassages.map((p, i) => ({ ...p, ...passageAssignmentsRaw[i] })),
      usedFallback: true,
      fallbackReason: reason,
    };
  }
}
