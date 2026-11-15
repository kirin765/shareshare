/**
 * Fixed-window limiter. Keys are IP addresses or socket ids; buckets are
 * removed by the room sweeper so memory does not grow with failed attempts.
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(limit: number, windowMs: number, now: () => number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  allow(key: string): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.#windowMs) {
      this.#buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    if (bucket.count >= this.#limit) return false;
    bucket.count += 1;
    return true;
  }

  sweep(): void {
    const now = this.#now();
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.windowStart >= this.#windowMs) this.#buckets.delete(key);
    }
  }

  get size(): number {
    return this.#buckets.size;
  }
}
