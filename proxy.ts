import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "aeo_session";

const PUBLIC_PATHS = [
  "/login",
  "/api/login",
  "/api/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/api/oauth/register",
  "/api/oauth/authorize",
  "/api/oauth/token",
];

async function isAuthenticated(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;

  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;

  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(secret)
    );
    return payload.authenticated === true;
  } catch {
    return false;
  }
}

export async function proxy(req: NextRequest) {
  const { pathname, origin } = req.nextUrl;

  // Handled directly here rather than via app/.well-known/* route files:
  // Next.js's App Router file-based routing does not reliably resolve
  // dot-prefixed folder segments (reproduced locally -- the request hangs
  // indefinitely with zero bytes returned, not a clean 404). Middleware
  // matches on raw pathname strings, which sidesteps that entirely.
  if (pathname === "/.well-known/oauth-protected-resource") {
    return NextResponse.json({
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
    });
  }

  if (pathname === "/.well-known/oauth-authorization-server") {
    return NextResponse.json({
      issuer: origin,
      authorization_endpoint: `${origin}/api/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  }

  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));
  if (isPublic) {
    return NextResponse.next();
  }

  const authed = await isAuthenticated(req);

  if (!authed) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static, _next/image (Next internals)
     * - favicon.ico
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
