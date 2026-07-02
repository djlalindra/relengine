import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  BorderStyle,
  ExternalHyperlink,
  Packer,
  WidthType,
} from "docx";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { BlogGenRun } from "./types";

type DocChild = Paragraph | Table | ImageRun;
type InlineChild = TextRun | ExternalHyperlink;

// Strip artifacts that have no docx equivalent
function cleanMarkdown(markdown: string): string {
  return markdown
    .replace(/\*?\*?\(Hypothetical[^)]*\)\*?\*?/gi, "")
    .replace(/\*?\*?\[Hypothetical[^\]]*\]\*?\*?/gi, "")
    .replace(/\*?\*?\(Example[^)]*\)\*?\*?/gi, "")
    .replace(/^> /gm, "")
    .replace(/^---+$/gm, "")
    .replace(/^\*\*\*+$/gm, "")
    .replace(/^___+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Parse inline markdown into TextRun / ExternalHyperlink children
function parseInlineRuns(text: string): InlineChild[] {
  const runs: InlineChild[] = [];
  // Pattern order matters: links first, then bold, then italic, then code
  const tokenRe = /(\[([^\]]+)\]\((https?:\/\/[^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(text)) !== null) {
    // Plain text before this token
    if (match.index > last) {
      const plain = text.slice(last, match.index);
      if (plain) runs.push(new TextRun({ text: plain }));
    }

    const [full, , linkLabel, linkUrl, boldText, italicText, codeText] = match;

    if (linkUrl) {
      // [label](url) → clickable hyperlink
      runs.push(
        new ExternalHyperlink({
          link: linkUrl,
          children: [
            new TextRun({
              text: linkLabel || linkUrl,
              style: "Hyperlink",
            }),
          ],
        })
      );
    } else if (boldText) {
      runs.push(new TextRun({ text: boldText, bold: true }));
    } else if (italicText) {
      runs.push(new TextRun({ text: italicText, italics: true }));
    } else if (codeText) {
      runs.push(new TextRun({ text: codeText, font: "Courier New" }));
    } else {
      runs.push(new TextRun({ text: full }));
    }

    last = match.index + full.length;
  }

  if (last < text.length) {
    const tail = text.slice(last);
    if (tail) runs.push(new TextRun({ text: tail }));
  }

  return runs.length ? runs : [new TextRun({ text: text })];
}

function makeCell(text: string, isHeader = false): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        children: parseInlineRuns(text.trim()) as TextRun[],
        ...(isHeader ? {} : {}),
      }),
    ],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1 },
      bottom: { style: BorderStyle.SINGLE, size: 1 },
      left: { style: BorderStyle.SINGLE, size: 1 },
      right: { style: BorderStyle.SINGLE, size: 1 },
    },
  });
}

// Detect and convert a block of markdown table lines to a Word Table
function buildMarkdownTable(tableLines: string[]): Table {
  const rows: TableRow[] = [];
  let isFirstDataRow = true;

  for (const line of tableLines) {
    // Skip separator rows like |---|---|
    if (/^\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?$/.test(line.trim())) continue;

    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());

    rows.push(
      new TableRow({
        children: cells.map((c) => makeCell(c, isFirstDataRow)),
        tableHeader: isFirstDataRow,
      })
    );
    isFirstDataRow = false;
  }

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

function isTableLine(line: string): boolean {
  return /^\s*\|/.test(line) || /\|\s*$/.test(line);
}

// Convert a full markdown string to docx children, handling tables as blocks
function markdownToDocxChildren(markdown: string): DocChild[] {
  const lines = cleanMarkdown(markdown).split("\n");
  const children: DocChild[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Collect table block
    if (isTableLine(line)) {
      const tableLines: string[] = [];
      while (i < lines.length && isTableLine(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        children.push(buildMarkdownTable(tableLines));
        children.push(new Paragraph({ text: "" }));
      } else {
        // Single-line pseudo-table, just render as text
        for (const tl of tableLines) {
          children.push(new Paragraph({ children: parseInlineRuns(tl) as TextRun[] }));
        }
      }
      continue;
    }

    if (trimmed.startsWith("# ")) {
      children.push(new Paragraph({ text: trimmed.slice(2), heading: HeadingLevel.HEADING_1 }));
    } else if (trimmed.startsWith("## ")) {
      children.push(new Paragraph({ text: trimmed.slice(3), heading: HeadingLevel.HEADING_2 }));
    } else if (trimmed.startsWith("### ")) {
      children.push(new Paragraph({ text: trimmed.slice(4), heading: HeadingLevel.HEADING_3 }));
    } else if (/^[-*]\s/.test(trimmed)) {
      children.push(
        new Paragraph({
          children: parseInlineRuns(trimmed.slice(2)) as TextRun[],
          bullet: { level: 0 },
        })
      );
    } else if (/^\d+\.\s/.test(trimmed)) {
      children.push(
        new Paragraph({
          children: parseInlineRuns(trimmed.replace(/^\d+\.\s/, "")) as TextRun[],
          numbering: { reference: "default-numbering", level: 0 },
        })
      );
    } else if (trimmed === "") {
      children.push(new Paragraph({ text: "" }));
    } else {
      children.push(new Paragraph({ children: parseInlineRuns(trimmed) as TextRun[] }));
    }

    i++;
  }

  return children;
}

function buildRunSummaryTable(run: BlogGenRun): Table {
  const rows = [
    ["Keyword", run.keyword],
    ["Status", run.status],
    ["Created", new Date(run.created_at).toLocaleString()],
    ["Target word count", String(run.phases.p5?.target_word_count ?? "—")],
    ["Primary intent", run.phases.p0?.primary_intent ?? "—"],
    ["Angle", run.phases.p5?.angle_statement ?? "—"],
    ["QA Gate", run.phases.p13?.gate_result ?? "—"],
  ];

  return new Table({
    rows: rows.map(
      ([label, value]) =>
        new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })],
              borders: {
                top: { style: BorderStyle.SINGLE, size: 1 },
                bottom: { style: BorderStyle.SINGLE, size: 1 },
                left: { style: BorderStyle.SINGLE, size: 1 },
                right: { style: BorderStyle.SINGLE, size: 1 },
              },
            }),
            new TableCell({
              children: [new Paragraph({ text: value })],
              borders: {
                top: { style: BorderStyle.SINGLE, size: 1 },
                bottom: { style: BorderStyle.SINGLE, size: 1 },
                left: { style: BorderStyle.SINGLE, size: 1 },
                right: { style: BorderStyle.SINGLE, size: 1 },
              },
            }),
          ],
        })
    ),
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

function buildArticleContent(run: BlogGenRun): DocChild[] {
  const children: DocChild[] = [];

  const finalMarkdown =
    run.final_markdown ??
    run.phases.p115?.revised_draft ??
    run.phases.p12?.revised_markdown ??
    run.phases.p7?.draft_markdown ??
    "";

  if (finalMarkdown) {
    children.push(...markdownToDocxChildren(finalMarkdown));

    if (run.phases.p8?.suggested_images) {
      for (const img of run.phases.p8.suggested_images) {
        if (img.local_path) {
          const absPath = join(process.cwd(), "public", img.local_path.replace(/^\//, ""));
          if (existsSync(absPath)) {
            try {
              const imgBuffer = readFileSync(absPath);
              children.push(
                new Paragraph({ text: "" }),
                new Paragraph({
                  children: [
                    new ImageRun({
                      data: imgBuffer,
                      transformation: { width: 500, height: 300 },
                      type: img.local_path.endsWith(".png") ? "png" : "jpg",
                    }),
                  ],
                }),
                new Paragraph({
                  children: [
                    new TextRun({ text: img.caption + " — " + img.attribution, italics: true, size: 18 }),
                  ],
                  alignment: AlignmentType.CENTER,
                }),
                new Paragraph({ text: "" })
              );
            } catch {
              // skip unreadable image
            }
          }
        }
      }
    }
  }

  return children;
}

// Build references section with clickable hyperlinks
function buildReferencesSection(refs: string[]): DocChild[] {
  const children: DocChild[] = [
    new Paragraph({ text: "" }),
    new Paragraph({ text: "References", heading: HeadingLevel.HEADING_2 }),
  ];

  for (const ref of refs) {
    // Extract URL from reference string if present — Harvard refs often end with "Available at: https://..."
    const urlMatch = ref.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      const url = urlMatch[0].replace(/[.,;)]+$/, ""); // trim trailing punctuation
      const beforeUrl = ref.slice(0, ref.indexOf(urlMatch[0]));
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: beforeUrl }),
            new ExternalHyperlink({
              link: url,
              children: [new TextRun({ text: url, style: "Hyperlink" })],
            }),
          ],
          spacing: { after: 120 },
        })
      );
    } else {
      children.push(new Paragraph({ text: ref, spacing: { after: 120 } }));
    }
  }

  return children;
}

const NUMBERING_CONFIG = {
  config: [
    {
      reference: "default-numbering",
      levels: [{ level: 0, format: "decimal" as const, text: "%1.", alignment: AlignmentType.START }],
    },
  ],
};

export async function buildDocx(run: BlogGenRun): Promise<Buffer> {
  const children: DocChild[] = [];

  children.push(
    new Paragraph({
      text: "Blog Generation Run Report",
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({ text: "" }),
    buildRunSummaryTable(run),
    new Paragraph({ text: "" })
  );

  if (run.phases.p5?.differentiation_points?.length) {
    children.push(
      new Paragraph({ text: "Differentiation Points", heading: HeadingLevel.HEADING_2 }),
      ...run.phases.p5.differentiation_points.map(
        (pt) => new Paragraph({ text: pt, bullet: { level: 0 } })
      ),
      new Paragraph({ text: "" })
    );
  }

  if (run.phases.p4?.gaps?.length) {
    children.push(
      new Paragraph({ text: "Information Gaps Found", heading: HeadingLevel.HEADING_2 }),
      ...run.phases.p4.gaps.map(
        (g) =>
          new Paragraph({
            children: [
              new TextRun({ text: g.topic + ": ", bold: true }),
              new TextRun({ text: g.why_it_matters }),
            ],
            bullet: { level: 0 },
          })
      ),
      new Paragraph({ text: "" })
    );
  }

  children.push(
    new Paragraph({ text: "Article", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: "" }),
    ...buildArticleContent(run)
  );

  if (run.phases.p10?.harvard_references?.length) {
    children.push(...buildReferencesSection(run.phases.p10.harvard_references));
  }

  if (run.phases.p13) {
    const gate = run.phases.p13;
    children.push(
      new Paragraph({ text: "" }),
      new Paragraph({ text: `QA Gate: ${gate.gate_result}`, heading: HeadingLevel.HEADING_2 })
    );
    if (gate.failing_items?.length) {
      children.push(
        new Paragraph({ text: "Failing items:" }),
        ...gate.failing_items.map((f) => new Paragraph({ text: f, bullet: { level: 0 } }))
      );
    }
  }

  const doc = new Document({
    numbering: NUMBERING_CONFIG,
    sections: [{ children: children as Paragraph[] }],
  });

  return await Packer.toBuffer(doc);
}

export async function buildCleanArticleDocx(run: BlogGenRun): Promise<Buffer> {
  const children: DocChild[] = [...buildArticleContent(run)];

  if (run.phases.p10?.harvard_references?.length) {
    children.push(...buildReferencesSection(run.phases.p10.harvard_references));
  }

  const doc = new Document({
    numbering: NUMBERING_CONFIG,
    sections: [{ children: children as Paragraph[] }],
  });

  return await Packer.toBuffer(doc);
}
