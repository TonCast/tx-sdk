import { StonApiClient } from "@ston-fi/api";
import type { Client as TonClient } from "@ston-fi/sdk";
import { buildJettonBetTx } from "./builders/jetton.js";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RATE_CACHE_TTL_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_SLIPPAGE,
  DEFAULT_STON_API_MIN_INTERVAL_MS,
  DEFAULT_TON_CLIENT_MIN_INTERVAL_MS,
  DEFAULT_WALLET_RESERVE,
  DEX_CUSTOM_PAYLOAD_FORWARD_GAS,
  PAIRS_CACHE_TTL_MS,
  TON_ADDRESS,
  TON_DIRECT_GAS,
} from "./constants.js";
import { ToncastBetError, ToncastNetworkError } from "./errors.js";
import { planBetOption } from "./planner.js";
import { priceCoins as priceCoinsImpl } from "./pricing.js";
import { createRatesClient, type RatesClient } from "./rates.js";
import { PairsCache } from "./routing/pairsCache.js";
import { computeFixedBets } from "./strategies/fixed.js";
import { computeLimitBets } from "./strategies/limit.js";
import { computeMarketBets } from "./strategies/market.js";
import type {
  AvailableCoin,
  BetOption,
  BetQuote,
  FixedBetParams,
  LimitBetParams,
  LockedInRate,
  MarketBetParams,
  PricedCoin,
  StrategyBreakdown,
} from "./types.js";
import { sameAddress } from "./utils/address.js";
import { withRetry } from "./utils/retry.js";
import { Throttler } from "./utils/throttle.js";
import { validateBetParams } from "./validate.js";

export type ToncastTxSdkOptions = {
  /** Optional TonClient from `@ston-fi/sdk`. Required for jetton flows. */
  tonClient?: TonClient;
  /** Optional override of the internal `StonApiClient`. Intended for tests. */
  apiClient?: StonApiClient;
  /**
   * TTL for the swap-simulation cache. Defaults to
   * {@link DEFAULT_RATE_CACHE_TTL_MS} (5 minutes). A long value is safe
   * because `confirmQuote` re-simulates fresh before signing.
   */
  rateCacheTtlMs?: number;
  /**
   * TTL for the `/v1/markets` pairs list cache (used by `discoverRoute`
   * to avoid refetching ~40K pairs per coin). Defaults to
   * {@link PAIRS_CACHE_TTL_MS} (5 minutes).
   */
  pairsCacheTtlMs?: number;
  /** Override the jetton-swap forward buffer (default 0.1 TON). */
  customPayloadForwardGas?: bigint;
  /** Retries for transient network failures (default 1). */
  maxRetries?: number;
  /** Base delay between retries (linear backoff). Default 1000 ms. */
  retryDelayMs?: number;
  /** Per-client throttle config (defaults tuned for free tier). */
  rateLimits?: {
    tonClient?: { minIntervalMs?: number };
    stonApi?: { minIntervalMs?: number };
  };
};

/**
 * High-level entry point for `@toncast/tx-sdk`.
 *
 * Typical flow:
 *
 * 1. `sdk.priceCoins({ availableCoins })` — UI shows per-coin TON
 *    equivalents so the user can pick which coin to bet with.
 * 2. `sdk.quoteXxxBet({ source, pricedCoins, ... })` — builds a single
 *    transaction funded by the chosen source.
 * 3. `sdk.confirmQuote(quote)` — re-simulates the swap just before the
 *    user signs, rebuilds the tx at the current rate, and throws
 *    `SLIPPAGE_DRIFTED` if the price has moved beyond `slippage`.
 */
export class ToncastTxSdk {
  private readonly tonClient?: TonClient;
  private readonly apiClient: StonApiClient;
  private readonly rates: RatesClient;
  private readonly pairsCache: PairsCache;
  private readonly tonThrottler: Throttler;
  private readonly stonApiThrottler: Throttler;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly customPayloadForwardGas: bigint;

  constructor(options: ToncastTxSdkOptions = {}) {
    if (options.tonClient) this.tonClient = options.tonClient;
    this.apiClient = options.apiClient ?? new StonApiClient();

    this.tonThrottler = new Throttler(
      options.rateLimits?.tonClient?.minIntervalMs ??
        DEFAULT_TON_CLIENT_MIN_INTERVAL_MS,
    );
    this.stonApiThrottler = new Throttler(
      options.rateLimits?.stonApi?.minIntervalMs ??
        DEFAULT_STON_API_MIN_INTERVAL_MS,
    );

    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.customPayloadForwardGas =
      options.customPayloadForwardGas ?? DEX_CUSTOM_PAYLOAD_FORWARD_GAS;

    this.rates = createRatesClient({
      apiClient: this.apiClient,
      callStonApi: this.callStonApi.bind(this),
      rateCacheTtlMs: options.rateCacheTtlMs ?? DEFAULT_RATE_CACHE_TTL_MS,
    });

    this.pairsCache = new PairsCache(
      this.apiClient,
      this.callStonApi.bind(this),
      options.pairsCacheTtlMs ?? PAIRS_CACHE_TTL_MS,
    );
  }

  /** @internal */
  public callStonApi<T>(fn: () => Promise<T>, method: string): Promise<T> {
    return this.stonApiThrottler
      .run(() =>
        withRetry(fn, {
          maxRetries: this.maxRetries,
          delayMs: this.retryDelayMs,
        }),
      )
      .catch((cause) => {
        if (cause instanceof ToncastNetworkError) throw cause;
        throw new ToncastNetworkError("stonApi", method, cause);
      });
  }

  /** @internal */
  public callTonClient<T>(fn: () => Promise<T>, method: string): Promise<T> {
    return this.tonThrottler
      .run(() =>
        withRetry(fn, {
          maxRetries: this.maxRetries,
          delayMs: this.retryDelayMs,
        }),
      )
      .catch((cause) => {
        if (cause instanceof ToncastNetworkError) throw cause;
        throw new ToncastNetworkError("tonClient", method, cause);
      });
  }

  /**
   * Value each coin in TON and flag which are viable as funding sources.
   * See `src/pricing.ts` for the per-coin rules — TON is always priced
   * (never filtered), jettons are filtered when their swap cost (gas)
   * exceeds what they deliver.
   */
  async priceCoins(params: {
    availableCoins: AvailableCoin[];
    slippage?: string;
    walletReserve?: bigint;
  }): Promise<PricedCoin[]> {
    return priceCoinsImpl({
      availableCoins: params.availableCoins,
      ...(params.slippage !== undefined && { slippage: params.slippage }),
      ...(params.walletReserve !== undefined && {
        walletReserve: params.walletReserve,
      }),
      apiClient: this.apiClient,
      ...(this.tonClient !== undefined && { tonClient: this.tonClient }),
      callStonApi: this.callStonApi.bind(this),
      pairsCache: this.pairsCache,
    });
  }

  /**
   * Fixed mode — one `yesOdds` + `ticketsCount`. Ignores current liquidity.
   */
  async quoteFixedBet(params: FixedBetParams): Promise<BetQuote> {
    const { bets, totalCost, breakdown } = computeFixedBets({
      yesOdds: params.yesOdds,
      ticketsCount: params.ticketsCount,
      isYes: params.isYes,
    });
    validateBetParams({
      pariAddress: params.pariAddress,
      senderAddress: params.senderAddress,
      beneficiary: params.beneficiary,
      bets,
      referral: params.referral,
      referralPct: params.referralPct,
    });
    return this.buildQuote("fixed", { bets, totalCost, breakdown }, params);
  }

  /**
   * Limit mode — match available liquidity up to `worstYesOdds`, place
   * remainder at `worstYesOdds`.
   */
  async quoteLimitBet(params: LimitBetParams): Promise<BetQuote> {
    const { bets, totalCost, breakdown } = computeLimitBets({
      oddsState: params.oddsState,
      isYes: params.isYes,
      worstYesOdds: params.worstYesOdds,
      ticketsCount: params.ticketsCount,
    });
    validateBetParams({
      pariAddress: params.pariAddress,
      senderAddress: params.senderAddress,
      beneficiary: params.beneficiary,
      bets,
      referral: params.referral,
      referralPct: params.referralPct,
    });
    return this.buildQuote("limit", { bets, totalCost, breakdown }, params);
  }

  /**
   * Market mode — spend `maxBudgetTon` greedily on counter-side liquidity,
   * placement at the last matched yesOdds (or `ODDS_DEFAULT_PLACEMENT` if
   * nothing matched).
   */
  async quoteMarketBet(params: MarketBetParams): Promise<BetQuote> {
    const result = computeMarketBets({
      oddsState: params.oddsState,
      isYes: params.isYes,
      maxBudgetTon: params.maxBudgetTon,
    });

    if (!result.feasible) {
      const source = labelSource(params.source, params.pricedCoins);
      return {
        mode: "market",
        bets: [],
        isYes: params.isYes,
        totalCost: 0n,
        quotedAt: Date.now(),
        option: {
          feasible: false,
          source,
          reason: "budget_too_small_for_single_entry",
        },
        lockedInRate: null,
        breakdown: { matched: [] },
      };
    }

    validateBetParams({
      pariAddress: params.pariAddress,
      senderAddress: params.senderAddress,
      beneficiary: params.beneficiary,
      bets: result.bets,
      referral: params.referral,
      referralPct: params.referralPct,
    });

    return this.buildQuote(
      "market",
      {
        bets: result.bets,
        totalCost: result.totalCost,
        breakdown: result.breakdown,
      },
      params,
    );
  }

  /**
   * Re-check a jetton-funded quote just before the user signs.
   *
   * - For TON-funded quotes: returns the input unchanged (no swap, no drift).
   * - For jetton-funded quotes: clears the rate cache, runs a fresh reverse
   *   simulation, and rebuilds the transaction with up-to-date `offerUnits`.
   *   Throws {@link ToncastBetError} with code `SLIPPAGE_DRIFTED` if the
   *   fresh `priceImpact` exceeds the slippage tolerance recorded at quote
   *   time. Cost of the bet is unchanged (the target is still
   *   `quote.totalCost`); only the jetton amount the user pays may shift.
   */
  async confirmQuote(
    quote: BetQuote,
    params: {
      pariAddress: string;
      beneficiary: string;
      senderAddress?: string;
      referral: string | null;
      referralPct: number;
    },
  ): Promise<BetQuote> {
    if (!quote.option.feasible) {
      throw new ToncastBetError(
        "QUOTE_INFEASIBLE",
        `cannot confirm an infeasible quote (reason: ${quote.option.reason})`,
      );
    }
    const locked = quote.lockedInRate;
    if (!locked) {
      return quote; // TON-funded — no swap, nothing to re-check.
    }
    if (!this.tonClient) {
      throw new ToncastBetError(
        "SOURCE_NOT_VIABLE",
        "tonClient is required to confirm a jetton-funded quote",
      );
    }

    // Force a fresh round-trip — cache would defeat the point.
    this.rates.clearCache();

    const slippage = locked.slippage;
    let freshOfferUnits: bigint;
    let freshImpact: number;
    let freshRoute = locked.route;
    try {
      if (locked.route.type === "direct") {
        const rev = await this.rates.simulateReverseToTon({
          offerAddress: locked.source,
          targetTonUnits: locked.targetTonUnits,
          slippage,
        });
        freshOfferUnits = BigInt(rev.offerUnits);
        freshImpact = Number(rev.priceImpact);
        freshRoute = { type: "direct", leg1: rev };
      } else {
        const intermediate = locked.route.intermediate;
        const chained = await this.rates.simulateReverseCrossToTon({
          offerAddress: locked.source,
          intermediate,
          targetTonUnits: locked.targetTonUnits,
          slippage,
        });
        freshOfferUnits = BigInt(chained.leg1.offerUnits);
        freshImpact =
          Number(chained.leg1.priceImpact) + Number(chained.leg2.priceImpact);
        freshRoute = {
          type: "cross",
          intermediate,
          leg1: chained.leg1,
          leg2: chained.leg2,
        };
      }
    } catch (cause) {
      if (cause instanceof ToncastNetworkError) throw cause;
      throw new ToncastNetworkError(
        "stonApi",
        "confirmQuote.simulateReverse",
        cause,
      );
    }

    const slippageLimit = Number(slippage);
    if (freshImpact > slippageLimit) {
      throw new ToncastBetError(
        "SLIPPAGE_DRIFTED",
        `slippage drifted: quote ${(locked.priceImpact * 100).toFixed(
          2,
        )}% → now ${(freshImpact * 100).toFixed(2)}% (limit ${(
          slippageLimit * 100
        ).toFixed(2)}%)`,
      );
    }

    // Note: no explicit `minAskUnits >= totalCost` check here. The fresh
    // reverse simulation runs through `rates.ts::simulateReverse*`, which
    // grosses up the ask via `grossUpForSlippage` — so the returned
    // `minAskUnits` is ≥ `totalCost` by construction. Keep the invariant
    // in one place (rates.ts) rather than duplicating the guard.

    // Rebuild the tx with fresh `offerUnits`. Cost on the Pari side is
    // unchanged (still `quote.totalCost`); only the jetton amount the user
    // sends may have shifted.
    const freshTx = await buildJettonBetTx({
      tonClient: this.tonClient,
      apiClient: this.apiClient,
      offerAddress: locked.source,
      offerUnits: freshOfferUnits.toString(),
      pariAddress: params.pariAddress,
      beneficiary: params.beneficiary,
      ...(params.senderAddress !== undefined && {
        senderAddress: params.senderAddress,
      }),
      isYes: quote.isYes,
      bets: quote.bets,
      referral: params.referral,
      referralPct: params.referralPct,
      slippage,
      customPayloadForwardGas: this.customPayloadForwardGas,
      route: freshRoute,
      callStonApi: this.callStonApi.bind(this),
      callTonClient: this.callTonClient.bind(this),
    });

    const oldOption = quote.option;
    const freshOption: BetOption = {
      ...oldOption,
      // Confirmed: tx is built, estimate flipped off.
      estimated: false,
      txs: [freshTx],
      breakdown: {
        ...oldOption.breakdown,
        spend: freshOfferUnits,
      },
    };

    return {
      ...quote,
      quotedAt: Date.now(),
      option: freshOption,
      lockedInRate: {
        ...locked,
        route: freshRoute,
        offerUnits: freshOfferUnits,
        priceImpact: freshImpact,
      },
    };
  }

  private async buildQuote(
    mode: BetQuote["mode"],
    strategy: {
      bets: BetQuote["bets"];
      totalCost: bigint;
      breakdown: StrategyBreakdown;
    },
    params: Pick<
      FixedBetParams,
      | "pariAddress"
      | "beneficiary"
      | "senderAddress"
      | "isYes"
      | "referral"
      | "referralPct"
      | "source"
      | "pricedCoins"
      | "slippage"
      | "walletReserve"
    >,
  ): Promise<BetQuote> {
    const walletReserve = params.walletReserve ?? DEFAULT_WALLET_RESERVE;
    const slippage = params.slippage ?? DEFAULT_SLIPPAGE;

    const { option, lockedInRate } = await planBetOption({
      bets: strategy.bets,
      totalCost: strategy.totalCost,
      pariAddress: params.pariAddress,
      beneficiary: params.beneficiary,
      ...(params.senderAddress !== undefined && {
        senderAddress: params.senderAddress,
      }),
      isYes: params.isYes,
      referral: params.referral,
      referralPct: params.referralPct,
      source: params.source,
      pricedCoins: params.pricedCoins,
      slippage,
      walletReserve,
      tonDirectGas: TON_DIRECT_GAS,
      customPayloadForwardGas: this.customPayloadForwardGas,
      rates: this.rates,
      apiClient: this.apiClient,
      ...(this.tonClient !== undefined && { tonClient: this.tonClient }),
      callStonApi: this.callStonApi.bind(this),
      callTonClient: this.callTonClient.bind(this),
    });

    return {
      mode,
      bets: strategy.bets,
      isYes: params.isYes,
      totalCost: strategy.totalCost,
      quotedAt: Date.now(),
      option,
      lockedInRate,
      breakdown: strategy.breakdown,
    };
  }

  /**
   * Drop all cached rate and pair data (on-demand refresh).
   *
   * Use this after the user clicks a "refresh" control, or between
   * independent betting sessions if you want to force a brand-new
   * look at STON.fi's state. `confirmQuote` already clears the
   * rate cache internally, so this is only needed for manual
   * pre-`priceCoins` refresh.
   */
  clearRateCache(): void {
    this.rates.clearCache();
    this.pairsCache.clear();
  }
}

function labelSource(
  address: string,
  pricedCoins: PricedCoin[],
): BetOption["source"] {
  if (sameAddress(address, TON_ADDRESS)) return "TON";
  const found = pricedCoins.find((c) => sameAddress(c.address, address));
  if (!found) return { address };
  return {
    address,
    ...(found.symbol !== undefined && { symbol: found.symbol }),
    ...(found.decimals !== undefined && { decimals: found.decimals }),
  };
}

// Silences "unused" lint for the intentionally-narrowed LockedInRate re-export.
export type { LockedInRate };
