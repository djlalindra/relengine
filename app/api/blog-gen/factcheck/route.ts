import { NextRequest } from "next/server";
import { callClaude, SONNET_5 } from "@/lib/blog-gen/anthropic-client";
import { callModel } from "@/lib/pipeline/model-client";
import { getGroundedUrls } from "@/lib/pipeline/grounding-client";
import { buildFactCheckPrompt, RESEARCH_SYSTEM } from "@/lib/blog-gen/prompts";
import type { SourcedClaim, SuggestedImage } from "@/lib/blog-gen/types";

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found");
  return JSON.parse(text.slice(start, end + 1));
}

async function findSources(
  placeholders: string[],
  keyword: string,
  signal: AbortSignal
): Promise<SourcedClaim[]> {
  const results: SourcedClaim[] = [];
  for (const claim of placeholders.slice(0, 10)) {
    try {
      const query = `${claim} site:.gov OR site:.edu OR site:who.int OR site:nih.gov`;
      const urls = await getGroundedUrls(query, 3, signal);
      for (const u of urls) {
        const hostname = new URL(u.resolvedUri || u.uri).hostname;
        const type: SourcedClaim["source_type"] =
          hostname.endsWith(".gov")
            ? "gov"
            : hostname.endsWith(".edu")
            ? "edu"
            : "institutional";
        results.push({
          claim,
          source_url: u.resolvedUri || u.uri,
          source_title: u.title || hostname,
          source_type: type,
          supports_claim: true,
          year: new Date().getFullYear().toString(),
        });
        break;
      }
    } catch {
      // skip failed source lookups
    }
  }
  return results;
}

async function findImages(
  keyword: string,
  signal: AbortSignal
): Promise<SuggestedImage[]> {
  const images: SuggestedImage[] = [];
  try {
    const query = `${keyword} chart infographic filetype:png site:.gov OR site:.edu OR site:ourworldindata.org`;
    const urls = await getGroundedUrls(query, 5, signal);

    // Ask Gemini to suggest image placements from the found URLs
    const prompt = `Given these URLs found for the topic "${keyword}", identify which ones likely contain charts, graphs, or infographics that would illustrate the article. For each relevant image URL, provide a caption and Harvard-style attribution.

URLs:
${urls.map((u) => `${u.title}: ${u.resolvedUri || u.uri}`).join("\n")}

Output JSON array (max 3 items):
[{"url": "", "caption": "", "attribution": "", "harvard_ref": "", "place_after_section": ""}]

Only include image URLs that directly link to image files (.png, .jpg, .gif, .svg) or known image hosting paths. If none qualify, return [].`;

    const raw = await callModel(
      [{ role: "user", content: prompt }],
      { maxTokens: 2000, jsonMode: true, signal }
    );

    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start !== -1 && end !== -1) {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as SuggestedImage[];
      images.push(...parsed);
    }
  } catch {
    // images are optional
  }
  return images;
}

export async function POST(req: NextRequest) {
  let body: {
    keyword?: string;
    draft_markdown?: string;
    placeholders?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 });
  }

  if (!body.draft_markdown) {
    return new Response(JSON.stringify({ error: "draft_markdown is required." }), { status: 400 });
  }

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const stream = new ReadableStream({
    async start(streamController) {
      const encoder = new TextEncoder();
      const send = (data: object) => streamController.enqueue(encoder.encode(sse(data)));

      try {
        send({ type: "progress", step: "Finding authoritative sources…" });
        const sourcedClaims = await findSources(
          body.placeholders ?? [],
          body.keyword ?? "",
          controller.signal
        );

        send({ type: "progress", step: "Searching for charts and images from authoritative sources…" });
        const suggestedImages = await findImages(body.keyword ?? "", controller.signal);

        send({ type: "progress", step: "Fact-checking and compiling Harvard references (Claude Sonnet 5)…" });
        const raw = await callClaude(
          RESEARCH_SYSTEM,
          buildFactCheckPrompt(
            body.draft_markdown ?? "",
            JSON.stringify(sourcedClaims, null, 2)
          ),
          { model: SONNET_5, maxTokens: 10000, signal: controller.signal }
        );

        const factcheck = parseJson(raw) as {
          p9?: unknown;
          p10?: unknown;
          corrected_markdown?: string;
        };

        send({
          type: "result",
          phase: "factcheck",
          data: { ...factcheck, sourced_claims: sourcedClaims, suggested_images: suggestedImages },
        });
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
