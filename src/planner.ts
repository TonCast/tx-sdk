import type { StonApiClient } from "@ston-fi/api";
import type { Client as TonClient } from "@ston-fi/sdk";
import { buildTonBetTx } from "./builders/ton.js";
import {
  CROSS_HOP_JETTON_GAS_ESTIMATE,
  DEFAULT_SLIPPAGE,
  DIRECT_HOP_JETTON_GAS_ESTIMATE,
  TON_ADDRESS,
  TON_DIRECT_GAS,
} from "./constants.js";
import { availableForBet } from "./pricing.js";
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
import { normalizeAddress, sameAddress } from "./utils/address.js";
import {
  sourceLabelForAddress,
  sourceLabelFromPriced,
} from "./utils/sourceLabel.js";

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
  /**
   * Preview-mode flag. When `true`, lets balance-short quotes through
   * as `feasible: true` + `warnings` + `shortfall` for cases where the
   * TonConnect wallet will still refuse to sign (protecting the user
   * from an on-chain gas burn). See `CommonBetParams.allowInsufficientBalance`.
   */
  allowInsufficientBalance?: boolean;
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
 * For TON-funded bets: produces a ready-to-sign transaction immediately.
 *
 * For jetton-funded bets: produces an **estimated** option — the
 * transaction is NOT built yet (`txs: []`, `estimated: true`), and
 * `offerUnits` is a linear approximation from the cached rate captured
 * by `priceCoins`. No STON.fi API call is made here. The caller MUST
 * run `sdk.confirmQuote(...)` before signing; that step runs a fresh
 * reverse simulation and returns a finalised option with `txs.length === 1`
 * and `estimated: false`. Trying to sign an estimated quote is prevented
 * by construction — there are no `txs` to sign.
 *
 * The motivation: slider-driven UIs that re-quote on every keystroke
 * previously hit STON.fi with a reverse-sim per change. With the linear
 * approximation, only `priceCoins` and `confirmQuote` touch the network.
 * The 5-minute cache + linear scaling means interactive UX sees near-zero
 * API traffic, while on-chain safety is preserved by `minAskAmount =
 * totalCost` on the DEX floor.
 */
export async function planBetOption(
  input: PlanBetOptionInput,
): Promise<PlanBetOptionResult> {
  const slippage = input.slippage ?? DEFAULT_SLIPPAGE;
  const tonDirectGas = input.tonDirectGas ?? TON_DIRECT_GAS;
  // `customPayloadForwardGas` is consumed by `confirmQuote` via the
  // SDK-level constant; we don't need it here in the planner itself.
  void input.customPayloadForwardGas;

  const picked = input.pricedCoins.find((c) =>
    sameAddress(c.address, input.source),
  );
  if (!picked) {
    return {
      option: {
        feasible: false,
        source: sourceLabelForAddress(input.source, input.pricedCoins),
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

  const shortBy =
    picked.amount < tonNeeded + input.walletReserve
      ? tonNeeded + input.walletReserve - picked.amount
      : 0n;

  if (shortBy > 0n && !input.allowInsufficientBalance) {
    return {
      option: {
        feasible: false,
        source,
        reason: "insufficient_balance",
        shortfall: shortBy,
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

  // When `allowInsufficientBalance` lets a short-balance quote through,
  // the tx is still built at full `value = totalCost + tonDirectGas`.
  // The TonConnect wallet compares `value` to the user's TON balance
  // and refuses to sign when short — so no gas is burned. The caller
  // uses `shortfall` + `warnings` to gate the "Place Bet" button.
  return {
    option: {
      feasible: true,
      source,
      estimated: false,
      txs: [tx],
      breakdown: { spend: tonNeeded, gas: tonDirectGas },
      ...(shortBy > 0n && {
        warnings: [
          `insufficient_balance: wallet is short ${shortBy} nano-TON — signing will be refused until topped up`,
        ],
        shortfall: shortBy,
      }),
    },
    lockedInRate: null,
  };
}

// ─── Jetton funding (estimated; finalised by confirmQuote) ─────────────────

function planJettonOption(args: {
  picked: PricedCoin;
  input: PlanBetOptionInput;
  slippage: string;
  tonOnWallet: bigint;
}): PlanBetOptionResult {
  const { picked, input, slippage, tonOnWallet } = args;
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

  const gasShortBy =
    tonOnWallet < gasEstimate + input.walletReserve
      ? gasEstimate + input.walletReserve - tonOnWallet
      : 0n;

  if (gasShortBy > 0n && !input.allowInsufficientBalance) {
    return {
      option: {
        feasible: false,
        source,
        reason: "insufficient_ton_for_gas",
        shortfall: gasShortBy,
      },
      lockedInRate: null,
    };
  }

  // Capacity check — if the jetton's pessimistic full-amount delivery
  // (`tonEquivalent`) can't cover `totalCost`, fail early without
  // pretending we could build a quote. For jetton sources
  // `availableForBet` is just `tonEquivalent`; factoring it through the
  // helper keeps the test symmetric with the TON-direct path.
  //
  // Note: `allowInsufficientBalance` does NOT relax this branch.
  // Missing jetton balance is invisible to the signing wallet, so a
  // short balance would let the swap reach the network and burn gas
  // when the jetton wallet bounces the transfer. Keep the hard block.
  const capacity = availableForBet(picked, input.walletReserve);
  if (capacity < input.totalCost) {
    return {
      option: {
        feasible: false,
        source,
        reason: "insufficient_balance",
        shortfall: input.totalCost - capacity,
      },
      lockedInRate: null,
    };
  }

  // Linear approximation: `priceCoins` computed that the full balance
  // `picked.amount` delivers `picked.tonEquivalent` TON (worst-case slippage
  // on the full amount). Extrapolate to `totalCost` TON:
  //
  //   offerUnits ≈ picked.amount × totalCost / picked.tonEquivalent
  //
  // This is a pessimistic estimate — smaller swaps have lower priceImpact,
  // so the real `offerUnits` computed by `confirmQuote`'s reverse-sim will
  // typically be slightly LOWER. The user doesn't lose here: the UI just
  // shows a conservative number; `confirmQuote` tightens it before signing.
  //
  // Using `picked.tonEquivalent` (which is `minAskUnits` from the full-amount
  // simulate) already bakes in the user's slippage tolerance; no extra
  // gross-up needed.
  const estimatedOfferUnits = ceilDivBig(
    picked.amount * input.totalCost,
    picked.tonEquivalent,
  );

  if (picked.amount < estimatedOfferUnits) {
    // Shouldn't happen given the `availableForBet >= totalCost` guard
    // above, but the arithmetic might drift by 1 unit due to ceiling
    // rounding — treat as a balance shortfall rather than build a
    // broken plan.
    return {
      option: {
        feasible: false,
        source,
        reason: "insufficient_balance",
        shortfall: estimatedOfferUnits - picked.amount,
      },
      lockedInRate: null,
    };
  }

  // Synthesise a placeholder `DiscoveredRoute` so `confirmQuote` knows
  // which route shape to re-simulate. Leg-level simulation fields are
  // left as dummies with `minAskUnits === totalCost`; they're never read
  // directly from here (no tx is built), and `confirmQuote` replaces
  // them wholesale with fresh simulations before building the signed tx.
  const placeholderRoute: DiscoveredRoute = isDirect
    ? {
        type: "direct",
        leg1: makePlaceholderSim({
          offerAddress: picked.address,
          askAddress: TON_ADDRESS,
          offerUnits: estimatedOfferUnits.toString(),
          askUnits: input.totalCost.toString(),
          minAskUnits: input.totalCost.toString(),
        }),
      }
    : {
        type: "cross",
        intermediate: routeShape.intermediate,
        leg1: makePlaceholderSim({
          offerAddress: picked.address,
          askAddress: routeShape.intermediate,
          offerUnits: estimatedOfferUnits.toString(),
          askUnits: "0",
          minAskUnits: "0",
        }),
        leg2: makePlaceholderSim({
          offerAddress: routeShape.intermediate,
          askAddress: TON_ADDRESS,
          offerUnits: "0",
          askUnits: input.totalCost.toString(),
          minAskUnits: input.totalCost.toString(),
        }),
      };

  return {
    option: {
      feasible: true,
      source,
      // Jetton: tx is NOT built yet. Caller must run `confirmQuote` to
      // get a signed-ready transaction. This is enforced by returning
      // an empty `txs` array — you literally cannot sign what isn't here.
      estimated: true,
      txs: [],
      breakdown: {
        spend: estimatedOfferUnits,
        gas: gasEstimate,
      },
      slippage,
      route: isDirect ? "direct" : { intermediate: routeShape.intermediate },
      // Preview mode for jetton source: TON gas reservation short but
      // the tx's `value` still carries the full gas amount, so the
      // TonConnect wallet refuses to sign the tx that `confirmQuote`
      // eventually produces. Safe to surface as a feasible preview.
      ...(gasShortBy > 0n && {
        warnings: [
          `insufficient_ton_for_gas: wallet is short ${gasShortBy} nano-TON for jetton-swap gas — signing will be refused until topped up`,
        ],
        shortfall: gasShortBy,
      }),
    },
    lockedInRate: {
      // Canonicalise once so `confirmQuote` always feeds STON.fi /
      // tonClient the same textual form regardless of how the caller
      // formatted `pricedCoins[i].address` (EQ / UQ / raw).
      source: normalizeAddress(picked.address),
      route: placeholderRoute,
      offerUnits: estimatedOfferUnits,
      // priceImpact unknown at quote time (no simulate). `confirmQuote`
      // sets the real value from its fresh sim; 0 is a conservative
      // sentinel that comparison code treats as "unknown baseline".
      priceImpact: 0,
      slippage,
      targetTonUnits: input.totalCost,
    },
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────

function ceilDivBig(a: bigint, b: bigint): bigint {
  if (b <= 0n) return 0n;
  return (a + b - 1n) / b;
}

/**
 * Minimal placeholder `SwapSimulation` — planner never reads beyond
 * the listed fields, and `confirmQuote` replaces the whole object with
 * a fresh STON.fi response before building a signed tx. The shape is
 * cast through `unknown` to avoid dragging STON.fi SDK internals into
 * the planner and to keep the cast localised.
 */
function makePlaceholderSim(args: {
  offerAddress: string;
  askAddress: string;
  offerUnits: string;
  askUnits: string;
  minAskUnits: string;
}): SwapSimulation {
  return {
    askAddress: args.askAddress,
    askJettonWallet: "",
    askUnits: args.askUnits,
    feeAddress: "",
    feePercent: "0",
    feeUnits: "0",
    minAskUnits: args.minAskUnits,
    offerAddress: args.offerAddress,
    offerJettonWallet: "",
    offerUnits: args.offerUnits,
    poolAddress: "",
    priceImpact: "0",
    routerAddress: "",
    router: {
      address: "",
      majorVersion: 2,
      minorVersion: 1,
      ptonMasterAddress: "",
      ptonVersion: "2.1",
      ptonWalletAddress: "",
      routerType: "ConstantProduct",
      poolCreationEnabled: true,
    },
    slippageTolerance: "0",
    swapRate: "0",
    recommendedSlippageTolerance: "0",
    recommendedMinAskUnits: args.minAskUnits,
    gasParams: {
      gasBudget: "300000000",
      forwardGas: "240000000",
      estimatedGasConsumption: "60000000",
    },
  } as unknown as SwapSimulation;
}

// Re-export the tx type locally so tests / consumers that used to import
// it from the planner continue to compile without reaching into builders.
export type { TxParams };
