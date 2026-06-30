import { callModel } from "./model-client";

export type CriterionScore = 0 | 1 | 2;

export type CriterionResult = {
  criterion: string;
  score: CriterionScore;
  reason: string;
};

export type DimensionResult = {
  label: string;
  criteria: CriterionResult[];
  points: number;   // sum of scores, max 10
  percent: number;  // points / 10 * 100
};

export type EEATResult = {
  dimensions: DimensionResult[];
  overallPercent: number;
  overallVerdict: string;
};

const DIMENSIONS = [
  {
    label: "Experience",
    key: "experience",
    criteria: [
      "Author has first-hand experience with the topic",
      "Includes personal anecdotes or real-world stories",
      "Shows practical examples from actual use",
      "Demonstrates real results or outcomes",
      "Contains original media (photos, screenshots, data)",
    ],
  },
  {
    label: "Expertise",
    key: "expertise",
    criteria: [
      "Author has relevant qualifications or credentials",
      "Content demonstrates deep subject-matter knowledge",
      "Provides accurate, up-to-date information",
      "Uses industry-specific terminology correctly",
      "Covers the topic comprehensively",
    ],
  },
  {
    label: "Authoritativeness",
    key: "authoritativeness",
    criteria: [
      "Published on a recognised or well-known domain",
      "Referenced or cited by other authoritative sources",
      "Author has an established online presence",
      "Includes editorial standards or a review process",
      "Content has been updated or actively maintained",
    ],
  },
  {
    label: "Trustworthiness",
    key: "trustworthiness",
    criteria: [
      "Has clear contact information",
      "Includes privacy policy and terms of service",
      "Uses HTTPS and secure connections",
      "Content is free of misleading or exaggerated claims",
      "Cites sources for factual claims",
    ],
  },
] as const;

function verdictForScore(pct: number): string {
  if (pct >= 80) return "Strong E-E-A-T. Content meets Google's quality guidelines well.";
  if (pct >= 60) return "Good E-E-A-T. A few areas could be strengthened.";
  if (pct >= 40) return "Moderate E-E-A-T. Several areas need attention to meet quality guidelines.";
  return "Weak E-E-A-T. Significant improvements are needed across multiple dimensions.";
}

export async function runEEATScorer(
  content: string,
  extras: { url?: string; author?: string; domain?: string },
  onProgress: (step: string) => void,
  signal?: AbortSignal
): Promise<EEATResult> {
  onProgress("Evaluating E-E-A-T criteria with Gemini…");

  const contextLines: string[] = [];
  if (extras.url) contextLines.push(`URL: ${extras.url}`);
  if (extras.author) contextLines.push(`Author: ${extras.author}`);
  if (extras.domain) contextLines.push(`Domain/site: ${extras.domain}`);
  const contextBlock = contextLines.length
    ? `\nAdditional context:\n${contextLines.join("\n")}\n`
    : "";

  const criteriaBlock = DIMENSIONS.map((d) =>
    `## ${d.label}\n${d.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
  ).join("\n\n");

  const prompt = `You are a senior content quality evaluator applying Google's E-E-A-T framework (Experience, Expertise, Authoritativeness, Trustworthiness).

Evaluate the following content against each criterion below.

Scoring scale (MUST be an integer — 0, 1, or 2 only):
  0 = Not Present
  1 = Partial (some evidence but incomplete)
  2 = Strong (clear, convincing evidence)
${contextBlock}
--- CONTENT START ---
${content.slice(0, 12000)}
--- CONTENT END ---

Criteria to evaluate:
${criteriaBlock}

Return ONLY valid JSON (no markdown, no explanation, no code fences).
Each "score" value MUST be the integer 0, 1, or 2 — never write "0|1|2".
{
  "experience": [
    { "criterion": "Author has first-hand experience with the topic", "score": 1, "reason": "one concise sentence" },
    { "criterion": "Includes personal anecdotes or real-world stories", "score": 0, "reason": "one concise sentence" },
    { "criterion": "Shows practical examples from actual use", "score": 2, "reason": "one concise sentence" },
    { "criterion": "Demonstrates real results or outcomes", "score": 1, "reason": "one concise sentence" },
    { "criterion": "Contains original media (photos, screenshots, data)", "score": 0, "reason": "one concise sentence" }
  ],
  "expertise": [ ... 5 items with integer scores ... ],
  "authoritativeness": [ ... 5 items with integer scores ... ],
  "trustworthiness": [ ... 5 items with integer scores ... ]
}

Be direct and evidence-based. Reference specific content from the text when justifying scores.`;

  const raw = await callModel(
    [{ role: "user", content: prompt }],
    { temperature: 0.2, maxTokens: 2000, signal, jsonMode: true }
  );

  onProgress("Calculating scores…");

  let parsed: Record<string, { criterion: string; score: number; reason: string }[]>;
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("no JSON object found");
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (cause) {
    throw new Error(
      `Gemini returned unparseable JSON for E-E-A-T evaluation: ${cause instanceof Error ? cause.message : cause}`
    );
  }

  const dimensions: DimensionResult[] = DIMENSIONS.map((d) => {
    const raw = parsed[d.key] ?? [];
    const criteria: CriterionResult[] = d.criteria.map((cText, i) => {
      const entry = raw[i] ?? {};
      const score = Math.min(2, Math.max(0, Math.round(Number(entry.score ?? 0)))) as CriterionScore;
      return {
        criterion: cText,
        score,
        reason: entry.reason ?? "No assessment provided.",
      };
    });
    const points = criteria.reduce((s, c) => s + c.score, 0);
    const percent = Math.round((points / 10) * 100);
    return { label: d.label, criteria, points, percent };
  });

  const overallPercent = Math.round(
    dimensions.reduce((s, d) => s + d.percent, 0) / dimensions.length
  );

  onProgress("Done.");

  return {
    dimensions,
    overallPercent,
    overallVerdict: verdictForScore(overallPercent),
  };
}
