import { createHmac, randomBytes } from "crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecret(): string {
  const buf = randomBytes(20); // 160 bits
  let bits = 0, val = 0, out = "";
  for (const byte of buf) {
    val = (val << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(val << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const cleaned = s.toUpperCase().replace(/\s/g, "").replace(/=+$/, "");
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac("sha1", key).update(msg).digest();
  const offset = hash[hash.length - 1] & 0xf;
  const code =
    (((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff)) %
    1_000_000;
  return code.toString().padStart(6, "0");
}

/**
 * Verifies a 6-digit TOTP code against the stored secret.
 * Allows ±1 time window (30 s each) to tolerate clock drift.
 */
export function verifyTOTP(secret: string, token: string): boolean {
  const cleaned = token.replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  const t = Math.floor(Date.now() / 1000 / 30);
  return [-1, 0, 1].some((d) => hotp(secret, t + d) === cleaned);
}

/**
 * Returns a QR code image URL for scanning into Google Authenticator.
 * Uses api.qrserver.com which does not require API keys and works from Vercel.
 */
export function getQrCodeUrl(secret: string, label = "Relevance Engineering"): string {
  const uri = `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(label)}&algorithm=SHA1&digits=6&period=30`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=256x256&margin=10&data=${encodeURIComponent(uri)}`;
}

/** Returns true if the secret contains only valid base32 characters (A-Z, 2-7). */
export function isValidBase32(secret: string): boolean {
  return /^[A-Z2-7]{16,}$/i.test(secret.replace(/\s/g, ""));
}

export function getTOTPSecret(): string {
  const s = process.env.TOTP_SECRET;
  if (!s) throw new Error("TOTP_SECRET is not set in environment variables.");
  return s;
}
