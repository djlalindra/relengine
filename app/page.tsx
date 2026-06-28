"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

type EntityGap = {
  name: string;
  type: string;
  appearsInCompetitors: number;
  avgSalienceInCompetitors: number;
};

type ExtractedEntity = {
  name: string;
  type: string;
  salience: number;
};

type PassageMatch = {
  competitorChunk: string;
  competitorUrl: string;
  bestMatchScore: number;
};

type GapReport = {
  targetUrl: string;
  targetWordCount: number;
  missingEntities: EntityGap[];
  targetEntities: ExtractedEntity[];
  semanticCoverage: {
    coverageScore: number;
    uncoveredPassages: PassageMatch[];
    strongMatchThreshold: number;
  };
  competitorsAnalyzed: { url: string; wordCount: number; fetchError?: string }[];
  errors: string[];
};

type StructuralFinding = { rule: string; passed: boolean; detail: string };

type AuditResult = {
  topic: string;
  targetUrl: string;
  gapReport: GapReport;
  rewriteSuggestions: string;
  structuralReport: { findings: StructuralFinding[]; score: number };
  errors: string[];
};

export default function Home() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [urls, setUrls] = useState("");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const urlCount = urls
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean).length;

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!topic.trim() || !targetUrl.trim() || running) return;

    setRunning(true);
    setSteps([]);
    setResult(null);
    setError("");
    setCopied(false);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          targetUrl: targetUrl.trim(),
          urls: urls.trim() || undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Something went wrong.");
        setRunning(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setError("No response stream available.");
        setRunning(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

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
            setSteps((prev) => [...prev, payload.step]);
          } else if (payload.type === "result") {
            setResult(payload.result);
          } else if (payload.type === "error") {
            setError(payload.error);
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        setError("Connection lost. Try again.");
      }
    } finally {
      setRunning(false);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    setRunning(false);
    setSteps((prev) => [...prev, "Stopped by user."]);
  }

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  async function handleCopy() {
    if (!result) return;
    await navigator.clipboard.writeText(result.rewriteSuggestions);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-[#e8e8e8]">
      <header className="flex items-center justify-between border-b border-[#1f1f1f] px-6 py-4">
        <h1 className="text-sm font-medium text-[#e8e8e8]">
          Relevance Engineering
        </h1>
        <button
          onClick={handleLogout}
          className="text-xs text-[#888] hover:text-[#e8e8e8]"
        >
          Sign out
        </button>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <form onSubmit={handleGenerate} className="mb-8 space-y-4">
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
              disabled={running}
              className="w-full rounded-md border border-[#2a2a2a] bg-[#161616] px-3 py-2 text-sm outline-none focus:border-[#555] focus:ring-1 focus:ring-[#555] disabled:opacity-50"
            />
          </div>

          <div>
            <label htmlFor="targetUrl" className="mb-1.5 block text-xs text-[#999]">
              Target URL (required) — the page you want audited
            </label>
            <input
              id="targetUrl"
              type="text"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://yoursite.com/your-page"
              disabled={running}
              className="w-full rounded-md border border-[#2a2a2a] bg-[#161616] px-3 py-2 text-sm outline-none focus:border-[#555] focus:ring-1 focus:ring-[#555] disabled:opacity-50"
            />
          </div>

          <div>
            <label htmlFor="urls" className="mb-1.5 block text-xs text-[#999]">
              Competitor URLs (required, at least 1) — one per line or
              comma-separated
            </label>
            <textarea
              id="urls"
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              placeholder={"https://competitor1.com/page\nhttps://competitor2.com/page"}
              rows={5}
              disabled={running}
              className="w-full resize-y rounded-md border border-[#2a2a2a] bg-[#161616] px-3 py-2 text-sm font-mono outline-none focus:border-[#555] focus:ring-1 focus:ring-[#555] disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-[#666]">
              {urlCount > 0
                ? `${urlCount} URL${urlCount === 1 ? "" : "s"} detected (max 15 used).`
                : "No competitor URLs entered yet."}
            </p>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={running || !topic.trim() || !targetUrl.trim() || urlCount === 0}
              className="rounded-md bg-[#e8e8e8] px-4 py-2 text-sm font-medium text-[#0d0d0d] transition hover:bg-white disabled:opacity-50"
            >
              {running ? "Analyzing..." : "Run audit"}
            </button>
            {running && (
              <button
                type="button"
                onClick={handleStop}
                className="rounded-md border border-[#3a1f1f] bg-[#1a1212] px-4 py-2 text-sm font-medium text-[#ff6b6b] transition hover:bg-[#241515]"
              >
                Stop
              </button>
            )}
          </div>
        </form>

        {steps.length > 0 && (
          <div className="mb-8 space-y-1.5 rounded-md border border-[#1f1f1f] bg-[#121212] p-4">
            {steps.map((step, i) => (
              <p key={i} className="text-xs text-[#888]">
                {i === steps.length - 1 && running ? "→ " : "✓ "}
                {step}
              </p>
            ))}
          </div>
        )}

        {error && (
          <div className="mb-8 rounded-md border border-[#3a1f1f] bg-[#1a1212] p-4">
            <p className="text-sm text-[#ff6b6b]">{error}</p>
          </div>
        )}

        {result && (
          <div className="space-y-8">
            {result.errors.length > 0 && (
              <section>
                <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[#999]">
                  Warnings
                </h2>
                <div className="space-y-1 rounded-md border border-[#3a2f1f] bg-[#1a1712] p-4">
                  {result.errors.map((e, i) => (
                    <p key={i} className="text-sm text-[#e8c468]">
                      {e}
                    </p>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[#999]">
                Semantic coverage — {result.gapReport.semanticCoverage.coverageScore}/100
              </h2>
              <div className="rounded-md border border-[#1f1f1f] bg-[#121212] p-4">
                <p className="text-sm text-[#d8d8d8]">
                  {result.gapReport.semanticCoverage.coverageScore}% of
                  competitor passages have a strong semantic match (≥
                  {result.gapReport.semanticCoverage.strongMatchThreshold}) in
                  your target page. Target page: {result.gapReport.targetWordCount} words.
                </p>
              </div>
            </section>

            <section>
              <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[#999]">
                Missing entities — competitors mention these, your target page doesn&apos;t
              </h2>
              <div className="rounded-md border border-[#1f1f1f] bg-[#121212] p-4">
                {result.gapReport.missingEntities.length > 0 ? (
                  <ul className="space-y-1.5 text-sm">
                    {result.gapReport.missingEntities.map((e, i) => (
                      <li key={i} className="flex justify-between">
                        <span className="text-[#d8d8d8]">
                          {e.name}{" "}
                          <span className="text-xs text-[#666]">({e.type})</span>
                        </span>
                        <span className="text-xs text-[#888]">
                          {e.appearsInCompetitors} competitor(s) · salience{" "}
                          {e.avgSalienceInCompetitors.toFixed(2)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-[#888]">
                    No entity gaps found — your target page covers the
                    entities competitors mention.
                  </p>
                )}
              </div>
            </section>

            <section>
              <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[#999]">
                Uncovered passages — competitor content with no strong match in your target page
              </h2>
              <div className="space-y-3 rounded-md border border-[#1f1f1f] bg-[#121212] p-4">
                {result.gapReport.semanticCoverage.uncoveredPassages.length > 0 ? (
                  result.gapReport.semanticCoverage.uncoveredPassages
                    .slice(0, 10)
                    .map((p, i) => (
                      <div key={i} className="border-b border-[#1f1f1f] pb-3 last:border-0 last:pb-0">
                        <p className="mb-1 text-xs text-[#666]">
                          {p.competitorUrl} · best match score: {p.bestMatchScore.toFixed(2)}
                        </p>
                        <p className="text-sm text-[#d8d8d8]">{p.competitorChunk}</p>
                      </div>
                    ))
                ) : (
                  <p className="text-sm text-[#888]">
                    No significant uncovered passages found.
                  </p>
                )}
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-medium uppercase tracking-wide text-[#999]">
                  Rewrite suggestions
                </h2>
                <button
                  onClick={handleCopy}
                  className="text-xs text-[#888] hover:text-[#e8e8e8]"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-[#1f1f1f] bg-[#121212] p-4 text-sm leading-relaxed text-[#d8d8d8]">
                {result.rewriteSuggestions}
              </pre>
            </section>

            <section>
              <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[#999]">
                Structural check on target page — {result.structuralReport.score}/100
              </h2>
              <div className="space-y-2 rounded-md border border-[#1f1f1f] bg-[#121212] p-4">
                {result.structuralReport.findings.map((f, i) => (
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
            </section>

            <section>
              <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[#999]">
                Competitor pages analyzed
              </h2>
              <ul className="space-y-1 rounded-md border border-[#1f1f1f] bg-[#121212] p-4 text-sm text-[#888]">
                {result.gapReport.competitorsAnalyzed.map((c, i) => (
                  <li key={i}>
                    {c.url} — {c.fetchError ? `failed: ${c.fetchError}` : `${c.wordCount} words`}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
