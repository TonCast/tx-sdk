import { describe, expect, it, vi } from "vitest";
import {
  CROSS_HOP_JETTON_GAS_ESTIMATE,
  DIRECT_HOP_JETTON_GAS_ESTIMATE,
  TON_ADDRESS,
} from "../src/constants.js";
import { planBetOption } from "../src/planner.js";
import type { RatesClient } from "../src/rates.js";
import type { BetItem, PricedCoin, TxParams } from "../src/types.js";
import {
  buildSimulation,
  createMockApiClient,
} from "./_utils/mockApiClient.js";

const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const PARI = "EQA7bkHU1hRX6LtvkuAASvN0YSX0tk-N9gx5Ji3oDioslLP0";
const BENEFICIARY = "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8";

const bets: BetItem[] = [{ yesOdds: 56, ticketsCount: 100 }];
// totalCost = 0.1 fee + 100 * 0.056 = 5.7 TON
const totalCost = 5_700_000_000n;

type RatesMock = {
  simulateForward: ReturnType<typeof vi.fn>;
  simulateReverseToTon: ReturnType<typeof vi.fn>;
  simulateReverseCrossToTon: ReturnType<typeof vi.fn>;
  clearCache: ReturnType<typeof vi.fn>;
};

function makeRates(
  reverses: Record<string, ReturnType<typeof buildSimulation>> = {},
): RatesMock {
  return {
    simulateForward: vi.fn(),
    simulateReverseToTon: vi.fn(
      async ({ offerAddress }: { offerAddress: string }) => {
        const sim = reverses[offerAddress];
        if (!sim) throw new Error(`no reverse sim for ${offerAddress}`);
        return sim;
      },
    ),
    simulateReverseCrossToTon: vi.fn(async () => {
      throw new Error("makeRates: cross-reverse not seeded");
    }),
    clearCache: vi.fn(),
  };
}

function makeFakeTonClient() {
  const open = vi.fn(() => ({
    getSwapJettonToTonTxParams: vi.fn(async () => ({
      to: { equals: () => true } as unknown,
      value: 600_000_000n,
      body: null,
    })) as () => Promise<TxParams>,
    getSwapJettonToJettonTxParams: vi.fn(async () => ({
      to: { equals: () => true } as unknown,
      value: 900_000_000n,
      body: null,
    })) as () => Promise<TxParams>,
  }));
  return { open } as unknown as import("@ston-fi/sdk").Client;
}

async function identityCaller<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

/** Build a minimal valid PricedCoin for TON. */
function priceTon(amount: bigint): PricedCoin {
  return {
    address: TON_ADDRESS,
    amount,
    tonEquivalent: amount,
    gasReserve: 50_000_000n,
    netTon: amount - 50_000_000n - 50_000_000n,
    route: "direct",
    viable: amount > 100_000_000n,
  };
}

/** Build a minimal valid viable PricedCoin for a jetton with direct route. */
function priceJettonDirect(
  address: string,
  amount: bigint,
  tonEq: bigint,
): PricedCoin {
  return {
    address,
    amount,
    tonEquivalent: tonEq,
    gasReserve: DIRECT_HOP_JETTON_GAS_ESTIMATE,
    netTon: tonEq - DIRECT_HOP_JETTON_GAS_ESTIMATE,
    route: "direct",
    viable: tonEq > DIRECT_HOP_JETTON_GAS_ESTIMATE,
    symbol: "USDT",
    decimals: 6,
  };
}

describe("planBetOption", () => {
  it("TON source: feasible when balance covers totalCost + gas + walletReserve", async () => {
    const apiClient = createMockApiClient();
    const rates = makeRates();
    const pricedCoins = [priceTon(10_000_000_000n)];

    const { option, lockedInRate } = await planBetOption({
      bets,
      totalCost,
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      referral: null,
      referralPct: 0,
      source: TON_ADDRESS,
      pricedCoins,
      walletReserve: 50_000_000n,
      rates: rates as unknown as RatesClient,
      apiClient,
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(true);
    if (option.feasible) {
      expect(option.source).toBe("TON");
      expect(option.txs).toHaveLength(1);
      expect(option.breakdown.gas).toBe(50_000_000n);
    }
    expect(lockedInRate).toBeNull();
  });

  it("TON source: infeasible + shortfall when balance short", async () => {
    const apiClient = createMockApiClient();
    const rates = makeRates();
    const pricedCoins = [priceTon(1_000_000_000n)];

    const { option } = await planBetOption({
      bets,
      totalCost,
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      referral: null,
      referralPct: 0,
      source: TON_ADDRESS,
      pricedCoins,
      walletReserve: 50_000_000n,
      rates: rates as unknown as RatesClient,
      apiClient,
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(false);
    if (!option.feasible) {
      expect(option.reason).toBe("insufficient_balance");
      expect(option.shortfall).toBeGreaterThan(0n);
    }
  });

  it("source not in pricedCoins → source_not_in_priced_coins", async () => {
    const { option } = await planBetOption({
      bets,
      totalCost,
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins: [priceTon(10_000_000_000n)],
      walletReserve: 50_000_000n,
      rates: makeRates() as unknown as RatesClient,
      apiClient: createMockApiClient(),
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(false);
    if (!option.feasible) {
      expect(option.reason).toBe("source_not_in_priced_coins");
    }
  });

  it("non-viable source → source_not_viable", async () => {
    const nonViableUsdt: PricedCoin = {
      address: USDT,
      amount: 100n,
      tonEquivalent: 1000n,
      gasReserve: DIRECT_HOP_JETTON_GAS_ESTIMATE,
      netTon: 0n,
      route: "direct",
      viable: false,
      reason: "swap gas exceeds delivered TON",
    };

    const { option } = await planBetOption({
      bets,
      totalCost,
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins: [nonViableUsdt],
      walletReserve: 50_000_000n,
      rates: makeRates() as unknown as RatesClient,
      apiClient: createMockApiClient(),
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(false);
    if (!option.feasible) {
      expect(option.reason).toBe("source_not_viable");
      expect(option.warnings?.[0]).toContain("swap gas exceeds");
    }
  });

  it("jetton source without tonClient → ton_client_required", async () => {
    const pricedCoins = [
      priceTon(1_000_000_000n),
      priceJettonDirect(USDT, 100_000_000n, 50_000_000_000n),
    ];

    const { option } = await planBetOption({
      bets,
      totalCost,
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins,
      walletReserve: 50_000_000n,
      rates: makeRates() as unknown as RatesClient,
      apiClient: createMockApiClient(),
      callStonApi: identityCaller,
      callTonClient: identityCaller,
      // no tonClient
    });

    expect(option.feasible).toBe(false);
    if (!option.feasible) {
      expect(option.reason).toBe("ton_client_required");
    }
  });

  it("jetton source: TON balance below swap gas → insufficient_ton_for_gas", async () => {
    // TON amount = 0.2 TON, gas needed = 0.3 + 0.05 = 0.35 TON.
    const pricedCoins = [
      priceTon(200_000_000n),
      priceJettonDirect(USDT, 100_000_000n, 50_000_000_000n),
    ];

    const { option } = await planBetOption({
      bets,
      totalCost,
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins,
      walletReserve: 50_000_000n,
      rates: makeRates() as unknown as RatesClient,
      apiClient: createMockApiClient(),
      tonClient: makeFakeTonClient(),
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(false);
    if (!option.feasible) {
      expect(option.reason).toBe("insufficient_ton_for_gas");
      expect(option.shortfall).toBeGreaterThan(0n);
    }
  });

  it("jetton source: netTon < totalCost → insufficient_balance (early exit)", async () => {
    // Jetton delivers 1 TON, bet needs 5.7 — must fail without calling reverse-sim.
    const pricedCoins = [
      priceTon(2_000_000_000n),
      priceJettonDirect(USDT, 1_000_000n, 1_000_000_000n),
    ];
    const rates = makeRates();

    const { option } = await planBetOption({
      bets,
      totalCost,
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins,
      walletReserve: 50_000_000n,
      rates: rates as unknown as RatesClient,
      apiClient: createMockApiClient(),
      tonClient: makeFakeTonClient(),
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(false);
    if (!option.feasible) {
      expect(option.reason).toBe("insufficient_balance");
    }
    // Reverse-sim must not be called in this early-exit path.
    expect(rates.simulateReverseToTon).not.toHaveBeenCalled();
  });

  it("jetton source: feasible flow locks in rate", async () => {
    const reverse = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "5700000",
      askUnits: totalCost.toString(),
      minAskUnits: totalCost.toString(),
      priceImpact: "0.01",
    });
    const rates = makeRates({ [USDT]: reverse });
    const pricedCoins = [
      priceTon(1_000_000_000n),
      priceJettonDirect(USDT, 100_000_000n, 50_000_000_000n),
    ];

    const { option, lockedInRate } = await planBetOption({
      bets,
      totalCost,
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins,
      walletReserve: 50_000_000n,
      rates: rates as unknown as RatesClient,
      apiClient: createMockApiClient(),
      tonClient: makeFakeTonClient(),
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(true);
    if (option.feasible) {
      expect(option.breakdown.gas).toBe(DIRECT_HOP_JETTON_GAS_ESTIMATE);
      expect(option.route).toBe("direct");
    }
    expect(lockedInRate).not.toBeNull();
    if (lockedInRate) {
      expect(lockedInRate.source).toBe(USDT);
      expect(lockedInRate.offerUnits).toBe(5_700_000n);
      expect(lockedInRate.targetTonUnits).toBe(totalCost);
      expect(lockedInRate.priceImpact).toBe(0.01);
    }
  });

  it("jetton source: cross-hop route, feasible, reverseCross called", async () => {
    const COMMUNITY = "EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA";
    const leg1 = buildSimulation({
      offerAddress: COMMUNITY,
      askAddress: USDT,
      offerUnits: "50000000",
      askUnits: "6000000",
      minAskUnits: "6000000",
      priceImpact: "0.01",
    });
    const leg2 = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "6000000",
      askUnits: totalCost.toString(),
      minAskUnits: totalCost.toString(),
      priceImpact: "0.01",
    });
    const rates: RatesMock = {
      simulateForward: vi.fn(),
      simulateReverseToTon: vi.fn(),
      simulateReverseCrossToTon: vi.fn(async () => ({ leg1, leg2 })),
      clearCache: vi.fn(),
    };
    const pricedCoins: PricedCoin[] = [
      priceTon(1_000_000_000n),
      {
        address: COMMUNITY,
        amount: 100_000_000n,
        tonEquivalent: 8_000_000_000n,
        gasReserve: CROSS_HOP_JETTON_GAS_ESTIMATE,
        netTon: 8_000_000_000n - CROSS_HOP_JETTON_GAS_ESTIMATE,
        route: { intermediate: USDT },
        viable: true,
      },
    ];

    const { option, lockedInRate } = await planBetOption({
      bets,
      totalCost,
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      referral: null,
      referralPct: 0,
      source: COMMUNITY,
      pricedCoins,
      walletReserve: 50_000_000n,
      rates: rates as unknown as RatesClient,
      apiClient: createMockApiClient(),
      tonClient: makeFakeTonClient(),
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(true);
    if (option.feasible) {
      expect(option.breakdown.gas).toBe(CROSS_HOP_JETTON_GAS_ESTIMATE);
      expect(option.route).toEqual({ intermediate: USDT });
    }
    expect(rates.simulateReverseCrossToTon).toHaveBeenCalledTimes(1);
    expect(lockedInRate?.route.type).toBe("cross");
  });

  it("jetton source: reverse-sim throws → no_route infeasible", async () => {
    const rates: RatesMock = {
      simulateForward: vi.fn(),
      simulateReverseToTon: vi.fn(async () => {
        throw new Error("API down");
      }),
      simulateReverseCrossToTon: vi.fn(),
      clearCache: vi.fn(),
    };
    const pricedCoins = [
      priceTon(1_000_000_000n),
      priceJettonDirect(USDT, 100_000_000n, 50_000_000_000n),
    ];

    const { option } = await planBetOption({
      bets,
      totalCost,
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins,
      walletReserve: 50_000_000n,
      rates: rates as unknown as RatesClient,
      apiClient: createMockApiClient(),
      tonClient: makeFakeTonClient(),
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(false);
    if (!option.feasible) {
      expect(option.reason).toBe("no_route");
      expect(option.warnings?.[0]).toContain("API down");
    }
  });

  it("jetton source: slippage exceeds limit → slippage_exceeds_limit", async () => {
    const reverse = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "5700000",
      askUnits: totalCost.toString(),
      minAskUnits: totalCost.toString(),
      priceImpact: "0.2", // 20% > 5% limit
    });
    const rates = makeRates({ [USDT]: reverse });
    const pricedCoins = [
      priceTon(1_000_000_000n),
      priceJettonDirect(USDT, 100_000_000n, 50_000_000_000n),
    ];

    const { option } = await planBetOption({
      bets,
      totalCost,
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins,
      walletReserve: 50_000_000n,
      slippage: "0.05",
      rates: rates as unknown as RatesClient,
      apiClient: createMockApiClient(),
      tonClient: makeFakeTonClient(),
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(false);
    if (!option.feasible) {
      expect(option.reason).toBe("slippage_exceeds_limit");
    }
  });

  // NB: the "mainnet refund" scenario (minAskUnits < totalCost) is now
  // prevented at the `rates.ts` layer via `grossUpForSlippage` rather
  // than re-checked in the planner. See tests/rates.test.ts for the
  // unit coverage of that invariant.

  it("source matches pricedCoins entry across address formats (EQ vs UQ)", async () => {
    // Regression: planner used strict string equality to look up `source`
    // inside `pricedCoins`. If the caller priced with one textual form
    // (say bounceable EQ…) and passed the source in another (UQ…, or the
    // raw `0:…` form), the search silently returned undefined and the
    // planner reported `source_not_in_priced_coins` despite the coin
    // being present. Now compared via `Address.equals`.
    const { Address: _Addr } = await import("@ton/ton");
    const pricedCoins = [priceTon(10_000_000_000n)];
    const tonAsRaw = _Addr.parse(TON_ADDRESS).toRawString();

    const { option } = await planBetOption({
      bets,
      totalCost,
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      referral: null,
      referralPct: 0,
      source: tonAsRaw,
      pricedCoins,
      walletReserve: 50_000_000n,
      rates: makeRates() as unknown as RatesClient,
      apiClient: createMockApiClient(),
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(true);
    if (option.feasible) expect(option.source).toBe("TON");
  });
});
