export type StructuralFinding = {
  rule: string;
  passed: boolean;
  detail: string;
};

export type StructuralReport = {
  findings: StructuralFinding[];
  score: number; // 0-100, simple proportion of passed checks
};

/**
 * Splits markdown into sections by H2 (##) headings.
 */
function splitIntoSections(markdown: string): { heading: string; body: string }[] {
  const lines = markdown.split("\n");
  const sections: { heading: string; body: string }[] = [];
  let currentHeading = "";
  let currentBody: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.*)/);
    if (h2Match) {
      if (currentHeading) {
        sections.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
      }
      currentHeading = h2Match[1].trim();
      currentBody = [];
    } else if (currentHeading) {
      currentBody.push(line);
    }
  }
  if (currentHeading) {
    sections.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
  }
  return sections;
}

function firstSentence(text: string): string {
  const cleaned = text.replace(/^\s*[-*]\s+/gm, "").trim();
  const match = cleaned.match(/^[^.!?]*[.!?]/);
  return match ? match[0].trim() : cleaned.slice(0, 160);
}

export function runStructuralChecks(markdown: string): StructuralReport {
  const findings: StructuralFinding[] = [];

  // 1. Has at least one H1 title
  const hasH1 = /^#\s+.+/m.test(markdown);
  findings.push({
    rule: "Has a top-level title (H1)",
    passed: hasH1,
    detail: hasH1 ? "Title found." : "No H1 (#) title found at the top of the document.",
  });

  // 2. Has at least 3 H2 sections
  const sections = splitIntoSections(markdown);
  const hasEnoughSections = sections.length >= 3;
  findings.push({
    rule: "Has at least 3 H2 sections",
    passed: hasEnoughSections,
    detail: `Found ${sections.length} H2 section(s).`,
  });

  // 3. Answer-first: each section's first sentence is reasonably short and declarative
  const answerFirstFailures: string[] = [];
  if (sections.length === 0) {
    // No H2 sections exist at all -- this is already caught by check #2,
    // but we should not silently report "all sections pass" when there are
    // none to check. Treat as a failure of this check too.
    answerFirstFailures.push("(no sections found)");
  }
  for (const section of sections) {
    if (!section.body) continue;
    const first = firstSentence(section.body);
    const wordCount = first.split(/\s+/).filter(Boolean).length;
    // Heuristic: answer-first sentences tend to be direct and not overly long
    // or starting with a throat-clearing phrase.
    const startsWithFiller = /^(in this section|this section|let's|let us|we will|it is important to note)/i.test(
      first
    );
    if (wordCount > 35 || startsWithFiller || wordCount < 3) {
      answerFirstFailures.push(section.heading);
    }
  }
  findings.push({
    rule: "Sections open with a direct answer (not throat-clearing)",
    passed: answerFirstFailures.length === 0,
    detail:
      answerFirstFailures.length === 0
        ? "All sections open with a direct, reasonably concise statement."
        : sections.length === 0
        ? "No H2 sections found to check -- see heading structure issue above."
        : `Sections needing a tighter opening line: ${answerFirstFailures.join(", ")}.`,
  });

  // 4. Paragraph length check: flag paragraphs over ~150 words
  const paragraphs = markdown
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#") && !p.startsWith("-") && !p.startsWith("*"));
  const longParagraphs = paragraphs.filter(
    (p) => p.split(/\s+/).filter(Boolean).length > 150
  );
  findings.push({
    rule: "No oversized paragraphs (under ~150 words each)",
    passed: longParagraphs.length === 0,
    detail:
      longParagraphs.length === 0
        ? "All paragraphs are a reasonable length."
        : `${longParagraphs.length} paragraph(s) exceed ~150 words. Consider breaking these up.`,
  });

  // 5. Has an FAQ-style block (heading containing "FAQ" or "?" pattern with multiple questions)
  const hasFaqHeading = sections.some((s) => /faq|frequently asked|common questions/i.test(s.heading));
  const questionCount = (markdown.match(/^#{2,3}\s+.*\?/gm) || []).length;
  const hasFaqBlock = hasFaqHeading || questionCount >= 2;
  findings.push({
    rule: "Includes an FAQ-style block (AEO surfacing)",
    passed: hasFaqBlock,
    detail: hasFaqBlock
      ? "FAQ-style section or multiple question-headings detected."
      : "No FAQ section or question-style subheadings found. AI answer engines often pull from these.",
  });

  // 6. Internal linking presence (markdown links, excluding external http(s) ones is hard
  //    to determine without a domain list, so we just flag total link presence as a proxy)
  const linkCount = (markdown.match(/\[[^\]]+\]\([^)]+\)/g) || []).length;
  const hasLinks = linkCount >= 1;
  findings.push({
    rule: "Contains at least one internal/contextual link placeholder",
    passed: hasLinks,
    detail: hasLinks
      ? `${linkCount} link(s) found.`
      : "No links found. Consider adding internal links to related pages once published.",
  });

  // 7. Heading hierarchy sanity: no H3 before any H2 (orphaned subheading)
  const headingLines = markdown
    .split("\n")
    .filter((l) => /^#{1,4}\s/.test(l))
    .map((l) => ({
      level: l.match(/^(#{1,4})/)![1].length,
      text: l.replace(/^#{1,4}\s+/, ""),
    }));
  let sawH2 = false;
  let orphanedH3 = false;
  for (const h of headingLines) {
    if (h.level === 2) sawH2 = true;
    if (h.level === 3 && !sawH2) orphanedH3 = true;
  }
  findings.push({
    rule: "Heading hierarchy is well-formed (no orphaned H3 before an H2)",
    passed: !orphanedH3,
    detail: orphanedH3
      ? "Found an H3 subheading before any H2 — check heading nesting."
      : "Heading hierarchy looks consistent.",
  });

  const passedCount = findings.filter((f) => f.passed).length;
  const score = Math.round((passedCount / findings.length) * 100);

  return { findings, score };
}
