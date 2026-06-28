import { extractEntities, ExtractedEntity } from "./entity-extractor";
import { computeSemanticCoverage, SemanticCoverageResult } from "./embeddings-client";
import { PageContent } from "./content-extractor";

export type EntityGap = {
  name: string;
  type: string;
  appearsInCompetitors: number; // how many competitor pages mention this
  avgSalienceInCompetitors: number;
};

export type GapReport = {
  targetUrl: string;
  targetWordCount: number;
  missingEntities: EntityGap[];
  targetEntities: ExtractedEntity[];
  semanticCoverage: SemanticCoverageResult;
  competitorsAnalyzed: { url: string; wordCount: number; fetchError?: string }[];
  errors: string[];
};

/**
 * Compares a target page against a set of competitor pages and produces a
 * gap report: which entities competitors mention that the target page
 * doesn't, and which semantic passages competitors cover that the target
 * page has no equivalent for.
 *
 * This is the core "audit" output -- everything else in the pipeline
 * (writer, structural checker) is secondary to this when a target URL is
 * provided.
 */
export async function buildGapReport(
  target: PageContent,
  competitors: PageContent[]
): Promise<GapReport> {
  const errors: string[] = [];

  if (target.fetchError) {
    errors.push(`Could not fetch target page: ${target.fetchError}`);
  }

  const validCompetitors = competitors.filter((c) => !c.fetchError && c.text);
  const failedCompetitors = competitors.filter((c) => c.fetchError || !c.text);

  for (const failed of failedCompetitors) {
    errors.push(
      `Could not fetch competitor page ${failed.url}: ${failed.fetchError ?? "no content returned"}`
    );
  }

  // --- Entity comparison ---
  let targetEntities: ExtractedEntity[] = [];
  const competitorEntityLists: { url: string; entities: ExtractedEntity[] }[] = [];

  try {
    targetEntities = await extractEntities(target.text);
  } catch (err) {
    errors.push(
      `Entity extraction failed for target page: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }

  for (const comp of validCompetitors) {
    try {
      const entities = await extractEntities(comp.text);
      competitorEntityLists.push({ url: comp.url, entities });
    } catch (err) {
      errors.push(
        `Entity extraction failed for ${comp.url}: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }
  }

  const targetEntityNames = new Set(
    targetEntities.map((e) => e.name.toLowerCase())
  );

  // Aggregate competitor entities not present in target
  const entityAggregation = new Map<
    string,
    { name: string; type: string; count: number; salienceSum: number }
  >();

  for (const { entities } of competitorEntityLists) {
    for (const entity of entities) {
      const key = entity.name.toLowerCase();
      if (targetEntityNames.has(key)) continue; // already covered by target

      const existing = entityAggregation.get(key);
      if (existing) {
        existing.count++;
        existing.salienceSum += entity.salience;
      } else {
        entityAggregation.set(key, {
          name: entity.name,
          type: entity.type,
          count: 1,
          salienceSum: entity.salience,
        });
      }
    }
  }

  const missingEntities: EntityGap[] = Array.from(entityAggregation.values())
    .map((e) => ({
      name: e.name,
      type: e.type,
      appearsInCompetitors: e.count,
      avgSalienceInCompetitors: e.salienceSum / e.count,
    }))
    // Entities that appear across more competitors, with higher salience,
    // are the most important gaps to surface first.
    .sort((a, b) => {
      if (b.appearsInCompetitors !== a.appearsInCompetitors) {
        return b.appearsInCompetitors - a.appearsInCompetitors;
      }
      return b.avgSalienceInCompetitors - a.avgSalienceInCompetitors;
    })
    .slice(0, 30); // cap to the most relevant gaps, not an overwhelming dump

  // --- Semantic/passage-level comparison ---
  let semanticCoverage: SemanticCoverageResult = {
    targetChunks: [],
    coverageScore: 0,
    uncoveredPassages: [],
    strongMatchThreshold: 0.75,
  };

  if (target.text && validCompetitors.length > 0) {
    try {
      semanticCoverage = await computeSemanticCoverage(
        target.text,
        validCompetitors.map((c) => ({ url: c.url, text: c.text }))
      );
    } catch (err) {
      errors.push(
        `Semantic coverage analysis failed: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }
  }

  return {
    targetUrl: target.url,
    targetWordCount: target.wordCount,
    missingEntities,
    targetEntities: targetEntities.slice(0, 30),
    semanticCoverage,
    competitorsAnalyzed: competitors.map((c) => ({
      url: c.url,
      wordCount: c.wordCount,
      fetchError: c.fetchError,
    })),
    errors,
  };
}
