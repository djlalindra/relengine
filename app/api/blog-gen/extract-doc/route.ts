import { NextRequest } from "next/server";
import mammoth from "mammoth";
import { callModel } from "@/lib/pipeline/model-client";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return new Response(JSON.stringify({ error: "No file uploaded." }), { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const name = file.name.toLowerCase();

    let text = "";

    if (name.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else if (name.endsWith(".txt") || name.endsWith(".md")) {
      text = buffer.toString("utf-8");
    } else {
      return new Response(JSON.stringify({ error: "Unsupported file type. Upload a .docx or .txt file." }), { status: 400 });
    }

    text = text.trim();
    if (!text || text.split(/\s+/).length < 50) {
      return new Response(JSON.stringify({ error: "Document appears empty or too short (under 50 words)." }), { status: 400 });
    }

    // Extract keyword and core theme from the document
    const snippet = text.slice(0, 3000);
    const raw = await callModel(
      [
        {
          role: "user",
          content: `Read this article extract and identify:
1. The primary SEO keyword this article targets (the phrase someone would search to find this content — be specific, 3–7 words)
2. The core topic in one sentence

Extract:
${snippet}

Output JSON only:
{
  "suggested_keyword": "",
  "core_topic": ""
}`,
        },
      ],
      { maxTokens: 500, jsonMode: true }
    );

    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const meta = start !== -1 && end !== -1
      ? JSON.parse(raw.slice(start, end + 1)) as { suggested_keyword?: string; core_topic?: string }
      : {};

    return new Response(
      JSON.stringify({
        text,
        word_count: text.split(/\s+/).filter(Boolean).length,
        suggested_keyword: meta.suggested_keyword ?? "",
        core_topic: meta.core_topic ?? "",
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Failed to extract document." }),
      { status: 500 }
    );
  }
}
