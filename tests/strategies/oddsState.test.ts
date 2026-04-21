import { describe, expect, it } from "vitest";
import { ODDS_COUNT, ODDS_MAX, ODDS_MIN } from "../../src/constants.js";
import { ToncastBetError } from "../../src/errors.js";
import {
  availableTickets,
  indexToYesOdds,
  mergeSameOdds,
  validateOddsState,
  yesOddsToIndex,
} from "../../src/strategies/oddsState.js";
import type { OddsState } from "../../src/types.js";

function emptyOddsState(): OddsState {
  return {
    Yes: new Array(ODDS_COUNT).fill(0) as number[],
    No: new Array(ODDS_COUNT).fill(0) as number[],
  };
}

describe("indexToYesOdds / yesOddsToIndex", () => {
  it("index 0 → yesOdds 2", () => {
    expect(indexToYesOdds(0)).toBe(2);
  });

  it("index 48 → yesOdds 98", () => {
    expect(indexToYesOdds(48)).toBe(98);
  });

  it("yesOdds 50 → index 24", () => {
    expect(yesOddsToIndex(50)).toBe(24);
  });

  it("round-trips across the full range", () => {
    for (let i = 0; i < ODDS_COUNT; i++) {
      const yesOdds = indexToYesOdds(i);
      expect(yesOddsToIndex(yesOdds)).toBe(i);
    }
  });

  it("rejects out-of-range index", () => {
    expect(() => indexToYesOdds(-1)).toThrow(ToncastBetError);
    expect(() => indexToYesOdds(ODDS_COUNT)).toThrow(ToncastBetError);
    expect(() => indexToYesOdds(1.5)).toThrow(ToncastBetError);
  });

  it("rejects odd yesOdds", () => {
    expect(() => yesOddsToIndex(55)).toThrow(ToncastBetError);
  });

  it("rejects out-of-range yesOdds", () => {
    expect(() => yesOddsToIndex(0)).toThrow(ToncastBetError);
    expect(() => yesOddsToIndex(1)).toThrow(ToncastBetError);
    expect(() => yesOddsToIndex(100)).toThrow(ToncastBetError);
    expect(() => yesOddsToIndex(ODDS_MAX + 2)).toThrow(ToncastBetError);
    expect(() => yesOddsToIndex(ODDS_MIN - 2)).toThrow(ToncastBetError);
  });
});

describe("availableTickets", () => {
  it("YES user reads NO via complementary index (NO-prob = 100 − yesOdds)", () => {
    // Convention: `No[i]` stores NO orders at NO-probability 2*(i+1), i.e.
    // Pari yesOdds = 100 − 2*(i+1). So a NO order matchable at Pari
    // yesOdds=56 sits at index `yesOddsToIndex(100 − 56) = yesOddsToIndex(44)`.
    // YES-side is indexed directly by yesOdds.
    const state = emptyOddsState();
    state.No[yesOddsToIndex(100 - 56)] = 100; // → matchable at yesOdds=56
    state.Yes[yesOddsToIndex(56)] = 42;

    expect(availableTickets(state, true, 56)).toBe(100);
    expect(availableTickets(state, false, 56)).toBe(42);
  });

  it("YES lookup at same numeric index does NOT collide with NO lookup", () => {
    // Regression guard: before the complementary-index fix, putting `N` at
    // `No[yesOddsToIndex(X)]` accidentally satisfied `availableTickets(..,
    // true, X)`. After the fix, it instead satisfies `availableTickets(..,
    // true, 100 − X)` — proving the two lookups use different cells.
    const state = emptyOddsState();
    state.No[yesOddsToIndex(36)] = 200; // NO-prob 36% → Pari yesOdds 64
    expect(availableTickets(state, true, 64)).toBe(200);
    expect(availableTickets(state, true, 36)).toBe(0);
  });

  it("throws on negative cell (no silent coercion to 0)", () => {
    const state: OddsState = {
      Yes: new Array(ODDS_COUNT)
        .fill(0)
        .map((_, i) => (i === 0 ? -5 : 0)) as number[],
      No: new Array(ODDS_COUNT).fill(0) as number[],
    };
    expect(() => availableTickets(state, false, 2)).toThrow(ToncastBetError);
  });

  it("throws on non-finite cell (NaN)", () => {
    const state: OddsState = {
      Yes: new Array(ODDS_COUNT)
        .fill(0)
        .map((_, i) => (i === 1 ? Number.NaN : 0)) as number[],
      No: new Array(ODDS_COUNT).fill(0) as number[],
    };
    expect(() => availableTickets(state, false, 4)).toThrow(ToncastBetError);
  });

  it("throws on fractional cell (no silent truncation)", () => {
    const state = emptyOddsState();
    state.No[yesOddsToIndex(100 - 40)] = 7.9; // matchable at yesOdds=40
    expect(() => availableTickets(state, true, 40)).toThrow(ToncastBetError);
  });
});

describe("validateOddsState", () => {
  it("accepts correctly shaped state", () => {
    expect(() => validateOddsState(emptyOddsState())).not.toThrow();
  });

  it("rejects wrong lengths", () => {
    expect(() =>
      validateOddsState({
        Yes: new Array(10).fill(0) as number[],
        No: new Array(ODDS_COUNT).fill(0) as number[],
      }),
    ).toThrow(ToncastBetError);
  });

  it("rejects missing arrays", () => {
    expect(() => validateOddsState({} as OddsState)).toThrow(ToncastBetError);
  });

  it("rejects negative cell values (INVALID_ODDS_STATE)", () => {
    // Regression for Bug 9: used to only check array lengths and silently
    // clamp negatives to 0 in availableTickets — corrupt data was hidden.
    const s = emptyOddsState();
    s.No[10] = -1;
    try {
      validateOddsState(s);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ToncastBetError);
      if (e instanceof ToncastBetError)
        expect(e.code).toBe("INVALID_ODDS_STATE");
    }
  });

  it("rejects non-integer cell values", () => {
    const s = emptyOddsState();
    s.Yes[5] = 3.14;
    expect(() => validateOddsState(s)).toThrow(ToncastBetError);
  });

  it("rejects cell values above uint32", () => {
    const s = emptyOddsState();
    s.Yes[0] = 0x1_0000_0000;
    expect(() => validateOddsState(s)).toThrow(ToncastBetError);
  });
});

describe("availableTickets (strict on bad cells)", () => {
  it("throws INVALID_ODDS_STATE on negative cell instead of returning 0", () => {
    // Regression for Bug 9: defense-in-depth for callers that skip
    // validateOddsState upfront — don't silently hide -1 as 0.
    const s = emptyOddsState();
    s.No[yesOddsToIndex(100 - 56)] = -5;
    try {
      availableTickets(s, true, 56);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ToncastBetError);
      if (e instanceof ToncastBetError)
        expect(e.code).toBe("INVALID_ODDS_STATE");
    }
  });

  it("returns the stored integer when cell is valid", () => {
    const s = emptyOddsState();
    s.No[yesOddsToIndex(100 - 56)] = 100;
    expect(availableTickets(s, true, 56)).toBe(100);
  });
});

describe("mergeSameOdds", () => {
  it("merges duplicates, sums ticketsCount", () => {
    const merged = mergeSameOdds([
      { yesOdds: 56, ticketsCount: 100 },
      { yesOdds: 54, ticketsCount: 17 },
      { yesOdds: 56, ticketsCount: 183 },
    ]);
    expect(merged).toEqual([
      { yesOdds: 54, ticketsCount: 17 },
      { yesOdds: 56, ticketsCount: 283 },
    ]);
  });

  it("orders output ascending by yesOdds", () => {
    const merged = mergeSameOdds([
      { yesOdds: 98, ticketsCount: 1 },
      { yesOdds: 2, ticketsCount: 1 },
      { yesOdds: 50, ticketsCount: 1 },
    ]);
    expect(merged.map((b) => b.yesOdds)).toEqual([2, 50, 98]);
  });

  it("no duplicates → identity preserved (modulo order)", () => {
    const input = [
      { yesOdds: 54, ticketsCount: 10 },
      { yesOdds: 56, ticketsCount: 20 },
    ];
    expect(mergeSameOdds(input)).toEqual(input);
  });

  it("empty → empty", () => {
    expect(mergeSameOdds([])).toEqual([]);
  });
});
