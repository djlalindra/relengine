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

export type RankRecord = {
  id: string;
  title?: string;
  content: string;
};

export type RankedRecord = {
  id: string;
  title?: string;
  content: string;
  score: number;
};

type RankingApiResponse = {
  records?: { id: string; score: number; title?: string; content?: string }[];
  error?: { message: string; status?: string };
};

/**
 * Reranks text records against a query using the Vertex AI Ranking API
 * (discoveryengine.googleapis.com). Unlike cosine similarity which only
 * measures semantic closeness, the ranker scores how well each passage
 * actually answers the query — better for surfacing the most informative chunks.
 *
 * Requires "Discovery Engine API" to be enabled in your GCP project.
 * Model: semantic-ranker-default@latest (1024-token context, most accurate).
 */
export async function rankRecords(
  query: string,
  records: RankRecord[],
  topN?: number
): Promise<RankedRecord[]> {
  if (records.length === 0) return [];

  const auth = getAuth();
  const client = await auth.getClient();
  const projectId = getProjectId();

  const url = `https://discoveryengine.googleapis.com/v1/projects/${projectId}/locations/global/rankingConfigs/default_ranking_config:rank`;

  const body: Record<string, unknown> = {
    model: "semantic-ranker-default@latest",
    query,
    records: records.slice(0, 200).map((r) => ({
      id: r.id,
      title: r.title ?? "",
      content: r.content.slice(0, 2000),
    })),
    ignoreRecordDetailsInResponse: false,
  };
  if (topN) body.topN = topN;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (client as any).request({
    url,
    method: "POST",
    data: body,
  });

  const data = response.data as RankingApiResponse;

  if (data.error) {
    throw new Error(
      `Vertex AI Ranking API error: ${data.error.message}. ` +
        `Ensure "Discovery Engine API" (discoveryengine.googleapis.com) is enabled in your GCP project.`
    );
  }

  if (!data.records) return [];

  const idToOriginal = new Map(records.map((r) => [r.id, r]));

  return data.records
    .map((r) => ({
      id: r.id,
      content: idToOriginal.get(r.id)?.content ?? r.content ?? "",
      title: idToOriginal.get(r.id)?.title ?? r.title,
      score: r.score,
    }))
    .sort((a, b) => b.score - a.score);
}
