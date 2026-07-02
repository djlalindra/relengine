import { NextRequest } from "next/server";
import { callModel } from "@/lib/pipeline/model-client";

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  let body: {
    article_text?: string;
    keyword?: string;
    research?: object;
    ideal_outline?: object;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 });
  }

  if (!body.article_text || !body.keyword) {
    return new Response(JSON.stringify({ error: "article_text and keyword are required." }), { status: 400 });
  }

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();
      const send = (data: object) => streamController.enqueue(encoder.encode(sse(data)));

      try {
        send({ type: "progress", step: "Comparing article against research and ideal structure…" });

        const prompt = `You are a senior SEO content strategist. Analyse the provided article against the research brief and ideal outline. Produce a specific, actionable gap report — not generic advice.

KEYWORD: "${body.keyword}"

RESEARCH BRIEF (what the ideal article should cover):
${JSON.stringify(body.research, null, 2).slice(0, 3000)}

IDEAL OUTLINE (structure the article should follow):
${JSON.stringify(body.ideal_outline, null, 2).slice(0, 2000)}

SUBMITTED ARTICLE:
${body.article_text!.slice(0, 6000)}

Analyse across these dimensions:

1. MISSING SECTIONS — outline sections that have no equivalent in the article
2. WEAK SECTIONS — sections present but thin, vague, or missing the required answer
3. MISSING ENTITIES — core entities from research that don't appear in the article
4. UNSOURCED CLAIMS — specific stats or claims that need a cited source
5. E-E-A-T GAPS — where expertise/experience/authority/trust signals are absent
6. STRUCTURAL ISSUES — answer-first violations, paragraph length, list opportunities
7. QUICK WINS — the 3 highest-impact changes that would most improve this article

For each issue, be specific: quote the weak passage or name the missing section. Don't say "add more detail" — say exactly what detail is missing and why it matters.

Output JSON:
{
  "missing_sections": [{"h2": "", "why_needed": "", "suggested_content": ""}],
  "weak_sections": [{"heading": "", "current_issue": "", "specific_fix": ""}],
  "missing_entities": [{"entity": "", "type": "", "where_to_add": ""}],
  "unsourced_claims": [{"claim": "", "location": "", "suggested_source_type": ""}],
  "eeat_gaps": [{"signal": "", "current": "", "fix": ""}],
  "structural_issues": [{"issue": "", "location": "", "fix": ""}],
  "quick_wins": [{"title": "", "description": "", "impact": "high|medium"}],
  "overall_score": 0,
  "overall_verdict": ""
}`;

        const raw = await callModel(
          [{ role: "user", content: prompt }],
          { maxTokens: 6000, jsonMode: true, signal: controller.signal }
        );

        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start === -1 || end === -1) throw new Error("No JSON in response");

        const result = JSON.parse(raw.slice(start, end + 1));
        send({ type: "result", phase: "doc_gap", data: result });
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
