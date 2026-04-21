import { describe, expect, it, vi } from "vitest";
import {
  CROSS_HOP_JETTON_GAS_ESTIMATE,
  DIRECT_HOP_JETTON_GAS_ESTIMATE,
  TON_ADDRESS,
  TON_DIRECT_GAS,
} from "../src/constants.js";
import { priceCoins } from "../src/pricing.js";
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
  it("TON: viable, netTon = amount − walletReserve − TON_DIRECT_GAS", async () => {
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
    expect(c?.netTon).toBe(10_000_000_000n - 50_000_000n - TON_DIRECT_GAS);
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
    expect(priced[0]?.netTon).toBe(0n);
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

  it("jetton with direct route: viable, netTon = tonEquivalent − direct gas", async () => {
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
    expect(c?.gasReserve).toBe(DIRECT_HOP_JETTON_GAS_ESTIMATE);
    expect(c?.netTon).toBe(49_500_000_000n - DIRECT_HOP_JETTON_GAS_ESTIMATE);
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
    expect(c?.gasReserve).toBe(CROSS_HOP_JETTON_GAS_ESTIMATE);
    expect(c?.netTon).toBe(4_950_000_000n - CROSS_HOP_JETTON_GAS_ESTIMATE);
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
    expect(priced[0]?.netTon).toBe(0n);
    expect(priced[0]?.reason).toMatch(/swap delivers/);
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
