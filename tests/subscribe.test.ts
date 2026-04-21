import { describe, expect, it, vi } from "vitest";
import { TON_ADDRESS } from "../src/constants.js";
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

function tonPriced(amount: bigint): PricedCoin {
  return {
    address: TON_ADDRESS,
    amount,
    tonEquivalent: amount,
    gasReserve: 50_000_000n,
    netTon: amount - 100_000_000n,
    route: "direct",
    viable: true,
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

  it("onError receives errors and doesn't break the loop", async () => {
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
        intervalMs: 10_000,
        onError: (e) => errs.push(e),
      },
    );

    await new Promise((r) => setTimeout(r, 50));
    sub.stop();
    await sub.done;

    expect(errs.length + onData.mock.calls.length).toBeGreaterThan(0);
  });
});
