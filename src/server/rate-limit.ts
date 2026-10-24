import { AppError } from "./errors";

// Fixed-window in-memory limiter. Adequate for a single app instance;
// swap for Redis/Postgres-backed limits when running multiple replicas.
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
  } else if (++bucket.count > limit) {
    const retrySec = Math.ceil((bucket.resetAt - now) / 1000);
    throw new AppError("RATE_LIMITED", `Too many requests. Try again in ${retrySec}s.`);
  }
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
}

/** Throw if `key` has already reached `limit` hits in its window, without counting this call. */
export function assertUnderLimit(key: string, limit: number) {
  const bucket = buckets.get(key);
  if (bucket && bucket.resetAt > Date.now() && bucket.count >= limit) {
    const retrySec = Math.ceil((bucket.resetAt - Date.now()) / 1000);
    throw new AppError("RATE_LIMITED", `Too many attempts. Try again in ${retrySec}s.`);
  }
}

/** Count one hit against `key` (e.g. a failed login). */
export function recordHit(key: string, windowMs: number) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) buckets.set(key, { count: 1, resetAt: now + windowMs });
  else bucket.count++;
}

export function resetRateLimits() {
  buckets.clear();
}
