const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type OpenRouterChoice = {
  message: { role: string; content: string };
};

type OpenRouterResponse = {
  choices: OpenRouterChoice[];
  error?: { message: string };
};

const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

/**
 * Calls a Nemotron model via OpenRouter's OpenAI-compatible chat completions
 * endpoint. Throws on non-2xx responses or malformed payloads so callers can
 * decide how to handle/report failures rather than silently returning
 * empty strings.
 */
export async function callModel(
  messages: ChatMessage[],
  options: { model?: string; temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set in the environment.");
  }

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      // OpenRouter requests these for free-tier usage attribution; harmless
      // if your deployed domain differs, but recommended to keep accurate.
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": "Relevance Engineering",
    },
    body: JSON.stringify({
      model: options.model ?? DEFAULT_MODEL,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4000,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${text}`);
  }

  const data: OpenRouterResponse = await response.json();

  if (data.error) {
    throw new Error(`OpenRouter error: ${data.error.message}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenRouter response contained no content.");
  }

  return content;
}

export { DEFAULT_MODEL };
