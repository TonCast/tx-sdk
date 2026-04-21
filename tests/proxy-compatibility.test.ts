import { describe, expect, it } from "vitest";
import {
  CONTRACT_RESERVE,
  DEX_CUSTOM_PAYLOAD_FORWARD_GAS,
} from "../src/constants.js";

/**
 * Invariants the SDK must uphold w.r.t. the deployed
 * `toncast_swap_proxy.tolk` contract. These are numeric, not cell-level
 * tests — they catch regressions in the reasoning behind our `minAskAmount`
 * + `DEX_CUSTOM_PAYLOAD_FORWARD_GAS` choices.
 *
 * On-chain the proxy checks:
 *
 *   if (msgValue >= totalCost + CONTRACT_RESERVE) → forward to Pari
 *   else                                          → refund
 *
 * where `msgValue = ton_amount_delivered_by_swap + DEX_CUSTOM_PAYLOAD_FORWARD_GAS`.
 *
 * In the WORST case, `ton_amount_delivered_by_swap = minAskAmount` (the DEX
 * floor). So we need: `minAskAmount + DEX_CUSTOM_PAYLOAD_FORWARD_GAS >=
 * totalCost + CONTRACT_RESERVE`.
 *
 * Historical bug: when `minAskAmount = totalCost × (1 − slippage)`, the left
 * side was short by `totalCost × slippage − DEX_CUSTOM_PAYLOAD_FORWARD_GAS +
 * CONTRACT_RESERVE`. For bets ≥ ~2 TON this went negative and the proxy
 * would silently refund. Fix: `minAskAmount = totalCost`.
 */

function worstCaseMsgValue(minAskAmount: bigint): bigint {
  return minAskAmount + DEX_CUSTOM_PAYLOAD_FORWARD_GAS;
}

function proxyAccepts(msgValue: bigint, totalCost: bigint): boolean {
  return msgValue >= totalCost + CONTRACT_RESERVE;
}

describe("proxy dead-zone regression (minAskAmount = totalCost)", () => {
  // Bets of varying magnitude; the invariant must hold for ALL of them.
  const totalCosts = [
    150_000_000n, // 0.15 TON  (1 ticket)
    350_000_000n, // 0.35 TON  (5 tickets)
    1_000_000_000n, // 1 TON
    2_000_000_000n, // 2 TON
    5_700_000_000n, // 5.7 TON  (100 tickets @ 56%)
    10_000_000_000n, // 10 TON
    50_000_000_000n, // 50 TON
  ];

  for (const totalCost of totalCosts) {
    it(`proxy accepts worst-case delivery at totalCost=${totalCost}n`, () => {
      // Post-fix: minAskAmount = totalCost. Worst case delivery = totalCost.
      // msgValue = totalCost + forward_gas. Needs to be ≥ totalCost + CONTRACT_RESERVE.
      const minAskAmount = totalCost;
      const msgValue = worstCaseMsgValue(minAskAmount);
      expect(proxyAccepts(msgValue, totalCost)).toBe(true);
    });
  }

  it("demonstrates the OLD behaviour would refund at totalCost ≥ 2 TON", () => {
    // Pre-fix: minAskAmount = totalCost × 0.95. This test exists to document
    // the regression class — if someone ever reverts to the old pattern,
    // they should first re-read this test and understand why.
    const slippageNumerator = 95n;
    const slippageDenominator = 100n;
    const brokenAtOrAbove = 2_000_000_000n;
    for (const totalCost of totalCosts) {
      const oldMinAskAmount =
        (totalCost * slippageNumerator) / slippageDenominator;
      const msgValue = worstCaseMsgValue(oldMinAskAmount);
      const accepts = proxyAccepts(msgValue, totalCost);
      if (totalCost >= brokenAtOrAbove) {
        expect(
          accepts,
          `OLD behaviour would refund at totalCost=${totalCost}n`,
        ).toBe(false);
      }
    }
  });
});
