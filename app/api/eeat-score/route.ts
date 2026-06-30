import { NextRequest } from "next/server";
import { runEEATScorer } from "@/lib/pipeline/eeat-scorer";

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  let body: { content?: string; url?: string; author?: string; domain?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 });
  }

  const content = body.content?.trim();
  if (!content) {
    return new Response(JSON.stringify({ error: "Content is required." }), { status: 400 });
  }
  if (content.split(/\s+/).filter(Boolean).length < 20) {
    return new Response(
      JSON.stringify({ error: "Content must contain at least 20 words for a meaningful evaluation." }),
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
        const result = await runEEATScorer(
          content,
          { url: body.url?.trim(), author: body.author?.trim(), domain: body.domain?.trim() },
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
