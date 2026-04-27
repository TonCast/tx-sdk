import type { StonApiClient } from "@ston-fi/api";
import type { Client as TonClient } from "@ston-fi/sdk";
import {
  CROSS_HOP_JETTON_GAS_ESTIMATE,
  DEFAULT_SLIPPAGE,
  DEFAULT_WALLET_RESERVE,
  DIRECT_HOP_JETTON_GAS_ESTIMATE,
  TON_ADDRESS,
  TON_DIRECT_GAS,
} from "./constants.js";
import { ToncastError } from "./errors.js";
import { discoverRoute } from "./routing/discover.js";
import type { PairsCache } from "./routing/pairsCache.js";
import type { AvailableCoin, PricedCoin } from "./types.js";
import { sameAddress } from "./utils/address.js";

/**
 * Guaranteed TON this priced coin can contribute to a bet.
 *
 * Handles the TON/jetton asymmetry in one place:
 *
 * - **TON**: subtracts `walletReserve` + `gasReserve` (= {@link TON_DIRECT_GAS},
 *   default `0n`). With the default the only deduction is `walletReserve`
 *   itself — `PARI_EXECUTION_FEE` already covers Pari's processing gas
 *   from inside `totalCost`, so no extra buffer is needed.
 * - **Jetton**: equals `tonEquivalent` (the pessimistic `minAskUnits` of
 *   the full swap). Swap gas is billed to the user's TON wallet
 *   separately, NOT to this jetton, so it must NOT be deducted here.
 *
 * Returns `0n` when `!viable`, a non-viable coin has nothing to offer.
 *
 * Use this as the unified capacity check, **and** as the slider max for
 * UI bet sizing — guaranteed to fit alongside `walletReserve`:
 *
 * ```ts
 * const maxBudget = availableForBet(picked, walletReserve);
 * ```
 *
 * UI layers that want an optimistic "you will get ~X TON" label should
 * use `coin.tonEquivalentExpected` (not this function) — that one is
 * the slippage-unadjusted projection and typically ~5% higher.
 */
export function availableForBet(
  coin: PricedCoin,
  walletReserve: bigint,
): bigint {
  if (!coin.viable) return 0n;
  if (sameAddress(coin.address, TON_ADDRESS)) {
    const required = walletReserve + coin.gasReserve;
    return coin.amount > required ? coin.amount - required : 0n;
  }
  return coin.tonEquivalent;
}

type NetworkCaller = <T>(fn: () => Promise<T>, method: string) => Promise<T>;

export type PriceCoinsInput = {
  /** Coins the user wants priced against TON. */
  availableCoins: AvailableCoin[];
  /**
   * Maximum acceptable per-leg slippage for the valuation swap simulation.
   * Does NOT filter non-viable coins — only parameterises
   * `discoverRoute` / `simulateSwap`. Default {@link DEFAULT_SLIPPAGE}.
   */
  slippage?: string;
  /**
   * TON reserved on the wallet after all transactions finish. Subtracted
   * from TON's usable amount so {@link availableForBet} matches what the
   * bet can actually spend. Default {@link DEFAULT_WALLET_RESERVE}.
   */
  walletReserve?: bigint;
  /** STON.fi API client for swap simulation + route discovery. */
  apiClient: StonApiClient;
  /** Optional TonClient — required for jetton pricing (else jettons are non-viable). */
  tonClient?: TonClient;
  /** Throttled + retried wrapper for STON.fi API calls. */
  callStonApi: NetworkCaller;
  /**
   * Optional shared pairs cache. Strongly recommended — when multiple
   * jettons are priced in the same call, the pairs list is fetched
   * exactly once (≤ 1 per `PAIRS_CACHE_TTL_MS`) instead of N times.
   * `ToncastTxSdk.priceCoins` always passes its singleton instance.
   */
  pairsCache?: PairsCache;
};

const defaultCaller: NetworkCaller = async (fn) => fn();

/**
 * Value each coin in TON and flag which are viable bet sources.
 *
 * - TON is valued at `amount − walletReserve − TON_DIRECT_GAS`.
 *   With the default `TON_DIRECT_GAS = 0n` this collapses to
 *   `amount − walletReserve`. `viable` iff the result is strictly positive.
 * - Jetton: `discoverRoute` finds a direct or 2-hop path, then the
 *   forward simulation's `minAskUnits` is used as the pessimistic TON
 *   delivery. `gasReserve` is 0.3 TON (direct) / 0.6 TON (cross).
 *   `viable` iff `tonEquivalent > gasReserve`.
 * - If route discovery fails (no path, network error, no `tonClient`),
 *   the entry is returned with `route: null`, `viable: false`, and a
 *   human-readable `reason`.
 *
 * No throws: failures surface per-coin as `viable: false`. The function
 * deliberately takes **no** bet parameters — viability is a pure property
 * of "is swap cheaper than what it delivers?", independent of bet sizing.
 * UI layers should sum {@link availableForBet} across user-selected viable coins.
 */
export async function priceCoins(
  input: PriceCoinsInput,
): Promise<PricedCoin[]> {
  const slippage = input.slippage ?? DEFAULT_SLIPPAGE;
  const walletReserve = input.walletReserve ?? DEFAULT_WALLET_RESERVE;
  const callStonApi = input.callStonApi ?? defaultCaller;

  // Price coins in parallel — each `priceOne` is either a TON-local
  // computation or an independent STON.fi route discovery call; they do
  // not share mutable state. The shared `Throttler` inside `callStonApi`
  // enforces the STON.fi rate limit, so concurrency here only compresses
  // the total wall-clock into one throttled window instead of N serial
  // windows.
  return Promise.all(
    input.availableCoins.map((coin) =>
      priceOne({
        coin,
        slippage,
        walletReserve,
        apiClient: input.apiClient,
        ...(input.tonClient !== undefined && { tonClient: input.tonClient }),
        callStonApi,
        ...(input.pairsCache !== undefined && { pairsCache: input.pairsCache }),
      }),
    ),
  );
}

async function priceOne(args: {
  coin: AvailableCoin;
  slippage: string;
  walletReserve: bigint;
  apiClient: StonApiClient;
  tonClient?: TonClient;
  callStonApi: NetworkCaller;
  pairsCache?: PairsCache;
}): Promise<PricedCoin> {
  const { coin, slippage, walletReserve } = args;
  const meta = {
    address: coin.address,
    amount: coin.amount,
    ...(coin.symbol !== undefined && { symbol: coin.symbol }),
    ...(coin.decimals !== undefined && { decimals: coin.decimals }),
  };

  if (sameAddress(coin.address, TON_ADDRESS)) {
    const gasReserve = TON_DIRECT_GAS;
    const required = walletReserve + gasReserve;
    const usable = coin.amount > required ? coin.amount - required : 0n;
    return {
      ...meta,
      // For TON the slippage axis is degenerate (no swap involved), so
      // `tonEquivalent` and `tonEquivalentExpected` collapse to the
      // same value. We pin both to `usable` (= `amount − walletReserve
      // − gasReserve`) so that the field carries the same meaning for
      // every coin: "how many TON can this coin contribute to a bet".
      // UI sliders can read `tonEquivalent` uniformly for TON and
      // jetton sources without any per-source branching, mirroring
      // jetton's `minAskUnits` semantics. The raw on-wallet balance
      // remains accessible via `coin.amount`.
      tonEquivalent: usable,
      tonEquivalentExpected: usable,
      gasReserve,
      route: "direct",
      viable: usable > 0n,
      ...(usable === 0n
        ? {
            reason: `TON balance ${coin.amount} ≤ walletReserve + gas (${required}) — no room left to bet.`,
          }
        : {}),
    };
  }

  if (!args.tonClient) {
    return {
      ...meta,
      tonEquivalent: 0n,
      tonEquivalentExpected: 0n,
      gasReserve: 0n,
      route: null,
      viable: false,
      reason:
        "tonClient is required to price jettons — pass it to ToncastTxSdk constructor.",
    };
  }

  try {
    const route = await discoverRoute({
      apiClient: args.apiClient,
      offerAddress: coin.address,
      offerUnits: coin.amount.toString(),
      slippage,
      callStonApi: args.callStonApi,
      ...(args.pairsCache !== undefined && { pairsCache: args.pairsCache }),
    });

    // For a direct route the final TON delivery is leg1's ask; for a
    // cross-hop it's leg2's ask (intermediate → TON). `askUnits` is the
    // expected pool output (no slippage applied — this is just the raw
    // pool price); `minAskUnits` is what STON.fi computed for the
    // slippage we passed in.
    const finalLeg = route.type === "direct" ? route.leg1 : route.leg2;
    const tonEquivalentExpected = BigInt(finalLeg.askUnits || "0");
    const minAskUnitsAtUserSlippage = BigInt(finalLeg.minAskUnits || "0");
    const gasReserve =
      route.type === "direct"
        ? DIRECT_HOP_JETTON_GAS_ESTIMATE
        : CROSS_HOP_JETTON_GAS_ESTIMATE;

    // STON.fi's per-pool slippage recommendation, normalised to the
    // route-TOTAL slippage scale (= the user-facing budget on the
    // final TON delivery, not per leg). For direct = leg1's recommendation
    // unchanged; for cross-hop = the two leg recommendations COMPOSED
    // (`1 − (1 − r1)(1 − r2)`) — that's the route-total budget needed
    // to honour both per-leg recommendations after the per-leg gross-up
    // applied internally by `simulateReverseCrossToTon` / `discoverRoute`.
    // Falls back to the user-provided slippage when STON.fi does not
    // return a recommendation (some pools omit the field or return
    // "0" / empty).
    const recommendedSlippage = pickRecommendedRouteSlippage(route);
    const userSlippage = slippage;
    // Effective slippage = min(recommended, user-set max). The user
    // set their max as a hard ceiling; STON.fi can only TIGHTEN it,
    // never relax it past what the user agreed to risk.
    const effectiveSlippage = recommendedSlippage
      ? minSlippage(recommendedSlippage, userSlippage)
      : userSlippage;

    // `tonEquivalent` is the route-total floor the planner / confirmQuote
    // enforce for this coin: how much TON the full balance is GUARANTEED
    // to deliver assuming an adverse movement up to `effectiveSlippage`
    // anywhere along the route. Always computed from `expected × (1 −
    // routeTotal)`; we deliberately do NOT reuse the simulator's
    // `minAskUnits` for cross-hop because under per-leg slippage that
    // value is `ask × (1 − perLeg)` — a per-leg floor, not a route-total
    // one. For direct (legCount = 1) per-leg ≡ route-total, so the
    // simulator's `minAskUnits` is reused as a precomputed shortcut when
    // the slippage buckets match.
    // `recommendedMinAskUnits` exposed on `PricedCoin` is the floor at
    // STON.fi's recommendedSlippage, route-total. For direct we reuse
    // the simulator's value as-is (route-total ≡ per-leg). For cross we
    // compose it locally from `tonEquivalentExpected × (1 − routeTotalRec)`
    // because the simulator's per-leg `recommendedMinAskUnits` is sized
    // for the wrong slippage scale.
    const recommendedMinAskUnitsDirect = pickRecommendedMinAskUnits(route);
    const recommendedMinAskUnits =
      route.type === "direct"
        ? recommendedMinAskUnitsDirect
        : recommendedSlippage !== undefined
          ? computeFloorFromExpected(tonEquivalentExpected, recommendedSlippage)
          : undefined;
    const tonEquivalent =
      route.type === "direct"
        ? computeFloorFromExpected(
            tonEquivalentExpected,
            effectiveSlippage,
            recommendedSlippage !== undefined &&
              sameSlippage(recommendedSlippage, effectiveSlippage)
              ? recommendedMinAskUnitsDirect
              : minAskUnitsAtUserSlippage &&
                  sameSlippage(userSlippage, effectiveSlippage)
                ? minAskUnitsAtUserSlippage
                : undefined,
          )
        : computeFloorFromExpected(tonEquivalentExpected, effectiveSlippage);

    // `viable` filters dust jettons: if the swap delivers less TON than
    // it costs in wallet gas, using this coin is net-destructive. Note
    // that gas is paid from the TON wallet (not from this jetton) — the
    // comparison is just a sanity filter in TON-cost terms, not an
    // accounting deduction.
    const viable = tonEquivalent > gasReserve;

    return {
      ...meta,
      tonEquivalent,
      tonEquivalentExpected,
      gasReserve,
      route:
        route.type === "direct"
          ? "direct"
          : { intermediate: route.intermediate },
      viable,
      ...(viable
        ? {}
        : {
            reason: `swap delivers ${tonEquivalent} nano-TON but costs ${gasReserve} TON in wallet gas — net-destructive.`,
          }),
      ...(recommendedSlippage !== undefined && { recommendedSlippage }),
      ...(recommendedMinAskUnits !== undefined && { recommendedMinAskUnits }),
      effectiveSlippage,
    };
  } catch (cause) {
    return {
      ...meta,
      tonEquivalent: 0n,
      tonEquivalentExpected: 0n,
      gasReserve: 0n,
      route: null,
      viable: false,
      reason:
        cause instanceof ToncastError
          ? cause.message
          : String(cause ?? "no route to TON"),
    };
  }
}

// ─── slippage helpers ──────────────────────────────────────────────────────

/**
 * Extract STON.fi's slippage recommendation for the route, expressed
 * as a route-TOTAL slippage (= user-facing budget on the final TON
 * delivery).
 *
 * For direct routes — leg1's `recommendedSlippageTolerance` directly
 * (route-total ≡ per-leg when there is one leg).
 *
 * For cross-hop — the two per-pool recommendations composed via
 * `1 − (1 − r1)(1 − r2)`. That is the smallest route-total budget
 * which, after being split back into per-leg via
 * {@link perLegSlippage}, still satisfies both pools' independent
 * recommendations. If only one leg returns a usable value, we
 * conservatively assume the missing leg matches it (treat as r1=r2)
 * and compose — this avoids silently dropping the recommendation
 * for one leg only because the other pool omitted the field.
 *
 * Returns `undefined` if NEITHER leg has a usable value (some pools
 * omit the field or return `"0"` / empty string).
 */
function pickRecommendedRouteSlippage(route: {
  type: "direct" | "cross";
  leg1: { recommendedSlippageTolerance?: string | null };
  leg2?: { recommendedSlippageTolerance?: string | null };
}): string | undefined {
  const leg1 = parseSlippage(route.leg1.recommendedSlippageTolerance);
  if (route.type === "direct") return leg1;
  const leg2 = parseSlippage(route.leg2?.recommendedSlippageTolerance);
  if (leg1 === undefined && leg2 === undefined) return undefined;
  // Compose into route-total. Single-leg-known case: take the worse
  // (larger) leg as a stand-in for both; that's the conservative
  // direction (over-estimates required headroom slightly, never
  // under-estimates).
  const a = leg1 ?? leg2;
  const b = leg2 ?? leg1;
  if (a === undefined || b === undefined) return undefined;
  const composed = 1 - (1 - numericSlippage(a)) * (1 - numericSlippage(b));
  return Number(composed.toFixed(9)).toString();
}

/**
 * Mirror {@link pickRecommendedRouteSlippage} but for the precomputed
 * floor value. Only meaningful for direct routes — for cross-hop the
 * simulator returns `recommendedMinAskUnits` per-leg (= `ask × (1 −
 * legRec)`), which can NOT be reused as a route-total floor without
 * composition. Returning `undefined` for cross routes signals the
 * caller to recompute the floor locally as
 * `tonEquivalentExpected × (1 − routeTotalRec)` instead.
 */
function pickRecommendedMinAskUnits(route: {
  type: "direct" | "cross";
  leg1: { recommendedMinAskUnits?: string | null };
  leg2?: { recommendedMinAskUnits?: string | null };
}): bigint | undefined {
  if (route.type !== "direct") return undefined;
  const raw = route.leg1.recommendedMinAskUnits;
  if (!raw) return undefined;
  try {
    const v = BigInt(raw);
    return v > 0n ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate a slippage string and return it normalised, or `undefined`
 * when missing / non-numeric / outside `[0, 1)`. Treats `"0"` as
 * "STON.fi did not return a useful value" — a recommendation of 0
 * makes no sense in practice and would otherwise lock effective
 * slippage to zero, guaranteeing on-chain reverts on any pool drift.
 */
function parseSlippage(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return undefined;
  return raw;
}

function numericSlippage(s: string): number {
  return Number(s);
}

function minSlippage(a: string, b: string): string {
  return numericSlippage(a) <= numericSlippage(b) ? a : b;
}

/**
 * Compare two slippage strings as numbers with a tiny epsilon so
 * `"0.005"` vs `0.005000001` doesn't accidentally diverge.
 */
function sameSlippage(a: string, b: string): boolean {
  return Math.abs(numericSlippage(a) - numericSlippage(b)) < 1e-9;
}

/**
 * Compute `askUnits × (1 − slippage)` in bigint with `1e9`-scale
 * fixed-point math. Falls back to a STON.fi-supplied precomputed
 * value when it's already correct for this slippage (one less local
 * approximation, byte-identical to whatever the DEX would return).
 */
function computeFloorFromExpected(
  expected: bigint,
  slippage: string,
  precomputed?: bigint,
): bigint {
  if (precomputed !== undefined && precomputed > 0n) return precomputed;
  if (expected <= 0n) return 0n;
  const SCALE = 1_000_000_000n;
  const slip = numericSlippage(slippage);
  if (slip <= 0) return expected;
  const keep = SCALE - BigInt(Math.round(slip * Number(SCALE)));
  if (keep <= 0n) return 0n;
  return (expected * keep) / SCALE;
}
