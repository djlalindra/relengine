import { LanguageServiceClient } from "@google-cloud/language";
import { callModel } from "./model-client";
import { getEmbeddings, cosineSimilarity } from "./embeddings-client";

let clientInstance: LanguageServiceClient | null = null;

function getClient(): LanguageServiceClient {
  if (clientInstance) return clientInstance;

  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credsJson)
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is not set in the environment.");

  let credentials;
  try {
    credentials = JSON.parse(credsJson);
  } catch {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON.");
  }

  clientInstance = new LanguageServiceClient({ credentials });
  return clientInstance;
}

export type AnalyzedEntity = {
  name: string;
  type: string;
  salience: number;
  mentions: number;
  sentimentScore: number | null;
  wikipediaUrl?: string;
};

export type RelatedKeyword = {
  keyword: string;
  similarity: number; // 0–100, cosine similarity × 100
};

export type EntityAnalyzerResult = {
  entities: AnalyzedEntity[];
  documentSentiment: {
    score: number;
    magnitude: number;
    label: "Very Positive" | "Positive" | "Neutral" | "Negative" | "Very Negative" | "Mixed";
  };
  categories: { name: string; confidence: number }[];
  aiBreakdown: string;
  relatedKeywords: RelatedKeyword[];
  wordCount: number;
  entityCount: number;
};

function sentimentLabel(
  score: number,
  magnitude: number
): EntityAnalyzerResult["documentSentiment"]["label"] {
  if (magnitude < 0.4) return "Neutral";
  if (magnitude > 2.5 && Math.abs(score) < 0.2) return "Mixed";
  if (score >= 0.5) return "Very Positive";
  if (score >= 0.1) return "Positive";
  if (score <= -0.5) return "Very Negative";
  if (score <= -0.1) return "Negative";
  return "Neutral";
}

export async function runEntityAnalyzer(
  text: string,
  keywords: string,
  onProgress: (step: string) => void,
  signal?: AbortSignal
): Promise<EntityAnalyzerResult> {
  const client = getClient();
  const truncated = text.slice(0, 75000); // ~10 000 words
  const wordCount = truncated.trim().split(/\s+/).filter(Boolean).length;
  const canClassify = wordCount >= 20;

  onProgress("Calling Google Natural Language API…");

  const [annotateResult] = await client.annotateText({
    document: { content: truncated, type: "PLAIN_TEXT" },
    features: {
      extractEntities: true,
      extractDocumentSentiment: true,
      ...(canClassify ? { classifyText: true } : {}),
    },
  });

  if (signal?.aborted) throw new DOMException("Aborted.", "AbortError");

  onProgress("Processing entities and sentiment…");

  const rawEntities = annotateResult.entities ?? [];
  const entities: AnalyzedEntity[] = rawEntities
    .filter((e) => e.name && typeof e.salience === "number" && e.salience > 0.0005)
    .map((e) => {
      const scores = (e.mentions ?? [])
        .map((m) => m.sentiment?.score)
        .filter((s): s is number => s !== null && s !== undefined);
      const avgSentiment =
        scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
      const meta = e.metadata as Record<string, string> | undefined;
      return {
        name: e.name!,
        type: e.type?.toString() ?? "UNKNOWN",
        salience: parseFloat(e.salience!.toFixed(4)),
        mentions: e.mentions?.length ?? 0,
        sentimentScore: avgSentiment !== null ? parseFloat(avgSentiment.toFixed(3)) : null,
        ...(meta?.wikipedia_url ? { wikipediaUrl: meta.wikipedia_url } : {}),
      };
    })
    .sort((a, b) => b.salience - a.salience);

  const ds = annotateResult.documentSentiment ?? {};
  const sentScore = parseFloat((ds.score ?? 0).toFixed(3));
  const sentMag = parseFloat((ds.magnitude ?? 0).toFixed(3));

  const categories = (annotateResult.categories ?? [])
    .filter((c) => c.name && typeof c.confidence === "number")
    .map((c) => ({
      name: c.name!,
      confidence: Math.round((c.confidence ?? 0) * 100),
    }))
    .sort((a, b) => b.confidence - a.confidence);

  onProgress("Generating AI breakdown with Gemini…");

  const topEntities = entities
    .slice(0, 20)
    .map((e) => `- ${e.name} (${e.type}, salience ${e.salience}, ${e.mentions} mention${e.mentions !== 1 ? "s" : ""})`)
    .join("\n");

  const keywordLine = keywords.trim() ? `\nTarget keywords: ${keywords}` : "";
  const catLine =
    categories.length > 0
      ? `\nGoogle content categories: ${categories.map((c) => `${c.name} (${c.confidence}%)`).join(", ")}`
      : "\nContent classification: not available (text too short or ambiguous)";

  const aiPrompt = `You are a senior SEO/AEO consultant reviewing a Google Natural Language API report.

Text: ${wordCount} words, ${entities.length} entities extracted.
Document sentiment: score ${sentScore} (range −1 to +1), magnitude ${sentMag} → ${sentimentLabel(sentScore, sentMag)}.${catLine}${keywordLine}

Top entities by salience:
${topEntities}

Write a concise expert breakdown using exactly 5 bullet points starting with •. Cover:
1. What the entity profile signals to Google about this content's topicality and authority
2. Which entities are over- or under-represented vs. what a top-ranking page would show
3. How document sentiment and magnitude affect E-E-A-T and citation likelihood${keywords.trim() ? "\n4. How well the entity mix aligns with the target keywords" : "\n4. What topic gaps the entity profile reveals"}
5. One or two specific, actionable steps to improve entity coverage for AEO/GEO

Be direct. Reference actual entity names. No generic filler.`;

  const [aiBreakdown, relatedKeywords] = await Promise.all([
    callModel(
      [{ role: "user", content: aiPrompt }],
      { temperature: 0.45, maxTokens: 900, signal }
    ),
    (async (): Promise<RelatedKeyword[]> => {
      const targetTerm = keywords.trim();
      if (!targetTerm) return []; // cosine ranking requires a target term

      const topEntityNames = entities.slice(0, 15).map((e) => e.name).join(", ");
      const catLine = categories.length > 0 ? `Content category: ${categories[0].name}\n` : "";

      // Step 1 — Gemini generates a broad candidate pool
      const kwPrompt = `You are an SEO keyword researcher. Generate exactly 80 semantically related search keywords for the target term: "${targetTerm}"

${catLine}Top entities found in the content: ${topEntityNames}

Rules:
- Mix of long-tail phrases, question-based queries, comparison terms, subtopic variations, local modifiers
- Realistic search queries (2–6 words each)
- No duplicates or near-duplicates
- Vary intent: informational, commercial, navigational, transactional

Return ONLY a JSON array of 80 keyword strings, no markdown:
["keyword 1", "keyword 2", ...]`;

      try {
        const raw = await callModel(
          [{ role: "user", content: kwPrompt }],
          { temperature: 0.75, maxTokens: 1200, signal }
        );
        const s = raw.indexOf("["), e = raw.lastIndexOf("]");
        if (s === -1 || e === -1) return [];
        const arr = JSON.parse(raw.slice(s, e + 1));
        if (!Array.isArray(arr) || arr.length === 0) return [];
        const candidates: string[] = arr.slice(0, 80).map(String);

        // Step 2 — embed target term + all candidates in one batch
        const allTexts = [targetTerm, ...candidates];
        const embeddings = await getEmbeddings(allTexts, (msg) => onProgress(msg));
        const targetEmb = embeddings[0];
        const candidateEmbs = embeddings.slice(1);

        // Step 3 — rank by cosine similarity, return top 30
        return candidates
          .map((keyword, i) => ({
            keyword,
            similarity: Math.round(cosineSimilarity(targetEmb, candidateEmbs[i]) * 100),
          }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 30);
      } catch {
        return [];
      }
    })(),
  ]);

  onProgress("Done.");

  return {
    entities,
    documentSentiment: { score: sentScore, magnitude: sentMag, label: sentimentLabel(sentScore, sentMag) },
    categories,
    aiBreakdown,
    relatedKeywords,
    wordCount,
    entityCount: entities.length,
  };
}
