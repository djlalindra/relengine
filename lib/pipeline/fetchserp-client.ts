const FETCHSERP_BASE = "https://www.fetchserp.com/api/v1";

export type SerpSource = {
  title: string;
  url: string;
  site_name?: string;
  description?: string;
  ranking?: number;
};

export type SerpResult = {
  query: string;
  organicResults: SerpSource[];
  aiOverview: {
    content: string | null;
    sources: SerpSource[];
  };
  aiMode: {
    content: string | null;
    sources: SerpSource[];
  };
  creditsUsed: number;
};

function getApiKey(): string {
  const key = process.env.FETCHSERP_API_KEY;
  if (!key) {
    throw new Error("FETCHSERP_API_KEY is not set in the environment.");
  }
  return key;
}

async function fetchserpGet(path: string, params: Record<string, string>) {
  const apiKey = getApiKey();
  const url = `${FETCHSERP_BASE}${path}?${new URLSearchParams(params)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`fetchSERP request failed (${response.status}): ${text}`);
  }

  return response.json();
}

/**
 * Fetches real Google AI Overview + AI Mode data for a keyword, including
 * the actual source URLs Google surfaced. This is the closest available
 * signal to "what does Google's AI actually cite for this query" --
 * directly relevant to AEO/GEO work, as opposed to a plain organic SERP.
 *
 * Cost: 20 credits per call (SERP AI Mode endpoint includes AI Overview).
 * With 250 free credits, this allows ~12 lookups before topping up.
 */
export async function fetchGoogleAiSerp(
  query: string,
  country: string = "us"
): Promise<SerpResult> {
  const data = await fetchserpGet("/serp_ai_mode", {
    query,
    country,
  });

  const results = data?.data?.results ?? {};
  const aiOverview = results.ai_overview ?? {};
  const aiMode = results.ai_mode_response ?? {};
  const searchResults: SerpSource[] = results.search_results ?? [];

  return {
    query,
    organicResults: searchResults,
    aiOverview: {
      content: aiOverview.content ?? null,
      sources: aiOverview.sources ?? [],
    },
    aiMode: {
      content: aiMode.content ?? null,
      sources: aiMode.sources ?? [],
    },
    creditsUsed: 20,
  };
}

/**
 * Fetches a plain organic SERP (Bing/Yahoo/DuckDuckGo only -- fetchSERP's
 * standard SERP endpoint does not cover Google). Cheaper (1 credit/page)
 * than the Google AI endpoints, useful as a fallback or for cross-engine
 * comparison, but NOT a source of real Google rankings.
 */
export async function fetchOrganicSerp(
  query: string,
  searchEngine: "bing" | "yahoo" | "duckduckgo" = "bing",
  country: string = "us"
): Promise<SerpSource[]> {
  const data = await fetchserpGet("/serp", {
    search_engine: searchEngine,
    country,
    pages_number: "1",
    query,
  });

  return Array.isArray(data) ? data : data?.data ?? [];
}
