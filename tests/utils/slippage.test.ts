import { describe, expect, it } from "vitest";
import {
  combineLegSlippage,
  grossUpForSlippage,
  perLegSlippage,
} from "../../src/utils/slippage.js";

describe("grossUpForSlippage", () => {
  it("0% slippage is a no-op", () => {
    expect(grossUpForSlippage(350_000_000n, "0")).toBe(350_000_000n);
    expect(grossUpForSlippage(1n, "0")).toBe(1n);
  });

  it("5% slippage grosses up so minAskUnits (= ask×0.95) stays ≥ target", () => {
    // Reproduces the mainnet scenario: totalCost = 0.35 TON, slippage 5%.
    // Without the gross-up the swap could legally deliver 0.35 × 0.95 =
    // 0.3325 TON, below totalCost, and the proxy refunds. Grossing up by
    // 1/0.95 forces ask ≈ 0.36842 TON → minAskUnits = ask × 0.95 = 0.35.
    const target = 350_000_000n;
    const bumped = grossUpForSlippage(target, "0.05");
    // ceil(350_000_000 × 10_000 / 9_500) = 368_421_053
    expect(bumped).toBe(368_421_053n);
    // Verify the DEX floor (ask × 0.95) is ≥ original target.
    const minAsk = (bumped * 9_500n) / 10_000n;
    expect(minAsk).toBeGreaterThanOrEqual(target);
  });

  it("ceils the result — never under-delivers by one unit", () => {
    // amount=100, slippage=0.1 → ask = 100/0.9 = 111.111… → ceil = 112.
    // minAsk = floor(112 × 0.9) = 100 ≥ target.
    const bumped = grossUpForSlippage(100n, "0.1");
    expect(bumped).toBe(112n);
  });

  it("rejects slippage out of [0, 1)", () => {
    expect(() => grossUpForSlippage(1n, "1")).toThrow();
    expect(() => grossUpForSlippage(1n, "-0.01")).toThrow();
    expect(() => grossUpForSlippage(1n, "not-a-number")).toThrow();
  });

  it("sub-basis-point slippage still grosses up (no silent no-op)", () => {
    // Regression: with a basis-point-only SCALE=10_000, slippage="0.00001"
    // rounded to `keep=10_000` and the helper silently returned `amount`
    // unchanged — re-opening the mainnet minAskUnits < totalCost refund
    // scenario. With SCALE=10^9 the bump is honoured at any realistic
    // precision.
    const target = 350_000_000n;
    const bumped = grossUpForSlippage(target, "0.00001");
    expect(bumped).toBeGreaterThan(target);
    // ceil(350_000_000 / 0.99999) = 350_003_501
    expect(bumped).toBe(350_003_501n);
    // Verify the DEX enforcement floor (ask × 0.99999) stays ≥ target.
    const minAsk = (bumped * 99_999n) / 100_000n;
    expect(minAsk).toBeGreaterThanOrEqual(target);
  });

  it("bps-precision values still match expected ceiling (no regression)", () => {
    // Existing callers use bp-granularity values like "0.05", "0.01".
    // Switching SCALE from 10_000 → 10^9 must not shift their results.
    expect(grossUpForSlippage(350_000_000n, "0.05")).toBe(368_421_053n);
    expect(grossUpForSlippage(100n, "0.1")).toBe(112n);
    expect(grossUpForSlippage(1_000_000_000n, "0.01")).toBe(1_010_101_011n);
  });
});

describe("perLegSlippage", () => {
  it("legCount=1 is the identity (direct routes unchanged)", () => {
    expect(perLegSlippage("0.05", 1)).toBe("0.05");
    expect(perLegSlippage("0.005", 1)).toBe("0.005");
  });

  it("legCount=2 splits user budget so compounded ≈ route-total", () => {
    // (1 − perLeg)² = 1 − 0.05 → perLeg = 1 − √0.95 ≈ 0.0253205
    const perLeg = perLegSlippage("0.05", 2);
    const v = Number(perLeg);
    // perLegSlippage caps at 9 decimals so the round-trip is accurate
    // to ~10⁻⁹ — well inside any realistic slippage configuration.
    expect(v).toBeCloseTo(1 - Math.sqrt(0.95), 8);
    expect((1 - v) ** 2).toBeCloseTo(1 - 0.05, 8);
  });

  it("legCount=2 at 0% is 0% (no-op)", () => {
    expect(Number(perLegSlippage("0", 2))).toBe(0);
  });

  it("rejects out-of-range slippage", () => {
    expect(() => perLegSlippage("1", 2)).toThrow();
    expect(() => perLegSlippage("-0.1", 2)).toThrow();
    expect(() => perLegSlippage("not-a-number", 2)).toThrow();
  });
});

describe("combineLegSlippage", () => {
  it("legCount=1 is the identity", () => {
    expect(combineLegSlippage("0.025", 1)).toBe("0.025");
  });

  it("legCount=2 composes via 1 − (1 − perLeg)²", () => {
    // perLeg 0.025 → total = 1 − 0.975² = 0.049375
    expect(Number(combineLegSlippage("0.025", 2))).toBeCloseTo(
      1 - 0.975 ** 2,
      9,
    );
  });

  it("perLegSlippage and combineLegSlippage round-trip", () => {
    const total = "0.05";
    const perLeg = perLegSlippage(total, 2);
    const recombined = combineLegSlippage(perLeg, 2);
    // 9-decimal cap on each helper means the round-trip drift is at
    // most ~10⁻⁹ — orders of magnitude finer than any realistic UI
    // slippage step.
    expect(Number(recombined)).toBeCloseTo(Number(total), 8);
  });
});
