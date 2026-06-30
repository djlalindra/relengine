import { NextRequest } from "next/server";
import { runPageRelevance } from "@/lib/pipeline/page-relevance";

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  let body: { urls?: string[]; queries?: string[]; fanoutCount?: number };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 });
  }

  const urls = (body.urls ?? []).map((u) => u.trim()).filter(Boolean);
  const queries = (body.queries ?? []).map((q) => q.trim()).filter(Boolean);

  if (urls.length === 0) {
    return new Response(JSON.stringify({ error: "At least one URL is required." }), { status: 400 });
  }
  if (queries.length === 0) {
    return new Response(JSON.stringify({ error: "At least one query is required." }), { status: 400 });
  }
  if (urls.length > 10) {
    return new Response(JSON.stringify({ error: "Maximum 10 URLs per run." }), { status: 400 });
  }
  if (queries.length > 10) {
    return new Response(JSON.stringify({ error: "Maximum 10 queries per run." }), { status: 400 });
  }

  const fanoutCount = Math.min(10, Math.max(0, Math.round(body.fanoutCount ?? 0)));

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();
      const onProgress = (step: string) =>
        streamController.enqueue(encoder.encode(sse({ type: "progress", step })));

      try {
        const result = await runPageRelevance(urls, queries, fanoutCount, onProgress, controller.signal);
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
