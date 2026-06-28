import { SignJWT, jwtVerify } from "jose";
import { createHash } from "crypto";

/**
 * Stateless OAuth 2.1 + Dynamic Client Registration, self-hosted in this
 * same app (no third-party identity provider, no database).
 *
 * Why stateless: Vercel serverless functions don't share memory across
 * invocations, so a normal in-memory "registered clients" store wouldn't
 * survive between requests. Instead, every issued client_id, authorization
 * code, and token is itself a signed JWT carrying whatever data would
 * normally live in a database row. Verifying the signature IS the lookup.
 * This is a legitimate, standard pattern for OAuth without persistent
 * storage, not a shortcut that skips real security -- the signature still
 * makes these values unforgeable.
 */

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET is missing or too short.");
  }
  return new TextEncoder().encode(secret);
}

export type ClientRecord = {
  type: "client";
  redirectUris: string[];
  clientName: string;
};

export type AuthCodePayload = {
  type: "auth_code";
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
};

export type AccessTokenPayload = {
  type: "access_token";
  clientId: string;
  scope: string;
};

export type RefreshTokenPayload = {
  type: "refresh_token";
  clientId: string;
  scope: string;
};

async function sign(payload: Record<string, unknown>, expiresIn: string): Promise<string> {
  const secret = getSecret();
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

async function verify<T>(token: string): Promise<T | null> {
  try {
    const secret = getSecret();
    const { payload } = await jwtVerify(token, secret);
    return payload as unknown as T;
  } catch {
    return null;
  }
}

export async function issueClientId(redirectUris: string[], clientName: string): Promise<string> {
  return sign({ type: "client", redirectUris, clientName } satisfies ClientRecord, "1y");
}

export async function verifyClientId(clientId: string): Promise<ClientRecord | null> {
  const payload = await verify<ClientRecord>(clientId);
  if (!payload || payload.type !== "client") return null;
  return payload;
}

export async function issueAuthCode(
  data: Omit<AuthCodePayload, "type">
): Promise<string> {
  return sign({ type: "auth_code", ...data } satisfies AuthCodePayload, "5m");
}

export async function verifyAuthCode(code: string): Promise<AuthCodePayload | null> {
  const payload = await verify<AuthCodePayload>(code);
  if (!payload || payload.type !== "auth_code") return null;
  return payload;
}

export async function issueAccessToken(clientId: string, scope: string): Promise<string> {
  return sign({ type: "access_token", clientId, scope } satisfies AccessTokenPayload, "1h");
}

export async function issueRefreshToken(clientId: string, scope: string): Promise<string> {
  return sign({ type: "refresh_token", clientId, scope } satisfies RefreshTokenPayload, "30d");
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  const payload = await verify<AccessTokenPayload>(token);
  if (!payload || payload.type !== "access_token") return null;
  return payload;
}

export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload | null> {
  const payload = await verify<RefreshTokenPayload>(token);
  if (!payload || payload.type !== "refresh_token") return null;
  return payload;
}

/**
 * Base64url encode (no padding), per RFC 7636 PKCE requirements.
 */
function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Verifies a PKCE code_verifier against the code_challenge that was
 * captured at authorization time. Only S256 is supported (plain is
 * deprecated/insecure and not offered).
 */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const hash = createHash("sha256").update(codeVerifier).digest();
  const computed = base64url(hash);
  return computed === codeChallenge;
}
