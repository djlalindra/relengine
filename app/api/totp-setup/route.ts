import { NextRequest, NextResponse } from "next/server";
import { generateSecret, getQrCodeUrl } from "@/lib/totp";

/**
 * Returns the TOTP setup info (QR code URL + raw secret) so the admin can
 * scan it into Google Authenticator. Protected by TOTP_SETUP_TOKEN — pass
 * it as ?token=... in the URL. Only needed once; after scanning, discard
 * the token and rely on the authenticator app going forward.
 */
export async function GET(req: NextRequest) {
  const setupToken = process.env.TOTP_SETUP_TOKEN;
  const provided = req.nextUrl.searchParams.get("token");

  if (!setupToken || provided !== setupToken) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  // Use existing TOTP_SECRET if set; otherwise generate a new one and
  // tell the admin to save it to their environment.
  let secret = process.env.TOTP_SECRET;
  let isNew = false;

  if (!secret) {
    secret = generateSecret();
    isNew = true;
  }

  return NextResponse.json({
    secret,
    qrCodeUrl: getQrCodeUrl(secret),
    isNew,
    instruction: isNew
      ? `Set TOTP_SECRET=${secret} in your environment variables, then restart the server. Scan the QR code with Google Authenticator.`
      : "Scan the QR code with Google Authenticator.",
  });
}
