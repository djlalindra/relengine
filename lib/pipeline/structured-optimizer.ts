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
  overallCurrentScore: number;
  overallProjectedScore: number | null;
  projectedScoreUnavailableReason?: string;
  sectionsFound: number;
  usedFallbackAssignment: boolean;
  fallbackReason?: string;
};

const OPTIMIZER_JSON_SYSTEM = `You are a senior SEO/AEO content strategist. You are given a target page's real sections, each with specific gaps (missing entities, competitor passages) already assigned to it, plus a citability score showing whether the section currently has any verifiable claim.

For each section listed, write ACTUAL REWRITTEN BODY TEXT for that section that naturally incorporates the assigned gaps. For sections proposed as new, write actual new section body text.

Research shows including real citations, quotations, and statistics is the most effective lever for AI-generated answer visibility (up to 40% boost). If a competitor passage given to you contains a real statistic, you may suggest sourcing a similar verifiable figure -- frame it as "[CITE: similar to competitor data showing X]" rather than inventing a number as the target's own fact. Never fabricate a specific number presented as established fact.

Keep language plain and direct. No buzzwords, no "in today's landscape" filler.

Respond ONLY with valid JSON, no markdown fences, no preamble, in this exact shape:
{
  "sections": [
    {"heading": "exact heading given", "isNew": false, "suggestedText": "full rewritten body text", "relevanceImpact": "one sentence on why this matters"}
  ]
}`;

function stripJsonFences(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
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

  if (gapReport.missingEntities.length === 0 && gapReport.semanticCoverage.uncoveredPassages.length === 0) {
    return {
      sections: [],
      overallCurrentScore,
      overallProjectedScore: overallCurrentScore,
      sectionsFound: 0,
      usedFallbackAssignment: false,
    };
  }

  onProgress("Splitting target page into real sections...");
  const sections = splitIntoSections(target.text);

  onProgress("Assigning gaps to the section they're most related to...");
  const assigned = await assignGapsToSections(
    sections,
    gapReport.missingEntities.slice(0, 25),
    gapReport.semanticCoverage.uncoveredPassages.slice(0, 15)
  );

  if (assigned.usedFallback) {
    onProgress(`Note: using keyword-overlap fallback (${assigned.fallbackReason}).`);
  }

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

  const newEntities = bySectionEntities.get(-1) ?? [];
  const newPassages = bySectionPassages.get(-1) ?? [];
  if (newEntities.length > 0 || newPassages.length > 0) {
    const proposedHeading = "Additional Coverage";
    promptBlocks.push(
      [
        `### Section: "${proposedHeading}" (NEW -- propose this section)`,
        newEntities.length > 0 ? "Entities to cover: " + newEntities.map((e) => e.name).join(", ") : "",
        newPassages.length > 0
          ? "Related competitor passages: " + newPassages.map((p) => `"${p.competitorChunk.slice(0, 150)}"`).join(" | ")
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
    sectionMeta.push({
      heading: proposedHeading,
      isNew: true,
      currentText: "",
      entitiesAssigned: newEntities.map((e) => e.name),
    });
  }

  onProgress("Generating structured per-section rewrites...");
  const messages: ChatMessage[] = [
    { role: "system", content: OPTIMIZER_JSON_SYSTEM },
    { role: "user", content: `Target page: ${target.url}\n\n${promptBlocks.join("\n\n")}` },
  ];

  const rawResponse = await callModel(messages, { temperature: 0.5, maxTokens: 3000, signal });

  let parsedSections: { heading: string; isNew: boolean; suggestedText: string; relevanceImpact: string }[];
  try {
    const parsed = JSON.parse(stripJsonFences(rawResponse));
    parsedSections = parsed.sections ?? [];
  } catch (err) {
    throw new Error(
      `Could not parse optimizer output as JSON: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }

  const sectionResults: SectionOptimization[] = sectionMeta.map((meta) => {
    const match = parsedSections.find((p) => p.heading === meta.heading);
    const suggestedText = match?.suggestedText ?? meta.currentText;
    return {
      heading: meta.heading,
      isNew: meta.isNew,
      currentText: meta.currentText,
      suggestedText,
      entitiesAssigned: meta.entitiesAssigned,
      citabilityBefore: meta.currentText ? computeCitability(meta.currentText).score : 0,
      citabilityAfter: computeCitability(suggestedText).score,
      relevanceImpact: match?.relevanceImpact ?? "",
    };
  });

  onProgress("Recomputing semantic coverage with suggested changes applied...");
  let overallProjectedScore: number | null = null;
  let projectedScoreUnavailableReason: string | undefined;

  try {
    const optimizedText = buildOptimizedFullText(sections, sectionResults);
    const competitorTexts = competitors
      .filter((c) => !c.fetchError && c.text)
      .map((c) => ({ url: c.url, text: c.text }));
    const newCoverage = await computeSemanticCoverage(optimizedText, competitorTexts);
    overallProjectedScore = newCoverage.coverageScore;
  } catch (err) {
    projectedScoreUnavailableReason = err instanceof Error ? err.message : "Unknown error.";
    onProgress(`Could not recompute projected score: ${projectedScoreUnavailableReason}`);
  }

  return {
    sections: sectionResults,
    overallCurrentScore,
    overallProjectedScore,
    projectedScoreUnavailableReason,
    sectionsFound: sections.length,
    usedFallbackAssignment: assigned.usedFallback,
    fallbackReason: assigned.fallbackReason,
  };
}
