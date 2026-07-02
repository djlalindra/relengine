import { NextRequest } from "next/server";
import { callModel } from "@/lib/pipeline/model-client";
import { buildCriticPrompt, CRITIC_SYSTEM } from "@/lib/blog-gen/prompts";

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
  let body: { final_markdown?: string; rerun_comment?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 });
  }

  if (!body.final_markdown) {
    return new Response(JSON.stringify({ error: "final_markdown is required." }), { status: 400 });
  }

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();
      const send = (data: object) => streamController.enqueue(encoder.encode(sse(data)));

      try {
        send({ type: "progress", step: "Critic review — QA gate (Gemini)…" });

        const raw = await callModel(
          [
            { role: "system", content: CRITIC_SYSTEM },
            { role: "user", content: buildCriticPrompt(body.final_markdown!, body.rerun_comment) },
          ],
          { maxTokens: 8000, jsonMode: true, signal: controller.signal }
        );

        const result = parseJson(raw);
        send({ type: "result", phase: "critic", data: result });
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
