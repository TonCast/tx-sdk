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

function tonPriced(amount: bigint): PricedCoin {
  return {
    address: TON_ADDRESS,
    amount,
    tonEquivalent: amount,
    tonEquivalentExpected: amount,
    gasReserve: 50_000_000n,
    route: "direct",
    viable: amount > 100_000_000n,
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
    expect(priced[0]?.gasReserve).toBe(50_000_000n);
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

  it("flag does NOT relax jetton balance shortfall (would burn gas)", async () => {
    const sdk = makeSdk();
    // Jetton delivers only 1 TON; bet needs 5.7 TON. With flag or not,
    // this MUST remain infeasible — a signed tx would bounce on-chain
    // and burn gas.
    const nonViableJetton: PricedCoin = {
      address: USDT,
      amount: 1_000_000n,
      tonEquivalent: 1_000_000_000n,
      tonEquivalentExpected: 1_053_000_000n,
      gasReserve: DIRECT_HOP_JETTON_GAS_ESTIMATE,
      route: "direct",
      viable: true, // 1 TON > 0.3 TON gas — would-be viable per priceCoins
      symbol: "USDT",
      decimals: 6,
    };
    const quote = await new ToncastTxSdk({
      apiClient: createMockApiClient(),
      tonClient: makeFakeTonClient(),
      rateLimits: {
        tonClient: { minIntervalMs: 0 },
        stonApi: { minIntervalMs: 0 },
      },
      maxRetries: 0,
    }).quoteFixedBet({
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      yesOdds: 56,
      ticketsCount: 100,
      referral: null,
      referralPct: 0,
      source: USDT,
      pricedCoins: [tonPriced(2_000_000_000n), nonViableJetton],
      allowInsufficientBalance: true,
    });
    void sdk;

    expect(quote.option.feasible).toBe(false);
    if (!quote.option.feasible) {
      expect(quote.option.reason).toBe("insufficient_balance");
    }
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
