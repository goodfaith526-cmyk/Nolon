interface Bucket {
  failures: number;
  windowStart: number;
  blockedUntil: number;
}

export interface LimitRule {
  maxFailures: number;
  windowMs: number;
  blockMs: number;
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** Per email: 10 failures in 15 minutes blocks that email for 15 minutes. */
export const EMAIL_RULE: LimitRule = {
  maxFailures: 10,
  windowMs: FIFTEEN_MINUTES,
  blockMs: FIFTEEN_MINUTES,
};

/** Per client IP: 50 failures in 15 minutes blocks that IP for 15 minutes. */
export const IP_RULE: LimitRule = {
  maxFailures: 50,
  windowMs: FIFTEEN_MINUTES,
  blockMs: FIFTEEN_MINUTES,
};

/**
 * In-memory failed sign-in counter (one API instance). A block is a delay, never a permanent
 * lock. Keys are namespaced by the caller ("email:..." / "ip:...").
 */
export class FailureLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly rule: LimitRule,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(key: string): boolean {
    const bucket = this.buckets.get(key);
    return bucket !== undefined && bucket.blockedUntil > this.now();
  }

  recordFailure(key: string): void {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.rule.windowMs) {
      bucket = { failures: 0, windowStart: now, blockedUntil: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.failures += 1;
    if (bucket.failures >= this.rule.maxFailures) {
      bucket.blockedUntil = now + this.rule.blockMs;
      bucket.failures = 0;
      bucket.windowStart = now;
    }
    this.prune(now);
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Drops idle buckets so the map cannot grow without bound. */
  private prune(now: number): void {
    if (this.buckets.size < 10_000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.blockedUntil <= now && now - bucket.windowStart >= this.rule.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}
