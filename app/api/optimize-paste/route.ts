import { NextRequest } from "next/server";
import { extractEntities } from "@/lib/pipeline/entity-extractor";
import { buildGapReport } from "@/lib/pipeline/gap-report";
import { generateStructuredOptimization } from "@/lib/pipeline/structured-optimizer";
import type { PageContent } from "@/lib/pipeline/content-extractor";

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function textToPageContent(label: string, text: string): PageContent {
  return {
    url: label,
    title: label,
    text: text.slice(0, 50000),
    wordCount: text.trim().split(/\s+/).filter(Boolean).length,
  };
}

export async function POST(req: NextRequest) {
  let body: {
    target?: { label: string; text: string };
    competitors?: { label: string; text: string }[];
  };

  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 });
  }

  const targetText = body.target?.text?.trim() ?? "";
  const targetLabel = body.target?.label?.trim() || "Target Page";

  if (!targetText || targetText.split(/\s+/).filter(Boolean).length < 50) {
    return new Response(
      JSON.stringify({ error: "Target content must be at least 50 words." }),
      { status: 400 }
    );
  }

  const competitorInputs = (body.competitors ?? [])
    .filter((c) => c.text?.trim() && c.text.trim().split(/\s+/).filter(Boolean).length >= 50)
    .slice(0, 3);

  if (competitorInputs.length === 0) {
    return new Response(
      JSON.stringify({ error: "At least one competitor with 50+ words is required." }),
      { status: 400 }
    );
  }

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();
      const onProgress = (step: string) =>
        streamController.enqueue(encoder.encode(sse({ type: "progress", step })));

      try {
        onProgress("Extracting entities from target content (Google NLP)…");
        const targetEntities = await extractEntities(targetText);

        onProgress(`Extracting entities from ${competitorInputs.length} competitor(s) (Google NLP)…`);
        const competitorEntityLists = await Promise.all(
          competitorInputs.map(async (c) => ({
            url: c.label || "Competitor",
            entities: await extractEntities(c.text),
          }))
        );

        const target = textToPageContent(targetLabel, targetText);
        const competitors = competitorInputs.map((c) =>
          textToPageContent(c.label || "Competitor", c.text)
        );

        onProgress("Computing semantic coverage (Vertex Embeddings)…");
        const gapReport = await buildGapReport(target, competitors, {
          targetEntities,
          competitorEntityLists,
        });

        const optimization = await generateStructuredOptimization(
          target,
          competitors,
          gapReport,
          onProgress,
          controller.signal
        );

        streamController.enqueue(
          encoder.encode(sse({ type: "result", result: { gapReport, optimization } }))
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error occurred.";
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
