import type { StonApiClient } from "@ston-fi/api";
import { describe, expect, it, vi } from "vitest";
import { TON_ADDRESS } from "../src/constants.js";
import { createRatesClient } from "../src/rates.js";
import {
  buildSimulation,
  createMockApiClient,
} from "./_utils/mockApiClient.js";

const OFFER = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

function makeClient(
  simulateReverseSwap?: StonApiClient["simulateReverseSwap"],
) {
  const apiClient = createMockApiClient({
    simulations: {
      [`${OFFER}→${TON_ADDRESS}`]: buildSimulation({
        offerAddress: OFFER,
        askAddress: TON_ADDRESS,
        offerUnits: "1000000",
        askUnits: "2000000000",
        minAskUnits: "1980000000",
      }),
    },
  });
  if (simulateReverseSwap) {
    (
      apiClient as unknown as { simulateReverseSwap: unknown }
    ).simulateReverseSwap = simulateReverseSwap;
  }
  return apiClient;
}

describe("createRatesClient", () => {
  it("forward simulation hits cache on second call", async () => {
    const apiClient = makeClient();
    const callStonApi = vi.fn(<T>(fn: () => Promise<T>) => fn());
    const rates = createRatesClient({
      apiClient,
      callStonApi: callStonApi as <T>(
        fn: () => Promise<T>,
        method: string,
      ) => Promise<T>,
      rateCacheTtlMs: 5000,
    });

    await rates.simulateForward({
      offerAddress: OFFER,
      askAddress: TON_ADDRESS,
      offerUnits: "1000000",
    });
    await rates.simulateForward({
      offerAddress: OFFER,
      askAddress: TON_ADDRESS,
      offerUnits: "1000000",
    });

    // Second call hits the cache — callStonApi is invoked only once.
    expect(callStonApi).toHaveBeenCalledTimes(1);
  });

  it("reverse simulation calls simulateReverseSwap and caches by askUnits", async () => {
    const reverseSim = buildSimulation({
      offerAddress: OFFER,
      askAddress: TON_ADDRESS,
      offerUnits: "1200000",
      askUnits: "2000000000",
      minAskUnits: "2000000000",
    });
    const simulateReverseSwap = vi.fn(async () => reverseSim);
    const apiClient = makeClient(
      simulateReverseSwap as unknown as StonApiClient["simulateReverseSwap"],
    );

    const callStonApi = vi.fn(<T>(fn: () => Promise<T>) => fn());
    const rates = createRatesClient({
      apiClient,
      callStonApi: callStonApi as <T>(
        fn: () => Promise<T>,
        method: string,
      ) => Promise<T>,
      rateCacheTtlMs: 5000,
    });

    await rates.simulateReverseToTon({
      offerAddress: OFFER,
      targetTonUnits: 2_000_000_000n,
    });
    await rates.simulateReverseToTon({
      offerAddress: OFFER,
      targetTonUnits: 2_000_000_000n,
    });

    expect(simulateReverseSwap).toHaveBeenCalledTimes(1);
  });

  it("simulateReverseCrossToTon chains two reverse calls", async () => {
    const INTERMEDIATE = "EQITERMXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const leg2 = buildSimulation({
      offerAddress: INTERMEDIATE,
      askAddress: TON_ADDRESS,
      offerUnits: "6000000",
      askUnits: "5700000000",
      minAskUnits: "5700000000",
      priceImpact: "0.01",
    });
    const leg1 = buildSimulation({
      offerAddress: OFFER,
      askAddress: INTERMEDIATE,
      offerUnits: "7200000",
      askUnits: "6000000",
      minAskUnits: "6000000",
      priceImpact: "0.01",
    });
    const simulateReverseSwap = vi
      .fn()
      .mockResolvedValueOnce(leg2)
      .mockResolvedValueOnce(leg1);
    const apiClient = makeClient(
      simulateReverseSwap as unknown as StonApiClient["simulateReverseSwap"],
    );
    const callStonApi = vi.fn(<T>(fn: () => Promise<T>) => fn());
    const rates = createRatesClient({
      apiClient,
      callStonApi: callStonApi as <T>(
        fn: () => Promise<T>,
        method: string,
      ) => Promise<T>,
      rateCacheTtlMs: 5000,
    });

    const result = await rates.simulateReverseCrossToTon({
      offerAddress: OFFER,
      intermediate: INTERMEDIATE,
      targetTonUnits: 5_700_000_000n,
    });

    expect(simulateReverseSwap).toHaveBeenCalledTimes(2);
    expect(result.leg1).toBe(leg1);
    expect(result.leg2).toBe(leg2);
  });

  it("simulateReverseCrossToTon throws when leg2 returns zero offerUnits", async () => {
    const badLeg2 = buildSimulation({
      offerAddress: "EQxx",
      askAddress: TON_ADDRESS,
      offerUnits: "0",
      askUnits: "1",
      minAskUnits: "1",
    });
    const apiClient = makeClient(
      vi.fn(
        async () => badLeg2,
      ) as unknown as StonApiClient["simulateReverseSwap"],
    );
    const rates = createRatesClient({
      apiClient,
      callStonApi: (async <T>(fn: () => Promise<T>) => fn()) as <T>(
        fn: () => Promise<T>,
        method: string,
      ) => Promise<T>,
      rateCacheTtlMs: 5000,
    });

    await expect(
      rates.simulateReverseCrossToTon({
        offerAddress: OFFER,
        intermediate: "EQxx",
        targetTonUnits: 5_700_000_000n,
      }),
    ).rejects.toMatchObject({ code: "NO_ROUTE" });
  });

  it("simulateReverseToTon bumps askUnits so minAskUnits stays ≥ target", async () => {
    // Mainnet regression: totalCost 0.35 TON at 5% slippage used to call
    // simulateReverseSwap with askUnits = "350000000", giving
    // minAskUnits = 0.3325 TON. A swap inside the slippage band then
    // legally under-delivered and the Pari proxy refunded. The fix is
    // to gross up askUnits internally so minAskUnits ≥ totalCost.
    const captured: Array<{ askUnits: string; slippageTolerance: string }> = [];
    const simulateReverseSwap = vi.fn(async (args: unknown) => {
      const a = args as { askUnits: string; slippageTolerance: string };
      captured.push({
        askUnits: a.askUnits,
        slippageTolerance: a.slippageTolerance,
      });
      return buildSimulation({
        offerAddress: OFFER,
        askAddress: TON_ADDRESS,
        offerUnits: "1200000",
        askUnits: a.askUnits,
        // Mimic STON.fi: minAskUnits ≈ askUnits × (1 − slippage).
        minAskUnits: ((BigInt(a.askUnits) * 9_500n) / 10_000n).toString(),
      });
    });
    const apiClient = makeClient(
      simulateReverseSwap as unknown as StonApiClient["simulateReverseSwap"],
    );
    const rates = createRatesClient({
      apiClient,
      callStonApi: (async <T>(fn: () => Promise<T>) => fn()) as <T>(
        fn: () => Promise<T>,
        method: string,
      ) => Promise<T>,
      rateCacheTtlMs: 5000,
    });

    const totalCost = 350_000_000n;
    const sim = await rates.simulateReverseToTon({
      offerAddress: OFFER,
      targetTonUnits: totalCost,
      slippage: "0.05",
    });

    expect(captured).toHaveLength(1);
    // Grossed-up askUnits must exceed totalCost / (1 − slippage).
    expect(BigInt(captured[0]!.askUnits)).toBeGreaterThan(totalCost);
    // And the simulated minAskUnits — the actual DEX rejection floor —
    // must stay ≥ totalCost, closing the mainnet bug.
    expect(BigInt(sim.minAskUnits)).toBeGreaterThanOrEqual(totalCost);
  });

  it("simulateReverseCrossToTon grosses up each leg by per-leg slippage", async () => {
    // Variant B (route-total slippage): each of the two legs is grossed
    // up by the per-leg budget `1 − √(1 − userSlip)` so the COMPOSED
    // worst-case across the route equals the user's stated slippage.
    //
    // Invariants this test pins:
    //   1. Both leg ask amounts are bumped above their target (so the
    //      simulator's per-leg minAskUnits stays ≥ the target it covers).
    //   2. The TOTAL gross-up factor (offerUnits / fair offer at no
    //      slippage) is ≈ 1/(1 − userSlip) — NOT 1/(1 − userSlip)² as it
    //      was under the old per-leg-as-user-slippage semantics.
    const INTERMEDIATE = "EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTOgVZIxEQI";
    const captured: Array<{
      offerAddress: string;
      askAddress: string;
      askUnits: string;
      slippageTolerance: string;
    }> = [];
    const simulateReverseSwap = vi.fn(async (args: unknown) => {
      const a = args as {
        offerAddress: string;
        askAddress: string;
        askUnits: string;
        slippageTolerance: string;
      };
      captured.push({
        offerAddress: a.offerAddress,
        askAddress: a.askAddress,
        askUnits: a.askUnits,
        slippageTolerance: a.slippageTolerance,
      });
      // Mock simulator honours the slippageTolerance it was passed —
      // mirrors STON.fi behaviour and is the right shape for asserting
      // "leg minAskUnits stays ≥ its per-leg target".
      const SCALE = 1_000_000_000n;
      const slip = Number(a.slippageTolerance);
      const keep = SCALE - BigInt(Math.round(slip * Number(SCALE)));
      const minAskUnits = ((BigInt(a.askUnits) * keep) / SCALE).toString();
      // Stub a simple 1:1 offer/ask ratio for simplicity.
      return buildSimulation({
        offerAddress: a.offerAddress,
        askAddress: a.askAddress,
        offerUnits: a.askUnits,
        askUnits: a.askUnits,
        minAskUnits,
        priceImpact: "0.01",
      });
    });
    const apiClient = makeClient(
      simulateReverseSwap as unknown as StonApiClient["simulateReverseSwap"],
    );
    const rates = createRatesClient({
      apiClient,
      callStonApi: (async <T>(fn: () => Promise<T>) => fn()) as <T>(
        fn: () => Promise<T>,
        method: string,
      ) => Promise<T>,
      rateCacheTtlMs: 5000,
    });

    const totalCost = 350_000_000n;
    const userSlip = 0.05;
    const result = await rates.simulateReverseCrossToTon({
      offerAddress: OFFER,
      intermediate: INTERMEDIATE,
      targetTonUnits: totalCost,
      slippage: userSlip.toString(),
    });

    expect(captured).toHaveLength(2);
    // First call: leg2 (intermediate → TON). Per-leg slippage = 1 − √(1 − userSlip).
    expect(captured[0]!.askAddress).toBe(TON_ADDRESS);
    const expectedPerLeg = 1 - Math.sqrt(1 - userSlip);
    expect(Number(captured[0]!.slippageTolerance)).toBeCloseTo(
      expectedPerLeg,
      9,
    );
    expect(BigInt(captured[0]!.askUnits)).toBeGreaterThan(totalCost);
    // Second call: leg1 (offer → intermediate). Same per-leg slippage,
    // and its askUnits must exceed leg2.offerUnits to cover leg2's
    // slippage envelope.
    expect(captured[1]!.offerAddress).toBe(OFFER);
    expect(Number(captured[1]!.slippageTolerance)).toBeCloseTo(
      expectedPerLeg,
      9,
    );
    expect(BigInt(captured[1]!.askUnits)).toBeGreaterThan(
      BigInt(result.leg2.offerUnits),
    );
    // Per-leg enforcement floors are safe under their own per-leg
    // slippage (mock honours the slippageTolerance arg, so this matches
    // real STON.fi behaviour):
    expect(BigInt(result.leg2.minAskUnits)).toBeGreaterThanOrEqual(totalCost);
    expect(BigInt(result.leg1.minAskUnits)).toBeGreaterThanOrEqual(
      BigInt(result.leg2.offerUnits),
    );
    // Total gross-up regression: with 1:1 mock rates, leg1.offerUnits
    // is the TCAST equivalent the user actually pays for `totalCost`
    // worth of TON delivery. Under Variant B that's totalCost ×
    // 1/(1 − userSlip) ≈ 1.0526× — NOT the old 1.108× from compounding
    // 5% slippage on each leg independently. Allow ±1% wiggle for ceil
    // rounding in two grossUpForSlippage calls.
    const fairOffer = Number(totalCost);
    const actualOffer = Number(BigInt(result.leg1.offerUnits));
    expect(actualOffer / fairOffer).toBeGreaterThan(1 / (1 - userSlip) - 0.01);
    expect(actualOffer / fairOffer).toBeLessThan(1 / (1 - userSlip) + 0.01);
  });

  it("forward and reverse use separate cache slots", async () => {
    const reverseSim = buildSimulation({
      offerAddress: OFFER,
      askAddress: TON_ADDRESS,
      offerUnits: "1200000",
      askUnits: "2000000000",
      minAskUnits: "2000000000",
    });
    const simulateReverseSwap = vi.fn(async () => reverseSim);
    const apiClient = makeClient(
      simulateReverseSwap as unknown as StonApiClient["simulateReverseSwap"],
    );

    const simulateSwap = apiClient.simulateSwap as unknown as ReturnType<
      typeof vi.fn
    >;
    const callStonApi = vi.fn(<T>(fn: () => Promise<T>) => fn());
    const rates = createRatesClient({
      apiClient,
      callStonApi: callStonApi as <T>(
        fn: () => Promise<T>,
        method: string,
      ) => Promise<T>,
      rateCacheTtlMs: 5000,
    });

    await rates.simulateForward({
      offerAddress: OFFER,
      askAddress: TON_ADDRESS,
      offerUnits: "1000000",
    });
    await rates.simulateReverseToTon({
      offerAddress: OFFER,
      targetTonUnits: 2_000_000_000n,
    });

    expect(simulateSwap).toHaveBeenCalledTimes(1);
    expect(simulateReverseSwap).toHaveBeenCalledTimes(1);
  });
});
