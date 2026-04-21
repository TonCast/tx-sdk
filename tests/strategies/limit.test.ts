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

/**
 * Seed NO orders matchable against a YES bet at the given Pari yesOdds.
 *
 * The `No` array is indexed by NO-probability (= 100 − yesOdds), so a NO
 * order matchable at Pari yesOdds=X lives at `No[yesOddsToIndex(100 − X)]`.
 * See the `availableTickets` JSDoc for the full convention.
 */
function stateWithNo(
  entries: Array<{ yesOdds: number; tickets: number }>,
): OddsState {
  const s = emptyOddsState();
  for (const e of entries) {
    s.No[yesOddsToIndex(100 - e.yesOdds)] = e.tickets;
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

  describe("regression: YES side uses complementary No-array lookup", () => {
    // Real user-reported state from Toncast UI: YES tickets at Pari yesOdds
    // 50/52/54/56 live in `Yes[24..27]` (direct indexing), while the
    // opposing NO orders matchable against YES bets at Pari yesOdds
    // 58/60/62/64 live in `No[17..20]` (complementary indexing — the raw
    // index matches NO-probability, not yesOdds).
    //
    // Before the fix, `availableTickets(.., true, 58)` wrongly read
    // `No[yesOddsToIndex(58)] = No[28]`, returning 0 and so a YES limit bet
    // ignored all the liquidity it should have matched. The NO side was
    // already correct, masking the bug until a large YES bet was compared
    // with UI figures.
    const s: OddsState = {
      Yes: new Array(ODDS_COUNT).fill(0) as number[],
      No: new Array(ODDS_COUNT).fill(0) as number[],
    };
    s.Yes[24] = 200; // yesOdds=50
    s.Yes[25] = 104; // yesOdds=52
    s.Yes[26] = 50; //  yesOdds=54
    s.Yes[27] = 24; //  yesOdds=56
    s.No[17] = 200; //  matchable at yesOdds=64 (NO-prob=36)
    s.No[18] = 100; //  matchable at yesOdds=62 (NO-prob=38)
    s.No[19] = 50; //   matchable at yesOdds=60 (NO-prob=40)
    s.No[20] = 20; //   matchable at yesOdds=58 (NO-prob=42)

    it("YES user, worstYesOdds=66, 500 tickets → matches UI screenshot", () => {
      const r = computeLimitBets({
        oddsState: s,
        isYes: true,
        worstYesOdds: 66,
        ticketsCount: 500,
      });
      expect(r.bets).toEqual([
        { yesOdds: 58, ticketsCount: 20 },
        { yesOdds: 60, ticketsCount: 50 },
        { yesOdds: 62, ticketsCount: 100 },
        { yesOdds: 64, ticketsCount: 200 },
        { yesOdds: 66, ticketsCount: 130 },
      ]);
      // Matched stake: 20·0.058 + 50·0.060 + 100·0.062 + 200·0.064 = 23.16 TON.
      // Placement stake: 130·0.066 = 8.58 TON.
      // 5 batch entries × 0.1 TON execution fee = 0.5 TON.
      // Total = 32.24 TON.
      expect(r.totalCost).toBe(32_240_000_000n);
    });

    it("NO user, worstYesOdds=46, 500 tickets → matches UI screenshot", () => {
      const r = computeLimitBets({
        oddsState: s,
        isYes: false,
        worstYesOdds: 46,
        ticketsCount: 500,
      });
      expect(r.bets).toEqual([
        { yesOdds: 46, ticketsCount: 122 },
        { yesOdds: 50, ticketsCount: 200 },
        { yesOdds: 52, ticketsCount: 104 },
        { yesOdds: 54, ticketsCount: 50 },
        { yesOdds: 56, ticketsCount: 24 },
      ]);
      // NO ticketCost = (100 − yesOdds)·0.001 TON:
      //   24·0.044 + 50·0.046 + 104·0.048 + 200·0.050 = 17.348 matched
      //   placement 122·0.054 = 6.588
      //   5 entries × 0.1 fee = 0.5
      // Total = 25.436 TON.
      expect(r.totalCost).toBe(25_436_000_000n);
    });
  });

  describe("regression: matched-at-worstYesOdds is preserved in breakdown", () => {
    // User report from a NO, worstYesOdds=2 case: 2 tickets matched at
    // yesOdds=2 + 710 placement tickets at yesOdds=2. The `bets` array is
    // merged (for fee-efficient on-chain submission), but `breakdown` MUST
    // keep both legs separate so UIs can render "matching" and "place"
    // line items correctly. A bug in consumer UIs that reads `bets` instead
    // of `breakdown` is out of scope for the SDK.
    it("exposes 2-tickets matched + 710-tickets placement via breakdown", () => {
      const s: OddsState = {
        Yes: new Array(ODDS_COUNT).fill(0) as number[],
        No: new Array(ODDS_COUNT).fill(0) as number[],
      };
      s.Yes[0] = 2; //  yesOdds=2,  2 YES tickets (last matched slot)
      s.Yes[1] = 5; //  yesOdds=4,  5 YES tickets
      s.Yes[19] = 200; // yesOdds=40, 200 YES tickets
      s.Yes[20] = 83; //  yesOdds=42, 83 YES tickets

      const r = computeLimitBets({
        oddsState: s,
        isYes: false,
        worstYesOdds: 2,
        ticketsCount: 1000,
      });

      // `bets` is merged: the 2 matched + 710 placement at yesOdds=2 fold
      // into a single `{2, 712}` entry, saving 0.1 TON on execution fees.
      expect(r.bets).toEqual([
        { yesOdds: 2, ticketsCount: 712 },
        { yesOdds: 4, ticketsCount: 5 },
        { yesOdds: 40, ticketsCount: 200 },
        { yesOdds: 42, ticketsCount: 83 },
      ]);

      // The split survives intact in `breakdown`:
      expect(r.breakdown.matched.at(-1)).toEqual({
        yesOdds: 2,
        tickets: 2,
        cost: 100_000_000n + 2n * 98_000_000n, // 0.1 + 0.196 = 0.296 TON
      });
      expect(r.breakdown.unmatched).toEqual({
        yesOdds: 2,
        tickets: 710,
        cost: 100_000_000n + 710n * 98_000_000n, // 0.1 + 69.58 = 69.68 TON
      });

      // Total = 4 merged entries × 0.1 fee + ticket stake
      // = 0.4 + (712·0.098 + 5·0.096 + 200·0.060 + 83·0.058)
      // = 0.4 + (69.776 + 0.48 + 12 + 4.814)
      // = 87.47 TON.
      expect(r.totalCost).toBe(87_470_000_000n);
    });
  });
});
