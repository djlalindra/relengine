import { LanguageServiceClient } from "@google-cloud/language";
import { callModel } from "./model-client";

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

export type EntityAnalyzerResult = {
  entities: AnalyzedEntity[];
  documentSentiment: {
    score: number;
    magnitude: number;
    label: "Very Positive" | "Positive" | "Neutral" | "Negative" | "Very Negative" | "Mixed";
  };
  categories: { name: string; confidence: number }[];
  aiBreakdown: string;
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
  const truncated = text.slice(0, 5000);
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

  const aiBreakdown = await callModel(
    [{ role: "user", content: aiPrompt }],
    { temperature: 0.45, maxTokens: 900, signal }
  );

  onProgress("Done.");

  return {
    entities,
    documentSentiment: { score: sentScore, magnitude: sentMag, label: sentimentLabel(sentScore, sentMag) },
    categories,
    aiBreakdown,
    wordCount,
    entityCount: entities.length,
  };
}
