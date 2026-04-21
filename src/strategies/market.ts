import {
  ODDS_DEFAULT_PLACEMENT,
  ODDS_MAX,
  ODDS_MIN,
  ODDS_STEP,
  PARI_EXECUTION_FEE,
} from "../constants.js";
import { calcBetCost, ticketCost } from "../cost.js";
import { ToncastBetError } from "../errors.js";
import type { BetItem, OddsState, StrategyBreakdown } from "../types.js";
import {
  availableTickets,
  mergeSameOdds,
  validateOddsState,
} from "./oddsState.js";

export type MarketStrategyInput = {
  oddsState: OddsState;
  isYes: boolean;
  /** Budget expressed in nano-TON (bigint). */
  maxBudgetTon: bigint;
};

export type MarketStrategySuccess = {
  feasible: true;
  bets: BetItem[];
  totalCost: bigint;
  breakdown: StrategyBreakdown;
};

export type MarketStrategyFailure = {
  feasible: false;
  reason: "budget_too_small_for_single_entry";
};

export type MarketStrategyResult =
  | MarketStrategySuccess
  | MarketStrategyFailure;

/**
 * Market mode — spend up to `maxBudgetTon` greedily on the best available
 * counter-side liquidity, then (if budget is left over AND all reachable
 * liquidity got matched) park the remainder at the FIRST matched yesOdds
 * — the cheapest per-ticket price on the user's side. Fallback to
 * {@link ODDS_DEFAULT_PLACEMENT} = 50 when nothing matched at all.
 *
 * ## Why FIRST matched, not LAST
 *
 * A NO user walks yesOdds DESC (98 → 2) because NO `ticketCost =
 * (100 − yesOdds)·WIN/100` is cheaper at higher yesOdds. The FIRST
 * successful match therefore sits at the HIGHEST matched yesOdds, which is
 * also the CHEAPEST price per NO-ticket. Symmetrically for YES, the first
 * match is at the LOWEST matched yesOdds — the cheapest YES-ticket.
 *
 * Previous behaviour parked the remainder at `lastYesOdds` which, by the
 * walk order, is the MOST EXPENSIVE price seen — it saved one 0.1 TON
 * execution fee via `mergeSameOdds` but forced the user to pay a
 * significantly worse per-ticket price. On a 1000 TON NO budget with
 * liquidity at yesOdds∈{2, 4, 40, 42} that single trade-off cost ~69% of
 * potential tickets (16 933 vs 10 021). FIRST-matched placement keeps the
 * fee saving intact (merge folds the placement into the first matched
 * entry at the same yesOdds) AND maximises tickets for the budget.
 *
 * All ticket-count arithmetic is in `bigint` because the Market mode can
 * easily generate millions of tickets on large budgets.
 */
export function computeMarketBets(
  input: MarketStrategyInput,
): MarketStrategyResult {
  const { oddsState, isYes, maxBudgetTon } = input;

  validateOddsState(oddsState);

  if (typeof maxBudgetTon !== "bigint" || maxBudgetTon < 0n) {
    throw new ToncastBetError(
      "INVALID_BUDGET",
      `maxBudgetTon must be a non-negative bigint, got ${maxBudgetTon}`,
    );
  }

  let remainingBudget = maxBudgetTon;
  const preMerge: BetItem[] = [];
  const matched: StrategyBreakdown["matched"] = [];
  // `firstYesOdds` anchors the placement to the CHEAPEST matched price
  // (see JSDoc). Only set on the first successful match and never updated
  // afterwards.
  let firstYesOdds: number | null = null;

  // Walk yesOdds in "best → worst" order for the user's side:
  //   YES user:  ticketCost = WIN * yesOdds / 100 → smallest yesOdds is
  //              cheapest (highest decimal odds), iterate ascending.
  //   NO user:   ticketCost = WIN * (100 - yesOdds) / 100 → largest yesOdds
  //              is cheapest for the NO side, iterate descending.
  // Iterating in the wrong direction would spend the budget on the worst
  // coefficients first and starve the rest, shrinking the resulting
  // ticket count by an order of magnitude.
  const step = isYes ? ODDS_STEP : -ODDS_STEP;
  const startOdds = isYes ? ODDS_MIN : ODDS_MAX;
  const endOdds = isYes ? ODDS_MAX : ODDS_MIN;
  const inRange = (o: number) => (isYes ? o <= endOdds : o >= endOdds);

  for (let yesOdds = startOdds; inRange(yesOdds); yesOdds += step) {
    if (remainingBudget <= PARI_EXECUTION_FEE) break;

    const available = availableTickets(oddsState, isYes, yesOdds);
    if (available <= 0) continue;

    const price = ticketCost(yesOdds, isYes);
    if (price <= 0n) continue;

    const byBudget = (remainingBudget - PARI_EXECUTION_FEE) / price;
    if (byBudget <= 0n) break;

    const take = byBudget < BigInt(available) ? byBudget : BigInt(available);
    if (take <= 0n) break;

    // `ticketsCount` field is uint32 on-chain; clamp per-entry.
    // Any overflow becomes the placement leg below.
    const MAX_TICKETS = 0xffffffffn;
    const actualTake = take > MAX_TICKETS ? MAX_TICKETS : take;

    preMerge.push({ yesOdds, ticketsCount: Number(actualTake) });
    const entryCost = PARI_EXECUTION_FEE + price * actualTake;
    matched.push({
      yesOdds,
      tickets: Number(actualTake),
      cost: entryCost,
    });
    remainingBudget -= entryCost;
    if (firstYesOdds === null) firstYesOdds = yesOdds;
  }

  let placement: StrategyBreakdown["placement"];

  if (firstYesOdds === null) {
    // Nothing matched → fallback placement on the neutral 50% yesOdds.
    const fallbackYesOdds = ODDS_DEFAULT_PLACEMENT;
    const fallbackPrice = ticketCost(fallbackYesOdds, isYes);
    // A new entry requires AT LEAST `PARI_EXECUTION_FEE + fallbackPrice`,
    // so equality must still be feasible — a strict `<` is the correct
    // guard here, `<=` drops the exact-threshold case as a false negative.
    if (remainingBudget < PARI_EXECUTION_FEE + fallbackPrice) {
      return { feasible: false, reason: "budget_too_small_for_single_entry" };
    }
    const maxTickets = (remainingBudget - PARI_EXECUTION_FEE) / fallbackPrice;
    // Defence in depth: `maxTickets` is guaranteed ≥ 1 by the check
    // above, so this branch is effectively unreachable. Kept as a
    // safety net in case the arithmetic invariant ever shifts.
    if (maxTickets <= 0n) {
      return { feasible: false, reason: "budget_too_small_for_single_entry" };
    }
    const MAX_TICKETS = 0xffffffffn;
    const finalTickets = maxTickets > MAX_TICKETS ? MAX_TICKETS : maxTickets;
    const cost = PARI_EXECUTION_FEE + fallbackPrice * finalTickets;
    preMerge.push({
      yesOdds: fallbackYesOdds,
      ticketsCount: Number(finalTickets),
    });
    placement = {
      yesOdds: fallbackYesOdds,
      tickets: Number(finalTickets),
      cost,
    };
  } else if (remainingBudget > 0n) {
    // Remaining budget goes onto the FIRST matched yesOdds (cheapest per
    // ticket for the user's side — see the JSDoc for the full rationale).
    // No extra PARI_EXECUTION_FEE because mergeSameOdds will fold it into
    // the existing `firstYesOdds` entry — the execution fee was already
    // paid by the matched entry at this yesOdds.
    const price = ticketCost(firstYesOdds, isYes);
    if (price > 0n) {
      const extra = remainingBudget / price;
      if (extra > 0n) {
        const MAX_TICKETS = 0xffffffffn;
        // After mergeSameOdds the combined entry at `firstYesOdds` is
        // capped by uint32 on-chain. Account for tickets already queued
        // in `preMerge` at the same yesOdds so the merged count cannot
        // overflow `validateBetParams`'s INVALID_TICKETS_COUNT check.
        let alreadyAtOdds = 0n;
        for (const entry of preMerge) {
          if (entry.yesOdds === firstYesOdds) {
            alreadyAtOdds += BigInt(entry.ticketsCount);
          }
        }
        const headroom =
          alreadyAtOdds >= MAX_TICKETS ? 0n : MAX_TICKETS - alreadyAtOdds;
        const capByExtra = extra > MAX_TICKETS ? MAX_TICKETS : extra;
        const finalExtra = capByExtra > headroom ? headroom : capByExtra;
        if (finalExtra > 0n) {
          preMerge.push({
            yesOdds: firstYesOdds,
            ticketsCount: Number(finalExtra),
          });
          placement = {
            yesOdds: firstYesOdds,
            tickets: Number(finalExtra),
            cost: price * finalExtra,
          };
        }
      }
    }
  }

  const bets = mergeSameOdds(preMerge);
  const { totalCost } = calcBetCost(bets, isYes);

  return {
    feasible: true,
    bets,
    totalCost,
    breakdown: placement ? { matched, placement } : { matched },
  };
}
