import { NextRequest } from "next/server";
import { callModel } from "@/lib/pipeline/model-client";
import { buildOutlinePrompt, RESEARCH_SYSTEM } from "@/lib/blog-gen/prompts";

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
  let body: { keyword?: string; research?: unknown; rerun_comment?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 });
  }

  const keyword = (body.keyword ?? "").trim();
  if (!keyword || !body.research) {
    return new Response(JSON.stringify({ error: "keyword and research are required." }), { status: 400 });
  }

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();
      const send = (data: object) => streamController.enqueue(encoder.encode(sse(data)));

      try {
        send({ type: "progress", step: "Building article outline…" });

        const raw = await callModel(
          [
            { role: "system", content: RESEARCH_SYSTEM },
            { role: "user", content: buildOutlinePrompt(JSON.stringify(body.research, null, 2), keyword, body.rerun_comment) },
          ],
          { maxTokens: 4000, jsonMode: true, signal: controller.signal }
        );

        const outline = parseJson(raw);
        send({ type: "result", phase: "outline", data: outline });
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
