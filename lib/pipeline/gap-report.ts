import { extractEntities, ExtractedEntity } from "./entity-extractor";
import { computeSemanticCoverage, SemanticCoverageResult } from "./embeddings-client";
import { PageContent } from "./content-extractor";

/**
 * Extracts entities for the target page and a set of competitor pages in
 * one pass. Used by the Scrape & Summarize stage so entity data can be
 * shown immediately, and reused by the Optimize stage afterward instead of
 * re-calling Cloud NLP on the same content twice.
 */
export async function extractEntitiesForPages(
  target: PageContent,
  competitors: PageContent[]
): Promise<{
  targetEntities: ExtractedEntity[];
  competitorEntityLists: { url: string; entities: ExtractedEntity[] }[];
  errors: string[];
}> {
  const errors: string[] = [];
  let targetEntities: ExtractedEntity[] = [];
  const competitorEntityLists: { url: string; entities: ExtractedEntity[] }[] = [];

  if (target.text) {
    try {
      targetEntities = await extractEntities(target.text);
    } catch (err) {
      errors.push(
        `Entity extraction failed for target page: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }
  }

  for (const comp of competitors.filter((c) => !c.fetchError && c.text)) {
    try {
      const entities = await extractEntities(comp.text);
      competitorEntityLists.push({ url: comp.url, entities });
    } catch (err) {
      errors.push(
        `Entity extraction failed for ${comp.url}: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }
  }

  return { targetEntities, competitorEntityLists, errors };
}

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

export type TopKeyword = {
  term: string;
  type: string;
  appearsInCompetitors: number;
  avgSalience: number;
  presentInTarget: boolean;
};

/**
 * Aggregates entities across competitor pages into a ranked "top semantic
 * keywords" list for the search term -- the terms/concepts that show up
 * repeatedly and prominently across what's currently published for this
 * topic. This reuses Cloud NLP entity data already being extracted (no
 * extra API calls) rather than inventing a separate keyword-extraction
 * pass. Marks whether each term is already present in the target page,
 * so this view stands alone as "what matters for this term" without
 * requiring the full gap report to be run first.
 */
export function buildTopKeywords(
  competitorEntityLists: { url: string; entities: ExtractedEntity[] }[],
  targetEntities: ExtractedEntity[],
  limit: number = 25
): TopKeyword[] {
  const targetNames = new Set(targetEntities.map((e) => e.name.toLowerCase()));

  const aggregation = new Map<
    string,
    { term: string; type: string; count: number; salienceSum: number }
  >();

  for (const { entities } of competitorEntityLists) {
    for (const entity of entities) {
      const key = entity.name.toLowerCase();
      const existing = aggregation.get(key);
      if (existing) {
        existing.count++;
        existing.salienceSum += entity.salience;
      } else {
        aggregation.set(key, {
          term: entity.name,
          type: entity.type,
          count: 1,
          salienceSum: entity.salience,
        });
      }
    }
  }

  return Array.from(aggregation.values())
    .map((e) => ({
      term: e.term,
      type: e.type,
      appearsInCompetitors: e.count,
      avgSalience: e.salienceSum / e.count,
      presentInTarget: targetNames.has(e.term.toLowerCase()),
    }))
    .sort((a, b) => {
      if (b.appearsInCompetitors !== a.appearsInCompetitors) {
        return b.appearsInCompetitors - a.appearsInCompetitors;
      }
      return b.avgSalience - a.avgSalience;
    })
    .slice(0, limit);
}

/**
 * Compares a target page against a set of competitor pages and produces a
 * gap report: which entities competitors mention that the target page
 * doesn't, and which semantic passages competitors cover that the target
 * page has no equivalent for.
 *
 * If precomputedEntities is provided (from an earlier Scrape & Summarize
 * stage), entity extraction is skipped and that data is reused directly --
 * avoids calling Cloud NLP twice on the same content across stages.
 */
export async function buildGapReport(
  target: PageContent,
  competitors: PageContent[],
  precomputedEntities?: {
    targetEntities: ExtractedEntity[];
    competitorEntityLists: { url: string; entities: ExtractedEntity[] }[];
  }
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
  let targetEntities: ExtractedEntity[];
  let competitorEntityLists: { url: string; entities: ExtractedEntity[] }[];

  if (precomputedEntities) {
    targetEntities = precomputedEntities.targetEntities;
    competitorEntityLists = precomputedEntities.competitorEntityLists;
  } else {
    const extracted = await extractEntitiesForPages(target, validCompetitors);
    targetEntities = extracted.targetEntities;
    competitorEntityLists = extracted.competitorEntityLists;
    errors.push(...extracted.errors);
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
