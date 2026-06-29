import { callModel } from "./model-client";

export type QueryIntent =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational"
  | "question"
  | "comparison"
  | "local";

export type FanOutQuery = {
  query: string;
  type: string;
};

export type FanOutCategory = {
  name: string;
  intent: QueryIntent;
  queries: FanOutQuery[];
};

export type FanOutResult = {
  seed: string;
  categories: FanOutCategory[];
  totalQueries: number;
  entities: string[];
  generatedAt: string;
};

const SYSTEM = `You are an expert SEO strategist specialising in search intent mapping and query architecture.
Return only valid JSON — no markdown, no code fences, no explanation.`;

export async function runFanOut(
  seed: string,
  onProgress: (step: string) => void,
  signal?: AbortSignal
): Promise<FanOutResult> {
  onProgress(`Building query architecture for "${seed}"…`);

  const prompt = `Seed keyword: "${seed}"

Generate a comprehensive SEO query architecture with at least 100 distinct search queries.
Organise them into exactly these 7 categories:

1. Informational  (intent: "informational")  — how-to, guides, definitions, tutorials  (≥20 queries)
2. Commercial     (intent: "commercial")     — best, top, reviews, comparisons for buyers (≥15 queries)
3. Transactional  (intent: "transactional") — buy, price, deal, coupon, near-me purchase  (≥10 queries)
4. Question-Based (intent: "question")      — who/what/when/where/why/how question forms  (≥20 queries)
5. Comparison     (intent: "comparison")    — X vs Y, alternatives, differences           (≥10 queries)
6. Long-tail      (intent: "informational") — 4-6 word highly-specific variations          (≥15 queries)
7. Local Intent   (intent: "local")         — near me, city/region modifiers               (≥10 queries)

Each query object must have:
  "query"  : the full search query string
  "type"   : a short label like "how-to", "best-of", "vs", "price", "near-me", "definition", etc.

Also return 10–15 key entities (brands, concepts, products) central to this topic.

Respond with ONLY this JSON structure:
{
  "categories": [
    {
      "name": "Informational",
      "intent": "informational",
      "queries": [{ "query": "...", "type": "..." }, ...]
    },
    ...6 more categories...
  ],
  "entities": ["entity1", "entity2", ...]
}`;

  const raw = await callModel(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
    ],
    { temperature: 0.85, maxTokens: 8000, signal }
  );

  onProgress("Parsing query architecture…");

  let parsed: { categories: FanOutCategory[]; entities: string[] };
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Model returned unparseable JSON for query architecture.");
  }

  if (!Array.isArray(parsed.categories) || parsed.categories.length === 0) {
    throw new Error("Model returned an unexpected structure — no categories found.");
  }

  const totalQueries = parsed.categories.reduce(
    (sum, c) => sum + (c.queries?.length ?? 0),
    0
  );

  onProgress(
    `Done — ${totalQueries} queries across ${parsed.categories.length} intent categories.`
  );

  return {
    seed,
    categories: parsed.categories,
    totalQueries,
    entities: Array.isArray(parsed.entities) ? parsed.entities : [],
    generatedAt: new Date().toISOString(),
  };
}
