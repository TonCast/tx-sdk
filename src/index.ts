/**
 * `@toncast/tx-sdk` — build TonConnect transactions for Toncast Pari bets.
 *
 * Three bet modes, TON-direct and jetton-via-STON.fi, one transaction per
 * bet. Typical flow:
 *
 * 1. `sdk.priceCoins({ availableCoins })` — UI shows per-coin TON value
 *    and which coins are viable sources.
 * 2. `sdk.quoteXxxBet({ source, pricedCoins, ... })` — builds the tx.
 * 3. `sdk.confirmQuote(quote, ...)` — fresh re-simulation just before
 *    the user signs; throws `SLIPPAGE_DRIFTED` if price moved too much.
 */

// ─── Re-exports (so consumers never need to import @ston-fi/sdk) ────────────
export { Client as TonClient } from "@ston-fi/sdk";
export {
  type BuildJettonBetTxParams,
  buildJettonBetTx,
} from "./builders/jetton.js";
// ─── Builders ───────────────────────────────────────────────────────────────
export { type BuildTonBetTxParams, buildTonBetTx } from "./builders/ton.js";
export { makeSwapCacheKey, TtlCache } from "./cache.js";
// ─── Constants & schema ─────────────────────────────────────────────────────
export * from "./constants.js";
// ─── Core pure functions (no I/O) ──────────────────────────────────────────
export { calcBetCost, ticketCost } from "./cost.js";
// ─── Errors ─────────────────────────────────────────────────────────────────
export {
  type BetErrorCode,
  ToncastBetError,
  ToncastError,
  ToncastNetworkError,
} from "./errors.js";
export {
  buildBatchPlaceBetsForWithRefCell,
  buildProxyForwardCell,
} from "./payload.js";
// ─── Planner ────────────────────────────────────────────────────────────────
export {
  type PlanBetOptionInput,
  type PlanBetOptionResult,
  planBetOption,
} from "./planner.js";
// ─── Pricing ────────────────────────────────────────────────────────────────
export { type PriceCoinsInput, priceCoins } from "./pricing.js";
// ─── Rates & cache ──────────────────────────────────────────────────────────
export {
  type CreateRatesClientOptions,
  createRatesClient,
  type RatesClient,
} from "./rates.js";
export {
  type DiscoveredRoute,
  type DiscoverRouteInput,
  discoverRoute,
  type SwapSimulation,
} from "./routing/discover.js";
// ─── High-level SDK ─────────────────────────────────────────────────────────
export { ToncastTxSdk, type ToncastTxSdkOptions } from "./sdk.js";
// ─── Strategies (pure) ──────────────────────────────────────────────────────
export { computeFixedBets } from "./strategies/fixed.js";
export { computeLimitBets } from "./strategies/limit.js";
export {
  computeMarketBets,
  type MarketStrategyFailure,
  type MarketStrategyResult,
  type MarketStrategySuccess,
} from "./strategies/market.js";
export {
  availableTickets,
  indexToYesOdds,
  mergeSameOdds,
  validateOddsState,
  yesOddsToIndex,
} from "./strategies/oddsState.js";
export {
  type SubscribeOptions,
  type Subscription,
  subscribeFixedBet,
  subscribeLimitBet,
  subscribeMarketBet,
} from "./subscribe.js";
// ─── Types ──────────────────────────────────────────────────────────────────
export type {
  AvailableCoin,
  BetItem,
  BetOption,
  BetOptionFailureReason,
  BetOptionSource,
  BetQuote,
  CommonBetParams,
  CostBreakdown,
  CostBreakdownEntry,
  FixedBetParams,
  LimitBetParams,
  LockedInRate,
  MarketBetParams,
  OddsState,
  PricedCoin,
  StrategyBreakdown,
  TxParams,
} from "./types.js";
// ─── UI helpers (pure) ──────────────────────────────────────────────────────
export {
  type BreakdownTotals,
  breakdownTotals,
  calcWinnings,
  yesOddsToDecimalOdds,
  yesOddsToProbabilityPct,
} from "./ui-helpers.js";
// ─── Utils (retry, throttle, sleep) ─────────────────────────────────────────
export { type RetryOptions, withRetry } from "./utils/retry.js";
export { sleep } from "./utils/sleep.js";
export { Throttler } from "./utils/throttle.js";
export { validateBetParams } from "./validate.js";
