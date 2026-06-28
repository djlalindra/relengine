import { NextRequest, NextResponse } from "next/server";
import {
  verifyAuthCode,
  verifyRefreshToken,
  issueAccessToken,
  issueRefreshToken,
  verifyPkce,
} from "@/lib/oauth";

async function parseBody(req: NextRequest): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return req.json();
  }
  const formData = await req.formData();
  const result: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    result[key] = String(value);
  }
  return result;
}

export async function POST(req: NextRequest) {
  const body = await parseBody(req);
  const grantType = body.grant_type;

  if (grantType === "authorization_code") {
    const code = body.code;
    const redirectUri = body.redirect_uri;
    const clientId = body.client_id;
    const codeVerifier = body.code_verifier;

    if (!code || !redirectUri || !clientId || !codeVerifier) {
      return NextResponse.json(
        { error: "invalid_request", error_description: "Missing required parameters." },
        { status: 400 }
      );
    }

    const authCode = await verifyAuthCode(code);
    if (!authCode) {
      return NextResponse.json(
        { error: "invalid_grant", error_description: "Authorization code is invalid or expired." },
        { status: 400 }
      );
    }

    if (authCode.clientId !== clientId || authCode.redirectUri !== redirectUri) {
      return NextResponse.json(
        { error: "invalid_grant", error_description: "client_id or redirect_uri does not match." },
        { status: 400 }
      );
    }

    if (!verifyPkce(codeVerifier, authCode.codeChallenge)) {
      return NextResponse.json(
        { error: "invalid_grant", error_description: "PKCE verification failed." },
        { status: 400 }
      );
    }

    const accessToken = await issueAccessToken(authCode.clientId, authCode.scope);
    const refreshToken = await issueRefreshToken(authCode.clientId, authCode.scope);

    return NextResponse.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: authCode.scope,
    });
  }

  if (grantType === "refresh_token") {
    const refreshTokenValue = body.refresh_token;
    if (!refreshTokenValue) {
      return NextResponse.json(
        { error: "invalid_request", error_description: "Missing refresh_token." },
        { status: 400 }
      );
    }

    const payload = await verifyRefreshToken(refreshTokenValue);
    if (!payload) {
      return NextResponse.json(
        { error: "invalid_grant", error_description: "Refresh token is invalid or expired." },
        { status: 400 }
      );
    }

    const accessToken = await issueAccessToken(payload.clientId, payload.scope);
    const newRefreshToken = await issueRefreshToken(payload.clientId, payload.scope);

    return NextResponse.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: newRefreshToken,
      scope: payload.scope,
    });
  }

  return NextResponse.json(
    { error: "unsupported_grant_type", error_description: `Unsupported grant_type: ${grantType}` },
    { status: 400 }
  );
}
