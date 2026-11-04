type Bucket = { startedAt: number; count: number };

/** A bounded fixed-window limiter keyed by the caller's transport address. */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastPrunedAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxSubjects = 10_000,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
    if (!Number.isInteger(windowMs) || windowMs < 1)
      throw new RangeError('windowMs must be a positive integer');
    if (!Number.isInteger(maxSubjects) || maxSubjects < 1)
      throw new RangeError('maxSubjects must be a positive integer');
  }

  get trackedSubjects(): number {
    return this.buckets.size;
  }

  allow(subject: string, now = Date.now()): boolean {
    if (now - this.lastPrunedAt >= Math.min(this.windowMs, 10_000)) {
      for (const [key, bucket] of this.buckets) {
        if (now - bucket.startedAt >= this.windowMs) this.buckets.delete(key);
      }
      this.lastPrunedAt = now;
    }

    let bucket = this.buckets.get(subject);
    if (!bucket || now - bucket.startedAt >= this.windowMs) {
      if (this.buckets.size >= this.maxSubjects) {
        const oldest = this.buckets.keys().next().value as string | undefined;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { startedAt: now, count: 0 };
    }

    bucket.count += 1;
    this.buckets.delete(subject);
    this.buckets.set(subject, bucket);
    return bucket.count <= this.limit;
  }
}
