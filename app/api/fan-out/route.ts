import { NextRequest } from "next/server";
import { runFanOut } from "@/lib/pipeline/fan-out";

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  let body: { keyword?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), {
      status: 400,
    });
  }

  const keyword = body.keyword?.trim();

  if (!keyword) {
    return new Response(JSON.stringify({ error: "Keyword is required." }), {
      status: 400,
    });
  }

  if (keyword.length > 200) {
    return new Response(
      JSON.stringify({ error: "Keyword must be under 200 characters." }),
      { status: 400 }
    );
  }

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();

      const onProgress = (step: string) => {
        streamController.enqueue(encoder.encode(sse({ type: "progress", step })));
      };

      try {
        const result = await runFanOut(keyword, onProgress, controller.signal);
        streamController.enqueue(
          encoder.encode(sse({ type: "result", result }))
        );
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
