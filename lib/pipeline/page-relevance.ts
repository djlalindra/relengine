import { callModel } from "./model-client";
import { fetchFullPageContent } from "./content-extractor";
import { getEmbeddings, cosineSimilarity } from "./embeddings-client";
import { getGroundedUrls } from "./grounding-client";
import { rankRecords, type RankedRecord } from "./ranking-client";

/* ---------------------------------------------------------------------- */
/* Types                                                                    */
/* ---------------------------------------------------------------------- */

export type ChunkDetail = {
  index: number;
  text: string;
  scores: number[];
  rankScore?: number;
};

export type UrlResult = {
  rank: number;
  url: string;
  title: string;
  chunkCount: number;
  fetchError?: string;
  bestScores: number[];
  topRankScore?: number;
  chunks: ChunkDetail[];
};

export type QueryCoverage = {
  query: string;
  isSeed: boolean;
  coverCount: number;
  totalUrls: number;
};

export type QualityAudit = {
  groundedness: number;
  contextRelevance: number;
  notes: string;
};

export type PageRelevanceResult = {
  seedQuery: string;
  city: string;
  queries: string[];
  urls: UrlResult[];
  queryCoverage: QueryCoverage[];
  qualityAudit?: QualityAudit;
};

/* ---------------------------------------------------------------------- */
/* Overlapping token chunker                                                */
/* ---------------------------------------------------------------------- */

export function chunkTextOverlapping(
  text: string,
  windowWords = 375,
  overlapWords = 75,
  minWords = 15
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < minWords) return [];

  const chunks: string[] = [];
  const step = windowWords - overlapWords;

  for (let i = 0; i < words.length; i += step) {
    const slice = words.slice(i, i + windowWords);
    if (slice.length < minWords) break;
    chunks.push(slice.join(" "));
  }

  return chunks;
}

/* ---------------------------------------------------------------------- */
/* Fan-out                                                                  */
/* ---------------------------------------------------------------------- */

async function generateFanOutQueries(
  seedQuery: string,
  city: string,
  count: number,
  signal?: AbortSignal
): Promise<string[]> {
  const localizedSeed = city ? `${seedQuery} ${city}` : seedQuery;

  const raw = await callModel(
    [
      {
        role: "user",
        content: `You are an SEO research assistant. Given the localized seed keyword "${localizedSeed}", generate exactly ${count} unique, non-overlapping search query variations.

Rules:
- Each query must be distinct in intent (informational, commercial, comparison, question-based, local variant)
- Each must include location context relevant to "${city || "the topic"}"
- No duplicates or near-duplicates
- 3–8 words per query
- Do NOT include the seed query itself

Return ONLY a JSON array of ${count} strings:
["query 1", "query 2", ...]`,
      },
    ],
    { temperature: 0.7, maxTokens: 600, signal, jsonMode: true }
  );

  try {
    const s = raw.indexOf("["), e = raw.lastIndexOf("]");
    if (s === -1 || e === -1) return [];
    const arr = JSON.parse(raw.slice(s, e + 1));
    if (Array.isArray(arr)) return arr.slice(0, count).map(String);
  } catch {
    // fall through
  }
  return [];
}

/* ---------------------------------------------------------------------- */
/* Quality audit                                                            */
/* ---------------------------------------------------------------------- */

async function runQualityAudit(
  seedQuery: string,
  city: string,
  topChunks: RankedRecord[],
  signal?: AbortSignal
): Promise<QualityAudit> {
  const localizedSeed = city ? `${seedQuery} ${city}` : seedQuery;
  const sample = topChunks
    .slice(0, 5)
    .map((c, i) => `${i + 1}. [score: ${c.score.toFixed(3)}] ${c.content.slice(0, 300)}`)
    .join("\n\n");

  const raw = await callModel(
    [
      {
        role: "user",
        content: `You are auditing the output of a semantic search pipeline.

Seed query: "${localizedSeed}"

Top retrieved chunks (ranked by Vertex AI Ranking API):
${sample}

Score the following on a 0–100 scale:
- groundedness: Are these chunks grounded in real, specific content about the query topic?
- contextRelevance: Do these chunks provide substantive information that addresses the query?

Return ONLY valid JSON:
{"groundedness": <integer 0-100>, "contextRelevance": <integer 0-100>, "notes": "<one sentence>"}`,
      },
    ],
    { temperature: 0.2, maxTokens: 200, signal, jsonMode: true }
  );

  try {
    const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    if (s !== -1 && e !== -1) {
      const parsed = JSON.parse(raw.slice(s, e + 1));
      return {
        groundedness: Math.min(100, Math.max(0, Math.round(Number(parsed.groundedness ?? 0)))),
        contextRelevance: Math.min(100, Math.max(0, Math.round(Number(parsed.contextRelevance ?? 0)))),
        notes: String(parsed.notes ?? ""),
      };
    }
  } catch {
    // fall through
  }
  return { groundedness: 0, contextRelevance: 0, notes: "Audit parse failed." };
}

/* ---------------------------------------------------------------------- */
/* Main pipeline                                                            */
/* ---------------------------------------------------------------------- */

export async function runPageRelevance(
  seedQuery: string,
  city: string,
  fanoutCount: number,
  topNPerQuery: number,
  onProgress: (step: string) => void,
  signal?: AbortSignal
): Promise<PageRelevanceResult> {
  if (!seedQuery.trim()) throw new Error("Seed query is required.");

  const localizedSeed = city.trim()
    ? `${seedQuery.trim()} ${city.trim()}`
    : seedQuery.trim();

  /* Step 1 — Fan-out */
  let allQueries: string[] = [localizedSeed];
  if (fanoutCount > 0) {
    onProgress(`Generating ${fanoutCount} fan-out query variations…`);
    const fanout = await generateFanOutQueries(
      seedQuery.trim(),
      city.trim(),
      fanoutCount,
      signal
    );
    allQueries = [localizedSeed, ...fanout];
  }

  if (signal?.aborted) throw new DOMException("Aborted.", "AbortError");

  /* Step 2 — Parallel target crawling via Gemini Search Grounding */
  onProgress(
    `Searching Google for top organic URLs across ${allQueries.length} quer${allQueries.length === 1 ? "y" : "ies"}…`
  );

  const groundingResults = await Promise.allSettled(
    allQueries.map((q) => getGroundedUrls(q, topNPerQuery, signal))
  );

  const seenUris = new Set<string>();
  const uniqueUrls: { uri: string; title: string }[] = [];

  for (const result of groundingResults) {
    if (result.status === "fulfilled") {
      for (const g of result.value) {
        const key = g.resolvedUri;
        if (!seenUris.has(key)) {
          seenUris.add(key);
          uniqueUrls.push({ uri: g.resolvedUri, title: g.title });
        }
      }
    }
  }

  if (uniqueUrls.length === 0) {
    throw new Error(
      "Google Search Grounding returned no URLs. Ensure the Vertex AI API is enabled and Search Grounding is available on your GCP plan."
    );
  }

  onProgress(`Found ${uniqueUrls.length} unique pages. Crawling concurrently…`);

  if (signal?.aborted) throw new DOMException("Aborted.", "AbortError");

  /* Step 3 — Concurrent layout-aware crawl */
  const pageResults = await Promise.all(
    uniqueUrls.map(async (u, i) => {
      let hostname = u.uri;
      try { hostname = new URL(u.uri).hostname; } catch { /* keep raw */ }
      onProgress(`[${i + 1}/${uniqueUrls.length}] Crawling ${hostname}…`);
      return fetchFullPageContent(u.uri);
    })
  );

  if (signal?.aborted) throw new DOMException("Aborted.", "AbortError");

  /* Step 4 — Overlapping semantic token chunking */
  onProgress("Chunking pages into overlapping 500-token windows…");

  const pageChunks = pageResults.map((page) => ({
    url: page.url,
    title: page.title,
    fetchError: page.fetchError,
    chunks: page.fetchError ? [] : chunkTextOverlapping(page.text),
  }));

  /* Step 5 — Embed all chunks + all queries */
  const allChunkTexts = pageChunks.flatMap((p) => p.chunks);
  const totalTexts = allChunkTexts.length + allQueries.length;

  onProgress(
    `Embedding ${totalTexts} texts (${allChunkTexts.length} chunks + ${allQueries.length} queries)…`
  );

  const allEmbeddings = await getEmbeddings(
    [...allQueries, ...allChunkTexts],
    (msg) => onProgress(msg)
  );

  const queryEmbeddings = allEmbeddings.slice(0, allQueries.length);
  const chunkEmbeddings = allEmbeddings.slice(allQueries.length);

  if (signal?.aborted) throw new DOMException("Aborted.", "AbortError");

  /* Step 6 — Vector scoring */
  onProgress("Scoring chunks with cosine similarity…");

  let chunkOffset = 0;
  const urlResults: UrlResult[] = [];

  for (let pi = 0; pi < pageChunks.length; pi++) {
    const page = pageChunks[pi];
    const rank = pi + 1;

    if (page.fetchError || page.chunks.length === 0) {
      urlResults.push({
        rank,
        url: page.url,
        title: page.title,
        chunkCount: 0,
        fetchError: page.fetchError ?? "No content extracted.",
        bestScores: allQueries.map(() => 0),
        chunks: [],
      });
      continue;
    }

    const pageChunkEmbs = chunkEmbeddings.slice(chunkOffset, chunkOffset + page.chunks.length);
    chunkOffset += page.chunks.length;

    const chunkDetails: ChunkDetail[] = page.chunks.map((text, ci) => ({
      index: ci + 1,
      text: text.slice(0, 300),
      scores: queryEmbeddings.map((qEmb) =>
        Math.round(cosineSimilarity(pageChunkEmbs[ci], qEmb) * 100)
      ),
    }));

    const bestScores = allQueries.map((_, qi) =>
      chunkDetails.length > 0
        ? Math.max(...chunkDetails.map((c) => c.scores[qi]))
        : 0
    );

    urlResults.push({
      rank,
      url: page.url,
      title: page.title,
      chunkCount: page.chunks.length,
      bestScores,
      chunks: chunkDetails,
    });
  }

  /* Step 7 — Vertex AI Ranking API */
  onProgress("Reranking with Vertex AI Ranking API (semantic-ranker-default)…");

  const allRankRecords = pageChunks.flatMap((page, pi) =>
    page.chunks.map((text, ci) => ({
      id: `${pi}-${ci}`,
      title: page.title,
      content: text,
    }))
  );

  let rankedChunks: RankedRecord[] = [];
  try {
    rankedChunks = await rankRecords(localizedSeed, allRankRecords, 50);

    for (const ranked of rankedChunks) {
      const [piStr, ciStr] = ranked.id.split("-");
      const pi = parseInt(piStr);
      const ci = parseInt(ciStr);
      if (urlResults[pi]?.chunks[ci]) {
        urlResults[pi].chunks[ci].rankScore = ranked.score;
      }
    }

    for (const urlResult of urlResults) {
      const scores = urlResult.chunks.map((c) => c.rankScore ?? 0).filter((s) => s > 0);
      if (scores.length > 0) urlResult.topRankScore = Math.max(...scores);
    }
  } catch (rankErr) {
    onProgress(
      `Ranking API unavailable: ${rankErr instanceof Error ? rankErr.message.split(".")[0] : "error"}. Continuing with cosine scores only.`
    );
  }

  if (signal?.aborted) throw new DOMException("Aborted.", "AbortError");

  /* Step 8 — Coverage summary */
  const successfulUrls = urlResults.filter((u) => !u.fetchError);
  const queryCoverage: QueryCoverage[] = allQueries.map((q, qi) => ({
    query: q,
    isSeed: qi === 0,
    coverCount: successfulUrls.filter((u) => u.bestScores[qi] >= 60).length,
    totalUrls: successfulUrls.length,
  }));

  /* Step 9 — Quality audit */
  let qualityAudit: QualityAudit | undefined;
  if (rankedChunks.length > 0) {
    onProgress("Running automated quality audit (groundedness + context relevance)…");
    try {
      qualityAudit = await runQualityAudit(
        seedQuery.trim(),
        city.trim(),
        rankedChunks,
        signal
      );
    } catch {
      // non-fatal
    }
  }

  onProgress("Done.");

  return {
    seedQuery: seedQuery.trim(),
    city: city.trim(),
    queries: allQueries,
    urls: urlResults,
    queryCoverage,
    qualityAudit,
  };
}
