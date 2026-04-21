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
 * counter-side liquidity, then place the remainder at the last matched
 * yesOdds (or at {@link ODDS_DEFAULT_PLACEMENT} = 50 if nothing matched).
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
  let lastYesOdds: number | null = null;

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
    lastYesOdds = yesOdds;
  }

  let placement: StrategyBreakdown["placement"];

  if (lastYesOdds === null) {
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
    // Remaining budget goes onto the last matched yesOdds. No extra
    // PARI_EXECUTION_FEE because mergeSameOdds will fold it into the
    // existing `lastYesOdds` entry — the execution fee was already paid
    // by the matched entry at this yesOdds.
    const price = ticketCost(lastYesOdds, isYes);
    if (price > 0n) {
      const extra = remainingBudget / price;
      if (extra > 0n) {
        const MAX_TICKETS = 0xffffffffn;
        // After mergeSameOdds the combined entry at `lastYesOdds` is
        // capped by uint32 on-chain. Account for tickets already queued
        // in `preMerge` at the same yesOdds so the merged count cannot
        // overflow `validateBetParams`'s INVALID_TICKETS_COUNT check.
        let alreadyAtOdds = 0n;
        for (const entry of preMerge) {
          if (entry.yesOdds === lastYesOdds) {
            alreadyAtOdds += BigInt(entry.ticketsCount);
          }
        }
        const headroom =
          alreadyAtOdds >= MAX_TICKETS ? 0n : MAX_TICKETS - alreadyAtOdds;
        const capByExtra = extra > MAX_TICKETS ? MAX_TICKETS : extra;
        const finalExtra = capByExtra > headroom ? headroom : capByExtra;
        if (finalExtra > 0n) {
          preMerge.push({
            yesOdds: lastYesOdds,
            ticketsCount: Number(finalExtra),
          });
          placement = {
            yesOdds: lastYesOdds,
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
