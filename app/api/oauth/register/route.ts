import { NextRequest, NextResponse } from "next/server";
import { issueClientId } from "@/lib/oauth";

export async function POST(req: NextRequest) {
  let body: { redirect_uris?: string[]; client_name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_client_metadata", error_description: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const redirectUris = body.redirect_uris;
  if (!redirectUris || !Array.isArray(redirectUris) || redirectUris.length === 0) {
    return NextResponse.json(
      {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris is required and must be a non-empty array.",
      },
      { status: 400 }
    );
  }

  for (const uri of redirectUris) {
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
        return NextResponse.json(
          {
            error: "invalid_redirect_uri",
            error_description: `redirect_uri must use https: ${uri}`,
          },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: "invalid_redirect_uri", error_description: `Malformed redirect_uri: ${uri}` },
        { status: 400 }
      );
    }
  }

  const clientName = body.client_name || "Unnamed MCP Client";
  const clientId = await issueClientId(redirectUris, clientName);

  return NextResponse.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      client_name: clientName,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { status: 201 }
  );
}
