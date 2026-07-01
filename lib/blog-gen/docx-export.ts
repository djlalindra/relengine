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
  Packer,
} from "docx";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { BlogGenRun } from "./types";

function parseMarkdownLine(line: string): Paragraph {
  const trimmed = line.trim();

  if (trimmed.startsWith("# ")) {
    return new Paragraph({ text: trimmed.slice(2), heading: HeadingLevel.HEADING_1 });
  }
  if (trimmed.startsWith("## ")) {
    return new Paragraph({ text: trimmed.slice(3), heading: HeadingLevel.HEADING_2 });
  }
  if (trimmed.startsWith("### ")) {
    return new Paragraph({ text: trimmed.slice(4), heading: HeadingLevel.HEADING_3 });
  }
  if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
    return new Paragraph({
      text: trimmed.slice(2),
      bullet: { level: 0 },
    });
  }
  if (/^\d+\.\s/.test(trimmed)) {
    return new Paragraph({
      text: trimmed.replace(/^\d+\.\s/, ""),
      numbering: { reference: "default-numbering", level: 0 },
    });
  }
  if (trimmed === "") {
    return new Paragraph({ text: "" });
  }

  // Inline bold/italic parsing
  const runs: TextRun[] = [];
  const parts = trimmed.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/);
  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**")) {
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true }));
    } else if (part.startsWith("*") && part.endsWith("*")) {
      runs.push(new TextRun({ text: part.slice(1, -1), italics: true }));
    } else if (part.startsWith("`") && part.endsWith("`")) {
      runs.push(new TextRun({ text: part.slice(1, -1), font: "Courier New" }));
    } else if (part) {
      runs.push(new TextRun({ text: part }));
    }
  }

  return new Paragraph({ children: runs });
}

function markdownToParagraphs(markdown: string): Paragraph[] {
  return markdown.split("\n").map(parseMarkdownLine);
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
    width: { size: 100, type: "pct" },
  });
}

export async function buildDocx(run: BlogGenRun): Promise<Buffer> {
  const children: (Paragraph | Table | ImageRun)[] = [];

  // Cover info
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

  // Differentiation points
  if (run.phases.p5?.differentiation_points?.length) {
    children.push(
      new Paragraph({ text: "Differentiation Points", heading: HeadingLevel.HEADING_2 }),
      ...run.phases.p5.differentiation_points.map(
        (pt) => new Paragraph({ text: pt, bullet: { level: 0 } })
      ),
      new Paragraph({ text: "" })
    );
  }

  // Gap analysis
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

  // Final article
  const finalMarkdown = run.final_markdown ?? run.phases.p115?.revised_draft ?? run.phases.p12?.revised_markdown ?? run.phases.p7?.draft_markdown ?? "";

  if (finalMarkdown) {
    children.push(
      new Paragraph({ text: "Final Article", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: "" })
    );

    const lines = finalMarkdown.split("\n");
    for (const line of lines) {
      children.push(parseMarkdownLine(line));
    }

    // Inline images if available locally
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
                  children: [new TextRun({ text: img.caption + " — " + img.attribution, italics: true, size: 18 })],
                  alignment: AlignmentType.CENTER,
                }),
                new Paragraph({ text: "" })
              );
            } catch {
              // skip image if unreadable
            }
          }
        }
      }
    }
  }

  // References
  if (run.phases.p10?.harvard_references?.length) {
    children.push(
      new Paragraph({ text: "" }),
      new Paragraph({ text: "References", heading: HeadingLevel.HEADING_2 }),
      ...run.phases.p10.harvard_references.map((ref) => new Paragraph({ text: ref, spacing: { after: 120 } }))
    );
  }

  // QA Gate
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
    numbering: {
      config: [
        {
          reference: "default-numbering",
          levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START }],
        },
      ],
    },
    sections: [{ children: children as Paragraph[] }],
  });

  return await Packer.toBuffer(doc);
}
