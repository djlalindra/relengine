import { GoogleAuth } from "google-auth-library";

let authInstance: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (authInstance) return authInstance;
  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credsJson) throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is not set.");
  let credentials;
  try {
    credentials = JSON.parse(credsJson);
  } catch {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON.");
  }
  authInstance = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return authInstance;
}

function getProjectId(): string {
  const id = process.env.GCP_PROJECT_ID;
  if (!id) throw new Error("GCP_PROJECT_ID is not set.");
  return id;
}

function getRegion(): string {
  return process.env.GCP_REGION || "us-central1";
}

export type GroundedUrl = {
  uri: string;
  resolvedUri: string;
  title: string;
  sourceQuery: string;
};

type GeminiGroundingResponse = {
  candidates?: {
    groundingMetadata?: {
      groundingChunks?: { web?: { uri?: string; title?: string } }[];
      webSearchQueries?: string[];
    };
  }[];
  error?: { message: string };
};

/**
 * Follows a redirect URL and returns the final destination URL.
 * Vertex AI grounding returns vertexaisearch.cloud.google.com redirect URLs —
 * this resolves them to the actual page URL for display and deduplication.
 */
export async function resolveRedirectUrl(redirectUrl: string): Promise<string> {
  try {
    const response = await fetch(redirectUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(6000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RelevanceBot/1.0)" },
    });
    return response.url || redirectUrl;
  } catch {
    return redirectUrl;
  }
}

/**
 * Calls Gemini 2.5 Flash with Google Search grounding enabled.
 * Returns the grounding chunks (top organic URLs) that Gemini cited
 * when answering the query. These are the pages Google considers most
 * relevant for the query — equivalent to top SERP results.
 */
export async function getGroundedUrls(
  query: string,
  topN: number = 5,
  signal?: AbortSignal
): Promise<GroundedUrl[]> {
  const auth = getAuth();
  const client = await auth.getClient();
  const projectId = getProjectId();
  const region = getRegion();

  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/gemini-2.5-flash:generateContent`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Search for and summarize the top ranking web pages for this query: "${query}". Describe what each page covers.`,
          },
        ],
      },
    ],
    tools: [{ googleSearch: {} }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 800,
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (client as any).request({
    url,
    method: "POST",
    data: body,
    signal,
  });

  const data = response.data as GeminiGroundingResponse;

  if (data.error) {
    throw new Error(
      `Gemini Search Grounding error: ${data.error.message}. ` +
        `Ensure "Vertex AI API" and "Generative Language API" are enabled in your GCP project.`
    );
  }

  const chunks =
    data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];

  const raw = chunks
    .filter((c) => c.web?.uri)
    .slice(0, topN)
    .map((c) => ({
      uri: c.web!.uri!,
      resolvedUri: c.web!.uri!,
      title: c.web!.title ?? c.web!.uri!,
      sourceQuery: query,
    }));

  // Resolve redirect URIs in parallel so we can deduplicate by real URL
  const resolved = await Promise.all(
    raw.map(async (item) => ({
      ...item,
      resolvedUri: await resolveRedirectUrl(item.uri),
    }))
  );

  return resolved;
}
