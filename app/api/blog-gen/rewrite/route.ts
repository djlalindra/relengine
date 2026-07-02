import { NextRequest } from "next/server";
import { callClaude, SONNET_5 } from "@/lib/blog-gen/anthropic-client";
import { WRITER_SYSTEM } from "@/lib/blog-gen/prompts";

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
    article_text?: string;
    gap_report?: object;
    research?: object;
    ideal_outline?: object;
    manual_eeat_notes?: string;
    source_brief?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 });
  }

  if (!body.article_text || !body.gap_report) {
    return new Response(JSON.stringify({ error: "article_text and gap_report are required." }), { status: 400 });
  }

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();
      const send = (data: object) => streamController.enqueue(encoder.encode(sse(data)));

      try {
        send({ type: "progress", step: "Rewriting article with gap fixes applied (Claude Sonnet 5)…" });

        const gap = body.gap_report as {
          quick_wins?: { title: string; description: string }[];
          missing_sections?: { h2: string; why_needed: string; suggested_content: string }[];
          weak_sections?: { heading: string; current_issue: string; specific_fix: string }[];
          unsourced_claims?: { claim: string; location: string; suggested_source_type: string }[];
          missing_entities?: { entity: string; type: string; where_to_add: string }[];
          eeat_gaps?: { signal: string; fix: string }[];
          structural_issues?: { issue: string; fix: string }[];
        };

        const fixList: string[] = [];

        if (gap.missing_sections?.length) {
          fixList.push("ADD THESE MISSING SECTIONS:");
          gap.missing_sections.forEach((s) => fixList.push(`  • H2: "${s.h2}" — ${s.why_needed}. Suggested content: ${s.suggested_content}`));
        }
        if (gap.weak_sections?.length) {
          fixList.push("STRENGTHEN THESE WEAK SECTIONS:");
          gap.weak_sections.forEach((s) => fixList.push(`  • "${s.heading}": ${s.specific_fix}`));
        }
        if (gap.missing_entities?.length) {
          fixList.push("ADD THESE MISSING ENTITIES:");
          gap.missing_entities.forEach((e) => fixList.push(`  • ${e.entity} (${e.type}) — add to: ${e.where_to_add}`));
        }
        if (gap.eeat_gaps?.length) {
          fixList.push("FIX THESE E-E-A-T GAPS:");
          gap.eeat_gaps.forEach((e) => fixList.push(`  • ${e.signal}: ${e.fix}`));
        }
        if (gap.structural_issues?.length) {
          fixList.push("FIX THESE STRUCTURAL ISSUES:");
          gap.structural_issues.forEach((s) => fixList.push(`  • ${s.fix}`));
        }
        if (gap.unsourced_claims?.length) {
          fixList.push("THESE CLAIMS NEED SOURCES — add [NEEDS SOURCE: claim] placeholders:");
          gap.unsourced_claims.forEach((c) => fixList.push(`  • "${c.claim}" (${c.location})`));
        }

        const sourceBriefBlock = body.source_brief
          ? `\nVERIFIED SOURCES — embed as named attributions with hyperlinks on the stat:\n${body.source_brief}\nExample: "A 2024 Clio report found that [73% of law firm clients](url) research online before hiring."\n`
          : "";

        const prompt = `You are rewriting an existing article to fix specific identified gaps. Keep sections that are already strong. Rewrite or expand only what the gap report identifies as weak or missing. Maintain the author's voice and any specific examples or anecdotes already present.

EXISTING ARTICLE:
${body.article_text!.slice(0, 6000)}

IDEAL OUTLINE (structure to follow):
${JSON.stringify(body.ideal_outline, null, 2).slice(0, 1500)}

RESEARCH BRIEF (context and entities):
${JSON.stringify(body.research, null, 2).slice(0, 1500)}
${sourceBriefBlock}
REQUIRED FIXES — apply every one of these:
${fixList.join("\n")}

${body.manual_eeat_notes ? `E-E-A-T NOTES TO WEAVE IN VERBATIM: ${body.manual_eeat_notes}` : ""}

Rules:
- Keep strong sections intact — do not rewrite what works
- Add every missing section and entity identified above
- Fix every weak section using the specific fix described
- Answer-first structure: every section opens with the direct answer
- Sentences under 25 words, paragraphs 3–5 sentences max
- Do NOT label anything "(Hypothetical Example)"
- Output JSON:
{
  "draft_markdown": "...",
  "placeholders_needing_sources": [],
  "manual_eeat_used": false
}`;

        const raw = await callClaude(WRITER_SYSTEM, prompt, {
          model: SONNET_5,
          maxTokens: 14000,
          signal: controller.signal,
        });

        const draft = parseJson(raw);
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
