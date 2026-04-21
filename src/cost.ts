import { PARI_EXECUTION_FEE, WIN_AMOUNT_PER_TICKET } from "./constants.js";
import type { BetItem, CostBreakdown } from "./types.js";

/**
 * Cost per single ticket, mirroring `pari-proxy.tolk`:
 *
 * ```
 * ticketCost = WIN_AMOUNT_PER_TICKET * (isYes ? yesOdds : 100 - yesOdds) / 100
 * ```
 */
export function ticketCost(yesOdds: number, isYes: boolean): bigint {
  const k = BigInt(isYes ? yesOdds : 100 - yesOdds);
  return (WIN_AMOUNT_PER_TICKET * k) / 100n;
}

/**
 * Total TON cost of a batch of bets, mirroring `pari-proxy.tolk`:
 *
 * ```
 * totalCost = Σ (PARI_EXECUTION_FEE + ticketCost(yesOdds, isYes) * ticketsCount)
 * ```
 *
 * This is a deterministic, I/O-free computation — it does NOT include swap
 * fees, TON-direct gas, or the DEX forward buffer.
 */
export function calcBetCost(bets: BetItem[], isYes: boolean): CostBreakdown {
  let totalCost = 0n;
  const perEntry = bets.map((b) => {
    const cost =
      PARI_EXECUTION_FEE +
      ticketCost(b.yesOdds, isYes) * BigInt(b.ticketsCount);
    totalCost += cost;
    return { ...b, cost };
  });
  return { totalCost, perEntry };
}
