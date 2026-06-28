import { NextRequest } from "next/server";
import { runPipeline } from "@/lib/pipeline/run-pipeline";

const MAX_TOPIC_LENGTH = 200;
const MAX_URLS = 15;

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Parses a raw block of text containing URLs, accepting either:
 * - One URL per line (plain paste)
 * - Comma-separated values (CSV-style paste, e.g. "url,url,url" or a
 *   single-column CSV export with one URL per row)
 * Filters out anything that doesn't look like a valid http(s) URL, so a
 * stray header row like "url" or "URLs" from a CSV export doesn't get
 * treated as a real source.
 */
function parseUrlList(raw: string): string[] {
  const candidates = raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const valid: string[] = [];
  for (const c of candidates) {
    try {
      const parsed = new URL(c);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        valid.push(c);
      }
    } catch {
      // Not a valid URL -- skip silently (e.g. a CSV header cell).
    }
  }

  return valid.slice(0, MAX_URLS);
}

export async function POST(req: NextRequest) {
  let body: { topic?: string; urls?: string };
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

  const manualUrls = body.urls ? parseUrlList(body.urls) : [];

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed/aborted client-side -- ignore.
        }
      };

      const onProgress = (step: string) => {
        safeEnqueue(sse({ type: "progress", step }));
      };

      // If the client disconnects (e.g. the Stop button calls
      // AbortController.abort()), req.signal fires "abort". We pass this
      // signal into the pipeline so in-progress model calls and the retry
      // loop stop checking/calling further, instead of continuing to burn
      // API credits after the user has already given up on the response.
      req.signal.addEventListener("abort", () => {
        closed = true;
      });

      try {
        const result = await runPipeline(topic, onProgress, manualUrls, req.signal);
        safeEnqueue(sse({ type: "result", result }));
      } catch (err) {
        if (req.signal.aborted) {
          // Expected -- the user clicked Stop. Nothing to report as an error.
          return;
        }
        const message =
          err instanceof Error ? err.message : "Unknown error occurred.";
        safeEnqueue(sse({ type: "error", error: message }));
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed -- fine.
        }
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
