"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { AccordionRow } from "@/components/AccordionRow";
import { CircularGauge } from "@/components/CircularGauge";
import { CoverageBarChart } from "@/components/CoverageBarChart";
import { ScoreCard } from "@/components/ScoreCard";
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
};

type TopKeyword = {
  term: string;
  type: string;
  appearsInCompetitors: number;
  avgSalience: number;
  presentInTarget: boolean;
};

type ScrapeResult = {
  target: PageSummary;
  competitors: PageSummary[];
  topKeywords: TopKeyword[];
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
    uncoveredPassages: PassageMatch[];
    strongMatchThreshold: number;
  };
  errors: string[];
};

type OptimizeResult = {
  gapReport: GapReport;
  rewriteSuggestions: string;
};

type StructuralFinding = { rule: string; passed: boolean; detail: string };
type StructuralReport = { findings: StructuralFinding[]; score: number };

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
    <div className="mt-4 space-y-1.5 rounded-md border border-[#1f1f1f] bg-[#121212] p-4">
      {steps.map((step, i) => (
        <p key={i} className="text-xs text-[#888]">
          {i === steps.length - 1 && running ? "→ " : "✓ "}
          {step}
        </p>
      ))}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="mt-4 rounded-md border border-[#3a1f1f] bg-[#1a1212] p-4">
      <p className="text-sm text-[#ff6b6b]">{message}</p>
    </div>
  );
}

function WarningsBox({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-[#3a2f1f] bg-[#1a1712] p-4">
      {warnings.map((w, i) => (
        <p key={i} className="text-sm text-[#e8c468]">{w}</p>
      ))}
    </div>
  );
}

function PageDetail({ page }: { page: PageSummary }) {
  const [showRawText, setShowRawText] = useState(false);

  return (
    <div className="space-y-4">
      {page.fetchError ? (
        <p className="text-sm text-[#ff6b6b]">Failed: {page.fetchError}</p>
      ) : (
        <>
          <div className="flex gap-4">
            <p className="text-xs text-[#888]">
              <span className="text-[#d8d8d8]">{page.wordCount}</span> words
            </p>
            <p className="text-xs text-[#888]">
              <span className="text-[#d8d8d8]">{page.entityCount}</span> entities identified
            </p>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[#999]">
              Headings
            </p>
            {page.headingOutline.length === 0 ? (
              <p className="text-xs text-[#666]">No headings detected.</p>
            ) : (
              <div className="space-y-0.5">
                {page.headingOutline.map((h, i) => (
                  <p
                    key={i}
                    className="text-xs text-[#aaa]"
                    style={{ paddingLeft: `${(h.level - 1) * 12}px` }}
                  >
                    H{h.level} — {h.text}
                  </p>
                ))}
              </div>
            )}
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[#999]">
              Top entities (showing {Math.min(20, page.entities.length)} of {page.entityCount})
            </p>
            <div className="flex flex-wrap gap-1.5">
              {page.entities.slice(0, 20).map((e, i) => (
                <span
                  key={i}
                  className="rounded bg-[#1f1f1f] px-2 py-0.5 text-xs text-[#aaa]"
                  title={`${e.type} · salience ${e.salience.toFixed(2)}`}
                >
                  {e.name}
                </span>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[#999]">
              Information gain — unique to this page only
            </p>
            {page.informationGain.length === 0 ? (
              <p className="text-xs text-[#666]">
                Nothing found that&apos;s unique to this page vs. the rest of the set.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {page.informationGain.map((g, i) => (
                  <span
                    key={i}
                    className="rounded bg-[#1a2a1f] px-2 py-0.5 text-xs text-[#8fd99f]"
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
              className="text-xs text-[#888] hover:text-[#e8e8e8] underline"
            >
              {showRawText ? "Hide" : "Show"} raw extracted text (verify header/footer exclusion)
            </button>
            {showRawText && (
              <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-[#1f1f1f] bg-[#0d0d0d] p-3 text-xs text-[#999]">
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
        { targetUrl: targetUrl.trim(), urls: urls.trim() },
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
    await navigator.clipboard.writeText(optimizeResult.rewriteSuggestions);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleExportCsv() {
    if (!scrapeResult) return;

    const rows: (string | number)[][] = [
      ["Type", "URL", "Word Count", "Term", "Term Type", "Salience/Score", "In Target"],
    ];

    rows.push(["Target", scrapeResult.target.url, scrapeResult.target.wordCount, "", "", "", ""]);
    for (const e of scrapeResult.target.entities) {
      rows.push(["Target Entity", scrapeResult.target.url, "", e.name, e.type, e.salience.toFixed(3), "yes"]);
    }

    for (const c of scrapeResult.competitors) {
      rows.push(["Competitor", c.url, c.wordCount, "", "", "", ""]);
      for (const e of c.entities) {
        rows.push(["Competitor Entity", c.url, "", e.name, e.type, e.salience.toFixed(3), ""]);
      }
    }

    for (const k of scrapeResult.topKeywords) {
      rows.push([
        "Top Keyword",
        "",
        "",
        k.term,
        k.type,
        k.avgSalience.toFixed(3),
        k.presentInTarget ? "yes" : "no",
      ]);
    }

    if (optimizeResult) {
      for (const e of optimizeResult.gapReport.missingEntities) {
        rows.push(["Missing Entity", "", "", e.name, e.type, e.avgSalienceInCompetitors.toFixed(3), "no"]);
      }
    }

    downloadCsv(`audit-${scrapeResult.target.url.replace(/[^a-z0-9]/gi, "-")}.csv`, rows);
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

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-[#e8e8e8]">
      <header className="flex items-center justify-between border-b border-[#1f1f1f] px-6 py-4">
        <h1 className="text-sm font-medium text-[#e8e8e8]">Relevance Engineering</h1>
        <button onClick={handleLogout} className="text-xs text-[#888] hover:text-[#e8e8e8]">
          Sign out
        </button>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10 space-y-10">
        <section>
          <h2 className="mb-4 text-sm font-semibold text-[#e8e8e8]">
            Step 1 — Scrape &amp; Summarize
          </h2>
          <form onSubmit={handleScrape} className="space-y-4">
            <div>
              <label htmlFor="topic" className="mb-1.5 block text-xs text-[#999]">
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
                className="w-full rounded-md border border-[#2a2a2a] bg-[#161616] px-3 py-2 text-sm outline-none focus:border-[#555] focus:ring-1 focus:ring-[#555] disabled:opacity-50"
              />
            </div>

            <div>
              <label htmlFor="targetUrl" className="mb-1.5 block text-xs text-[#999]">
                Target URL (required)
              </label>
              <input
                id="targetUrl"
                type="text"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="https://yoursite.com/your-page"
                disabled={scrapeRunning}
                className="w-full rounded-md border border-[#2a2a2a] bg-[#161616] px-3 py-2 text-sm outline-none focus:border-[#555] focus:ring-1 focus:ring-[#555] disabled:opacity-50"
              />
            </div>

            <div>
              <label htmlFor="urls" className="mb-1.5 block text-xs text-[#999]">
                Competitor URLs (required, at least 1)
              </label>
              <textarea
                id="urls"
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
                placeholder={"https://competitor1.com/page\nhttps://competitor2.com/page"}
                rows={5}
                disabled={scrapeRunning}
                className="w-full resize-y rounded-md border border-[#2a2a2a] bg-[#161616] px-3 py-2 text-sm font-mono outline-none focus:border-[#555] focus:ring-1 focus:ring-[#555] disabled:opacity-50"
              />
              <p className="mt-1 text-xs text-[#666]">
                {urlCount > 0 ? `${urlCount} URL(s) detected.` : "No competitor URLs entered yet."}
              </p>
            </div>

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={scrapeRunning || !targetUrl.trim() || urlCount === 0}
                className="rounded-md bg-[#e8e8e8] px-4 py-2 text-sm font-medium text-[#0d0d0d] transition hover:bg-white disabled:opacity-50"
              >
                {scrapeRunning ? "Scraping..." : "Scrape & Summarize"}
              </button>
              {scrapeRunning && (
                <button
                  type="button"
                  onClick={handleStopScrape}
                  className="rounded-md border border-[#3a1f1f] bg-[#1a1212] px-4 py-2 text-sm font-medium text-[#ff6b6b] transition hover:bg-[#241515]"
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
          <section className="border-t border-[#1f1f1f] pt-8 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-[#e8e8e8]">Audit results</h2>
                <p className="text-xs text-[#666]">{scrapeResult.target.url}</p>
              </div>
              <button
                onClick={handleExportCsv}
                className="rounded-md border border-[#2a2a2a] bg-[#161616] px-3 py-1.5 text-xs text-[#aaa] hover:bg-[#1f1f1f]"
              >
                Export CSV
              </button>
            </div>

            <WarningsBox warnings={scrapeResult.errors} />

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <ScoreCard value={scrapeResult.competitors.length} label="Competitors analyzed" />
              <ScoreCard value={scrapeResult.target.wordCount} label="Target word count" />
              <ScoreCard
                value={criticalGapCount}
                label="Missing entities"
                accent={criticalGapCount > 0 ? "warning" : "good"}
              />
              <ScoreCard value={infoGainCount} label="Keyword gaps" accent={infoGainCount > 0 ? "warning" : "good"} />
            </div>

            {optimizeResult && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex items-center justify-center rounded-md border border-[#1f1f1f] bg-[#121212] p-6">
                  <CircularGauge
                    value={optimizeResult.gapReport.semanticCoverage.coverageScore}
                    label="Semantic coverage"
                    sublabel="vs. competitor passages"
                  />
                </div>
                <div className="rounded-md border border-[#1f1f1f] bg-[#121212] p-4">
                  <p className="mb-3 text-xs font-medium uppercase tracking-wide text-[#999]">
                    Top keywords — competitor mentions
                  </p>
                  <CoverageBarChart items={barChartItems} />
                  <p className="mt-2 text-xs text-[#666]">
                    <span className="text-[#6bcf6b]">green</span> = present in your target page ·{" "}
                    <span className="text-[#ff6b6b]">red</span> = missing
                  </p>
                </div>
              </div>
            )}

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[#999]">
                Page-by-page analysis
              </p>
              <div className="space-y-2">
                <AccordionRow
                  title={scrapeResult.target.title}
                  subtitle={`${scrapeResult.target.url} · ${scrapeResult.target.wordCount} words · ${scrapeResult.target.entityCount} entities`}
                  badge={
                    <span className="rounded bg-[#1f3a2a] px-2 py-0.5 text-xs text-[#6bcf6b]">
                      Your page
                    </span>
                  }
                  defaultOpen
                >
                  <PageDetail page={scrapeResult.target} />
                </AccordionRow>

                {scrapeResult.competitors.map((c, i) => (
                  <AccordionRow
                    key={i}
                    title={c.title}
                    subtitle={`${c.url} · ${c.wordCount} words · ${c.entityCount} entities`}
                  >
                    <PageDetail page={c} />
                  </AccordionRow>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[#999]">
                Top semantic keywords for this term
              </p>
              <div className="rounded-md border border-[#1f1f1f] bg-[#121212] p-4">
                <ul className="space-y-1.5 text-sm">
                  {scrapeResult.topKeywords.map((k, i) => (
                    <li key={i} className="flex items-center justify-between">
                      <span className="text-[#d8d8d8]">
                        {k.term} <span className="text-xs text-[#666]">({k.type})</span>
                        {k.presentInTarget && (
                          <span className="ml-2 text-xs text-[#6bcf6b]">✓ in target</span>
                        )}
                      </span>
                      <span className="text-xs text-[#888]">
                        {k.appearsInCompetitors} competitor(s) · {k.avgSalience.toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        )}

        {scrapeResult && (
          <section className="border-t border-[#1f1f1f] pt-8">
            <h2 className="mb-4 text-sm font-semibold text-[#e8e8e8]">Step 2 — Optimize</h2>
            <div className="flex gap-2">
              <button
                onClick={handleOptimize}
                disabled={optimizeRunning}
                className="rounded-md bg-[#e8e8e8] px-4 py-2 text-sm font-medium text-[#0d0d0d] transition hover:bg-white disabled:opacity-50"
              >
                {optimizeRunning ? "Optimizing..." : "Run gap analysis + rewrite suggestions"}
              </button>
              {optimizeRunning && (
                <button
                  onClick={handleStopOptimize}
                  className="rounded-md border border-[#3a1f1f] bg-[#1a1212] px-4 py-2 text-sm font-medium text-[#ff6b6b] transition hover:bg-[#241515]"
                >
                  Stop
                </button>
              )}
            </div>

            <StepStatus steps={optimizeSteps} running={optimizeRunning} />
            {optimizeError && <ErrorBox message={optimizeError} />}

            {optimizeResult && (
              <div className="mt-6 space-y-6">
                <WarningsBox warnings={optimizeResult.gapReport.errors} />

                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[#999]">
                    Missing entities — competitors mention these, your target page doesn&apos;t
                  </p>
                  <div className="rounded-md border border-[#1f1f1f] bg-[#121212] p-4">
                    {optimizeResult.gapReport.missingEntities.length > 0 ? (
                      <ul className="space-y-1.5 text-sm">
                        {optimizeResult.gapReport.missingEntities.map((e, i) => (
                          <li key={i} className="flex justify-between">
                            <span className="text-[#d8d8d8]">
                              {e.name} <span className="text-xs text-[#666]">({e.type})</span>
                            </span>
                            <span className="text-xs text-[#888]">
                              {e.appearsInCompetitors} competitor(s) · {e.avgSalienceInCompetitors.toFixed(2)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-[#888]">No entity gaps found.</p>
                    )}
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[#999]">
                    Uncovered passages
                  </p>
                  <div className="space-y-3 rounded-md border border-[#1f1f1f] bg-[#121212] p-4">
                    {optimizeResult.gapReport.semanticCoverage.uncoveredPassages.length > 0 ? (
                      optimizeResult.gapReport.semanticCoverage.uncoveredPassages.slice(0, 10).map((p, i) => (
                        <div key={i} className="border-b border-[#1f1f1f] pb-3 last:border-0 last:pb-0">
                          <p className="mb-1 text-xs text-[#666]">
                            {p.competitorUrl} · score: {p.bestMatchScore.toFixed(2)}
                          </p>
                          <p className="text-sm text-[#d8d8d8]">{p.competitorChunk}</p>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-[#888]">None found.</p>
                    )}
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-medium uppercase tracking-wide text-[#999]">
                      Rewrite suggestions
                    </p>
                    <button onClick={handleCopy} className="text-xs text-[#888] hover:text-[#e8e8e8]">
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-[#1f1f1f] bg-[#121212] p-4 text-sm leading-relaxed text-[#d8d8d8]">
                    {optimizeResult.rewriteSuggestions}
                  </pre>
                </div>
              </div>
            )}
          </section>
        )}

        {scrapeResult && (
          <section className="border-t border-[#1f1f1f] pt-8">
            <h2 className="mb-4 text-sm font-semibold text-[#e8e8e8]">
              Step 3 — Structural Check (optional)
            </h2>
            <button
              onClick={handleStructuralCheck}
              disabled={structuralRunning}
              className="rounded-md bg-[#e8e8e8] px-4 py-2 text-sm font-medium text-[#0d0d0d] transition hover:bg-white disabled:opacity-50"
            >
              {structuralRunning ? "Checking..." : "Run structural check"}
            </button>

            {structuralError && <ErrorBox message={structuralError} />}

            {structuralResult && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[#999]">
                  Structural check — {structuralResult.score}/100
                </p>
                <div className="space-y-2 rounded-md border border-[#1f1f1f] bg-[#121212] p-4">
                  {structuralResult.findings.map((f, i) => (
                    <div key={i} className="text-sm">
                      <span className={f.passed ? "text-[#6bcf6b]" : "text-[#ff6b6b]"}>
                        {f.passed ? "✓" : "✗"}
                      </span>{" "}
                      <span className="text-[#d8d8d8]">{f.rule}</span>
                      {!f.passed && (
                        <p className="ml-5 mt-0.5 text-xs text-[#888]">{f.detail}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
