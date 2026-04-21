import { describe, expect, it } from "vitest";
import {
  PARI_EXECUTION_FEE,
  PLATFORM_FEE_PCT,
  WIN_AMOUNT_PER_TICKET,
} from "../src/constants.js";
import { ToncastBetError } from "../src/errors.js";
import type { BetItem, BetQuote } from "../src/types.js";
import {
  breakdownTotals,
  calcWinnings,
  yesOddsToDecimalOdds,
  yesOddsToProbabilityPct,
} from "../src/ui-helpers.js";

// ─── yesOddsToProbabilityPct ─────────────────────────────────────────────────

describe("yesOddsToProbabilityPct", () => {
  it("YES side returns yesOdds as-is", () => {
    expect(yesOddsToProbabilityPct(56, true)).toBe(56);
    expect(yesOddsToProbabilityPct(2, true)).toBe(2);
    expect(yesOddsToProbabilityPct(98, true)).toBe(98);
  });

  it("NO side returns 100 - yesOdds", () => {
    expect(yesOddsToProbabilityPct(56, false)).toBe(44);
    expect(yesOddsToProbabilityPct(2, false)).toBe(98);
    expect(yesOddsToProbabilityPct(98, false)).toBe(2);
  });

  it("rejects non-even / out-of-range yesOdds", () => {
    expect(() => yesOddsToProbabilityPct(55, true)).toThrow(ToncastBetError);
    expect(() => yesOddsToProbabilityPct(0, true)).toThrow(ToncastBetError);
    expect(() => yesOddsToProbabilityPct(100, true)).toThrow(ToncastBetError);
  });
});

// ─── yesOddsToDecimalOdds ────────────────────────────────────────────────────

describe("yesOddsToDecimalOdds", () => {
  it("YES 56% → 100/56 ≈ 1.7857", () => {
    const d = yesOddsToDecimalOdds(56, true);
    expect(d).toBeCloseTo(1.7857, 4);
  });

  it("NO 56% → 100/44 ≈ 2.2727", () => {
    const d = yesOddsToDecimalOdds(56, false);
    expect(d).toBeCloseTo(2.2727, 4);
  });

  it("50/50: YES and NO both give 2.0", () => {
    expect(yesOddsToDecimalOdds(50, true)).toBe(2);
    expect(yesOddsToDecimalOdds(50, false)).toBe(2);
  });
});

// ─── calcWinnings ────────────────────────────────────────────────────────────

describe("calcWinnings", () => {
  it("100 tickets, no referral → 100 * 0.1 TON * 96% = 9.6 TON", () => {
    const bets: BetItem[] = [{ yesOdds: 56, ticketsCount: 100 }];
    const net = calcWinnings(bets, 0);
    // (100 tickets) * (0.1 TON) * (1 - 0.04) = 9.6 TON = 9_600_000_000n
    expect(net).toBe(9_600_000_000n);
  });

  it("100 tickets, 3% referral → 93% net", () => {
    const bets: BetItem[] = [{ yesOdds: 56, ticketsCount: 100 }];
    expect(calcWinnings(bets, 3)).toBe(9_300_000_000n);
  });

  it("max referral 7 → 89% net", () => {
    const bets: BetItem[] = [{ yesOdds: 56, ticketsCount: 100 }];
    expect(calcWinnings(bets, 7)).toBe(8_900_000_000n);
  });

  it("sums ticketsCount across multiple entries", () => {
    // 317 total matched + 14931 placement = 15248 tickets (Market example)
    const bets: BetItem[] = [
      { yesOdds: 54, ticketsCount: 17 },
      { yesOdds: 56, ticketsCount: 100 },
      { yesOdds: 58, ticketsCount: 200 + 14931 },
    ];
    const net = calcWinnings(bets, 0);
    // 15248 * 0.1 * 0.96 = 1463.808 TON
    expect(net).toBe((15248n * WIN_AMOUNT_PER_TICKET * 96n) / 100n);
  });

  it("rejects negative referralPct", () => {
    expect(() => calcWinnings([{ yesOdds: 56, ticketsCount: 1 }], -1)).toThrow(
      ToncastBetError,
    );
  });

  it("rejects fractional referralPct", () => {
    expect(() => calcWinnings([{ yesOdds: 56, ticketsCount: 1 }], 1.5)).toThrow(
      ToncastBetError,
    );
  });

  it("rejects referralPct that overflows 100% total (4% platform + referral)", () => {
    // 4 + 97 = 101% — more than total payout.
    expect(() => calcWinnings([{ yesOdds: 56, ticketsCount: 1 }], 97)).toThrow(
      ToncastBetError,
    );
  });

  it("PLATFORM_FEE_PCT constant matches the formula", () => {
    expect(PLATFORM_FEE_PCT).toBe(4);
  });
});

// ─── breakdownTotals ────────────────────────────────────────────────────────

describe("breakdownTotals", () => {
  function makeQuote(bd: BetQuote["breakdown"], bets: BetItem[]): BetQuote {
    return {
      mode: "limit",
      bets,
      isYes: true,
      totalCost: bets.reduce((s, _b) => s + PARI_EXECUTION_FEE + 0n, 0n),
      quotedAt: 0,
      option: {
        feasible: false,
        source: "TON",
        reason: "insufficient_balance",
      },
      lockedInRate: null,
      breakdown: bd,
    };
  }

  it("extracts matched + placement totals, stripping per-entry fee", () => {
    // Limit-like: 17 @ 54 + 100 @ 56 matched, 183 @ 56 placement.
    // ticketCost(54, YES) = 0.054 TON; ticketCost(56, YES) = 0.056 TON.
    const matched = [
      {
        yesOdds: 54,
        tickets: 17,
        cost: PARI_EXECUTION_FEE + 54_000_000n * 17n, // 0.1 + 0.918 = 1.018 TON
      },
      {
        yesOdds: 56,
        tickets: 100,
        cost: PARI_EXECUTION_FEE + 56_000_000n * 100n, // 0.1 + 5.6 = 5.7 TON
      },
    ];
    const unmatched = {
      yesOdds: 56,
      tickets: 183,
      cost: PARI_EXECUTION_FEE + 56_000_000n * 183n, // 0.1 + 10.248 = 10.348 TON
    };
    const bets: BetItem[] = [
      { yesOdds: 54, ticketsCount: 17 },
      // After mergeSameOdds: 100 matched + 183 placement at yesOdds=56 → 283.
      { yesOdds: 56, ticketsCount: 283 },
    ];
    const quote = makeQuote({ matched, unmatched }, bets);
    quote.totalCost =
      2n * PARI_EXECUTION_FEE + 17n * 54_000_000n + 283n * 56_000_000n;

    const t = breakdownTotals(quote);

    expect(t.matchedTickets).toBe(117);
    // matched ticket cost sans fee: 0.918 + 5.6 = 6.518 TON
    expect(t.matchedTicketCost).toBe(54_000_000n * 17n + 56_000_000n * 100n);

    expect(t.placementTickets).toBe(183);
    expect(t.placementTicketCost).toBe(56_000_000n * 183n);

    // Only 2 entries in final bets[] (after merge), so executionFee = 0.2 TON.
    expect(t.executionFee).toBe(2n * PARI_EXECUTION_FEE);

    expect(t.stake).toBe(t.matchedTicketCost + t.placementTicketCost);
    expect(t.total).toBe(quote.totalCost);
    expect(t.stake + t.executionFee).toBe(t.total);
  });

  it("handles Fixed mode (one matched entry, no placement)", () => {
    const bets: BetItem[] = [{ yesOdds: 56, ticketsCount: 100 }];
    const quote = makeQuote(
      {
        matched: [
          {
            yesOdds: 56,
            tickets: 100,
            cost: PARI_EXECUTION_FEE + 56_000_000n * 100n,
          },
        ],
      },
      bets,
    );
    quote.totalCost = PARI_EXECUTION_FEE + 56_000_000n * 100n;

    const t = breakdownTotals(quote);

    expect(t.matchedTickets).toBe(100);
    expect(t.matchedTicketCost).toBe(56_000_000n * 100n);
    expect(t.placementTickets).toBe(0);
    expect(t.placementTicketCost).toBe(0n);
    expect(t.executionFee).toBe(PARI_EXECUTION_FEE);
    expect(t.stake).toBe(56_000_000n * 100n);
    expect(t.total).toBe(quote.totalCost);
  });
});
