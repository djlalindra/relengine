import { NextRequest, NextResponse } from "next/server";
import { buildDocx, buildCleanArticleDocx } from "@/lib/blog-gen/docx-export";
import type { BlogGenRun } from "@/lib/blog-gen/types";

export async function POST(req: NextRequest) {
  let body: { run?: BlogGenRun; clean_only?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.run) {
    return NextResponse.json({ error: "run is required." }, { status: 400 });
  }

  try {
    const buffer = body.clean_only
      ? await buildCleanArticleDocx(body.run)
      : await buildDocx(body.run);

    const prefix = body.clean_only ? "article" : "blog";
    const filename = `${prefix}-${body.run.keyword.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${body.run.run_id.slice(0, 8)}.docx`;

    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to generate document." },
      { status: 500 }
    );
  }
}
