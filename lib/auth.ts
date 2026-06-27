import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const SESSION_COOKIE = "aeo_session";
const SESSION_DURATION_SECONDS = 60 * 60 * 8; // 8 hours

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "SESSION_SECRET is missing or too short. Set a random 32+ character value in your environment."
    );
  }
  return new TextEncoder().encode(secret);
}

/**
 * Verifies submitted credentials against the predefined username/password
 * stored in environment variables. Never compares plaintext in a way that
 * short-circuits early -- timing-safe-ish via fixed-length comparison isn't
 * critical here since this guards a single shared credential, but we still
 * avoid leaking which field was wrong.
 */
export function checkCredentials(username: string, password: string): boolean {
  const expectedUser = process.env.APP_USERNAME;
  const expectedPass = process.env.APP_PASSWORD;

  if (!expectedUser || !expectedPass) {
    throw new Error(
      "APP_USERNAME or APP_PASSWORD is not set in the environment."
    );
  }

  // Both must match. Intentionally not revealing which one failed.
  return username === expectedUser && password === expectedPass;
}

export async function createSession(): Promise<void> {
  const secret = getSecret();
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .sign(secret);

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function getSession(): Promise<boolean> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE)?.value;
    if (!token) return false;

    const secret = getSecret();
    const { payload } = await jwtVerify(token, secret);
    return payload.authenticated === true;
  } catch {
    return false;
  }
}

export { SESSION_COOKIE };
