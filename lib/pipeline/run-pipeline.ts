import { callModel, ChatMessage } from "./model-client";
import { runStructuralChecks, StructuralReport } from "./structural-checks";

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
- Do not invent specific statistics, named tools, or client results -- write structurally complete content with placeholders like [METRIC] or [CASE STUDY] where a real example would go, rather than fabricating one.
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

async function planOutline(
  topic: string,
  onProgress: ProgressCallback
): Promise<{ outline: string; retries: number }> {
  let outline = "";
  let retries = 0;
  let feedback = "";

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    onProgress(
      attempt === 0
        ? "Drafting outline..."
        : `Revising outline (attempt ${attempt + 1})...`
    );

    const messages: ChatMessage[] = [
      { role: "system", content: PLANNER_SYSTEM },
      {
        role: "user",
        content: feedback
          ? `Topic/service: ${topic}\n\nYour previous outline had issues: ${feedback}\n\nProduce a corrected outline.`
          : `Topic/service: ${topic}`,
      },
    ];

    outline = await callModel(messages, { temperature: 0.6 });

    onProgress("Checking outline quality...");
    const validatorMessages: ChatMessage[] = [
      { role: "system", content: OUTLINE_VALIDATOR_SYSTEM },
      { role: "user", content: outline },
    ];
    const validatorResponse = await callModel(validatorMessages, {
      temperature: 0,
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
  onProgress: ProgressCallback
): Promise<{ draft: string; retries: number }> {
  let draft = "";
  let retries = 0;
  let feedback = "";

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    onProgress(
      attempt === 0
        ? "Writing draft..."
        : `Revising draft (attempt ${attempt + 1})...`
    );

    const messages: ChatMessage[] = [
      { role: "system", content: WRITER_SYSTEM },
      {
        role: "user",
        content: feedback
          ? `Topic/service: ${topic}\n\nOutline to follow:\n${outline}\n\nYour previous draft had issues: ${feedback}\n\nProduce a corrected full article.`
          : `Topic/service: ${topic}\n\nOutline to follow:\n${outline}`,
      },
    ];

    draft = await callModel(messages, { temperature: 0.7, maxTokens: 4000 });

    onProgress("Checking draft quality...");
    const validatorMessages: ChatMessage[] = [
      { role: "system", content: DRAFT_VALIDATOR_SYSTEM },
      { role: "user", content: draft },
    ];
    const validatorResponse = await callModel(validatorMessages, {
      temperature: 0,
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
  onProgress: ProgressCallback
): Promise<{ altTitles: string[]; faqSuggestions: string[] }> {
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

  const response = await callModel(messages, { temperature: 0.8 });

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

export async function runPipeline(
  topic: string,
  onProgress: ProgressCallback = () => {}
): Promise<PipelineResult> {
  const { outline, retries: outlineRetries } = await planOutline(
    topic,
    onProgress
  );

  const { draft, retries: draftRetries } = await writeDraft(
    topic,
    outline,
    onProgress
  );

  const { altTitles, faqSuggestions } = await generateAltTitlesAndFaq(
    topic,
    draft,
    onProgress
  );

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
  };
}
