import { describe, expect, it } from "vitest";
import {
  ODDS_COUNT,
  ODDS_DEFAULT_PLACEMENT,
  PARI_EXECUTION_FEE,
} from "../../src/constants.js";
import { ToncastBetError } from "../../src/errors.js";
import { computeMarketBets } from "../../src/strategies/market.js";
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
 * See `availableTickets` JSDoc — `No` is indexed by NO-probability.
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

describe("computeMarketBets", () => {
  it("reproduces Market screenshot: budget ~884.416 TON, liquidity 17@54+100@56+200@58", () => {
    const result = computeMarketBets({
      oddsState: stateWithNo([
        { yesOdds: 54, tickets: 17 },
        { yesOdds: 56, tickets: 100 },
        { yesOdds: 58, tickets: 200 },
      ]),
      isYes: true,
      maxBudgetTon: 884_416_000_000n, // 884.416 TON
    });
    expect(result.feasible).toBe(true);
    if (!result.feasible) throw new Error("unreachable");

    // Matched: {54,17}, {56,100}, {58,200}. Placement extends 58.
    // Expected merged bets.
    const [b0, b1, b2] = result.bets;
    expect(b0?.yesOdds).toBe(54);
    expect(b0?.ticketsCount).toBe(17);
    expect(b1?.yesOdds).toBe(56);
    expect(b1?.ticketsCount).toBe(100);
    expect(b2?.yesOdds).toBe(58);
    // Placement tickets should add a large amount to b2.
    expect(b2?.ticketsCount).toBeGreaterThan(200);

    expect(result.breakdown.matched).toHaveLength(3);
    expect(result.breakdown.placement?.yesOdds).toBe(58);
  });

  it("budget too small for any entry → feasible=false", () => {
    const result = computeMarketBets({
      oddsState: emptyOddsState(),
      isYes: true,
      maxBudgetTon: PARI_EXECUTION_FEE, // exactly one fee, not enough for any ticket
    });
    expect(result.feasible).toBe(false);
  });

  it("empty oddsState → placement on ODDS_DEFAULT_PLACEMENT=50", () => {
    const budget = 10_000_000_000n; // 10 TON, plenty for a default-placement bet
    const result = computeMarketBets({
      oddsState: emptyOddsState(),
      isYes: true,
      maxBudgetTon: budget,
    });
    expect(result.feasible).toBe(true);
    if (!result.feasible) throw new Error("unreachable");
    expect(result.bets).toHaveLength(1);
    expect(result.bets[0]?.yesOdds).toBe(ODDS_DEFAULT_PLACEMENT);
    expect(result.breakdown.placement?.yesOdds).toBe(ODDS_DEFAULT_PLACEMENT);
  });

  it("exact match with available liquidity, no placement", () => {
    // Liquidity 10 @ 50% YES-ticketCost 0.05 TON; cost = 0.1 fee + 10*0.05 = 0.6 TON.
    const result = computeMarketBets({
      oddsState: stateWithNo([{ yesOdds: 50, tickets: 10 }]),
      isYes: true,
      maxBudgetTon: 600_000_000n,
    });
    expect(result.feasible).toBe(true);
    if (!result.feasible) throw new Error("unreachable");
    expect(result.bets).toEqual([{ yesOdds: 50, ticketsCount: 10 }]);
    expect(result.breakdown.placement).toBeUndefined();
  });

  it("consumes only as much as the budget allows at a given yesOdds", () => {
    // Budget = 0.1 fee + 5 * 0.05 = 0.35 TON. Should take 5 tickets out of 10.
    const result = computeMarketBets({
      oddsState: stateWithNo([{ yesOdds: 50, tickets: 10 }]),
      isYes: true,
      maxBudgetTon: 350_000_000n,
    });
    expect(result.feasible).toBe(true);
    if (!result.feasible) throw new Error("unreachable");
    expect(result.bets[0]?.ticketsCount).toBe(5);
  });

  it("zero budget → feasible=false", () => {
    const result = computeMarketBets({
      oddsState: emptyOddsState(),
      isYes: true,
      maxBudgetTon: 0n,
    });
    expect(result.feasible).toBe(false);
  });

  it("NO user: iterates from ODDS_MAX down, filling cheapest tickets first", () => {
    // Reproduction of the critical NO-direction bug. Liquidity 100 tickets
    // at yesOdds=2 (most EXPENSIVE for NO, 0.098 TON/ticket) and 100
    // tickets at yesOdds=98 (cheapest for NO, 0.002 TON/ticket).
    // With a 0.6 TON budget a NO user should first consume the 100 @
    // yesOdds=98 tickets (cost 100*0.002 + 0.1 fee = 0.3 TON) and then
    // try to consume yesOdds=2 (next step). The ascending-direction bug
    // would instead drain the budget on the 0.098 TON tickets first and
    // return roughly 5 tickets — a ~20× worse result.
    const s = emptyOddsState();
    s.Yes[yesOddsToIndex(2)] = 100;
    s.Yes[yesOddsToIndex(98)] = 100;
    const result = computeMarketBets({
      oddsState: s,
      isYes: false,
      maxBudgetTon: 600_000_000n, // 0.6 TON
    });
    expect(result.feasible).toBe(true);
    if (!result.feasible) throw new Error("unreachable");

    // At minimum the NO user should have fully consumed the 100 @
    // yesOdds=98 liquidity — if the buggy direction was active, he'd get
    // about 5 tickets total at yesOdds=2.
    const entryAt98 = result.bets.find((b) => b.yesOdds === 98);
    expect(entryAt98?.ticketsCount).toBe(100);
    // Total tickets should be ≥ 100 — enforcing the cheapest-first rule.
    const totalTickets = result.bets.reduce((s, b) => s + b.ticketsCount, 0);
    expect(totalTickets).toBeGreaterThanOrEqual(100);
  });

  it("NO user: placement extends lastYesOdds (cheapest matched)", () => {
    const s = emptyOddsState();
    s.Yes[yesOddsToIndex(90)] = 10;
    const result = computeMarketBets({
      oddsState: s,
      isYes: false,
      maxBudgetTon: 2_000_000_000n, // 2 TON
    });
    if (!result.feasible) throw new Error("unreachable");
    // Matched 10 @ yesOdds=90, then placement extends yesOdds=90 with the
    // remaining budget.
    expect(result.bets).toHaveLength(1);
    expect(result.bets[0]?.yesOdds).toBe(90);
    expect(result.breakdown.placement?.yesOdds).toBe(90);
  });

  it("breakdownTotals contract holds when Market placement merges into matched", async () => {
    // Regression: previously `stake + executionFee !== totalCost` whenever
    // placement folded into `lastYesOdds` — ui-helpers.breakdownTotals
    // double-subtracted PARI_EXECUTION_FEE. Use the dynamic import to
    // avoid adding a direct dep from strategies tests onto ui-helpers.
    const { breakdownTotals } = await import("../../src/ui-helpers.js");
    const s = emptyOddsState();
    // 100 NO orders matchable at Pari yesOdds=56 → No[yesOddsToIndex(44)].
    s.No[yesOddsToIndex(100 - 56)] = 100;
    const r = computeMarketBets({
      oddsState: s,
      isYes: true,
      maxBudgetTon: 20_000_000_000n,
    });
    if (!r.feasible) throw new Error("unreachable");
    const quote = {
      mode: "market" as const,
      bets: r.bets,
      isYes: true,
      totalCost: r.totalCost,
      quotedAt: 0,
      option: {
        feasible: false as const,
        source: "TON" as const,
        reason: "insufficient_balance" as const,
      },
      lockedInRate: null,
      breakdown: r.breakdown,
    };
    const t = breakdownTotals(quote);
    expect(t.stake + t.executionFee).toBe(t.total);
  });

  it("fallback at exact budget threshold fits 1 ticket (no off-by-one)", () => {
    // Regression: previously the fallback branch used `<=` to gate
    // infeasibility, rejecting budgets equal to fee + fallbackPrice even
    // though that budget perfectly affords exactly one placement ticket.
    // ticketCost(50, YES) = 0.05 TON, fee = 0.1 TON → threshold 0.15 TON.
    const threshold = PARI_EXECUTION_FEE + 50_000_000n;
    const result = computeMarketBets({
      oddsState: emptyOddsState(),
      isYes: true,
      maxBudgetTon: threshold,
    });
    expect(result.feasible).toBe(true);
    if (!result.feasible) throw new Error("unreachable");
    expect(result.bets).toEqual([
      { yesOdds: ODDS_DEFAULT_PLACEMENT, ticketsCount: 1 },
    ]);
    expect(result.totalCost).toBe(threshold);
    // One-cent-below-threshold must still be infeasible — `<` not `≤`.
    const justBelow = computeMarketBets({
      oddsState: emptyOddsState(),
      isYes: true,
      maxBudgetTon: threshold - 1n,
    });
    expect(justBelow.feasible).toBe(false);
  });

  it("astronomical budget: merged ticketsCount caps at uint32 (no overflow)", async () => {
    // Regression: with enormous budget, matched + placement could merge
    // at `lastYesOdds` into > 0xffffffff tickets, later rejected by
    // validateBetParams with INVALID_TICKETS_COUNT (an internal error on
    // a nominally valid code path). The planner / ui would surface it
    // as a generic throw instead of a clean insufficient_balance.
    const { validateBetParams } = await import("../../src/validate.js");
    const s = emptyOddsState();
    s.No[yesOddsToIndex(50)] = 100; // small matched liquidity
    const result = computeMarketBets({
      oddsState: s,
      isYes: true,
      // ~1e21 nano-TON = 1e12 TON — far beyond any realistic balance; the
      // placement leg is what would overflow without the cap.
      maxBudgetTon: 1_000_000_000_000_000_000_000n,
    });
    expect(result.feasible).toBe(true);
    if (!result.feasible) throw new Error("unreachable");

    for (const b of result.bets) {
      expect(b.ticketsCount).toBeLessThanOrEqual(0xffffffff);
    }
    // `validateBetParams` must not throw on the strategy output — bets
    // are meant to be passed directly into the builder.
    expect(() =>
      validateBetParams({
        beneficiary: "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8",
        bets: result.bets,
        referral: null,
        referralPct: 0,
      }),
    ).not.toThrow();
  });

  it("negative budget → throws ToncastBetError with INVALID_BUDGET code", () => {
    // Regression: used to throw INVALID_TICKETS_COUNT which broke error-code
    // filtering for callers inspecting what went wrong.
    try {
      computeMarketBets({
        oddsState: emptyOddsState(),
        isYes: true,
        maxBudgetTon: -1n,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ToncastBetError);
      if (err instanceof ToncastBetError) {
        expect(err.code).toBe("INVALID_BUDGET");
      }
    }
  });
});
