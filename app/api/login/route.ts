import { NextRequest, NextResponse } from "next/server";
import { checkCredentials, createSession } from "@/lib/auth";
import {
  isRateLimited,
  recordFailedAttempt,
  clearAttempts,
  getRemainingLockoutMs,
} from "@/lib/rate-limit";

function getClientKey(req: NextRequest): string {
  // Best-effort client identifier for rate limiting. Behind most hosting
  // providers (Vercel included) this header is set reliably; falls back to
  // a constant bucket if absent, which still rate-limits overall volume.
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0].trim() ?? "unknown";
}

export async function POST(req: NextRequest) {
  const clientKey = getClientKey(req);

  if (isRateLimited(clientKey)) {
    const remainingMs = getRemainingLockoutMs(clientKey);
    const remainingMin = Math.ceil(remainingMs / 60000);
    return NextResponse.json(
      {
        error: `Too many failed attempts. Try again in ${remainingMin} minute${
          remainingMin === 1 ? "" : "s"
        }.`,
      },
      { status: 429 }
    );
  }

  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { username, password } = body;

  if (!username || !password) {
    return NextResponse.json(
      { error: "Username and password are required." },
      { status: 400 }
    );
  }

  let valid: boolean;
  try {
    valid = checkCredentials(username, password);
  } catch {
    // APP_USERNAME/APP_PASSWORD not configured server-side.
    return NextResponse.json(
      { error: "Server is not configured for login. Contact the administrator." },
      { status: 500 }
    );
  }

  if (!valid) {
    recordFailedAttempt(clientKey);
    return NextResponse.json(
      { error: "Incorrect username or password." },
      { status: 401 }
    );
  }

  clearAttempts(clientKey);
  await createSession();
  return NextResponse.json({ success: true });
}
