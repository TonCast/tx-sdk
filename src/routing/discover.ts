import type { StonApiClient } from "@ston-fi/api";
import { DEFAULT_SLIPPAGE, DEX_VERSION, TON_ADDRESS } from "../constants.js";
import { ToncastBetError, ToncastNetworkError } from "../errors.js";
import { normalizeAddress, sameAddress } from "../utils/address.js";
import { perLegSlippage } from "../utils/slippage.js";
import { PairsCache } from "./pairsCache.js";

/** Async wrapper for a `StonApiClient` call surfaced as {@link ToncastNetworkError}. */
type NetworkCaller = <T>(fn: () => Promise<T>, method: string) => Promise<T>;

export type SwapSimulation = Awaited<ReturnType<StonApiClient["simulateSwap"]>>;

export type DiscoveredRoute =
  | {
      type: "direct";
      /** Simulation of `offerAddress → TON`. */
      leg1: SwapSimulation;
    }
  | {
      type: "cross";
      /** Address of the intermediate jetton (`offerAddress → intermediate`). */
      intermediate: string;
      /** Simulation of `offerAddress → intermediate`. */
      leg1: SwapSimulation;
      /** Simulation of `intermediate → TON`. */
      leg2: SwapSimulation;
    };

export type DiscoverRouteInput = {
  apiClient: StonApiClient;
  offerAddress: string;
  offerUnits: string;
  slippage?: string;
  /** Max intermediate jetton candidates to evaluate when direct pool is absent. */
  maxCandidates?: number;
  /** Networking wrapper (throttle + retry). Optional — if absent, calls raw. */
  callStonApi?: NetworkCaller;
  /**
   * Optional shared pairs cache. When omitted, a one-off cache is
   * constructed for this call (backwards-compatible; no memoisation
   * across calls). Callers that run `discoverRoute` N times (e.g.
   * `priceCoins`) should share a single instance to fetch
   * `/v1/markets` only once.
   */
  pairsCache?: PairsCache;
};

const DEFAULT_MAX_CANDIDATES = 5;

const defaultCaller: NetworkCaller = async (fn, method) => {
  try {
    return await fn();
  } catch (cause) {
    throw new ToncastNetworkError("stonApi", method, cause);
  }
};

/**
 * Discover the best route from `offerAddress` to native TON:
 *
 * 1. Check the (cached) `/v1/markets` pair list: is there a direct
 *    `offer → TON` pair? If yes, run `simulateSwap` direct. If it
 *    produces positive `minAskUnits`, return as a `direct` route.
 * 2. Otherwise (no direct pair, or simulate refused) enumerate pairs
 *    that connect `offerAddress` to some intermediate, then the
 *    intermediate to TON. Pick the intermediate with the highest pool
 *    TVL, simulate both legs, return a `cross` route.
 *
 * Pre-checking the pair list avoids the deterministic HTTP 400 that the
 * STON.fi API returns when a pair has no direct pool (observed for
 * jettons like TCAST that only have USDT pools). Errors that would
 * normally show up in the user's console disappear for pools that were
 * never going to route directly.
 *
 * All upstream failures are surfaced as {@link ToncastNetworkError}.
 */
export async function discoverRoute(
  input: DiscoverRouteInput,
): Promise<DiscoveredRoute> {
  const {
    apiClient,
    offerAddress,
    offerUnits,
    slippage = DEFAULT_SLIPPAGE,
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    callStonApi = defaultCaller,
  } = input;

  const pairsCache = input.pairsCache ?? new PairsCache(apiClient, callStonApi);

  // Step 1 — check if a direct pair exists. Pair presence does NOT
  // guarantee the simulate call will succeed (pool may be empty /
  // deprecated), but its ABSENCE is a strong signal and avoids the 400.
  const hasDirect = await pairsCache
    .hasDirectPoolWithTon(offerAddress)
    .catch(() => false); // fall through to cross if pairs fetch fails

  if (hasDirect) {
    try {
      const sim = await callStonApi(
        () =>
          apiClient.simulateSwap({
            offerAddress,
            askAddress: TON_ADDRESS,
            offerUnits,
            slippageTolerance: slippage,
            dexVersion: DEX_VERSION,
          }),
        "simulateSwap",
      );
      if (sim.minAskUnits && BigInt(sim.minAskUnits) > 0n) {
        return { type: "direct", leg1: sim };
      }
    } catch {
      // Simulation failed despite pair being listed — pool might be
      // deprecated or drained. Fall through to 2-hop discovery.
    }
  }

  // Step 2 — 2-hop discovery.
  let candidates: string[];
  try {
    candidates = await pairsCache.getCrossHopCandidates(offerAddress);
  } catch (cause) {
    throw cause instanceof ToncastNetworkError
      ? cause
      : new ToncastNetworkError("stonApi", "getSwapPairs", cause);
  }

  if (candidates.length === 0) {
    throw new ToncastBetError(
      "NO_ROUTE",
      `[Route discovery] No route from ${offerAddress} to TON (no direct pair, no cross-hop intermediate with a TON pool)`,
    );
  }

  // Rank candidates by pool TVL (USD), take the deepest pool as the hop.
  const top = candidates.slice(0, maxCandidates);
  const poolResults = await Promise.allSettled(
    top.map(async (mid) => {
      const pools = await callStonApi(
        () =>
          apiClient.getPoolsByAssetPair({
            asset0Address: offerAddress,
            asset1Address: mid,
          }),
        "getPoolsByAssetPair",
      );
      const best = pools.reduce(
        (acc, p) =>
          Number(p.lpTotalSupplyUsd ?? 0) > Number(acc.lpTotalSupplyUsd ?? 0)
            ? p
            : acc,
        pools[0] ?? ({ lpTotalSupplyUsd: "0" } as (typeof pools)[number]),
      );
      return { mid, liquidity: Number(best?.lpTotalSupplyUsd ?? 0) };
    }),
  );

  const ranked = poolResults
    .filter(
      (r): r is PromiseFulfilledResult<{ mid: string; liquidity: number }> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value)
    .sort((a, b) => b.liquidity - a.liquidity);

  const intermediate = ranked[0]?.mid ?? top[0];
  if (!intermediate) {
    throw new ToncastBetError(
      "NO_ROUTE",
      `[Route discovery] No 2-hop intermediate selected for ${offerAddress}`,
    );
  }

  // Cross-hop simulation uses a per-leg slippage so the route's compound
  // worst-case still equals the user's `slippage` route-total budget. The
  // returned `leg1.minAskUnits` / `leg2.minAskUnits` thus reflect the
  // per-leg floor (`ask × (1 − legSlip)`); pricing / rates layers compose
  // those into a route-total floor when sizing tonEquivalent or rebuilding
  // the swap on confirm. See `utils/slippage.ts::perLegSlippage`.
  const legSlippage = perLegSlippage(slippage, 2);

  const leg1 = await callStonApi(
    () =>
      apiClient.simulateSwap({
        offerAddress,
        askAddress: intermediate,
        offerUnits,
        slippageTolerance: legSlippage,
        dexVersion: DEX_VERSION,
      }),
    "simulateSwap",
  );
  if (!leg1.minAskUnits || BigInt(leg1.minAskUnits) <= 0n) {
    throw new ToncastBetError(
      "NO_ROUTE",
      `[Route discovery] Leg1 (${offerAddress} → ${intermediate}) returned zero minAskUnits — insufficient pool liquidity`,
    );
  }

  const leg2 = await callStonApi(
    () =>
      apiClient.simulateSwap({
        offerAddress: intermediate,
        askAddress: TON_ADDRESS,
        offerUnits: leg1.askUnits,
        slippageTolerance: legSlippage,
        dexVersion: DEX_VERSION,
      }),
    "simulateSwap",
  );
  if (!leg2.minAskUnits || BigInt(leg2.minAskUnits) <= 0n) {
    throw new ToncastBetError(
      "NO_ROUTE",
      `[Route discovery] Leg2 (${intermediate} → TON) returned zero minAskUnits — insufficient pool liquidity`,
    );
  }

  return { type: "cross", intermediate, leg1, leg2 };
}

// Re-exports — minor internal refactors shouldn't force downstream to
// update imports.
export { sameAddress, normalizeAddress };
