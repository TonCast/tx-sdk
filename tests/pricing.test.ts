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
  it("TON: viable, availableForBet = amount − walletReserve − TON_DIRECT_GAS", async () => {
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
    expect(c?.tonEquivalent).toBe(10_000_000_000n);
    expect(availableForBet(c!, 50_000_000n)).toBe(
      10_000_000_000n - 50_000_000n - TON_DIRECT_GAS,
    );
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
    expect(c?.tonEquivalent).toBe(4_950_000_000n);
    // leg2.askUnits is 5 TON (expected); minAskUnits is 4.95 (5% slippage).
    expect(c?.tonEquivalentExpected).toBe(5_000_000_000n);
    expect(c?.gasReserve).toBe(CROSS_HOP_JETTON_GAS_ESTIMATE);
    // availableForBet for jetton = tonEquivalent (no gas subtraction).
    expect(availableForBet(c!, 50_000_000n)).toBe(4_950_000_000n);
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

  it("cross-hop: takes the LARGER of the two leg recommendations (worst leg dominates)", async () => {
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
    leg2.recommendedSlippageTolerance = "0.025"; // wide on leg2 (the dominant)
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
    // Cross-hop picks the larger (riskier) leg recommendation.
    expect(c?.recommendedSlippage).toBe("0.025");
    expect(c?.effectiveSlippage).toBe("0.025");
    // Cross floors compose locally; using effective slippage on leg2's
    // expected output: 5_000_000_000 × 0.975 = 4_875_000_000.
    expect(c?.tonEquivalent).toBe(4_875_000_000n);
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
