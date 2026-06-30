import { NextRequest, NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { verifyTOTP, getTOTPSecret } from "@/lib/totp";
import {
  isRateLimited,
  recordFailedAttempt,
  clearAttempts,
  getRemainingLockoutMs,
} from "@/lib/rate-limit";

function getClientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0].trim() ?? "unknown";
}

export async function POST(req: NextRequest) {
  const clientKey = getClientKey(req);

  if (isRateLimited(clientKey)) {
    const remainingMs = getRemainingLockoutMs(clientKey);
    const remainingMin = Math.ceil(remainingMs / 60000);
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${remainingMin} minute${remainingMin === 1 ? "" : "s"}.` },
      { status: 429 }
    );
  }

  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { code } = body;

  if (!code) {
    return NextResponse.json({ error: "Authenticator code is required." }, { status: 400 });
  }

  let secret: string;
  try {
    secret = getTOTPSecret();
  } catch {
    return NextResponse.json(
      { error: "Server is not configured for 2FA. Set TOTP_SECRET in environment variables." },
      { status: 500 }
    );
  }

  if (!verifyTOTP(secret, code)) {
    recordFailedAttempt(clientKey);
    return NextResponse.json({ error: "Invalid code. Check your authenticator app and try again." }, { status: 401 });
  }

  clearAttempts(clientKey);
  await createSession();
  return NextResponse.json({ success: true });
}
