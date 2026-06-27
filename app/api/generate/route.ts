import { NextRequest } from "next/server";
import { runPipeline } from "@/lib/pipeline/run-pipeline";

const MAX_TOPIC_LENGTH = 200;

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  let body: { topic?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), {
      status: 400,
    });
  }

  const topic = body.topic?.trim();

  if (!topic) {
    return new Response(JSON.stringify({ error: "Topic is required." }), {
      status: 400,
    });
  }

  if (topic.length > MAX_TOPIC_LENGTH) {
    return new Response(
      JSON.stringify({
        error: `Topic must be under ${MAX_TOPIC_LENGTH} characters.`,
      }),
      { status: 400 }
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const onProgress = (step: string) => {
        controller.enqueue(encoder.encode(sse({ type: "progress", step })));
      };

      try {
        const result = await runPipeline(topic, onProgress);
        controller.enqueue(
          encoder.encode(sse({ type: "result", result }))
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error occurred.";
        controller.enqueue(
          encoder.encode(sse({ type: "error", error: message }))
        );
      } finally {
        controller.close();
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
