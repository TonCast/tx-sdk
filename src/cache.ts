/**
 * Tiny TTL cache for `simulateSwap` / `simulateReverseSwap` results.
 *
 * Keyed by a normalised `(offer, ask, units, slippage)` string. Values live
 * for up to `ttlMs` milliseconds — after that, reads miss and the caller is
 * expected to re-fetch.
 *
 * No invalidation beyond TTL. No eviction — intended for small working sets
 * (a handful of jettons × a couple of slippage values).
 */
export class TtlCache<V> {
  private readonly store = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Fetch or populate the cache. If a fresh entry exists it is returned
   * without calling `compute`; otherwise `compute` runs and its result is
   * memoised.
   */
  async remember(key: string, compute: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    this.set(key, value);
    return value;
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Compose a deterministic cache key for a swap simulation.
 *
 * `units` are rounded down to 5 significant decimals so that adjacent
 * binary-search attempts hit the same cache entry.
 */
export function makeSwapCacheKey(params: {
  offerAddress: string;
  askAddress: string;
  units: string;
  slippage: string;
  direction: "forward" | "reverse";
}): string {
  return [
    params.direction,
    params.offerAddress,
    params.askAddress,
    // Bucket by 5 leading digits to coalesce close reverse-quote probes.
    bucketUnits(params.units),
    params.slippage,
  ].join("|");
}

function bucketUnits(units: string): string {
  // Guard against non-numeric strings.
  if (!/^-?\d+$/.test(units)) return units;
  if (units.length <= 5) return units;
  // Keep the 5 most significant digits; zero out the rest.
  const keep = units.slice(0, 5);
  const pad = units.length - 5;
  return `${keep}${"0".repeat(pad)}`;
}
