/**
 * In-memory rate limiter for login attempts.
 *
 * Scope/limitation: this resets if the server restarts and does not share
 * state across multiple instances. For a single-user/small-team tool on a
 * single serverless region or single long-running server, this is sufficient
 * to stop casual brute-forcing. It is NOT a substitute for a distributed
 * rate limiter (e.g. Upstash Redis) if this app ever sees real attack
 * traffic or runs across multiple regions/instances.
 */

type Attempt = { count: number; firstAttempt: number };

const attempts = new Map<string, Attempt>();

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

export function isRateLimited(key: string): boolean {
  const record = attempts.get(key);
  if (!record) return false;

  const elapsed = Date.now() - record.firstAttempt;
  if (elapsed > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }

  return record.count >= MAX_ATTEMPTS;
}

export function recordFailedAttempt(key: string): void {
  const record = attempts.get(key);
  const now = Date.now();

  if (!record || now - record.firstAttempt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAttempt: now });
    return;
  }

  record.count += 1;
}

export function clearAttempts(key: string): void {
  attempts.delete(key);
}

export function getRemainingLockoutMs(key: string): number {
  const record = attempts.get(key);
  if (!record) return 0;
  const elapsed = Date.now() - record.firstAttempt;
  return Math.max(0, WINDOW_MS - elapsed);
}
