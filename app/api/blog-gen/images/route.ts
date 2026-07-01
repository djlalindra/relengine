import { NextRequest, NextResponse } from "next/server";
import { fetchAndSaveImages } from "@/lib/blog-gen/image-fetcher";
import type { SuggestedImage } from "@/lib/blog-gen/types";

export async function POST(req: NextRequest) {
  let body: { images?: SuggestedImage[]; run_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.images?.length || !body.run_id) {
    return NextResponse.json({ error: "images and run_id are required." }, { status: 400 });
  }

  try {
    const saved = await fetchAndSaveImages(body.images, body.run_id);
    return NextResponse.json({ images: saved });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch images." },
      { status: 500 }
    );
  }
}
