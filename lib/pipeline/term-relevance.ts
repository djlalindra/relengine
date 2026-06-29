import { getEmbeddings, cosineSimilarity, chunkText } from "./embeddings-client";

export type ChunkRelevance = {
  text: string;
  score: number; // 0-100, cosine similarity to the search term
};

export type PageTermRelevance = {
  url: string;
  overallScore: number; // 0-100, best single chunk's relevance to the term
  topChunks: ChunkRelevance[]; // top 3 most relevant chunks on this page
};

/**
 * Ranks every page (target + competitors) by how semantically relevant
 * its content actually is to the literal search term -- not to each
 * other, to the term itself. This is the fundamental signal that was
 * missing from the rest of the pipeline: everything else compares pages
 * against each other, never against what was actually searched for.
 *
 * One embedding call for the term, one batched call for all chunks across
 * all pages combined (not per-page) to minimize total Vertex requests.
 */
export async function computeTermRelevance(
  searchTerm: string,
  pages: { url: string; text: string }[],
  onWait?: (message: string) => void
): Promise<PageTermRelevance[]> {
  const [termEmbedding] = await getEmbeddings([searchTerm], onWait);

  const allChunks: { url: string; text: string }[] = [];
  for (const page of pages) {
    for (const chunk of chunkText(page.text)) {
      allChunks.push({ url: page.url, text: chunk });
    }
  }

  if (allChunks.length === 0) {
    return pages.map((p) => ({ url: p.url, overallScore: 0, topChunks: [] }));
  }

  const chunkEmbeddings = await getEmbeddings(allChunks.map((c) => c.text), onWait);

  const byPage = new Map<string, ChunkRelevance[]>();
  for (let i = 0; i < allChunks.length; i++) {
    const score = Math.round(cosineSimilarity(termEmbedding, chunkEmbeddings[i]) * 100);
    const list = byPage.get(allChunks[i].url) ?? [];
    list.push({ text: allChunks[i].text, score });
    byPage.set(allChunks[i].url, list);
  }

  return pages.map((p) => {
    const chunks = (byPage.get(p.url) ?? []).sort((a, b) => b.score - a.score);
    return {
      url: p.url,
      overallScore: chunks[0]?.score ?? 0,
      topChunks: chunks.slice(0, 3),
    };
  });
}
