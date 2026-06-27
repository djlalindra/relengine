"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

type StructuralFinding = {
  rule: string;
  passed: boolean;
  detail: string;
};

type PipelineResult = {
  topic: string;
  outline: string;
  draft: string;
  structuralReport: { findings: StructuralFinding[]; score: number };
  outlineRetries: number;
  draftRetries: number;
  altTitles: string[];
  faqSuggestions: string[];
  grounding: {
    used: boolean;
    sourcesSeen: { title: string; url: string }[];
    error?: string;
    source: "manual" | "api" | "none";
  };
};

export default function Home() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [urls, setUrls] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!topic.trim() || running) return;

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

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  async function handleCopy() {
    if (!result) return;
    await navigator.clipboard.writeText(result.draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const urlCount = urls
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean).length;

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
        <form onSubmit={handleGenerate} className="mb-8">
          <label htmlFor="topic" className="mb-2 block text-xs text-[#999]">
            Service or topic to write about
          </label>
          <div className="flex gap-2">
            <input
              id="topic"
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. technical SEO audits for SaaS companies"
              maxLength={200}
              disabled={running}
              className="flex-1 rounded-md border border-[#2a2a2a] bg-[#161616] px-3 py-2 text-sm outline-none focus:border-[#555] focus:ring-1 focus:ring-[#555] disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={running || !topic.trim()}
              className="rounded-md bg-[#e8e8e8] px-4 py-2 text-sm font-medium text-[#0d0d0d] transition hover:bg-white disabled:opacity-50"
            >
              {running ? "Generating..." : "Generate"}
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowUrlInput((v) => !v)}
            className="mt-3 text-xs text-[#888] hover:text-[#e8e8e8]"
          >
            {showUrlInput ? "− Hide" : "+ Add"} real SERP URLs (optional)
          </button>

          {showUrlInput && (
            <div className="mt-2">
              <label htmlFor="urls" className="mb-1.5 block text-xs text-[#999]">
                Paste Google SERP URLs — one per line, or comma-separated
                (e.g. from a CSV export). These will be fetched and used to
                ground the content instead of an automatic search.
              </label>
              <textarea
                id="urls"
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
                placeholder={"https://example.com/page-one\nhttps://example.com/page-two\nhttps://example.com/page-three"}
                rows={5}
                disabled={running}
                className="w-full resize-y rounded-md border border-[#2a2a2a] bg-[#161616] px-3 py-2 text-sm font-mono outline-none focus:border-[#555] focus:ring-1 focus:ring-[#555] disabled:opacity-50"
              />
              <p className="mt-1 text-xs text-[#666]">
                {urlCount > 0
                  ? `${urlCount} URL${urlCount === 1 ? "" : "s"} detected (max 15 used).`
                  : "No URLs entered yet — without these, the app will try to fetch real Google AI Overview data automatically."}
              </p>
            </div>
          )}
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
            <section>
              <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[#999]">
                Grounding —{" "}
                {result.grounding.source === "manual"
                  ? "from URLs you supplied"
                  : result.grounding.source === "api"
                  ? "from live Google AI data"
                  : "none (writer used model knowledge only)"}
              </h2>
              <div className="rounded-md border border-[#1f1f1f] bg-[#121212] p-4">
                {result.grounding.sourcesSeen.length > 0 ? (
                  <ul className="space-y-1.5 text-sm">
                    {result.grounding.sourcesSeen.map((s, i) => (
                      <li key={i}>
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#8ab4f8] hover:underline"
                        >
                          {s.title || s.url}
                        </a>
                        <span className="ml-1.5 text-xs text-[#666]">
                          {s.url}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-[#888]">
                    {result.grounding.error
                      ? `Grounding failed: ${result.grounding.error}`
                      : "No real sources were used for this generation — the writer relied on the model's own training knowledge, not live data."}
                  </p>
                )}
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-medium uppercase tracking-wide text-[#999]">
                  Generated article
                </h2>
                <button
                  onClick={handleCopy}
                  className="text-xs text-[#888] hover:text-[#e8e8e8]"
                >
                  {copied ? "Copied" : "Copy markdown"}
                </button>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-[#1f1f1f] bg-[#121212] p-4 text-sm leading-relaxed text-[#d8d8d8]">
                {result.draft}
              </pre>
            </section>

            <section>
              <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[#999]">
                Structural check — {result.structuralReport.score}/100
              </h2>
              <div className="space-y-2 rounded-md border border-[#1f1f1f] bg-[#121212] p-4">
                {result.structuralReport.findings.map((f, i) => (
                  <div key={i} className="text-sm">
                    <span
                      className={f.passed ? "text-[#6bcf6b]" : "text-[#ff6b6b]"}
                    >
                      {f.passed ? "✓" : "✗"}
                    </span>{" "}
                    <span className="text-[#d8d8d8]">{f.rule}</span>
                    {!f.passed && (
                      <p className="ml-5 mt-0.5 text-xs text-[#888]">
                        {f.detail}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {result.altTitles.length > 0 && (
              <section>
                <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[#999]">
                  Alternate titles
                </h2>
                <ul className="space-y-1.5 rounded-md border border-[#1f1f1f] bg-[#121212] p-4 text-sm text-[#d8d8d8]">
                  {result.altTitles.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </section>
            )}

            {result.faqSuggestions.length > 0 && (
              <section>
                <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[#999]">
                  Additional FAQ candidates
                </h2>
                <ul className="space-y-1.5 rounded-md border border-[#1f1f1f] bg-[#121212] p-4 text-sm text-[#d8d8d8]">
                  {result.faqSuggestions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </section>
            )}

            <p className="text-xs text-[#666]">
              Outline revised {result.outlineRetries}x · Draft revised{" "}
              {result.draftRetries}x
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
