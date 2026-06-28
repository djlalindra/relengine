import { callModel, ChatMessage } from "./model-client";
import { runStructuralChecks, StructuralReport } from "./structural-checks";
import { fetchGoogleAiSerp, SerpResult } from "./fetchserp-client";
import { fetchFullPageContent, fetchMultiplePages, PageContent } from "./content-extractor";
import { buildGapReport, GapReport } from "./gap-report";

function getFetchserpApiKey(): string | undefined {
  return process.env.FETCHSERP_API_KEY;
}

/** Throws if the given signal has already been aborted -- used between
 * pipeline steps so a stopped request halts promptly instead of running
 * through several more (costly) model calls before noticing. */
function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Aborted by user.", "AbortError");
  }
}

/**
 * Fetches basic page content (title + text snippet) for a list of manually-
 * supplied URLs. Uses fetchSERP's no-JS scraping endpoint if a key is
 * configured (handles bot-protected sites better); falls back to a direct
 * fetch + naive text extraction if no fetchSERP key is set, so this still
 * works even without that API. Best-effort: failures per-URL are recorded
 * rather than thrown, since one bad URL shouldn't kill the whole batch.
 */
async function fetchManualUrlContent(
  urls: string[]
): Promise<{ title: string; url: string; description?: string }[]> {
  const apiKey = getFetchserpApiKey();
  const results: { title: string; url: string; description?: string }[] = [];

  for (const url of urls) {
    try {
      if (apiKey) {
        const response = await fetch(
          `https://www.fetchserp.com/api/v1/scrape_webpage_nojs?` +
            new URLSearchParams({ url }),
          {
            headers: {
              accept: "application/json",
              authorization: `Bearer ${apiKey}`,
            },
          }
        );
        if (response.ok) {
          const data = await response.json();
          const html: string = data?.web_page?.html ?? "";
          const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
          const title = titleMatch ? titleMatch[1].trim() : url;
          const textOnly = html
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          results.push({ title, url, description: textOnly.slice(0, 300) });
          continue;
        }
      }

      // Fallback: direct fetch, no API key needed. Best-effort only --
      // many sites block generic server-side fetches, so failures here
      // are expected and handled gracefully.
      const direct = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ContentAuditBot/1.0)" },
      });
      if (direct.ok) {
        const html = await direct.text();
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : url;
        const textOnly = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        results.push({ title, url, description: textOnly.slice(0, 300) });
      } else {
        results.push({ title: url, url, description: "(could not fetch this page)" });
      }
    } catch {
      results.push({ title: url, url, description: "(could not fetch this page)" });
    }
  }

  return results;
}

const MAX_RETRIES = 3;

export type PipelineResult = {
  topic: string;
  outline: string;
  draft: string;
  structuralReport: StructuralReport;
  outlineRetries: number;
  draftRetries: number;
  altTitles: string[];
  faqSuggestions: string[];
  grounding: {
    used: boolean;
    sourcesSeen: { title: string; url: string }[];
    error?: string;
    source: "manual" | "api" | "none";
  };
};

export type ProgressCallback = (step: string) => void;

const PLANNER_SYSTEM = `You are a senior SEO/AEO content strategist. You write outlines for blog posts that market a service while being structured for both traditional search engines and AI answer engines (ChatGPT, AI Overviews, Perplexity).

Rules for every outline you produce:
- Title (H1) is specific and includes the core topic, not generic.
- 4 to 6 H2 sections covering distinct subtopics, ordered logically.
- Each section description states the DIRECT ANSWER or main point that section will open with, in one sentence -- this is what will become the section's first line.
- Include one FAQ section near the end with 3-4 question-style subheadings (H3), each with a one-line description of the answer.
- No filler sections like "Introduction" or "Conclusion" framed generically -- every section must carry real informational weight.
- Output ONLY the outline in markdown. No preamble, no explanation.`;

const OUTLINE_VALIDATOR_SYSTEM = `You are a strict editorial reviewer. You check a blog outline against these requirements:
1. Has a specific (not generic) H1 title.
2. Has 4-6 H2 sections.
3. Each section's description states a clear, direct answer/point (not vague).
4. Has an FAQ section with 3+ question-style subheadings.
5. No filler "Introduction"/"Conclusion" sections with no real content.

Respond with EXACTLY one line in this format:
STATUS: ok
or
STATUS: retry
MISSING: <comma-separated list of what's missing or wrong, be specific>`;

const WRITER_SYSTEM = `You are a senior content writer specializing in SEO/AEO-optimized articles that market a professional service.

Rules:
- Follow the outline exactly: same H1, same H2 sections in the same order, same FAQ subsection.
- Each H2 section's FIRST sentence must directly answer or state the section's main point -- no throat-clearing like "In this section..." or "Let's explore...".
- Keep paragraphs under 150 words. Break up long paragraphs.
- Write in plain, direct language. No buzzwords, no hollow phrases like "in today's fast-paced world" or "unlock your potential."
- The FAQ section uses H3 for each question, with a direct 1-3 sentence answer immediately after.
- Do not invent specific statistics, named tools, or client results beyond what's provided as real grounding data -- where no real data is given, use placeholders like [METRIC] or [CASE STUDY] rather than fabricating one.
- Output ONLY the final markdown article. No preamble, no explanation, no meta-commentary.`;

const DRAFT_VALIDATOR_SYSTEM = `You are a strict editorial reviewer checking a drafted article against these requirements:
1. Every H2 section's first sentence directly answers/states the section's point (no filler openers).
2. No paragraph exceeds roughly 150 words.
3. No hollow marketing buzzwords ("unlock your potential", "fast-paced world", "synergy", "leverage" used as a verb loosely, "in today's landscape", etc.)
4. FAQ section present with direct answers.
5. No fabricated specific statistics or client names presented as fact (placeholders like [METRIC] are fine).

Respond with EXACTLY one line in this format:
STATUS: ok
or
STATUS: retry
MISSING: <comma-separated list of specific problems, quote the offending phrase where relevant>`;

function parseValidatorResponse(response: string): { ok: boolean; missing: string } {
  const statusMatch = response.match(/STATUS:\s*(ok|retry)/i);
  const missingMatch = response.match(/MISSING:\s*(.*)/i);
  const ok = statusMatch ? statusMatch[1].toLowerCase() === "ok" : false;
  const missing = missingMatch ? missingMatch[1].trim() : "";
  return { ok, missing };
}

function formatSourcesForPrompt(serp: SerpResult): string {
  const lines: string[] = [];

  if (serp.aiOverview.content) {
    lines.push(`Google AI Overview currently says: "${serp.aiOverview.content}"`);
  }

  const allSources = [
    ...serp.aiOverview.sources,
    ...serp.aiMode.sources,
    ...serp.organicResults,
  ];

  // De-duplicate by URL
  const seen = new Set<string>();
  const unique = allSources.filter((s) => {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  if (unique.length > 0) {
    lines.push("\nSources Google currently surfaces for this topic:");
    for (const s of unique.slice(0, 8)) {
      lines.push(`- ${s.title || "(untitled)"} -- ${s.url}${s.description ? `: ${s.description}` : ""}`);
    }
  }

  return lines.join("\n");
}

async function fetchGrounding(
  topic: string,
  onProgress: ProgressCallback,
  manualUrls: string[] = []
): Promise<{ context: string; sourcesSeen: { title: string; url: string }[]; used: boolean; error?: string; source: "manual" | "api" | "none" }> {
  // Manual URLs take priority -- if the person supplied their own list
  // (e.g. from manually checking Google), use that instead of calling
  // fetchSERP. This costs zero API credits and lets the person ground
  // generation in exactly the pages they chose, rather than whatever the
  // API call happens to return.
  if (manualUrls.length > 0) {
    onProgress(`Fetching content from ${manualUrls.length} supplied URL(s)...`);
    try {
      const pages = await fetchManualUrlContent(manualUrls);

      const lines: string[] = ["Sources supplied by the user for this topic:"];
      for (const p of pages) {
        lines.push(`- ${p.title} -- ${p.url}${p.description ? `: ${p.description}` : ""}`);
      }

      const sourcesSeen = pages.map((p) => ({ title: p.title, url: p.url }));

      onProgress(`Fetched content from ${pages.length} supplied URL(s).`);

      return {
        context: lines.join("\n"),
        sourcesSeen,
        used: true,
        source: "manual",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error fetching supplied URLs.";
      onProgress(`Could not fetch supplied URLs (${message}). Continuing without them.`);
      return { context: "", sourcesSeen: [], used: false, error: message, source: "none" };
    }
  }

  onProgress("Fetching real Google AI Overview / AI Mode data...");

  try {
    const serp = await fetchGoogleAiSerp(topic);
    const context = formatSourcesForPrompt(serp);

    const sourcesSeen = [
      ...serp.aiOverview.sources,
      ...serp.aiMode.sources,
      ...serp.organicResults,
    ]
      .filter((s) => s.url)
      .map((s) => ({ title: s.title || "(untitled)", url: s.url }));

    const seen = new Set<string>();
    const uniqueSourcesSeen = sourcesSeen.filter((s) => {
      if (seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });

    onProgress(
      uniqueSourcesSeen.length > 0
        ? `Found ${uniqueSourcesSeen.length} real source(s) Google currently surfaces for this topic.`
        : "Google AI data fetched, but no source URLs were returned for this query."
    );

    return { context, sourcesSeen: uniqueSourcesSeen, used: true, source: "api" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown grounding error.";
    onProgress(`Grounding unavailable (${message}). Continuing without real SERP data.`);
    return { context: "", sourcesSeen: [], used: false, error: message, source: "none" };
  }
}

async function planOutline(
  topic: string,
  onProgress: ProgressCallback,
  groundingContext: string,
  signal?: AbortSignal
): Promise<{ outline: string; retries: number }> {
  let outline = "";
  let retries = 0;
  let feedback = "";

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    throwIfAborted(signal);
    onProgress(
      attempt === 0
        ? "Drafting outline..."
        : `Revising outline (attempt ${attempt + 1})...`
    );

    const groundingBlock = groundingContext
      ? `\n\nReal current Google data for this topic (use this to inform what subtopics matter and what readers/AI engines are actually seeing -- do not just copy it):\n${groundingContext}`
      : "";

    const messages: ChatMessage[] = [
      { role: "system", content: PLANNER_SYSTEM },
      {
        role: "user",
        content: feedback
          ? `Topic/service: ${topic}${groundingBlock}\n\nYour previous outline had issues: ${feedback}\n\nProduce a corrected outline.`
          : `Topic/service: ${topic}${groundingBlock}`,
      },
    ];

    outline = await callModel(messages, { temperature: 0.6, signal });

    throwIfAborted(signal);
    onProgress("Checking outline quality...");
    const validatorMessages: ChatMessage[] = [
      { role: "system", content: OUTLINE_VALIDATOR_SYSTEM },
      { role: "user", content: outline },
    ];
    const validatorResponse = await callModel(validatorMessages, {
      temperature: 0,
      signal,
    });
    const { ok, missing } = parseValidatorResponse(validatorResponse);

    if (ok) {
      return { outline, retries };
    }

    feedback = missing || "Outline did not meet requirements.";
    retries++;
  }

  // Exhausted retries -- return best effort outline rather than failing the
  // whole pipeline. The structural checker on the final draft will still
  // surface any remaining issues to the user.
  return { outline, retries };
}

async function writeDraft(
  topic: string,
  outline: string,
  onProgress: ProgressCallback,
  groundingContext: string,
  signal?: AbortSignal
): Promise<{ draft: string; retries: number }> {
  let draft = "";
  let retries = 0;
  let feedback = "";

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    throwIfAborted(signal);
    onProgress(
      attempt === 0
        ? "Writing draft..."
        : `Revising draft (attempt ${attempt + 1})...`
    );

    const groundingBlock = groundingContext
      ? `\n\nReal current Google data for this topic (ground specific claims in this where relevant, and feel free to reference what's currently surfacing, but do not fabricate beyond what's given here):\n${groundingContext}`
      : "";

    const messages: ChatMessage[] = [
      { role: "system", content: WRITER_SYSTEM },
      {
        role: "user",
        content: feedback
          ? `Topic/service: ${topic}\n\nOutline to follow:\n${outline}${groundingBlock}\n\nYour previous draft had issues: ${feedback}\n\nProduce a corrected full article.`
          : `Topic/service: ${topic}\n\nOutline to follow:\n${outline}${groundingBlock}`,
      },
    ];

    draft = await callModel(messages, { temperature: 0.7, maxTokens: 4000, signal });

    throwIfAborted(signal);
    onProgress("Checking draft quality...");
    const validatorMessages: ChatMessage[] = [
      { role: "system", content: DRAFT_VALIDATOR_SYSTEM },
      { role: "user", content: draft },
    ];
    const validatorResponse = await callModel(validatorMessages, {
      temperature: 0,
      signal,
    });
    const { ok, missing } = parseValidatorResponse(validatorResponse);

    if (ok) {
      return { draft, retries };
    }

    feedback = missing || "Draft did not meet requirements.";
    retries++;
  }

  return { draft, retries };
}

async function generateAltTitlesAndFaq(
  topic: string,
  draft: string,
  onProgress: ProgressCallback,
  signal?: AbortSignal
): Promise<{ altTitles: string[]; faqSuggestions: string[] }> {
  throwIfAborted(signal);
  onProgress("Generating alternate titles and FAQ suggestions...");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `Given a finished article, produce:
1. Three alternate H1 titles (different angles: benefit-led, question-led, specific-outcome-led).
2. Two additional FAQ question candidates not already covered in the article, relevant to AI answer engines surfacing this topic.

Respond in exactly this format, no extra commentary:
TITLES:
- title one
- title two
- title three
FAQS:
- question one
- question two`,
    },
    { role: "user", content: `Topic: ${topic}\n\nArticle:\n${draft}` },
  ];

  const response = await callModel(messages, { temperature: 0.8, signal });

  const titlesBlock = response.match(/TITLES:\s*([\s\S]*?)FAQS:/i);
  const faqsBlock = response.match(/FAQS:\s*([\s\S]*)/i);

  const altTitles = titlesBlock
    ? titlesBlock[1]
        .split("\n")
        .map((l) => l.replace(/^-\s*/, "").trim())
        .filter(Boolean)
    : [];

  const faqSuggestions = faqsBlock
    ? faqsBlock[1]
        .split("\n")
        .map((l) => l.replace(/^-\s*/, "").trim())
        .filter(Boolean)
    : [];

  return { altTitles, faqSuggestions };
}

export type AuditPipelineResult = {
  topic: string;
  targetUrl: string;
  gapReport: GapReport;
  rewriteSuggestions: string;
  structuralReport: StructuralReport;
  errors: string[];
};

const REWRITE_SUGGESTIONS_SYSTEM = `You are a senior SEO/AEO content strategist. You are given:
1. A target page's existing content
2. A list of entities that competitor pages mention but the target page doesn't
3. A list of competitor passages that have no strong semantic equivalent in the target page

Your job: write specific, actionable rewrite suggestions for the target page. For each major gap, suggest:
- Which section of the target page to add content to (or a new section to add)
- What specifically should be added (referencing the missing entity or topic, in plain terms)
- Keep suggestions concrete and tied to the actual gaps given -- do not invent generic SEO advice unrelated to the specific data provided.

Output as a markdown bulleted list, grouped by section/topic. No preamble.`;

async function generateRewriteSuggestions(
  target: PageContent,
  gapReport: GapReport,
  onProgress: ProgressCallback,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal);
  onProgress("Generating rewrite suggestions from the gap report...");

  if (gapReport.missingEntities.length === 0 && gapReport.semanticCoverage.uncoveredPassages.length === 0) {
    return "No significant gaps found -- the target page's entity coverage and semantic coverage are already in line with the competitor set analyzed.";
  }

  const entitySummary = gapReport.missingEntities
    .slice(0, 20)
    .map(
      (e) =>
        `- ${e.name} (${e.type}) -- mentioned in ${e.appearsInCompetitors} competitor page(s), avg salience ${e.avgSalienceInCompetitors.toFixed(2)}`
    )
    .join("\n");

  const passageSummary = gapReport.semanticCoverage.uncoveredPassages
    .slice(0, 15)
    .map(
      (p) =>
        `- From ${p.competitorUrl} (best match score in target: ${p.bestMatchScore.toFixed(2)}): "${p.competitorChunk.slice(0, 200)}${p.competitorChunk.length > 200 ? "..." : ""}"`
    )
    .join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: REWRITE_SUGGESTIONS_SYSTEM },
    {
      role: "user",
      content: `Target page URL: ${target.url}\n\nTarget page content (for reference):\n${target.text.slice(0, 8000)}\n\nEntities competitors mention that the target page is missing:\n${entitySummary || "(none)"}\n\nCompetitor passages with no strong semantic match in the target page:\n${passageSummary || "(none)"}\n\nProduce specific rewrite suggestions.`,
    },
  ];

  return await callModel(messages, { temperature: 0.5, maxTokens: 2000, signal });
}

/**
 * The primary audit pipeline: requires a target URL. Fetches the target
 * page and all competitor pages in full, extracts entities, computes
 * passage-level semantic coverage, and produces a gap report plus concrete
 * rewrite suggestions. This is the "tell me what's missing" workflow,
 * distinct from runPipeline's "write something new from scratch" workflow.
 */
export async function runAuditPipeline(
  topic: string,
  targetUrl: string,
  competitorUrls: string[],
  onProgress: ProgressCallback = () => {},
  signal?: AbortSignal
): Promise<AuditPipelineResult> {
  throwIfAborted(signal);
  onProgress("Fetching target page content...");
  const target = await fetchFullPageContent(targetUrl);

  if (target.fetchError) {
    onProgress(`Warning: target page fetch failed (${target.fetchError}).`);
  } else {
    onProgress(`Fetched target page (${target.wordCount} words).`);
  }

  throwIfAborted(signal);
  onProgress(`Fetching ${competitorUrls.length} competitor page(s)...`);
  const competitors = await fetchMultiplePages(competitorUrls);
  const successCount = competitors.filter((c) => !c.fetchError).length;
  onProgress(`Fetched ${successCount}/${competitorUrls.length} competitor page(s) successfully.`);

  throwIfAborted(signal);
  onProgress("Extracting entities (Cloud Natural Language)...");
  onProgress("Computing semantic passage coverage (Vertex Embeddings)...");
  const gapReport = await buildGapReport(target, competitors);

  throwIfAborted(signal);
  const rewriteSuggestions = await generateRewriteSuggestions(
    target,
    gapReport,
    onProgress,
    signal
  );

  throwIfAborted(signal);
  onProgress("Running structural checks on target page...");
  const structuralReport = runStructuralChecks(target.text);

  return {
    topic,
    targetUrl,
    gapReport,
    rewriteSuggestions,
    structuralReport,
    errors: gapReport.errors,
  };
}

export async function runPipeline(
  topic: string,
  onProgress: ProgressCallback = () => {},
  manualUrls: string[] = [],
  signal?: AbortSignal
): Promise<PipelineResult> {
  throwIfAborted(signal);
  const grounding = await fetchGrounding(topic, onProgress, manualUrls);

  throwIfAborted(signal);
  const { outline, retries: outlineRetries } = await planOutline(
    topic,
    onProgress,
    grounding.context,
    signal
  );

  throwIfAborted(signal);
  const { draft, retries: draftRetries } = await writeDraft(
    topic,
    outline,
    onProgress,
    grounding.context,
    signal
  );

  throwIfAborted(signal);
  const { altTitles, faqSuggestions } = await generateAltTitlesAndFaq(
    topic,
    draft,
    onProgress,
    signal
  );

  throwIfAborted(signal);
  onProgress("Running structural checks...");
  const structuralReport = runStructuralChecks(draft);

  return {
    topic,
    outline,
    draft,
    structuralReport,
    outlineRetries,
    draftRetries,
    altTitles,
    faqSuggestions,
    grounding: {
      used: grounding.used,
      sourcesSeen: grounding.sourcesSeen,
      error: grounding.error,
      source: grounding.source,
    },
  };
}
