import type { StonApiClient } from "@ston-fi/api";
import type { Client as TonClient } from "@ston-fi/sdk";
import { buildJettonBetTx } from "./builders/jetton.js";
import { buildTonBetTx } from "./builders/ton.js";
import {
  CROSS_HOP_JETTON_GAS_ESTIMATE,
  DEFAULT_SLIPPAGE,
  DEX_CUSTOM_PAYLOAD_FORWARD_GAS,
  DIRECT_HOP_JETTON_GAS_ESTIMATE,
  TON_ADDRESS,
  TON_DIRECT_GAS,
} from "./constants.js";
import { ToncastError, ToncastNetworkError } from "./errors.js";
import type { RatesClient } from "./rates.js";
import type { DiscoveredRoute, SwapSimulation } from "./routing/discover.js";
import type {
  BetItem,
  BetOption,
  BetOptionSource,
  LockedInRate,
  PricedCoin,
  TxParams,
} from "./types.js";
import { sameAddress } from "./utils/address.js";

type NetworkCaller = <T>(fn: () => Promise<T>, method: string) => Promise<T>;

export type PlanBetOptionInput = {
  /** `bets[]` produced by a strategy. */
  bets: BetItem[];
  /** Sum of per-entry costs; precomputed from `calcBetCost(bets, isYes)`. */
  totalCost: bigint;
  /** Target Pari market contract. */
  pariAddress: string;
  /** Address that will own the placed tickets on-chain. */
  beneficiary: string;
  /** Signing wallet address (defaults to `beneficiary`). */
  senderAddress?: string;
  /** `true` → YES side, `false` → NO side. */
  isYes: boolean;
  /** Optional referral address. */
  referral: string | null;
  /** Referral share, 0..7 (percent). */
  referralPct: number;
  /** Coin chosen by the user to fund the bet. MUST be present in `pricedCoins`. */
  source: string;
  /** Priced coin list (from `sdk.priceCoins`). */
  pricedCoins: PricedCoin[];
  /** Max acceptable swap slippage (default `"0.05"`). */
  slippage?: string;
  /** TON to keep in the wallet (default from SDK). */
  walletReserve: bigint;
  /** TON gas added on top of `value` for TON-direct transactions. */
  tonDirectGas?: bigint;
  /** TON buffer delivered alongside jetton-swap payload on the proxy. */
  customPayloadForwardGas?: bigint;
  /** Shared rates client (cached simulate / simulateReverseSwap). */
  rates: RatesClient;
  /** STON.fi API client — needed for jetton transaction building. */
  apiClient: StonApiClient;
  /** Optional TonClient — required for jetton source. */
  tonClient?: TonClient;
  /** Network caller wrapper (throttle + retry) for `@ston-fi/api`. */
  callStonApi: NetworkCaller;
  /** Network caller wrapper for `@ston-fi/sdk` (TonClient). */
  callTonClient: NetworkCaller;
};

export type PlanBetOptionResult = {
  option: BetOption;
  lockedInRate: LockedInRate | null;
};

/**
 * Build a funding plan for the chosen `source` coin.
 *
 * Unlike the previous planner, this one does NOT try every coin and pick the
 * cheapest — the caller is expected to have already shown `priceCoins()`
 * results to the user and received an explicit choice. That keeps the
 * transaction flow predictable (one source → one transaction) and the gas
 * cost visible to the user before signing.
 *
 * Returns an `option` describing the plan (feasible or not) and, for jetton
 * sources, a `lockedInRate` snapshot used by `confirmQuote` to detect
 * price drift before the user signs.
 */
export async function planBetOption(
  input: PlanBetOptionInput,
): Promise<PlanBetOptionResult> {
  const slippage = input.slippage ?? DEFAULT_SLIPPAGE;
  const tonDirectGas = input.tonDirectGas ?? TON_DIRECT_GAS;
  const customPayloadForwardGas =
    input.customPayloadForwardGas ?? DEX_CUSTOM_PAYLOAD_FORWARD_GAS;

  const picked = input.pricedCoins.find((c) =>
    sameAddress(c.address, input.source),
  );
  if (!picked) {
    return {
      option: {
        feasible: false,
        source: sourceLabel(input.source),
        reason: "source_not_in_priced_coins",
        warnings: [
          `source ${input.source} is not present in pricedCoins — call sdk.priceCoins first and pass its output.`,
        ],
      },
      lockedInRate: null,
    };
  }

  if (!picked.viable) {
    return {
      option: {
        feasible: false,
        source: sourceLabelFromPriced(picked),
        reason: "source_not_viable",
        ...(picked.reason !== undefined ? { warnings: [picked.reason] } : {}),
      },
      lockedInRate: null,
    };
  }

  const tonCoin = input.pricedCoins.find((c) =>
    sameAddress(c.address, TON_ADDRESS),
  );
  const tonOnWallet = tonCoin?.amount ?? 0n;

  if (sameAddress(picked.address, TON_ADDRESS)) {
    return planTonOption({
      picked,
      input,
      tonDirectGas,
    });
  }

  return planJettonOption({
    picked,
    input,
    slippage,
    customPayloadForwardGas,
    tonOnWallet,
  });
}

// ─── TON funding ───────────────────────────────────────────────────────────

function planTonOption(args: {
  picked: PricedCoin;
  input: PlanBetOptionInput;
  tonDirectGas: bigint;
}): PlanBetOptionResult {
  const { picked, input, tonDirectGas } = args;
  const tonNeeded = input.totalCost + tonDirectGas;
  const source: BetOptionSource = "TON";

  if (picked.amount < tonNeeded + input.walletReserve) {
    return {
      option: {
        feasible: false,
        source,
        reason: "insufficient_balance",
        shortfall: tonNeeded + input.walletReserve - picked.amount,
      },
      lockedInRate: null,
    };
  }

  const tx = buildTonBetTx({
    pariAddress: input.pariAddress,
    beneficiary: input.beneficiary,
    isYes: input.isYes,
    bets: input.bets,
    referral: input.referral,
    referralPct: input.referralPct,
    tonDirectGas,
  });

  return {
    option: {
      feasible: true,
      source,
      txs: [tx],
      breakdown: { spend: tonNeeded, gas: tonDirectGas },
    },
    lockedInRate: null,
  };
}

// ─── Jetton funding ────────────────────────────────────────────────────────

async function planJettonOption(args: {
  picked: PricedCoin;
  input: PlanBetOptionInput;
  slippage: string;
  customPayloadForwardGas: bigint;
  tonOnWallet: bigint;
}): Promise<PlanBetOptionResult> {
  const { picked, input, slippage, customPayloadForwardGas, tonOnWallet } =
    args;
  const source = sourceLabelFromPriced(picked);

  if (!input.tonClient) {
    return {
      option: {
        feasible: false,
        source,
        reason: "ton_client_required",
        warnings: [
          "pass tonClient to ToncastTxSdk constructor to enable jetton funding.",
        ],
      },
      lockedInRate: null,
    };
  }

  // `picked.route` is guaranteed non-null here (`viable` implies a route).
  const routeShape = picked.route;
  if (routeShape === null) {
    return {
      option: {
        feasible: false,
        source,
        reason: "no_route",
        warnings: [
          "priced coin marked viable but has no route — stale pricedCoins?",
        ],
      },
      lockedInRate: null,
    };
  }

  const isDirect = routeShape === "direct";
  const gasEstimate = isDirect
    ? DIRECT_HOP_JETTON_GAS_ESTIMATE
    : CROSS_HOP_JETTON_GAS_ESTIMATE;

  if (tonOnWallet < gasEstimate + input.walletReserve) {
    return {
      option: {
        feasible: false,
        source,
        reason: "insufficient_ton_for_gas",
        shortfall: gasEstimate + input.walletReserve - tonOnWallet,
      },
      lockedInRate: null,
    };
  }

  // Quick capacity check against the jetton's net TON — if even its
  // slippage-adjusted delivery can't cover totalCost, fail early with a
  // useful shortfall number (no need to burn a reverse-quote API call).
  if (picked.netTon < input.totalCost) {
    return {
      option: {
        feasible: false,
        source,
        reason: "insufficient_balance",
        shortfall: input.totalCost - picked.netTon,
      },
      lockedInRate: null,
    };
  }

  // Reverse-quote sized to the bet's exact totalCost.
  let reverseRoute: DiscoveredRoute;
  let leg1: SwapSimulation;
  let leg2: SwapSimulation | undefined;
  try {
    if (isDirect) {
      const rev = await input.rates.simulateReverseToTon({
        offerAddress: picked.address,
        targetTonUnits: input.totalCost,
        slippage,
      });
      leg1 = rev;
      reverseRoute = { type: "direct", leg1: rev };
    } else {
      const intermediate = routeShape.intermediate;
      const chained = await input.rates.simulateReverseCrossToTon({
        offerAddress: picked.address,
        intermediate,
        targetTonUnits: input.totalCost,
        slippage,
      });
      leg1 = chained.leg1;
      leg2 = chained.leg2;
      reverseRoute = {
        type: "cross",
        intermediate,
        leg1: chained.leg1,
        leg2: chained.leg2,
      };
    }
  } catch (cause) {
    return {
      option: {
        feasible: false,
        source,
        reason:
          cause instanceof ToncastNetworkError ? "network_error" : "no_route",
        warnings: [
          cause instanceof ToncastError ? cause.message : String(cause),
        ],
      },
      lockedInRate: null,
    };
  }

  const combinedImpact =
    Number(leg1.priceImpact) + (leg2 ? Number(leg2.priceImpact) : 0);
  const slippageLimit = Number(slippage);
  if (combinedImpact > slippageLimit) {
    return {
      option: {
        feasible: false,
        source,
        reason: "slippage_exceeds_limit",
        warnings: [
          `actual ${(combinedImpact * 100).toFixed(2)}% vs limit ${(
            slippageLimit * 100
          ).toFixed(2)}%${!isDirect ? " (2-hop route)" : ""}`,
        ],
      },
      lockedInRate: null,
    };
  }

  // Note: we deliberately DO NOT re-check `minAskUnits >= totalCost` here.
  // `rates.ts::simulateReverse*` sizes the reverse-swap ask through
  // `grossUpForSlippage(totalCost, slippage)`, which guarantees the
  // returned `minAskUnits` is ≥ `totalCost` under STON.fi's standard
  // `minAskUnits = askUnits × (1 − slippage)` formula. Relying on that
  // invariant keeps the planner lean; if STON.fi ever changes the
  // formula, the fix belongs in `rates.ts`, not here.

  const offerUnits = BigInt(leg1.offerUnits);
  if (picked.amount < offerUnits) {
    return {
      option: {
        feasible: false,
        source,
        reason: "insufficient_balance",
        shortfall: offerUnits - picked.amount,
      },
      lockedInRate: null,
    };
  }

  try {
    const tx = await buildJettonBetTx({
      tonClient: input.tonClient,
      apiClient: input.apiClient,
      offerAddress: picked.address,
      offerUnits: offerUnits.toString(),
      pariAddress: input.pariAddress,
      beneficiary: input.beneficiary,
      ...(input.senderAddress !== undefined && {
        senderAddress: input.senderAddress,
      }),
      isYes: input.isYes,
      bets: input.bets,
      referral: input.referral,
      referralPct: input.referralPct,
      slippage,
      customPayloadForwardGas,
      route: reverseRoute,
      callStonApi: input.callStonApi,
      callTonClient: input.callTonClient,
    });

    const warnings: string[] = [];
    if (combinedImpact > slippageLimit * 0.8) {
      warnings.push(
        `high slippage ${(combinedImpact * 100).toFixed(2)}% (limit ${(
          slippageLimit * 100
        ).toFixed(2)}%)${!isDirect ? " across 2 hops" : ""}`,
      );
    }

    return {
      option: {
        feasible: true,
        source,
        txs: [tx],
        breakdown: { spend: offerUnits, gas: gasEstimate },
        slippage,
        route: isDirect ? "direct" : { intermediate: routeShape.intermediate },
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      lockedInRate: {
        source: picked.address,
        route: reverseRoute,
        offerUnits,
        priceImpact: combinedImpact,
        slippage,
        targetTonUnits: input.totalCost,
      },
    };
  } catch (cause) {
    return {
      option: {
        feasible: false,
        source,
        reason:
          cause instanceof ToncastNetworkError ? "network_error" : "no_route",
        warnings: [
          cause instanceof ToncastError ? cause.message : String(cause),
        ],
      },
      lockedInRate: null,
    };
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function sourceLabel(address: string): BetOptionSource {
  return sameAddress(address, TON_ADDRESS) ? "TON" : { address };
}

function sourceLabelFromPriced(coin: PricedCoin): BetOptionSource {
  if (sameAddress(coin.address, TON_ADDRESS)) return "TON";
  return {
    address: coin.address,
    ...(coin.symbol !== undefined && { symbol: coin.symbol }),
    ...(coin.decimals !== undefined && { decimals: coin.decimals }),
  };
}

// Re-export the tx type locally so tests / consumers that used to import
// it from the planner continue to compile without reaching into builders.
export type { TxParams };
