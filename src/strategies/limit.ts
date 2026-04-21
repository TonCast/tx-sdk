import {
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
  yesOddsToIndex,
} from "./oddsState.js";

export type LimitStrategyInput = {
  oddsState: OddsState;
  isYes: boolean;
  worstYesOdds: number;
  ticketsCount: number;
};

export type StrategyResult = {
  bets: BetItem[];
  breakdown: StrategyBreakdown;
  totalCost: bigint;
};

/**
 * Limit mode — greedily match existing counter-side liquidity from the best
 * coefficient (lowest yesOdds for a YES user) up to `worstYesOdds`, then
 * place any unmatched remainder as a fresh bet at `worstYesOdds`.
 *
 * Entries sharing a yesOdds are merged before returning.
 */
export function computeLimitBets(input: LimitStrategyInput): StrategyResult {
  const { oddsState, isYes, worstYesOdds, ticketsCount } = input;

  validateOddsState(oddsState);
  // Throws if worstYesOdds is not an even integer in the valid range.
  yesOddsToIndex(worstYesOdds);

  if (
    !Number.isInteger(ticketsCount) ||
    ticketsCount <= 0 ||
    ticketsCount > 0xffffffff
  ) {
    throw new ToncastBetError(
      "INVALID_TICKETS_COUNT",
      `ticketsCount must be a positive uint32, got ${ticketsCount}`,
    );
  }

  const matched: StrategyBreakdown["matched"] = [];
  const preMerge: BetItem[] = [];
  let remaining = ticketsCount;

  // Walk yesOdds in "best → worst" order for the user's side:
  //   YES user: smallest yesOdds is cheapest → iterate ASC from ODDS_MIN
  //             up to `worstYesOdds` (the user's acceptable upper bound).
  //   NO user:  largest yesOdds is cheapest for the NO side → iterate DESC
  //             from ODDS_MAX down to `worstYesOdds` (the user's acceptable
  //             lower bound). Iterating in the wrong direction would
  //             consume the worst coefficients first and leave the best
  //             liquidity unmatched.
  // The `availableTickets` helper already mirrors the array lookup for NO
  // (reads `oddsState.Yes`), so the direction change here is purely about
  // pricing order, not data access.
  const step = isYes ? ODDS_STEP : -ODDS_STEP;
  const startOdds = isYes ? ODDS_MIN : ODDS_MAX;
  const inRange = (o: number) =>
    isYes ? o <= worstYesOdds : o >= worstYesOdds;

  for (let yesOdds = startOdds; inRange(yesOdds); yesOdds += step) {
    if (remaining === 0) break;

    const available = availableTickets(oddsState, isYes, yesOdds);
    if (available <= 0) continue;

    const take = Math.min(available, remaining);
    preMerge.push({ yesOdds, ticketsCount: take });
    matched.push({
      yesOdds,
      tickets: take,
      cost: PARI_EXECUTION_FEE + ticketCost(yesOdds, isYes) * BigInt(take),
    });
    remaining -= take;
  }

  let unmatched: StrategyBreakdown["unmatched"];
  if (remaining > 0) {
    preMerge.push({ yesOdds: worstYesOdds, ticketsCount: remaining });
    unmatched = {
      yesOdds: worstYesOdds,
      tickets: remaining,
      cost:
        PARI_EXECUTION_FEE +
        ticketCost(worstYesOdds, isYes) * BigInt(remaining),
    };
  }

  const bets = mergeSameOdds(preMerge);
  const { totalCost } = calcBetCost(bets, isYes);

  return {
    bets,
    totalCost,
    breakdown: unmatched ? { matched, unmatched } : { matched },
  };
}
