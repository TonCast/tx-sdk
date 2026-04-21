import { sleep } from "./sleep.js";

/**
 * Serialise async calls so that consecutive invocations start no sooner than
 * `minIntervalMs` apart. Minimal footprint — uses a single chained Promise
 * and `Date.now()` to compute wait time.
 *
 * `minIntervalMs === 0` disables throttling entirely (calls still go through
 * the same chain, so ordering is preserved).
 */
export class Throttler {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStartAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const step = async (): Promise<T> => {
      if (this.minIntervalMs > 0) {
        const now = Date.now();
        const wait = Math.max(0, this.lastStartAt + this.minIntervalMs - now);
        if (wait > 0) await sleep(wait);
      }
      this.lastStartAt = Date.now();
      return fn();
    };

    // Chain on success OR failure so one failed call doesn't freeze the chain.
    const result = this.chain.then(step, step) as Promise<T>;
    // Swallow errors on the chain itself to keep subsequent calls flowing.
    this.chain = result.catch(() => undefined);
    return result;
  }
}
