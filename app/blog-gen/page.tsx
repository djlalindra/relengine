"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type {
  BlogGenRun,
  BlogGenInput,
  DocGapOutput,
  Phase0Output,
  Phase1Output,
  Phase2Output,
  Phase3Output,
  Phase4Output,
  Phase5Output,
  Phase6Output,
  Phase7Output,
  Phase8Output,
  Phase9Output,
  Phase10Output,
  Phase12Output,
  Phase115Output,
  Phase13Output,
  SourceBriefOutput,
  SuggestedImage,
} from "@/lib/blog-gen/types";

const STORAGE_KEY = "relengine_blog_gen_v1";
const MAX_HISTORY = 50;

function generateRunId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadHistory(): BlogGenRun[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as BlogGenRun[];
  } catch {
    return [];
  }
}

function saveRun(run: BlogGenRun) {
  const history = loadHistory().filter((r) => r.run_id !== run.run_id);
  history.unshift(run);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

function deleteRun(runId: string) {
  const history = loadHistory().filter((r) => r.run_id !== runId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function slug(keyword: string) {
  return keyword.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function buildResearchDownload(run: BlogGenRun): string {
  const p = run.phases;
  const lines: string[] = [
    `RESEARCH REPORT — "${run.keyword}"`,
    `Generated: ${new Date(run.created_at).toLocaleString()}`,
    "",
    "═══════════════════════════════════════",
    "PHASE 0 — INTENT ANALYSIS",
    "═══════════════════════════════════════",
    `Primary intent: ${p.p0?.primary_intent ?? "—"}`,
    `Scope note: ${p.p0?.scope_note ?? "—"}`,
    "",
    "Sub-intents:",
    ...(p.p0?.sub_intents?.map((s) => `  • ${s}`) ?? ["  —"]),
    "",
    "═══════════════════════════════════════",
    "PHASE 1 — ENTITIES & SEMANTIC CLUSTERS",
    "═══════════════════════════════════════",
    "Core entities:",
    ...(p.p1?.core_entities?.map((e) => `  • ${e}`) ?? ["  —"]),
    "",
    "Semantic clusters:",
    ...(p.p1?.semantic_clusters?.map((c) => `  [${c.cluster}]  ${c.terms.join(", ")}`) ?? ["  —"]),
    "",
    "Notably absent from competitors:",
    ...(p.p1?.notably_absent_from_competitors?.map((e) => `  • ${e}`) ?? ["  —"]),
    "",
    "═══════════════════════════════════════",
    "PHASE 2 — FAN-OUT QUERIES",
    "═══════════════════════════════════════",
    ...(p.p2?.fanout_queries?.map((q, i) => `  ${i + 1}. ${q}`) ?? ["  —"]),
    "",
    "═══════════════════════════════════════",
    "PHASE 3 — SERP & COMPETITOR ANALYSIS",
    "═══════════════════════════════════════",
    `Common format: ${p.p3?.serp_patterns?.common_format ?? "—"}`,
    `Common H1 pattern: ${p.p3?.serp_patterns?.common_h1_pattern ?? "—"}`,
    `Avg word count: ${p.p3?.serp_patterns?.avg_word_count ?? "—"}`,
    "",
    `AI Overview summary: ${p.p3?.ai_overview_summary ?? "—"}`,
    "",
    "Competitor angles:",
    ...(p.p3?.leading_angle_per_competitor?.map((c) => `  [${c.source}]  ${c.angle}`) ?? ["  —"]),
    "",
    "Competitor URLs crawled:",
    ...(p.p3?.competitor_urls?.map((u) => `  • ${u}`) ?? ["  —"]),
    "",
    "═══════════════════════════════════════",
    "PHASE 4 — COVERAGE GAP ANALYSIS",
    "═══════════════════════════════════════",
    "Fully covered by competitors:",
    ...(p.p4?.fully_covered?.map((t) => `  ✓ ${t}`) ?? ["  —"]),
    "",
    "Partially covered:",
    ...(p.p4?.partially_covered?.map((t) => `  ~ ${t}`) ?? ["  —"]),
    "",
    "GAPS (your opportunity):",
    ...(p.p4?.gaps?.map((g) => `  ✗ ${g.topic}\n    Why it matters: ${g.why_it_matters}`) ?? ["  —"]),
    "",
    "═══════════════════════════════════════",
    "PHASE 5 — DIFFERENTIATION STRATEGY",
    "═══════════════════════════════════════",
    `Angle: ${p.p5?.angle_statement ?? "—"}`,
    `Target word count: ${p.p5?.target_word_count ?? "—"}`,
    "",
    "Differentiation points:",
    ...(p.p5?.differentiation_points?.map((d) => `  • ${d}`) ?? ["  —"]),
  ];
  return lines.join("\n");
}

function buildOutlineDownload(run: BlogGenRun): string {
  const p6 = run.phases.p6;
  if (!p6) return "";
  const lines = [
    `OUTLINE — "${run.keyword}"`,
    `Generated: ${new Date(run.created_at).toLocaleString()}`,
    "",
    `H1: ${p6.h1}`,
    "",
    ...(p6.sections?.flatMap((s, i) => [
      `H2 ${i + 1}: ${s.h2}`,
      `  Must answer: ${s.must_answer}`,
      `  Format: ${s.format}${s.needs_citation ? "  |  Citation needed" : ""}`,
      "",
    ]) ?? []),
  ];
  return lines.join("\n");
}

function buildGapReportDownload(run: BlogGenRun): string {
  const g = run.phases.doc_gap;
  if (!g) return "";
  const lines = [
    `DRAFT ANALYSIS REPORT — "${run.keyword}"`,
    `Generated: ${new Date(run.created_at).toLocaleString()}`,
    `Overall score: ${g.overall_score}/100`,
    `Verdict: ${g.overall_verdict}`,
    "",
    "═══════════════════════════════════════",
    "QUICK WINS",
    "═══════════════════════════════════════",
    ...(g.quick_wins?.map((w, i) => `${i + 1}. [${w.impact.toUpperCase()}] ${w.title}\n   ${w.description}`) ?? ["—"]),
    "",
    "═══════════════════════════════════════",
    "MISSING SECTIONS",
    "═══════════════════════════════════════",
    ...(g.missing_sections?.length ? g.missing_sections.map((s, i) => `${i + 1}. ${s.h2}\n   Why needed: ${s.why_needed}\n   Suggested content: ${s.suggested_content}`) : ["None"]),
    "",
    "═══════════════════════════════════════",
    "WEAK SECTIONS",
    "═══════════════════════════════════════",
    ...(g.weak_sections?.length ? g.weak_sections.map((s, i) => `${i + 1}. ${s.heading}\n   Issue: ${s.current_issue}\n   Fix: ${s.specific_fix}`) : ["None"]),
    "",
    "═══════════════════════════════════════",
    "UNSOURCED CLAIMS",
    "═══════════════════════════════════════",
    ...(g.unsourced_claims?.length ? g.unsourced_claims.map((c, i) => `${i + 1}. "${c.claim}"\n   Location: ${c.location}\n   Suggested source type: ${c.suggested_source_type}`) : ["None"]),
    "",
    "═══════════════════════════════════════",
    "MISSING ENTITIES",
    "═══════════════════════════════════════",
    ...(g.missing_entities?.length ? g.missing_entities.map((e) => `• ${e.entity} (${e.type}) — add to: ${e.where_to_add}`) : ["None"]),
    "",
    "═══════════════════════════════════════",
    "E-E-A-T GAPS",
    "═══════════════════════════════════════",
    ...(g.eeat_gaps?.length ? g.eeat_gaps.map((e, i) => `${i + 1}. ${e.signal}\n   Current: ${e.current}\n   Fix: ${e.fix}`) : ["None"]),
    "",
    "═══════════════════════════════════════",
    "STRUCTURAL ISSUES",
    "═══════════════════════════════════════",
    ...(g.structural_issues?.length ? g.structural_issues.map((s, i) => `${i + 1}. ${s.issue}\n   Location: ${s.location}\n   Fix: ${s.fix}`) : ["None"]),
  ];
  return lines.join("\n");
}

function buildSourcesDownload(run: BlogGenRun): string {
  const { p8, p9, p10 } = run.phases;
  const lines = [
    `SOURCES & FACT-CHECK — "${run.keyword}"`,
    `Generated: ${new Date(run.created_at).toLocaleString()}`,
    "",
    "═══════════════════════════════════════",
    "SOURCED CLAIMS",
    "═══════════════════════════════════════",
    ...(p8?.sourced_claims?.map((c, i) => [
      `${i + 1}. ${c.claim}`,
      `   Source: ${c.source_title} (${c.source_url})`,
      `   Type: ${c.source_type}  |  Supports: ${c.supports_claim ? "yes" : "no"}`,
      c.author ? `   Author: ${c.author}${c.year ? `, ${c.year}` : ""}` : "",
    ].filter(Boolean).join("\n")) ?? ["—"]),
    "",
    "═══════════════════════════════════════",
    "CORRECTIONS APPLIED",
    "═══════════════════════════════════════",
    ...(p9?.corrections_needed?.length
      ? p9.corrections_needed.map((c, i) => `${i + 1}. [${c.location}] ${c.issue}\n   Fix: ${c.fix}`)
      : ["None"]),
    "",
    "═══════════════════════════════════════",
    "HARVARD REFERENCES",
    "═══════════════════════════════════════",
    ...(p10?.harvard_references?.map((r, i) => `${i + 1}. ${r}`) ?? ["—"]),
  ];
  return lines.join("\n");
}

async function streamPhase(
  url: string,
  body: object,
  onProgress: (msg: string) => void,
  signal: AbortSignal
): Promise<unknown> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: unknown = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const evt = JSON.parse(line.slice(6)) as {
        type: string;
        step?: string;
        error?: string;
        phase?: string;
        data?: unknown;
      };
      if (evt.type === "progress" && evt.step) onProgress(evt.step);
      if (evt.type === "error") throw new Error(evt.error ?? "Unknown error");
      if (evt.type === "result") result = evt.data;
    }
  }

  return result;
}

const PHASE_LABELS = [
  { key: "research", label: "Research", subtitle: "Intent · Entities · Fan-out · Gap analysis" },
  { key: "outline", label: "Outline", subtitle: "Answer-first structure" },
  { key: "source_brief", label: "Source Brief", subtitle: "Real stats & authoritative URLs before drafting" },
  { key: "draft", label: "Draft", subtitle: "Full article with real citations (Claude Sonnet 5)" },
  { key: "factcheck", label: "Fact-check", subtitle: "Verify · Images · Harvard refs" },
  { key: "polish", label: "E-E-A-T", subtitle: "Expertise signals (Claude Sonnet 5)" },
  { key: "humanize", label: "Humanize", subtitle: "Remove AI tells (Claude Sonnet 5)" },
  { key: "critic", label: "Critic", subtitle: "QA gate (Gemini)" },
];

type PhaseKey = typeof PHASE_LABELS[number]["key"];

type RerunState = {
  phase: PhaseKey;
  comment: string;
  loading: boolean;
};

export default function BlogGenPage() {
  const [input, setInput] = useState<BlogGenInput>({ keyword: "" });
  const [run, setRun] = useState<BlogGenRun | null>(null);
  const [activePhase, setActivePhase] = useState<PhaseKey | null>(null);
  const [progressMsg, setProgressMsg] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<BlogGenRun[]>(() => {
    if (typeof window !== "undefined") return loadHistory();
    return [];
  });
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingClean, setExportingClean] = useState(false);
  const [rerunState, setRerunState] = useState<RerunState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Upload-and-analyse mode
  const [mode, setMode] = useState<"generate" | "analyse">("generate");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<"idle" | "extracting" | "done" | "error">("idle");
  const [uploadedText, setUploadedText] = useState("");
  const [uploadWordCount, setUploadWordCount] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateRun = useCallback((updater: (prev: BlogGenRun) => BlogGenRun) => {
    setRun((prev) => {
      if (!prev) return prev;
      const next = updater(prev);
      saveRun(next);
      setHistory(loadHistory());
      return next;
    });
  }, []);

  async function handleFileUpload(file: File) {
    setUploadFile(file);
    setUploadState("extracting");
    setUploadError("");
    setUploadedText("");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const resp = await fetch("/api/blog-gen/extract-doc", { method: "POST", body: formData });
      const data = await resp.json() as { text?: string; word_count?: number; suggested_keyword?: string; core_topic?: string; error?: string };
      if (!resp.ok || data.error) throw new Error(data.error ?? "Extraction failed.");

      setUploadedText(data.text ?? "");
      setUploadWordCount(data.word_count ?? 0);
      if (data.suggested_keyword && !input.keyword.trim()) {
        setInput((p) => ({ ...p, keyword: data.suggested_keyword! }));
      }
      setUploadState("done");
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Failed to read file.");
      setUploadState("error");
    }
  }

  async function runAnalysePipeline() {
    if (!input.keyword.trim()) { setError("Enter a keyword to continue."); return; }
    if (!uploadedText) { setError("Upload a document first."); return; }
    setError("");

    const runId = generateRunId();
    const keyword = input.keyword.trim();
    const newRun: BlogGenRun = {
      run_id: runId,
      keyword,
      status: "RUNNING",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      input,
      phases: {},
      uploaded_article_text: uploadedText,
    };
    setRun(newRun);
    saveRun(newRun);
    setHistory(loadHistory());

    const abort = new AbortController();
    abortRef.current = abort;
    const progress = (msg: string) => setProgressMsg(msg);
    const update = (updater: (prev: BlogGenRun) => BlogGenRun) => updateRun(updater);

    try {
      setActivePhase("research");
      const research = await streamPhase(
        "/api/blog-gen/research",
        { ...input, keyword },
        progress, abort.signal
      ) as { p0?: Phase0Output; p1?: Phase1Output; p2?: Phase2Output; p3?: Phase3Output; p4?: Phase4Output; p5?: Phase5Output };
      update((r) => ({ ...r, phases: { ...r.phases, p0: research.p0, p1: research.p1, p2: research.p2, p3: research.p3, p4: research.p4, p5: research.p5 }, updated_at: new Date().toISOString() }));

      setActivePhase("outline");
      const outline = await streamPhase(
        "/api/blog-gen/outline",
        { keyword, research },
        progress, abort.signal
      ) as Phase6Output;
      update((r) => ({ ...r, phases: { ...r.phases, p6: outline }, updated_at: new Date().toISOString() }));

      setActivePhase("doc_gap" as PhaseKey);
      const docGap = await streamPhase(
        "/api/blog-gen/doc-gap",
        { article_text: uploadedText, keyword, research, ideal_outline: outline },
        progress, abort.signal
      ) as DocGapOutput;
      update((r) => ({ ...r, phases: { ...r.phases, doc_gap: docGap }, updated_at: new Date().toISOString() }));

      setActivePhase("polish");
      const eeat = await streamPhase(
        "/api/blog-gen/polish",
        { draft_markdown: uploadedText, manual_eeat_notes: input.manual_eeat_notes ?? "" },
        progress, abort.signal
      ) as Phase12Output;
      update((r) => ({ ...r, phases: { ...r.phases, p12: eeat }, updated_at: new Date().toISOString() }));

      setActivePhase("critic");
      const critic = await streamPhase(
        "/api/blog-gen/critic",
        { final_markdown: uploadedText },
        progress, abort.signal
      ) as Phase13Output;
      update((r) => ({
        ...r,
        phases: { ...r.phases, p13: critic },
        status: critic.gate_result === "PASS" ? "COMPLETE" : "FAILED_QA_GATE",
        updated_at: new Date().toISOString(),
      }));

      setActivePhase(null);
      setProgressMsg("");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Analysis failed.");
      setActivePhase(null);
      updateRun((r) => ({ ...r, updated_at: new Date().toISOString() }));
    }
  }

  async function runFullPipeline() {
    if (!input.keyword.trim()) { setError("Enter a keyword to continue."); return; }
    setError("");

    const runId = generateRunId();
    const newRun: BlogGenRun = {
      run_id: runId,
      keyword: input.keyword.trim(),
      status: "RUNNING",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      input,
      phases: {},
    };
    setRun(newRun);
    saveRun(newRun);
    setHistory(loadHistory());

    const abort = new AbortController();
    abortRef.current = abort;

    const progress = (msg: string) => setProgressMsg(msg);
    const update = (updater: (prev: BlogGenRun) => BlogGenRun) => updateRun(updater);

    try {
      setActivePhase("research");
      const research = await streamPhase(
        "/api/blog-gen/research",
        { ...input, keyword: input.keyword.trim() },
        progress, abort.signal
      ) as { p0?: Phase0Output; p1?: Phase1Output; p2?: Phase2Output; p3?: Phase3Output; p4?: Phase4Output; p5?: Phase5Output };

      update((r) => ({
        ...r,
        phases: { ...r.phases, p0: research.p0, p1: research.p1, p2: research.p2, p3: research.p3, p4: research.p4, p5: research.p5 },
        updated_at: new Date().toISOString(),
      }));

      setActivePhase("outline");
      const outline = await streamPhase(
        "/api/blog-gen/outline",
        { keyword: input.keyword.trim(), research },
        progress, abort.signal
      ) as Phase6Output;

      update((r) => ({ ...r, phases: { ...r.phases, p6: outline }, updated_at: new Date().toISOString() }));

      setActivePhase("source_brief");
      let sourceBrief: SourceBriefOutput | undefined;
      try {
        sourceBrief = await streamPhase(
          "/api/blog-gen/source-brief",
          { keyword: input.keyword.trim(), outline },
          progress, abort.signal
        ) as SourceBriefOutput;
        update((r) => ({ ...r, phases: { ...r.phases, source_brief: sourceBrief }, updated_at: new Date().toISOString() }));
      } catch {
        // source brief is best-effort — draft proceeds without it if it fails
      }

      const sourceBriefText = sourceBrief?.sources?.length
        ? sourceBrief.sources.map((s) => `- ${s.stat_or_finding} [${s.source_label}](${s.url}) → supports: ${s.section_relevance}`).join("\n")
        : undefined;

      setActivePhase("draft");
      const draft = await streamPhase(
        "/api/blog-gen/draft",
        {
          outline,
          research,
          target_word_count: research.p5?.target_word_count ?? 1800,
          manual_eeat_notes: input.manual_eeat_notes ?? "",
          source_brief: sourceBriefText,
        },
        progress, abort.signal
      ) as Phase7Output;

      update((r) => ({ ...r, phases: { ...r.phases, p7: draft }, updated_at: new Date().toISOString() }));

      setActivePhase("factcheck");
      const factcheck = await streamPhase(
        "/api/blog-gen/factcheck",
        { keyword: input.keyword.trim(), draft_markdown: draft.draft_markdown ?? "", placeholders: draft.placeholders_needing_sources ?? [] },
        progress, abort.signal
      ) as { p9?: Phase9Output; p10?: Phase10Output; corrected_markdown?: string; sourced_claims?: Phase8Output["sourced_claims"]; suggested_images?: SuggestedImage[] };

      update((r) => ({
        ...r,
        phases: {
          ...r.phases,
          p8: { sourced_claims: factcheck.sourced_claims ?? [], suggested_images: factcheck.suggested_images ?? [] },
          p9: factcheck.p9,
          p10: factcheck.p10,
        },
        updated_at: new Date().toISOString(),
      }));

      if (factcheck.suggested_images?.length) {
        progress("Downloading authoritative images…");
        try {
          const imgResp = await fetch("/api/blog-gen/images", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ images: factcheck.suggested_images, run_id: newRun.run_id }),
            signal: abort.signal,
          });
          if (imgResp.ok) {
            const { images: savedImages } = await imgResp.json() as { images: SuggestedImage[] };
            update((r) => ({
              ...r,
              phases: { ...r.phases, p8: { sourced_claims: r.phases.p8?.sourced_claims ?? [], suggested_images: savedImages } },
            }));
          }
        } catch { /* images optional */ }
      }

      const draftForPolish = factcheck.corrected_markdown ?? draft.draft_markdown ?? "";

      setActivePhase("polish");
      const eeat = await streamPhase(
        "/api/blog-gen/polish",
        { draft_markdown: draftForPolish, manual_eeat_notes: input.manual_eeat_notes ?? "" },
        progress, abort.signal
      ) as Phase12Output;

      update((r) => ({ ...r, phases: { ...r.phases, p12: eeat }, updated_at: new Date().toISOString() }));

      setActivePhase("humanize");
      const humanized = await streamPhase(
        "/api/blog-gen/humanize",
        { draft_markdown: eeat.revised_markdown ?? draftForPolish },
        progress, abort.signal
      ) as Phase115Output;

      update((r) => ({ ...r, phases: { ...r.phases, p115: humanized }, updated_at: new Date().toISOString() }));

      const finalMarkdown = humanized.revised_draft ?? eeat.revised_markdown ?? draftForPolish;

      setActivePhase("critic");
      const critic = await streamPhase(
        "/api/blog-gen/critic",
        { final_markdown: finalMarkdown },
        progress, abort.signal
      ) as Phase13Output;

      update((r) => ({
        ...r,
        phases: { ...r.phases, p13: critic },
        final_markdown: finalMarkdown,
        status: critic.gate_result === "PASS" ? "COMPLETE" : "FAILED_QA_GATE",
        updated_at: new Date().toISOString(),
      }));

      setActivePhase(null);
      setProgressMsg("");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Pipeline failed.");
      setActivePhase(null);
      updateRun((r) => ({ ...r, updated_at: new Date().toISOString() }));
    }
  }

  async function rerunPhase(startPhase: PhaseKey, comment: string) {
    if (!run) return;
    setError("");

    const abort = new AbortController();
    abortRef.current = abort;
    const progress = (msg: string) => setProgressMsg(msg);

    const PHASE_ORDER: PhaseKey[] = ["research", "outline", "source_brief", "draft", "factcheck", "polish", "humanize", "critic"];
    const startIdx = PHASE_ORDER.indexOf(startPhase);

    // Seed local data from current run — updated as each phase produces fresh output
    let researchData = { p0: run.phases.p0, p1: run.phases.p1, p2: run.phases.p2, p3: run.phases.p3, p4: run.phases.p4, p5: run.phases.p5 };
    let outlineData: Phase6Output | undefined = run.phases.p6;
    let sourceBriefData: SourceBriefOutput | undefined = run.phases.source_brief;
    let draftData: Phase7Output | undefined = run.phases.p7;
    let correctedMd: string | undefined;
    let p8Data = run.phases.p8;
    let p9Data = run.phases.p9;
    let p10Data = run.phases.p10;
    let eeatData: Phase12Output | undefined = run.phases.p12;
    let humanizedData: Phase115Output | undefined = run.phases.p115;

    try {
      for (let i = startIdx; i < PHASE_ORDER.length; i++) {
        const phase = PHASE_ORDER[i];
        const isTarget = i === startIdx;
        const phaseComment = isTarget ? comment : undefined;

        setRerunState({ phase, comment, loading: true });

        if (phase === "research") {
          researchData = await streamPhase(
            "/api/blog-gen/research",
            { ...run.input, keyword: run.keyword, rerun_comment: phaseComment },
            progress, abort.signal
          ) as typeof researchData;
          updateRun((r) => ({
            ...r,
            phases: { ...r.phases, p0: researchData.p0, p1: researchData.p1, p2: researchData.p2, p3: researchData.p3, p4: researchData.p4, p5: researchData.p5 },
            updated_at: new Date().toISOString(),
          }));

        } else if (phase === "outline") {
          outlineData = await streamPhase(
            "/api/blog-gen/outline",
            { keyword: run.keyword, research: researchData, rerun_comment: phaseComment },
            progress, abort.signal
          ) as Phase6Output;
          updateRun((r) => ({ ...r, phases: { ...r.phases, p6: outlineData }, updated_at: new Date().toISOString() }));

        } else if (phase === "source_brief") {
          try {
            sourceBriefData = await streamPhase(
              "/api/blog-gen/source-brief",
              { keyword: run.keyword, outline: outlineData },
              progress, abort.signal
            ) as SourceBriefOutput;
            updateRun((r) => ({ ...r, phases: { ...r.phases, source_brief: sourceBriefData }, updated_at: new Date().toISOString() }));
          } catch { /* best-effort */ }

        } else if (phase === "draft") {
          const sourceBriefText = sourceBriefData?.sources?.length
            ? sourceBriefData.sources.map((s) => `- ${s.stat_or_finding} [${s.source_label}](${s.url}) → supports: ${s.section_relevance}`).join("\n")
            : undefined;
          draftData = await streamPhase(
            "/api/blog-gen/draft",
            {
              outline: outlineData,
              research: researchData,
              target_word_count: researchData.p5?.target_word_count ?? 1800,
              manual_eeat_notes: run.input.manual_eeat_notes ?? "",
              source_brief: sourceBriefText,
              rerun_comment: phaseComment,
            },
            progress, abort.signal
          ) as Phase7Output;
          updateRun((r) => ({ ...r, phases: { ...r.phases, p7: draftData }, updated_at: new Date().toISOString() }));

        } else if (phase === "factcheck") {
          const factcheck = await streamPhase(
            "/api/blog-gen/factcheck",
            {
              keyword: run.keyword,
              draft_markdown: draftData?.draft_markdown ?? "",
              placeholders: draftData?.placeholders_needing_sources ?? [],
              rerun_comment: phaseComment,
            },
            progress, abort.signal
          ) as { p9?: Phase9Output; p10?: Phase10Output; corrected_markdown?: string; sourced_claims?: Phase8Output["sourced_claims"]; suggested_images?: SuggestedImage[] };
          correctedMd = factcheck.corrected_markdown;
          p8Data = { sourced_claims: factcheck.sourced_claims ?? [], suggested_images: factcheck.suggested_images ?? [] };
          p9Data = factcheck.p9;
          p10Data = factcheck.p10;
          updateRun((r) => ({
            ...r,
            phases: { ...r.phases, p8: p8Data, p9: p9Data, p10: p10Data },
            updated_at: new Date().toISOString(),
          }));

        } else if (phase === "polish") {
          const draftForPolish = correctedMd ?? draftData?.draft_markdown ?? "";
          eeatData = await streamPhase(
            "/api/blog-gen/polish",
            { draft_markdown: draftForPolish, manual_eeat_notes: run.input.manual_eeat_notes ?? "", rerun_comment: phaseComment },
            progress, abort.signal
          ) as Phase12Output;
          updateRun((r) => ({ ...r, phases: { ...r.phases, p12: eeatData }, updated_at: new Date().toISOString() }));

        } else if (phase === "humanize") {
          const draftForHumanize = eeatData?.revised_markdown ?? correctedMd ?? draftData?.draft_markdown ?? "";
          humanizedData = await streamPhase(
            "/api/blog-gen/humanize",
            { draft_markdown: draftForHumanize, rerun_comment: phaseComment },
            progress, abort.signal
          ) as Phase115Output;
          updateRun((r) => ({ ...r, phases: { ...r.phases, p115: humanizedData }, updated_at: new Date().toISOString() }));

        } else if (phase === "critic") {
          const finalMd = humanizedData?.revised_draft ?? eeatData?.revised_markdown ?? correctedMd ?? draftData?.draft_markdown ?? "";
          const critic = await streamPhase(
            "/api/blog-gen/critic",
            { final_markdown: finalMd, rerun_comment: phaseComment },
            progress, abort.signal
          ) as Phase13Output;
          updateRun((r) => ({
            ...r,
            phases: { ...r.phases, p13: critic },
            final_markdown: finalMd,
            status: critic.gate_result === "PASS" ? "COMPLETE" : "FAILED_QA_GATE",
            updated_at: new Date().toISOString(),
          }));
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof Error ? err.message : `Rerun failed.`);
    } finally {
      setRerunState(null);
      setProgressMsg("");
    }
  }

  function stopPipeline() {
    abortRef.current?.abort();
    setActivePhase(null);
    setProgressMsg("");
    setRerunState(null);
  }

  async function exportDocx(r: BlogGenRun, cleanOnly = false) {
    if (cleanOnly) setExportingClean(true);
    else setExporting(true);
    try {
      const resp = await fetch("/api/blog-gen/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run: r, clean_only: cleanOnly }),
      });
      if (!resp.ok) throw new Error("Export failed");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const prefix = cleanOnly ? "article" : "blog";
      a.download = `${prefix}-${slug(r.keyword)}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
      setExportingClean(false);
    }
  }

  const completedPhases = run
    ? PHASE_LABELS.filter((p) => {
        if (p.key === "research") return !!run.phases.p0;
        if (p.key === "outline") return !!run.phases.p6;
        if (p.key === "source_brief") return !!run.phases.source_brief;
        if (p.key === "draft") return !!run.phases.p7;
        if (p.key === "factcheck") return !!run.phases.p9;
        if (p.key === "polish") return !!run.phases.p12;
        if (p.key === "humanize") return !!run.phases.p115;
        if (p.key === "critic") return !!run.phases.p13;
        return false;
      }).map((p) => p.key)
    : [];

  const isRunning = !!activePhase || rerunState?.loading;

  return (
    <div className="flex min-h-screen bg-[var(--background)]">
      {/* Sidebar — history */}
      <aside className={`fixed inset-y-0 left-0 z-20 w-72 bg-[var(--card)] border-r border-[var(--border)] flex flex-col transition-transform duration-200 ${showHistory ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex items-center justify-between p-4 border-b border-[var(--border)]">
          <span className="text-sm font-semibold text-[var(--foreground)]">Run History</span>
          <button onClick={() => setShowHistory(false)} className="text-[var(--muted)] hover:text-[var(--foreground)] text-lg">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {history.length === 0 && <p className="text-xs text-[var(--muted)] p-3">No runs yet.</p>}
          {history.map((h) => (
            <div key={h.run_id} className="group rounded-lg border border-[var(--border)] p-3 hover:bg-slate-50 cursor-pointer" onClick={() => { setRun(h); setShowHistory(false); }}>
              <p className="text-sm font-medium text-[var(--foreground)] truncate">{h.keyword}</p>
              <p className="text-xs text-[var(--muted)]">{new Date(h.created_at).toLocaleDateString()} · {h.status}</p>
              <div className="mt-2 flex gap-1 opacity-0 group-hover:opacity-100 transition">
                <button onClick={(e) => { e.stopPropagation(); exportDocx(h); }} className="text-xs px-2 py-0.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]">.docx</button>
                <button onClick={(e) => { e.stopPropagation(); deleteRun(h.run_id); setHistory(loadHistory()); if (run?.run_id === h.run_id) setRun(null); }} className="text-xs px-2 py-0.5 rounded border border-red-200 text-red-500 hover:bg-red-50">Delete</button>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {showHistory && <div className="fixed inset-0 z-10 bg-black/20" onClick={() => setShowHistory(false)} />}

      {/* Main */}
      <div className="flex-1 flex flex-col max-w-4xl mx-auto px-4 py-8 w-full">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] text-sm font-bold">B</span>
            <div>
              <h1 className="text-lg font-semibold text-[var(--foreground)]">Blog Generator</h1>
              <p className="text-xs text-[var(--muted)]">AEO/GEO · 7-agent pipeline · Harvard refs</p>
            </div>
          </div>
          <button onClick={() => setShowHistory(true)} className="text-sm px-3 py-1.5 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]">
            History ({history.length})
          </button>
        </div>

        {/* Input form */}
        {!run && (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-6 space-y-4">
            {/* Mode toggle */}
            <div className="flex gap-1 rounded-lg border border-[var(--border)] p-1 bg-slate-50">
              <button
                onClick={() => setMode("generate")}
                className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${mode === "generate" ? "bg-white shadow-sm text-[var(--foreground)]" : "text-[var(--muted)] hover:text-[var(--foreground)]"}`}
              >
                Generate new article
              </button>
              <button
                onClick={() => setMode("analyse")}
                className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${mode === "analyse" ? "bg-white shadow-sm text-[var(--foreground)]" : "text-[var(--muted)] hover:text-[var(--foreground)]"}`}
              >
                Analyse existing draft
              </button>
            </div>

            {/* Upload zone — analyse mode only */}
            {mode === "analyse" && (
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".docx,.txt,.md"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); }}
                />
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFileUpload(f); }}
                  className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-6 text-center transition ${uploadState === "done" ? "border-green-300 bg-green-50" : "border-[var(--border)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"}`}
                >
                  {uploadState === "idle" && (
                    <>
                      <p className="text-sm font-medium text-[var(--foreground)]">Drop your draft here or click to upload</p>
                      <p className="text-xs text-[var(--muted)] mt-1">.docx · .txt · .md</p>
                    </>
                  )}
                  {uploadState === "extracting" && (
                    <p className="text-sm text-[var(--accent)]">Reading document…</p>
                  )}
                  {uploadState === "done" && (
                    <>
                      <p className="text-sm font-medium text-green-700">{uploadFile?.name}</p>
                      <p className="text-xs text-green-600 mt-0.5">{uploadWordCount.toLocaleString()} words extracted</p>
                    </>
                  )}
                  {uploadState === "error" && (
                    <p className="text-sm text-red-600">{uploadError}</p>
                  )}
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-[var(--muted)] mb-1">
                Keyword / Topic *
                {mode === "analyse" && uploadState === "done" && <span className="ml-1 font-normal">(auto-detected from doc — override if needed)</span>}
              </label>
              <input type="text" value={input.keyword} onChange={(e) => setInput((p) => ({ ...p, keyword: e.target.value }))} placeholder="e.g. best CRM software for small businesses" className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]" onKeyDown={(e) => { if (e.key === "Enter" && mode === "generate") runFullPipeline(); }} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--muted)] mb-1">Target Audience</label>
                <input type="text" value={input.target_audience ?? ""} onChange={(e) => setInput((p) => ({ ...p, target_audience: e.target.value }))} placeholder="e.g. startup founders" className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)]" />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--muted)] mb-1">Business Context</label>
                <input type="text" value={input.business_context ?? ""} onChange={(e) => setInput((p) => ({ ...p, business_context: e.target.value }))} placeholder="e.g. SaaS company selling CRM" className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)]" />
              </div>
            </div>
            {mode === "generate" && (
              <div>
                <label className="block text-xs font-medium text-[var(--muted)] mb-1">Existing URL <span className="font-normal text-[var(--muted)]">(optional)</span></label>
                <input type="url" value={input.existing_url ?? ""} onChange={(e) => setInput((p) => ({ ...p, existing_url: e.target.value }))} placeholder="https://yoursite.com/existing-article" className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)]" />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-[var(--muted)] mb-1">E-E-A-T Notes <span className="font-normal text-[var(--muted)]">(personal experience, credentials)</span></label>
              <textarea value={input.manual_eeat_notes ?? ""} onChange={(e) => setInput((p) => ({ ...p, manual_eeat_notes: e.target.value }))} placeholder="e.g. We ran this exact test across 12 clients in 2024 and found..." rows={3} className="w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] resize-none" />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            {mode === "generate" ? (
              <button onClick={runFullPipeline} className="w-full rounded-lg bg-[var(--accent)] py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition">Generate Article</button>
            ) : (
              <button
                onClick={runAnalysePipeline}
                disabled={uploadState !== "done"}
                className="w-full rounded-lg bg-violet-600 py-2.5 text-sm font-medium text-white hover:bg-violet-700 transition disabled:opacity-40"
              >
                {uploadState === "extracting" ? "Reading document…" : "Analyse Draft"}
              </button>
            )}
          </div>
        )}

        {/* Active run */}
        {run && (
          <div className="space-y-6">
            {/* Run header */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-[var(--foreground)]">{run.keyword}</h2>
                <p className="text-xs text-[var(--muted)]">{run.status} · {new Date(run.created_at).toLocaleString()}</p>
              </div>
              <div className="flex gap-2 flex-wrap justify-end">
                {isRunning && (
                  <button onClick={stopPipeline} className="text-sm px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50">Stop</button>
                )}
                {!isRunning && (
                  <>
                    {run.phases.doc_gap && (
                      <button
                        onClick={() => downloadText(`gap-report-${slug(run.keyword)}.txt`, buildGapReportDownload(run))}
                        className="text-sm px-3 py-1.5 rounded-lg border border-violet-200 text-violet-700 hover:bg-violet-50"
                      >
                        Download Gap Report .txt
                      </button>
                    )}
                    {run.final_markdown && (
                      <>
                        <button onClick={() => exportDocx(run, true)} disabled={exportingClean} className="text-sm px-3 py-1.5 rounded-lg border border-green-200 text-green-700 hover:bg-green-50 disabled:opacity-50">
                          {exportingClean ? "Exporting…" : "Download Article .docx"}
                        </button>
                        <button onClick={() => exportDocx(run, false)} disabled={exporting} className="text-sm px-3 py-1.5 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50">
                          {exporting ? "Exporting…" : "Full Report .docx"}
                        </button>
                      </>
                    )}
                    <button onClick={() => { setRun(null); setInput({ keyword: "" }); setError(""); }} className="text-sm px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white hover:bg-blue-700">New run</button>
                  </>
                )}
              </div>
            </div>

            {/* Phase tracker */}
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
              <div className="flex gap-2 flex-wrap">
                {PHASE_LABELS.map((p, i) => {
                  const isDone = completedPhases.includes(p.key);
                  const isActive = activePhase === p.key || rerunState?.phase === p.key;
                  return (
                    <div key={p.key} className="flex items-center gap-1.5">
                      <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${isDone ? "bg-green-50 text-green-700 border border-green-200" : isActive ? "bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]" : "bg-slate-50 text-[var(--muted)] border border-[var(--border)]"}`}>
                        {isDone ? "✓" : isActive ? "⟳" : String(i + 1)} {p.label}
                      </div>
                      {i < PHASE_LABELS.length - 1 && <span className="text-[var(--muted)] text-xs">→</span>}
                    </div>
                  );
                })}
              </div>
              {progressMsg && <p className="mt-3 text-xs text-[var(--muted)] animate-pulse">{progressMsg}</p>}
            </div>

            {/* QA Gate result */}
            {run.phases.p13 && (
              <div className={`rounded-xl border p-4 ${run.phases.p13.gate_result === "PASS" ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-sm font-semibold ${run.phases.p13.gate_result === "PASS" ? "text-green-700" : "text-amber-700"}`}>QA Gate: {run.phases.p13.gate_result}</span>
                  <span className="text-xs text-[var(--muted)]">AI signal: {run.phases.p115?.band ?? "—"} ({run.phases.p115?.post_edit_signal_score ?? "—"}/100)</span>
                </div>
                {run.phases.p13.failing_items?.length > 0 && (
                  <ul className="text-xs text-amber-700 space-y-0.5 list-disc list-inside">
                    {run.phases.p13.failing_items.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                )}
              </div>
            )}

            {/* Doc Gap Analysis panel — analyse mode only */}
            {run.phases.doc_gap && (
              <div className="rounded-xl border border-violet-200 bg-violet-50 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-violet-800">Draft Analysis Report</p>
                    <p className="text-xs text-violet-600 mt-0.5">Overall score: {run.phases.doc_gap.overall_score}/100 — {run.phases.doc_gap.overall_verdict}</p>
                  </div>
                </div>

                {run.phases.doc_gap.quick_wins?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-violet-700 mb-2">Quick Wins</p>
                    <div className="space-y-2">
                      {run.phases.doc_gap.quick_wins.map((w, i) => (
                        <div key={i} className="flex gap-2 rounded-lg bg-white border border-violet-100 px-3 py-2">
                          <span className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${w.impact === "high" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>{w.impact}</span>
                          <div>
                            <p className="text-xs font-medium text-[var(--foreground)]">{w.title}</p>
                            <p className="text-xs text-[var(--muted)]">{w.description}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {run.phases.doc_gap.missing_sections?.length > 0 && (
                  <details className="group">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-violet-700 list-none flex items-center gap-1">
                      <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
                      Missing sections ({run.phases.doc_gap.missing_sections.length})
                    </summary>
                    <div className="mt-2 space-y-2">
                      {run.phases.doc_gap.missing_sections.map((s, i) => (
                        <div key={i} className="rounded-lg bg-white border border-violet-100 px-3 py-2">
                          <p className="text-xs font-medium text-[var(--foreground)]">{s.h2}</p>
                          <p className="text-xs text-[var(--muted)] mt-0.5">{s.why_needed}</p>
                          {s.suggested_content && <p className="text-xs text-violet-700 mt-1 italic">{s.suggested_content}</p>}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {run.phases.doc_gap.weak_sections?.length > 0 && (
                  <details className="group">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-violet-700 list-none flex items-center gap-1">
                      <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
                      Weak sections ({run.phases.doc_gap.weak_sections.length})
                    </summary>
                    <div className="mt-2 space-y-2">
                      {run.phases.doc_gap.weak_sections.map((s, i) => (
                        <div key={i} className="rounded-lg bg-white border border-violet-100 px-3 py-2">
                          <p className="text-xs font-medium text-[var(--foreground)]">{s.heading}</p>
                          <p className="text-xs text-red-600 mt-0.5">{s.current_issue}</p>
                          <p className="text-xs text-green-700 mt-1">Fix: {s.specific_fix}</p>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {run.phases.doc_gap.unsourced_claims?.length > 0 && (
                  <details className="group">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-violet-700 list-none flex items-center gap-1">
                      <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
                      Unsourced claims ({run.phases.doc_gap.unsourced_claims.length})
                    </summary>
                    <div className="mt-2 space-y-2">
                      {run.phases.doc_gap.unsourced_claims.map((c, i) => (
                        <div key={i} className="rounded-lg bg-white border border-violet-100 px-3 py-2">
                          <p className="text-xs text-[var(--foreground)] italic">"{c.claim}"</p>
                          <p className="text-xs text-[var(--muted)] mt-0.5">In: {c.location} · Suggested source: {c.suggested_source_type}</p>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {run.phases.doc_gap.missing_entities?.length > 0 && (
                  <details className="group">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-violet-700 list-none flex items-center gap-1">
                      <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
                      Missing entities ({run.phases.doc_gap.missing_entities.length})
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {run.phases.doc_gap.missing_entities.map((e, i) => (
                        <span key={i} title={`Add to: ${e.where_to_add}`} className="rounded-full bg-white border border-violet-200 px-2 py-0.5 text-xs text-violet-700">{e.entity}</span>
                      ))}
                    </div>
                  </details>
                )}

                {run.phases.doc_gap.eeat_gaps?.length > 0 && (
                  <details className="group">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-violet-700 list-none flex items-center gap-1">
                      <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
                      E-E-A-T gaps ({run.phases.doc_gap.eeat_gaps.length})
                    </summary>
                    <div className="mt-2 space-y-2">
                      {run.phases.doc_gap.eeat_gaps.map((g, i) => (
                        <div key={i} className="rounded-lg bg-white border border-violet-100 px-3 py-2">
                          <p className="text-xs font-medium text-[var(--foreground)]">{g.signal}</p>
                          <p className="text-xs text-[var(--muted)] mt-0.5">{g.current}</p>
                          <p className="text-xs text-green-700 mt-1">Fix: {g.fix}</p>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}

            {/* Phase panels */}
            <div className="space-y-3">

              {/* Research */}
              {run.phases.p5 && (
                <PhasePanel
                  title="Research"
                  badge={`${run.phases.p4?.gaps?.length ?? 0} gaps · ${run.phases.p5.target_word_count} word target`}
                  expanded={expandedPhase === "research"}
                  onToggle={() => setExpandedPhase(expandedPhase === "research" ? null : "research")}
                  onDownload={() => downloadText(`research-${slug(run.keyword)}.txt`, buildResearchDownload(run))}
                  onRerun={!isRunning ? () => setRerunState({ phase: "research", comment: "", loading: false }) : undefined}
                  rerunActive={rerunState?.phase === "research"}
                  rerunComment={rerunState?.phase === "research" ? rerunState.comment : ""}
                  onRerunCommentChange={(c) => setRerunState((s) => s ? { ...s, comment: c } : s)}
                  onRerunSubmit={() => { if (rerunState) rerunPhase("research", rerunState.comment); }}
                  onRerunCancel={() => setRerunState(null)}
                  rerunLoading={rerunState?.phase === "research" && rerunState.loading}
                >
                  <ResearchContent run={run} />
                </PhasePanel>
              )}

              {/* Outline */}
              {run.phases.p6 && (
                <PhasePanel
                  title="Outline"
                  badge={`${run.phases.p6.sections?.length ?? 0} sections`}
                  expanded={expandedPhase === "outline"}
                  onToggle={() => setExpandedPhase(expandedPhase === "outline" ? null : "outline")}
                  onDownload={() => downloadText(`outline-${slug(run.keyword)}.txt`, buildOutlineDownload(run))}
                  onRerun={!isRunning ? () => setRerunState({ phase: "outline", comment: "", loading: false }) : undefined}
                  rerunActive={rerunState?.phase === "outline"}
                  rerunComment={rerunState?.phase === "outline" ? rerunState.comment : ""}
                  onRerunCommentChange={(c) => setRerunState((s) => s ? { ...s, comment: c } : s)}
                  onRerunSubmit={() => { if (rerunState) rerunPhase("outline", rerunState.comment); }}
                  onRerunCancel={() => setRerunState(null)}
                  rerunLoading={rerunState?.phase === "outline" && rerunState.loading}
                >
                  <div className="text-sm space-y-2">
                    <p className="font-semibold text-[var(--foreground)]">H1: {run.phases.p6.h1}</p>
                    {run.phases.p6.sections?.map((s, i) => (
                      <div key={i} className="pl-3 border-l-2 border-[var(--border)]">
                        <p className="font-medium text-[var(--foreground)]">H2: {s.h2}</p>
                        <p className="text-[var(--muted)] text-xs">{s.must_answer} · {s.format}{s.needs_citation ? " · citation needed" : ""}</p>
                      </div>
                    ))}
                  </div>
                </PhasePanel>
              )}

              {/* Draft */}
              {run.phases.p7 && (
                <PhasePanel
                  title="Draft"
                  badge={`${run.phases.p7.draft_markdown?.split(/\s+/).length ?? 0} words`}
                  expanded={expandedPhase === "draft"}
                  onToggle={() => setExpandedPhase(expandedPhase === "draft" ? null : "draft")}
                  onDownload={() => downloadText(`draft-${slug(run.keyword)}.md`, run.phases.p7?.draft_markdown ?? "")}
                  onRerun={!isRunning ? () => setRerunState({ phase: "draft", comment: "", loading: false }) : undefined}
                  rerunActive={rerunState?.phase === "draft"}
                  rerunComment={rerunState?.phase === "draft" ? rerunState.comment : ""}
                  onRerunCommentChange={(c) => setRerunState((s) => s ? { ...s, comment: c } : s)}
                  onRerunSubmit={() => { if (rerunState) rerunPhase("draft", rerunState.comment); }}
                  onRerunCancel={() => setRerunState(null)}
                  rerunLoading={rerunState?.phase === "draft" && rerunState.loading}
                >
                  <pre className="text-xs font-mono bg-slate-50 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap text-[var(--foreground)] max-h-[400px] overflow-y-auto">
                    {run.phases.p7.draft_markdown}
                  </pre>
                  {run.phases.p7.placeholders_needing_sources?.length ? (
                    <div className="mt-3">
                      <p className="text-xs text-[var(--muted)] mb-1">Placeholders needing sources</p>
                      <ul className="list-disc list-inside text-xs text-amber-700 space-y-0.5">
                        {run.phases.p7.placeholders_needing_sources.map((p, i) => <li key={i}>{p}</li>)}
                      </ul>
                    </div>
                  ) : null}
                </PhasePanel>
              )}

              {/* Sources */}
              {run.phases.p10 && (
                <PhasePanel
                  title="Sources & References"
                  badge={`${run.phases.p8?.sourced_claims?.length ?? 0} sources · ${run.phases.p8?.suggested_images?.length ?? 0} images`}
                  expanded={expandedPhase === "factcheck"}
                  onToggle={() => setExpandedPhase(expandedPhase === "factcheck" ? null : "factcheck")}
                  onDownload={() => downloadText(`sources-${slug(run.keyword)}.txt`, buildSourcesDownload(run))}
                  onRerun={!isRunning ? () => setRerunState({ phase: "factcheck", comment: "", loading: false }) : undefined}
                  rerunActive={rerunState?.phase === "factcheck"}
                  rerunComment={rerunState?.phase === "factcheck" ? rerunState.comment : ""}
                  onRerunCommentChange={(c) => setRerunState((s) => s ? { ...s, comment: c } : s)}
                  onRerunSubmit={() => { if (rerunState) rerunPhase("factcheck", rerunState.comment); }}
                  onRerunCancel={() => setRerunState(null)}
                  rerunLoading={rerunState?.phase === "factcheck" && rerunState.loading}
                >
                  <div className="text-sm space-y-3">
                    {run.phases.p9?.corrections_needed?.length ? (
                      <div>
                        <p className="text-xs font-medium text-[var(--muted)] mb-1">Corrections applied ({run.phases.p9.corrections_needed.length})</p>
                        <ul className="list-disc list-inside space-y-0.5 text-[var(--foreground)]">
                          {run.phases.p9.corrections_needed.map((c, i) => <li key={i}>{c.issue}</li>)}
                        </ul>
                      </div>
                    ) : null}
                    {run.phases.p8?.suggested_images?.length ? (
                      <div>
                        <p className="text-xs font-medium text-[var(--muted)] mb-2">Images</p>
                        <div className="space-y-2">
                          {run.phases.p8.suggested_images.map((img, i) => (
                            <div key={i} className="rounded-lg border border-[var(--border)] p-2 flex gap-3">
                              {img.local_path && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={img.local_path} alt={img.caption} className="w-24 h-16 object-cover rounded flex-shrink-0" />
                              )}
                              <div>
                                <p className="text-xs font-medium text-[var(--foreground)]">{img.caption}</p>
                                <p className="text-xs text-[var(--muted)]">{img.attribution}</p>
                                {!img.local_path && <p className="text-xs text-amber-600">Image not downloaded (restricted domain)</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {run.phases.p10.harvard_references?.length ? (
                      <div>
                        <p className="text-xs font-medium text-[var(--muted)] mb-1">Harvard References</p>
                        <ol className="list-decimal list-inside space-y-1 text-xs text-[var(--foreground)]">
                          {run.phases.p10.harvard_references.map((r, i) => <li key={i}>{r}</li>)}
                        </ol>
                      </div>
                    ) : null}
                  </div>
                </PhasePanel>
              )}

              {/* E-E-A-T */}
              {run.phases.p12 && (
                <PhasePanel
                  title="E-E-A-T"
                  badge={`${run.phases.p12.adjustments_made?.length ?? 0} adjustments`}
                  expanded={expandedPhase === "eeat"}
                  onToggle={() => setExpandedPhase(expandedPhase === "eeat" ? null : "eeat")}
                  onDownload={() => downloadText(`eeat-${slug(run.keyword)}.md`, run.phases.p12?.revised_markdown ?? "")}
                  onRerun={!isRunning ? () => setRerunState({ phase: "polish", comment: "", loading: false }) : undefined}
                  rerunActive={rerunState?.phase === "polish"}
                  rerunComment={rerunState?.phase === "polish" ? rerunState.comment : ""}
                  onRerunCommentChange={(c) => setRerunState((s) => s ? { ...s, comment: c } : s)}
                  onRerunSubmit={() => { if (rerunState) rerunPhase("polish", rerunState.comment); }}
                  onRerunCancel={() => setRerunState(null)}
                  rerunLoading={rerunState?.phase === "polish" && rerunState.loading}
                >
                  <div className="text-sm space-y-3">
                    {run.phases.p12.eeat_notes?.length ? (
                      <div>
                        <p className="text-xs font-medium text-[var(--muted)] mb-1">E-E-A-T signals added</p>
                        <ul className="list-disc list-inside space-y-0.5 text-[var(--foreground)] text-xs">{run.phases.p12.eeat_notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                      </div>
                    ) : null}
                    {run.phases.p12.adjustments_made?.length ? (
                      <div>
                        <p className="text-xs font-medium text-[var(--muted)] mb-1">Adjustments made</p>
                        <ul className="list-disc list-inside space-y-0.5 text-[var(--foreground)] text-xs">{run.phases.p12.adjustments_made.map((a, i) => <li key={i}>{a}</li>)}</ul>
                      </div>
                    ) : null}
                    <pre className="text-xs font-mono bg-slate-50 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap text-[var(--foreground)] max-h-[300px] overflow-y-auto">{run.phases.p12.revised_markdown}</pre>
                  </div>
                </PhasePanel>
              )}

              {/* Humanize */}
              {run.phases.p115 && (
                <PhasePanel
                  title="Humanize"
                  badge={`AI signal: ${run.phases.p115.pre_edit_signal_score} → ${run.phases.p115.post_edit_signal_score} · ${run.phases.p115.band}`}
                  expanded={expandedPhase === "humanize"}
                  onToggle={() => setExpandedPhase(expandedPhase === "humanize" ? null : "humanize")}
                  onDownload={() => downloadText(`humanized-${slug(run.keyword)}.md`, run.phases.p115?.revised_draft ?? "")}
                  onRerun={!isRunning ? () => setRerunState({ phase: "humanize", comment: "", loading: false }) : undefined}
                  rerunActive={rerunState?.phase === "humanize"}
                  rerunComment={rerunState?.phase === "humanize" ? rerunState.comment : ""}
                  onRerunCommentChange={(c) => setRerunState((s) => s ? { ...s, comment: c } : s)}
                  onRerunSubmit={() => { if (rerunState) rerunPhase("humanize", rerunState.comment); }}
                  onRerunCancel={() => setRerunState(null)}
                  rerunLoading={rerunState?.phase === "humanize" && rerunState.loading}
                >
                  <div className="text-sm space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="rounded-lg bg-slate-50 p-2 text-center">
                        <p className="text-xs text-[var(--muted)]">Before</p>
                        <p className="text-sm font-semibold text-red-500">{run.phases.p115.pre_edit_signal_score}/100</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-2 text-center">
                        <p className="text-xs text-[var(--muted)]">After</p>
                        <p className="text-sm font-semibold text-green-600">{run.phases.p115.post_edit_signal_score}/100</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-2 text-center">
                        <p className="text-xs text-[var(--muted)]">Band</p>
                        <p className="text-sm font-semibold text-[var(--foreground)]">{run.phases.p115.band}</p>
                      </div>
                    </div>
                    {run.phases.p115.categories_fixed?.length ? (
                      <div>
                        <p className="text-xs font-medium text-[var(--muted)] mb-1">AI tells removed</p>
                        <div className="flex flex-wrap gap-1">
                          {run.phases.p115.categories_fixed.map((c, i) => <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700">{c}</span>)}
                        </div>
                      </div>
                    ) : null}
                    <pre className="text-xs font-mono bg-slate-50 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap text-[var(--foreground)] max-h-[300px] overflow-y-auto">{run.phases.p115.revised_draft}</pre>
                  </div>
                </PhasePanel>
              )}

              {/* Critic */}
              {run.phases.p13 && (
                <PhasePanel
                  title="Critic / QA Gate"
                  badge={run.phases.p13.gate_result}
                  expanded={expandedPhase === "critic"}
                  onToggle={() => setExpandedPhase(expandedPhase === "critic" ? null : "critic")}
                  onRerun={!isRunning ? () => setRerunState({ phase: "critic", comment: "", loading: false }) : undefined}
                  rerunActive={rerunState?.phase === "critic"}
                  rerunComment={rerunState?.phase === "critic" ? rerunState.comment : ""}
                  onRerunCommentChange={(c) => setRerunState((s) => s ? { ...s, comment: c } : s)}
                  onRerunSubmit={() => { if (rerunState) rerunPhase("critic", rerunState.comment); }}
                  onRerunCancel={() => setRerunState(null)}
                  rerunLoading={rerunState?.phase === "critic" && rerunState.loading}
                >
                  {run.phases.p13.failing_items?.length ? (
                    <ul className="text-xs text-amber-700 list-disc list-inside space-y-0.5">{run.phases.p13.failing_items.map((f, i) => <li key={i}>{f}</li>)}</ul>
                  ) : (
                    <p className="text-xs text-green-700">All rubric items passed.</p>
                  )}
                </PhasePanel>
              )}

              {/* Final article */}
              {run.final_markdown && (
                <PhasePanel
                  title="Final Article"
                  badge={`${run.final_markdown.split(/\s+/).length} words · ${run.phases.p115?.band ?? ""} AI signal`}
                  expanded={expandedPhase === "article"}
                  onToggle={() => setExpandedPhase(expandedPhase === "article" ? null : "article")}
                  onDownload={() => downloadText(`final-${slug(run.keyword)}.md`, run.final_markdown ?? "")}
                >
                  <div className="flex justify-end mb-3">
                    <button onClick={() => navigator.clipboard.writeText(run.final_markdown ?? "")} className="text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]">Copy markdown</button>
                  </div>
                  <pre className="text-xs font-mono bg-slate-50 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap text-[var(--foreground)] max-h-[600px] overflow-y-auto">
                    {run.final_markdown}
                  </pre>
                </PhasePanel>
              )}
            </div>

            {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function ResearchContent({ run }: { run: BlogGenRun }) {
  return (
    <div className="space-y-5 text-sm">
      {run.phases.p0 && (
        <ReasoningBlock title="Intent Analysis" color="blue">
          <p className="text-[var(--foreground)] font-medium mb-1">{run.phases.p0.primary_intent}</p>
          <p className="text-xs text-[var(--muted)] mb-2">{run.phases.p0.scope_note}</p>
          <div className="flex flex-wrap gap-1">
            {run.phases.p0.sub_intents?.map((s, i) => <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{s}</span>)}
          </div>
        </ReasoningBlock>
      )}
      {run.phases.p1 && (
        <ReasoningBlock title="Entities & Semantic Clusters" color="purple">
          <div className="mb-2">
            <p className="text-xs text-[var(--muted)] mb-1">Core entities</p>
            <div className="flex flex-wrap gap-1">
              {run.phases.p1.core_entities?.map((e, i) => <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-purple-50 text-purple-700">{e}</span>)}
            </div>
          </div>
          {run.phases.p1.semantic_clusters?.map((c, i) => (
            <div key={i} className="mt-2">
              <p className="text-xs font-medium text-[var(--muted)]">[{c.cluster}]</p>
              <div className="flex flex-wrap gap-1 mt-0.5">{c.terms.map((t, j) => <span key={j} className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-[var(--muted)]">{t}</span>)}</div>
            </div>
          ))}
          {run.phases.p1.notably_absent_from_competitors?.length ? (
            <div className="mt-2">
              <p className="text-xs text-[var(--muted)] mb-1">Notably absent from competitors</p>
              <div className="flex flex-wrap gap-1">
                {run.phases.p1.notably_absent_from_competitors.map((e, i) => <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">{e}</span>)}
              </div>
            </div>
          ) : null}
        </ReasoningBlock>
      )}
      {run.phases.p2?.fanout_queries && (
        <ReasoningBlock title={`Fan-out Queries (${run.phases.p2.fanout_queries.length})`} color="teal">
          <p className="text-xs text-[var(--muted)] mb-2">Sub-questions used to map the full information space around your keyword.</p>
          <ol className="space-y-1">
            {run.phases.p2.fanout_queries.map((q, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-xs text-teal-500 font-medium flex-shrink-0">{i + 1}.</span>
                <span className="text-xs text-[var(--foreground)]">{q}</span>
              </li>
            ))}
          </ol>
        </ReasoningBlock>
      )}
      {run.phases.p3 && (
        <ReasoningBlock title="SERP & Competitor Analysis" color="orange">
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div className="rounded-lg bg-orange-50 p-2 text-center">
              <p className="text-xs text-[var(--muted)]">Avg word count</p>
              <p className="text-sm font-semibold text-orange-700">{run.phases.p3.serp_patterns?.avg_word_count ?? "—"}</p>
            </div>
            <div className="rounded-lg bg-orange-50 p-2 text-center col-span-2">
              <p className="text-xs text-[var(--muted)]">Common format</p>
              <p className="text-xs font-medium text-orange-700">{run.phases.p3.serp_patterns?.common_format ?? "—"}</p>
            </div>
          </div>
          <p className="text-xs text-[var(--muted)] mb-0.5">Common H1 pattern</p>
          <p className="text-xs text-[var(--foreground)] mb-3 italic">"{run.phases.p3.serp_patterns?.common_h1_pattern}"</p>
          {run.phases.p3.ai_overview_summary && (
            <div className="mb-3">
              <p className="text-xs text-[var(--muted)] mb-0.5">AI Overview summary</p>
              <p className="text-xs text-[var(--foreground)]">{run.phases.p3.ai_overview_summary}</p>
            </div>
          )}
          {run.phases.p3.leading_angle_per_competitor?.length ? (
            <div>
              <p className="text-xs text-[var(--muted)] mb-1">Competitor angles</p>
              <div className="space-y-1.5">
                {run.phases.p3.leading_angle_per_competitor.map((c, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <span className="text-xs text-[var(--muted)] flex-shrink-0 w-4">{i + 1}.</span>
                    <div>
                      <p className="text-xs font-medium text-[var(--foreground)] truncate max-w-xs">{c.source}</p>
                      <p className="text-xs text-[var(--muted)]">{c.angle}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </ReasoningBlock>
      )}
      {run.phases.p4 && (
        <ReasoningBlock title="Coverage Gap Analysis" color="red">
          {run.phases.p4.fully_covered?.length ? (
            <div className="mb-2">
              <p className="text-xs text-[var(--muted)] mb-1">Fully covered by competitors</p>
              <div className="flex flex-wrap gap-1">{run.phases.p4.fully_covered.map((t, i) => <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-[var(--muted)] line-through">{t}</span>)}</div>
            </div>
          ) : null}
          {run.phases.p4.partially_covered?.length ? (
            <div className="mb-2">
              <p className="text-xs text-[var(--muted)] mb-1">Partially covered</p>
              <div className="flex flex-wrap gap-1">{run.phases.p4.partially_covered.map((t, i) => <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">{t}</span>)}</div>
            </div>
          ) : null}
          {run.phases.p4.gaps?.length ? (
            <div>
              <p className="text-xs text-[var(--muted)] mb-1">Gaps — your opportunity</p>
              <ul className="space-y-1.5">
                {run.phases.p4.gaps.map((g, i) => (
                  <li key={i} className="rounded-lg bg-red-50 p-2">
                    <p className="text-xs font-medium text-red-700">{g.topic}</p>
                    <p className="text-xs text-red-600">{g.why_it_matters}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </ReasoningBlock>
      )}
      {run.phases.p5 && (
        <ReasoningBlock title="Differentiation Decision" color="green">
          <p className="text-xs text-[var(--muted)] mb-1">Angle chosen</p>
          <p className="text-sm font-medium text-[var(--foreground)] mb-3">{run.phases.p5.angle_statement}</p>
          <ul className="space-y-1">
            {run.phases.p5.differentiation_points?.map((d, i) => (
              <li key={i} className="flex gap-2 text-xs text-[var(--foreground)]">
                <span className="text-green-500 flex-shrink-0">✓</span>{d}
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--muted)] mt-2">Target word count: <span className="font-medium text-[var(--foreground)]">{run.phases.p5.target_word_count}</span></p>
        </ReasoningBlock>
      )}
    </div>
  );
}

function PhasePanel({
  title, badge, expanded, onToggle, onDownload, onRerun,
  rerunActive, rerunComment, onRerunCommentChange, onRerunSubmit, onRerunCancel, rerunLoading,
  children,
}: {
  title: string;
  badge?: string;
  expanded: boolean;
  onToggle: () => void;
  onDownload?: () => void;
  onRerun?: () => void;
  rerunActive?: boolean;
  rerunComment?: string;
  onRerunCommentChange?: (c: string) => void;
  onRerunSubmit?: () => void;
  onRerunCancel?: () => void;
  rerunLoading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] overflow-hidden">
      <div className="w-full flex items-center justify-between p-4 hover:bg-slate-50 transition">
        <button onClick={onToggle} className="flex items-center gap-2 flex-1 text-left">
          <span className="text-sm font-medium text-[var(--foreground)]">{title}</span>
          {badge && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-[var(--muted)]">{badge}</span>}
        </button>
        <div className="flex items-center gap-2 flex-shrink-0">
          {onRerun && !rerunActive && (
            <button onClick={(e) => { e.stopPropagation(); onRerun(); }} className="text-xs px-2.5 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-amber-700 hover:border-amber-300 transition" title="Rerun this step with feedback">
              ↺ Rerun
            </button>
          )}
          {onDownload && (
            <button onClick={(e) => { e.stopPropagation(); onDownload(); }} className="text-xs px-2.5 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)] hover:border-[var(--accent)] transition" title="Download this step">
              ↓ Download
            </button>
          )}
          <button onClick={onToggle} className="text-[var(--muted)] text-sm px-1">{expanded ? "▲" : "▼"}</button>
        </div>
      </div>

      {/* Rerun form */}
      {rerunActive && (
        <div className="px-4 pb-3 border-t border-amber-100 bg-amber-50">
          <p className="text-xs font-medium text-amber-800 mt-3 mb-2">What should change? Add feedback for this phase:</p>
          <textarea
            value={rerunComment ?? ""}
            onChange={(e) => onRerunCommentChange?.(e.target.value)}
            placeholder="e.g. Focus more on B2B law firms specifically. Add a section on local SEO tactics."
            rows={3}
            className="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-amber-400 resize-none"
            autoFocus
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={onRerunSubmit}
              disabled={rerunLoading}
              className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 transition"
            >
              {rerunLoading ? "Running…" : "Run with this feedback"}
            </button>
            <button onClick={onRerunCancel} disabled={rerunLoading} className="text-xs px-3 py-1.5 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {expanded && <div className="px-4 pb-4 border-t border-[var(--border)]"><div className="pt-4">{children}</div></div>}
    </div>
  );
}

function ReasoningBlock({ title, color, children }: { title: string; color: "blue" | "purple" | "teal" | "orange" | "red" | "green"; children: React.ReactNode }) {
  const accent: Record<string, string> = { blue: "border-blue-200 bg-blue-50/40", purple: "border-purple-200 bg-purple-50/40", teal: "border-teal-200 bg-teal-50/40", orange: "border-orange-200 bg-orange-50/40", red: "border-red-200 bg-red-50/40", green: "border-green-200 bg-green-50/40" };
  const label: Record<string, string> = { blue: "text-blue-700", purple: "text-purple-700", teal: "text-teal-700", orange: "text-orange-700", red: "text-red-700", green: "text-green-700" };
  return (
    <div className={`rounded-lg border p-3 ${accent[color]}`}>
      <p className={`text-xs font-semibold mb-2 uppercase tracking-wide ${label[color]}`}>{title}</p>
      {children}
    </div>
  );
}
