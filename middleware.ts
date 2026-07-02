import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "aeo_session";

const PUBLIC_PATHS = [
  "/login",
  "/api/login",
  "/api/oauth",
  "/setup-2fa",
  "/api/totp-setup",
  "/_next",
  "/favicon",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;

  if (token) {
    try {
      const secret = process.env.SESSION_SECRET;
      if (secret && secret.length >= 32) {
        await jwtVerify(token, new TextEncoder().encode(secret));
        return NextResponse.next();
      }
    } catch {
      // token invalid or expired — fall through to redirect
    }
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
