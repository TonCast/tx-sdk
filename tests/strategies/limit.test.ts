import { describe, expect, it } from "vitest";
import { ODDS_COUNT } from "../../src/constants.js";
import { ToncastBetError } from "../../src/errors.js";
import { computeLimitBets } from "../../src/strategies/limit.js";
import { yesOddsToIndex } from "../../src/strategies/oddsState.js";
import type { OddsState } from "../../src/types.js";

function emptyOddsState(): OddsState {
  return {
    Yes: new Array(ODDS_COUNT).fill(0) as number[],
    No: new Array(ODDS_COUNT).fill(0) as number[],
  };
}

function stateWithNo(
  entries: Array<{ yesOdds: number; tickets: number }>,
): OddsState {
  const s = emptyOddsState();
  for (const e of entries) {
    s.No[yesOddsToIndex(e.yesOdds)] = e.tickets;
  }
  return s;
}

describe("computeLimitBets", () => {
  it("matches the Limit screenshot (worst=56, 300 tickets, 17@54 + 100@56)", () => {
    const result = computeLimitBets({
      oddsState: stateWithNo([
        { yesOdds: 54, tickets: 17 },
        { yesOdds: 56, tickets: 100 },
      ]),
      isYes: true,
      worstYesOdds: 56,
      ticketsCount: 300,
    });

    // After merge: {54,17} + {56,100+183} = 2 entries
    expect(result.bets).toEqual([
      { yesOdds: 54, ticketsCount: 17 },
      { yesOdds: 56, ticketsCount: 283 },
    ]);
    expect(result.breakdown.matched).toEqual([
      { yesOdds: 54, tickets: 17, cost: 100_000_000n + 17n * 54_000_000n },
      { yesOdds: 56, tickets: 100, cost: 100_000_000n + 100n * 56_000_000n },
    ]);
    expect(result.breakdown.unmatched).toEqual({
      yesOdds: 56,
      tickets: 183,
      cost: 100_000_000n + 183n * 56_000_000n,
    });
  });

  it("fully matches without remainder", () => {
    const result = computeLimitBets({
      oddsState: stateWithNo([{ yesOdds: 50, tickets: 100 }]),
      isYes: true,
      worstYesOdds: 56,
      ticketsCount: 100,
    });
    expect(result.bets).toEqual([{ yesOdds: 50, ticketsCount: 100 }]);
    expect(result.breakdown.unmatched).toBeUndefined();
  });

  it("no counter-side liquidity → everything falls on worstYesOdds", () => {
    const result = computeLimitBets({
      oddsState: emptyOddsState(),
      isYes: true,
      worstYesOdds: 56,
      ticketsCount: 100,
    });
    expect(result.bets).toEqual([{ yesOdds: 56, ticketsCount: 100 }]);
    expect(result.breakdown.matched).toHaveLength(0);
    expect(result.breakdown.unmatched?.tickets).toBe(100);
  });

  it("skips yesOdds above worstYesOdds even if liquidity exists there", () => {
    const result = computeLimitBets({
      oddsState: stateWithNo([
        { yesOdds: 50, tickets: 50 },
        { yesOdds: 60, tickets: 1000 }, // beyond worstYesOdds — must be ignored
      ]),
      isYes: true,
      worstYesOdds: 56,
      ticketsCount: 80,
    });
    // 50 matched at 50%, 30 placed at 56 (worstYesOdds).
    expect(result.bets).toEqual([
      { yesOdds: 50, ticketsCount: 50 },
      { yesOdds: 56, ticketsCount: 30 },
    ]);
  });

  it("skips empty levels between matches", () => {
    const result = computeLimitBets({
      oddsState: stateWithNo([
        { yesOdds: 40, tickets: 10 },
        { yesOdds: 46, tickets: 15 },
      ]),
      isYes: true,
      worstYesOdds: 48,
      ticketsCount: 20,
    });
    expect(result.bets).toEqual([
      { yesOdds: 40, ticketsCount: 10 },
      { yesOdds: 46, ticketsCount: 10 },
    ]);
  });

  it("NO user consumes YES tickets (mirrored), best→worst descent", () => {
    // NO-side pricing: ticketCost = WIN * (100 − yesOdds) / 100, so larger
    // yesOdds is CHEAPER for NO. The iteration must walk from ODDS_MAX
    // down to `worstYesOdds` (here 40). Liquidity at yesOdds=50 is within
    // [40, 98] → matched; placement remainder lands on worstYesOdds=40.
    const state = emptyOddsState();
    state.Yes[yesOddsToIndex(50)] = 40;
    const result = computeLimitBets({
      oddsState: state,
      isYes: false,
      worstYesOdds: 40,
      ticketsCount: 40,
    });
    expect(result.bets).toEqual([{ yesOdds: 50, ticketsCount: 40 }]);
  });

  it("NO user skips liquidity below worstYesOdds threshold", () => {
    // worstYesOdds=60 means "don't accept worse than yesOdds=60" (for NO,
    // that's the cheapest acceptable tickets). Liquidity at yesOdds=50 is
    // BELOW the threshold — must be ignored and full 40 tickets land on
    // placement at worstYesOdds=60.
    const state = emptyOddsState();
    state.Yes[yesOddsToIndex(50)] = 40;
    const result = computeLimitBets({
      oddsState: state,
      isYes: false,
      worstYesOdds: 60,
      ticketsCount: 40,
    });
    expect(result.bets).toEqual([{ yesOdds: 60, ticketsCount: 40 }]);
  });

  it("NO user takes liquidity at the cheapest yesOdds first", () => {
    // Three liquidity levels. NO-side cost per ticket:
    //   yesOdds=80 → 0.02 TON (cheapest → best coefficient ×5)
    //   yesOdds=60 → 0.04 TON
    //   yesOdds=40 → 0.06 TON (worstYesOdds threshold here)
    // Iteration is DESC from 98. Should consume 80 first, then 60, then 40.
    const state = emptyOddsState();
    state.Yes[yesOddsToIndex(80)] = 10;
    state.Yes[yesOddsToIndex(60)] = 15;
    state.Yes[yesOddsToIndex(40)] = 50;
    const result = computeLimitBets({
      oddsState: state,
      isYes: false,
      worstYesOdds: 40,
      ticketsCount: 30,
    });
    // 10 @ 80, then 15 @ 60, then 5 @ 40 — remaining 0, no placement needed.
    expect(result.bets).toEqual([
      { yesOdds: 40, ticketsCount: 5 },
      { yesOdds: 60, ticketsCount: 15 },
      { yesOdds: 80, ticketsCount: 10 },
    ]);
    expect(result.breakdown.unmatched).toBeUndefined();
  });

  it("rejects odd worstYesOdds", () => {
    expect(() =>
      computeLimitBets({
        oddsState: emptyOddsState(),
        isYes: true,
        worstYesOdds: 55,
        ticketsCount: 10,
      }),
    ).toThrow(ToncastBetError);
  });

  it("rejects invalid oddsState shape", () => {
    expect(() =>
      computeLimitBets({
        oddsState: { Yes: [], No: [] } as unknown as OddsState,
        isYes: true,
        worstYesOdds: 50,
        ticketsCount: 10,
      }),
    ).toThrow(ToncastBetError);
  });
});
