import { calcBetCost } from "../cost.js";
import { ToncastBetError } from "../errors.js";
import type { BetItem, StrategyBreakdown } from "../types.js";
import { yesOddsToIndex } from "./oddsState.js";

export type FixedStrategyInput = {
  yesOdds: number;
  ticketsCount: number;
  isYes: boolean;
};

export type StrategyResult = {
  bets: BetItem[];
  breakdown: StrategyBreakdown;
  totalCost: bigint;
};

/**
 * Fixed mode — places `ticketsCount` tickets at a single `yesOdds`. The strategy
 * ignores current liquidity; on-chain matching is performed by the Pari contract.
 */
export function computeFixedBets(input: FixedStrategyInput): StrategyResult {
  // Throws on invalid yesOdds (non-even / out of range).
  yesOddsToIndex(input.yesOdds);

  if (
    !Number.isInteger(input.ticketsCount) ||
    input.ticketsCount <= 0 ||
    input.ticketsCount > 0xffffffff
  ) {
    throw new ToncastBetError(
      "INVALID_TICKETS_COUNT",
      `ticketsCount must be a positive uint32, got ${input.ticketsCount}`,
    );
  }

  const bets: BetItem[] = [
    { yesOdds: input.yesOdds, ticketsCount: input.ticketsCount },
  ];

  const { totalCost, perEntry } = calcBetCost(bets, input.isYes);
  const entry = perEntry[0];
  if (!entry) {
    // Unreachable (bets is non-empty by construction), appeases TS.
    throw new ToncastBetError("EMPTY_BETS", "no entries produced");
  }

  return {
    bets,
    totalCost,
    breakdown: {
      matched: [
        {
          yesOdds: input.yesOdds,
          tickets: input.ticketsCount,
          cost: entry.cost,
        },
      ],
    },
  };
}
