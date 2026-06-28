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

/**
 * Splits text into paragraph-level chunks for passage-level comparison.
 * Filters out very short fragments (likely nav remnants, single labels)
 * that would otherwise dilute the similarity signal.
 */
export function chunkText(text: string, minWords: number = 15): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return paragraphs.filter(
    (p) => p.split(/\s+/).filter(Boolean).length >= minWords
  );
}

/**
 * Calls Vertex AI's text embedding model for a batch of text chunks.
 * Returns one embedding vector per input chunk, in the same order.
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const auth = getAuth();
  const client = await auth.getClient();
  const projectId = getProjectId();
  const region = getRegion();

  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${EMBEDDING_MODEL}:predict`;

  // Vertex's embedding endpoint accepts a batch of instances per call, but
  // caps batch size (typically 250 for this model family); chunk requests
  // defensively at 20 to stay well clear of payload-size limits given each
  // chunk of text can be a full paragraph.
  const BATCH_SIZE = 20;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

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
