import { LanguageServiceClient } from "@google-cloud/language";

export type ExtractedEntity = {
  name: string;
  type: string;
  salience: number;
};

let clientInstance: LanguageServiceClient | null = null;

function getClient(): LanguageServiceClient {
  if (clientInstance) return clientInstance;

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
      "GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON. Paste the full service account key file contents."
    );
  }

  clientInstance = new LanguageServiceClient({ credentials });
  return clientInstance;
}

/**
 * Extracts named entities and their salience scores from a block of text.
 * Salience (0-1) indicates how central each entity is to the overall text --
 * useful for comparing whether a target page emphasizes the same entities
 * that competitor pages emphasize.
 *
 * Cloud Natural Language has a request size limit; long pages are
 * truncated to avoid errors, which is an acceptable tradeoff for
 * entity-salience comparison (the most salient entities tend to appear
 * early/often in well-structured content anyway).
 */
export async function extractEntities(text: string): Promise<ExtractedEntity[]> {
  if (!text || text.trim().length === 0) return [];

  const client = getClient();
  const truncated = text.slice(0, 50000); // stay well under API limits

  const [result] = await client.analyzeEntities({
    document: {
      content: truncated,
      type: "PLAIN_TEXT",
    },
  });

  const entities = result.entities ?? [];

  return entities
    .filter((e) => e.name && typeof e.salience === "number")
    .map((e) => ({
      name: e.name!,
      type: e.type?.toString() ?? "UNKNOWN",
      salience: e.salience!,
    }))
    .sort((a, b) => b.salience - a.salience);
}
