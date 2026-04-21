import type { StonApiClient } from "@ston-fi/api";
import { PAIRS_CACHE_TTL_MS, TON_ADDRESS } from "../constants.js";
import { normalizeAddress, sameAddress } from "../utils/address.js";

type NetworkCaller = <T>(fn: () => Promise<T>, method: string) => Promise<T>;

export type PairsSnapshot = {
  /** Raw pair list as returned by `/v1/markets`: `[offer, ask][]`. */
  pairs: Array<[string, string]>;
  /**
   * Lookup by normalised offer address → set of normalised ask addresses.
   * Built once per fetch so `hasDirectPoolWithTon` et al. avoid rescanning
   * the 40K-entry list on every probe.
   */
  byOffer: Map<string, Set<string>>;
  /**
   * All addresses that appear on the `ask` side of a pair with TON. Used
   * to enumerate valid intermediates for cross-hop discovery.
   */
  tonAsks: Set<string>;
  /** Timestamp of the fetch. */
  fetchedAt: number;
};

/**
 * TTL-cached view over `StonApiClient.getSwapPairs()` (= `/v1/markets`).
 *
 * The raw list has ~40K entries and rarely changes, so fetching it per
 * coin during `priceCoins` is wasteful. This cache:
 *
 * - Fetches on first request; subsequent calls within {@link PAIRS_CACHE_TTL_MS}
 *   return the memoised snapshot.
 * - Deduplicates in-flight requests: if 10 parallel `priceCoins` coroutines
 *   arrive while the fetch is pending, only one HTTP call goes out; the
 *   rest await the same promise.
 * - Normalises addresses once, so address comparisons in `discoverRoute`
 *   are O(1) map lookups instead of linear scans of the raw array.
 */
export class PairsCache {
  private snapshot: PairsSnapshot | null = null;
  private inFlight: Promise<PairsSnapshot> | null = null;

  constructor(
    private readonly apiClient: StonApiClient,
    private readonly callStonApi: NetworkCaller,
    private readonly ttlMs: number = PAIRS_CACHE_TTL_MS,
  ) {}

  /**
   * Fetch or return cached pairs. Re-fetches once the entry ages past TTL.
   * Concurrent callers share the same in-flight fetch.
   */
  async get(): Promise<PairsSnapshot> {
    const now = Date.now();
    if (this.snapshot && now - this.snapshot.fetchedAt < this.ttlMs) {
      return this.snapshot;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetch()
      .then((snap) => {
        this.snapshot = snap;
        return snap;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Fast local check: is there a direct pair `offer → TON`? */
  async hasDirectPoolWithTon(offerAddress: string): Promise<boolean> {
    const snap = await this.get();
    const asks = snap.byOffer.get(normalizeAddress(offerAddress));
    return asks?.has(normalizeAddress(TON_ADDRESS)) ?? false;
  }

  /**
   * Discover candidate intermediates for a cross-hop route: jettons that
   * appear both as an ask-side counterpart of `offerAddress` AND on the
   * offer side of a pair with TON. Returns normalised addresses.
   */
  async getCrossHopCandidates(offerAddress: string): Promise<string[]> {
    const snap = await this.get();
    const asks = snap.byOffer.get(normalizeAddress(offerAddress));
    if (!asks) return [];
    const candidates: string[] = [];
    const tonNorm = normalizeAddress(TON_ADDRESS);
    for (const mid of asks) {
      if (mid === tonNorm) continue;
      if (snap.tonAsks.has(mid)) candidates.push(mid);
    }
    return candidates;
  }

  /** Reset both the snapshot and any in-flight fetch. */
  clear(): void {
    this.snapshot = null;
    this.inFlight = null;
  }

  private async fetch(): Promise<PairsSnapshot> {
    const pairs = await this.callStonApi(
      () => this.apiClient.getSwapPairs(),
      "getSwapPairs",
    );
    return buildSnapshot(pairs);
  }
}

function buildSnapshot(pairs: Array<[string, string]>): PairsSnapshot {
  const byOffer = new Map<string, Set<string>>();
  const tonAsks = new Set<string>();
  for (const p of pairs) {
    if (!p[0] || !p[1]) continue;
    const offer = normalizeAddress(p[0]);
    const ask = normalizeAddress(p[1]);
    let set = byOffer.get(offer);
    if (!set) {
      set = new Set();
      byOffer.set(offer, set);
    }
    set.add(ask);
    if (sameAddress(ask, TON_ADDRESS)) tonAsks.add(offer);
  }
  return { pairs, byOffer, tonAsks, fetchedAt: Date.now() };
}
