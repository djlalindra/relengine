import { PageContent, PageSection, splitIntoSections } from "./content-extractor";
import { assignGapsToSections } from "./section-assignment";
import { computeCitability } from "./citability";
import { computeSemanticCoverage } from "./embeddings-client";
import { GapReport } from "./gap-report";
import { callModel, ChatMessage } from "./model-client";

export type SectionOptimization = {
  heading: string;
  isNew: boolean;
  currentText: string;
  suggestedText: string;
  entitiesAssigned: string[];
  citabilityBefore: number;
  citabilityAfter: number;
  relevanceImpact: string;
};

export type StructuredOptimizationResult = {
  sections: SectionOptimization[];
  overallCurrentScore: number; // binary threshold % -- coarse, can stay flat despite real progress
  overallProjectedScore: number | null;
  overallCurrentSimilarity: number; // continuous average similarity -- shows partial progress the binary score can't
  overallProjectedSimilarity: number | null;
  projectedScoreUnavailableReason?: string;
  sectionsFound: number;
};

const OPTIMIZER_JSON_SYSTEM = `You are a senior SEO/AEO content strategist. You are given a target page's real sections, each with specific gaps (missing entities, competitor passages) already assigned to it, plus a citability score showing whether the section currently has any verifiable claim.

For each EXISTING section listed, write ACTUAL REWRITTEN BODY TEXT for that section that naturally incorporates its assigned gaps.

You are also given a pool of gaps that didn't closely match any existing section. Do NOT lump all of these into one generic section. Instead, group them by genuine topical relatedness and propose AS MANY distinct new sections as the material actually supports -- a page with gaps about family impact, financial compensation, and the legal process should get three separate proposed sections, not one. Give each proposed section its own specific, descriptive heading (not generic labels like "Additional Coverage" or "Miscellaneous"). If a gap is too thin or unrelated to justify its own section, it is acceptable to omit it rather than force it in somewhere irrelevant -- but err toward proposing real sections over dropping content, since the goal is to surface real opportunities, not minimize them.

Research shows including real citations, quotations, and statistics is the most effective lever for AI-generated answer visibility (up to 40% boost). If a competitor passage given to you contains a real statistic, you may suggest sourcing a similar verifiable figure -- frame it as "[CITE: similar to competitor data showing X]" rather than inventing a number as the target's own fact. Never fabricate a specific number presented as established fact.

Keep language plain and direct. No buzzwords, no "in today's landscape" filler.

Respond ONLY with valid JSON, no markdown fences, no preamble, in this exact shape:
{
  "sections": [
    {"heading": "exact heading given for existing sections, OR your own specific heading for new sections", "isNew": false, "suggestedText": "full rewritten or new body text", "relevanceImpact": "one sentence on why this matters"}
  ]
}`;

function stripJsonFences(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
}

/**
 * Extracts a JSON object from a model response that may include preamble
 * or trailing text despite being told not to ("We need to look at each
 * section..." before the actual JSON, a real observed failure mode with
 * some models). Strips markdown fences first, then if that alone doesn't
 * parse, falls back to taking the substring between the first '{' and the
 * last '}' -- the JSON object is usually still there, just not alone.
 */
function extractJson(text: string): unknown {
  const fenceStripped = stripJsonFences(text);

  try {
    return JSON.parse(fenceStripped);
  } catch {
    // fall through to bracket extraction
  }

  const firstBrace = fenceStripped.indexOf("{");
  const lastBrace = fenceStripped.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(
      `No JSON object found in model response. Response started with: "${text.slice(0, 80)}"`
    );
  }

  const candidate = fenceStripped.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(
      `Found a JSON-like block but it didn't parse: ${err instanceof Error ? err.message : "unknown error"}. ` +
        `Block started with: "${candidate.slice(0, 80)}"`
    );
  }
}

function buildOptimizedFullText(
  originalSections: PageSection[],
  optimizations: SectionOptimization[]
): string {
  const optimizationByHeading = new Map(optimizations.map((o) => [o.heading, o]));

  const parts: string[] = [];
  for (const section of originalSections) {
    const opt = optimizationByHeading.get(section.heading);
    const headingMarkup = "#".repeat(Math.max(1, section.level)) + " " + section.heading;
    parts.push(headingMarkup);
    parts.push(opt ? opt.suggestedText : section.bodyText);
  }
  for (const opt of optimizations.filter((o) => o.isNew)) {
    parts.push("## " + opt.heading);
    parts.push(opt.suggestedText);
  }

  return parts.join("\n\n");
}

export async function generateStructuredOptimization(
  target: PageContent,
  competitors: PageContent[],
  gapReport: GapReport,
  onProgress: (step: string) => void,
  signal?: AbortSignal
): Promise<StructuredOptimizationResult> {
  const overallCurrentScore = gapReport.semanticCoverage.coverageScore;
  const overallCurrentSimilarity = gapReport.semanticCoverage.averageSimilarity;

  if (gapReport.missingEntities.length === 0 && gapReport.semanticCoverage.uncoveredPassages.length === 0) {
    return {
      sections: [],
      overallCurrentScore,
      overallProjectedScore: overallCurrentScore,
      overallCurrentSimilarity,
      overallProjectedSimilarity: overallCurrentSimilarity,
      sectionsFound: 0,
    };
  }

  onProgress("Splitting target page into real sections...");
  const sections = splitIntoSections(target.text);

  onProgress("Assigning gaps to the section they're most related to (Vertex Embeddings)...");
  // No cap-then-drop: every missing entity and uncovered passage is
  // considered, so opportunities aren't silently lost to an arbitrary
  // slice before assignment even runs.
  const assigned = await assignGapsToSections(
    sections,
    gapReport.missingEntities,
    gapReport.semanticCoverage.uncoveredPassages,
    onProgress
  );

  const bySectionEntities = new Map<number, typeof assigned.entityAssignments>();
  const bySectionPassages = new Map<number, typeof assigned.passageAssignments>();
  for (const e of assigned.entityAssignments) {
    const list = bySectionEntities.get(e.sectionIndex) ?? [];
    list.push(e);
    bySectionEntities.set(e.sectionIndex, list);
  }
  for (const p of assigned.passageAssignments) {
    const list = bySectionPassages.get(p.sectionIndex) ?? [];
    list.push(p);
    bySectionPassages.set(p.sectionIndex, list);
  }

  const promptBlocks: string[] = [];
  const sectionMeta: { heading: string; isNew: boolean; currentText: string; entitiesAssigned: string[] }[] = [];

  sections.forEach((section, i) => {
    const entities = bySectionEntities.get(i) ?? [];
    const passages = bySectionPassages.get(i) ?? [];
    if (entities.length === 0 && passages.length === 0) return;

    const citability = computeCitability(section.bodyText);
    const statfulPassages = passages.filter((p) => computeCitability(p.competitorChunk).score >= 40);

    const lines = [
      `### Section: "${section.heading}" (existing)`,
      `Current text: ${section.bodyText.slice(0, 500)}`,
      `Citability score: ${citability.score}/100`,
    ];
    if (entities.length > 0) {
      lines.push("Assigned missing entities: " + entities.map((e) => e.name).join(", "));
    }
    if (statfulPassages.length > 0) {
      lines.push(
        "Competitor data with real stats you may reference: " +
          statfulPassages.map((p) => `"${p.competitorChunk.slice(0, 150)}"`).join(" | ")
      );
    }
    promptBlocks.push(lines.join("\n"));
    sectionMeta.push({
      heading: section.heading,
      isNew: false,
      currentText: section.bodyText,
      entitiesAssigned: entities.map((e) => e.name),
    });
  });

  // Unassigned gaps are handed over as ONE pool, but the prompt explicitly
  // instructs the model to split this into multiple genuinely distinct
  // new sections rather than one forced catch-all -- this is the direct
  // fix for opportunities being collapsed into a single generic bucket.
  const newEntities = bySectionEntities.get(-1) ?? [];
  const newPassages = bySectionPassages.get(-1) ?? [];
  if (newEntities.length > 0 || newPassages.length > 0) {
    promptBlocks.push(
      [
        `### Unassigned gap pool (propose MULTIPLE distinct new sections from this, grouped by real topical similarity -- do not combine unrelated items into one section):`,
        newEntities.length > 0 ? "Entities to cover: " + newEntities.map((e) => e.name).join(", ") : "",
        newPassages.length > 0
          ? "Related competitor passages: " + newPassages.map((p) => `"${p.competitorChunk.slice(0, 150)}"`).join(" | ")
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  onProgress("Generating structured per-section rewrites...");

  let parsedSections: { heading: string; isNew: boolean; suggestedText: string; relevanceImpact: string }[] = [];
  let lastError: string | null = null;
  const MAX_JSON_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_JSON_ATTEMPTS; attempt++) {
    const messages: ChatMessage[] = [
      { role: "system", content: OPTIMIZER_JSON_SYSTEM },
      {
        role: "user",
        content: lastError
          ? `Target page: ${target.url}\n\n${promptBlocks.join("\n\n")}\n\nYour previous response could not be parsed as valid JSON: ${lastError}\n\nReturn ONLY a corrected, complete, valid JSON object this time -- no preamble, no reasoning text, properly escape any quotes within string values.`
          : `Target page: ${target.url}\n\n${promptBlocks.join("\n\n")}`,
      },
    ];

    if (attempt > 0) {
      onProgress(`Retrying JSON generation (attempt ${attempt + 1}/${MAX_JSON_ATTEMPTS}) after parse error...`);
    }

    // maxTokens raised from 3000 to 6000 -- a real possible cause of the
    // observed mid-array JSON truncation is simply running out of tokens
    // for pages with many assigned sections/gaps.
    const rawResponse = await callModel(messages, { temperature: 0.4, maxTokens: 6000, signal });

    try {
      const parsed = extractJson(rawResponse) as { sections?: typeof parsedSections };
      parsedSections = parsed.sections ?? [];
      lastError = null;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "unknown error";
      if (attempt === MAX_JSON_ATTEMPTS - 1) {
        throw new Error(`Could not parse optimizer output as JSON after ${MAX_JSON_ATTEMPTS} attempts: ${lastError}`);
      }
    }
  }

  // Existing sections: matched back to their known metadata by exact
  // heading. New sections: the model may propose any number of them with
  // its own headings -- anything marked isNew=true that doesn't match an
  // existing section's heading is accepted as a genuine new proposal,
  // rather than being forced to match one predetermined placeholder.
  const existingHeadings = new Set(sectionMeta.map((m) => m.heading));

  const sectionResults: SectionOptimization[] = [];

  for (const meta of sectionMeta) {
    const match = parsedSections.find((p) => p.heading === meta.heading);
    const suggestedText = match?.suggestedText ?? meta.currentText;
    sectionResults.push({
      heading: meta.heading,
      isNew: false,
      currentText: meta.currentText,
      suggestedText,
      entitiesAssigned: meta.entitiesAssigned,
      citabilityBefore: meta.currentText ? computeCitability(meta.currentText).score : 0,
      citabilityAfter: computeCitability(suggestedText).score,
      relevanceImpact: match?.relevanceImpact ?? "",
    });
  }

  for (const parsed of parsedSections) {
    if (parsed.isNew && !existingHeadings.has(parsed.heading)) {
      sectionResults.push({
        heading: parsed.heading,
        isNew: true,
        currentText: "",
        suggestedText: parsed.suggestedText,
        entitiesAssigned: [...newEntities.map((e) => e.name), ...newPassages.map(() => "")].filter(Boolean),
        citabilityBefore: 0,
        citabilityAfter: computeCitability(parsed.suggestedText).score,
        relevanceImpact: parsed.relevanceImpact ?? "",
      });
    }
  }

  onProgress("Recomputing semantic coverage with suggested changes applied...");
  let overallProjectedScore: number | null = null;
  let overallProjectedSimilarity: number | null = null;
  let projectedScoreUnavailableReason: string | undefined;

  try {
    const optimizedText = buildOptimizedFullText(sections, sectionResults);
    const competitorTexts = competitors
      .filter((c) => !c.fetchError && c.text)
      .map((c) => ({ url: c.url, text: c.text }));
    const newCoverage = await computeSemanticCoverage(optimizedText, competitorTexts);
    overallProjectedScore = newCoverage.coverageScore;
    overallProjectedSimilarity = newCoverage.averageSimilarity;
  } catch (err) {
    projectedScoreUnavailableReason = err instanceof Error ? err.message : "Unknown error.";
    onProgress(`Could not recompute projected score: ${projectedScoreUnavailableReason}`);
  }

  return {
    sections: sectionResults,
    overallCurrentScore,
    overallProjectedScore,
    overallCurrentSimilarity,
    overallProjectedSimilarity,
    projectedScoreUnavailableReason,
    sectionsFound: sections.length,
  };
}
