import { GoogleAuth } from "google-auth-library";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// Gemini via Vertex AI -- replaces the previous OpenRouter/Nemotron
// free-tier model. Same project this app already uses for Vertex
// Embeddings (GOOGLE_APPLICATION_CREDENTIALS_JSON / GCP_PROJECT_ID /
// GCP_REGION), so no new credential type is required.
const DEFAULT_MODEL = "gemini-2.5-flash";

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
  if (!id) {
    throw new Error("GCP_PROJECT_ID is not set in the environment.");
  }
  return id;
}

function getRegion(): string {
  return process.env.GCP_REGION || "us-central1";
}

type GeminiPart = { text: string };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

type GeminiResponse = {
  candidates?: {
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message: string; status?: string };
};

function isRetriableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("RESOURCE_EXHAUSTED") ||
    message.includes("Quota exceeded") ||
    message.includes("429") ||
    message.includes("503") ||
    message.includes("UNAVAILABLE")
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls Gemini via Vertex AI's generateContent REST endpoint, using the
 * same direct-REST + GoogleAuth pattern as embeddings-client.ts (rather
 * than the @google-cloud/vertexai SDK) so both Google-backed calls in
 * this app authenticate and retry identically.
 *
 * ChatMessage's OpenAI-style roles are translated to Gemini's shape:
 * any "system" messages are concatenated into systemInstruction (Gemini
 * has no system role inside contents), "assistant" becomes "model", and
 * "user" passes through unchanged.
 *
 * Throws on non-2xx responses, blocked prompts, or empty output so
 * callers can decide how to handle/report failures rather than silently
 * returning empty strings -- consistent with this app's no-silent-
 * fallback approach elsewhere.
 */
export async function callModel(
  messages: ChatMessage[],
  options: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    onWait?: (message: string) => void;
  } = {}
): Promise<string> {
  const auth = getAuth();
  const client = await auth.getClient();
  const projectId = getProjectId();
  const region = getRegion();
  const model = options.model ?? DEFAULT_MODEL;

  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const contents: GeminiContent[] = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens ?? 4000,
    },
  };
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  // Same retry budget as Vertex Embeddings (embeddings-client.ts): fresh
  // GCP projects commonly have low default per-minute quotas, and a
  // longer backoff window gives a real chance of waiting out a quota
  // reset rather than failing the whole step on a transient 429/503.
  const MAX_RETRIES = 7;
  const MAX_BACKOFF_MS = 30000;

  let attempt = 0;
  while (true) {
    try {
      const response = await client.request({
        url,
        method: "POST",
        data: body,
        signal: options.signal,
      });

      const data = response.data as GeminiResponse;

      if (data.error) {
        throw new Error(`Vertex Gemini error: ${data.error.message}`);
      }

      const candidate = data.candidates?.[0];
      if (data.promptFeedback?.blockReason) {
        throw new Error(
          `Vertex Gemini blocked the prompt: ${data.promptFeedback.blockReason}`
        );
      }

      const text = candidate?.content?.parts?.map((p) => p.text).join("") ?? "";
      if (!text) {
        throw new Error(
          `Vertex Gemini response contained no text (finishReason: ${candidate?.finishReason ?? "unknown"}).`
        );
      }

      return text;
    } catch (err) {
      if (isRetriableError(err) && attempt < MAX_RETRIES) {
        const backoffMs = Math.min(MAX_BACKOFF_MS, 2000 * Math.pow(2, attempt));
        options.onWait?.(
          `Vertex Gemini quota hit, waiting ${Math.round(backoffMs / 1000)}s before retry (attempt ${attempt + 1}/${MAX_RETRIES})...`
        );
        attempt++;
        await sleep(backoffMs);
        continue;
      }
      throw err;
    }
  }
}

export { DEFAULT_MODEL };
