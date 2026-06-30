import { NextRequest } from "next/server";
import { runPageRelevance } from "@/lib/pipeline/page-relevance";

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  let body: {
    seedQuery?: string;
    city?: string;
    fanoutCount?: number;
    topNPerQuery?: number;
  };

  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 });
  }

  const seedQuery = (body.seedQuery ?? "").trim();
  const city = (body.city ?? "").trim();

  if (!seedQuery) {
    return new Response(JSON.stringify({ error: "seedQuery is required." }), { status: 400 });
  }

  const fanoutCount = Math.min(14, Math.max(0, Math.round(body.fanoutCount ?? 5)));
  const topNPerQuery = Math.min(10, Math.max(1, Math.round(body.topNPerQuery ?? 3)));

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();
      const onProgress = (step: string) =>
        streamController.enqueue(encoder.encode(sse({ type: "progress", step })));

      try {
        const result = await runPageRelevance(
          seedQuery,
          city,
          fanoutCount,
          topNPerQuery,
          onProgress,
          controller.signal
        );
        streamController.enqueue(encoder.encode(sse({ type: "result", result })));
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
