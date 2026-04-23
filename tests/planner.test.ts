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
  type buildSimulation,
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
    tonEquivalentExpected: amount,
    // TON_DIRECT_GAS = 0n by default: see src/constants.ts.
    gasReserve: 0n,
    route: "direct",
    // Viable when balance > walletReserve (50_000_000n in tests).
    viable: amount > 50_000_000n,
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
    // Expected = minAskUnits / (1 − slippage); approximate as tonEq / 0.95.
    tonEquivalentExpected: (tonEq * 100n) / 95n,
    gasReserve: DIRECT_HOP_JETTON_GAS_ESTIMATE,
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
      // TON_DIRECT_GAS = 0n by default — `value` collapses to totalCost.
      expect(option.breakdown.gas).toBe(0n);
      expect(option.breakdown.spend).toBe(totalCost);
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
      tonEquivalentExpected: 1053n,
      gasReserve: DIRECT_HOP_JETTON_GAS_ESTIMATE,
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

  it("jetton source: capacity < totalCost → insufficient_balance (early exit)", async () => {
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

  it("jetton source: feasible flow returns ESTIMATED quote with linear offerUnits and empty txs", async () => {
    // Post-0.2.0 behaviour: `planBetOption` does NOT reverse-simulate
    // for jetton sources. It produces a linear-extrapolation estimate
    // based on `pricedCoin.amount / pricedCoin.tonEquivalent` and sets
    // `option.estimated = true, option.txs = []`. The real tx is built
    // later by `sdk.confirmQuote(...)`.
    const rates = makeRates(); // no simulations seeded — none should be called
    // pricedCoin says: 100M USDT → 50B TON. Linear extrapolation for
    // totalCost=5.7 TON: offerUnits = ceil(100M × 5.7e9 / 50e9) = ceil(11_400_000) = 11_400_000.
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
      expect(option.estimated).toBe(true);
      expect(option.txs).toEqual([]); // cannot sign until confirmQuote runs
      expect(option.breakdown.gas).toBe(DIRECT_HOP_JETTON_GAS_ESTIMATE);
      expect(option.route).toBe("direct");
      // Linear: (amount × totalCost) / tonEquivalent, rounded up.
      const expected =
        (100_000_000n * totalCost + 50_000_000_000n - 1n) / 50_000_000_000n;
      expect(option.breakdown.spend).toBe(expected);
    }
    expect(lockedInRate).not.toBeNull();
    if (lockedInRate) {
      expect(lockedInRate.source).toBe(USDT);
      expect(lockedInRate.targetTonUnits).toBe(totalCost);
      expect(lockedInRate.route.type).toBe("direct");
    }

    // Critical: planBetOption must NOT hit STON.fi at all for jetton quotes.
    expect(rates.simulateReverseToTon).not.toHaveBeenCalled();
    expect(rates.simulateReverseCrossToTon).not.toHaveBeenCalled();
  });

  it("jetton source: cross-hop route, still estimated, no reverse-sim called", async () => {
    const COMMUNITY = "EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA";
    const rates: RatesMock = {
      simulateForward: vi.fn(),
      simulateReverseToTon: vi.fn(),
      simulateReverseCrossToTon: vi.fn(),
      clearCache: vi.fn(),
    };
    const pricedCoins: PricedCoin[] = [
      priceTon(1_000_000_000n),
      {
        address: COMMUNITY,
        amount: 100_000_000n,
        tonEquivalent: 8_000_000_000n,
        tonEquivalentExpected: 8_421_052_631n, // 8e9 / 0.95 ≈ 8.42e9
        gasReserve: CROSS_HOP_JETTON_GAS_ESTIMATE,
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
      expect(option.estimated).toBe(true);
      expect(option.txs).toEqual([]);
      expect(option.breakdown.gas).toBe(CROSS_HOP_JETTON_GAS_ESTIMATE);
      expect(option.route).toEqual({ intermediate: USDT });
    }
    // Confirmed: no reverse-sim on any path.
    expect(rates.simulateReverseToTon).not.toHaveBeenCalled();
    expect(rates.simulateReverseCrossToTon).not.toHaveBeenCalled();
    expect(lockedInRate?.route.type).toBe("cross");
  });

  // NB: slippage / network-error scenarios for jettons now live in
  // `confirmQuote` tests (sdk.test.ts), because those only manifest
  // during the fresh reverse-sim performed immediately before signing.
  // The planner no longer talks to STON.fi for jetton sources at all.

  it("TON source + allowInsufficientBalance: feasible preview with warnings + shortfall", async () => {
    // Preview mode: let the quote through even though balance is far
    // below tonNeeded. TonConnect wallet compares `value` to balance
    // before signing and refuses — no gas is burned. UI can render
    // cost info + disabled button with shortfall.
    const apiClient = createMockApiClient();
    const rates = makeRates();
    const pricedCoins = [priceTon(1_000_000_000n)]; // 1 TON vs 5.7 TON bet

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
      allowInsufficientBalance: true,
      rates: rates as unknown as RatesClient,
      apiClient,
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(true);
    if (option.feasible) {
      // Tx is still built at full value — wallet will refuse to sign.
      expect(option.txs).toHaveLength(1);
      expect(option.estimated).toBe(false);
      expect(option.shortfall).toBeGreaterThan(0n);
      expect(option.warnings?.[0]).toContain("insufficient_balance");
    }
    // TON source never carries a locked-in rate (no swap).
    expect(lockedInRate).toBeNull();
  });

  it("jetton source + allowInsufficientBalance (gas short): feasible preview with shortfall", async () => {
    // 0.2 TON on wallet but direct-hop needs 0.3 + walletReserve. With
    // the flag, planner returns a feasible ESTIMATED quote carrying
    // the shortfall — confirmQuote will build the real tx whose
    // `value` exceeds the TON balance, and the wallet refuses to sign.
    const pricedCoins = [
      priceTon(200_000_000n),
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
      allowInsufficientBalance: true,
      rates: makeRates() as unknown as RatesClient,
      apiClient: createMockApiClient(),
      tonClient: makeFakeTonClient(),
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(true);
    if (option.feasible) {
      expect(option.estimated).toBe(true);
      expect(option.txs).toEqual([]);
      expect(option.shortfall).toBeGreaterThan(0n);
      expect(option.warnings?.[0]).toContain("insufficient_ton_for_gas");
    }
    // Locked rate is still produced so confirmQuote can finalise.
    expect(lockedInRate).not.toBeNull();
  });

  it("jetton source + allowInsufficientBalance DOES relax insufficient JETTON balance (with explicit gas-burn warning)", async () => {
    // Jetton delivers only 1 TON, bet needs 5.7 TON. With the flag,
    // planner emits a feasible ESTIMATED quote so the UI can still
    // render cost / odds. Warning explicitly flags that this is NOT
    // wallet-caught — the tx WILL broadcast and burn gas. UI decides
    // whether to confirm + send anyway.
    const pricedCoins = [
      priceTon(2_000_000_000n),
      priceJettonDirect(USDT, 1_000_000n, 1_000_000_000n),
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
      allowInsufficientBalance: true,
      rates: makeRates() as unknown as RatesClient,
      apiClient: createMockApiClient(),
      tonClient: makeFakeTonClient(),
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(true);
    if (option.feasible) {
      expect(option.estimated).toBe(true);
      expect(option.txs).toEqual([]);
      expect(option.shortfall).toBeGreaterThan(0n);
      // Warning must spell out the gas-burn risk so UIs aren't
      // tempted to treat it like the wallet-caught cases.
      const combined = option.warnings?.join("\n") ?? "";
      expect(combined).toContain("insufficient_balance");
      expect(combined).toMatch(/burn/i);
    }
    expect(lockedInRate).not.toBeNull();
  });

  it("jetton source + allowInsufficientBalance: combined gas + jetton short emits both warnings", async () => {
    // Both shortfalls present: 0.2 TON wallet (gas short) AND jetton
    // delivers 1 TON (capacity short vs 5.7 TON bet). Warnings must
    // surface both; `shortfall` tracks the jetton shortfall (the
    // dominant, user-actionable one).
    const pricedCoins = [
      priceTon(200_000_000n),
      priceJettonDirect(USDT, 1_000_000n, 1_000_000_000n),
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
      allowInsufficientBalance: true,
      rates: makeRates() as unknown as RatesClient,
      apiClient: createMockApiClient(),
      tonClient: makeFakeTonClient(),
      callStonApi: identityCaller,
      callTonClient: identityCaller,
    });

    expect(option.feasible).toBe(true);
    if (option.feasible) {
      expect(option.warnings?.length).toBeGreaterThanOrEqual(2);
      const combined = option.warnings?.join("\n") ?? "";
      expect(combined).toContain("insufficient_ton_for_gas");
      expect(combined).toContain("insufficient_balance");
      // shortfall tracks the jetton-side gap (the one UI shows as "top up X").
      expect(option.shortfall).toBe(totalCost - 1_000_000_000n);
    }
  });

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
