import { describe, expect, it, vi } from "vitest";
import {
  DIRECT_HOP_JETTON_GAS_ESTIMATE,
  ODDS_COUNT,
  TON_ADDRESS,
} from "../src/constants.js";
import { ToncastBetError, ToncastNetworkError } from "../src/errors.js";
import { ToncastTxSdk } from "../src/sdk.js";
import type { OddsState, PricedCoin } from "../src/types.js";
import {
  buildSimulation,
  createMockApiClient,
} from "./_utils/mockApiClient.js";

const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

const PARI = "EQA7bkHU1hRX6LtvkuAASvN0YSX0tk-N9gx5Ji3oDioslLP0";
const BENEFICIARY = "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8";

function emptyOddsState(): OddsState {
  return {
    Yes: new Array(ODDS_COUNT).fill(0) as number[],
    No: new Array(ODDS_COUNT).fill(0) as number[],
  };
}

function tonPriced(amount: bigint, walletReserve = 50_000_000n): PricedCoin {
  // tonEquivalent now reflects the spendable budget for TON sources too
  // (= amount − walletReserve − gasReserve). Same field, same meaning,
  // for both TON and jetton — UI sliders read it uniformly.
  const usable = amount > walletReserve ? amount - walletReserve : 0n;
  return {
    address: TON_ADDRESS,
    amount,
    tonEquivalent: usable,
    tonEquivalentExpected: usable,
    gasReserve: 0n,
    route: "direct",
    viable: usable > 0n,
  };
}

function makeSdk() {
  return new ToncastTxSdk({
    apiClient: createMockApiClient(),
    rateLimits: {
      tonClient: { minIntervalMs: 0 },
      stonApi: { minIntervalMs: 0 },
    },
    maxRetries: 0,
  });
}

describe("ToncastTxSdk.quoteFixedBet", () => {
  it("TON-only flow: produces feasible TON option with isYes echoed", async () => {
    const sdk = makeSdk();
    const quote = await sdk.quoteFixedBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      yesOdds: 56,
      ticketsCount: 100,
      referral: null,
      referralPct: 0,
      source: TON_ADDRESS,
      pricedCoins: [tonPriced(10_000_000_000n)],
    });

    expect(quote.mode).toBe("fixed");
    expect(quote.isYes).toBe(true);
    expect(quote.bets).toEqual([{ yesOdds: 56, ticketsCount: 100 }]);
    expect(quote.totalCost).toBe(5_700_000_000n);
    expect(quote.option.feasible).toBe(true);
    expect(quote.lockedInRate).toBeNull();
  });

  it("validation error propagates as ToncastBetError", async () => {
    const sdk = makeSdk();
    await expect(
      sdk.quoteFixedBet({
        pariAddress: PARI,
        beneficiary: BENEFICIARY,
        isYes: true,
        yesOdds: 56,
        ticketsCount: 100,
        referral: null,
        referralPct: 5, // pct>0 without referral
        source: TON_ADDRESS,
        pricedCoins: [tonPriced(10_000_000_000n)],
      }),
    ).rejects.toBeInstanceOf(ToncastBetError);
  });
});

describe("ToncastTxSdk.quoteLimitBet", () => {
  it("produces feasible quote with merged entries", async () => {
    const sdk = makeSdk();
    const state = emptyOddsState();
    // NO orders matchable at yesOdds=54 live at No[yesOddsToIndex(46)] = No[22]
    // and NO orders matchable at yesOdds=56 live at No[yesOddsToIndex(44)] = No[21]
    // under the complementary-NO-index convention (see oddsState.ts).
    state.No[22] = 17;
    state.No[21] = 100;

    const quote = await sdk.quoteLimitBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      oddsState: state,
      worstYesOdds: 56,
      ticketsCount: 300,
      referral: null,
      referralPct: 0,
      source: TON_ADDRESS,
      pricedCoins: [tonPriced(100_000_000_000n)],
    });

    expect(quote.mode).toBe("limit");
    expect(quote.bets).toEqual([
      { yesOdds: 54, ticketsCount: 17 },
      { yesOdds: 56, ticketsCount: 283 },
    ]);
    expect(quote.option.feasible).toBe(true);
  });
});

describe("ToncastTxSdk.quoteMarketBet", () => {
  it("empty oddsState → placement on yesOdds 50", async () => {
    const sdk = makeSdk();
    const quote = await sdk.quoteMarketBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      oddsState: emptyOddsState(),
      maxBudgetTon: 10_000_000_000n,
      referral: null,
      referralPct: 0,
      source: TON_ADDRESS,
      pricedCoins: [tonPriced(20_000_000_000n)],
    });

    expect(quote.mode).toBe("market");
    expect(quote.bets).toHaveLength(1);
    expect(quote.bets[0]?.yesOdds).toBe(50);
  });

  it("budget too small → infeasible quote", async () => {
    const sdk = makeSdk();
    const quote = await sdk.quoteMarketBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      oddsState: emptyOddsState(),
      maxBudgetTon: 50_000_000n, // below PARI_EXECUTION_FEE
      referral: null,
      referralPct: 0,
      source: TON_ADDRESS,
      pricedCoins: [tonPriced(1_000_000_000n)],
    });

    expect(quote.option.feasible).toBe(false);
    if (!quote.option.feasible) {
      expect(quote.option.reason).toBe("budget_too_small_for_single_entry");
    }
  });
});

describe("ToncastTxSdk.priceCoins", () => {
  it("TON without tonClient is still priced directly", async () => {
    const sdk = new ToncastTxSdk({
      apiClient: createMockApiClient(),
      rateLimits: {
        tonClient: { minIntervalMs: 0 },
        stonApi: { minIntervalMs: 0 },
      },
      maxRetries: 0,
    });
    const priced = await sdk.priceCoins({
      availableCoins: [{ address: TON_ADDRESS, amount: 10_000_000_000n }],
    });
    expect(priced).toHaveLength(1);
    expect(priced[0]?.address).toBe(TON_ADDRESS);
    expect(priced[0]?.viable).toBe(true);
    // TON_DIRECT_GAS = 0n: PARI_EXECUTION_FEE inside totalCost already
    // covers Pari-side gas, no extra surplus is attached.
    expect(priced[0]?.gasReserve).toBe(0n);
  });

  it("jetton without tonClient → non-viable with reason", async () => {
    const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
    const sdk = new ToncastTxSdk({
      apiClient: createMockApiClient(),
      rateLimits: {
        tonClient: { minIntervalMs: 0 },
        stonApi: { minIntervalMs: 0 },
      },
      maxRetries: 0,
    });
    const priced = await sdk.priceCoins({
      availableCoins: [{ address: USDT, amount: 100_000_000n }],
    });
    expect(priced[0]?.viable).toBe(false);
    expect(priced[0]?.reason).toMatch(/tonClient is required/);
  });
});

describe("ToncastTxSdk.confirmQuote", () => {
  it("TON-funded quote: confirms unchanged (no swap)", async () => {
    const sdk = makeSdk();
    const quote = await sdk.quoteFixedBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      yesOdds: 56,
      ticketsCount: 100,
      referral: null,
      referralPct: 0,
      source: TON_ADDRESS,
      pricedCoins: [tonPriced(10_000_000_000n)],
    });

    const confirmed = await sdk.confirmQuote(quote, {
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      referral: null,
      referralPct: 0,
    });

    expect(confirmed).toBe(quote);
  });

  it("infeasible quote → throws on confirmQuote", async () => {
    const sdk = makeSdk();
    const quote = await sdk.quoteFixedBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      yesOdds: 56,
      ticketsCount: 100,
      referral: null,
      referralPct: 0,
      source: TON_ADDRESS,
      pricedCoins: [tonPriced(100_000_000n)], // far less than 5.7 TON
    });
    expect(quote.option.feasible).toBe(false);

    await expect(
      sdk.confirmQuote(quote, {
        pariAddress: PARI,
        beneficiary: BENEFICIARY,
        referral: null,
        referralPct: 0,
      }),
    ).rejects.toBeInstanceOf(ToncastBetError);

    // Regression: previously surfaced as `EMPTY_BETS` — a misleading code
    // for callers filtering on error.code. Should be `QUOTE_INFEASIBLE`.
    try {
      await sdk.confirmQuote(quote, {
        pariAddress: PARI,
        beneficiary: BENEFICIARY,
        referral: null,
        referralPct: 0,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ToncastBetError);
      if (err instanceof ToncastBetError) {
        expect(err.code).toBe("QUOTE_INFEASIBLE");
      }
    }
  });
});

// ─── Jetton flows (fake tonClient + seeded simulations) ───────────────────

function makeFakeTonClient() {
  const open = vi.fn(() => ({
    getSwapJettonToTonTxParams: vi.fn(async () => ({
      to: { equals: () => true } as unknown,
      value: 600_000_000n,
      body: null,
    })),
    getSwapJettonToJettonTxParams: vi.fn(async () => ({
      to: { equals: () => true } as unknown,
      value: 900_000_000n,
      body: null,
    })),
  }));
  return { open } as unknown as import("@ston-fi/sdk").Client;
}

function priceUsdtDirect(tonEq: bigint): PricedCoin {
  return {
    address: USDT,
    amount: 100_000_000n,
    tonEquivalent: tonEq,
    tonEquivalentExpected: (tonEq * 100n) / 95n,
    gasReserve: DIRECT_HOP_JETTON_GAS_ESTIMATE,
    route: "direct",
    viable: tonEq > DIRECT_HOP_JETTON_GAS_ESTIMATE,
    symbol: "USDT",
    decimals: 6,
  };
}

describe("ToncastTxSdk jetton source", () => {
  it("quoteFixedBet returns ESTIMATED jetton quote; confirmQuote finalises it", async () => {
    const reverse = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "5700000",
      askUnits: "5700000000",
      minAskUnits: "5700000000",
      priceImpact: "0.01",
    });
    const apiClient = createMockApiClient();
    // Inject simulateReverseSwap — confirmQuote will call this.
    (apiClient as { simulateReverseSwap?: unknown }).simulateReverseSwap =
      vi.fn(async () => reverse);
    const sdk = new ToncastTxSdk({
      apiClient,
      tonClient: makeFakeTonClient(),
      rateLimits: {
        tonClient: { minIntervalMs: 0 },
        stonApi: { minIntervalMs: 0 },
      },
      maxRetries: 0,
    });

    const pricedCoins = [
      tonPriced(1_000_000_000n),
      priceUsdtDirect(50_000_000_000n),
    ];

    const quote = await sdk.quoteFixedBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      yesOdds: 56,
      ticketsCount: 100,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins,
    });

    // Post-0.2.0: jetton quote is estimated, has no tx yet.
    expect(quote.option.feasible).toBe(true);
    if (quote.option.feasible) {
      expect(quote.option.estimated).toBe(true);
      expect(quote.option.txs).toEqual([]);
    }
    expect(quote.lockedInRate).not.toBeNull();
    if (quote.lockedInRate) {
      expect(quote.lockedInRate.source).toBe(USDT);
      // Planner doesn't simulate → priceImpact is 0 sentinel.
      expect(quote.lockedInRate.priceImpact).toBe(0);
    }

    // simulateReverseSwap must NOT have been called yet — the planner
    // used a linear estimate. confirmQuote will call it next.
    const reverseFn = (
      apiClient as unknown as {
        simulateReverseSwap: { mock: { calls: unknown[] } };
      }
    ).simulateReverseSwap;
    expect(reverseFn.mock.calls.length).toBe(0);

    // confirmQuote runs the fresh reverse sim and builds the tx.
    const fresh = await sdk.confirmQuote(quote, {
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      referral: null,
      referralPct: 0,
    });
    expect(fresh.option.feasible).toBe(true);
    if (fresh.option.feasible) {
      expect(fresh.option.estimated).toBe(false);
      expect(fresh.option.txs).toHaveLength(1);
      expect(fresh.option.breakdown.spend).toBe(5_700_000n);
    }
    // Exactly one simulate-reverse call happened across the whole flow.
    expect(reverseFn.mock.calls.length).toBe(1);
  });

  it("confirmQuote throws SLIPPAGE_DRIFTED when fresh sim exceeds slippage", async () => {
    // Since planBetOption no longer simulates, the ONLY reverse-swap
    // call happens inside confirmQuote. Seed it to return a drifted
    // priceImpact and verify the error.
    const reverseDrifted = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "5700000",
      askUnits: "5700000000",
      minAskUnits: "5700000000",
      priceImpact: "0.12", // 12% > 5% limit → drift
    });

    const apiClient = createMockApiClient();
    (apiClient as { simulateReverseSwap?: unknown }).simulateReverseSwap =
      vi.fn(async () => reverseDrifted);
    const sdk = new ToncastTxSdk({
      apiClient,
      tonClient: makeFakeTonClient(),
      rateLimits: {
        tonClient: { minIntervalMs: 0 },
        stonApi: { minIntervalMs: 0 },
      },
      maxRetries: 0,
    });

    const pricedCoins = [
      tonPriced(1_000_000_000n),
      priceUsdtDirect(50_000_000_000n),
    ];
    const quote = await sdk.quoteFixedBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      yesOdds: 56,
      ticketsCount: 100,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins,
    });
    expect(quote.option.feasible).toBe(true);

    await expect(
      sdk.confirmQuote(quote, {
        pariAddress: PARI,
        beneficiary: BENEFICIARY,
        referral: null,
        referralPct: 0,
      }),
    ).rejects.toMatchObject({ code: "SLIPPAGE_DRIFTED" });
  });

  it("confirmQuote without tonClient throws SOURCE_NOT_VIABLE", async () => {
    // Build a quote with a fake locked-in rate by quoting with tonClient,
    // then confirm on a new SDK that lacks one.
    const forward = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "100000000",
      askUnits: "50000000000",
      minAskUnits: "49500000000",
      priceImpact: "0.01",
    });
    const reverse = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "5700000",
      askUnits: "5700000000",
      minAskUnits: "5700000000",
      priceImpact: "0.01",
    });
    const apiClient = createMockApiClient({
      simulations: { [`${USDT}→${TON_ADDRESS}`]: forward },
    });
    (apiClient as { simulateReverseSwap?: unknown }).simulateReverseSwap =
      vi.fn(async () => reverse);
    const sdkWithClient = new ToncastTxSdk({
      apiClient,
      tonClient: makeFakeTonClient(),
      rateLimits: {
        tonClient: { minIntervalMs: 0 },
        stonApi: { minIntervalMs: 0 },
      },
      maxRetries: 0,
    });
    const pricedCoins = [
      tonPriced(1_000_000_000n),
      priceUsdtDirect(50_000_000_000n),
    ];
    const quote = await sdkWithClient.quoteFixedBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      yesOdds: 56,
      ticketsCount: 100,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins,
    });
    expect(quote.option.feasible).toBe(true);

    const sdkNoClient = new ToncastTxSdk({
      apiClient: createMockApiClient(),
      rateLimits: {
        tonClient: { minIntervalMs: 0 },
        stonApi: { minIntervalMs: 0 },
      },
      maxRetries: 0,
    });

    await expect(
      sdkNoClient.confirmQuote(quote, {
        pariAddress: PARI,
        beneficiary: BENEFICIARY,
        referral: null,
        referralPct: 0,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_VIABLE" });
  });
});

describe("ToncastTxSdk effectiveSlippage propagation", () => {
  it("uses PricedCoin.effectiveSlippage for the actual swap (not user max)", async () => {
    // Jetton priced with effectiveSlippage 0.005 (recommended < user max).
    // After confirmQuote, simulateReverseSwap MUST be called with that
    // tighter slippage — proves end-to-end propagation through
    // lockedInRate.slippage.
    const reverseSpy = vi.fn(async () =>
      buildSimulation({
        offerAddress: USDT,
        askAddress: TON_ADDRESS,
        offerUnits: "5670000",
        askUnits: "5700000000",
        minAskUnits: "5700000000",
        priceImpact: "0.001",
      }),
    );
    const apiClient = createMockApiClient();
    (apiClient as { simulateReverseSwap?: unknown }).simulateReverseSwap =
      reverseSpy;

    const sdk = new ToncastTxSdk({
      apiClient,
      tonClient: makeFakeTonClient(),
      rateLimits: {
        tonClient: { minIntervalMs: 0 },
        stonApi: { minIntervalMs: 0 },
      },
      maxRetries: 0,
    });

    const usdtPriced: PricedCoin = {
      address: USDT,
      amount: 100_000_000n,
      tonEquivalent: 49_750_000_000n, // floor at 0.005
      tonEquivalentExpected: 50_000_000_000n,
      gasReserve: DIRECT_HOP_JETTON_GAS_ESTIMATE,
      route: "direct",
      viable: true,
      symbol: "USDT",
      decimals: 6,
      recommendedSlippage: "0.005",
      effectiveSlippage: "0.005",
    };

    const quote = await sdk.quoteFixedBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      yesOdds: 56,
      ticketsCount: 100,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins: [tonPriced(1_000_000_000n), usdtPriced],
      // User passed 0.05 — this should NOT win over PricedCoin.effectiveSlippage.
      slippage: "0.05",
    });

    expect(quote.lockedInRate?.slippage).toBe("0.005");

    await sdk.confirmQuote(quote, {
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      referral: null,
      referralPct: 0,
    });

    // The reverse-sim call must have been issued at the tighter
    // effective slippage, not the user-set max.
    expect(reverseSpy).toHaveBeenCalledTimes(1);
    const call = (
      reverseSpy.mock.calls[0] as unknown as
        | [{ slippageTolerance: string }]
        | undefined
    )?.[0];
    expect(call?.slippageTolerance).toBe("0.005");
  });
});

describe("ToncastTxSdk allowInsufficientBalance (preview mode)", () => {
  it("TON source: short balance → feasible quote with warnings + shortfall, tx built", async () => {
    const sdk = makeSdk();
    const quote = await sdk.quoteFixedBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      yesOdds: 56,
      ticketsCount: 100,
      referral: null,
      referralPct: 0,
      source: TON_ADDRESS,
      // 0.5 TON — above the viability threshold (walletReserve + gas =
      // 0.1 TON) so planner proceeds, but far below the 5.7 TON bet.
      pricedCoins: [tonPriced(500_000_000n)],
      allowInsufficientBalance: true,
    });

    expect(quote.option.feasible).toBe(true);
    if (quote.option.feasible) {
      expect(quote.option.txs).toHaveLength(1);
      expect(quote.option.shortfall).toBeGreaterThan(0n);
      expect(quote.option.warnings?.[0]).toMatch(/insufficient_balance/);
    }
    // Also reachable via confirmQuote (TON-source returns unchanged).
    const confirmed = await sdk.confirmQuote(quote, {
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      referral: null,
      referralPct: 0,
    });
    expect(confirmed).toBe(quote);
  });

  it("jetton source + short TON-for-gas: confirmQuote passes and finalises the tx", async () => {
    // Regression: without the flag, confirmQuote threw QUOTE_INFEASIBLE
    // on this exact scenario. With the flag + insufficient gas, the
    // tx is still built so the wallet can show "not enough TON" to the
    // user before signing.
    const reverse = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "5700000",
      askUnits: "5700000000",
      minAskUnits: "5700000000",
      priceImpact: "0.01",
    });
    const apiClient = createMockApiClient();
    (apiClient as { simulateReverseSwap?: unknown }).simulateReverseSwap =
      vi.fn(async () => reverse);
    const sdk = new ToncastTxSdk({
      apiClient,
      tonClient: makeFakeTonClient(),
      rateLimits: {
        tonClient: { minIntervalMs: 0 },
        stonApi: { minIntervalMs: 0 },
      },
      maxRetries: 0,
    });

    // 0.2 TON on wallet; direct-hop needs 0.3 + reserve.
    const pricedCoins = [
      tonPriced(200_000_000n),
      priceUsdtDirect(50_000_000_000n),
    ];

    const quote = await sdk.quoteFixedBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      yesOdds: 56,
      ticketsCount: 100,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins,
      allowInsufficientBalance: true,
    });

    expect(quote.option.feasible).toBe(true);
    if (quote.option.feasible) {
      expect(quote.option.estimated).toBe(true);
      expect(quote.option.shortfall).toBeGreaterThan(0n);
      expect(quote.option.warnings?.[0]).toMatch(/insufficient_ton_for_gas/);
    }

    const confirmed = await sdk.confirmQuote(quote, {
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      referral: null,
      referralPct: 0,
    });
    expect(confirmed.option.feasible).toBe(true);
    if (confirmed.option.feasible) {
      expect(confirmed.option.estimated).toBe(false);
      expect(confirmed.option.txs).toHaveLength(1);
    }
  });

  it("flag relaxes jetton balance shortfall too, with explicit gas-burn warning", async () => {
    // Jetton delivers only 1 TON; bet needs 5.7 TON. With flag on, we
    // now emit a feasible estimated quote — but the warning flags
    // that this is the footgun case (tx broadcasts and burns gas).
    const reverse = buildSimulation({
      offerAddress: USDT,
      askAddress: TON_ADDRESS,
      offerUnits: "7000000", // STON.fi sizes swap independently of user balance
      askUnits: "5700000000",
      minAskUnits: "5700000000",
      priceImpact: "0.01",
    });
    const apiClient = createMockApiClient();
    (apiClient as { simulateReverseSwap?: unknown }).simulateReverseSwap =
      vi.fn(async () => reverse);
    const sdk = new ToncastTxSdk({
      apiClient,
      tonClient: makeFakeTonClient(),
      rateLimits: {
        tonClient: { minIntervalMs: 0 },
        stonApi: { minIntervalMs: 0 },
      },
      maxRetries: 0,
    });

    const thinJetton: PricedCoin = {
      address: USDT,
      amount: 1_000_000n,
      tonEquivalent: 1_000_000_000n,
      tonEquivalentExpected: 1_053_000_000n,
      gasReserve: DIRECT_HOP_JETTON_GAS_ESTIMATE,
      route: "direct",
      viable: true,
      symbol: "USDT",
      decimals: 6,
    };
    const quote = await sdk.quoteFixedBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      yesOdds: 56,
      ticketsCount: 100,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins: [tonPriced(2_000_000_000n), thinJetton],
      allowInsufficientBalance: true,
    });

    expect(quote.option.feasible).toBe(true);
    if (quote.option.feasible) {
      expect(quote.option.estimated).toBe(true);
      expect(quote.option.shortfall).toBeGreaterThan(0n);
      const combined = quote.option.warnings?.join("\n") ?? "";
      expect(combined).toContain("insufficient_balance");
      expect(combined).toMatch(/burn/i);
    }

    // confirmQuote should proceed — producing a concrete tx the UI
    // can forward to TonConnect. The on-chain jetton wallet is what
    // will reject; that's the UX tradeoff the flag makes explicit.
    const confirmed = await sdk.confirmQuote(quote, {
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      referral: null,
      referralPct: 0,
    });
    expect(confirmed.option.feasible).toBe(true);
    if (confirmed.option.feasible) {
      expect(confirmed.option.txs).toHaveLength(1);
    }
  });
});

// ─── Cross-hop end-to-end smoke tests ──────────────────────────────────────
//
// Reproduce the mainnet TCAST → USDT → TON path for each of fixed / limit /
// market modes and verify quote → confirmQuote produces a swap whose offer
// jetton amount tracks the planner's linear estimate within ±2 %.
//
// Why these exist:
//   - Variant B (route-total slippage) was a structural change to the
//     cross-hop slippage math. The pricing-/rates-level regression test
//     covers the math in isolation; these tests pin the contract for the
//     full SDK surface so a future "let's gross up per leg again" change
//     surfaces an obvious failure.
//   - All three strategies feed the same planner / confirmQuote pipeline
//     but with different `bets[]` shapes — covering each guards against
//     accidental coupling between strategy logic and slippage handling.
describe("ToncastTxSdk cross-hop quote → confirmQuote", () => {
  // Mock STON.fi pool: 1 jetton ≈ 50 TON via USDT intermediate, 1:1 USDT
  // legs. honourSlippage replays the slippageTolerance the simulator was
  // called with, mirroring real STON.fi behaviour (mock at the rates
  // layer in pricing.test.ts already covers the same shape).
  const COMMUNITY_X = "EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTOgVZIxEQI";
  const SCALE = 1_000_000_000n;

  function honourSlippage(askUnits: string, slip: string): string {
    const keep = SCALE - BigInt(Math.round(Number(slip) * Number(SCALE)));
    return ((BigInt(askUnits) * keep) / SCALE).toString();
  }

  function makeCrossHopApiClient() {
    const usdtPerJetton = 5_000_000n; // leg1: 100M jetton → 5M USDT
    // Pool sized so 100M jetton ≈ 50 TON — plenty of headroom for fixed
    // (5.7 TON) / limit (~17 TON) / market (capacity-fraction) bets so
    // capacity isn't what we're testing here.
    const tonPerUsdt = 10_000n; // leg2: 5M USDT → 5e10 TON
    const apiClient = createMockApiClient({
      pairs: [
        [COMMUNITY_X, USDT],
        [USDT, TON_ADDRESS],
      ],
      pools: { [`${COMMUNITY_X}↔${USDT}`]: [{ lpTotalSupplyUsd: "1000000" }] },
    });

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
      if (a.offerAddress === COMMUNITY_X && a.askAddress === USDT) {
        askUnits = (
          (BigInt(a.offerUnits) * usdtPerJetton) /
          100_000_000n
        ).toString();
      } else if (a.offerAddress === USDT && a.askAddress === TON_ADDRESS) {
        askUnits = (BigInt(a.offerUnits) * tonPerUsdt).toString();
      } else {
        throw new Error(
          `unexpected forward sim: ${a.offerAddress} → ${a.askAddress}`,
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

    (
      apiClient as unknown as {
        simulateReverseSwap: import("@ston-fi/api").StonApiClient["simulateReverseSwap"];
      }
    ).simulateReverseSwap = vi.fn(async (args: unknown) => {
      const a = args as {
        offerAddress: string;
        askAddress: string;
        askUnits: string;
        slippageTolerance: string;
      };
      let offerUnits: string;
      if (a.offerAddress === USDT && a.askAddress === TON_ADDRESS) {
        offerUnits = (BigInt(a.askUnits) / tonPerUsdt).toString();
      } else if (a.offerAddress === COMMUNITY_X && a.askAddress === USDT) {
        offerUnits = (
          (BigInt(a.askUnits) * 100_000_000n) /
          usdtPerJetton
        ).toString();
      } else {
        throw new Error(
          `unexpected reverse sim: ${a.offerAddress} → ${a.askAddress}`,
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
    }) as unknown as import("@ston-fi/api").StonApiClient["simulateReverseSwap"];
    return apiClient;
  }

  function expectLinearEstimateMatchesConfirm(args: {
    pricedJetton: PricedCoin;
    totalCost: bigint;
    confirmOfferUnits: bigint;
  }) {
    const { pricedJetton, totalCost, confirmOfferUnits } = args;
    // Mirror planner.ts::estimatedOfferUnits exactly.
    const linear =
      (pricedJetton.amount * totalCost + pricedJetton.tonEquivalent - 1n) /
      pricedJetton.tonEquivalent;
    const ratio = Number(confirmOfferUnits) / Number(linear);
    // Old per-leg-as-user-slippage code put this ratio at ~1.05 for
    // cross-hop. With Variant B it must sit inside a couple of percent —
    // the only remaining drift comes from grossUp ceil rounding plus
    // tonEquivalent's pessimistic floor on the *full* balance.
    expect(ratio).toBeGreaterThan(0.98);
    expect(ratio).toBeLessThan(1.02);
  }

  it("quoteFixedBet → confirmQuote: cross-hop offer matches linear estimate", async () => {
    const apiClient = makeCrossHopApiClient();
    const sdk = new ToncastTxSdk({
      apiClient,
      tonClient: makeFakeTonClient(),
      rateLimits: {
        tonClient: { minIntervalMs: 0 },
        stonApi: { minIntervalMs: 0 },
      },
      maxRetries: 0,
    });

    // Use SDK.priceCoins so tonEquivalent is whatever the new pricing
    // logic actually emits — no hand-crafted values that could mask
    // regressions.
    const priced = await sdk.priceCoins({
      availableCoins: [
        { address: TON_ADDRESS, amount: 2_000_000_000n },
        { address: COMMUNITY_X, amount: 100_000_000n },
      ],
    });
    const jetton = priced.find((c) => c.address === COMMUNITY_X);
    expect(jetton?.viable).toBe(true);
    expect(jetton?.route).toEqual({ intermediate: USDT });

    const quote = await sdk.quoteFixedBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      yesOdds: 56,
      ticketsCount: 100,
      referral: null,
      referralPct: 0,
      source: COMMUNITY_X,
      pricedCoins: priced,
    });
    expect(quote.option.feasible).toBe(true);

    const confirmed = await sdk.confirmQuote(quote, {
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      referral: null,
      referralPct: 0,
    });
    expect(confirmed.option.feasible).toBe(true);
    if (!confirmed.option.feasible) return;
    expect(confirmed.option.estimated).toBe(false);
    expect(confirmed.option.txs).toHaveLength(1);

    expectLinearEstimateMatchesConfirm({
      pricedJetton: jetton!,
      totalCost: quote.totalCost,
      confirmOfferUnits: confirmed.option.breakdown.spend,
    });
  });

  it("quoteLimitBet → confirmQuote: cross-hop offer matches linear estimate", async () => {
    const apiClient = makeCrossHopApiClient();
    const sdk = new ToncastTxSdk({
      apiClient,
      tonClient: makeFakeTonClient(),
      rateLimits: {
        tonClient: { minIntervalMs: 0 },
        stonApi: { minIntervalMs: 0 },
      },
      maxRetries: 0,
    });
    const priced = await sdk.priceCoins({
      availableCoins: [
        { address: TON_ADDRESS, amount: 2_000_000_000n },
        { address: COMMUNITY_X, amount: 100_000_000n },
      ],
    });
    const jetton = priced.find((c) => c.address === COMMUNITY_X)!;

    const state = emptyOddsState();
    state.No[22] = 17; // matchable at yesOdds=54
    state.No[21] = 100; // matchable at yesOdds=56

    const quote = await sdk.quoteLimitBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      oddsState: state,
      worstYesOdds: 56,
      ticketsCount: 300,
      referral: null,
      referralPct: 0,
      source: COMMUNITY_X,
      pricedCoins: priced,
    });
    expect(quote.option.feasible).toBe(true);
    // Strategy still produces the same merged bets regardless of source.
    expect(quote.bets).toEqual([
      { yesOdds: 54, ticketsCount: 17 },
      { yesOdds: 56, ticketsCount: 283 },
    ]);

    const confirmed = await sdk.confirmQuote(quote, {
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      referral: null,
      referralPct: 0,
    });
    expect(confirmed.option.feasible).toBe(true);
    if (!confirmed.option.feasible) return;

    expectLinearEstimateMatchesConfirm({
      pricedJetton: jetton,
      totalCost: quote.totalCost,
      confirmOfferUnits: confirmed.option.breakdown.spend,
    });
  });

  it("quoteMarketBet → confirmQuote: cross-hop offer matches linear estimate", async () => {
    const apiClient = makeCrossHopApiClient();
    const sdk = new ToncastTxSdk({
      apiClient,
      tonClient: makeFakeTonClient(),
      rateLimits: {
        tonClient: { minIntervalMs: 0 },
        stonApi: { minIntervalMs: 0 },
      },
      maxRetries: 0,
    });
    const priced = await sdk.priceCoins({
      availableCoins: [
        { address: TON_ADDRESS, amount: 2_000_000_000n },
        { address: COMMUNITY_X, amount: 100_000_000n },
      ],
    });
    const jetton = priced.find((c) => c.address === COMMUNITY_X)!;

    // Half of jetton's tonEquivalent — well inside its capacity, market
    // strategy can place it as a single placement on yesOdds=50 with
    // an empty oddsState.
    const maxBudget = jetton.tonEquivalent / 2n;
    const quote = await sdk.quoteMarketBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      oddsState: emptyOddsState(),
      maxBudgetTon: maxBudget,
      referral: null,
      referralPct: 0,
      source: COMMUNITY_X,
      pricedCoins: priced,
    });
    expect(quote.option.feasible).toBe(true);
    expect(quote.bets).toHaveLength(1);
    expect(quote.bets[0]?.yesOdds).toBe(50);

    const confirmed = await sdk.confirmQuote(quote, {
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      referral: null,
      referralPct: 0,
    });
    expect(confirmed.option.feasible).toBe(true);
    if (!confirmed.option.feasible) return;

    expectLinearEstimateMatchesConfirm({
      pricedJetton: jetton,
      totalCost: quote.totalCost,
      confirmOfferUnits: confirmed.option.breakdown.spend,
    });
  });

  it("availableForBet on cross-hop jetton lets a max-capacity bet still confirm", async () => {
    // The structural change shrank cross-hop tonEquivalent by ~5 % vs
    // the pre-fix value. Pin: a bet sized exactly at availableForBet
    // (= tonEquivalent for jetton sources) must still confirm without
    // bumping into insufficient_balance — i.e. the planner's linear
    // estimate stays ≤ amount, AND confirmQuote's reverse simulation
    // still fits the same jetton balance.
    const apiClient = makeCrossHopApiClient();
    const sdk = new ToncastTxSdk({
      apiClient,
      tonClient: makeFakeTonClient(),
      rateLimits: {
        tonClient: { minIntervalMs: 0 },
        stonApi: { minIntervalMs: 0 },
      },
      maxRetries: 0,
    });
    const priced = await sdk.priceCoins({
      availableCoins: [
        { address: TON_ADDRESS, amount: 2_000_000_000n },
        { address: COMMUNITY_X, amount: 100_000_000n },
      ],
    });
    const jetton = priced.find((c) => c.address === COMMUNITY_X)!;

    // Market mode greedy-spends maxBudgetTon. Setting it to exactly
    // tonEquivalent forces the planner to size offerUnits right up to
    // the jetton balance ceiling.
    const quote = await sdk.quoteMarketBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      oddsState: emptyOddsState(),
      maxBudgetTon: jetton.tonEquivalent,
      referral: null,
      referralPct: 0,
      source: COMMUNITY_X,
      pricedCoins: priced,
    });
    expect(quote.option.feasible).toBe(true);

    const confirmed = await sdk.confirmQuote(quote, {
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      referral: null,
      referralPct: 0,
    });
    expect(confirmed.option.feasible).toBe(true);
    if (!confirmed.option.feasible) return;
    // Confirmed offer units must not exceed the jetton balance —
    // otherwise the wallet would refuse / revert on jetton transfer.
    expect(confirmed.option.breakdown.spend).toBeLessThanOrEqual(jetton.amount);
  });
});

describe("ToncastTxSdk utilities", () => {
  it("clearRateCache does not throw", () => {
    const sdk = new ToncastTxSdk();
    sdk.clearRateCache();
  });

  it("exports ToncastNetworkError for instanceof checks", () => {
    const err = new ToncastNetworkError(
      "stonApi",
      "simulateSwap",
      new Error("x"),
    );
    expect(err).toBeInstanceOf(ToncastNetworkError);
    expect(err.source).toBe("stonApi");
  });
});
