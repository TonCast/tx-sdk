import type { StonApiClient } from "@ston-fi/api";
import { describe, expect, it, vi } from "vitest";
import {
  CROSS_HOP_JETTON_GAS_ESTIMATE,
  DIRECT_HOP_JETTON_GAS_ESTIMATE,
  TON_ADDRESS,
  TON_DIRECT_GAS,
} from "../src/constants.js";
import { availableForBet, priceCoins } from "../src/pricing.js";
import {
  buildSimulation,
  createMockApiClient,
} from "./_utils/mockApiClient.js";

const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const COMMUNITY = "EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA";

async function identityCaller<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

describe("priceCoins", () => {
  it("TON: viable, tonEquivalent === availableForBet (= amount − walletReserve − TON_DIRECT_GAS)", async () => {
    const apiClient = createMockApiClient();
    const priced = await priceCoins({
      availableCoins: [{ address: TON_ADDRESS, amount: 10_000_000_000n }],
      walletReserve: 50_000_000n,
      apiClient,
      callStonApi: identityCaller,
    });
    expect(priced).toHaveLength(1);
    const c = priced[0];
    expect(c?.viable).toBe(true);
    expect(c?.route).toBe("direct");
    expect(c?.gasReserve).toBe(TON_DIRECT_GAS);
    // tonEquivalent for TON is now the spendable amount, not the raw
    // balance. The raw balance lives on `coin.amount`.
    const usable = 10_000_000_000n - 50_000_000n - TON_DIRECT_GAS;
    expect(c?.tonEquivalent).toBe(usable);
    expect(c?.tonEquivalentExpected).toBe(usable);
    expect(c?.amount).toBe(10_000_000_000n);
    expect(availableForBet(c!, 50_000_000n)).toBe(usable);
  });

  it("TON: tiny balance → non-viable with human-readable reason", async () => {
    const apiClient = createMockApiClient();
    const priced = await priceCoins({
      availableCoins: [{ address: TON_ADDRESS, amount: 10_000_000n }],
      walletReserve: 50_000_000n,
      apiClient,
      callStonApi: identityCaller,
    });
    expect(priced[0]?.viable).toBe(false);
    expect(availableForBet(priced[0]!, 50_000_000n)).toBe(0n);
    expect(priced[0]?.reason).toMatch(/no room left/);
  });

  it("jetton without tonClient → non-viable", async () => {
    const apiClient = createMockApiClient();
    const priced = await priceCoins({
      availableCoins: [{ address: USDT, amount: 100_000_000n }],
      apiClient,
      callStonApi: identityCaller,
    });
    expect(priced[0]?.viable).toBe(false);
    expect(priced[0]?.route).toBeNull();
    expect(priced[0]?.reason).toMatch(/tonClient is required/);
  });

  it("jetton with direct route: viable, availableForBet = tonEquivalent", async () => {
    const sim = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "100000000",
      askUnits: "50000000000",
      minAskUnits: "49500000000", // 49.5 TON after slippage
      priceImpact: "0.01",
    });
    const apiClient = createMockApiClient({
      simulations: { [`${USDT}→${TON_ADDRESS}`]: sim },
      pairs: [[USDT, TON_ADDRESS]],
    });
    const tonClient = {
      open: vi.fn(),
    } as unknown as import("@ston-fi/sdk").Client;

    const priced = await priceCoins({
      availableCoins: [
        { address: USDT, amount: 100_000_000n, symbol: "USDT", decimals: 6 },
      ],
      apiClient,
      tonClient,
      callStonApi: identityCaller,
    });
    const c = priced[0];
    expect(c?.viable).toBe(true);
    expect(c?.tonEquivalent).toBe(49_500_000_000n);
    // askUnits (expected, no slippage) is 50 TON; minAskUnits is 49.5 TON.
    expect(c?.tonEquivalentExpected).toBe(50_000_000_000n);
    expect(c?.gasReserve).toBe(DIRECT_HOP_JETTON_GAS_ESTIMATE);
    // availableForBet for jetton equals `tonEquivalent` — swap gas is
    // billed separately from the TON wallet, NOT from the jetton.
    expect(availableForBet(c!, 50_000_000n)).toBe(49_500_000_000n);
    expect(c?.route).toBe("direct");
    expect(c?.symbol).toBe("USDT");
    expect(c?.decimals).toBe(6);
  });

  it("jetton with cross-hop route: uses CROSS_HOP gas reserve", async () => {
    const leg1 = buildSimulation({
      offerAddress: COMMUNITY,
      askAddress: USDT,
      offerUnits: "100000000",
      askUnits: "5000000",
      minAskUnits: "4950000",
      priceImpact: "0.01",
    });
    const leg2 = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "5000000",
      askUnits: "5000000000",
      minAskUnits: "4950000000", // 4.95 TON delivered
      priceImpact: "0.01",
    });
    const apiClient = createMockApiClient({
      simulations: {
        [`${COMMUNITY}→${USDT}`]: leg1,
        [`${USDT}→${TON_ADDRESS}`]: leg2,
      },
      pairs: [
        [COMMUNITY, USDT],
        [USDT, TON_ADDRESS],
      ],
      pools: { [`${COMMUNITY}↔${USDT}`]: [{ lpTotalSupplyUsd: "1000000" }] },
    });
    const tonClient = {
      open: vi.fn(),
    } as unknown as import("@ston-fi/sdk").Client;

    const priced = await priceCoins({
      availableCoins: [{ address: COMMUNITY, amount: 100_000_000n }],
      apiClient,
      tonClient,
      callStonApi: identityCaller,
    });
    const c = priced[0];
    expect(c?.viable).toBe(true);
    // leg2.askUnits is 5 TON (expected). Both legs in the mock carry
    // `recommendedSlippageTolerance: "0.01"` (default in buildSimulation),
    // so the route-total recommendation composes to
    // `1 − (1 − 0.01)(1 − 0.01) = 0.0199` and effectiveSlippage is
    // clamped to that (tighter than the user's 5% default). tonEquivalent
    // is then `5 TON × (1 − 0.0199) = 4.9005 TON` — recomputed locally
    // for cross-hop instead of trusting the simulator's per-leg
    // `minAskUnits` (which is sized for the per-leg slippage scale).
    expect(c?.tonEquivalent).toBe(4_900_500_000n);
    expect(c?.tonEquivalentExpected).toBe(5_000_000_000n);
    expect(c?.gasReserve).toBe(CROSS_HOP_JETTON_GAS_ESTIMATE);
    // availableForBet for jetton = tonEquivalent (no gas subtraction).
    expect(availableForBet(c!, 50_000_000n)).toBe(4_900_500_000n);
    expect(c?.route).toEqual({ intermediate: USDT });
  });

  it("jetton swap gas exceeds delivered TON → non-viable", async () => {
    // minAskUnits = 0.1 TON, direct gas = 0.3 TON → net = -0.2 → filter out.
    const sim = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "100000000",
      askUnits: "100000000",
      minAskUnits: "100000000", // 0.1 TON
      priceImpact: "0.01",
    });
    const apiClient = createMockApiClient({
      simulations: { [`${USDT}→${TON_ADDRESS}`]: sim },
      pairs: [[USDT, TON_ADDRESS]],
    });
    const tonClient = {
      open: vi.fn(),
    } as unknown as import("@ston-fi/sdk").Client;

    const priced = await priceCoins({
      availableCoins: [{ address: USDT, amount: 100_000_000n }],
      apiClient,
      tonClient,
      callStonApi: identityCaller,
    });
    expect(priced[0]?.viable).toBe(false);
    expect(availableForBet(priced[0]!, 50_000_000n)).toBe(0n);
    expect(priced[0]?.reason).toMatch(/swap delivers/);
  });

  it("STON.fi recommendation < user slippage → effective uses recommendation, tonEquivalent rises", async () => {
    // User asks for 5% max; STON.fi recommends 0.5%. Effective = 0.5%.
    // tonEquivalent should be askUnits × 0.995, not × 0.95 — the user
    // gets a TIGHTER floor and the planner's offerUnits estimate
    // shrinks correspondingly.
    const sim = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "100000000",
      askUnits: "50000000000", // 50 TON expected
      minAskUnits: "47500000000", // 47.5 TON at 5% (user's input)
      priceImpact: "0.001",
    });
    // STON.fi-recommended slippage 0.005 + matching floor.
    // The mock builder takes only top-level overrides; patch fields
    // here for clarity.
    sim.recommendedSlippageTolerance = "0.005";
    sim.recommendedMinAskUnits = "49750000000"; // 50 TON × 0.995

    const apiClient = createMockApiClient({
      simulations: { [`${USDT}→${TON_ADDRESS}`]: sim },
      pairs: [[USDT, TON_ADDRESS]],
    });
    const tonClient = {
      open: vi.fn(),
    } as unknown as import("@ston-fi/sdk").Client;

    const priced = await priceCoins({
      availableCoins: [{ address: USDT, amount: 100_000_000n }],
      slippage: "0.05",
      apiClient,
      tonClient,
      callStonApi: identityCaller,
    });
    const c = priced[0];
    expect(c?.recommendedSlippage).toBe("0.005");
    expect(c?.recommendedMinAskUnits).toBe(49_750_000_000n);
    expect(c?.effectiveSlippage).toBe("0.005");
    expect(c?.tonEquivalent).toBe(49_750_000_000n);
    expect(c?.tonEquivalentExpected).toBe(50_000_000_000n);
  });

  it("STON.fi recommendation > user slippage → capped at user max", async () => {
    // User says max 1%; STON.fi recommends 4% for this thin pool.
    // Effective is clamped to 1% — user-set ceiling wins. Pool may
    // revert at the user's tighter floor; that's the user's choice.
    const sim = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "100000000",
      askUnits: "50000000000",
      minAskUnits: "49500000000", // 1% per user request
      priceImpact: "0.03",
    });
    sim.recommendedSlippageTolerance = "0.04";
    sim.recommendedMinAskUnits = "48000000000"; // 50 TON × 0.96 (4%)

    const apiClient = createMockApiClient({
      simulations: { [`${USDT}→${TON_ADDRESS}`]: sim },
      pairs: [[USDT, TON_ADDRESS]],
    });
    const tonClient = {
      open: vi.fn(),
    } as unknown as import("@ston-fi/sdk").Client;

    const priced = await priceCoins({
      availableCoins: [{ address: USDT, amount: 100_000_000n }],
      slippage: "0.01", // user's max
      apiClient,
      tonClient,
      callStonApi: identityCaller,
    });
    const c = priced[0];
    expect(c?.recommendedSlippage).toBe("0.04");
    expect(c?.effectiveSlippage).toBe("0.01");
    // tonEquivalent at user's tighter slippage, NOT at 4%.
    expect(c?.tonEquivalent).toBe(49_500_000_000n);
  });

  it("STON.fi returns 0 / missing recommendation → falls back to user slippage", async () => {
    const sim = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "100000000",
      askUnits: "50000000000",
      minAskUnits: "47500000000",
      priceImpact: "0.001",
    });
    // STON.fi returned a junk recommendation — must be ignored.
    sim.recommendedSlippageTolerance = "0";

    const apiClient = createMockApiClient({
      simulations: { [`${USDT}→${TON_ADDRESS}`]: sim },
      pairs: [[USDT, TON_ADDRESS]],
    });
    const tonClient = {
      open: vi.fn(),
    } as unknown as import("@ston-fi/sdk").Client;

    const priced = await priceCoins({
      availableCoins: [{ address: USDT, amount: 100_000_000n }],
      slippage: "0.05",
      apiClient,
      tonClient,
      callStonApi: identityCaller,
    });
    const c = priced[0];
    expect(c?.recommendedSlippage).toBeUndefined();
    expect(c?.effectiveSlippage).toBe("0.05");
    // Floor at user slippage 5% → askUnits × 0.95.
    expect(c?.tonEquivalent).toBe(47_500_000_000n);
  });

  it("cross-hop: composes per-leg recommendations into route-total slippage", async () => {
    const leg1 = buildSimulation({
      offerAddress: COMMUNITY,
      askAddress: USDT,
      offerUnits: "100000000",
      askUnits: "5000000",
      minAskUnits: "4750000",
      priceImpact: "0.005",
    });
    leg1.recommendedSlippageTolerance = "0.005"; // tight on leg1
    leg1.recommendedMinAskUnits = "4975000";
    const leg2 = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "5000000",
      askUnits: "5000000000",
      minAskUnits: "4750000000",
      priceImpact: "0.025",
    });
    leg2.recommendedSlippageTolerance = "0.025"; // wider on leg2
    leg2.recommendedMinAskUnits = "4875000000";

    const apiClient = createMockApiClient({
      simulations: {
        [`${COMMUNITY}→${USDT}`]: leg1,
        [`${USDT}→${TON_ADDRESS}`]: leg2,
      },
      pairs: [
        [COMMUNITY, USDT],
        [USDT, TON_ADDRESS],
      ],
      pools: { [`${COMMUNITY}↔${USDT}`]: [{ lpTotalSupplyUsd: "1000000" }] },
    });
    const tonClient = {
      open: vi.fn(),
    } as unknown as import("@ston-fi/sdk").Client;

    const priced = await priceCoins({
      availableCoins: [{ address: COMMUNITY, amount: 100_000_000n }],
      slippage: "0.05",
      apiClient,
      tonClient,
      callStonApi: identityCaller,
    });
    const c = priced[0];
    // Cross-hop COMPOSES per-pool recommendations into a route-total
    // slippage: `1 − (1 − 0.005)(1 − 0.025) = 0.029875`. That is the
    // route-total budget needed to honour BOTH per-pool recommendations
    // after the SDK splits it back into per-leg via perLegSlippage.
    expect(c?.recommendedSlippage).toBe("0.029875");
    // User's 5% is wider than the recommended composite — recommendation
    // wins (tighter ceiling).
    expect(c?.effectiveSlippage).toBe("0.029875");
    // tonEquivalent = leg2.askUnits × (1 − route-total) =
    //   5_000_000_000 × 0.970125 = 4_850_625_000.
    expect(c?.tonEquivalent).toBe(4_850_625_000n);
    // recommendedMinAskUnits exposed on PricedCoin is recomputed for
    // cross-hop from the route-total recommendation (NOT taken from
    // the simulator's per-leg `recommendedMinAskUnits`, which would be
    // sized at the wrong slippage scale). Same formula as tonEquivalent
    // when effective ≡ recommended.
    expect(c?.recommendedMinAskUnits).toBe(4_850_625_000n);
  });

  it("regression: cross-hop linear estimate matches confirmQuote offerUnits within ~1%", async () => {
    // Reproduces the mainnet bug: cross-hop swaps used to gross up
    // 1/(1 − slip) per leg, so the planner's linear estimate (single
    // slippage applied via tonEquivalent) was ~5 % below what
    // `simulateReverseCrossToTon` then asked for at sign time.
    //
    // Variant B fix: per-leg slippage = `1 − √(1 − userSlip)` so the
    // composed gross-up across the route equals 1/(1 − userSlip),
    // i.e. matches the linear estimate. This test would have shown a
    // ~5 % discrepancy under the old behaviour; we assert it now sits
    // inside ±1 % (rounding from two `grossUpForSlippage` ceil ops).
    const COMMUNITY_LOCAL = "EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTOgVZIxEQI";
    const SCALE = 1_000_000_000n;

    function honourSlippage(askUnits: string, slip: string): string {
      const keep = SCALE - BigInt(Math.round(Number(slip) * Number(SCALE)));
      return ((BigInt(askUnits) * keep) / SCALE).toString();
    }

    // Forward sim: 100M jetton → 5M USDT → 5_000M TON (5 TON expected).
    // Same shape STON.fi would return — minAskUnits scales with the
    // slippageTolerance the simulator was passed, so the test mock
    // mirrors real per-leg behaviour instead of hardcoding 5 %.
    const baseRate = 100_000_000n; // 100M jetton balance
    const usdtFromJetton = 5_000_000n; // leg1 ask
    const tonFromUsdt = 5_000_000_000n; // leg2 ask = 5 TON expected

    const apiClient = createMockApiClient({
      pairs: [
        [COMMUNITY_LOCAL, USDT],
        [USDT, TON_ADDRESS],
      ],
      pools: {
        [`${COMMUNITY_LOCAL}↔${USDT}`]: [{ lpTotalSupplyUsd: "1000000" }],
      },
    });
    // Override forward simulateSwap to honour slippageTolerance from the
    // call (so leg.minAskUnits reflects per-leg slippage correctly).
    (
      apiClient as unknown as { simulateSwap: typeof apiClient.simulateSwap }
    ).simulateSwap = vi.fn(async (args: unknown) => {
      const a = args as {
        offerAddress: string;
        askAddress: string;
        offerUnits: string;
        slippageTolerance: string;
      };
      let askUnits: string;
      if (a.offerAddress === COMMUNITY_LOCAL && a.askAddress === USDT) {
        askUnits = (
          (BigInt(a.offerUnits) * usdtFromJetton) /
          baseRate
        ).toString();
      } else if (a.offerAddress === USDT && a.askAddress === TON_ADDRESS) {
        askUnits = (
          (BigInt(a.offerUnits) * tonFromUsdt) /
          usdtFromJetton
        ).toString();
      } else {
        throw new Error(
          `unexpected forward sim call: ${a.offerAddress} → ${a.askAddress}`,
        );
      }
      return buildSimulation({
        offerAddress: a.offerAddress,
        askAddress: a.askAddress,
        offerUnits: a.offerUnits,
        askUnits,
        minAskUnits: honourSlippage(askUnits, a.slippageTolerance),
        priceImpact: "0.001",
      });
    }) as unknown as typeof apiClient.simulateSwap;

    const tonClient = {
      open: vi.fn(),
    } as unknown as import("@ston-fi/sdk").Client;

    const userSlip = "0.05";
    const priced = await priceCoins({
      availableCoins: [{ address: COMMUNITY_LOCAL, amount: baseRate }],
      slippage: userSlip,
      apiClient,
      tonClient,
      callStonApi: identityCaller,
    });
    const c = priced[0];
    expect(c?.viable).toBe(true);
    expect(c?.route).toEqual({ intermediate: USDT });

    // Simulate "user picks 95 % of tonEquivalent as their bet" — the
    // linear estimate the planner would emit. Under the old behaviour
    // tonEquivalent was 5 TON × 0.95 = 4.75 TON; under Variant B with
    // the default mock recommendation (1 % per leg → composed 0.0199),
    // tonEquivalent settles tighter — but the property we care about
    // is the LINEAR-ESTIMATE-vs-CONFIRM ratio, computed below, which
    // is independent of effectiveSlippage's exact value.
    const totalCost = (c!.tonEquivalent * 90n) / 100n;
    const linearEstimate =
      (c!.amount * totalCost + c!.tonEquivalent - 1n) / c!.tonEquivalent; // ceilDiv mirroring planner.ts

    // Now run the actual reverse simulation that confirmQuote would do.
    const captured: Array<{ slippageTolerance: string; askUnits: string }> = [];
    (
      apiClient as unknown as {
        simulateReverseSwap: StonApiClient["simulateReverseSwap"];
      }
    ).simulateReverseSwap = vi.fn(async (args: unknown) => {
      const a = args as {
        offerAddress: string;
        askAddress: string;
        askUnits: string;
        slippageTolerance: string;
      };
      captured.push({
        askUnits: a.askUnits,
        slippageTolerance: a.slippageTolerance,
      });
      // Same pool rate as forward — mock acts like a frictionless AMM.
      let offerUnits: string;
      if (a.offerAddress === USDT && a.askAddress === TON_ADDRESS) {
        offerUnits = (
          (BigInt(a.askUnits) * usdtFromJetton) /
          tonFromUsdt
        ).toString();
      } else if (a.offerAddress === COMMUNITY_LOCAL && a.askAddress === USDT) {
        offerUnits = (
          (BigInt(a.askUnits) * baseRate) /
          usdtFromJetton
        ).toString();
      } else {
        throw new Error(
          `unexpected reverse sim call: ${a.offerAddress} → ${a.askAddress}`,
        );
      }
      return buildSimulation({
        offerAddress: a.offerAddress,
        askAddress: a.askAddress,
        offerUnits,
        askUnits: a.askUnits,
        minAskUnits: honourSlippage(a.askUnits, a.slippageTolerance),
        priceImpact: "0.001",
      });
    }) as unknown as StonApiClient["simulateReverseSwap"];

    // Wire the same rates client confirmQuote uses.
    const { createRatesClient } = await import("../src/rates.js");
    const rates = createRatesClient({
      apiClient,
      callStonApi: identityCaller as <T>(
        fn: () => Promise<T>,
        method: string,
      ) => Promise<T>,
      rateCacheTtlMs: 5000,
    });
    const cross = await rates.simulateReverseCrossToTon({
      offerAddress: COMMUNITY_LOCAL,
      intermediate: USDT,
      targetTonUnits: totalCost,
      slippage: c!.effectiveSlippage ?? userSlip,
    });
    const confirmOfferUnits = BigInt(cross.leg1.offerUnits);

    // The fix: linear estimate ≈ confirm amount within ±1 %. Under the
    // old per-leg-as-user-slippage code this ratio was ~1.05.
    const ratio = Number(confirmOfferUnits) / Number(linearEstimate);
    expect(ratio).toBeGreaterThan(0.99);
    expect(ratio).toBeLessThan(1.01);
  });

  it("jetton with no route → non-viable with route: null", async () => {
    const apiClient = createMockApiClient({ pairs: [] });
    const tonClient = {
      open: vi.fn(),
    } as unknown as import("@ston-fi/sdk").Client;

    const priced = await priceCoins({
      availableCoins: [{ address: COMMUNITY, amount: 100_000_000n }],
      apiClient,
      tonClient,
      callStonApi: identityCaller,
    });
    expect(priced[0]?.viable).toBe(false);
    expect(priced[0]?.route).toBeNull();
    expect(priced[0]?.reason).toBeDefined();
  });
});
