import type { Clock } from "./types.js";

export interface RateSample {
  bytesPerSecond: number;
  etaMs: number | null;
}

/**
 * Short window throughput estimate. Kept intentionally simple: it never
 * extrapolates from less than 250 ms of data and reports no ETA until it has a
 * positive rate.
 */
export class RateMeter {
  #clock: Clock;
  #samples: Array<{ at: number; bytes: number }> = [];

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  record(bytes: bigint): void {
    const at = this.#clock.now();
    this.#samples.push({ at, bytes: Number(bytes) });
    while (this.#samples.length > 2 && at - this.#samples[0]!.at > 2000) {
      this.#samples.shift();
    }
  }

  sample(remaining: bigint): RateSample {
    const first = this.#samples[0];
    const last = this.#samples[this.#samples.length - 1];
    if (!first || !last) return { bytesPerSecond: 0, etaMs: null };
    const elapsed = last.at - first.at;
    if (elapsed < 250) return { bytesPerSecond: 0, etaMs: null };
    const delta = last.bytes - first.bytes;
    if (delta <= 0) return { bytesPerSecond: 0, etaMs: null };
    const bytesPerSecond = (delta / elapsed) * 1000;
    const etaMs = remaining > 0n ? Math.round((Number(remaining) / bytesPerSecond) * 1000) : 0;
    return { bytesPerSecond, etaMs };
  }
}
