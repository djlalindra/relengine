import { GoogleAuth } from "google-auth-library";

const EMBEDDING_MODEL = "text-embedding-005";
const EMBEDDING_DIMENSION_TASK_TYPE = "SEMANTIC_SIMILARITY";

let authInstance: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (authInstance) return authInstance;

  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credsJson) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS_JSON is not set in the environment."
    );
  }

  let credentials;
  try {
    credentials = JSON.parse(credsJson);
  } catch {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON."
    );
  }

  authInstance = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return authInstance;
}

function getProjectId(): string {
  const id = process.env.GCP_PROJECT_ID;
  if (!id) {
    throw new Error("GCP_PROJECT_ID is not set in the environment.");
  }
  return id;
}

function getRegion(): string {
  return process.env.GCP_REGION || "us-central1";
}

// Common generic marketing/mission-statement language -- words that
// appear heavily in vague "we care about you" copy with no concrete,
// checkable content. A passage dominated by these, with zero concrete
// signals (numbers, named entities, specific claims), is more likely
// filler than a real informational gap worth surfacing.
const FLUFF_WORDS = new Set([
  "confidence", "peace", "mind", "ambitions", "hope", "supportive",
  "compassionate", "dedicated", "empower", "empowered", "empowering",
  "journey", "strength", "renewed", "passionate", "committed",
  "advocate", "advocates", "advocating", "caring", "care", "heartfelt",
  "wholeheartedly", "tirelessly", "relentlessly", "unwavering",
  "exceptional", "outstanding", "world-class", "best-in-class",
  "cutting-edge", "innovative", "trusted", "proven", "premier",
  "beautiful", "safe", "heard", "navigate", "emotional", "needs",
  "difficult", "feel", "felt", "reclaim", "facets", "comprehensive",
]);

/**
 * Heuristic check for generic marketing/mission-statement filler --
 * passages heavy on emotive, non-specific language with zero concrete,
 * checkable content (no numbers, no named entities/proper nouns beyond
 * sentence-start capitalization). Not perfect, but catches the clearest
 * cases (e.g. "They empower clients to pursue their best interests and
 * ambitions with confidence and peace of mind") without needing a full
 * NLP classifier.
 */
export function isLikelyFluff(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  const fluffCount = words.filter((w) =>
    FLUFF_WORDS.has(w.toLowerCase().replace(/[.,!?;:]+$/, ""))
  ).length;
  const fluffRatio = fluffCount / words.length;

  const hasNumber = /\d/.test(text);
  // Proper-noun-like tokens: capitalized words NOT at the start of a
  // sentence (a crude but workable signal for named entities/specifics).
  // Require at least 2 distinct such tokens -- a single capitalized word
  // mid-sentence is often just the page's own firm name repeated in
  // boilerplate copy ("At Acme Law, you're not just a case number"),
  // which shouldn't by itself count as a concrete, checkable fact.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const properNounTokens = new Set<string>();
  for (const sentence of sentences) {
    const sentenceWords = sentence.split(/\s+/).filter(Boolean);
    for (let i = 1; i < sentenceWords.length; i++) {
      if (/^[A-Z][a-z]+/.test(sentenceWords[i])) {
        properNounTokens.add(sentenceWords[i]);
      }
    }
  }

  const hasConcreteSignal = hasNumber || properNounTokens.size >= 2;

  // Flag as fluff if marketing-language density is meaningfully high AND
  // there's nothing concrete anchoring the passage to a checkable fact.
  return fluffRatio >= 0.045 && !hasConcreteSignal;
}

/**
 * Splits text into paragraph-level chunks for passage-level comparison.
 * Filters out very short fragments (likely nav remnants, single labels)
 * that would otherwise dilute the similarity signal, and filters out
 * generic marketing/mission-statement filler that isn't a real
 * informational gap worth surfacing even if it's semantically distinct.
 */
export function chunkText(text: string, minWords: number = 15): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return paragraphs.filter(
    (p) =>
      p.split(/\s+/).filter(Boolean).length >= minWords && !isLikelyFluff(p)
  );
}

function isRetriableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("RESOURCE_EXHAUSTED") ||
    message.includes("Quota exceeded") ||
    message.includes("429") ||
    message.includes("503")
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls Vertex AI's text embedding model for a batch of text chunks.
 * Returns one embedding vector per input chunk, in the same order.
 *
 * Retries with exponential backoff on quota/rate-limit errors (common on
 * fresh GCP projects with low default quotas for online prediction
 * requests), rather than failing the whole audit on a transient 429.
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const auth = getAuth();
  const client = await auth.getClient();
  const projectId = getProjectId();
  const region = getRegion();

  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${EMBEDDING_MODEL}:predict`;

  // Larger batches mean fewer total requests against the per-minute quota.
  // This model family's documented cap is around 250 instances/request;
  // 40 stays comfortably under payload-size limits for paragraph-length
  // chunks while meaningfully cutting request count vs. a smaller batch.
  const BATCH_SIZE = 40;
  const MAX_RETRIES = 4;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    let attempt = 0;

    while (true) {
      try {
        const response = await client.request({
          url,
          method: "POST",
          data: {
            instances: batch.map((text) => ({
              content: text,
              task_type: EMBEDDING_DIMENSION_TASK_TYPE,
            })),
          },
        });

        const predictions = (response.data as { predictions?: { embeddings?: { values?: number[] } }[] })
          ?.predictions ?? [];

        for (const pred of predictions) {
          allEmbeddings.push(pred.embeddings?.values ?? []);
        }
        break;
      } catch (err) {
        if (isRetriableError(err) && attempt < MAX_RETRIES) {
          const backoffMs = 1000 * Math.pow(2, attempt);
          await sleep(backoffMs);
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }

  return allEmbeddings;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export type PassageMatch = {
  competitorChunk: string;
  competitorUrl: string;
  bestMatchScore: number; // highest similarity found against any target chunk
};

export type SemanticCoverageResult = {
  targetChunks: string[];
  coverageScore: number; // 0-100, % of competitor chunks with a strong match in target
  uncoveredPassages: PassageMatch[]; // competitor passages with weak/no match in target
  strongMatchThreshold: number;
};

/**
 * Compares a target page's content against one or more competitor pages'
 * content at the passage level. For each competitor paragraph, finds the
 * best-matching paragraph in the target page (by embedding cosine
 * similarity) and flags passages where the target has no strong semantic
 * equivalent -- i.e. topical/semantic gaps.
 */
export async function computeSemanticCoverage(
  targetText: string,
  competitorPages: { url: string; text: string }[],
  strongMatchThreshold: number = 0.75
): Promise<SemanticCoverageResult> {
  const targetChunks = chunkText(targetText);

  const competitorChunks: { url: string; text: string }[] = [];
  for (const page of competitorPages) {
    for (const chunk of chunkText(page.text)) {
      competitorChunks.push({ url: page.url, text: chunk });
    }
  }

  if (targetChunks.length === 0 || competitorChunks.length === 0) {
    return {
      targetChunks,
      coverageScore: 0,
      uncoveredPassages: [],
      strongMatchThreshold,
    };
  }

  const targetEmbeddings = await getEmbeddings(targetChunks);
  const competitorEmbeddings = await getEmbeddings(
    competitorChunks.map((c) => c.text)
  );

  const uncoveredPassages: PassageMatch[] = [];
  let strongMatchCount = 0;

  for (let i = 0; i < competitorChunks.length; i++) {
    const compEmbedding = competitorEmbeddings[i];
    let bestScore = 0;

    for (const targetEmbedding of targetEmbeddings) {
      const score = cosineSimilarity(compEmbedding, targetEmbedding);
      if (score > bestScore) bestScore = score;
    }

    if (bestScore >= strongMatchThreshold) {
      strongMatchCount++;
    } else {
      uncoveredPassages.push({
        competitorChunk: competitorChunks[i].text,
        competitorUrl: competitorChunks[i].url,
        bestMatchScore: bestScore,
      });
    }
  }

  const coverageScore = Math.round(
    (strongMatchCount / competitorChunks.length) * 100
  );

  // Sort uncovered passages by how weak the match was (weakest first) so
  // the biggest gaps surface at the top of the report.
  uncoveredPassages.sort((a, b) => a.bestMatchScore - b.bestMatchScore);

  return {
    targetChunks,
    coverageScore,
    uncoveredPassages,
    strongMatchThreshold,
  };
}
