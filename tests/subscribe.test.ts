import { describe, expect, it, vi } from "vitest";
import { TON_ADDRESS } from "../src/constants.js";
import { ToncastBetError } from "../src/errors.js";
import { ToncastTxSdk } from "../src/sdk.js";
import { subscribeFixedBet } from "../src/subscribe.js";
import type { PricedCoin } from "../src/types.js";
import { createMockApiClient } from "./_utils/mockApiClient.js";

const PARI = "EQA7bkHU1hRX6LtvkuAASvN0YSX0tk-N9gx5Ji3oDioslLP0";
const BENEFICIARY = "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8";

function makeSdk() {
  const apiClient = createMockApiClient();
  return new ToncastTxSdk({
    apiClient,
    rateLimits: {
      tonClient: { minIntervalMs: 0 },
      stonApi: { minIntervalMs: 0 },
    },
    maxRetries: 0,
  });
}

function tonPriced(amount: bigint, walletReserve = 50_000_000n): PricedCoin {
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

describe("subscribeFixedBet", () => {
  it("invokes onData at least once and stops cleanly", async () => {
    const sdk = makeSdk();
    const onData = vi.fn();

    const sub = subscribeFixedBet(
      sdk,
      {
        pariAddress: PARI,
        beneficiary: BENEFICIARY,
        isYes: true,
        yesOdds: 56,
        ticketsCount: 1,
        referral: null,
        referralPct: 0,
        source: TON_ADDRESS,
        pricedCoins: [tonPriced(10_000_000_000n)],
      },
      onData,
      { intervalMs: 10_000 },
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.stop();
    await sub.done;

    expect(onData).toHaveBeenCalled();
  });

  it("honors an external AbortSignal", async () => {
    const sdk = makeSdk();
    const onData = vi.fn();
    const controller = new AbortController();

    const sub = subscribeFixedBet(
      sdk,
      {
        pariAddress: PARI,
        beneficiary: BENEFICIARY,
        isYes: true,
        yesOdds: 56,
        ticketsCount: 1,
        referral: null,
        referralPct: 0,
        source: TON_ADDRESS,
        pricedCoins: [tonPriced(10_000_000_000n)],
      },
      onData,
      { intervalMs: 10_000, signal: controller.signal },
    );

    controller.abort();
    await sub.done;
    expect(true).toBe(true);
  });

  it("detaches userSignal listener when .stop() is called before userSignal aborts", async () => {
    // Regression: subscribe previously attached a `{ once: true }` abort
    // listener on userSignal that was never detached when `.stop()` fired
    // first. A long-lived app-level signal would accumulate one listener
    // per subscription. We count listeners directly via a wrapped signal.
    const realController = new AbortController();
    let listenerCount = 0;
    const wrapped = new Proxy(realController.signal, {
      get(target, prop, receiver) {
        if (prop === "addEventListener") {
          return (
            type: string,
            handler: EventListenerOrEventListenerObject,
            opts?: AddEventListenerOptions | boolean,
          ) => {
            if (type === "abort") listenerCount += 1;
            return target.addEventListener(type, handler, opts);
          };
        }
        if (prop === "removeEventListener") {
          return (
            type: string,
            handler: EventListenerOrEventListenerObject,
            opts?: EventListenerOptions | boolean,
          ) => {
            if (type === "abort") listenerCount -= 1;
            return target.removeEventListener(type, handler, opts);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as AbortSignal;

    const sdk = makeSdk();
    const sub = subscribeFixedBet(
      sdk,
      {
        pariAddress: PARI,
        beneficiary: BENEFICIARY,
        isYes: true,
        yesOdds: 56,
        ticketsCount: 1,
        referral: null,
        referralPct: 0,
        source: TON_ADDRESS,
        pricedCoins: [tonPriced(10_000_000_000n)],
      },
      vi.fn(),
      { intervalMs: 10_000, signal: wrapped },
    );

    await new Promise((r) => setTimeout(r, 20));
    sub.stop();
    await sub.done;

    // After stop(), all listeners attached by linkSignal must be removed.
    expect(listenerCount).toBe(0);
  });

  it("permanent ToncastBetError stops the loop after a single onError call", async () => {
    // Regression: the loop used to retry `ToncastBetError` on every
    // interval, flooding callers with the same deterministic error.
    // Validation errors are now terminal — one onError call, then exit.
    const sdk = makeSdk();
    const errs: unknown[] = [];
    const onData = vi.fn();

    const sub = subscribeFixedBet(
      sdk,
      {
        pariAddress: "invalid",
        beneficiary: BENEFICIARY,
        isYes: true,
        yesOdds: 56,
        ticketsCount: 1,
        referral: null,
        referralPct: 0,
        source: TON_ADDRESS,
        pricedCoins: [tonPriced(10_000_000_000n)],
      },
      onData,
      {
        intervalMs: 10,
        onError: (e) => errs.push(e),
      },
    );

    // Wait well past several intervals; loop must NOT emit more than
    // one error because the permanent error short-circuits it.
    await sub.done;

    expect(errs.length).toBe(1);
    expect(errs[0]).toBeInstanceOf(ToncastBetError);
    expect(onData).not.toHaveBeenCalled();
  });

  it("transient errors back off exponentially (intervalMs → 2× → 4×)", async () => {
    // Seed an SDK whose quote method always rejects with a generic
    // Error (not ToncastBetError), simulating a network failure.
    // Verify that successive failures widen the gap between onError
    // calls roughly following the 2^(n-1) * intervalMs schedule.
    const sdk = makeSdk();
    const spy = vi.spyOn(sdk, "quoteFixedBet").mockImplementation(async () => {
      throw new Error("transient upstream failure");
    });

    const timestamps: number[] = [];
    const sub = subscribeFixedBet(
      sdk,
      {
        pariAddress: PARI,
        beneficiary: BENEFICIARY,
        isYes: true,
        yesOdds: 56,
        ticketsCount: 1,
        referral: null,
        referralPct: 0,
        source: TON_ADDRESS,
        pricedCoins: [tonPriced(10_000_000_000n)],
      },
      vi.fn(),
      {
        intervalMs: 20,
        onError: () => timestamps.push(Date.now()),
      },
    );

    // Wait long enough to see 4 errors: base + 20 + 40 + 80 ≈ 140ms.
    await new Promise((r) => setTimeout(r, 300));
    sub.stop();
    await sub.done;
    spy.mockRestore();

    // We should see at least three errors (first + two backoffs).
    expect(timestamps.length).toBeGreaterThanOrEqual(3);
    // Second-to-third gap must be strictly larger than first-to-second
    // (2× vs 1× intervalMs minimum).
    if (timestamps.length >= 3) {
      const gap1 = timestamps[1]! - timestamps[0]!;
      const gap2 = timestamps[2]! - timestamps[1]!;
      expect(gap2).toBeGreaterThan(gap1);
    }
  });

  it("transient failure → recovery resets the backoff", async () => {
    const sdk = makeSdk();
    // Capture the real implementation BEFORE spying so the recovery
    // branch can delegate to it instead of re-entering the spy.
    const realQuote = sdk.quoteFixedBet.bind(sdk);
    let calls = 0;
    const spy = vi
      .spyOn(sdk, "quoteFixedBet")
      .mockImplementation(async (params) => {
        calls++;
        if (calls <= 2) throw new Error("transient");
        return realQuote(params);
      });

    const onData = vi.fn();
    const sub = subscribeFixedBet(
      sdk,
      {
        pariAddress: PARI,
        beneficiary: BENEFICIARY,
        isYes: true,
        yesOdds: 56,
        ticketsCount: 1,
        referral: null,
        referralPct: 0,
        source: TON_ADDRESS,
        pricedCoins: [tonPriced(10_000_000_000n)],
      },
      onData,
      { intervalMs: 10, onError: () => {} },
    );

    await new Promise((r) => setTimeout(r, 300));
    sub.stop();
    await sub.done;
    spy.mockRestore();

    expect(onData).toHaveBeenCalled();
  });
});
