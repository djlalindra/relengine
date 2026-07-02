"use client";

import { useState, useRef, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Flag {
  start: number;
  end: number;
  category: number;
  label: string;
  color: string;
  tooltip: string;
  fix: string;
}

interface CategoryResult {
  id: number;
  name: string;
  source: string;
  points: number;
  cap: number;
  hits: number;
  color: string;
  flags: Flag[];
}

interface HumanOffset {
  label: string;
  points: number;
  triggered: boolean;
}

interface ScanResult {
  score: number;
  band: string;
  bandColor: string;
  bandContext: string;
  categories: CategoryResult[];
  humanOffsets: HumanOffset[];
  wordCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","shall","to",
  "of","in","on","at","by","for","with","about","as","and","or","but","not",
  "this","that","these","those","it","its","their","they","we","our","which","who",
  "i","you","he","she","him","her","his","my","your","its","our","their",
]);

const AI_VOCAB = [
  "pivotal","crucial","key role","tapestry","testament","delve","delved","vibrant",
  "boasts","bolstered","enduring","meticulous","meticulously","intricate","intricacies",
  "interplay","underscore","underscores","underscored","showcases","showcasing",
  "fosters","fostering","enhance","enhances","enhancing","align with","aligns with",
  "garnered","garner","valuable insights","robust","encompassing","encompasses",
  "indelible mark","deeply rooted","evolving landscape","focal point","emphasizing",
];

const SIG_INFLATION = [
  "stands as","serves as a testament","marks a pivotal","represents a significant shift",
  "reflects broader","setting the stage for","contributing to the","symbolizing its",
  "marking a turning point","key turning point","evolving landscape","indelible mark on",
  "deeply rooted in",
];

const CHALLENGES_CLOSER_A = ["despite these challenges","despite its challenges","despite this"];
const CHALLENGES_CLOSER_B = ["continues to thrive","continues to evolve","continues to grow"];
const CHALLENGES_STANDALONE = ["future outlook","future prospects"];

const VAGUE_ATTR = [
  "industry reports","experts argue","observers have cited","observers note","some critics argue",
  "several sources","several publications","widely reported","active social media presence",
  "independent coverage","has been featured in","profiled in","leading experts","many researchers",
];

const PLAIN_VERB_AVOID = [
  "authored","relocated","utilized","commenced","endeavored","ventured into",
  "demonstrated proficiency in","exhibited a tendency",
];

const COPULA_AVOID = ["serves as a","stands as a","marks a","represents a","boasts a","acts as a"];

const SECTION_SUMMARIES = ["in summary","in conclusion","to summarize","overall,","in closing"];

const TRANSITION_TICS = ["additionally,","moreover,","furthermore,","notably,","importantly,","interestingly,"];

const SCRIPTED_THIS = [
  "this allows","this enables","this ensures","this approach","this design","this method",
  "this process","this system","this framework","this strategy","this initiative","this represents",
];

const KNOWLEDGE_GAP = [
  "while specific details are","not widely documented","not extensively documented",
  "based on available information","likely benefits from","the area likely",
  "it is likely that","presumably","it can be assumed",
];

// Category colors
const COLORS = [
  "#fef08a","#fca5a5","#fed7aa","#fb923c","#d8b4fe","#bfdbfe",
  "#bae6fd","#99f6e4","#a7f3d0","#a7f3d0","#fbcfe8","#fde68a",
  "#fef3c7","#ffedd5","#e2e8f0","#e2e8f0","#dbeafe","#e2e8f0","#e2e8f0",
];

// ---------------------------------------------------------------------------
// Scanning engine
// ---------------------------------------------------------------------------

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scan(text: string): ScanResult {
  const lower = text.toLowerCase();
  const words = text.trim().split(/\s+/).filter(Boolean);
  const wc = words.length;
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];

  const cats: CategoryResult[] = [];
  const flags: Flag[] = [];

  function addFlag(start: number, end: number, catId: number, label: string, color: string, tooltip: string, fix: string) {
    flags.push({ start, end, category: catId, label, color, tooltip, fix });
  }

  // --- Cat 1: AI Vocab ---
  {
    const seen = new Set<string>();
    let pts = 0;
    const catFlags: Flag[] = [];
    for (const term of AI_VOCAB) {
      const re = new RegExp(`\\b${escapeRe(term)}\\b`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (!seen.has(term.toLowerCase())) { pts += 2; seen.add(term.toLowerCase()); }
        catFlags.push({ start: m.index, end: m.index + m[0].length, category: 1, label: "AI Vocab", color: COLORS[0], tooltip: `AI vocabulary: "${term}"`, fix: `Replace "${term}" with a plain, specific word.` });
      }
    }
    pts = Math.min(pts, 16);
    cats.push({ id: 1, name: "AI Vocabulary", source: "Wikipedia", points: pts, cap: 16, hits: catFlags.length, color: COLORS[0], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 2: Em Dashes ---
  {
    let pts = 0;
    const catFlags: Flag[] = [];
    const emRe = /—/g;
    let m: RegExpExecArray | null;
    while ((m = emRe.exec(text)) !== null) {
      pts += 8;
      catFlags.push({ start: m.index, end: m.index + 1, category: 2, label: "Em Dash", color: COLORS[1], tooltip: "Em dash detected (zero-tolerance signal)", fix: "Replace with a comma, period, colon, or parentheses." });
    }
    const hhRe = /--/g;
    let hhPts = 0;
    while ((m = hhRe.exec(text)) !== null) {
      hhPts = Math.min(hhPts + 3, 9);
      catFlags.push({ start: m.index, end: m.index + 2, category: 2, label: "Double Hyphen", color: COLORS[1], tooltip: "Double-hyphen used as em dash", fix: "Replace with a comma, period, or colon." });
    }
    pts += hhPts;
    cats.push({ id: 2, name: "Em Dashes", source: "Both sources", points: pts, cap: 99, hits: catFlags.length, color: COLORS[1], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 3: Significance Inflation ---
  {
    let pts = 0;
    const catFlags: Flag[] = [];
    for (const phrase of SIG_INFLATION) {
      const re = new RegExp(escapeRe(phrase), "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        pts = Math.min(pts + 4, 12);
        catFlags.push({ start: m.index, end: m.index + m[0].length, category: 3, label: "Sig. Inflation", color: COLORS[2], tooltip: `Significance inflation: "${phrase}"`, fix: "Cut this sentence unless it follows a specific checkable fact." });
      }
    }
    cats.push({ id: 3, name: "Significance Inflation", source: "Wikipedia", points: pts, cap: 12, hits: catFlags.length, color: COLORS[2], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 4: Challenges Closer ---
  {
    let pts = 0;
    const catFlags: Flag[] = [];
    for (const a of CHALLENGES_CLOSER_A) {
      const idx = lower.indexOf(a);
      if (idx !== -1) {
        const window = lower.slice(Math.max(0, idx - 80), idx + 80);
        for (const b of CHALLENGES_CLOSER_B) {
          if (window.includes(b)) {
            pts = Math.min(pts + 8, 16);
            catFlags.push({ start: idx, end: idx + a.length, category: 4, label: "Challenges Closer", color: COLORS[3], tooltip: `"${a}" near "${b}"`, fix: 'End on the last real fact. Cut the "despite challenges" framing.' });
          }
        }
      }
    }
    for (const phrase of CHALLENGES_STANDALONE) {
      const re = new RegExp(escapeRe(phrase), "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        pts = Math.min(pts + 8, 16);
        catFlags.push({ start: m.index, end: m.index + m[0].length, category: 4, label: "Challenges Closer", color: COLORS[3], tooltip: `Standalone: "${phrase}"`, fix: "Replace with a specific statement about what actually happens next." });
      }
    }
    cats.push({ id: 4, name: "Challenges Closer", source: "Wikipedia", points: pts, cap: 16, hits: catFlags.length, color: COLORS[3], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 5: Negative Parallelism ---
  {
    const patterns = [
      /not (?:just|only)\b[\s\S]{0,90}\bbut/gi,
      /it's not[\s\S]{0,60}it's/gi,
      /not a[\s\S]{0,50}but a/gi,
      /rather than[\s\S]{0,60}instead/gi,
    ];
    let pts = 0;
    const catFlags: Flag[] = [];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        pts = Math.min(pts + 3, 12);
        catFlags.push({ start: m.index, end: m.index + m[0].length, category: 5, label: "Neg. Parallelism", color: COLORS[4], tooltip: "Negative parallelism pattern", fix: 'Rewrite "not just X but Y" as a direct statement.' });
      }
    }
    cats.push({ id: 5, name: "Negative Parallelism", source: "Wikipedia", points: pts, cap: 12, hits: catFlags.length, color: COLORS[4], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 6: Vague Attribution ---
  {
    let pts = 0;
    const catFlags: Flag[] = [];
    for (const phrase of VAGUE_ATTR) {
      const re = new RegExp(escapeRe(phrase), "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        pts = Math.min(pts + 3, 9);
        catFlags.push({ start: m.index, end: m.index + m[0].length, category: 6, label: "Vague Attribution", color: COLORS[5], tooltip: `Vague attribution: "${phrase}"`, fix: "Name the specific source, or cut the attribution." });
      }
    }
    cats.push({ id: 6, name: "Vague Attribution", source: "Wikipedia", points: pts, cap: 9, hits: catFlags.length, color: COLORS[5], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 7: Plain-Verb Avoidance ---
  {
    let pts = 0;
    const catFlags: Flag[] = [];
    for (const phrase of PLAIN_VERB_AVOID) {
      const re = new RegExp(`\\b${escapeRe(phrase)}\\b`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        pts = Math.min(pts + 2, 8);
        const fixes: Record<string, string> = { authored:"Use 'wrote'", relocated:"Use 'moved'", utilized:"Use 'used'", commenced:"Use 'started'", endeavored:"Use 'tried'" };
        catFlags.push({ start: m.index, end: m.index + m[0].length, category: 7, label: "Formal Verb", color: COLORS[6], tooltip: `Overly formal verb: "${phrase}"`, fix: fixes[phrase.toLowerCase()] ?? "Replace with a plain verb." });
      }
    }
    cats.push({ id: 7, name: "Plain-Verb Avoidance", source: "Wikipedia", points: pts, cap: 8, hits: catFlags.length, color: COLORS[6], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 8: Copula Avoidance ---
  {
    let pts = 0;
    const catFlags: Flag[] = [];
    for (const phrase of COPULA_AVOID) {
      const re = new RegExp(`\\b${escapeRe(phrase)}\\b`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        pts = Math.min(pts + 2, 8);
        catFlags.push({ start: m.index, end: m.index + m[0].length, category: 8, label: "Copula Avoid", color: COLORS[7], tooltip: `Copula avoidance: "${phrase}"`, fix: `Replace "${phrase}" with a plain "is a" or restructure.` });
      }
    }
    cats.push({ id: 8, name: "Copula Avoidance", source: "Wikipedia", points: pts, cap: 8, hits: catFlags.length, color: COLORS[7], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 9: Section Summaries ---
  {
    let pts = 0;
    const catFlags: Flag[] = [];
    for (const phrase of SECTION_SUMMARIES) {
      const re = new RegExp(`(^|[.!?]\\s+)${escapeRe(phrase)}`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        pts = Math.min(pts + 4, 8);
        const start = m.index + (m[1]?.length ?? 0);
        catFlags.push({ start, end: start + phrase.length, category: 9, label: "Section Summary", color: COLORS[8], tooltip: `AI summary phrase: "${phrase}"`, fix: "Cut this opener unless the following sentence contains new information." });
      }
    }
    cats.push({ id: 9, name: "Section Summaries", source: "Wikipedia", points: pts, cap: 8, hits: catFlags.length, color: COLORS[8], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 10: Transition Tics ---
  {
    let pts = 0;
    const catFlags: Flag[] = [];
    for (const phrase of TRANSITION_TICS) {
      const re = new RegExp(`(^|[.!?\\n]\\s*)${escapeRe(phrase)}`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        pts = Math.min(pts + 2, 8);
        const start = m.index + (m[1]?.length ?? 0);
        catFlags.push({ start, end: start + phrase.length, category: 10, label: "Transition Tic", color: COLORS[9], tooltip: `Scripted transition: "${phrase.replace(",","")}"`, fix: "Replace with a specific connective or restructure the paragraph." });
      }
    }
    cats.push({ id: 10, name: "Transition Tics", source: "Wikipedia", points: pts, cap: 8, hits: catFlags.length, color: COLORS[9], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 11: Participle Tack-Ons ---
  {
    const re = /,\s+[a-z]+ing\s+[a-z].+?\./gi;
    let pts = 0;
    const catFlags: Flag[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      pts = Math.min(pts + 3, 9);
      catFlags.push({ start: m.index, end: m.index + m[0].length, category: 11, label: "Participle Tack-On", color: COLORS[10], tooltip: "Tacked-on participial phrase at sentence end", fix: "Cut this phrase unless it contains factual information not stated above." });
    }
    cats.push({ id: 11, name: "Participle Tack-Ons", source: "Wikipedia", points: pts, cap: 9, hits: catFlags.length, color: COLORS[10], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 12: Templated Narrative Structure ---
  {
    const paragraphs = text.split(/\n\n+/);
    let pts = 0;
    const catFlags: Flag[] = [];
    let offset = 0;
    for (const para of paragraphs) {
      const sents = para.match(/[^.!?]+[.!?]*/g) ?? [];
      if (sents.length >= 3) {
        const hasTopic = /^[A-Z]/.test(sents[0].trim());
        const hasConnector = /\b(this|these|by)\b/i.test(sents[Math.floor(sents.length / 2)] ?? "");
        const lastSent = sents[sents.length - 1].toLowerCase();
        const hasClose = /^(this|these|as a result|consequently|therefore)\b/.test(lastSent.trim());
        if (hasTopic && hasConnector && hasClose) {
          pts = Math.min(pts + 5, 15);
          catFlags.push({ start: offset, end: offset + para.length, category: 12, label: "Templated Structure", color: COLORS[11], tooltip: "Paragraph matches AI template: topic → This connector → Therefore close", fix: "Vary the structure: not every paragraph needs the same 3-part pattern." });
        }
      }
      offset += para.length + 2;
    }
    cats.push({ id: 12, name: "Templated Narrative", source: "S-CTS Paper", points: pts, cap: 15, hits: catFlags.length, color: COLORS[11], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 13: Salient Term Overrepresentation ---
  {
    const termCounts = new Map<string, number>();
    for (const w of words) {
      const lw = w.toLowerCase().replace(/[^a-z]/g, "");
      if (lw.length > 3 && !STOPWORDS.has(lw)) {
        termCounts.set(lw, (termCounts.get(lw) ?? 0) + 1);
      }
    }
    const top5 = Array.from(termCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const windowSize = 80;
    let pts = 0;
    const catFlags: Flag[] = [];
    for (const [term] of top5) {
      const threshold = wc / windowSize;
      const count = termCounts.get(term) ?? 0;
      if (count > threshold) {
        // flag occurrences beyond the first per 80-word window
        const re = new RegExp(`\\b${escapeRe(term)}\\b`, "gi");
        let m: RegExpExecArray | null;
        let hits = 0;
        while ((m = re.exec(text)) !== null) {
          hits++;
          if (hits > 1) {
            pts = Math.min(pts + 2, 10);
            catFlags.push({ start: m.index, end: m.index + m[0].length, category: 13, label: "Overused Term", color: COLORS[12], tooltip: `"${term}" appears ${count}x (>${threshold.toFixed(1)} per 80 words)`, fix: `Replace later occurrences of "${term}" with a pronoun or synonym.` });
          }
        }
      }
    }
    cats.push({ id: 13, name: "Salient Term Overuse", source: "S-CTS Paper", points: pts, cap: 10, hits: catFlags.length, color: COLORS[12], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 14: Functional Redundancy ---
  {
    const paragraphs = text.split(/\n\n+/);
    let pts = 0;
    const catFlags: Flag[] = [];
    let offset = 0;
    for (const para of paragraphs) {
      const sents = para.match(/[^.!?]+[.!?]*/g) ?? [];
      for (let i = 0; i < sents.length - 1; i++) {
        const wordsA = sents[i].toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !STOPWORDS.has(w));
        const wordsB = sents[i + 1].toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !STOPWORDS.has(w));
        const shared = wordsA.filter((w) => wordsB.includes(w));
        if (shared.length >= 4) {
          const sentOffset = para.indexOf(sents[i + 1]);
          pts = Math.min(pts + 4, 12);
          catFlags.push({ start: offset + sentOffset, end: offset + sentOffset + sents[i + 1].length, category: 14, label: "Redundant Sentence", color: COLORS[13], tooltip: `This sentence repeats content from the previous one (${shared.length} shared terms)`, fix: "Cut or merge with the previous sentence." });
        }
      }
      offset += para.length + 2;
    }
    cats.push({ id: 14, name: "Functional Redundancy", source: "S-CTS Paper", points: pts, cap: 12, hits: catFlags.length, color: COLORS[13], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 15: Structural Uniformity ---
  {
    const paragraphs = text.split(/\n\n+/).filter((p) => {
      const sents = p.match(/[^.!?]+[.!?]*/g) ?? [];
      return sents.length >= 3;
    });
    let pts = 0;
    if (paragraphs.length >= 3) {
      const paraWordCounts = paragraphs.map((p) => p.trim().split(/\s+/).length);
      const mean = paraWordCounts.reduce((a, b) => a + b, 0) / paraWordCounts.length;
      const variance = paraWordCounts.reduce((s, v) => s + (v - mean) ** 2, 0) / paraWordCounts.length;
      const cv = Math.sqrt(variance) / mean;
      if (cv < 0.2) pts = 8;
      // sentence length variance
      const sentLengths = sentences.map((s) => s.trim().split(/\s+/).length);
      if (sentLengths.length >= 5) {
        const sMean = sentLengths.reduce((a, b) => a + b, 0) / sentLengths.length;
        const range = 5;
        const inRange = sentLengths.filter((l) => Math.abs(l - sMean) <= range / 2).length;
        if (inRange / sentLengths.length > 0.6) pts = Math.max(pts, 8);
      }
    }
    cats.push({ id: 15, name: "Structural Uniformity", source: "S-CTS Paper", points: pts, cap: 8, hits: pts > 0 ? 1 : 0, color: COLORS[14], flags: [] });
  }

  // --- Cat 16: Scripted "This X" Connectives ---
  {
    let pts = 0;
    const catFlags: Flag[] = [];
    let totalHits = 0;
    for (const phrase of SCRIPTED_THIS) {
      const re = new RegExp(`(^|[.!?\\n]\\s*)${escapeRe(phrase)}\\b`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        totalHits++;
        const start = m.index + (m[1]?.length ?? 0);
        catFlags.push({ start, end: start + phrase.length, category: 16, label: "Scripted Connective", color: COLORS[15], tooltip: `Scripted connective: "${phrase}"`, fix: `Replace "${phrase}" with a more specific or varied construction.` });
      }
    }
    if (totalHits >= 3) {
      pts = Math.min((totalHits - 2) * 3, 9);
    }
    cats.push({ id: 16, name: "Scripted 'This X'", source: "S-CTS Paper", points: pts, cap: 9, hits: totalHits, color: COLORS[15], flags: pts > 0 ? catFlags : [] });
    if (pts > 0) flags.push(...catFlags);
  }

  // --- Cat 17: Knowledge-Gap Hedging ---
  {
    let pts = 0;
    const catFlags: Flag[] = [];
    for (const phrase of KNOWLEDGE_GAP) {
      const re = new RegExp(escapeRe(phrase), "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        pts = Math.min(pts + 3, 6);
        catFlags.push({ start: m.index, end: m.index + m[0].length, category: 17, label: "Knowledge Gap", color: COLORS[16], tooltip: `Knowledge-gap hedging: "${phrase}"`, fix: "Either name the specific source or remove the hedge entirely." });
      }
    }
    cats.push({ id: 17, name: "Knowledge-Gap Hedging", source: "Wikipedia", points: pts, cap: 6, hits: catFlags.length, color: COLORS[16], flags: catFlags });
    flags.push(...catFlags);
  }

  // --- Cat 18: Bold Overuse ---
  {
    const boldMatches = [...text.matchAll(/\*\*[^*]+\*\*/g)];
    const rate = boldMatches.length / (wc / 100);
    let pts = 0;
    if (rate > 1) {
      const extra = boldMatches.length - Math.floor(wc / 100);
      pts = 3 + Math.max(0, extra);
    }
    cats.push({ id: 18, name: "Bold Overuse", source: "Wikipedia", points: pts, cap: 99, hits: boldMatches.length, color: COLORS[17], flags: [] });
  }

  // --- Cat 19: Title Case Headers ---
  {
    const headers = [...text.matchAll(/^#{2,3} .+$/gm)];
    const titleCaseCount = headers.filter((h) => {
      const words = h[0].replace(/^#+\s*/, "").split(/\s+/);
      const majors = words.filter((w) => w.length > 3);
      return majors.length > 0 && majors.every((w) => /^[A-Z]/.test(w));
    }).length;
    const pts = headers.length > 0 && titleCaseCount / headers.length > 0.6 ? 4 : 0;
    cats.push({ id: 19, name: "Title Case Headers", source: "Wikipedia", points: pts, cap: 4, hits: headers.length, color: COLORS[18], flags: [] });
  }

  // --- Human offsets ---
  const offsets: HumanOffset[] = [];
  {
    const plainCopulaRe = /\b(is a|are a|has a|was a|have a)\b/gi;
    const copulaHits = [...text.matchAll(plainCopulaRe)].length;
    const copulaRate = copulaHits / (wc / 100);
    if (copulaRate > 1.5) offsets.push({ label: "Plain copulas (high rate)", points: 8, triggered: true });
    else if (copulaRate >= 0.5) offsets.push({ label: "Plain copulas (moderate rate)", points: 4, triggered: true });
    else offsets.push({ label: "Plain copulas", points: 0, triggered: false });
  }
  {
    const hedgeRe = /\b(very|perhaps|tends to|kind of|sort of|probably|roughly|fairly)\b/gi;
    const triggered = hedgeRe.test(text);
    offsets.push({ label: "Hedging words", points: triggered ? 3 : 0, triggered });
  }
  {
    const wordyRe = /\b(as a result of|in order to|the fact that|a part of|some of the)\b/gi;
    const triggered = wordyRe.test(text);
    offsets.push({ label: "Natural wordy constructions", points: triggered ? 3 : 0, triggered });
  }
  {
    const sentLengths = sentences.map((s) => s.trim().split(/\s+/).length);
    if (sentLengths.length >= 5) {
      const mean = sentLengths.reduce((a, b) => a + b, 0) / sentLengths.length;
      const variance = sentLengths.reduce((s, v) => s + (v - mean) ** 2, 0) / sentLengths.length;
      const cv = Math.sqrt(variance) / mean;
      offsets.push({ label: "Sentence length variance", points: cv > 0.4 ? 4 : 0, triggered: cv > 0.4 });
    }
  }

  const rawScore = cats.reduce((s, c) => s + c.points, 0) - offsets.reduce((s, o) => s + o.points, 0);
  const score = Math.max(0, Math.min(100, rawScore));

  const band = score <= 14 ? "Reads as Human Written"
    : score <= 34 ? "Moderate AI Signal"
    : score <= 59 ? "Strong AI Signal"
    : "Reads as AI Generated";
  const bandColor = score <= 14 ? "#16a34a" : score <= 34 ? "#ca8a04" : score <= 59 ? "#ea580c" : "#dc2626";
  const bandContext = score <= 14 ? "Few or no AI writing patterns detected. Looks like human prose."
    : score <= 34 ? "Some AI patterns present. Worth reviewing flagged passages."
    : score <= 59 ? "Multiple AI patterns detected across several categories. Optimize before publishing."
    : "High density of AI writing tells. Strong candidate for a full rewrite.";

  return { score, band, bandColor, bandContext, categories: cats, humanOffsets: offsets, wordCount: wc };
}

// ---------------------------------------------------------------------------
// Annotated text renderer
// ---------------------------------------------------------------------------

interface Tooltip { x: number; y: number; flag: Flag }

function AnnotatedText({ text, flags }: { text: string; flags: Flag[] }) {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const sorted = [...flags].sort((a, b) => a.start - b.start);

  // Merge overlapping flags — keep first
  const merged: Flag[] = [];
  let cursor = 0;
  for (const f of sorted) {
    if (f.start >= cursor) { merged.push(f); cursor = f.end; }
  }

  const parts: React.ReactNode[] = [];
  let pos = 0;
  for (const f of merged) {
    if (f.start > pos) parts.push(<span key={`t-${pos}`}>{text.slice(pos, f.start)}</span>);
    const snippet = text.slice(f.start, f.end);
    parts.push(
      <mark
        key={`f-${f.start}`}
        style={{ backgroundColor: f.color, borderRadius: 2, cursor: "pointer", position: "relative" }}
        onMouseEnter={(e) => {
          const rect = (e.target as HTMLElement).getBoundingClientRect();
          setTooltip({ x: rect.left, y: rect.bottom + window.scrollY + 4, flag: f });
        }}
        onMouseLeave={() => setTooltip(null)}
      >
        {snippet}
      </mark>
    );
    pos = f.end;
  }
  if (pos < text.length) parts.push(<span key="tail">{text.slice(pos)}</span>);

  return (
    <div className="relative">
      <pre className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--foreground)] font-sans">{parts}</pre>
      {tooltip && (
        <div
          className="fixed z-50 max-w-xs rounded-lg border border-[var(--border)] bg-white p-3 shadow-lg text-xs"
          style={{ top: tooltip.y, left: Math.min(tooltip.x, window.innerWidth - 320) }}
        >
          <p className="font-semibold text-[var(--foreground)] mb-1">{tooltip.flag.label}</p>
          <p className="text-[var(--muted)] mb-1">{tooltip.flag.tooltip}</p>
          <p className="text-blue-700"><span className="font-medium">Fix:</span> {tooltip.flag.fix}</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff view
// ---------------------------------------------------------------------------

function DiffView({ original, optimized }: { original: string; optimized: string }) {
  const [tab, setTab] = useState<"original" | "optimized">("optimized");
  const origLines = original.split("\n");
  const optLines = optimized.split("\n");

  // Simple line diff
  const changes = optLines.filter((l, i) => l !== origLines[i]).length;

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <button onClick={() => setTab("original")} className={`px-3 py-1.5 rounded text-sm font-medium ${tab === "original" ? "bg-slate-200 text-[var(--foreground)]" : "text-[var(--muted)] hover:text-[var(--foreground)]"}`}>Original</button>
        <button onClick={() => setTab("optimized")} className={`px-3 py-1.5 rounded text-sm font-medium ${tab === "optimized" ? "bg-green-100 text-green-800" : "text-[var(--muted)] hover:text-[var(--foreground)]"}`}>Optimized</button>
        <span className="text-xs text-[var(--muted)] ml-2">{changes} lines changed</span>
      </div>
      <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans text-[var(--foreground)] max-h-[500px] overflow-y-auto rounded-lg border border-[var(--border)] p-4 bg-slate-50">
        {tab === "original" ? original : optimized}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function AIScannerPage() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [expandedCat, setExpandedCat] = useState<number | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizedText, setOptimizedText] = useState<string | null>(null);
  const [optError, setOptError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const wordCount = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  const canScan = wordCount >= 50;

  function handleScan() {
    if (!canScan) return;
    setResult(scan(text));
    setOptimizedText(null);
    setOptError("");
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.name.endsWith(".docx")) {
      setText("Paste text directly — Word files aren't supported.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => setText((ev.target?.result as string) ?? "");
    reader.readAsText(file);
  }

  async function handleOptimize() {
    if (!result || !text) return;
    setOptimizing(true);
    setOptError("");
    setOptimizedText(null);
    try {
      const resp = await fetch("/api/ai-scanner/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, scan_report: { score: result.score, categories: result.categories.map(c => ({ name: c.name, hits: c.hits, points: c.points })) } }),
      });
      if (!resp.ok || !resp.body) throw new Error("Optimize failed");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const evt = JSON.parse(line.slice(6)) as { type: string; text?: string; error?: string };
          if (evt.type === "result" && evt.text) setOptimizedText(evt.text);
          if (evt.type === "error") throw new Error(evt.error);
        }
      }
    } catch (err) {
      setOptError(err instanceof Error ? err.message : "Optimization failed.");
    } finally {
      setOptimizing(false);
    }
  }

  function handleRescan() {
    if (!optimizedText) return;
    setText(optimizedText);
    setResult(scan(optimizedText));
    setOptimizedText(null);
  }

  function handleExportReport() {
    if (!result) return;
    const lines = [
      "# AI Writing Signal Scan Report",
      `Score: ${result.score}/100 — ${result.band}`,
      `Word count: ${result.wordCount}`,
      "",
      "## Category Scores",
      ...result.categories.map((c) => `- ${c.name}: ${c.points}pts (${c.hits} hits) — Source: ${c.source}`),
      "",
      "## Human Signal Offsets",
      ...result.humanOffsets.filter((o) => o.triggered).map((o) => `- ${o.label}: -${o.points}pts`),
      "",
      "## Disclaimer",
      "This is a heuristic pattern count, not a calibrated AI detector. It finds passages worth reviewing, not a verdict on authorship.",
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ai-scan-report.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  const allFlags = result?.categories.flatMap((c) => c.flags) ?? [];
  const totalPoints = result?.categories.reduce((s, c) => s + c.points, 0) ?? 0;
  const totalOffset = result?.humanOffsets.reduce((s, o) => s + o.points, 0) ?? 0;

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <div className="border-b border-[var(--border)] bg-[var(--card)] px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-[var(--foreground)]">AI Writing Signal Scanner</h1>
            <p className="text-xs text-[var(--muted)]">Find and fix AI writing signals.</p>
          </div>
          <a href="/" className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]">← Back</a>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
        {/* Input panel */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 space-y-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste your content here..."
            rows={8}
            className="w-full resize-y rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <input ref={fileRef} type="file" accept=".txt,.md,.docx" className="hidden" onChange={handleFile} />
              <button onClick={() => fileRef.current?.click()} className="text-xs px-3 py-1.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]">Upload .txt / .md</button>
              <span className="text-xs text-[var(--muted)]">{wordCount} words</span>
            </div>
            <button
              onClick={handleScan}
              disabled={!canScan}
              className="px-5 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
            >
              Scan
            </button>
          </div>
        </div>

        {result && (
          <>
            {/* Spectrum bar */}
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-6 space-y-4">
              <div className="relative h-5 rounded-full overflow-hidden" style={{ background: "linear-gradient(to right, #16a34a, #ca8a04, #ea580c, #dc2626)" }}>
                <div
                  className="absolute top-0 h-full w-1 bg-white shadow-md"
                  style={{ left: `${result.score}%`, transform: "translateX(-50%)" }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-[var(--muted)] -mt-2">
                <span>Human</span><span>AI</span>
              </div>
              <div className="text-center space-y-1">
                <p className="text-3xl font-bold" style={{ color: result.bandColor }}>{result.score}</p>
                <p className="text-lg font-semibold" style={{ color: result.bandColor }}>{result.band}</p>
                <p className="text-sm text-[var(--muted)]">{result.bandContext}</p>
                <p className="text-xs text-[var(--muted)] italic mt-2 max-w-xl mx-auto">This is a heuristic pattern count, not a calibrated AI detector. It finds passages worth reviewing, not a verdict on authorship.</p>
              </div>
            </div>

            {/* Two-column body */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Left: annotated doc */}
              <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] mb-3">Annotated Document</p>
                <AnnotatedText text={text} flags={allFlags} />
              </div>

              {/* Right: score breakdown */}
              <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 space-y-4">
                <div className="flex items-baseline gap-2">
                  <span className="text-4xl font-bold" style={{ color: result.bandColor }}>{result.score}</span>
                  <span className="text-sm text-[var(--muted)]">{result.band}</span>
                </div>

                <div className="space-y-1">
                  {result.categories.filter((c) => c.hits > 0 || c.points > 0).map((cat) => (
                    <div key={cat.id}>
                      <button
                        onClick={() => setExpandedCat(expandedCat === cat.id ? null : cat.id)}
                        className="w-full flex items-center gap-2 py-1.5 text-left hover:bg-slate-50 rounded px-1"
                      >
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: cat.color, border: "1px solid rgba(0,0,0,0.1)" }} />
                        <span className="flex-1 text-xs text-[var(--foreground)] truncate">{cat.name}</span>
                        <span className="text-xs text-[var(--muted)]">{cat.hits} hits</span>
                        <span className="text-xs font-medium w-12 text-right" style={{ color: cat.points > 0 ? "#dc2626" : "#16a34a" }}>+{cat.points}pts</span>
                        <span className="text-[10px] text-[var(--muted)]">{expandedCat === cat.id ? "▲" : "▼"}</span>
                      </button>
                      {expandedCat === cat.id && cat.flags.length > 0 && (
                        <div className="ml-4 mb-2 space-y-1">
                          {cat.flags.slice(0, 5).map((f, i) => (
                            <p key={i} className="text-[11px] text-[var(--muted)] pl-2 border-l-2" style={{ borderColor: cat.color }}>
                              {f.tooltip}
                            </p>
                          ))}
                          {cat.flags.length > 5 && <p className="text-[11px] text-[var(--muted)] pl-2">+{cat.flags.length - 5} more…</p>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {result.humanOffsets.some((o) => o.triggered) && (
                  <div className="border-t border-[var(--border)] pt-3 space-y-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Human signal offsets</p>
                    {result.humanOffsets.filter((o) => o.triggered).map((o, i) => (
                      <div key={i} className="flex justify-between text-xs">
                        <span className="text-[var(--muted)]">{o.label}</span>
                        <span className="text-green-600 font-medium">-{o.points}pts</span>
                      </div>
                    ))}
                    <div className="flex justify-between text-xs font-medium pt-1 border-t border-[var(--border)]">
                      <span className="text-[var(--muted)]">Raw score before offset</span>
                      <span className="text-[var(--foreground)]">{totalPoints}pts</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Action bar */}
            <div className="flex gap-3 flex-wrap">
              <button
                onClick={handleOptimize}
                disabled={optimizing}
                className="px-5 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {optimizing ? "Generating optimized version…" : "Generate Optimized Version"}
              </button>
              <button
                onClick={handleExportReport}
                className="px-5 py-2 rounded-lg border border-[var(--border)] text-sm font-medium text-[var(--foreground)] hover:bg-slate-50"
              >
                Export Scan Report .md
              </button>
            </div>

            {optError && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-4">
                <p className="text-sm text-red-600">{optError}</p>
              </div>
            )}

            {optimizedText && (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-[var(--foreground)]">Optimized Version</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => navigator.clipboard.writeText(optimizedText)}
                      className="text-xs px-3 py-1.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                    >
                      Copy Text
                    </button>
                    <button
                      onClick={handleRescan}
                      className="text-xs px-3 py-1.5 rounded bg-[var(--accent)] text-white hover:bg-blue-700"
                    >
                      Re-scan Optimized
                    </button>
                  </div>
                </div>
                <DiffView original={text} optimized={optimizedText} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
