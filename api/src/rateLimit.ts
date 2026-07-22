// Minimal fixed-window rate limiter for the login endpoint (AUTH-SPEC §6):
// blunts access-code guessing since the code is the master credential.
//
// NOTE: in-memory and per-instance only. On multi-instance Render, move this to
// the shared Redis introduced in Phase 7. Adequate for single-instance / dev.

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;

const buckets = new Map<string, { count: number; resetAt: number }>();

/** Returns true if the caller is allowed, false if rate-limited. */
export function allowLoginAttempt(key: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (bucket.count >= MAX_ATTEMPTS) return false;
  bucket.count += 1;
  return true;
}

// Opportunistic cleanup so the map does not grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}, WINDOW_MS).unref();
