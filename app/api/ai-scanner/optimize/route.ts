import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: NextRequest) {
  let body: { text?: string; scan_report?: object };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 });
  }

  if (!body.text?.trim()) {
    return new Response(JSON.stringify({ error: "text is required." }), { status: 400 });
  }

  const system = `You are a copy editor removing AI writing tells from prose. Rewrite the document to fix all flagged issues:

1. EM DASHES: Remove every — character. Replace with a comma, period, colon, or parentheses. Zero in the output. No exceptions.
2. AI VOCABULARY: Replace flagged words with plain, specific alternatives. If a sentence is vague, rewrite it around a concrete fact. If no concrete fact exists, cut the sentence.
3. SIGNIFICANCE INFLATION: Cut any sentence asserting importance without a specific checkable fact.
4. CHALLENGES CLOSER: Cut "despite challenges, continues to thrive" endings. End on the last real fact, or write one specific concrete sentence about what actually happens next.
5. NEGATIVE PARALLELISM: Rewrite "not just X but Y" as a direct statement.
6. VAGUE ATTRIBUTION: Name the specific source, or cut the attribution.
7. PLAIN VERBS: authored → wrote, relocated → moved, utilized → used, commenced → started, endeavored → tried.
8. SECTION SUMMARIES: Cut "In summary" and "In conclusion" closers unless the sentence after contains new information.
9. TRANSITION TICS: Replace "Additionally," "Moreover," "Furthermore" with a specific connective that reflects the actual logical relationship, or restructure.
10. PARTICIPLE TACK-ONS: Cut ", [verb]ing [noun]" clauses at sentence ends unless they contain new factual information.
11. TEMPLATED STRUCTURE: Vary paragraph structure. Not every paragraph should follow topic sentence → This/these connector → Therefore/as a result close.
12. SALIENT TERM OVERUSE: Replace repeated instances with a pronoun, plain synonym, or restructure to avoid repetition.
13. FUNCTIONAL REDUNDANCY: Cut or merge sentences that restate what the previous sentence already said.
14. SCRIPTED CONNECTIVES: Replace "This allows," "This ensures," "This enables" sentence openers with a more specific or varied construction.
15. PRESERVE: Do not add new facts. Do not change the author's claims. Stay within 15% of original word count.
16. OUTPUT: Return only the rewritten document text. No preamble, no explanation.`;

  const userMsg = `SCAN REPORT:\n${JSON.stringify(body.scan_report ?? {}, null, 2)}\n\nORIGINAL TEXT:\n${body.text}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const response = await client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 4000,
          system,
          messages: [{ role: "user", content: userMsg }],
          stream: false,
        });

        const text = response.content[0]?.type === "text" ? response.content[0].text : "";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "result", text })}\n\n`));
      } catch (err) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: err instanceof Error ? err.message : "Unknown error" })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
