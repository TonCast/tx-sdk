import type { StonApiClient } from "@ston-fi/api";
import { DEFAULT_SLIPPAGE, DEX_VERSION, TON_ADDRESS } from "../constants.js";
import { ToncastBetError, ToncastNetworkError } from "../errors.js";
import { normalizeAddress, sameAddress } from "../utils/address.js";

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
 * 1. Try a direct simulation `offer → TON`. If it produces positive
 *    `minAskUnits`, return it as a `direct` route.
 * 2. Otherwise enumerate pairs that connect `offerAddress` to some
 *    intermediate, and the intermediate to TON. Pick the intermediate with
 *    the highest pool TVL, simulate both legs, and return a `cross` route.
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

  // Fire direct sim + pairs prefetch concurrently. If direct works we throw
  // pairs away; if it fails we already have them.
  const [directResult, pairsResult] = await Promise.allSettled([
    callStonApi(
      () =>
        apiClient.simulateSwap({
          offerAddress,
          askAddress: TON_ADDRESS,
          offerUnits,
          slippageTolerance: slippage,
          dexVersion: DEX_VERSION,
        }),
      "simulateSwap",
    ),
    callStonApi(() => apiClient.getSwapPairs(), "getSwapPairs"),
  ]);

  if (directResult.status === "fulfilled") {
    const sim = directResult.value;
    if (sim.minAskUnits && BigInt(sim.minAskUnits) > 0n) {
      return { type: "direct", leg1: sim };
    }
  }

  // Direct unavailable — need to build a 2-hop route.
  if (pairsResult.status === "rejected") {
    // Pairs fetch itself errored with a wrapped ToncastNetworkError.
    throw pairsResult.reason;
  }
  const pairs = pairsResult.value;

  // STON.fi API may return addresses in any textual format; compare via
  // parsed workchain+hash so we don't miss a valid 2-hop route when the
  // API returns e.g. raw `0:…` while the caller passed `EQ…`.
  const tonPairs = new Set<string>();
  for (const p of pairs) {
    if (!p[0] || !p[1]) continue;
    if (sameAddress(p[1], TON_ADDRESS)) tonPairs.add(normalizeAddress(p[0]));
  }
  const candidates = [
    ...new Set(
      pairs
        .filter((p) => !!p[0] && !!p[1] && sameAddress(p[0], offerAddress))
        .map((p) => normalizeAddress(p[1] as string))
        .filter(
          (addr): addr is string =>
            !!addr && !sameAddress(addr, TON_ADDRESS) && tonPairs.has(addr),
        ),
    ),
  ];

  if (candidates.length === 0) {
    throw new ToncastBetError(
      "NO_ROUTE",
      `[Route discovery] No 2-hop route: ${offerAddress} has no pairs bridging to TON (direct swap also failed)`,
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

  const leg1 = await callStonApi(
    () =>
      apiClient.simulateSwap({
        offerAddress,
        askAddress: intermediate,
        offerUnits,
        slippageTolerance: slippage,
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
        slippageTolerance: slippage,
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
