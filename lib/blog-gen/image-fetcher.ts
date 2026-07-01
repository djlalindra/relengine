import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import type { SuggestedImage } from "./types";

const ALLOWED_IMAGE_DOMAINS = [
  ".gov",
  ".edu",
  "who.int",
  "worldbank.org",
  "oecd.org",
  "statista.com",
  "commons.wikimedia.org",
  "upload.wikimedia.org",
  "ourworldindata.org",
  "pewresearch.org",
  "gallup.com",
  "census.gov",
  "bls.gov",
  "cdc.gov",
  "nih.gov",
];

function isAllowedDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return ALLOWED_IMAGE_DOMAINS.some((d) => hostname.endsWith(d));
  } catch {
    return false;
  }
}

function getImageExtension(url: string, contentType: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("svg")) return ".svg";
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  if (ext && ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return `.${ext}`;
  return ".png";
}

export async function fetchAndSaveImages(
  images: SuggestedImage[],
  runId: string
): Promise<SuggestedImage[]> {
  const dir = join(process.cwd(), "public", "blog-gen", "images", runId);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const results: SuggestedImage[] = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];

    if (!isAllowedDomain(img.url)) {
      results.push({ ...img, local_path: undefined });
      continue;
    }

    try {
      const response = await fetch(img.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; RelevanceBot/1.0)" },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        results.push({ ...img, local_path: undefined });
        continue;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) {
        results.push({ ...img, local_path: undefined });
        continue;
      }

      const ext = getImageExtension(img.url, contentType);
      const filename = `img-${i + 1}${ext}`;
      const filePath = join(dir, filename);
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(filePath, buffer);

      const publicPath = `/blog-gen/images/${runId}/${filename}`;
      results.push({ ...img, local_path: publicPath });
    } catch {
      results.push({ ...img, local_path: undefined });
    }
  }

  return results;
}
