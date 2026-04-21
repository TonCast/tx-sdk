import type { ToncastTxSdk } from "./sdk.js";
import type {
  BetQuote,
  FixedBetParams,
  LimitBetParams,
  MarketBetParams,
} from "./types.js";
import { sleep } from "./utils/sleep.js";

export type SubscribeOptions = {
  /** Interval between quote refreshes (ms). Default 3000. */
  intervalMs?: number;
  /** Cancel the subscription. */
  signal?: AbortSignal;
  /** Called for each refresh error. If omitted, errors are silently dropped. */
  onError?: (err: unknown) => void;
};

export type Subscription = {
  /** Stop refreshing and release resources. */
  stop: () => void;
  /** Internal promise that resolves when the loop exits. */
  done: Promise<void>;
};

function loop<P>(
  runOnce: (params: P) => Promise<BetQuote>,
  params: P,
  onData: (quote: BetQuote) => void,
  opts: SubscribeOptions,
): Subscription {
  const controller = new AbortController();
  const signal = opts.signal
    ? linkSignal(opts.signal, controller)
    : controller.signal;
  const intervalMs = opts.intervalMs ?? 3000;

  const done = (async () => {
    while (!signal.aborted) {
      try {
        const quote = await runOnce(params);
        if (signal.aborted) return;
        onData(quote);
      } catch (err) {
        if (signal.aborted) return;
        opts.onError?.(err);
      }
      try {
        await sleep(intervalMs, signal);
      } catch {
        return; // aborted
      }
    }
  })();

  return {
    stop: () => controller.abort(),
    done,
  };
}

function linkSignal(
  userSignal: AbortSignal,
  inner: AbortController,
): AbortSignal {
  if (userSignal.aborted) {
    inner.abort(userSignal.reason);
    return inner.signal;
  }
  const abortInner = () => inner.abort(userSignal.reason);
  userSignal.addEventListener("abort", abortInner, { once: true });
  // When the subscription is stopped BEFORE userSignal aborts (i.e. the
  // inner controller fires first), detach `abortInner` so long-lived
  // user signals — e.g. an app-wide controller — don't accumulate a
  // listener per subscription.
  inner.signal.addEventListener(
    "abort",
    () => {
      userSignal.removeEventListener("abort", abortInner);
    },
    { once: true },
  );
  return inner.signal;
}

/**
 * Repeatedly call `quoteFixedBet` at `intervalMs` and invoke `onData` with
 * each fresh result. The underlying rate cache keeps upstream traffic bounded
 * even at short intervals.
 */
export function subscribeFixedBet(
  sdk: ToncastTxSdk,
  params: FixedBetParams,
  onData: (quote: BetQuote) => void,
  opts: SubscribeOptions = {},
): Subscription {
  return loop((p) => sdk.quoteFixedBet(p), params, onData, opts);
}

/** Subscribe to `quoteLimitBet` refreshes. See {@link subscribeFixedBet}. */
export function subscribeLimitBet(
  sdk: ToncastTxSdk,
  params: LimitBetParams,
  onData: (quote: BetQuote) => void,
  opts: SubscribeOptions = {},
): Subscription {
  return loop((p) => sdk.quoteLimitBet(p), params, onData, opts);
}

/** Subscribe to `quoteMarketBet` refreshes. See {@link subscribeFixedBet}. */
export function subscribeMarketBet(
  sdk: ToncastTxSdk,
  params: MarketBetParams,
  onData: (quote: BetQuote) => void,
  opts: SubscribeOptions = {},
): Subscription {
  return loop((p) => sdk.quoteMarketBet(p), params, onData, opts);
}
