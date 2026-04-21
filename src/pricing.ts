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
   * from TON's usable amount so `netTon` matches what the bet can actually
   * spend. Default {@link DEFAULT_WALLET_RESERVE}.
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
 *   `viable` iff the result is strictly positive.
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
 * UI layers should sum `netTon` across user-selected viable coins.
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
    const netTon = coin.amount > required ? coin.amount - required : 0n;
    return {
      ...meta,
      // For TON, no swap is involved — min and expected collapse to the
      // same number, the raw balance.
      tonEquivalent: coin.amount,
      tonEquivalentExpected: coin.amount,
      gasReserve,
      netTon,
      route: "direct",
      viable: netTon > 0n,
      ...(netTon === 0n
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
      netTon: 0n,
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
    // cross-hop it's leg2's ask (intermediate → TON). In both cases we
    // capture BOTH the pessimistic floor (minAskUnits) and the expected
    // output (askUnits).
    const finalLeg = route.type === "direct" ? route.leg1 : route.leg2;
    const tonEquivalent = BigInt(finalLeg.minAskUnits || "0");
    const tonEquivalentExpected = BigInt(finalLeg.askUnits || "0");
    const gasReserve =
      route.type === "direct"
        ? DIRECT_HOP_JETTON_GAS_ESTIMATE
        : CROSS_HOP_JETTON_GAS_ESTIMATE;

    // `viable` filters dust jettons: if the swap delivers less TON than
    // it costs in wallet gas, using this coin is net-destructive. Note
    // that gas is paid from the TON wallet (not from this jetton) — the
    // comparison is just a sanity filter in TON-cost terms, not an
    // accounting deduction.
    const viable = tonEquivalent > gasReserve;

    // `netTon` is the jetton's gross contribution to the bet, equal to
    // the pessimistic swap output. Gas is NOT deducted here because it
    // is a separate wallet-TON charge (see `gasReserve` docstring).
    const netTon = viable ? tonEquivalent : 0n;

    return {
      ...meta,
      tonEquivalent,
      tonEquivalentExpected,
      gasReserve,
      netTon,
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
    };
  } catch (cause) {
    return {
      ...meta,
      tonEquivalent: 0n,
      tonEquivalentExpected: 0n,
      gasReserve: 0n,
      netTon: 0n,
      route: null,
      viable: false,
      reason:
        cause instanceof ToncastError
          ? cause.message
          : String(cause ?? "no route to TON"),
    };
  }
}
