import { describe, expect, it } from "vitest";
import {
  CONTRACT_RESERVE,
  PARI_EXECUTION_FEE,
  WIN_AMOUNT_PER_TICKET,
} from "../src/constants.js";
import { calcBetCost, ticketCost } from "../src/cost.js";

describe("ticketCost", () => {
  it("YES bet at 56% costs 0.056 TON per ticket", () => {
    expect(ticketCost(56, true)).toBe(56_000_000n);
  });

  it("NO bet at 56% (i.e. YES=56) costs 0.044 TON per ticket", () => {
    expect(ticketCost(56, false)).toBe(44_000_000n);
  });

  it("YES bet at minimum 2% costs 0.002 TON", () => {
    expect(ticketCost(2, true)).toBe(2_000_000n);
  });

  it("YES bet at maximum 98% costs 0.098 TON", () => {
    expect(ticketCost(98, true)).toBe(98_000_000n);
  });

  it("NO bet mirrors YES: NO at 54% == YES at 46%", () => {
    expect(ticketCost(54, false)).toBe(ticketCost(46, true));
  });

  it("matches the contract constants", () => {
    expect(WIN_AMOUNT_PER_TICKET).toBe(100_000_000n);
    expect(PARI_EXECUTION_FEE).toBe(100_000_000n);
    expect(CONTRACT_RESERVE).toBe(10_000_000n);
  });
});

describe("calcBetCost", () => {
  it("single entry: 100 tickets @ 56% YES = 0.1 + 5.6 = 5.7 TON", () => {
    const { totalCost, perEntry } = calcBetCost(
      [{ yesOdds: 56, ticketsCount: 100 }],
      true,
    );
    expect(totalCost).toBe(5_700_000_000n);
    expect(perEntry).toHaveLength(1);
    expect(perEntry[0]?.cost).toBe(5_700_000_000n);
  });

  it("matches screenshot Fixed: 100 tickets @ 56% → 5.7 TON total", () => {
    // Screenshot values: "100 tickets @ 56% • 5.6 TON" + "0.1 TON" fee = 5.7 TON итого
    const { totalCost } = calcBetCost(
      [{ yesOdds: 56, ticketsCount: 100 }],
      true,
    );
    expect(totalCost).toBe(5_700_000_000n);
  });

  it("matches screenshot Limit: 17@54 + 100@56 + 183@56 (before merge) = ~17.0 TON", () => {
    // 17 * 0.054 + 100 * 0.056 + 183 * 0.056 = 0.918 + 5.6 + 10.248 = 16.766 TON (tickets)
    // + 3 * 0.1 execution fee = 17.066 TON
    const { totalCost } = calcBetCost(
      [
        { yesOdds: 54, ticketsCount: 17 },
        { yesOdds: 56, ticketsCount: 100 },
        { yesOdds: 56, ticketsCount: 183 },
      ],
      true,
    );
    expect(totalCost).toBe(17_066_000_000n);
  });

  it("each entry includes exactly one PARI_EXECUTION_FEE", () => {
    const { perEntry } = calcBetCost(
      [
        { yesOdds: 50, ticketsCount: 1 },
        { yesOdds: 50, ticketsCount: 1 },
      ],
      true,
    );
    // Each entry: 0.1 fee + 1 * 0.05 = 0.15 TON
    expect(perEntry[0]?.cost).toBe(150_000_000n);
    expect(perEntry[1]?.cost).toBe(150_000_000n);
  });

  it("empty bets → totalCost 0", () => {
    const { totalCost, perEntry } = calcBetCost([], true);
    expect(totalCost).toBe(0n);
    expect(perEntry).toHaveLength(0);
  });
});
