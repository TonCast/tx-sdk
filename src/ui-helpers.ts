/**
 * UI-friendly helpers built on top of a {@link BetQuote}.
 *
 * All exports here are pure functions — no I/O, no async work — so they are
 * safe to call inside React render loops or derived-state selectors.
 * They translate the SDK's on-chain-oriented shapes (per-entry `cost` with
 * embedded `PARI_EXECUTION_FEE`, `yesOdds` as percent, etc.) into the fields
 * a typical betting UI wants to render: decimal odds, probability percent,
 * stake vs fee split, expected winnings.
 */

import {
  PARI_EXECUTION_FEE,
  PLATFORM_FEE_PCT,
  WIN_AMOUNT_PER_TICKET,
} from "./constants.js";
import { ToncastBetError } from "./errors.js";
import type { BetItem, BetQuote } from "./types.js";

/**
 * Convert on-chain `yesOdds` (uint7, meaning "YES probability in percent")
 * to the probability the CURRENT bet side wins, in percent.
 *
 * Example: yesOdds=56, isYes=true → 56 (UI shows "56%").
 * Example: yesOdds=56, isYes=false → 44 (the NO side wins if actual YES
 * probability is below 50%, so at yesOdds=56 the NO side is priced at 44%).
 */
export function yesOddsToProbabilityPct(
  yesOdds: number,
  isYes: boolean,
): number {
  assertValidYesOdds(yesOdds);
  return isYes ? yesOdds : 100 - yesOdds;
}

/**
 * Convert `yesOdds` to decimal odds for the current bet side — the
 * "coefficient" a typical betting UI shows next to the ticket count.
 *
 * decimal_odds = 100 / probability_pct
 *
 * Example: yesOdds=56, isYes=true  → 100 / 56 ≈ 1.7857 (UI: "1.79")
 * Example: yesOdds=56, isYes=false → 100 / 44 ≈ 2.2727 (UI: "2.27")
 */
export function yesOddsToDecimalOdds(yesOdds: number, isYes: boolean): number {
  const probabilityPct = yesOddsToProbabilityPct(yesOdds, isYes);
  return 100 / probabilityPct;
}

/**
 * Net winnings (in nano-TON) the user would receive **if their side wins**.
 *
 * Pari gross payout per winning ticket is {@link WIN_AMOUNT_PER_TICKET}
 * (0.1 TON). The platform deducts {@link PLATFORM_FEE_PCT} from every
 * winning ticket; the referral (if any) deducts `referralPct` on top.
 *
 * Formula:
 * ```
 * netPerTicket = WIN_AMOUNT_PER_TICKET
 *              * (100 - PLATFORM_FEE_PCT - referralPct) / 100
 * net = netPerTicket * totalTickets
 * ```
 *
 * For 0% referral: user keeps `100 - 4 = 96%` of gross.
 * For 7% max referral: user keeps `100 - 4 - 7 = 89%` of gross.
 */
export function calcWinnings(bets: BetItem[], referralPct: number): bigint {
  if (
    !Number.isInteger(referralPct) ||
    referralPct < 0 ||
    referralPct + PLATFORM_FEE_PCT > 100
  ) {
    throw new ToncastBetError(
      "INVALID_REFERRAL_PCT",
      `referralPct must be a non-negative integer with referralPct + PLATFORM_FEE_PCT ≤ 100, got ${referralPct}`,
    );
  }

  let totalTickets = 0n;
  for (const b of bets) {
    totalTickets += BigInt(b.ticketsCount);
  }
  const keepPct = BigInt(100 - PLATFORM_FEE_PCT - referralPct);
  return (WIN_AMOUNT_PER_TICKET * totalTickets * keepPct) / 100n;
}

/**
 * Fields most bet UIs need: totals split into "ticket cost" (stake) vs
 * "execution fee" (flat per-entry charge).
 *
 * `matchedTicketCost` / `placementTicketCost` exclude the per-entry
 * `PARI_EXECUTION_FEE` — they answer "how much TON pays for the tickets
 * themselves" (the stake). `executionFee` covers the flat 0.1 TON per entry
 * in `bets`. `stake + executionFee === total === quote.totalCost`.
 */
export type BreakdownTotals = {
  /** Sum of matched ticket counts across all `breakdown.matched` entries. */
  matchedTickets: number;
  /** Sum of matched ticket costs, **excluding** per-entry `PARI_EXECUTION_FEE`. */
  matchedTicketCost: bigint;
  /** Placement ticket count (0 if none — Fixed mode). */
  placementTickets: number;
  /** Placement ticket cost, **excluding** per-entry `PARI_EXECUTION_FEE`. */
  placementTicketCost: bigint;
  /** `bets.length × PARI_EXECUTION_FEE`. */
  executionFee: bigint;
  /** `matchedTicketCost + placementTicketCost` — "bet principal" / "stake". */
  stake: bigint;
  /** `quote.totalCost` — mirrors the field, for convenience. */
  total: bigint;
};

/**
 * Extract UI-friendly totals from a {@link BetQuote}. Pure, does not mutate.
 */
export function breakdownTotals(quote: BetQuote): BreakdownTotals {
  const executionFee = BigInt(quote.bets.length) * PARI_EXECUTION_FEE;

  let matchedTickets = 0;
  let matchedCostWithFee = 0n;
  for (const m of quote.breakdown.matched) {
    matchedTickets += m.tickets;
    matchedCostWithFee += m.cost;
  }
  // Each matched entry's `cost` includes one PARI_EXECUTION_FEE; subtract them.
  const matchedTicketCost =
    matchedCostWithFee -
    BigInt(quote.breakdown.matched.length) * PARI_EXECUTION_FEE;

  const placementEntry =
    quote.breakdown.placement ?? quote.breakdown.unmatched ?? null;
  const placementTickets = placementEntry?.tickets ?? 0;
  const placementCostWithFee = placementEntry?.cost ?? 0n;
  // Market mode may fold a placement into an already-matched entry at
  // `lastYesOdds` (same yesOdds → merged by mergeSameOdds). In that case
  // the placement's `cost` is a raw `price * tickets` with NO embedded
  // PARI_EXECUTION_FEE (the fee was already counted in the matched entry
  // for that yesOdds). All other shapes — Limit `unmatched`, Market
  // fallback placement at ODDS_DEFAULT_PLACEMENT when nothing matched —
  // carry the fee inside `cost` and need it stripped here.
  const placementFoldedIntoMatched =
    placementEntry !== null &&
    quote.breakdown.placement !== undefined &&
    quote.breakdown.matched.some(
      (m) => m.yesOdds === quote.breakdown.placement?.yesOdds,
    );
  const placementTicketCost =
    placementEntry === null
      ? 0n
      : placementFoldedIntoMatched
        ? placementCostWithFee
        : placementCostWithFee - PARI_EXECUTION_FEE;

  return {
    matchedTickets,
    matchedTicketCost,
    placementTickets,
    placementTicketCost,
    executionFee,
    stake: matchedTicketCost + placementTicketCost,
    total: quote.totalCost,
  };
}

// ─── internals ─────────────────────────────────────────────────────────────

function assertValidYesOdds(yesOdds: number): void {
  if (
    !Number.isInteger(yesOdds) ||
    yesOdds < 2 ||
    yesOdds > 98 ||
    yesOdds % 2 !== 0
  ) {
    throw new ToncastBetError(
      "INVALID_ODDS",
      `yesOdds must be an even integer in [2, 98], got ${yesOdds}`,
    );
  }
}
