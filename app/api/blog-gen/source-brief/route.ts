import { NextRequest } from "next/server";
import { callModel } from "@/lib/pipeline/model-client";
import { getGroundedUrls } from "@/lib/pipeline/grounding-client";

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

interface SourceBriefItem {
  url: string;
  title: string;
  stat_or_finding: string;
  source_label: string; // "Author/Org, Year" for inline citation
  section_relevance: string; // which outline section this supports
}

interface SourceBriefResult {
  sources: SourceBriefItem[];
}

export async function POST(req: NextRequest) {
  let body: { keyword?: string; outline?: object; rerun_comment?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 });
  }

  if (!body.keyword || !body.outline) {
    return new Response(JSON.stringify({ error: "keyword and outline are required." }), { status: 400 });
  }

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();
      const send = (data: object) => streamController.enqueue(encoder.encode(sse(data)));

      try {
        send({ type: "progress", step: "Gathering authoritative sources before drafting…" });

        const outlineStr = JSON.stringify(body.outline, null, 2);
        const keyword = body.keyword!;

        // Extract section headings from outline to build targeted queries
        const sections: string[] = [];
        try {
          const ol = body.outline as { sections?: { h2?: string; must_answer?: string }[] };
          for (const s of ol.sections ?? []) {
            if (s.h2) sections.push(s.h2);
          }
        } catch { /* ignore */ }

        // Build 3–4 targeted stat queries based on outline sections
        const queries = [
          `${keyword} statistics data survey research report`,
          `${keyword} benchmark study findings percentage`,
          ...(sections.slice(0, 2).map((s) => `${s} statistics data`)),
        ].slice(0, 4);

        send({ type: "progress", step: "Searching authoritative sources for key claims…" });

        const allUrls: { uri: string; resolvedUri?: string; title?: string }[] = [];
        for (const query of queries) {
          try {
            const urls = await getGroundedUrls(query, 4, controller.signal);
            allUrls.push(...urls);
          } catch { /* skip failed queries */ }
        }

        // Deduplicate by URL
        const seen = new Set<string>();
        const deduped = allUrls.filter((u) => {
          const key = u.resolvedUri || u.uri;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 15);

        send({ type: "progress", step: "Extracting statistics and findings from sources…" });

        // Ask Gemini to extract real stats/findings from these URLs
        const urlList = deduped.map((u) => `- ${u.title || "Source"}: ${u.resolvedUri || u.uri}`).join("\n");

        const prompt = `You are building a source brief for an article on: "${keyword}"

Article outline:
${outlineStr}

Authoritative sources found:
${urlList}

For each source URL above, identify the single most useful statistic, data point, or finding that supports a claim in this article's outline. Be specific — extract the actual number or finding, not a vague description.

Output JSON:
{
  "sources": [
    {
      "url": "exact URL from the list above",
      "title": "source title",
      "stat_or_finding": "The exact statistic or finding (e.g. '73% of law firm clients research online before hiring')",
      "source_label": "Org Name, Year (e.g. 'Clio, 2024')",
      "section_relevance": "which H2 section this stat best supports"
    }
  ]
}

Only include sources where you can identify a real, specific stat or finding relevant to the outline. Skip vague or irrelevant sources. Return 6–10 items max.`;

        const raw = await callModel(
          [{ role: "user", content: prompt }],
          { maxTokens: 4000, jsonMode: true, signal: controller.signal }
        );

        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        const result: SourceBriefResult = start !== -1 && end !== -1
          ? JSON.parse(raw.slice(start, end + 1))
          : { sources: [] };

        send({ type: "result", phase: "source_brief", data: result });
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
