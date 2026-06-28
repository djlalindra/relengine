import { NextRequest } from "next/server";
import {
  fetchFullPageContent,
  fetchMultiplePages,
  extractHeadingOutline,
} from "@/lib/pipeline/content-extractor";
import { extractEntitiesForPages, buildTopKeywords, isJunkEntity } from "@/lib/pipeline/gap-report";
import { computeInformationGain } from "@/lib/pipeline/information-gain";
import { computeTopicalCoverageScore } from "@/lib/pipeline/topical-score";

const MAX_URLS = 15;

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function isValidUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Normalizes a URL for "is this the same page" comparison purposes --
 * lowercases, strips a trailing slash, ignores query string/hash. Not a
 * perfect equivalence check, but catches the common real cases (trailing
 * slash differences, http vs https, case differences) that would
 * otherwise let the target URL sneak into the competitor list undetected,
 * causing the page to be compared against itself.
 */
function normalizeForComparison(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.hostname.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return url.toLowerCase();
  }
}

function parseUrlList(raw: string): string[] {
  const candidates = raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return candidates.filter(isValidUrl).slice(0, MAX_URLS);
}

export async function POST(req: NextRequest) {
  let body: { targetUrl?: string; urls?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), {
      status: 400,
    });
  }

  const targetUrl = body.targetUrl?.trim();
  if (!targetUrl || !isValidUrl(targetUrl)) {
    return new Response(
      JSON.stringify({ error: "A valid target URL is required." }),
      { status: 400 }
    );
  }

  const rawCompetitorUrls = body.urls ? parseUrlList(body.urls) : [];
  if (rawCompetitorUrls.length === 0) {
    return new Response(
      JSON.stringify({ error: "At least one competitor URL is required." }),
      { status: 400 }
    );
  }

  const targetNormalized = normalizeForComparison(targetUrl);
  const competitorUrls = rawCompetitorUrls.filter(
    (u) => normalizeForComparison(u) !== targetNormalized
  );
  const targetWasInCompetitorList = competitorUrls.length < rawCompetitorUrls.length;

  if (competitorUrls.length === 0) {
    return new Response(
      JSON.stringify({
        error:
          "All supplied competitor URLs matched the target URL. Add at least one genuinely different competitor page.",
      }),
      { status: 400 }
    );
  }

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();
      const onProgress = (step: string) => {
        streamController.enqueue(
          encoder.encode(sse({ type: "progress", step }))
        );
      };

      try {
        if (targetWasInCompetitorList) {
          onProgress(
            "Warning: your target URL was also found in the competitor list and has been removed from it -- comparing a page against itself produces meaningless results."
          );
        }

        onProgress("Fetching target page content...");
        const target = await fetchFullPageContent(targetUrl);
        onProgress(
          target.fetchError
            ? `Warning: target page fetch failed (${target.fetchError}).`
            : `Fetched target page (${target.wordCount} words).`
        );

        onProgress(`Fetching ${competitorUrls.length} competitor page(s)...`);
        const competitors = await fetchMultiplePages(competitorUrls);
        const successCount = competitors.filter((c) => !c.fetchError).length;
        onProgress(
          `Fetched ${successCount}/${competitorUrls.length} competitor page(s) successfully.`
        );

        onProgress("Extracting entities (Cloud Natural Language)...");
        const { targetEntities, competitorEntityLists, errors } =
          await extractEntitiesForPages(target, competitors);

        onProgress("Building top keyword summary...");
        const { keywords: topKeywords, textIntegrityWarning } = buildTopKeywords(
          competitorEntityLists,
          targetEntities,
          target.text,
          target.wordCount
        );

        const allErrors = [
          ...errors,
          ...(textIntegrityWarning ? [textIntegrityWarning] : []),
          ...(targetWasInCompetitorList
            ? [
                "Your target URL was also found in the competitor list and was excluded from it before analysis -- comparing a page against itself produces meaningless gap results.",
              ]
            : []),
        ];

        const cleanTargetEntities = targetEntities.filter(
          (e) => !isJunkEntity(e.name, e.type)
        );

        onProgress("Computing information gain (unique content per page)...");
        const allPageTexts = [target.text, ...competitors.map((c) => c.text)];
        const infoGainResults = computeInformationGain(allPageTexts);
        const targetInfoGain = infoGainResults[0]?.uniqueTerms ?? [];

        const topKeywordTerms = topKeywords.map((k) => k.term);
        const targetTopicalScore = computeTopicalCoverageScore(
          target.text,
          targetEntities.map((e) => e.name),
          topKeywordTerms
        );

        const result = {
          target: {
            url: target.url,
            title: target.title,
            wordCount: target.wordCount,
            fetchError: target.fetchError,
            headingOutline: extractHeadingOutline(target.text),
            entities: cleanTargetEntities,
            entityCount: cleanTargetEntities.length,
            rawText: target.text,
            informationGain: targetInfoGain,
            topicalCoverageScore: targetTopicalScore,
          },
          competitors: competitors.map((c, idx) => {
            const entityList = competitorEntityLists.find((e) => e.url === c.url);
            const entities = (entityList?.entities ?? []).filter(
              (e) => !isJunkEntity(e.name, e.type)
            );
            const topicalScore = computeTopicalCoverageScore(
              c.text,
              (entityList?.entities ?? []).map((e) => e.name),
              topKeywordTerms
            );
            return {
              url: c.url,
              title: c.title,
              wordCount: c.wordCount,
              fetchError: c.fetchError,
              headingOutline: extractHeadingOutline(c.text),
              entities: entities,
              entityCount: entities.length,
              rawText: c.text,
              // infoGainResults[0] is the target; competitors start at index 1.
              informationGain: infoGainResults[idx + 1]?.uniqueTerms ?? [],
              topicalCoverageScore: topicalScore,
            };
          }),
          topKeywords,
          errors: allErrors,
          // Pass the raw page content + entity data through so Step 2
          // (Optimize) can reuse it without re-fetching or re-extracting.
          _cache: {
            target,
            competitors,
            targetEntities,
            competitorEntityLists,
          },
        };

        streamController.enqueue(encoder.encode(sse({ type: "result", result })));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error occurred.";
        streamController.enqueue(encoder.encode(sse({ type: "error", error: message })));
      } finally {
        streamController.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
