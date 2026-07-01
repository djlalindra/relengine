import { NextRequest, NextResponse } from "next/server";
import { generateSecret, getQrCodeUrl, isValidBase32 } from "@/lib/totp";

export async function GET(req: NextRequest) {
  const setupToken = process.env.TOTP_SETUP_TOKEN;
  const provided = req.nextUrl.searchParams.get("token");

  if (!setupToken || provided !== setupToken) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const stored = process.env.TOTP_SECRET;

  // If no secret is set, or the stored one isn't valid base32, generate a fresh one.
  const needsNew = !stored || !isValidBase32(stored);
  const secret = needsNew ? generateSecret() : stored!;

  return NextResponse.json({
    secret,
    qrCodeUrl: getQrCodeUrl(secret),
    isNew: needsNew,
    invalidStored: !!stored && !isValidBase32(stored),
  });
}
