import { NextRequest, NextResponse } from "next/server";
import { verifyClientId, issueAuthCode } from "@/lib/oauth";
import { checkCredentials } from "@/lib/auth";

function renderLoginPage(params: {
  clientName: string;
  error?: string;
  hidden: Record<string, string>;
}): string {
  const hiddenInputs = Object.entries(params.hidden)
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${key}" value="${value.replace(/"/g, "&quot;")}" />`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Authorize ${params.clientName}</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0d0d0d; color: #e8e8e8;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { width: 100%; max-width: 380px; padding: 24px; }
    h1 { font-size: 16px; font-weight: 500; margin-bottom: 4px; }
    p { font-size: 13px; color: #888; margin-bottom: 24px; }
    label { font-size: 12px; color: #999; display: block; margin-bottom: 6px; }
    input[type=text], input[type=password] {
      width: 100%; padding: 8px 12px; margin-bottom: 16px; border-radius: 6px;
      border: 1px solid #2a2a2a; background: #161616; color: #e8e8e8; font-size: 14px;
      box-sizing: border-box;
    }
    button { width: 100%; padding: 10px; border-radius: 6px; border: none;
              background: #e8e8e8; color: #0d0d0d; font-weight: 500; cursor: pointer; }
    .error { color: #ff6b6b; font-size: 13px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize ${params.clientName}</h1>
    <p>Sign in to allow this app to access your Relevance Engineering tools.</p>
    ${params.error ? `<p class="error">${params.error}</p>` : ""}
    <form method="POST">
      ${hiddenInputs}
      <label>Username</label>
      <input type="text" name="username" autocomplete="username" required />
      <label>Password</label>
      <input type="password" name="password" autocomplete="current-password" required />
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

function htmlResponse(html: string, status = 200): NextResponse {
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function validateRequest(params: URLSearchParams) {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const responseType = params.get("response_type") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const codeChallengeMethod = params.get("code_challenge_method") ?? "";
  const state = params.get("state") ?? "";
  const scope = params.get("scope") ?? "mcp";

  if (responseType !== "code") {
    return { ok: false as const, error: "unsupported_response_type" };
  }
  if (codeChallengeMethod !== "S256" || !codeChallenge) {
    return { ok: false as const, error: "invalid_request", detail: "PKCE S256 code_challenge is required." };
  }

  const client = await verifyClientId(clientId);
  if (!client) {
    return { ok: false as const, error: "invalid_client" };
  }
  if (!client.redirectUris.includes(redirectUri)) {
    return { ok: false as const, error: "invalid_request", detail: "redirect_uri does not match registered client." };
  }

  return {
    ok: true as const,
    clientId,
    clientName: client.clientName,
    redirectUri,
    codeChallenge,
    state,
    scope,
  };
}

export async function GET(req: NextRequest) {
  const result = await validateRequest(req.nextUrl.searchParams);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, error_description: "detail" in result ? result.detail : undefined },
      { status: 400 }
    );
  }

  const hidden = {
    client_id: result.clientId,
    redirect_uri: result.redirectUri,
    code_challenge: result.codeChallenge,
    state: result.state,
    scope: result.scope,
  };

  return htmlResponse(renderLoginPage({ clientName: result.clientName, hidden }));
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");

  const clientId = String(formData.get("client_id") ?? "");
  const redirectUri = String(formData.get("redirect_uri") ?? "");
  const codeChallenge = String(formData.get("code_challenge") ?? "");
  const state = String(formData.get("state") ?? "");
  const scope = String(formData.get("scope") ?? "mcp");

  const client = await verifyClientId(clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let valid: boolean;
  try {
    valid = checkCredentials(username, password);
  } catch {
    return htmlResponse(
      renderLoginPage({
        clientName: client.clientName,
        error: "Server is not configured for login.",
        hidden: { client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge, state, scope },
      }),
      500
    );
  }

  if (!valid) {
    return htmlResponse(
      renderLoginPage({
        clientName: client.clientName,
        error: "Incorrect username or password.",
        hidden: { client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge, state, scope },
      }),
      401
    );
  }

  const code = await issueAuthCode({ clientId, redirectUri, codeChallenge, scope });

  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);

  return NextResponse.redirect(redirectUrl.toString(), 302);
}
