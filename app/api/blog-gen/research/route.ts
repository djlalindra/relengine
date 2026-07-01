import { NextRequest } from "next/server";
import { callModel } from "@/lib/pipeline/model-client";
import { getGroundedUrls } from "@/lib/pipeline/grounding-client";
import { fetchFullPageContent } from "@/lib/pipeline/content-extractor";
import { buildResearchPrompt, RESEARCH_SYSTEM } from "@/lib/blog-gen/prompts";

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in response");
  return JSON.parse(text.slice(start, end + 1));
}

export async function POST(req: NextRequest) {
  let body: {
    keyword?: string;
    target_audience?: string;
    business_context?: string;
    existing_url?: string;
    manual_eeat_notes?: string;
  };

  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 });
  }

  const keyword = (body.keyword ?? "").trim();
  if (!keyword) {
    return new Response(JSON.stringify({ error: "keyword is required." }), { status: 400 });
  }

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();
      const send = (data: object) => streamController.enqueue(encoder.encode(sse(data)));

      try {
        // Step 1 — grounding: get top competitor URLs
        send({ type: "progress", step: "Searching Google for top competitors…" });
        const groundedUrls = await getGroundedUrls(keyword, 8, controller.signal);
        const competitorUrls = groundedUrls.map((u) => u.resolvedUri || u.uri).slice(0, 8);

        // Step 2 — crawl competitors
        send({ type: "progress", step: `Crawling ${competitorUrls.length} competitor pages…` });
        const crawled: { url: string; text: string }[] = [];
        for (const url of competitorUrls) {
          try {
            const result = await fetchFullPageContent(url);
            if (result?.text) crawled.push({ url, text: result.text.slice(0, 3000) });
          } catch {
            // skip failed crawls
          }
        }

        // Step 3 — build SERP summary for prompt
        const serpData = crawled.length
          ? crawled
              .map((c, i) => `[${i + 1}] ${c.url}\n${c.text.slice(0, 1500)}`)
              .join("\n\n---\n\n")
          : `No competitor pages could be crawled for "${keyword}".`;

        // Step 4 — Gemini research phases 0-5
        send({ type: "progress", step: "Running research phases (intent, entities, fan-out, gap analysis)…" });
        const researchPrompt = buildResearchPrompt(
          keyword,
          body.target_audience ?? "",
          body.business_context ?? "",
          body.existing_url ?? "",
          body.manual_eeat_notes ?? "",
          serpData
        );

        const raw = await callModel(
          [
            { role: "system", content: RESEARCH_SYSTEM },
            { role: "user", content: researchPrompt },
          ],
          { maxTokens: 8000, jsonMode: true, signal: controller.signal }
        );

        const research = parseJson(raw) as {
          p0?: unknown; p1?: unknown; p2?: unknown;
          p3?: unknown; p4?: unknown; p5?: unknown;
        };

        // Attach competitor URLs to p3
        if (research.p3 && typeof research.p3 === "object") {
          (research.p3 as Record<string, unknown>).competitor_urls = competitorUrls;
        }

        send({ type: "result", phase: "research", data: research });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        send({ type: "error", error: message });
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
