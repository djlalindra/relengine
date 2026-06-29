import { callModel } from "./model-client";
import { fetchGoogleAiSerp } from "./fetchserp-client";
import { fetchFullPageContent } from "./content-extractor";
import { chunkText, getEmbeddings, cosineSimilarity } from "./embeddings-client";

export type ChunkDetail = {
  index: number;
  text: string;
  scores: number[];
};

export type UrlResult = {
  rank: number;
  url: string;
  title: string;
  chunkCount: number;
  fetchError?: string;
  bestScores: number[];
  chunks: ChunkDetail[];
};

export type QueryCoverage = {
  query: string;
  isSeed: boolean;
  coverCount: number;
  totalUrls: number;
};

export type PageRelevanceResult = {
  seed: string;
  queries: string[];
  region: string;
  urls: UrlResult[];
  queryCoverage: QueryCoverage[];
};

async function generateRelatedQueries(
  seed: string,
  count: number,
  signal?: AbortSignal
): Promise<string[]> {
  const raw = await callModel(
    [
      {
        role: "user",
        content: `Given the seed search query: "${seed}"

Generate exactly ${count} semantically related search queries a user investigating this topic might also search. Vary intent: informational, commercial, comparison, local, question-based.

Return ONLY a JSON array of ${count} strings, no markdown, no explanation:
["query 1", "query 2", ...]`,
      },
    ],
    { temperature: 0.75, maxTokens: 600, signal }
  );

  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) return arr.slice(0, count).map(String);
  } catch {
    // fall through
  }
  return [];
}

export async function runPageRelevance(
  seed: string,
  region: string,
  topN: number,
  fanoutCount: number,
  onProgress: (step: string) => void,
  signal?: AbortSignal
): Promise<PageRelevanceResult> {
  onProgress(`Fetching top ${topN} SERP results for "${seed}" (${region})…`);

  const serpResult = await fetchGoogleAiSerp(seed, region);
  const serpUrls = serpResult.organicResults.slice(0, topN);

  if (serpUrls.length === 0) {
    throw new Error(
      "No SERP results returned. Check your FETCHSERP_API_KEY and region code."
    );
  }

  const queries: string[] = [seed];

  if (fanoutCount > 0) {
    onProgress(`Generating ${fanoutCount} AI fan-out queries…`);
    const fanout = await generateRelatedQueries(seed, fanoutCount, signal);
    queries.push(...fanout);
  }

  if (signal?.aborted) throw new DOMException("Aborted.", "AbortError");

  onProgress(`Embedding ${queries.length} quer${queries.length === 1 ? "y" : "ies"}…`);
  const queryEmbeddings = await getEmbeddings(queries, (msg) => onProgress(msg));

  if (signal?.aborted) throw new DOMException("Aborted.", "AbortError");

  const urlResults: UrlResult[] = [];

  for (let i = 0; i < serpUrls.length; i++) {
    const serpEntry = serpUrls[i];
    const rank = i + 1;
    const url = serpEntry.url;
    const fallbackTitle = serpEntry.title || url;

    let hostname = url;
    try {
      hostname = new URL(url).hostname;
    } catch {
      // keep raw url
    }

    onProgress(`[${rank}/${serpUrls.length}] Crawling ${hostname}…`);

    const page = await fetchFullPageContent(url);

    if (page.fetchError || !page.text.trim()) {
      urlResults.push({
        rank,
        url,
        title: page.title || fallbackTitle,
        chunkCount: 0,
        fetchError: page.fetchError ?? "No content extracted.",
        bestScores: queries.map(() => 0),
        chunks: [],
      });
      continue;
    }

    if (signal?.aborted) throw new DOMException("Aborted.", "AbortError");

    const rawChunks = chunkText(page.text);

    if (rawChunks.length === 0) {
      urlResults.push({
        rank,
        url,
        title: page.title || fallbackTitle,
        chunkCount: 0,
        fetchError: "No usable content chunks after cleaning.",
        bestScores: queries.map(() => 0),
        chunks: [],
      });
      continue;
    }

    onProgress(
      `[${rank}/${serpUrls.length}] Embedding ${rawChunks.length} chunks from ${hostname}…`
    );
    const chunkEmbeddings = await getEmbeddings(rawChunks, (msg) => onProgress(msg));

    if (signal?.aborted) throw new DOMException("Aborted.", "AbortError");

    const chunkDetails: ChunkDetail[] = rawChunks.map((text, ci) => ({
      index: ci + 1,
      text: text.slice(0, 240),
      scores: queryEmbeddings.map((qEmb) =>
        Math.round(cosineSimilarity(chunkEmbeddings[ci], qEmb) * 100)
      ),
    }));

    const bestScores = queries.map((_, qi) =>
      chunkDetails.length > 0
        ? Math.max(...chunkDetails.map((c) => c.scores[qi]))
        : 0
    );

    urlResults.push({
      rank,
      url,
      title: page.title || fallbackTitle,
      chunkCount: rawChunks.length,
      bestScores,
      chunks: chunkDetails,
    });
  }

  const successfulUrls = urlResults.filter((u) => !u.fetchError);

  const queryCoverage: QueryCoverage[] = queries.map((q, qi) => ({
    query: q,
    isSeed: qi === 0,
    coverCount: successfulUrls.filter((u) => u.bestScores[qi] >= 60).length,
    totalUrls: successfulUrls.length,
  }));

  onProgress("Done.");

  return { seed, queries, region, urls: urlResults, queryCoverage };
}
