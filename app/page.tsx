"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { downloadXlsx } from "@/lib/xlsx-export";
import { downloadCsv } from "@/lib/csv-export";

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
  rewriteFailed?: boolean;
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

/* ---------------------------------------------------------------------- */
/* Shared helpers                                                          */
/* ---------------------------------------------------------------------- */

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
    <div className="mt-4 space-y-1.5 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      {steps.map((step, i) => (
        <p key={i} className="text-xs text-[var(--muted)]">
          {i === steps.length - 1 && running ? "→ " : "✓ "}
          {step}
        </p>
      ))}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="mt-4 rounded-xl border border-red-200 bg-[var(--red-soft)] p-4">
      <p className="text-sm text-[var(--red)]">{message}</p>
    </div>
  );
}

function WarningsBox({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-1 rounded-xl border border-amber-200 bg-[var(--gold-soft)] p-4">
      {warnings.map((w, i) => (
        <p key={i} className="text-sm text-[var(--gold)]">{w}</p>
      ))}
    </div>
  );
}

function Badge({ children, tone = "blue" }: { children: React.ReactNode; tone?: "blue" | "green" | "red" | "gold" | "slate" | "purple" }) {
  const tones: Record<string, string> = {
    blue: "bg-[var(--accent-soft)] text-[var(--accent)]",
    green: "bg-[var(--green-soft)] text-[var(--green)]",
    red: "bg-[var(--red-soft)] text-[var(--red)]",
    gold: "bg-[var(--gold-soft)] text-[var(--gold)]",
    slate: "bg-slate-100 text-slate-600",
    purple: "bg-violet-50 text-violet-700",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function ScoreCard({ value, label, tone = "slate" }: { value: string | number; label: string; tone?: "slate" | "green" | "gold" | "red" | "blue" | "purple" }) {
  const dot: Record<string, string> = {
    slate: "bg-slate-400",
    green: "bg-[var(--green)]",
    gold: "bg-[var(--gold)]",
    red: "bg-[var(--red)]",
    blue: "bg-[var(--accent)]",
    purple: "bg-violet-500",
  };
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-5 py-4">
      <span className={`mb-2 inline-block h-2 w-2 rounded-full ${dot[tone]}`} />
      <p className="text-3xl font-bold text-[var(--foreground)]">{value}</p>
      <p className="mt-1 text-xs text-[var(--muted)]">{label}</p>
    </div>
  );
}

function ScoreRing({ score, label }: { score: number; label: string }) {
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 70 ? "var(--green)" : score >= 40 ? "var(--gold)" : "var(--red)";

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative h-24 w-24">
        <svg viewBox="0 0 88 88" className="h-24 w-24 -rotate-90">
          <circle cx="44" cy="44" r={radius} fill="none" stroke="var(--border)" strokeWidth="8" />
          <circle
            cx="44"
            cy="44"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-lg font-semibold text-[var(--foreground)]">
          {score}
        </div>
      </div>
      <p className="text-xs text-[var(--muted)]">{label}</p>
    </div>
  );
}

function Card({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-[var(--muted)]">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ScoreCompare({ label, before, after }: { label: string; before: number; after: number | null }) {
  const improved = after !== null && after > before;
  return (
    <div className="flex flex-1 flex-col gap-1 rounded-lg border border-[var(--border)] p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold text-[var(--foreground)]">{before}%</span>
        {after !== null && (
          <>
            <span className="text-[var(--muted)]">→</span>
            <span className={`text-2xl font-semibold ${improved ? "text-[var(--green)]" : "text-[var(--foreground)]"}`}>
              {after}%
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function PageDetail({ page, isTarget }: { page: PageSummary; isTarget: boolean }) {
  const [expanded, setExpanded] = useState(isTarget);
  const [showRawText, setShowRawText] = useState(false);

  return (
    <div className="rounded-lg border border-[var(--border)]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2 overflow-hidden">
          {isTarget && <Badge tone="blue">Target</Badge>}
          <span className="truncate text-sm font-medium text-[var(--foreground)]">{page.title || page.url}</span>
        </div>
        <span className="text-[var(--muted)]">{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div className="space-y-4 border-t border-[var(--border)] px-4 py-4">
          {page.fetchError ? (
            <p className="text-sm text-[var(--red)]">Failed: {page.fetchError}</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-4 text-xs text-[var(--muted)]">
                <p><span className="font-medium text-[var(--foreground)]">{page.wordCount}</span> words</p>
                <p><span className="font-medium text-[var(--foreground)]">{page.entityCount}</span> entities</p>
                <p><span className="font-medium text-[var(--foreground)]">{page.informationGain.length}</span> unique signals</p>
                <p><span className="font-medium text-[var(--foreground)]">{page.topicalCoverageScore}%</span> topical coverage</p>
              </div>

              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Headings</p>
                {page.headingOutline.length === 0 ? (
                  <p className="text-xs text-[var(--muted)]">No headings detected.</p>
                ) : (
                  <div className="space-y-0.5">
                    {page.headingOutline.map((h, i) => (
                      <p key={i} className="text-xs text-slate-500" style={{ paddingLeft: `${(h.level - 1) * 12}px` }}>
                        H{h.level} — {h.text}
                      </p>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                  Top entities (showing {Math.min(20, page.entities.length)} of {page.entityCount})
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {page.entities.slice(0, 20).map((e, i) => (
                    <Badge key={i} tone="purple">
                      <span title={`${e.type} · salience ${e.salience.toFixed(2)}`}>{e.name}</span>
                    </Badge>
                  ))}
                  {page.entities.length === 0 && <p className="text-xs text-[var(--muted)]">No entities extracted.</p>}
                </div>
              </div>

              {page.informationGain.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                    Unique terms (not found on any other analyzed page)
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {page.informationGain.map((t, i) => (
                      <Badge key={i} tone="green">{t.term} ({t.count})</Badge>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <button
                  type="button"
                  onClick={() => setShowRawText((v) => !v)}
                  className="text-xs text-[var(--muted)] underline"
                >
                  {showRawText ? "Hide" : "Show"} raw extracted text (verify header/footer exclusion)
                </button>
                {showRawText && (
                  <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-slate-50 p-3 text-xs text-[var(--muted)]">
                    {page.rawText || "(no text extracted)"}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SectionCard({ section }: { section: SectionOptimization }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-[var(--border)]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2 overflow-hidden">
          {section.isNew && <Badge tone="green">New section</Badge>}
          {section.rewriteFailed && <Badge tone="red">No rewrite returned</Badge>}
          <span className="truncate text-sm font-medium text-[var(--foreground)]">{section.heading}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-[var(--muted)]">
          <span>Citability {section.citabilityBefore}→{section.citabilityAfter}</span>
          <span>{expanded ? "−" : "+"}</span>
        </div>
      </button>
      {expanded && (
        <div className="space-y-4 border-t border-[var(--border)] px-4 py-4">
          {section.relevanceImpact && <p className="text-sm text-[var(--muted)]">{section.relevanceImpact}</p>}
          {section.entitiesAssigned.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Entities incorporated</p>
              <div className="flex flex-wrap gap-1.5">
                {section.entitiesAssigned.map((e, i) => (
                  <Badge key={i} tone="purple">{e}</Badge>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {!section.isNew && (
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Current</p>
                <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                  {section.currentText || "(empty)"}
                </p>
              </div>
            )}
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                {section.isNew ? "Proposed new section" : "Suggested rewrite"}
              </p>
              <p className="whitespace-pre-wrap rounded-lg bg-[var(--green-soft)] p-3 text-sm text-emerald-800">
                {section.suggestedText}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Tab: Entity Analysis                                                     */
/* ---------------------------------------------------------------------- */

function EntityAnalysisTab() {
  const { run } = useSSE();

  const [topic, setTopic] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [urls, setUrls] = useState("");

  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScrapeResult | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const urlCount = urls.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).length;

  async function handleAnalyze(e: React.FormEvent) {
    e.preventDefault();
    if (!targetUrl.trim() || urlCount === 0 || running) return;

    setRunning(true);
    setSteps([]);
    setResult(null);
    setError("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = (await run(
        "/api/scrape",
        { targetUrl: targetUrl.trim(), urls: urls.trim(), searchTerm: topic.trim() },
        (step) => setSteps((s) => [...s, step]),
        controller.signal
      )) as ScrapeResult;
      setResult(data);
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    setRunning(false);
    setSteps((s) => [...s, "Stopped by user."]);
  }

  function handleExport() {
    if (!result) return;

    const sheets: { name: string; rows: (string | number)[][] }[] = [];

    sheets.push({
      name: "Pages Overview",
      rows: [
        ["URL", "Role", "Word Count", "Entity Count", "Topical Coverage %"],
        [result.target.url, "Target", result.target.wordCount, result.target.entityCount, result.target.topicalCoverageScore],
        ...result.competitors.map((c) => [c.url, "Competitor", c.wordCount, c.entityCount, c.topicalCoverageScore]),
      ],
    });

    sheets.push({
      name: "Top Keywords",
      rows: [
        ["Term", "Type", "Competitors Mentioning", "Avg Salience", "In Target"],
        ...result.topKeywords.map((k) => [k.term, k.type, k.appearsInCompetitors, k.avgSalience.toFixed(3), k.presentInTarget ? "Yes" : "No"]),
      ],
    });

    // Entity Matrix -- merges case-variant spellings of the same entity
    // into one row, same de-duplication approach as the original combined
    // page, so "Car Accident Lawyer" and "car accident lawyer" don't show
    // as two separate (and contradictory) rows.
    const allPages = [
      { url: result.target.url, label: "TARGET: " + result.target.url, entities: result.target.entities },
      ...result.competitors.map((c) => ({ url: c.url, label: c.url, entities: c.entities })),
    ];
    const normalizedGroups = new Map<string, { displayCounts: Map<string, number>; type: string; perPageSalience: Map<string, number> }>();
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
        if (e.salience > existingSalience) group.perPageSalience.set(page.url, e.salience);
      }
    }
    const sortedKeys = Array.from(normalizedGroups.keys()).sort();
    const matrixRows: (string | number)[][] = [["Entity", "Type", ...allPages.map((p) => p.label)]];
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

    sheets.push({
      name: "Information Gain",
      rows: [
        ["Page URL", "Role", "Unique Term", "Mentions"],
        ...result.target.informationGain.map((g) => [result.target.url, "Target", g.term, g.count]),
        ...result.competitors.flatMap((c) => c.informationGain.map((g) => [c.url, "Competitor", g.term, g.count])),
      ],
    });

    if (result.searchTerm && result.termRelevance.length > 0) {
      sheets.push({
        name: "Term Relevance",
        rows: [
          ["URL", "Role", "Relevance to Search Term %", "Best Matching Passage"],
          ...result.termRelevance.map((r) => [
            r.url,
            r.url === result.target.url ? "Target" : "Competitor",
            r.overallScore,
            r.topChunks[0]?.text ?? "",
          ]),
        ],
      });
    }

    sheets.push({
      name: "Scrape Report",
      rows: [
        ["URL", "Role", "Status"],
        [result.target.url, "Target", result.target.fetchError ? "Failed: " + result.target.fetchError : "OK"],
        ...result.competitors.map((c) => [c.url, "Competitor", c.fetchError ? "Failed: " + c.fetchError : "OK"]),
      ],
    });

    downloadXlsx(`entity-analysis-${result.target.url.replace(/[^a-z0-9]/gi, "-")}.xlsx`, sheets);
  }

  const infoGainCount = result?.topKeywords.filter((k) => !k.presentInTarget).length ?? 0;

  return (
    <div className="space-y-6">
      <Card title="Entity Analysis" subtitle="Audit content the way Google's NLP API sees it.">
        <form onSubmit={handleAnalyze} className="space-y-4">
          <div>
            <label htmlFor="topic" className="mb-1.5 block text-xs font-medium text-[var(--muted)]">
              Topic / keyword <span className="text-slate-400">(optional, enables term relevance)</span>
            </label>
            <input
              id="topic"
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. car accident lawyer toronto"
              maxLength={200}
              disabled={running}
              className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50"
            />
          </div>

          <div>
            <label htmlFor="targetUrl" className="mb-1.5 block text-xs font-medium text-[var(--muted)]">
              Target URL
            </label>
            <input
              id="targetUrl"
              type="text"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://yoursite.com/your-page"
              disabled={running}
              className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50"
            />
          </div>

          <div>
            <label htmlFor="urls" className="mb-1.5 block text-xs font-medium text-[var(--muted)]">
              Competitor URLs (at least 1, up to 15)
            </label>
            <textarea
              id="urls"
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              placeholder={"https://competitor1.com/page\nhttps://competitor2.com/page"}
              rows={5}
              disabled={running}
              className="w-full resize-y rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-mono text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-[var(--muted)]">
              {urlCount > 0 ? `${urlCount} URL(s) detected.` : "No competitor URLs entered yet."}
            </p>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={running || !targetUrl.trim() || urlCount === 0}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {running ? "Analyzing..." : "Run Entity Analysis"}
            </button>
            {running && (
              <button
                type="button"
                onClick={handleStop}
                className="rounded-lg border border-red-200 bg-[var(--red-soft)] px-4 py-2 text-sm font-medium text-[var(--red)]"
              >
                Stop
              </button>
            )}
          </div>
        </form>

        <StepStatus steps={steps} running={running} />
        {error && <ErrorBox message={error} />}
      </Card>

      {result && (
        <>
          <WarningsBox warnings={result.errors} />

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ScoreCard value={result.competitors.length} tone="blue" label="Competitors analyzed" />
            <ScoreCard value={result.target.wordCount} label="Target word count" />
            <ScoreCard value={result.target.entityCount} tone="purple" label="Target entities" />
            <ScoreCard value={infoGainCount} tone={infoGainCount > 0 ? "gold" : "green"} label="Missing keywords" />
          </div>

          <Card title="Topical Coverage">
            <div className="flex justify-center">
              <ScoreRing score={result.target.topicalCoverageScore} label="of top keywords covered" />
            </div>
          </Card>

          <Card title="Top Keywords" subtitle="Entities competitors emphasize across this term, ranked by prominence.">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--muted)]">
                    <th className="py-2 pr-4">Term</th>
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2 pr-4"># Competitors</th>
                    <th className="py-2 pr-4">Avg Salience</th>
                    <th className="py-2">In Target?</th>
                  </tr>
                </thead>
                <tbody>
                  {result.topKeywords.map((k, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-2 pr-4 font-medium text-[var(--foreground)]">{k.term}</td>
                      <td className="py-2 pr-4 text-[var(--muted)]">{k.type}</td>
                      <td className="py-2 pr-4 text-[var(--muted)]">{k.appearsInCompetitors}</td>
                      <td className="py-2 pr-4 text-[var(--muted)]">{k.avgSalience.toFixed(2)}</td>
                      <td className="py-2">{k.presentInTarget ? <Badge tone="green">Covered</Badge> : <Badge tone="red">Missing</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {result.searchTerm && (
            <Card title="Term Relevance" subtitle={`How relevant each page is to "${result.searchTerm}" — directly, not vs. competitors.`}>
              {result.termRelevanceError ? (
                <p className="text-sm text-[var(--red)]">{result.termRelevanceError}</p>
              ) : (
                <div className="space-y-3">
                  {[...result.termRelevance].sort((a, b) => b.overallScore - a.overallScore).map((tr, i) => (
                    <div key={i} className="flex items-center gap-4">
                      <span className="w-12 text-right text-sm font-medium text-[var(--foreground)]">{tr.overallScore}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${tr.overallScore}%` }} />
                      </div>
                      <span className="w-64 truncate text-sm text-[var(--muted)]">{tr.url}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          <Card title="Page by Page">
            <div className="space-y-2">
              <PageDetail page={result.target} isTarget />
              {result.competitors.map((c, i) => <PageDetail key={i} page={c} isTarget={false} />)}
            </div>
          </Card>

          <button
            onClick={handleExport}
            className="w-full rounded-lg border border-[var(--border)] bg-white py-2.5 text-sm font-medium text-[var(--foreground)] transition hover:bg-slate-50"
          >
            Export full report (.xlsx)
          </button>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Tab: Optimization                                                        */
/* ---------------------------------------------------------------------- */

function OptimizationTab() {
  const { run } = useSSE();

  const [targetUrl, setTargetUrl] = useState("");
  const [urls, setUrls] = useState("");

  const [scrapeRunning, setScrapeRunning] = useState(false);
  const [scrapeSteps, setScrapeSteps] = useState<string[]>([]);
  const [scrapeError, setScrapeError] = useState("");
  const [scrapeResult, setScrapeResult] = useState<ScrapeResult | null>(null);

  const [optimizeRunning, setOptimizeRunning] = useState(false);
  const [optimizeSteps, setOptimizeSteps] = useState<string[]>([]);
  const [optimizeError, setOptimizeError] = useState("");
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResult | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const urlCount = urls.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).length;

  async function handleScrape(e: React.FormEvent) {
    e.preventDefault();
    if (!targetUrl.trim() || urlCount === 0 || scrapeRunning) return;

    setScrapeRunning(true);
    setScrapeSteps([]);
    setScrapeResult(null);
    setScrapeError("");
    setOptimizeResult(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = (await run(
        "/api/scrape",
        { targetUrl: targetUrl.trim(), urls: urls.trim(), searchTerm: "" },
        (step) => setScrapeSteps((s) => [...s, step]),
        controller.signal
      )) as ScrapeResult;
      setScrapeResult(data);
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") setScrapeError(err.message);
    } finally {
      setScrapeRunning(false);
    }
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
      const data = (await run(
        "/api/optimize",
        { cache: scrapeResult._cache },
        (step) => setOptimizeSteps((s) => [...s, step]),
        controller.signal
      )) as OptimizeResult;
      setOptimizeResult(data);
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") setOptimizeError(err.message);
    } finally {
      setOptimizeRunning(false);
    }
  }

  function handleExport() {
    if (!scrapeResult || !optimizeResult) return;

    function findPlacement(entityName: string): string {
      for (const section of optimizeResult!.optimization.sections) {
        if (section.entitiesAssigned.some((e) => e.toLowerCase() === entityName.toLowerCase())) {
          return section.isNew ? `${section.heading} (new)` : section.heading;
        }
      }
      return "Unassigned";
    }

    const sheets: { name: string; rows: (string | number)[][] }[] = [];

    sheets.push({
      name: "Missing Entities",
      rows: [
        ["Entity", "Type", "Competitors Mentioning", "Avg Salience", "Suggested Placement"],
        ...optimizeResult.gapReport.missingEntities.map((e) => [
          e.name, e.type, e.appearsInCompetitors, e.avgSalienceInCompetitors.toFixed(3), findPlacement(e.name),
        ]),
      ],
    });

    sheets.push({
      name: "Uncovered Passages",
      rows: [
        ["Competitor URL", "Match Score", "Passage"],
        ...optimizeResult.gapReport.semanticCoverage.uncoveredPassages.map((p) => [
          p.competitorUrl, p.bestMatchScore.toFixed(3), p.competitorChunk,
        ]),
      ],
    });

    const optRows: (string | number)[][] = [
      ["Section", "New Section?", "Rewrite Status", "Citability Before", "Citability After", "Entities Assigned", "Current Text", "Suggested Text", "Relevance Impact"],
      ...optimizeResult.optimization.sections.map((s) => [
        s.heading,
        s.isNew ? "Yes" : "No",
        s.rewriteFailed ? "FAILED -- no rewrite returned, original text shown" : "OK",
        s.citabilityBefore,
        s.citabilityAfter,
        s.entitiesAssigned.join(", "),
        s.currentText,
        s.suggestedText,
        s.relevanceImpact,
      ]),
    ];
    optRows.push([]);
    optRows.push([
      "Overall semantic coverage", "", "",
      optimizeResult.optimization.overallCurrentScore,
      optimizeResult.optimization.overallProjectedScore ?? "N/A",
      "", "", "", "",
    ]);
    sheets.push({ name: "Optimization Plan", rows: optRows });

    downloadXlsx(`optimization-${scrapeResult.target.url.replace(/[^a-z0-9]/gi, "-")}.xlsx`, sheets);
  }

  return (
    <div className="space-y-6">
      <Card title="Optimization" subtitle="Section-grounded rewrite suggestions with a recomputed, not invented, impact score.">
        <form onSubmit={handleScrape} className="space-y-4">
          <div>
            <label htmlFor="opt-targetUrl" className="mb-1.5 block text-xs font-medium text-[var(--muted)]">
              Target URL
            </label>
            <input
              id="opt-targetUrl"
              type="text"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://yoursite.com/your-page"
              disabled={scrapeRunning}
              className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50"
            />
          </div>

          <div>
            <label htmlFor="opt-urls" className="mb-1.5 block text-xs font-medium text-[var(--muted)]">
              Competitor URLs (at least 1, up to 15)
            </label>
            <textarea
              id="opt-urls"
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              placeholder={"https://competitor1.com/page\nhttps://competitor2.com/page"}
              rows={5}
              disabled={scrapeRunning}
              className="w-full resize-y rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-mono text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-[var(--muted)]">
              {urlCount > 0 ? `${urlCount} URL(s) detected.` : "No competitor URLs entered yet."}
            </p>
          </div>

          <button
            type="submit"
            disabled={scrapeRunning || !targetUrl.trim() || urlCount === 0}
            className="w-full rounded-lg bg-[var(--accent)] py-2.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {scrapeRunning ? "Scraping..." : "Step 1: Scrape & Summarize"}
          </button>
        </form>

        <StepStatus steps={scrapeSteps} running={scrapeRunning} />
        {scrapeError && <ErrorBox message={scrapeError} />}
      </Card>

      {scrapeResult && (
        <>
          <Card title="Pages Fetched">
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between rounded-lg border border-[var(--border)] px-4 py-2">
                <span className="flex items-center gap-2">
                  <Badge tone="blue">Target</Badge>
                  <span className="font-medium text-[var(--foreground)]">{scrapeResult.target.title || scrapeResult.target.url}</span>
                </span>
                <span className="text-[var(--muted)]">{scrapeResult.target.wordCount} words · {scrapeResult.target.entityCount} entities</span>
              </div>
              {scrapeResult.competitors.map((c, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg border border-slate-100 px-4 py-2">
                  <span className="truncate font-medium text-[var(--foreground)]">{c.title || c.url}</span>
                  <span className="shrink-0 text-[var(--muted)]">
                    {c.fetchError ? <span className="text-[var(--red)]">{c.fetchError}</span> : `${c.wordCount} words · ${c.entityCount} entities`}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <button
            onClick={handleOptimize}
            disabled={optimizeRunning}
            className="w-full rounded-lg bg-[var(--accent)] py-2.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {optimizeRunning ? "Optimizing..." : optimizeResult ? "↻ Regenerate optimization" : "Step 2: Run gap analysis + rewrite suggestions"}
          </button>

          <StepStatus steps={optimizeSteps} running={optimizeRunning} />
          {optimizeError && <ErrorBox message={optimizeError} />}
        </>
      )}

      {optimizeResult && (
        <>
          <Card title="Impact Score" subtitle="Strong-match % is a coarse threshold; average similarity shows partial progress the threshold can miss.">
            <div className="flex flex-col gap-4 sm:flex-row">
              <ScoreCompare label="Strong-match coverage" before={optimizeResult.optimization.overallCurrentScore} after={optimizeResult.optimization.overallProjectedScore} />
              <ScoreCompare label="Average similarity" before={optimizeResult.optimization.overallCurrentSimilarity} after={optimizeResult.optimization.overallProjectedSimilarity} />
            </div>
            {optimizeResult.optimization.projectedScoreUnavailableReason && (
              <p className="mt-3 text-sm text-[var(--gold)]">
                Projected score unavailable: {optimizeResult.optimization.projectedScoreUnavailableReason}
              </p>
            )}
          </Card>

          <Card
            title="Gap Report"
            subtitle={`${optimizeResult.gapReport.missingEntities.length} missing entities · ${optimizeResult.gapReport.semanticCoverage.uncoveredPassages.length} uncovered passages`}
          >
            <div className="space-y-4">
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                  Missing entities (top {Math.min(20, optimizeResult.gapReport.missingEntities.length)})
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {optimizeResult.gapReport.missingEntities.slice(0, 20).map((e, i) => (
                    <Badge key={i} tone="red"><span title={`appears in ${e.appearsInCompetitors} competitor page(s)`}>{e.name}</span></Badge>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                  Uncovered passages (top {Math.min(5, optimizeResult.gapReport.semanticCoverage.uncoveredPassages.length)})
                </p>
                <div className="space-y-2">
                  {optimizeResult.gapReport.semanticCoverage.uncoveredPassages.slice(0, 5).map((p, i) => (
                    <p key={i} className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{p.competitorChunk}</p>
                  ))}
                </div>
              </div>
            </div>
          </Card>

          <Card
            title="Section-by-Section Optimization"
            subtitle={`${optimizeResult.optimization.sections.length} sections proposed across ${optimizeResult.optimization.sectionsFound} real page sections found.`}
          >
            <div className="space-y-2">
              {optimizeResult.optimization.sections.map((s, i) => <SectionCard key={i} section={s} />)}
              {optimizeResult.optimization.sections.length === 0 && (
                <p className="text-sm text-[var(--muted)]">No optimization needed — no gaps found.</p>
              )}
            </div>
          </Card>

          <button
            onClick={handleExport}
            className="w-full rounded-lg border border-[var(--border)] bg-white py-2.5 text-sm font-medium text-[var(--foreground)] transition hover:bg-slate-50"
          >
            Export optimization plan (.xlsx)
          </button>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Tab: Entity Analyzer (text-based, full NLP suite)                      */
/* ---------------------------------------------------------------------- */

type AnalyzedEntity = {
  name: string;
  type: string;
  salience: number;
  mentions: number;
  sentimentScore: number | null;
  wikipediaUrl?: string;
};

type EntityAnalyzerResult = {
  entities: AnalyzedEntity[];
  documentSentiment: {
    score: number;
    magnitude: number;
    label: string;
  };
  categories: { name: string; confidence: number }[];
  aiBreakdown: string;
  wordCount: number;
  entityCount: number;
};

function entityTypeTone(type: string): "blue" | "purple" | "green" | "gold" | "red" | "slate" {
  switch (type) {
    case "PERSON": return "purple";
    case "ORGANIZATION": return "blue";
    case "LOCATION": return "green";
    case "EVENT": return "gold";
    case "WORK_OF_ART": return "red";
    default: return "slate";
  }
}

function SentimentBar({ score }: { score: number }) {
  const pct = Math.round(((score + 1) / 2) * 100);
  const color = score >= 0.1 ? "var(--green)" : score <= -0.1 ? "var(--red)" : "#94a3b8";
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className="absolute inset-y-0 left-1/2 w-px bg-slate-300" />
      <div
        className="absolute inset-y-0 rounded-full"
        style={{
          left: score < 0 ? `${pct}%` : "50%",
          right: score >= 0 ? `${100 - pct}%` : "50%",
          backgroundColor: color,
        }}
      />
    </div>
  );
}

function EntityAnalyzerTab() {
  const { run } = useSSE();

  const [text, setText] = useState("");
  const [keywords, setKeywords] = useState("");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [result, setResult] = useState<EntityAnalyzerResult | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const wordCount = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  const MAX_WORDS = 10000;

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    const wc = text.trim().split(/\s+/).filter(Boolean).length;
    if (wc < 5 || wc > MAX_WORDS || running) return;

    setRunning(true);
    setSteps([]);
    setResult(null);
    setError("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = (await run(
        "/api/entity-analyzer",
        { text: text.trim(), keywords: keywords.trim() },
        (step) => setSteps((s) => [...s, step]),
        controller.signal
      )) as EntityAnalyzerResult;
      setResult(data);
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    setRunning(false);
    setSteps((s) => [...s, "Stopped by user."]);
  }

  const sentimentColor =
    result
      ? result.documentSentiment.score >= 0.1
        ? "green"
        : result.documentSentiment.score <= -0.1
        ? "red"
        : "slate"
      : "slate";

  return (
    <div className="space-y-6">
      <Card title="Text to analyse" subtitle="Audit content the way Google's NLP API sees it.">
        <form onSubmit={handleRun} className="space-y-4">
          <div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste your article, landing page copy, or any content here…"
              rows={8}
              disabled={running}
              className="w-full resize-y rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50"
            />
            <div className="mt-1 flex items-center justify-between">
              <p className="text-xs text-[var(--accent)]">
                Up to 10,000 words (any language). Google&apos;s classifier requires at least 20 words.
              </p>
              <p className={`text-xs font-medium tabular-nums ${wordCount > MAX_WORDS ? "text-[var(--red)]" : "text-[var(--muted)]"}`}>
                {wordCount.toLocaleString()} / {MAX_WORDS.toLocaleString()} words
              </p>
            </div>
          </div>

          <div>
            <label htmlFor="ea-keywords" className="mb-1.5 block text-sm font-semibold text-[var(--foreground)]">
              Target keywords <span className="font-normal text-[var(--muted)]">(optional)</span>
            </label>
            <input
              id="ea-keywords"
              type="text"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="google nlp, entity analysis, seo tooling"
              disabled={running}
              className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-[var(--muted)]">Used by the AI report to evaluate topical alignment.</p>
          </div>

          <div className="flex items-center justify-between gap-4 pt-1">
            <p className="text-xs text-[var(--muted)]">
              3 free runs across all tools · sign in for more
            </p>
            <div className="flex gap-2">
              {running && (
                <button
                  type="button"
                  onClick={handleStop}
                  className="rounded-lg border border-red-200 bg-[var(--red-soft)] px-4 py-2 text-sm font-medium text-[var(--red)]"
                >
                  Stop
                </button>
              )}
              <button
                type="submit"
                disabled={running || wordCount < 5 || wordCount > MAX_WORDS}
                className="rounded-lg bg-[var(--accent)] px-6 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
              >
                {running ? "Analysing…" : "Run Analysis"}
              </button>
            </div>
          </div>
        </form>

        <StepStatus steps={steps} running={running} />
        {error && <ErrorBox message={error} />}
      </Card>

      {result && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ScoreCard value={result.entityCount} tone="blue" label="Entities found" />
            <ScoreCard value={result.wordCount} label="Words analysed" />
            <ScoreCard
              value={result.documentSentiment.label}
              tone={sentimentColor as "green" | "red" | "slate"}
              label="Document sentiment"
            />
            <ScoreCard
              value={result.categories.length > 0 ? result.categories[0].name.split("/").pop()! : "—"}
              tone="purple"
              label="Top content category"
            />
          </div>

          <Card title="AI Breakdown" subtitle="What the entity profile signals to Google and how to improve it.">
            <div className="space-y-2">
              {result.aiBreakdown
                .split("\n")
                .filter((l) => l.trim())
                .map((line, i) => (
                  <p key={i} className="text-sm leading-relaxed text-[var(--foreground)]">
                    {line}
                  </p>
                ))}
            </div>
          </Card>

          <Card title="Entities" subtitle={`${result.entityCount} entities ranked by salience (how central each is to the text)`}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--muted)]">
                    <th className="py-2 pr-3">Entity</th>
                    <th className="py-2 pr-3">Type</th>
                    <th className="py-2 pr-3 w-32">Salience</th>
                    <th className="py-2 pr-3">Mentions</th>
                    <th className="py-2">Sentiment</th>
                  </tr>
                </thead>
                <tbody>
                  {result.entities.map((e, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-2 pr-3 font-medium text-[var(--foreground)]">
                        {e.wikipediaUrl ? (
                          <a href={e.wikipediaUrl} target="_blank" rel="noopener noreferrer"
                            className="underline decoration-dotted hover:text-[var(--accent)]">
                            {e.name}
                          </a>
                        ) : e.name}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge tone={entityTypeTone(e.type)}>{e.type}</Badge>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-full rounded-full bg-[var(--accent)]"
                              style={{ width: `${Math.min(100, e.salience * 100)}%` }}
                            />
                          </div>
                          <span className="text-xs tabular-nums text-[var(--muted)]">
                            {e.salience.toFixed(3)}
                          </span>
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-[var(--muted)]">{e.mentions}</td>
                      <td className="py-2">
                        {e.sentimentScore !== null ? (
                          <span
                            className={`text-xs font-medium ${
                              e.sentimentScore >= 0.15
                                ? "text-[var(--green)]"
                                : e.sentimentScore <= -0.15
                                ? "text-[var(--red)]"
                                : "text-[var(--muted)]"
                            }`}
                          >
                            {e.sentimentScore >= 0.15
                              ? "+"
                              : e.sentimentScore <= -0.15
                              ? "−"
                              : ""}
                            {e.sentimentScore.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2">
            <Card title="Document Sentiment">
              <div className="space-y-4">
                <SentimentBar score={result.documentSentiment.score} />
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-xl font-bold text-[var(--foreground)]">
                      {result.documentSentiment.score >= 0 ? "+" : ""}
                      {result.documentSentiment.score.toFixed(2)}
                    </p>
                    <p className="text-xs text-[var(--muted)]">Score (−1 to +1)</p>
                  </div>
                  <div>
                    <p className="text-xl font-bold text-[var(--foreground)]">
                      {result.documentSentiment.magnitude.toFixed(2)}
                    </p>
                    <p className="text-xs text-[var(--muted)]">Magnitude</p>
                  </div>
                  <div>
                    <p className="text-base font-semibold text-[var(--foreground)]">
                      {result.documentSentiment.label}
                    </p>
                    <p className="text-xs text-[var(--muted)]">Overall tone</p>
                  </div>
                </div>
              </div>
            </Card>

            {result.categories.length > 0 && (
              <Card title="Content Categories">
                <div className="space-y-3">
                  {result.categories.map((c, i) => (
                    <div key={i}>
                      <div className="mb-1 flex items-center justify-between">
                        <p className="text-xs text-[var(--foreground)] leading-snug">{c.name}</p>
                        <span className="ml-2 shrink-0 text-xs font-medium text-[var(--muted)]">
                          {c.confidence}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-[var(--accent)]"
                          style={{ width: `${c.confidence}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Tab: AI Fan-Out                                                         */
/* ---------------------------------------------------------------------- */

type QueryIntent =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational"
  | "question"
  | "comparison"
  | "local";

type FanOutQuery = { query: string; type: string };
type FanOutCategory = { name: string; intent: QueryIntent; queries: FanOutQuery[] };
type FanOutResult = {
  seed: string;
  categories: FanOutCategory[];
  totalQueries: number;
  entities: string[];
  generatedAt: string;
};

const INTENT_COLORS: Record<QueryIntent, string> = {
  informational: "#3b82f6",
  commercial: "#8b5cf6",
  transactional: "#10b981",
  navigational: "#64748b",
  question: "#f59e0b",
  comparison: "#f97316",
  local: "#ec4899",
};

const INTENT_TONES: Record<QueryIntent, "blue" | "purple" | "green" | "slate" | "gold" | "red"> = {
  informational: "blue",
  commercial: "purple",
  transactional: "green",
  navigational: "slate",
  question: "gold",
  comparison: "gold",
  local: "red",
};

const HISTORY_KEY = "relengine_fanout_history";
const MAX_HISTORY = 10;

function loadHistory(): FanOutResult[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveToHistory(result: FanOutResult) {
  const existing = loadHistory().filter((r) => r.seed !== result.seed);
  const updated = [result, ...existing].slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
}

function MindMap({
  seed,
  categories,
  selected,
  onSelect,
}: {
  seed: string;
  categories: FanOutCategory[];
  selected: number | null;
  onSelect: (i: number) => void;
}) {
  const cx = 260;
  const cy = 200;
  const radius = 145;
  const n = categories.length;

  return (
    <svg viewBox="0 0 520 400" className="w-full max-w-xl mx-auto select-none">
      {categories.map((cat, i) => {
        const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
        const x = cx + radius * Math.cos(angle);
        const y = cy + radius * Math.sin(angle);
        const color = INTENT_COLORS[cat.intent] ?? "#64748b";
        const isSelected = selected === i;
        const words = cat.name.split(" ");

        return (
          <g key={i} style={{ cursor: "pointer" }} onClick={() => onSelect(i)}>
            <line
              x1={cx} y1={cy} x2={x} y2={y}
              stroke={color}
              strokeWidth={isSelected ? 2.5 : 1.5}
              strokeOpacity={isSelected ? 0.9 : 0.35}
            />
            <circle
              cx={x} cy={y} r={isSelected ? 30 : 26}
              fill={isSelected ? color : "white"}
              stroke={color}
              strokeWidth={2}
              style={{ filter: isSelected ? "drop-shadow(0 2px 6px rgba(0,0,0,0.2))" : undefined }}
            />
            {words.length === 1 ? (
              <text x={x} y={y} textAnchor="middle" dominantBaseline="middle"
                fontSize={9} fontWeight={isSelected ? "600" : "500"}
                fill={isSelected ? "white" : color}>
                {cat.name}
              </text>
            ) : (
              <text x={x} y={y - 5} textAnchor="middle"
                fontSize={9} fontWeight={isSelected ? "600" : "500"}
                fill={isSelected ? "white" : color}>
                {words.slice(0, Math.ceil(words.length / 2)).join(" ")}
                <tspan x={x} dy="12">{words.slice(Math.ceil(words.length / 2)).join(" ")}</tspan>
              </text>
            )}
            <text x={x} y={isSelected ? y + 20 : y + 16} textAnchor="middle"
              fontSize={8} fill={isSelected ? "rgba(255,255,255,0.8)" : "#94a3b8"}>
              {cat.queries.length}
            </text>
          </g>
        );
      })}

      {/* Center node */}
      <circle cx={cx} cy={cy} r={44} fill="var(--accent)"
        style={{ filter: "drop-shadow(0 2px 8px rgba(59,130,246,0.35))" }} />
      <text x={cx} y={cy - 7} textAnchor="middle" fontSize={10} fontWeight="700" fill="white">
        {seed.length > 16 ? seed.slice(0, 14) + "…" : seed}
      </text>
      <text x={cx} y={cy + 8} textAnchor="middle" fontSize={8} fill="rgba(255,255,255,0.65)">
        seed keyword
      </text>
    </svg>
  );
}

function FanOutTab() {
  const { run } = useSSE();

  const [keyword, setKeyword] = useState("");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [result, setResult] = useState<FanOutResult | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [history, setHistory] = useState<FanOutResult[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    if (!keyword.trim() || running) return;

    setRunning(true);
    setSteps([]);
    setResult(null);
    setError("");
    setSelected(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = (await run(
        "/api/fan-out",
        { keyword: keyword.trim() },
        (step) => setSteps((s) => [...s, step]),
        controller.signal
      )) as FanOutResult;
      setResult(data);
      setSelected(0);
      saveToHistory(data);
      setHistory(loadHistory());
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    setRunning(false);
    setSteps((s) => [...s, "Stopped by user."]);
  }

  function handleLoadHistory(run: FanOutResult) {
    setResult(run);
    setSelected(0);
    setKeyword(run.seed);
    setSteps([]);
    setError("");
    setShowHistory(false);
  }

  function handleExportCsv() {
    if (!result) return;
    const rows: (string | number)[][] = [["Category", "Intent", "Type", "Query"]];
    for (const cat of result.categories) {
      for (const q of cat.queries) {
        rows.push([cat.name, cat.intent, q.type, q.query]);
      }
    }
    downloadCsv(`fan-out-${result.seed.replace(/[^a-z0-9]/gi, "-")}.csv`, rows);
  }

  const activeCat = selected !== null ? result?.categories[selected] : null;

  return (
    <div className="space-y-6">
      <Card title="AI Fan-Out" subtitle="Turn one seed keyword into a full SEO query architecture.">
        <form onSubmit={handleRun} className="space-y-4">
          <div>
            <label htmlFor="fo-keyword" className="mb-1.5 block text-xs font-medium text-[var(--muted)]">
              Seed keyword
            </label>
            <input
              id="fo-keyword"
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="e.g. best running shoes"
              maxLength={200}
              disabled={running}
              className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={running || !keyword.trim()}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {running ? "Generating…" : "Generate Query Architecture"}
            </button>
            {running && (
              <button
                type="button"
                onClick={handleStop}
                className="rounded-lg border border-red-200 bg-[var(--red-soft)] px-4 py-2 text-sm font-medium text-[var(--red)]"
              >
                Stop
              </button>
            )}
            {history.length > 0 && (
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                className="ml-auto rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                History ({history.length})
              </button>
            )}
          </div>
        </form>

        <StepStatus steps={steps} running={running} />
        {error && <ErrorBox message={error} />}
      </Card>

      {showHistory && history.length > 0 && (
        <Card title="Historic Runs">
          <div className="space-y-2">
            {history.map((h, i) => (
              <button
                key={i}
                onClick={() => handleLoadHistory(h)}
                className="flex w-full items-center justify-between rounded-lg border border-[var(--border)] px-4 py-3 text-left hover:bg-slate-50"
              >
                <div>
                  <p className="text-sm font-medium text-[var(--foreground)]">{h.seed}</p>
                  <p className="text-xs text-[var(--muted)]">
                    {h.totalQueries} queries · {h.categories.length} categories
                  </p>
                </div>
                <span className="shrink-0 text-xs text-[var(--muted)]">
                  {new Date(h.generatedAt).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {result && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <ScoreCard value={result.totalQueries} tone="blue" label="Total queries" />
            <ScoreCard value={result.categories.length} tone="purple" label="Intent categories" />
            <ScoreCard value={result.entities.length} tone="green" label="Key entities" />
          </div>

          {result.entities.length > 0 && (
            <Card title="Key Entities">
              <div className="flex flex-wrap gap-1.5">
                {result.entities.map((e, i) => (
                  <Badge key={i} tone="purple">{e}</Badge>
                ))}
              </div>
            </Card>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Query Mind Map" subtitle="Click a category to explore its queries.">
              <MindMap
                seed={result.seed}
                categories={result.categories}
                selected={selected}
                onSelect={setSelected}
              />
              <div className="mt-3 flex flex-wrap justify-center gap-3">
                {result.categories.map((cat, i) => (
                  <button
                    key={i}
                    onClick={() => setSelected(i)}
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                      selected === i
                        ? "bg-[var(--accent)] text-white"
                        : "border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: INTENT_COLORS[cat.intent] }}
                    />
                    {cat.name}
                    <span className="opacity-60">({cat.queries.length})</span>
                  </button>
                ))}
              </div>
            </Card>

            <Card
              title={activeCat ? activeCat.name : "Select a category"}
              subtitle={activeCat ? `${activeCat.queries.length} queries · intent: ${activeCat.intent}` : undefined}
            >
              {activeCat ? (
                <div className="max-h-96 overflow-y-auto space-y-1 pr-1">
                  {activeCat.queries.map((q, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 rounded-lg px-3 py-2 hover:bg-slate-50"
                    >
                      <Badge tone={INTENT_TONES[activeCat.intent]}>{q.type}</Badge>
                      <span className="text-sm text-[var(--foreground)]">{q.query}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[var(--muted)]">Click a node on the mind map or a category pill above.</p>
              )}
            </Card>
          </div>

          <Card title="All Queries by Category">
            <div className="space-y-4">
              {result.categories.map((cat, i) => (
                <div key={i}>
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className="inline-block h-3 w-3 rounded-full"
                      style={{ backgroundColor: INTENT_COLORS[cat.intent] }}
                    />
                    <p className="text-sm font-semibold text-[var(--foreground)]">{cat.name}</p>
                    <span className="text-xs text-[var(--muted)]">({cat.queries.length})</span>
                  </div>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {cat.queries.map((q, j) => (
                      <p key={j} className="truncate rounded px-2 py-1 text-sm text-[var(--foreground)] hover:bg-slate-50" title={q.query}>
                        {q.query}
                      </p>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <button
            onClick={handleExportCsv}
            className="w-full rounded-lg border border-[var(--border)] bg-white py-2.5 text-sm font-medium text-[var(--foreground)] transition hover:bg-slate-50"
          >
            Export full query set (.csv)
          </button>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Top-level: tab bar + header                                             */
/* ---------------------------------------------------------------------- */

type Tab = "entityanalyzer" | "fanout" | "entity" | "optimize";

const TOOLKIT_TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  {
    id: "entityanalyzer",
    label: "Entity Analysis",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="9" /><line x1="12" y1="3" x2="12" y2="9" /><line x1="12" y1="15" x2="12" y2="21" /><line x1="3" y1="12" x2="9" y2="12" /><line x1="15" y1="12" x2="21" y2="12" />
      </svg>
    ),
  },
  {
    id: "fanout",
    label: "AI Fan-Out",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
      </svg>
    ),
  },
  {
    id: "entity",
    label: "URL Audit",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    ),
  },
  {
    id: "optimize",
    label: "Optimization",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
];

export default function Home() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>("entityanalyzer");

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <header className="border-b border-[var(--border)] bg-[var(--card)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-sm font-bold text-[var(--accent)]">
              R
            </span>
            <div>
              <p className="text-sm font-semibold leading-tight text-[var(--foreground)]">Relevance Engineering</p>
              <p className="text-[10px] uppercase tracking-wide leading-tight text-[var(--muted)]">Semantic Audit Toolkit</p>
            </div>
          </div>
          <button onClick={handleLogout} className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
            Sign out
          </button>
        </div>

        <nav className="mx-auto max-w-5xl border-t border-[var(--border)] px-6 py-3">
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.15em] text-[var(--muted)] pr-1">
              Toolkit
            </span>
            {TOOLKIT_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                  activeTab === tab.id
                    ? "bg-[var(--accent)] text-white shadow-sm"
                    : "border border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        {activeTab === "entityanalyzer" && <EntityAnalyzerTab />}
        {activeTab === "fanout" && <FanOutTab />}
        {activeTab === "entity" && <EntityAnalysisTab />}
        {activeTab === "optimize" && <OptimizationTab />}
      </main>
    </div>
  );
}
