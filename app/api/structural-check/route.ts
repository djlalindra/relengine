import { NextRequest, NextResponse } from "next/server";
import { runStructuralChecks } from "@/lib/pipeline/structural-checks";

export async function POST(req: NextRequest) {
  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.text) {
    return NextResponse.json(
      { error: "Missing page text. Run the Scrape & Summarize step first." },
      { status: 400 }
    );
  }

  const structuralReport = runStructuralChecks(body.text);
  return NextResponse.json({ structuralReport });
}
