import { NextRequest } from "next/server";
import { PageContent } from "@/lib/pipeline/content-extractor";
import { ExtractedEntity } from "@/lib/pipeline/entity-extractor";
import { buildGapReport } from "@/lib/pipeline/gap-report";
import { generateRewriteSuggestionsForReport } from "@/lib/pipeline/run-pipeline";

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

type CachedData = {
  target: PageContent;
  competitors: PageContent[];
  targetEntities: ExtractedEntity[];
  competitorEntityLists: { url: string; entities: ExtractedEntity[] }[];
};

export async function POST(req: NextRequest) {
  let body: { cache?: CachedData };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), {
      status: 400,
    });
  }

  const cache = body.cache;
  if (!cache || !cache.target) {
    return new Response(
      JSON.stringify({
        error: "Missing cached scrape data. Run the Scrape & Summarize step first.",
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
        onProgress("Computing semantic passage coverage (Vertex Embeddings)...");
        const gapReport = await buildGapReport(
          cache.target,
          cache.competitors,
          {
            targetEntities: cache.targetEntities,
            competitorEntityLists: cache.competitorEntityLists,
          }
        );

        onProgress("Generating rewrite suggestions from the gap report...");
        const rewriteSuggestions = await generateRewriteSuggestionsForReport(
          cache.target,
          gapReport,
          onProgress,
          controller.signal
        );

        const result = { gapReport, rewriteSuggestions };

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
