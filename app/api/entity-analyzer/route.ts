import { NextRequest } from "next/server";
import { runEntityAnalyzer } from "@/lib/pipeline/entity-analyzer";

const MAX_TEXT = 75000; // ~10 000 words

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  let body: { text?: string; keywords?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 });
  }

  const text = body.text?.trim();
  const keywords = body.keywords?.trim() ?? "";

  if (!text) {
    return new Response(JSON.stringify({ error: "Text is required." }), { status: 400 });
  }

  if (text.length > MAX_TEXT) {
    return new Response(
      JSON.stringify({ error: `Text must be under ${MAX_TEXT} characters.` }),
      { status: 400 }
    );
  }

  if (text.split(/\s+/).filter(Boolean).length < 5) {
    return new Response(
      JSON.stringify({ error: "Text must contain at least 5 words." }),
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
        const result = await runEntityAnalyzer(text, keywords, onProgress, controller.signal);
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
