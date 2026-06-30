"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { downloadXlsx } from "@/lib/xlsx-export";
import { downloadCsv } from "@/lib/csv-export";

/* ---------------------------------------------------------------------- */
/* History                                                                  */
/* ---------------------------------------------------------------------- */

type HistoryTool = "entity-analyzer" | "eeat" | "page-relevance" | "fan-out" | "scrape" | "optimize";

type HistoryEntry = {
  id: string;
  tool: HistoryTool;
  label: string;
  summary: string;
  ts: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
};

const HISTORY_STORAGE_KEY = "relengine_history_v1";
const MAX_HISTORY_ENTRIES = 200;

function loadAllHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function pushHistory(entry: Omit<HistoryEntry, "id" | "ts">): void {
  if (typeof window === "undefined") return;
  const all = loadAllHistory();
  const newEntry: HistoryEntry = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, ts: Date.now() };
  const updated = [newEntry, ...all].slice(0, MAX_HISTORY_ENTRIES);
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(updated));
}

const TOOL_LABELS: Record<HistoryTool, string> = {
  "entity-analyzer": "Entity Analysis",
  "eeat": "E-E-A-T Score",
  "page-relevance": "Page Relevance",
  "fan-out": "AI Fan-Out",
  "scrape": "URL Scrape",
  "optimize": "Optimization",
};

const TOOL_TONE: Record<HistoryTool, "blue" | "green" | "red" | "gold"> = {
  "entity-analyzer": "blue",
  "eeat": "gold",
  "page-relevance": "green",
  "fan-out": "blue",
  "scrape": "gold",
  "optimize": "green",
};

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
      pushHistory({ tool: "scrape", label: targetUrl.trim(), summary: `${data.competitors.length + 1} pages · ${data.target.wordCount} target words`, payload: data });
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

type ContentInput = { label: string; text: string };

function ContentPasteArea({
  id, label, placeholder, value, onChange, disabled,
}: { id: string; label: string; placeholder: string; value: ContentInput; onChange: (v: ContentInput) => void; disabled: boolean }) {
  const wc = value.text.trim().split(/\s+/).filter(Boolean).length;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <input id={`${id}-label`} type="text" placeholder="Label / page name (optional)"
        value={value.label} onChange={(e) => onChange({ ...value, label: e.target.value })}
        disabled={disabled}
        className="w-full rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] outline-none focus:border-[var(--accent)] disabled:opacity-50" />
      <textarea id={`${id}-text`} rows={6} placeholder={placeholder}
        value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })}
        disabled={disabled}
        className="w-full resize-y rounded-lg border border-[var(--border)] bg-slate-50 px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50" />
      <p className="text-xs text-[var(--muted)] tabular-nums">{wc.toLocaleString()} words</p>
    </div>
  );
}

function OptimizationTab() {
  const { run } = useSSE();

  const [target, setTarget] = useState<ContentInput>({ label: "Target Page", text: "" });
  const [comp1, setComp1] = useState<ContentInput>({ label: "Competitor 1", text: "" });
  const [comp2, setComp2] = useState<ContentInput>({ label: "Competitor 2", text: "" });
  const [comp3, setComp3] = useState<ContentInput>({ label: "Competitor 3", text: "" });

  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResult | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const competitors = [comp1, comp2, comp3].filter((c) => c.text.trim().split(/\s+/).filter(Boolean).length >= 50);
  const targetWc = target.text.trim().split(/\s+/).filter(Boolean).length;
  const canRun = targetWc >= 50 && competitors.length >= 1;

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    if (!canRun || running) return;

    setRunning(true);
    setSteps([]);
    setOptimizeResult(null);
    setError("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = (await run(
        "/api/optimize-paste",
        { target, competitors: [comp1, comp2, comp3].filter((c) => c.text.trim().length > 0) },
        (step) => setSteps((s) => [...s, step]),
        controller.signal
      )) as OptimizeResult;
      setOptimizeResult(data);
      pushHistory({ tool: "optimize", label: target.label || "Optimization", summary: `${data.gapReport.missingEntities.length} missing entities · ${data.optimization.sections.length} sections`, payload: data });
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
    if (!optimizeResult) return;

    function findPlacement(entityName: string): string {
      for (const section of optimizeResult!.optimization.sections) {
        if (section.entitiesAssigned.some((e) => e.toLowerCase() === entityName.toLowerCase())) {
          return section.isNew ? `${section.heading} (new)` : section.heading;
        }
      }
      return "Unassigned";
    }

    const sheets: { name: string; rows: (string | number)[][] }[] = [];
    sheets.push({ name: "Missing Entities", rows: [
      ["Entity", "Type", "Competitors Mentioning", "Avg Salience", "Suggested Placement"],
      ...optimizeResult.gapReport.missingEntities.map((e) => [e.name, e.type, e.appearsInCompetitors, e.avgSalienceInCompetitors.toFixed(3), findPlacement(e.name)]),
    ]});
    sheets.push({ name: "Uncovered Passages", rows: [
      ["Competitor", "Match Score", "Passage"],
      ...optimizeResult.gapReport.semanticCoverage.uncoveredPassages.map((p) => [p.competitorUrl, p.bestMatchScore.toFixed(3), p.competitorChunk]),
    ]});
    const optRows: (string | number)[][] = [
      ["Section", "New?", "Status", "Citability Before", "Citability After", "Entities", "Current Text", "Suggested Text", "Impact"],
      ...optimizeResult.optimization.sections.map((s) => [s.heading, s.isNew ? "Yes" : "No", s.rewriteFailed ? "FAILED" : "OK", s.citabilityBefore, s.citabilityAfter, s.entitiesAssigned.join("; "), s.currentText, s.suggestedText, s.relevanceImpact]),
    ];
    sheets.push({ name: "Optimization Plan", rows: optRows });
    downloadXlsx(`optimization-${Date.now()}.xlsx`, sheets);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Content Optimizer</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Paste your target page and up to 3 competitors. Google NLP extracts entities, Vertex computes semantic gaps, Gemini writes the rewrite plan.
        </p>
      </div>

      <Card title="Paste content">
        <form onSubmit={handleRun} className="space-y-5">
          <ContentPasteArea id="target" label="Target page" placeholder="Paste your page content here…"
            value={target} onChange={setTarget} disabled={running} />
          <div className="border-t border-[var(--border)] pt-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Competitor content (at least 1, up to 3)</p>
            <div className="space-y-4">
              <ContentPasteArea id="comp1" label="Competitor 1" placeholder="Paste competitor 1 content…" value={comp1} onChange={setComp1} disabled={running} />
              <ContentPasteArea id="comp2" label="Competitor 2 (optional)" placeholder="Paste competitor 2 content…" value={comp2} onChange={setComp2} disabled={running} />
              <ContentPasteArea id="comp3" label="Competitor 3 (optional)" placeholder="Paste competitor 3 content…" value={comp3} onChange={setComp3} disabled={running} />
            </div>
          </div>
          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-[var(--muted)]">
              Target: {targetWc} words · {competitors.length} competitor{competitors.length !== 1 ? "s" : ""} ready
            </p>
            <div className="flex gap-2">
              {running && (
                <button type="button" onClick={handleStop}
                  className="rounded-lg border border-red-200 bg-[var(--red-soft)] px-4 py-2 text-sm font-medium text-[var(--red)]">
                  Stop
                </button>
              )}
              <button type="submit" disabled={!canRun || running}
                className="rounded-lg bg-[var(--accent)] px-6 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50">
                {running ? "Analyzing…" : "Run Gap Analysis"}
              </button>
            </div>
          </div>
        </form>
        <StepStatus steps={steps} running={running} />
        {error && <ErrorBox message={error} />}
      </Card>

      {optimizeResult && (
        <>
          <Card title="Impact Score" subtitle="Strong-match % is a coarse threshold; average similarity shows partial progress the threshold can miss.">
            <div className="flex flex-col gap-4 sm:flex-row">
              <ScoreCompare label="Strong-match coverage" before={optimizeResult.optimization.overallCurrentScore} after={optimizeResult.optimization.overallProjectedScore} />
              <ScoreCompare label="Average similarity" before={optimizeResult.optimization.overallCurrentSimilarity} after={optimizeResult.optimization.overallProjectedSimilarity} />
            </div>
            {optimizeResult.optimization.projectedScoreUnavailableReason && (
              <p className="mt-3 text-sm text-[var(--gold)]">Projected score unavailable: {optimizeResult.optimization.projectedScoreUnavailableReason}</p>
            )}
          </Card>

          <Card title="Gap Report" subtitle={`${optimizeResult.gapReport.missingEntities.length} missing entities · ${optimizeResult.gapReport.semanticCoverage.uncoveredPassages.length} uncovered passages`}>
            <div className="space-y-4">
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Missing entities (top {Math.min(20, optimizeResult.gapReport.missingEntities.length)})</p>
                <div className="flex flex-wrap gap-1.5">
                  {optimizeResult.gapReport.missingEntities.slice(0, 20).map((e, i) => (
                    <Badge key={i} tone="red"><span title={`appears in ${e.appearsInCompetitors} competitor page(s)`}>{e.name}</span></Badge>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Uncovered passages (top {Math.min(5, optimizeResult.gapReport.semanticCoverage.uncoveredPassages.length)})</p>
                <div className="space-y-2">
                  {optimizeResult.gapReport.semanticCoverage.uncoveredPassages.slice(0, 5).map((p, i) => (
                    <p key={i} className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{p.competitorChunk}</p>
                  ))}
                </div>
              </div>
            </div>
          </Card>

          <Card title="Section-by-Section Optimization" subtitle={`${optimizeResult.optimization.sections.length} sections proposed`}>
            <div className="space-y-2">
              {optimizeResult.optimization.sections.map((s, i) => <SectionCard key={i} section={s} />)}
              {optimizeResult.optimization.sections.length === 0 && (
                <p className="text-sm text-[var(--muted)]">No optimization needed — no gaps found.</p>
              )}
            </div>
          </Card>

          <button onClick={handleExport}
            className="w-full rounded-lg border border-[var(--border)] bg-white py-2.5 text-sm font-medium text-[var(--foreground)] transition hover:bg-slate-50">
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
  relatedKeywords: { keyword: string; similarity: number }[];
  keywordError?: string;
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

function EntityTabsModule({ entities }: { entities: AnalyzedEntity[] }) {
  const [activeType, setActiveType] = useState<string>("ALL");
  const types = ["ALL", ...Array.from(new Set(entities.map((e) => e.type))).sort()];
  const filtered = activeType === "ALL" ? entities : entities.filter((e) => e.type === activeType);
  const typeCount = (t: string) => t === "ALL" ? entities.length : entities.filter((e) => e.type === t).length;

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {types.map((t) => (
          <button key={t} onClick={() => setActiveType(t)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              activeType === t ? "bg-[var(--accent)] text-white" : "bg-slate-100 text-[var(--muted)] hover:bg-slate-200 hover:text-[var(--foreground)]"
            }`}>
            {t} <span className="opacity-70">({typeCount(t)})</span>
          </button>
        ))}
      </div>
      <div className="max-h-96 overflow-y-auto rounded border border-[var(--border)]">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-white z-10">
            <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--muted)]">
              <th className="px-3 py-2">Entity</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2 w-32">Salience</th>
              <th className="px-3 py-2">Mentions</th>
              <th className="px-3 py-2">Sentiment</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e, i) => (
              <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2 font-medium text-[var(--foreground)]">
                  {e.wikipediaUrl ? (
                    <a href={e.wikipediaUrl} target="_blank" rel="noopener noreferrer"
                      className="underline decoration-dotted hover:text-[var(--accent)]">{e.name}</a>
                  ) : e.name}
                </td>
                <td className="px-3 py-2"><Badge tone={entityTypeTone(e.type)}>{e.type}</Badge></td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.min(100, e.salience * 100)}%` }} />
                    </div>
                    <span className="text-xs tabular-nums text-[var(--muted)]">{e.salience.toFixed(3)}</span>
                  </div>
                </td>
                <td className="px-3 py-2 text-[var(--muted)]">{e.mentions}</td>
                <td className="px-3 py-2">
                  {e.sentimentScore !== null ? (
                    <span className={`text-xs font-medium ${e.sentimentScore >= 0.15 ? "text-[var(--green)]" : e.sentimentScore <= -0.15 ? "text-[var(--red)]" : "text-[var(--muted)]"}`}>
                      {e.sentimentScore >= 0.15 ? "+" : e.sentimentScore <= -0.15 ? "−" : ""}{e.sentimentScore.toFixed(2)}
                    </span>
                  ) : <span className="text-xs text-slate-300">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
      pushHistory({ tool: "entity-analyzer", label: keywords.trim() || "Entity Analysis", summary: `${data.entityCount} entities · ${data.wordCount} words · ${data.documentSentiment.label}`, payload: data });
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
          {/* Keywords FIRST */}
          {result.keywordError && (
            <Card title="Top 30 Semantic Keywords" subtitle="Keyword generation failed">
              <p className="text-sm text-red-500">{result.keywordError}</p>
              <p className="mt-1 text-xs text-[var(--muted)]">Enter a target keyword in the field above and re-run to generate ranked keywords.</p>
            </Card>
          )}

          {!result.keywordError && result.relatedKeywords.length > 0 && (
            <Card
              title="Top 30 Semantic Keywords"
              subtitle={`Ranked by cosine similarity to "${keywords}" — higher score = closer semantic match`}
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--muted)]">
                      <th className="py-2 pr-3 w-6">#</th>
                      <th className="py-2 pr-4">Keyword</th>
                      <th className="py-2 w-40">Similarity</th>
                      <th className="py-2 w-12 text-right">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.relatedKeywords.map((kw, i) => {
                      const sim = kw.similarity;
                      const barColor = sim >= 75 ? "var(--green)" : sim >= 60 ? "var(--accent)" : "var(--gold)";
                      return (
                        <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                          <td className="py-2 pr-3 text-xs text-[var(--muted)] tabular-nums">{i + 1}</td>
                          <td className="py-2 pr-4 font-medium text-[var(--foreground)]">{kw.keyword}</td>
                          <td className="py-2 pr-4">
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                              <div className="h-full rounded-full transition-all"
                                style={{ width: `${sim}%`, backgroundColor: barColor }} />
                            </div>
                          </td>
                          <td className="py-2 text-right text-xs font-medium tabular-nums" style={{ color: barColor }}>
                            {sim}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

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

          <Card title="Entities" subtitle={`${result.entityCount} entities — browse by type using the tabs below`}>
            <EntityTabsModule entities={result.entities} />
          </Card>

          {/* Export */}
          <button
            onClick={() => {
              const sheets: { name: string; rows: (string | number)[][] }[] = [];
              if (result.relatedKeywords.length > 0) {
                sheets.push({ name: "Semantic Keywords", rows: [
                  ["#", "Keyword", "Similarity Score"],
                  ...result.relatedKeywords.map((kw, i) => [i + 1, kw.keyword, kw.similarity]),
                ]});
              }
              sheets.push({ name: "Entities", rows: [
                ["Entity", "Type", "Salience", "Mentions", "Sentiment", "Wikipedia"],
                ...result.entities.map((e) => [e.name, e.type, e.salience, e.mentions, e.sentimentScore ?? "", e.wikipediaUrl ?? ""]),
              ]});
              sheets.push({ name: "Categories", rows: [
                ["Category", "Confidence %"],
                ...result.categories.map((c) => [c.name, c.confidence]),
              ]});
              sheets.push({ name: "Sentiment", rows: [
                ["Score", "Magnitude", "Label"],
                [result.documentSentiment.score, result.documentSentiment.magnitude, result.documentSentiment.label],
              ]});
              downloadXlsx(`entity-analysis-${keywords.trim().replace(/[^a-z0-9]/gi, "-") || Date.now()}.xlsx`, sheets);
            }}
            className="w-full rounded-lg border border-[var(--border)] bg-white py-2.5 text-sm font-medium text-[var(--foreground)] transition hover:bg-slate-50"
          >
            Export entity analysis (.xlsx)
          </button>

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
/* Tab: E-E-A-T Score Calculator                                          */
/* ---------------------------------------------------------------------- */

type CriterionScore = 0 | 1 | 2;
type CriterionResult = { criterion: string; score: CriterionScore; reason: string };
type DimensionResult = { label: string; criteria: CriterionResult[]; points: number; percent: number };
type EEATResult = { dimensions: DimensionResult[]; overallPercent: number; overallVerdict: string };

const DIMENSION_COLORS: Record<string, "blue" | "purple" | "green" | "gold"> = {
  Experience: "blue",
  Expertise: "purple",
  Authoritativeness: "green",
  Trustworthiness: "gold",
};

const DIMENSION_HEX: Record<string, string> = {
  Experience: "var(--accent)",
  Expertise: "#8b5cf6",
  Authoritativeness: "var(--green)",
  Trustworthiness: "var(--gold)",
};

function scoreTone(pct: number): "green" | "gold" | "red" {
  return pct >= 70 ? "green" : pct >= 40 ? "gold" : "red";
}

function scoreLabel(s: CriterionScore) {
  if (s === 2) return { text: "Strong", tone: "green" as const };
  if (s === 1) return { text: "Partial", tone: "gold" as const };
  return { text: "Not Present", tone: "red" as const };
}

function EEATBarChart({ dimensions }: { dimensions: DimensionResult[] }) {
  const barW = 80;
  const gap = 40;
  const chartH = 200;
  const totalW = dimensions.length * (barW + gap) + gap;

  return (
    <svg viewBox={`0 0 ${totalW} ${chartH + 60}`} className="w-full max-w-lg mx-auto">
      {dimensions.map((d, i) => {
        const x = gap + i * (barW + gap);
        const barH = (d.percent / 100) * chartH;
        const y = chartH - barH;
        const color = DIMENSION_HEX[d.label] ?? "var(--accent)";
        const tone = scoreTone(d.percent);
        const barColor = tone === "green" ? "var(--green)" : tone === "gold" ? "var(--gold)" : "var(--red)";

        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={barH}
              fill={barColor} rx={6} opacity={0.85} />
            <text x={x + barW / 2} y={y - 6}
              textAnchor="middle" fontSize={12} fontWeight="600"
              fill={barColor}>
              {d.percent}%
            </text>
            <text x={x + barW / 2} y={chartH + 20}
              textAnchor="middle" fontSize={11} fill="var(--foreground)">
              {d.label}
            </text>
          </g>
        );
      })}
      {/* baseline */}
      <line x1={0} y1={chartH} x2={totalW} y2={chartH}
        stroke="var(--border)" strokeWidth={1} />
    </svg>
  );
}

function EEATTab() {
  const { run } = useSSE();

  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [author, setAuthor] = useState("");
  const [domain, setDomain] = useState("");

  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [result, setResult] = useState<EEATResult | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const wordCount = content.trim() === "" ? 0 : content.trim().split(/\s+/).length;

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    if (wordCount < 20 || running) return;

    setRunning(true);
    setSteps([]);
    setResult(null);
    setError("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = (await run(
        "/api/eeat-score",
        { content: content.trim(), url: url.trim(), author: author.trim(), domain: domain.trim() },
        (step) => setSteps((s) => [...s, step]),
        controller.signal
      )) as EEATResult;
      setResult(data);
      pushHistory({ tool: "eeat", label: url.trim() || domain.trim() || "E-E-A-T", summary: `${data.overallPercent}% · ${data.overallVerdict.split(".")[0]}`, payload: data });
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

  const overallTone = result ? scoreTone(result.overallPercent) : "slate" as const;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">E-E-A-T Score Calculator</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Paste your content and let Gemini evaluate Experience, Expertise, Authoritativeness, and Trustworthiness across 20 criteria.
        </p>
      </div>

      <Card title="Content to evaluate">
        <form onSubmit={handleRun} className="space-y-4">
          <div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Paste your article, landing page, or any content here…"
              rows={8}
              disabled={running}
              className="w-full resize-y rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50"
            />
            <p className={`mt-1 text-right text-xs tabular-nums font-medium ${wordCount > 0 && wordCount < 20 ? "text-[var(--red)]" : "text-[var(--muted)]"}`}>
              {wordCount.toLocaleString()} words
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--muted)]">
                URL <span className="text-slate-400">(optional)</span>
              </label>
              <input type="text" value={url} onChange={(e) => setUrl(e.target.value)}
                placeholder="https://yoursite.com/page"
                disabled={running}
                className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--muted)]">
                Author name <span className="text-slate-400">(optional)</span>
              </label>
              <input type="text" value={author} onChange={(e) => setAuthor(e.target.value)}
                placeholder="Jane Smith, MD"
                disabled={running}
                className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--muted)]">
                Domain / site <span className="text-slate-400">(optional)</span>
              </label>
              <input type="text" value={domain} onChange={(e) => setDomain(e.target.value)}
                placeholder="yoursite.com"
                disabled={running}
                className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50" />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            {running && (
              <button type="button" onClick={handleStop}
                className="rounded-lg border border-red-200 bg-[var(--red-soft)] px-4 py-2 text-sm font-medium text-[var(--red)]">
                Stop
              </button>
            )}
            <button
              type="submit"
              disabled={running || wordCount < 20}
              className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {running ? "Evaluating…" : "Calculate E-E-A-T Score"}
            </button>
          </div>
        </form>

        <StepStatus steps={steps} running={running} />
        {error && <ErrorBox message={error} />}
      </Card>

      {result && (
        <>
          {/* Score cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {result.dimensions.map((d) => (
              <div key={d.label} className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-5 py-4">
                <p className="text-xs font-medium text-[var(--muted)]">{d.label}</p>
                <p className={`mt-1 text-3xl font-bold ${
                  scoreTone(d.percent) === "green"
                    ? "text-[var(--green)]"
                    : scoreTone(d.percent) === "gold"
                    ? "text-[var(--gold)]"
                    : "text-[var(--red)]"
                }`}>
                  {d.points}/10
                </p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">{d.percent}%</p>
              </div>
            ))}
          </div>

          {/* Overall score */}
          <div className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--card)] px-6 py-4">
            <div>
              <p className="text-sm font-semibold text-[var(--foreground)]">Overall E-E-A-T Score</p>
              <p className="mt-1 text-sm text-[var(--muted)]">{result.overallVerdict}</p>
            </div>
            <p className={`text-4xl font-bold tabular-nums ${
              overallTone === "green"
                ? "text-[var(--green)]"
                : overallTone === "gold"
                ? "text-[var(--gold)]"
                : "text-[var(--red)]"
            }`}>
              {result.overallPercent}%
            </p>
          </div>

          {/* Bar chart */}
          <Card title="Score by Dimension">
            <EEATBarChart dimensions={result.dimensions} />
          </Card>

          {/* Criterion breakdown */}
          {result.dimensions.map((d) => (
            <Card
              key={d.label}
              title={d.label}
              subtitle={`${d.points}/10 · ${d.percent}%`}
            >
              <div className="space-y-3">
                {d.criteria.map((c, i) => {
                  const { text, tone } = scoreLabel(c.score);
                  return (
                    <div key={i} className="flex items-start gap-3 rounded-lg border border-[var(--border)] px-4 py-3">
                      <Badge tone={tone}>{text}</Badge>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[var(--foreground)]">{c.criterion}</p>
                        <p className="mt-0.5 text-xs text-[var(--muted)] leading-relaxed">{c.reason}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}

          {/* EEAT Export */}
          <button
            onClick={() => {
              const rows: (string | number)[][] = [
                ["Dimension", "Criterion", "Score (0-2)", "Label", "Reason"],
                ...result.dimensions.flatMap((d) =>
                  d.criteria.map((c) => [d.label, c.criterion, c.score, c.score === 2 ? "Strong" : c.score === 1 ? "Partial" : "Not Present", c.reason])
                ),
                [],
                ["", "Overall %", result.overallPercent, "", result.overallVerdict],
              ];
              downloadXlsx(`eeat-${url.trim().replace(/[^a-z0-9]/gi, "-") || Date.now()}.xlsx`, [{ name: "E-E-A-T Scores", rows }]);
            }}
            className="w-full rounded-lg border border-[var(--border)] bg-white py-2.5 text-sm font-medium text-[var(--foreground)] transition hover:bg-slate-50"
          >
            Export E-E-A-T report (.xlsx)
          </button>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Tab: Page Relevance Analyzer                                            */
/* ---------------------------------------------------------------------- */

type ChunkDetail = { index: number; text: string; scores: number[]; rankScore?: number };
type UrlResult = {
  rank: number; url: string; title: string; chunkCount: number;
  fetchError?: string; bestScores: number[]; topRankScore?: number; chunks: ChunkDetail[];
};
type QueryCoverage = { query: string; isSeed: boolean; coverCount: number; totalUrls: number };
type QualityAudit = { groundedness: number; contextRelevance: number; notes: string };
type PageRelevanceResult = {
  seedQuery: string;
  city: string;
  queries: string[];
  urls: UrlResult[];
  queryCoverage: QueryCoverage[];
  qualityAudit?: QualityAudit;
};

function scoreStyle(score: number): { backgroundColor: string; color: string; fontWeight: string } {
  if (score >= 73) return { backgroundColor: "#1d4ed8", color: "white", fontWeight: "700" };
  if (score >= 65) return { backgroundColor: "#3b82f6", color: "white", fontWeight: "600" };
  if (score >= 57) return { backgroundColor: "#93c5fd", color: "#1e3a8a", fontWeight: "500" };
  if (score >= 48) return { backgroundColor: "#dbeafe", color: "#1e40af", fontWeight: "400" };
  return { backgroundColor: "#f0f9ff", color: "#93c5fd", fontWeight: "400" };
}

function DiagonalHeader({ label, isSeed }: { label: string; isSeed: boolean }) {
  const display = label.length > 32 ? label.slice(0, 30) + "…" : label;
  return (
    <th style={{ width: 110, height: 150, verticalAlign: "bottom", padding: "0 4px 8px", position: "relative" }}>
      <div style={{
        position: "absolute", bottom: 8, left: 8,
        transform: "rotate(-45deg)", transformOrigin: "bottom left",
        whiteSpace: "nowrap", fontSize: 11,
        color: isSeed ? "var(--accent)" : "var(--foreground)",
        maxWidth: 140,
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}>
        {isSeed && (
          <span style={{ fontSize: 9, fontWeight: 700, color: "var(--accent)", marginRight: 4, verticalAlign: "middle" }}>
            SEED
          </span>
        )}
        {display}
      </div>
    </th>
  );
}

function HeatmapCell({ score, onClick }: { score: number; onClick?: () => void }) {
  const style = scoreStyle(score);
  return (
    <td style={{ padding: "3px 3px" }}>
      <div
        onClick={onClick}
        style={{
          ...style,
          width: 100,
          height: 44,
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 15,
          cursor: onClick ? "pointer" : undefined,
        }}
      >
        {score > 0 ? score : "—"}
      </div>
    </td>
  );
}

function ChunkDrilldown({
  urlResult,
  queries,
  onClose,
}: {
  urlResult: UrlResult;
  queries: string[];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 pt-16 pb-16 px-4">
      <div className="w-full max-w-5xl rounded-2xl border border-[var(--border)] bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-[var(--border)] p-5">
          <div>
            <p className="text-sm font-semibold text-[var(--foreground)]">
              #{urlResult.rank} {urlResult.title}
            </p>
            <a href={urlResult.url} target="_blank" rel="noopener noreferrer"
              className="text-xs text-[var(--accent)] hover:underline">
              {urlResult.url} ↗
            </a>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Per-chunk × query heatmap. Each row is a passage from the page in document order.
            </p>
          </div>
          <button onClick={onClose}
            className="ml-4 shrink-0 rounded-lg p-1.5 text-[var(--muted)] hover:bg-slate-100">
            ✕
          </button>
        </div>
        <div className="overflow-x-auto p-4">
          <table style={{ borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                <th style={{ width: 40, verticalAlign: "bottom", paddingBottom: 8 }}>
                  <span className="text-xs text-[var(--muted)]">#</span>
                </th>
                <th style={{ width: 260, verticalAlign: "bottom", paddingBottom: 8, textAlign: "left" }}>
                  <span className="text-xs text-[var(--muted)]">Chunk</span>
                </th>
                {queries.map((q, i) => (
                  <DiagonalHeader key={i} label={q} isSeed={i === 0} />
                ))}
              </tr>
            </thead>
            <tbody>
              {urlResult.chunks.map((chunk) => (
                <tr key={chunk.index}>
                  <td className="pr-2 text-xs text-[var(--muted)] align-top pt-3">{chunk.index}</td>
                  <td className="pr-4 align-top pt-2">
                    <p className="text-xs text-[var(--foreground)] leading-relaxed line-clamp-3">
                      {chunk.text}
                    </p>
                  </td>
                  {chunk.scores.map((score, qi) => (
                    <HeatmapCell key={qi} score={score} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const TOP_N_OPTIONS = [3, 5, 7, 10];

function PageRelevanceTab() {
  const { run } = useSSE();

  const [seedQuery, setSeedQuery] = useState("");
  const [city, setCity] = useState("");
  const [fanoutEnabled, setFanoutEnabled] = useState(true);
  const [fanoutCount, setFanoutCount] = useState(5);
  const [topNPerQuery, setTopNPerQuery] = useState(3);

  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PageRelevanceResult | null>(null);
  const [drilldown, setDrilldown] = useState<UrlResult | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const canRun = seedQuery.trim().length >= 3;

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    if (!canRun || running) return;

    setRunning(true);
    setSteps([]);
    setResult(null);
    setError("");
    setDrilldown(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = (await run(
        "/api/page-relevance",
        {
          seedQuery: seedQuery.trim(),
          city: city.trim(),
          fanoutCount: fanoutEnabled ? fanoutCount : 0,
          topNPerQuery,
        },
        (step) => setSteps((s) => [...s, step]),
        controller.signal
      )) as PageRelevanceResult;
      setResult(data);
      pushHistory({
        tool: "page-relevance",
        label: seedQuery.trim(),
        summary: `${data.urls.length} URLs · ${data.queries.length} queries${city.trim() ? ` · ${city.trim()}` : ""}`,
        payload: data,
      });
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

  function handleExportCsv() {
    if (!result) return;
    const rows: (string | number)[][] = [
      ["Rank", "URL", "Title", "Chunks", "Rank Score", ...result.queries.map((q, i) => i === 0 ? `SEED: ${q}` : q)],
    ];
    for (const u of result.urls) {
      rows.push([u.rank, u.url, u.title, u.chunkCount, u.topRankScore?.toFixed(3) ?? "", ...u.bestScores]);
    }
    downloadCsv(`page-relevance-${Date.now()}.csv`, rows);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Page Relevance Analyzer</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Enter a seed keyword and city. Gemini Search Grounding discovers the top organic URLs,
          Vertex AI embeds and ranks every content chunk, and Gemini audits the quality of results.
        </p>
      </div>

      <Card title="">
        <form onSubmit={handleRun} className="space-y-5">
          {/* Seed query */}
          <div>
            <label htmlFor="pr-seed" className="mb-1.5 block text-sm font-semibold text-[var(--foreground)]">
              Seed keyword / query
            </label>
            <input
              id="pr-seed"
              type="text"
              value={seedQuery}
              onChange={(e) => setSeedQuery(e.target.value)}
              placeholder="e.g. car accident lawyer"
              disabled={running}
              className="w-full rounded-lg border border-[var(--border)] bg-slate-50 px-3 py-2.5 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50"
            />
          </div>

          {/* City + Top N */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="pr-city" className="mb-1.5 block text-sm font-semibold text-[var(--foreground)]">
                City / Location <span className="font-normal text-[var(--muted)]">(optional)</span>
              </label>
              <input
                id="pr-city"
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Toronto, ON"
                disabled={running}
                className="w-full rounded-lg border border-[var(--border)] bg-slate-50 px-3 py-2.5 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50"
              />
            </div>
            <div>
              <label htmlFor="pr-topn" className="mb-1.5 block text-sm font-semibold text-[var(--foreground)]">
                Top URLs per query
              </label>
              <select
                id="pr-topn"
                value={topNPerQuery}
                onChange={(e) => setTopNPerQuery(Number(e.target.value))}
                disabled={running}
                className="w-full rounded-lg border border-[var(--border)] bg-slate-50 px-3 py-2.5 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] disabled:opacity-50"
              >
                {TOP_N_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n} URLs per query</option>
                ))}
              </select>
            </div>
          </div>

          {/* Fan-out toggle */}
          <div className="rounded-lg border border-[var(--border)] bg-slate-50 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-[var(--foreground)]">Agentic query fan-out</p>
                <p className="text-xs text-[var(--muted)]">
                  Gemini generates {fanoutEnabled ? fanoutCount : "N"} unique localized variations of your seed query for broader SERP coverage
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFanoutEnabled((v) => !v)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${fanoutEnabled ? "bg-[var(--accent)]" : "bg-slate-200"}`}
              >
                <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${fanoutEnabled ? "translate-x-5" : "translate-x-0"}`} />
              </button>
            </div>
            {fanoutEnabled && (
              <div className="mt-3">
                <div className="mb-1.5 flex justify-between text-xs text-[var(--muted)]">
                  <span>Variations to generate</span>
                  <span className="font-medium tabular-nums">{fanoutCount}</span>
                </div>
                <input
                  type="range" min={1} max={14} value={fanoutCount}
                  onChange={(e) => setFanoutCount(Number(e.target.value))}
                  disabled={running}
                  className="w-full accent-[var(--accent)]"
                />
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            {running && (
              <button type="button" onClick={handleStop}
                className="rounded-lg border border-red-200 bg-[var(--red-soft)] px-4 py-2 text-sm font-medium text-[var(--red)]">
                Stop
              </button>
            )}
            <button type="submit" disabled={!canRun || running}
              className="flex items-center gap-2 rounded-lg bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50">
              {running ? "Analyzing…" : "Analyze SERP"}
            </button>
          </div>
        </form>

        <StepStatus steps={steps} running={running} />
        {error && <ErrorBox message={error} />}
      </Card>

      {result && (
        <>
          {/* Quality Audit */}
          {result.qualityAudit && (
            <Card title="Quality Audit" subtitle="Gemini's assessment of the pipeline output quality.">
              <div className="grid gap-4 sm:grid-cols-2">
                {[
                  { label: "Groundedness", value: result.qualityAudit.groundedness },
                  { label: "Context Relevance", value: result.qualityAudit.contextRelevance },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div className="mb-1 flex justify-between text-sm">
                      <span className="font-medium text-[var(--foreground)]">{label}</span>
                      <span className="font-semibold text-[var(--accent)]">{value}%</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-[var(--accent)] transition-all"
                        style={{ width: `${value}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              {result.qualityAudit.notes && (
                <p className="mt-3 text-sm text-[var(--muted)]">{result.qualityAudit.notes}</p>
              )}
            </Card>
          )}

          {/* Heatmap */}
          <Card
            title="Coverage Heatmap"
            subtitle="Best-matching chunk score per URL × query. Darker = stronger semantic match. Click a row to drill into per-chunk detail."
            action={
              <button onClick={handleExportCsv}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)]">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Export CSV
              </button>
            }
          >
            <div className="mb-3 flex items-center gap-2">
              <span className="text-xs text-[var(--muted)]">Low</span>
              <div className="h-3 w-32 rounded-full" style={{
                background: "linear-gradient(to right, #f0f9ff, #93c5fd, #3b82f6, #1d4ed8)"
              }} />
              <span className="text-xs text-[var(--muted)]">High</span>
            </div>
            <div className="overflow-x-auto">
              <table style={{ borderCollapse: "separate", borderSpacing: 0, minWidth: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ width: 260, verticalAlign: "bottom", paddingBottom: 8, textAlign: "left" }}>
                      <span className="text-xs font-semibold text-[var(--muted)]">URL</span>
                    </th>
                    {result.queries.map((q, i) => (
                      <DiagonalHeader key={i} label={q} isSeed={i === 0} />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.urls.map((u) => (
                    <tr key={u.rank} className="group">
                      <td className="py-1 pr-4 align-middle">
                        <button
                          onClick={() => setDrilldown(u)}
                          className="text-left group-hover:underline"
                          disabled={!!u.fetchError || u.chunkCount === 0}
                        >
                          <p className="text-sm font-semibold text-[var(--foreground)]">
                            #{u.rank} {u.title.length > 40 ? u.title.slice(0, 38) + "…" : u.title}
                          </p>
                          <p className="text-xs text-[var(--muted)]">{u.url}</p>
                          <p className="text-xs text-[var(--muted)]">
                            {u.fetchError
                              ? <span className="text-[var(--red)]">{u.fetchError}</span>
                              : (
                                <>
                                  {u.chunkCount} chunks
                                  {u.topRankScore !== undefined && (
                                    <span className="ml-1.5 text-[var(--accent)]">
                                      rank {(u.topRankScore * 100).toFixed(0)}%
                                    </span>
                                  )}
                                  {" · "}
                                  <a href={u.url} target="_blank" rel="noopener noreferrer"
                                    className="text-[var(--accent)] hover:underline"
                                    onClick={(e) => e.stopPropagation()}>visit ↗</a>
                                </>
                              )
                            }
                          </p>
                        </button>
                      </td>
                      {u.bestScores.map((score, qi) => (
                        <HeatmapCell
                          key={qi}
                          score={score}
                          onClick={!u.fetchError && u.chunkCount > 0 ? () => setDrilldown(u) : undefined}
                        />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Query Coverage */}
          <Card
            title="Query Coverage"
            subtitle="Share of discovered URLs that have at least one strong chunk (≥ 60% similarity) for each query. Low coverage = content gap = opportunity."
          >
            <div className="space-y-3">
              {result.queryCoverage.map((qc, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-72 shrink-0">
                    <span className="text-sm text-[var(--foreground)]">{qc.query}</span>
                    {qc.isSeed && (
                      <span className="ml-1.5 rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--accent)]">
                        SEED
                      </span>
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="h-3 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-[var(--accent)] transition-all"
                        style={{ width: qc.totalUrls > 0 ? `${(qc.coverCount / qc.totalUrls) * 100}%` : "0%" }}
                      />
                    </div>
                  </div>
                  <span className="w-16 shrink-0 text-right text-sm text-[var(--muted)]">
                    {qc.coverCount}/{qc.totalUrls} URLs
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      {drilldown && (
        <ChunkDrilldown
          urlResult={drilldown}
          queries={result?.queries ?? []}
          onClose={() => setDrilldown(null)}
        />
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
      pushHistory({ tool: "fan-out", label: keyword.trim(), summary: `${data.categories.length} categories`, payload: data });
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
/* Tab: History                                                             */
/* ---------------------------------------------------------------------- */

function HistoryTab() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [filter, setFilter] = useState<HistoryTool | "all">("all");

  useEffect(() => {
    setEntries(loadAllHistory());
    const onStorage = () => setEntries(loadAllHistory());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function handleClear() {
    if (!confirm("Clear all history? This cannot be undone.")) return;
    localStorage.removeItem(HISTORY_STORAGE_KEY);
    setEntries([]);
  }

  function handleDelete(id: string) {
    const updated = loadAllHistory().filter((e) => e.id !== id);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(updated));
    setEntries(updated);
  }

  const filtered = filter === "all" ? entries : entries.filter((e) => e.tool === filter);

  const toolCounts: Partial<Record<HistoryTool | "all", number>> = { all: entries.length };
  for (const e of entries) {
    toolCounts[e.tool] = (toolCounts[e.tool] ?? 0) + 1;
  }

  const filterOptions: { id: HistoryTool | "all"; label: string }[] = [
    { id: "all", label: "All" },
    { id: "entity-analyzer", label: "Entity Analysis" },
    { id: "eeat", label: "E-E-A-T" },
    { id: "page-relevance", label: "Page Relevance" },
    { id: "fan-out", label: "AI Fan-Out" },
    { id: "scrape", label: "URL Scrape" },
    { id: "optimize", label: "Optimization" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">History</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">All analysis runs saved locally in your browser. {entries.length} total.</p>
        </div>
        {entries.length > 0 && (
          <button onClick={handleClear}
            className="rounded-lg border border-red-200 bg-[var(--red-soft)] px-3 py-1.5 text-xs font-medium text-[var(--red)] hover:bg-red-100">
            Clear all
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {filterOptions.map((opt) => {
          const count = toolCounts[opt.id] ?? 0;
          if (opt.id !== "all" && count === 0) return null;
          return (
            <button key={opt.id} onClick={() => setFilter(opt.id)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${filter === opt.id ? "bg-[var(--accent)] text-white" : "border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
              {opt.label} <span className="ml-1 opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-slate-50 py-16 text-center">
          <p className="text-sm text-[var(--muted)]">No history yet. Run an analysis to see it here.</p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-slate-50">
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Tool</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Label</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Summary</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">When</th>
                <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry, i) => (
                <tr key={entry.id} className={`border-b border-[var(--border)] ${i % 2 === 0 ? "bg-white" : "bg-slate-50"} hover:bg-blue-50 transition`}>
                  <td className="px-4 py-2.5">
                    <Badge tone={TOOL_TONE[entry.tool]}>{TOOL_LABELS[entry.tool]}</Badge>
                  </td>
                  <td className="max-w-[200px] truncate px-4 py-2.5 font-medium text-[var(--foreground)]" title={entry.label}>
                    {entry.label}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--muted)]">{entry.summary}</td>
                  <td className="px-4 py-2.5 text-xs text-[var(--muted)] tabular-nums whitespace-nowrap">
                    {new Date(entry.ts).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        onClick={() => {
                          const blob = new Blob([JSON.stringify(entry.payload, null, 2)], { type: "application/json" });
                          const a = document.createElement("a");
                          a.href = URL.createObjectURL(blob);
                          a.download = `${entry.tool}-${entry.id}.json`;
                          a.click();
                          URL.revokeObjectURL(a.href);
                        }}
                        className="text-xs text-[var(--accent)] hover:underline transition"
                      >
                        Download
                      </button>
                      <button onClick={() => handleDelete(entry.id)}
                        className="text-xs text-[var(--muted)] hover:text-[var(--red)] transition">
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Top-level: tab bar + header                                             */
/* ---------------------------------------------------------------------- */

type Tab = "entityanalyzer" | "eeat" | "pagerelevance" | "fanout" | "entity" | "optimize" | "history";

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
    id: "eeat",
    label: "E-E-A-T Score",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    ),
  },
  {
    id: "pagerelevance",
    label: "Page Relevance Analyzer",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
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
  {
    id: "history",
    label: "History",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
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
        {activeTab === "eeat" && <EEATTab />}
        {activeTab === "pagerelevance" && <PageRelevanceTab />}
        {activeTab === "fanout" && <FanOutTab />}
        {activeTab === "entity" && <EntityAnalysisTab />}
        {activeTab === "optimize" && <OptimizationTab />}
        {activeTab === "history" && <HistoryTab />}
      </main>
    </div>
  );
}
