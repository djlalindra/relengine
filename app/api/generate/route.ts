import { NextRequest } from "next/server";
import { runAuditPipeline } from "@/lib/pipeline/run-pipeline";

const MAX_TOPIC_LENGTH = 200;
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

function parseUrlList(raw: string): string[] {
  const candidates = raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return candidates.filter(isValidUrl).slice(0, MAX_URLS);
}

export async function POST(req: NextRequest) {
  let body: { topic?: string; targetUrl?: string; urls?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), {
      status: 400,
    });
  }

  const topic = body.topic?.trim();
  const targetUrl = body.targetUrl?.trim();

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

  if (!targetUrl) {
    return new Response(
      JSON.stringify({ error: "Target URL is required." }),
      { status: 400 }
    );
  }

  if (!isValidUrl(targetUrl)) {
    return new Response(
      JSON.stringify({ error: "Target URL must be a valid http(s) URL." }),
      { status: 400 }
    );
  }

  const competitorUrls = body.urls ? parseUrlList(body.urls) : [];

  if (competitorUrls.length === 0) {
    return new Response(
      JSON.stringify({
        error: "At least one competitor URL is required to build a gap report.",
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
        const result = await runAuditPipeline(
          topic,
          targetUrl,
          competitorUrls,
          onProgress,
          controller.signal
        );
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
