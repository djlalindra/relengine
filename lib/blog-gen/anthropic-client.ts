const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Server-side only — never import from client components
function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set in environment variables.");
  return key;
}

export async function callClaude(
  systemPrompt: string,
  userContent: string,
  options: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  } = {}
): Promise<string> {
  const model = options.model ?? SONNET_5;
  const maxTokens = options.maxTokens ?? 8000;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": getApiKey(),
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(`Anthropic API error ${response.status}: ${err?.error?.message ?? response.statusText}`);
  }

  const data = await response.json() as {
    content?: { type: string; text?: string }[];
    error?: { message: string };
  };

  if (data.error) throw new Error(`Anthropic API error: ${data.error.message}`);

  const text = data.content?.find((b) => b.type === "text")?.text ?? "";
  if (!text) throw new Error("Anthropic API returned no text content.");
  return text;
}

export const SONNET_5 = "claude-sonnet-5";
export const HAIKU_45 = "claude-haiku-4-5-20251001";
