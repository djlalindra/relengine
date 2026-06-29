import { NextRequest } from "next/server";
import { runPageRelevance } from "@/lib/pipeline/page-relevance";

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  let body: {
    seed?: string;
    region?: string;
    topN?: number;
    fanoutCount?: number;
  };

  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), {
      status: 400,
    });
  }

  const seed = body.seed?.trim();
  if (!seed) {
    return new Response(JSON.stringify({ error: "Seed query is required." }), {
      status: 400,
    });
  }
  if (seed.length > 300) {
    return new Response(
      JSON.stringify({ error: "Seed query must be under 300 characters." }),
      { status: 400 }
    );
  }

  const region = (body.region?.trim() ?? "us").toLowerCase();
  const topN = Math.min(15, Math.max(1, Math.round(body.topN ?? 3)));
  const fanoutCount = Math.min(14, Math.max(0, Math.round(body.fanoutCount ?? 0)));

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();
      const onProgress = (step: string) =>
        streamController.enqueue(encoder.encode(sse({ type: "progress", step })));

      try {
        const result = await runPageRelevance(
          seed,
          region,
          topN,
          fanoutCount,
          onProgress,
          controller.signal
        );
        streamController.enqueue(encoder.encode(sse({ type: "result", result })));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error occurred.";
        streamController.enqueue(
          encoder.encode(sse({ type: "error", error: message }))
        );
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
