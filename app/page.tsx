"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { AccordionRow } from "@/components/AccordionRow";
import { CircularGauge } from "@/components/CircularGauge";
import { CoverageBarChart } from "@/components/CoverageBarChart";
import { ScoreCard } from "@/components/ScoreCard";
import { downloadXlsx } from "@/lib/xlsx-export";

type EntitySummary = { name: string; type: string; salience: number };
type HeadingItem = { level: number; text: string };

type PageSummary = {
  url: string;
  title: string;
  wordCount: number;
  fetchError?: string;
  headingOutline: HeadingItem[];
  entities: EntitySummary[];
  entityCount: number;
  rawText: string;
  informationGain: { term: string; count: number }[];
  topicalCoverageScore: number;
};

type TopKeyword = {
  term: string;
  type: string;
  appearsInCompetitors: number;
  avgSalience: number;
  presentInTarget: boolean;
};

type ChunkRelevance = { text: string; score: number };
type PageTermRelevance = { url: string; overallScore: number; topChunks: ChunkRelevance[] };

type ScrapeResult = {
  target: PageSummary;
  competitors: PageSummary[];
  topKeywords: TopKeyword[];
  searchTerm: string;
  termRelevance: PageTermRelevance[];
  termRelevanceError?: string;
  errors: string[];
  _cache: unknown;
};

type EntityGap = {
  name: string;
  type: string;
  appearsInCompetitors: number;
  avgSalienceInCompetitors: number;
};

type PassageMatch = {
  competitorChunk: string;
  competitorUrl: string;
  bestMatchScore: number;
};

type GapReport = {
  missingEntities: EntityGap[];
  semanticCoverage: {
    coverageScore: number;
    averageSimilarity: number;
    uncoveredPassages: PassageMatch[];
    partialMatchCount: number;
    strongMatchThreshold: number;
    realGapThreshold: number;
  };
  errors: string[];
};

type SectionOptimization = {
  heading: string;
  isNew: boolean;
  currentText: string;
  suggestedText: string;
  entitiesAssigned: string[];
  citabilityBefore: number;
  citabilityAfter: number;
  relevanceImpact: string;
};

type StructuredOptimizationResult = {
  sections: SectionOptimization[];
  overallCurrentScore: number;
  overallProjectedScore: number | null;
  overallCurrentSimilarity: number;
  overallProjectedSimilarity: number | null;
  projectedScoreUnavailableReason?: string;
  sectionsFound: number;
};

type OptimizeResult = {
  gapReport: GapReport;
  optimization: StructuredOptimizationResult;
};

type StructuralFinding = { rule: string; passed: boolean; detail: string };
type StructuralReport = { findings: StructuralFinding[]; score: number };

const C = {
  bg: "#06090F",
  card: "#0D111D",
  border: "#1A1F2E",
  text: "#F5F7FA",
  muted: "#8B93A7",
  green: "#14BA82",
  red: "#EE4542",
  gold: "#E0A33C",
  purple: "#7C6FE0",
  blue: "#5B8DEF",
};

function pillStyle(color: string) {
  return { backgroundColor: color + "26", color };
}

function useSSE() {
  async function run(
    url: string,
    body: object,
    onProgress: (step: string) => void,
    signal: AbortSignal
  ): Promise<unknown> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Request failed.");
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response stream available.");

    const decoder = new TextDecoder();
    let buffer = "";
    let result: unknown = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const evt of events) {
        if (!evt.startsWith("data: ")) continue;
        const payload = JSON.parse(evt.slice(6));

        if (payload.type === "progress") {
          onProgress(payload.step);
        } else if (payload.type === "result") {
          result = payload.result;
        } else if (payload.type === "error") {
          throw new Error(payload.error);
        }
      }
    }

    return result;
  }

  return { run };
}

function StepStatus({ steps, running }: { steps: string[]; running: boolean }) {
  if (steps.length === 0) return null;
  return (
    <div className="mt-4 space-y-1.5 rounded-xl border p-4" style={{ borderColor: C.border, backgroundColor: C.card }}>
      {steps.map((step, i) => (
        <p key={i} className="text-xs" style={{ color: C.muted }}>
          {i === steps.length - 1 && running ? "→ " : "✓ "}
          {step}
        </p>
      ))}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="mt-4 rounded-xl border p-4" style={{ borderColor: "#3a1f1f", backgroundColor: "#1a1212" }}>
      <p className="text-sm" style={{ color: C.red }}>{message}</p>
    </div>
  );
}

function WarningsBox({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-1 rounded-xl border p-4" style={{ borderColor: "#3a2f1f", backgroundColor: "#1a1712" }}>
      {warnings.map((w, i) => (
        <p key={i} className="text-sm" style={{ color: C.gold }}>{w}</p>
      ))}
    </div>
  );
}

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={pillStyle(color)}>
      {children}
    </span>
  );
}

function ProgressBar({ percent, color }: { percent: number; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: C.border }}>
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${Math.max(0, Math.min(100, percent))}%`, backgroundColor: color }}
      />
    </div>
  );
}

function PageDetail({ page }: { page: PageSummary }) {
  const [showRawText, setShowRawText] = useState(false);

  return (
    <div className="space-y-4">
      {page.fetchError ? (
        <p className="text-sm" style={{ color: C.red }}>Failed: {page.fetchError}</p>
      ) : (
        <>
          <div className="flex gap-4">
            <p className="text-xs" style={{ color: C.muted }}>
              <span style={{ color: C.text }}>{page.wordCount}</span> words
            </p>
            <p className="text-xs" style={{ color: C.muted }}>
              <span style={{ color: C.text }}>{page.entityCount}</span> entities
            </p>
            <p className="text-xs" style={{ color: C.muted }}>
              <span style={{ color: C.text }}>{page.informationGain.length}</span> unique signals
            </p>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide" style={{ color: C.muted }}>
              Headings
            </p>
            {page.headingOutline.length === 0 ? (
              <p className="text-xs" style={{ color: C.muted }}>No headings detected.</p>
            ) : (
              <div className="space-y-0.5">
                {page.headingOutline.map((h, i) => (
                  <p
                    key={i}
                    className="text-xs"
                    style={{ color: "#aab2c5", paddingLeft: `${(h.level - 1) * 12}px` }}
                  >
                    H{h.level} — {h.text}
                  </p>
                ))}
              </div>
            )}
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide" style={{ color: C.muted }}>
              Top entities (showing {Math.min(20, page.entities.length)} of {page.entityCount})
            </p>
            <div className="flex flex-wrap gap-1.5">
              {page.entities.slice(0, 20).map((e, i) => (
                <span
                  key={i}
                  className="rounded-full px-2 py-0.5 text-xs"
                  style={pillStyle(C.purple)}
                  title={`${e.type} · salience ${e.salience.toFixed(2)}`}
                >
                  {e.name}
                </span>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide" style={{ color: C.muted }}>
              Information gain — unique to this page only
            </p>
            {page.informationGain.length === 0 ? (
              <p className="text-xs" style={{ color: C.muted }}>
                Nothing found that&apos;s unique to this page vs. the rest of the set.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {page.informationGain.map((g, i) => (
                  <span
                    key={i}
                    className="rounded-full px-2 py-0.5 text-xs"
                    style={pillStyle(C.green)}
                    title={`mentioned ${g.count}x, found on no other page in this set`}
                  >
                    {g.term}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div>
            <button
              type="button"
              onClick={() => setShowRawText((v) => !v)}
              className="text-xs underline"
              style={{ color: C.muted }}
            >
              {showRawText ? "Hide" : "Show"} raw extracted text (verify header/footer exclusion)
            </button>
            {showRawText && (
              <pre
                className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl border p-3 text-xs"
                style={{ borderColor: C.border, backgroundColor: C.bg, color: C.muted }}
              >
                {page.rawText || "(no text extracted)"}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const sse = useSSE();

  const [topic, setTopic] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [urls, setUrls] = useState("");

  const [scrapeRunning, setScrapeRunning] = useState(false);
  const [scrapeSteps, setScrapeSteps] = useState<string[]>([]);
  const [scrapeResult, setScrapeResult] = useState<ScrapeResult | null>(null);
  const [scrapeError, setScrapeError] = useState("");

  const [optimizeRunning, setOptimizeRunning] = useState(false);
  const [optimizeSteps, setOptimizeSteps] = useState<string[]>([]);
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResult | null>(null);
  const [optimizeError, setOptimizeError] = useState("");

  const [structuralRunning, setStructuralRunning] = useState(false);
  const [structuralResult, setStructuralResult] = useState<StructuralReport | null>(null);
  const [structuralError, setStructuralError] = useState("");

  const [copied, setCopied] = useState(false);
  const [entityFilter, setEntityFilter] = useState("");
  const [keywordFilter, setKeywordFilter] = useState("");
  const [activeTypeFilter, setActiveTypeFilter] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const urlCount = urls
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean).length;

  async function handleScrape(e: React.FormEvent) {
    e.preventDefault();
    if (!targetUrl.trim() || urlCount === 0 || scrapeRunning) return;

    setScrapeRunning(true);
    setScrapeSteps([]);
    setScrapeResult(null);
    setScrapeError("");
    setOptimizeResult(null);
    setStructuralResult(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = (await sse.run(
        "/api/scrape",
        { targetUrl: targetUrl.trim(), urls: urls.trim(), searchTerm: topic.trim() },
        (step) => setScrapeSteps((prev) => [...prev, step]),
        controller.signal
      )) as ScrapeResult;
      setScrapeResult(result);
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        setScrapeError(err.message);
      }
    } finally {
      setScrapeRunning(false);
    }
  }

  function handleStopScrape() {
    abortRef.current?.abort();
    setScrapeRunning(false);
    setScrapeSteps((prev) => [...prev, "Stopped by user."]);
  }

  async function handleOptimize() {
    if (!scrapeResult || optimizeRunning) return;

    setOptimizeRunning(true);
    setOptimizeSteps([]);
    setOptimizeResult(null);
    setOptimizeError("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = (await sse.run(
        "/api/optimize",
        { cache: scrapeResult._cache },
        (step) => setOptimizeSteps((prev) => [...prev, step]),
        controller.signal
      )) as OptimizeResult;
      setOptimizeResult(result);
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        setOptimizeError(err.message);
      }
    } finally {
      setOptimizeRunning(false);
    }
  }

  function handleStopOptimize() {
    abortRef.current?.abort();
    setOptimizeRunning(false);
    setOptimizeSteps((prev) => [...prev, "Stopped by user."]);
  }

  async function handleStructuralCheck() {
    if (!scrapeResult || structuralRunning) return;

    setStructuralRunning(true);
    setStructuralResult(null);
    setStructuralError("");

    try {
      const cache = scrapeResult._cache as { target: { text: string } };
      const res = await fetch("/api/structural-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cache.target.text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStructuralError(data.error || "Something went wrong.");
      } else {
        setStructuralResult(data.structuralReport);
      }
    } catch {
      setStructuralError("Connection lost. Try again.");
    } finally {
      setStructuralRunning(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  async function handleCopy() {
    if (!optimizeResult) return;
    const text = optimizeResult.optimization.sections
      .map(
        (s) =>
          `## ${s.heading}${s.isNew ? " (new section)" : ""}\n\n${s.suggestedText}\n\nImpact: ${s.relevanceImpact}`
      )
      .join("\n\n---\n\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleExportXlsx() {
    if (!scrapeResult) return;

    const sheets: { name: string; rows: (string | number)[][] }[] = [];

    const pageRows: (string | number)[][] = [
      ["URL", "Role", "Word Count", "Entity Count", "Topical Coverage %"],
      [scrapeResult.target.url, "Target", scrapeResult.target.wordCount, scrapeResult.target.entityCount, scrapeResult.target.topicalCoverageScore],
      ...scrapeResult.competitors.map((c) => [
        c.url,
        "Competitor",
        c.wordCount,
        c.entityCount,
        c.topicalCoverageScore,
      ] as (string | number)[]),
    ];
    sheets.push({ name: "Pages Overview", rows: pageRows });

    const keywordRows: (string | number)[][] = [
      ["Term", "Type", "Competitors Mentioning", "Avg Salience", "In Target"],
      ...scrapeResult.topKeywords.map((k) => [
        k.term,
        k.type,
        k.appearsInCompetitors,
        k.avgSalience.toFixed(3),
        k.presentInTarget ? "Yes" : "No",
      ] as (string | number)[]),
    ];
    sheets.push({ name: "Top Keywords", rows: keywordRows });

    const allPages = [
      { url: scrapeResult.target.url, label: "TARGET: " + scrapeResult.target.url, entities: scrapeResult.target.entities },
      ...scrapeResult.competitors.map((c) => ({ url: c.url, label: c.url, entities: c.entities })),
    ];

    // Merge case-variant spellings of the same entity ("Car Accident
    // Lawyer" vs "car accident lawyer") into one row instead of treating
    // them as distinct entities. Without this, a term spelled differently
    // by case across pages can show as present on multiple sides when
    // it's actually the exact same term -- hiding the real gap (or lack
    // of one) rather than revealing it. Display name = most frequently
    // occurring original casing across the whole set; per-page cell =
    // max salience among all case-variants that page used.
    const normalizedGroups = new Map<
      string,
      { displayCounts: Map<string, number>; type: string; perPageSalience: Map<string, number> }
    >();

    for (const page of allPages) {
      for (const e of page.entities) {
        const key = e.name.toLowerCase().trim();
        let group = normalizedGroups.get(key);
        if (!group) {
          group = { displayCounts: new Map(), type: e.type, perPageSalience: new Map() };
          normalizedGroups.set(key, group);
        }
        group.displayCounts.set(e.name, (group.displayCounts.get(e.name) ?? 0) + 1);
        const existingSalience = group.perPageSalience.get(page.url) ?? 0;
        if (e.salience > existingSalience) {
          group.perPageSalience.set(page.url, e.salience);
        }
      }
    }

    const sortedKeys = Array.from(normalizedGroups.keys()).sort();
    const matrixHeader = ["Entity", "Type", ...allPages.map((p) => p.label)];
    const matrixRows: (string | number)[][] = [matrixHeader];

    for (const key of sortedKeys) {
      const group = normalizedGroups.get(key)!;
      const displayName = Array.from(group.displayCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
      const row: (string | number)[] = [displayName, group.type];
      for (const page of allPages) {
        const salience = group.perPageSalience.get(page.url);
        row.push(salience !== undefined ? salience.toFixed(3) : "");
      }
      matrixRows.push(row);
    }
    sheets.push({ name: "Entity Matrix", rows: matrixRows });

    const infoGainRows: (string | number)[][] = [["Page URL", "Role", "Unique Term", "Mentions"]];
    infoGainRows.push(
      ...scrapeResult.target.informationGain.map(
        (g) => [scrapeResult.target.url, "Target", g.term, g.count] as (string | number)[]
      )
    );
    for (const c of scrapeResult.competitors) {
      infoGainRows.push(
        ...c.informationGain.map((g) => [c.url, "Competitor", g.term, g.count] as (string | number)[])
      );
    }
    sheets.push({ name: "Information Gain", rows: infoGainRows });

    if (scrapeResult.searchTerm && scrapeResult.termRelevance.length > 0) {
      const termRelevanceRows: (string | number)[][] = [
        ["URL", "Role", "Relevance to Search Term %", "Best Matching Passage"],
        ...scrapeResult.termRelevance.map((r) => {
          const isTarget = r.url === scrapeResult.target.url;
          return [
            r.url,
            isTarget ? "Target" : "Competitor",
            r.overallScore,
            r.topChunks[0]?.text ?? "",
          ] as (string | number)[];
        }),
      ];
      sheets.push({ name: "Term Relevance", rows: termRelevanceRows });
    }

    const scrapeReportRows: (string | number)[][] = [
      ["URL", "Role", "Status"],
      [scrapeResult.target.url, "Target", scrapeResult.target.fetchError ? "Failed: " + scrapeResult.target.fetchError : "OK"],
      ...scrapeResult.competitors.map(
        (c) => [c.url, "Competitor", c.fetchError ? "Failed: " + c.fetchError : "OK"] as (string | number)[]
      ),
    ];
    sheets.push({ name: "Scrape Report", rows: scrapeReportRows });

    if (optimizeResult) {
      const missingRows: (string | number)[][] = [
        ["Entity", "Type", "Competitors Mentioning", "Avg Salience", "Suggested Placement"],
        ...optimizeResult.gapReport.missingEntities.map((e) => {
          const placement = findPlacement(e.name);
          return [e.name, e.type, e.appearsInCompetitors, e.avgSalienceInCompetitors.toFixed(3), placement] as (
            | string
            | number
          )[];
        }),
      ];
      sheets.push({ name: "Missing Entities", rows: missingRows });

      const passageRows: (string | number)[][] = [
        ["Competitor URL", "Match Score", "Passage"],
        ...optimizeResult.gapReport.semanticCoverage.uncoveredPassages.map(
          (p) => [p.competitorUrl, p.bestMatchScore.toFixed(3), p.competitorChunk] as (string | number)[]
        ),
      ];
      sheets.push({ name: "Uncovered Passages", rows: passageRows });

      const optRows: (string | number)[][] = [
        [
          "Section",
          "New Section?",
          "Citability Before",
          "Citability After",
          "Entities Assigned",
          "Current Text",
          "Suggested Text",
          "Relevance Impact",
        ],
        ...optimizeResult.optimization.sections.map(
          (s) =>
            [
              s.heading,
              s.isNew ? "Yes" : "No",
              s.citabilityBefore,
              s.citabilityAfter,
              s.entitiesAssigned.join(", "),
              s.currentText,
              s.suggestedText,
              s.relevanceImpact,
            ] as (string | number)[]
        ),
      ];
      optRows.push([]);
      optRows.push([
        "Overall semantic coverage",
        "",
        optimizeResult.optimization.overallCurrentScore,
        optimizeResult.optimization.overallProjectedScore ?? "N/A",
        "",
        "",
        "",
        "",
      ]);
      sheets.push({ name: "Optimization Plan", rows: optRows });
    }

    downloadXlsx(
      `relevance-audit-${scrapeResult.target.url.replace(/[^a-z0-9]/gi, "-")}.xlsx`,
      sheets
    );
  }

  const criticalGapCount = optimizeResult?.gapReport.missingEntities.length ?? 0;
  const infoGainCount = scrapeResult?.topKeywords.filter((k) => !k.presentInTarget).length ?? 0;

  const barChartItems = scrapeResult
    ? scrapeResult.topKeywords.map((k) => ({
        name: k.term,
        value: k.appearsInCompetitors,
        covered: k.presentInTarget,
      }))
    : [];

  function findPlacement(entityName: string): string {
    if (!optimizeResult) return "Not yet analyzed";
    for (const section of optimizeResult.optimization.sections) {
      if (section.entitiesAssigned.some((e) => e.toLowerCase() === entityName.toLowerCase())) {
        return section.isNew ? `${section.heading} (new)` : section.heading;
      }
    }
    return "Unassigned";
  }

  const competitorScores = scrapeResult?.competitors.map((c) => c.topicalCoverageScore) ?? [];
  const competitorAvgScore = competitorScores.length > 0
    ? Math.round(competitorScores.reduce((a, b) => a + b, 0) / competitorScores.length)
    : 0;
  const topCompetitorScore = competitorScores.length > 0 ? Math.max(...competitorScores) : 0;

  const entityTypes = optimizeResult
    ? Array.from(new Set(optimizeResult.gapReport.missingEntities.map((e) => e.type)))
    : [];

  const filteredMissingEntities = optimizeResult
    ? optimizeResult.gapReport.missingEntities.filter((e) => {
        if (activeTypeFilter && e.type !== activeTypeFilter) return false;
        if (entityFilter && !e.name.toLowerCase().includes(entityFilter.toLowerCase())) return false;
        return true;
      })
    : [];

  const filteredMissingKeywords = scrapeResult
    ? scrapeResult.topKeywords
        .filter((k) => !k.presentInTarget)
        .filter((k) => !keywordFilter || k.term.toLowerCase().includes(keywordFilter.toLowerCase()))
    : [];

  const optimizerInsight = optimizeResult
    ? `Your page covers ${optimizeResult.gapReport.semanticCoverage.coverageScore}% of competitor passages above the strong-match threshold (avg. similarity ${optimizeResult.gapReport.semanticCoverage.averageSimilarity}%) and is missing ${optimizeResult.gapReport.missingEntities.length} entit${optimizeResult.gapReport.missingEntities.length === 1 ? "y" : "ies"} that competitors mention. Applying the suggested section rewrites is projected to move average similarity from ${optimizeResult.optimization.overallCurrentSimilarity}% to ${optimizeResult.optimization.overallProjectedSimilarity ?? "an unavailable score (Vertex recomputation failed)"} -- note the strong-match % alone can stay flat even with real progress, since it only counts passages that fully cross the threshold.`
    : "Run the gap analysis to generate AI-backed optimization insight for this page.";

  return (
    <div className="min-h-screen" style={{ backgroundColor: C.bg, color: C.text }}>
      <header
        className="flex items-center justify-between border-b px-6 py-3"
        style={{ borderColor: C.border, backgroundColor: C.bg }}
      >
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold" style={{ backgroundColor: C.green, color: C.bg }}>
            R
          </span>
          <div>
            <p className="text-sm font-semibold leading-tight">Relevance Engineering</p>
            <p className="text-[10px] uppercase tracking-wide leading-tight" style={{ color: C.muted }}>
              Semantic Audit Engine
            </p>
          </div>
        </div>
        <button onClick={handleLogout} className="text-xs hover:underline" style={{ color: C.muted }}>
          Sign out
        </button>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10 space-y-10">
        <section className="rounded-xl border p-6" style={{ borderColor: C.border, backgroundColor: C.card }}>
          <h2 className="mb-4 text-sm font-semibold">Step 1 — Scrape &amp; Summarize</h2>
          <form onSubmit={handleScrape} className="space-y-4">
            <div>
              <label htmlFor="topic" className="mb-1.5 block text-xs" style={{ color: C.muted }}>
                Topic / keyword
              </label>
              <input
                id="topic"
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. car accident lawyer toronto"
                maxLength={200}
                disabled={scrapeRunning}
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none disabled:opacity-50"
                style={{ borderColor: C.border, backgroundColor: C.bg, color: C.text }}
              />
            </div>

            <div>
              <label htmlFor="targetUrl" className="mb-1.5 block text-xs" style={{ color: C.muted }}>
                Target URL (required)
              </label>
              <input
                id="targetUrl"
                type="text"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="https://yoursite.com/your-page"
                disabled={scrapeRunning}
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none disabled:opacity-50"
                style={{ borderColor: C.border, backgroundColor: C.bg, color: C.text }}
              />
            </div>

            <div>
              <label htmlFor="urls" className="mb-1.5 block text-xs" style={{ color: C.muted }}>
                Competitor URLs (required, at least 1)
              </label>
              <textarea
                id="urls"
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
                placeholder={"https://competitor1.com/page\nhttps://competitor2.com/page"}
                rows={5}
                disabled={scrapeRunning}
                className="w-full resize-y rounded-lg border px-3 py-2 text-sm font-mono outline-none disabled:opacity-50"
                style={{ borderColor: C.border, backgroundColor: C.bg, color: C.text }}
              />
              <p className="mt-1 text-xs" style={{ color: C.muted }}>
                {urlCount > 0 ? `${urlCount} URL(s) detected.` : "No competitor URLs entered yet."}
              </p>
            </div>

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={scrapeRunning || !targetUrl.trim() || urlCount === 0}
                className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
                style={{ backgroundColor: C.green, color: C.bg }}
              >
                {scrapeRunning ? "Scraping..." : "Scrape & Summarize"}
              </button>
              {scrapeRunning && (
                <button
                  type="button"
                  onClick={handleStopScrape}
                  className="rounded-lg border px-4 py-2 text-sm font-medium"
                  style={{ borderColor: "#3a1f1f", backgroundColor: "#1a1212", color: C.red }}
                >
                  Stop
                </button>
              )}
            </div>
          </form>

          <StepStatus steps={scrapeSteps} running={scrapeRunning} />
          {scrapeError && <ErrorBox message={scrapeError} />}
        </section>

        {scrapeResult && (
          <>
            <section
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-5 py-3"
              style={{ borderColor: C.border, backgroundColor: C.card }}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge color={C.blue}>{new URL(scrapeResult.target.url).hostname}</Badge>
                {topic && <span style={{ color: C.muted }}>&ldquo;{topic}&rdquo;</span>}
                <Badge color={C.purple}>Nemotron + Vertex</Badge>
              </div>
              <button
                onClick={handleExportXlsx}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium"
                style={{ backgroundColor: C.green, color: C.bg }}
              >
                Export Excel (multi-tab) ▾
              </button>
            </section>

            <WarningsBox warnings={scrapeResult.errors} />

            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <ScoreCard value={scrapeResult.competitors.length} label="Competitors analyzed" accent="info" />
              <ScoreCard value={scrapeResult.target.wordCount} label="Target word count" accent="neutral" />
              <ScoreCard
                value={optimizeResult ? criticalGapCount : "—"}
                label={optimizeResult ? "Critical entity gaps" : "Entity gaps (not yet analyzed)"}
                accent={!optimizeResult ? "neutral" : criticalGapCount > 0 ? "danger" : "good"}
              />
              <ScoreCard value={infoGainCount} label="Info-gain signals" accent={infoGainCount > 0 ? "warning" : "good"} />
            </section>

            <section
              className="rounded-xl border p-5"
              style={{
                borderColor: optimizeResult ? C.border : C.green,
                backgroundColor: C.card,
              }}
            >
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">
                    {optimizeResult ? "AI Content Optimizer" : "Step 2 — AI Content Optimizer (not run yet)"}
                  </p>
                  <p className="text-xs" style={{ color: C.muted }}>
                    Section-grounded rewrite suggestions with recomputed impact
                  </p>
                </div>
                {optimizeResult && !optimizeRunning && (
                  <button
                    onClick={handleOptimize}
                    className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
                    style={{ backgroundColor: C.border, color: C.text }}
                  >
                    ↻ Regenerate
                  </button>
                )}
                {optimizeRunning && (
                  <button onClick={handleStopOptimize} className="text-xs" style={{ color: C.red }}>
                    Stop
                  </button>
                )}
              </div>

              {!optimizeResult && !optimizeRunning && (
                <button
                  onClick={handleOptimize}
                  className="mb-3 w-full rounded-lg py-2.5 text-sm font-semibold"
                  style={{ backgroundColor: C.green, color: C.bg }}
                >
                  Run gap analysis + rewrite suggestions →
                </button>
              )}

              <div className="rounded-lg p-4" style={{ backgroundColor: C.bg }}>
                <p className="text-sm" style={{ color: "#c9cedb" }}>{optimizerInsight}</p>
              </div>

              <StepStatus steps={optimizeSteps} running={optimizeRunning} />
              {optimizeError && <ErrorBox message={optimizeError} />}

              {optimizeResult && (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center gap-6">
                    <div>
                      <p className="text-3xl font-bold" style={{ color: C.green }}>
                        {optimizeResult.optimization.overallCurrentScore}
                      </p>
                      <p className="text-xs" style={{ color: C.muted }}>Current (strong-match %)</p>
                    </div>
                    <span style={{ color: C.muted }}>→</span>
                    <div>
                      <p className="text-3xl font-bold" style={{ color: C.green }}>
                        {optimizeResult.optimization.overallProjectedScore ?? "N/A"}
                      </p>
                      <p className="text-xs" style={{ color: C.muted }}>Projected</p>
                    </div>
                    {optimizeResult.optimization.overallProjectedScore === null && (
                      <p className="text-xs" style={{ color: C.gold }}>
                        {optimizeResult.optimization.projectedScoreUnavailableReason}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-6 border-t pt-3" style={{ borderColor: C.border }}>
                    <div>
                      <p className="text-xl font-semibold" style={{ color: C.blue }}>
                        {optimizeResult.optimization.overallCurrentSimilarity}
                      </p>
                      <p className="text-xs" style={{ color: C.muted }}>Current (avg. similarity)</p>
                    </div>
                    <span style={{ color: C.muted }}>→</span>
                    <div>
                      <p className="text-xl font-semibold" style={{ color: C.blue }}>
                        {optimizeResult.optimization.overallProjectedSimilarity ?? "N/A"}
                      </p>
                      <p className="text-xs" style={{ color: C.muted }}>Projected</p>
                    </div>
                    <p className="text-xs" style={{ color: C.muted }}>
                      ← continuous score, shows real partial progress the strong-match % can&apos;t
                    </p>
                  </div>
                </div>
              )}
            </section>

            {optimizeResult && (
              <section>
                <h2 className="mb-3 text-sm font-semibold">Optimization Summary</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {[
                    {
                      title: "Information Gain",
                      color: C.green,
                      body: `${scrapeResult.target.informationGain.length} unique term(s) your page contributes that no competitor mentions.`,
                      items: scrapeResult.target.informationGain.slice(0, 3).map((g) => g.term),
                    },
                    {
                      title: "Keywords Needed",
                      color: C.red,
                      body: `${infoGainCount} top keyword(s) competitors use that your page doesn't.`,
                      items: scrapeResult.topKeywords.filter((k) => !k.presentInTarget).slice(0, 3).map((k) => k.term),
                    },
                    {
                      title: "Entities to Mention",
                      color: C.red,
                      body: `${criticalGapCount} entit${criticalGapCount === 1 ? "y" : "ies"} competitors mention that your page is missing.`,
                      items: optimizeResult.gapReport.missingEntities.slice(0, 3).map((e) => e.name),
                    },
                    {
                      title: "Embedding Friendliness",
                      color: C.blue,
                      body: `${optimizeResult.gapReport.semanticCoverage.coverageScore}% of competitor passages have a strong semantic match on your page.`,
                      items: [`${optimizeResult.gapReport.semanticCoverage.coverageScore}% semantic coverage`],
                    },
                    {
                      title: "Language & Readability",
                      color: C.gold,
                      body: structuralResult
                        ? `${structuralResult.findings.filter((f) => f.passed).length} of ${structuralResult.findings.length} structural checks passed.`
                        : "Run the structural check (Step 3) to populate this.",
                      items: structuralResult ? structuralResult.findings.filter((f) => f.passed).map((f) => f.rule) : [],
                    },
                    {
                      title: "Citability",
                      color: C.purple,
                      body: "Whether each section carries a verifiable statistic, quote, or named source.",
                      items: optimizeResult.optimization.sections
                        .filter((s) => s.citabilityAfter >= 40)
                        .slice(0, 3)
                        .map((s) => s.heading),
                    },
                  ].map((card, i) => (
                    <div key={i} className="rounded-xl border p-4" style={{ borderColor: C.border, backgroundColor: C.card }}>
                      <div className="mb-2 flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: card.color }} />
                        <p className="text-sm font-semibold">{card.title}</p>
                      </div>
                      <p className="mb-2 text-xs" style={{ color: C.muted }}>{card.body}</p>
                      <ul className="space-y-1">
                        {card.items.map((item, j) => (
                          <li key={j} className="flex items-start gap-1.5 text-xs" style={{ color: "#c9cedb" }}>
                            <span style={{ color: C.green }}>✓</span> {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {optimizeResult && optimizeResult.optimization.sections.length > 0 && (
              <section>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">
                    Section-by-Section Comparison — grounded in {optimizeResult.optimization.sectionsFound} real section(s)
                  </h2>
                  <button onClick={handleCopy} className="text-xs hover:underline" style={{ color: C.muted }}>
                    {copied ? "Copied" : "Copy all"}
                  </button>
                </div>
                <div className="space-y-3">
                  {optimizeResult.optimization.sections.map((s, i) => (
                    <div key={i} className="rounded-xl border p-4" style={{ borderColor: C.border, backgroundColor: C.card }}>
                      <div className="mb-3 flex items-center justify-between">
                        <p className="text-sm font-medium">
                          {s.heading}
                          {s.isNew && (
                            <span className="ml-2 rounded-full px-2 py-0.5 text-xs" style={pillStyle(C.green)}>
                              new section
                            </span>
                          )}
                        </p>
                        <span
                          className="rounded-full px-2 py-0.5 text-xs font-medium"
                          style={pillStyle(s.citabilityAfter >= 40 ? C.green : s.citabilityAfter >= 20 ? C.gold : C.red)}
                        >
                          {s.citabilityBefore} → {s.citabilityAfter}
                        </span>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        {!s.isNew && (
                          <div>
                            <p className="mb-1 text-xs font-medium uppercase tracking-wide" style={{ color: C.muted }}>
                              Current
                            </p>
                            <p className="text-sm" style={{ color: "#aab2c5" }}>{s.currentText.slice(0, 300)}</p>
                          </div>
                        )}
                        <div className={s.isNew ? "sm:col-span-2" : ""}>
                          <p className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wide" style={{ color: C.green }}>
                            ✓ {s.isNew ? "Proposed new content" : "Suggested"}
                          </p>
                          <p className="text-sm" style={{ color: "#c9cedb" }}>{s.suggestedText}</p>
                        </div>
                      </div>

                      {s.entitiesAssigned.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {s.entitiesAssigned.map((e, j) => (
                            <span key={j} className="rounded-full px-2 py-0.5 text-xs" style={pillStyle(C.purple)}>
                              {e}
                            </span>
                          ))}
                        </div>
                      )}

                      {s.relevanceImpact && (
                        <div className="mt-3 border-t pt-3 text-xs" style={{ borderColor: C.border, color: C.muted }}>
                          ↗ Relevance impact: {s.relevanceImpact}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {optimizeResult && (
              <section className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col items-center justify-center rounded-xl border p-6" style={{ borderColor: C.border, backgroundColor: C.card }}>
                  <p className="mb-3 self-start text-sm font-semibold">Semantic Relevance</p>
                  <CircularGauge
                    value={optimizeResult.gapReport.semanticCoverage.coverageScore}
                    label="Topic centroid baseline"
                  />
                </div>
                <div className="rounded-xl border p-5" style={{ borderColor: C.border, backgroundColor: C.card }}>
                  <p className="mb-3 text-sm font-semibold">Thematic Consensus</p>
                  <p className="mb-3 text-xs" style={{ color: C.muted }}>
                    Top entities across ranking pages — green = covered, red = gap
                  </p>
                  <CoverageBarChart items={barChartItems} />
                </div>
              </section>
            )}

            {scrapeResult.competitors.length > 0 && (
              <section className="rounded-xl border p-5" style={{ borderColor: C.border, backgroundColor: C.card }}>
                <p className="mb-1 text-sm font-semibold">Audit Summary</p>
                <p className="mb-4 text-xs" style={{ color: C.muted }}>
                  ↗ Topical coverage score: % of this term&apos;s top keywords each page actually contains
                </p>

                <div className="space-y-3">
                  {[
                    { label: "Your page", value: scrapeResult.target.topicalCoverageScore, color: C.green },
                    { label: "Competitor average", value: competitorAvgScore, color: C.muted },
                    { label: "Top competitor", value: topCompetitorScore, color: C.gold },
                  ].map((row, i) => (
                    <div key={i}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span style={{ color: C.muted }}>{row.label}</span>
                        <span style={{ color: row.color }}>{row.value}%</span>
                      </div>
                      <ProgressBar percent={row.value} color={row.color} />
                    </div>
                  ))}
                </div>

                <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <ScoreCard value={scrapeResult.topKeywords.length} label="Keywords tracked" accent="info" />
                  <ScoreCard value={scrapeResult.target.entityCount} label="Your entities" accent="neutral" />
                  <ScoreCard value={scrapeResult.target.informationGain.length} label="Unique signals" accent="good" />
                  <ScoreCard
                    value={optimizeResult ? criticalGapCount : "—"}
                    label={optimizeResult ? "Entity gaps" : "Entity gaps (run Step 2)"}
                    accent={!optimizeResult ? "neutral" : criticalGapCount > 0 ? "danger" : "good"}
                  />
                </div>
              </section>
            )}

            {scrapeResult.searchTerm && (
              <section className="rounded-xl border p-5" style={{ borderColor: C.border, backgroundColor: C.card }}>
                <p className="mb-1 text-sm font-semibold">Term Relevance — ranked against the literal search term</p>
                <p className="mb-4 text-xs" style={{ color: C.muted }}>
                  Unlike every other metric here (which compares pages against each other), this embeds
                  &ldquo;{scrapeResult.searchTerm}&rdquo; itself and ranks each page&apos;s best-matching passage
                  against it directly.
                </p>
                {scrapeResult.termRelevanceError ? (
                  <p className="text-sm" style={{ color: C.gold }}>
                    Unavailable this run: {scrapeResult.termRelevanceError}
                  </p>
                ) : scrapeResult.termRelevance.length === 0 ? (
                  <p className="text-sm" style={{ color: C.muted }}>No data computed.</p>
                ) : (
                  <div className="space-y-3">
                    {[...scrapeResult.termRelevance]
                      .sort((a, b) => b.overallScore - a.overallScore)
                      .map((r, i) => {
                        const isTarget = r.url === scrapeResult.target.url;
                        return (
                          <div key={i}>
                            <div className="mb-1 flex items-center justify-between text-xs">
                              <span style={{ color: isTarget ? C.green : C.muted }}>
                                {isTarget ? "YOUR PAGE — " : ""}
                                {r.url}
                              </span>
                              <span style={{ color: isTarget ? C.green : C.text }}>{r.overallScore}%</span>
                            </div>
                            <ProgressBar percent={r.overallScore} color={isTarget ? C.green : C.blue} />
                            {r.topChunks[0] && (
                              <p className="mt-1 text-xs italic" style={{ color: C.muted }}>
                                Best match: &ldquo;{r.topChunks[0].text.slice(0, 140)}
                                {r.topChunks[0].text.length > 140 ? "…" : ""}&rdquo;
                              </p>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}
              </section>
            )}

            <section>
              <h2 className="mb-3 text-sm font-semibold">Page-by-Page Analysis</h2>
              <div className="space-y-2">
                <AccordionRow
                  rank={1}
                  title={scrapeResult.target.title}
                  subtitle={scrapeResult.target.url}
                  metaRow={
                    <div className="flex gap-3 text-[11px]" style={{ color: C.muted }}>
                      <span>{scrapeResult.target.wordCount} words</span>
                      <span>{scrapeResult.target.entityCount} entities</span>
                      <span>{scrapeResult.target.informationGain.length} signals</span>
                    </div>
                  }
                  badge={<Badge color={C.green}>YOUR PAGE</Badge>}
                  rightMeta={
                    <span className="flex items-center gap-1.5 text-xs font-medium">
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{
                          backgroundColor:
                            scrapeResult.target.topicalCoverageScore >= 75
                              ? C.green
                              : scrapeResult.target.topicalCoverageScore >= 45
                                ? C.gold
                                : C.red,
                        }}
                      />
                      {scrapeResult.target.topicalCoverageScore}%
                    </span>
                  }
                  defaultOpen
                >
                  <PageDetail page={scrapeResult.target} />
                </AccordionRow>

                {scrapeResult.competitors.map((c, i) => (
                  <AccordionRow
                    key={i}
                    rank={i + 2}
                    title={c.title}
                    subtitle={c.url}
                    metaRow={
                      <div className="flex gap-3 text-[11px]" style={{ color: C.muted }}>
                        <span>{c.wordCount} words</span>
                        <span>{c.entityCount} entities</span>
                        <span>{c.informationGain.length} signals</span>
                      </div>
                    }
                    rightMeta={
                      <span className="flex items-center gap-1.5 text-xs font-medium">
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{
                            backgroundColor:
                              c.topicalCoverageScore >= 75 ? C.green : c.topicalCoverageScore >= 45 ? C.gold : C.red,
                          }}
                        />
                        {c.topicalCoverageScore}%
                      </span>
                    }
                  >
                    <PageDetail page={c} />
                  </AccordionRow>
                ))}
              </div>
            </section>

            {optimizeResult && (
              <section className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border p-4" style={{ borderColor: C.border, backgroundColor: C.card }}>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-semibold">Keywords</p>
                    <Badge color={C.red}>{filteredMissingKeywords.length} missing</Badge>
                  </div>
                  <p className="mb-2 text-xs" style={{ color: C.muted }}>
                    You cover {scrapeResult.topKeywords.length - infoGainCount} of {scrapeResult.topKeywords.length} (
                    {Math.round(((scrapeResult.topKeywords.length - infoGainCount) / Math.max(1, scrapeResult.topKeywords.length)) * 100)}%)
                  </p>
                  <ProgressBar
                    percent={((scrapeResult.topKeywords.length - infoGainCount) / Math.max(1, scrapeResult.topKeywords.length)) * 100}
                    color={C.red}
                  />
                  <input
                    type="text"
                    value={keywordFilter}
                    onChange={(e) => setKeywordFilter(e.target.value)}
                    placeholder="Filter keywords..."
                    className="mt-3 w-full rounded-lg border px-3 py-1.5 text-xs outline-none"
                    style={{ borderColor: C.border, backgroundColor: C.bg, color: C.text }}
                  />
                  <div className="mt-3 max-h-64 space-y-1.5 overflow-y-auto">
                    {filteredMissingKeywords.map((k, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span style={{ color: "#c9cedb" }}>{k.term}</span>
                        <Badge color={C.blue}>{k.appearsInCompetitors}/{scrapeResult.competitors.length} sites</Badge>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border p-4" style={{ borderColor: C.border, backgroundColor: C.card }}>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-semibold">Entities</p>
                    <Badge color={C.red}>{filteredMissingEntities.length} missing</Badge>
                  </div>
                  <p className="mb-2 text-xs" style={{ color: C.muted }}>
                    You cover {scrapeResult.target.entityCount} entities total
                  </p>
                  <ProgressBar
                    percent={
                      (scrapeResult.target.entityCount /
                        Math.max(1, scrapeResult.target.entityCount + criticalGapCount)) *
                      100
                    }
                    color={C.red}
                  />
                  <input
                    type="text"
                    value={entityFilter}
                    onChange={(e) => setEntityFilter(e.target.value)}
                    placeholder="Filter entities..."
                    className="mt-3 w-full rounded-lg border px-3 py-1.5 text-xs outline-none"
                    style={{ borderColor: C.border, backgroundColor: C.bg, color: C.text }}
                  />
                  <div className="mt-3 max-h-64 space-y-1.5 overflow-y-auto">
                    {filteredMissingEntities.map((e, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span style={{ color: "#c9cedb" }}>{e.name}</span>
                        <Badge color={C.purple}>{e.type}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {optimizeResult && (
              <section>
                <h2 className="mb-3 text-sm font-semibold">Entity Gap Analysis</h2>
                <div className="overflow-x-auto rounded-xl border" style={{ borderColor: C.border }}>
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr style={{ backgroundColor: C.card, color: C.muted }}>
                        <th className="px-4 py-2.5 font-medium">Missing Entity</th>
                        <th className="px-4 py-2.5 font-medium">Competitor Coverage</th>
                        <th className="px-4 py-2.5 font-medium">Suggested Placement</th>
                      </tr>
                    </thead>
                    <tbody>
                      {optimizeResult.gapReport.missingEntities.slice(0, 30).map((e, i) => (
                        <tr key={i} style={{ borderTop: `1px solid ${C.border}`, backgroundColor: C.bg }}>
                          <td className="px-4 py-2.5" style={{ color: C.text }}>{e.name}</td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <div className="w-20">
                                <ProgressBar
                                  percent={(e.appearsInCompetitors / Math.max(1, scrapeResult.competitors.length)) * 100}
                                  color={C.blue}
                                />
                              </div>
                              <span style={{ color: C.muted }}>
                                {e.appearsInCompetitors}/{scrapeResult.competitors.length}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge color={C.purple}>{findPlacement(e.name)}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className="rounded-xl border p-5" style={{ borderColor: C.border, backgroundColor: C.card }}>
              <h2 className="mb-3 text-sm font-semibold">Step 3 — Structural Check (optional)</h2>
              <button
                onClick={handleStructuralCheck}
                disabled={structuralRunning}
                className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
                style={{ backgroundColor: C.green, color: C.bg }}
              >
                {structuralRunning ? "Checking..." : "Run structural check"}
              </button>

              {structuralError && <ErrorBox message={structuralError} />}

              {structuralResult && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide" style={{ color: C.muted }}>
                    Structural check — {structuralResult.score}/100
                  </p>
                  <div className="space-y-2 rounded-lg p-4" style={{ backgroundColor: C.bg }}>
                    {structuralResult.findings.map((f, i) => (
                      <div key={i} className="text-sm">
                        <span style={{ color: f.passed ? C.green : C.red }}>{f.passed ? "✓" : "✗"}</span>{" "}
                        <span style={{ color: "#c9cedb" }}>{f.rule}</span>
                        {!f.passed && (
                          <p className="ml-5 mt-0.5 text-xs" style={{ color: C.muted }}>{f.detail}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {optimizeResult && entityTypes.length > 0 && (
              <section>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setActiveTypeFilter(null)}
                    className="rounded-full px-3 py-1 text-xs font-medium"
                    style={activeTypeFilter === null ? pillStyle(C.blue) : { color: C.muted, border: `1px solid ${C.border}` }}
                  >
                    All types
                  </button>
                  {entityTypes.map((t) => (
                    <button
                      key={t}
                      onClick={() => setActiveTypeFilter(t)}
                      className="rounded-full px-3 py-1 text-xs font-medium"
                      style={activeTypeFilter === t ? pillStyle(C.blue) : { color: C.muted, border: `1px solid ${C.border}` }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h2 className="mb-3 text-sm font-semibold">Scrape Report</h2>
              <div className="overflow-x-auto rounded-xl border" style={{ borderColor: C.border }}>
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr style={{ backgroundColor: C.card, color: C.muted }}>
                      <th className="px-4 py-2.5 font-medium">URL</th>
                      <th className="px-4 py-2.5 font-medium">Role</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ borderTop: `1px solid ${C.border}`, backgroundColor: C.bg }}>
                      <td className="px-4 py-2.5" style={{ color: C.text }}>{scrapeResult.target.url}</td>
                      <td className="px-4 py-2.5"><Badge color={C.green}>Target</Badge></td>
                      <td className="px-4 py-2.5">
                        {scrapeResult.target.fetchError ? (
                          <span style={{ color: C.red }}>{scrapeResult.target.fetchError}</span>
                        ) : (
                          <span style={{ color: C.green }}>OK</span>
                        )}
                      </td>
                    </tr>
                    {scrapeResult.competitors.map((c, i) => (
                      <tr key={i} style={{ borderTop: `1px solid ${C.border}`, backgroundColor: C.bg }}>
                        <td className="px-4 py-2.5" style={{ color: C.text }}>{c.url}</td>
                        <td className="px-4 py-2.5"><Badge color={C.blue}>Competitor</Badge></td>
                        <td className="px-4 py-2.5">
                          {c.fetchError ? (
                            <span style={{ color: C.red }}>{c.fetchError}</span>
                          ) : (
                            <span style={{ color: C.green }}>OK</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
