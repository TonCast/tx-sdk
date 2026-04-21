import { describe, expect, it } from "vitest";
import { ToncastBetError } from "../../src/errors.js";
import { computeFixedBets } from "../../src/strategies/fixed.js";

describe("computeFixedBets", () => {
  it("produces a single entry", () => {
    const result = computeFixedBets({
      yesOdds: 56,
      ticketsCount: 100,
      isYes: true,
    });
    expect(result.bets).toEqual([{ yesOdds: 56, ticketsCount: 100 }]);
    expect(result.totalCost).toBe(5_700_000_000n);
    expect(result.breakdown.matched).toHaveLength(1);
    expect(result.breakdown.matched[0]).toEqual({
      yesOdds: 56,
      tickets: 100,
      cost: 5_700_000_000n,
    });
  });

  it("rejects odd yesOdds", () => {
    expect(() =>
      computeFixedBets({ yesOdds: 55, ticketsCount: 10, isYes: true }),
    ).toThrow(ToncastBetError);
  });

  it("rejects ticketsCount 0", () => {
    expect(() =>
      computeFixedBets({ yesOdds: 50, ticketsCount: 0, isYes: true }),
    ).toThrow(ToncastBetError);
  });

  it("rejects fractional ticketsCount", () => {
    expect(() =>
      computeFixedBets({ yesOdds: 50, ticketsCount: 1.5, isYes: true }),
    ).toThrow(ToncastBetError);
  });
});
