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

// Infer industry-trusted domains from the keyword
function getIndustryDomains(keyword: string): string[] {
  const kw = keyword.toLowerCase();

  if (/law firm|solicitor|barrister|legal|attorney|counsel/.test(kw)) {
    return [
      "site:americanbar.org",
      "site:lawsociety.org.uk",
      "site:sra.org.uk",
      "site:clio.com",
      "site:legalweek.com",
      "site:law.com",
      "site:lexology.com",
      "site:acc.com",
      "site:barstandardsboard.org.uk",
    ];
  }
  if (/healthcare|hospital|medical|clinic|pharma|nhs/.test(kw)) {
    return [
      "site:who.int",
      "site:nih.gov",
      "site:cdc.gov",
      "site:nejm.org",
      "site:bmj.com",
      "site:nhs.uk",
      "site:jamanetwork.com",
    ];
  }
  if (/finance|fintech|banking|investment|accounting/.test(kw)) {
    return [
      "site:fdic.gov",
      "site:federalreserve.gov",
      "site:fsb.org.uk",
      "site:fca.org.uk",
      "site:cfainstitute.org",
      "site:bis.org",
      "site:imf.org",
    ];
  }
  if (/education|school|university|learning|training/.test(kw)) {
    return [
      "site:ed.gov",
      "site:educause.edu",
      "site:nces.ed.gov",
      "site:oecd.org",
      "site:nesta.org.uk",
    ];
  }
  if (/marketing|seo|content|digital|advertising/.test(kw)) {
    return [
      "site:searchengineland.com",
      "site:moz.com",
      "site:semrush.com/blog",
      "site:hubspot.com",
      "site:contentmarketinginstitute.com",
      "site:marketingweek.com",
    ];
  }
  if (/real estate|property|housing|mortgage/.test(kw)) {
    return [
      "site:nar.realtor",
      "site:hud.gov",
      "site:freddiemac.com",
      "site:fanniemae.com",
      "site:rics.org",
    ];
  }

  // Default: government and education first
  return [
    "site:.gov",
    "site:.edu",
    "site:who.int",
    "site:oecd.org",
    "site:worldbank.org",
    "site:statista.com",
  ];
}

async function findSources(
  placeholders: string[],
  keyword: string,
  signal: AbortSignal
): Promise<SourcedClaim[]> {
  const industryDomains = getIndustryDomains(keyword);
  const results: SourcedClaim[] = [];

  for (const claim of placeholders.slice(0, 12)) {
    try {
      // Try industry-specific domains first, fall back to broad gov/edu
      const domainFilter = industryDomains.slice(0, 3).join(" OR ");
      const query = `${claim} (${domainFilter} OR site:.gov OR site:.edu)`;
      const urls = await getGroundedUrls(query, 4, signal);

      // Score and pick best source
      const scored = urls.map((u) => {
        const hostname = new URL(u.resolvedUri || u.uri).hostname;
        const isGov = hostname.endsWith(".gov") || hostname.includes(".gov.");
        const isEdu = hostname.endsWith(".edu") || hostname.includes(".edu.");
        const isIndustry = industryDomains.some((d) =>
          hostname.includes(d.replace("site:", "").replace(/^www\./, ""))
        );
        const score = isGov ? 3 : isEdu ? 2 : isIndustry ? 1 : 0;
        return { u, hostname, score, isGov, isEdu };
      });
      scored.sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (best) {
        const type: SourcedClaim["source_type"] = best.isGov
          ? "gov"
          : best.isEdu
          ? "edu"
          : "institutional";
        results.push({
          claim,
          source_url: best.u.resolvedUri || best.u.uri,
          source_title: best.u.title || best.hostname,
          source_type: type,
          supports_claim: true,
          year: new Date().getFullYear().toString(),
        });
      }
    } catch {
      // skip failed source lookups
    }
  }
  return results;
}

async function findStats(
  keyword: string,
  draftMarkdown: string,
  signal: AbortSignal
): Promise<SourcedClaim[]> {
  const industryDomains = getIndustryDomains(keyword);
  const results: SourcedClaim[] = [];

  // Build stat queries — one broad, one industry-specific
  const statQueries = [
    `${keyword} statistics data percentage survey report`,
    `${keyword} statistics ${industryDomains.slice(0, 2).join(" OR ")}`,
    `${keyword} benchmark study findings`,
  ];

  for (const query of statQueries) {
    try {
      const urls = await getGroundedUrls(query, 3, signal);
      for (const u of urls) {
        const hostname = new URL(u.resolvedUri || u.uri).hostname;
        const isGov = hostname.endsWith(".gov") || hostname.includes(".gov.");
        const isEdu = hostname.endsWith(".edu") || hostname.includes(".edu.");
        const type: SourcedClaim["source_type"] = isGov ? "gov" : isEdu ? "edu" : "institutional";

        // Only add if not already in results
        if (!results.find((r) => r.source_url === (u.resolvedUri || u.uri))) {
          results.push({
            claim: `Statistics/data on: ${keyword}`,
            source_url: u.resolvedUri || u.uri,
            source_title: u.title || hostname,
            source_type: type,
            supports_claim: true,
            year: new Date().getFullYear().toString(),
          });
        }
        if (results.length >= 6) break;
      }
    } catch {
      // skip
    }
    if (results.length >= 6) break;
  }

  void draftMarkdown;
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
    rerun_comment?: string;
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
        send({ type: "progress", step: "Finding authoritative sources for claims…" });
        const sourcedClaims = await findSources(
          body.placeholders ?? [],
          body.keyword ?? "",
          controller.signal
        );

        send({ type: "progress", step: "Searching for statistics and data references…" });
        const statSources = await findStats(
          body.keyword ?? "",
          body.draft_markdown ?? "",
          controller.signal
        );

        const allSources = [...sourcedClaims, ...statSources];

        send({ type: "progress", step: "Searching for charts and images from authoritative sources…" });
        const suggestedImages = await findImages(body.keyword ?? "", controller.signal);

        send({ type: "progress", step: "Fact-checking and compiling Harvard references (Claude Sonnet 5)…" });
        const raw = await callClaude(
          RESEARCH_SYSTEM,
          buildFactCheckPrompt(
            body.draft_markdown ?? "",
            JSON.stringify(allSources, null, 2),
            body.rerun_comment
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
          data: { ...factcheck, sourced_claims: allSources, suggested_images: suggestedImages },
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
