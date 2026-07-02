import { NextRequest } from "next/server";
import { callClaude, SONNET_5 } from "@/lib/blog-gen/anthropic-client";
import { buildDraftPrompt, WRITER_SYSTEM } from "@/lib/blog-gen/prompts";

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found");
  return JSON.parse(text.slice(start, end + 1));
}

export async function POST(req: NextRequest) {
  let body: {
    outline?: unknown;
    research?: unknown;
    target_word_count?: number;
    manual_eeat_notes?: string;
    source_brief?: string;
    rerun_comment?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 });
  }

  if (!body.outline || !body.research) {
    return new Response(JSON.stringify({ error: "outline and research are required." }), { status: 400 });
  }

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();
      const send = (data: object) => streamController.enqueue(encoder.encode(sse(data)));

      try {
        send({ type: "progress", step: "Writing article draft (Claude Sonnet 5)…" });

        const raw = await callClaude(
          WRITER_SYSTEM,
          buildDraftPrompt(
            JSON.stringify(body.outline, null, 2),
            JSON.stringify(body.research, null, 2),
            body.target_word_count ?? 1800,
            body.manual_eeat_notes ?? "",
            body.source_brief,
            body.rerun_comment
          ),
          { model: SONNET_5, maxTokens: 12000, signal: controller.signal }
        );

        const draft = parseJson(raw) as { draft_markdown?: string; placeholders_needing_sources?: string[]; manual_eeat_used?: boolean };
        send({ type: "result", phase: "draft", data: draft });
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "Unknown error" });
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
