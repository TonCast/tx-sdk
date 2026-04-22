import { ToncastBetError } from "./errors.js";
import type { ToncastTxSdk } from "./sdk.js";
import type {
  BetQuote,
  FixedBetParams,
  LimitBetParams,
  MarketBetParams,
} from "./types.js";
import { sleep } from "./utils/sleep.js";

/** Hard ceiling for exponential backoff waits between failing refreshes. */
const MAX_BACKOFF_MS = 60_000;

export type SubscribeOptions = {
  /** Interval between quote refreshes (ms). Default 3000. */
  intervalMs?: number;
  /** Cancel the subscription. */
  signal?: AbortSignal;
  /**
   * Called for each refresh error, AND on the final permanent error
   * that stops the subscription.
   *
   * Permanent errors ({@link ToncastBetError} — invalid params, etc.)
   * stop the loop immediately: retrying the same bad input produces
   * the same error, and a 3-second cadence floods the caller with
   * noise. Transient errors (network, upstream 5xx/429) keep the loop
   * alive but each consecutive failure doubles the wait up to
   * {@link MAX_BACKOFF_MS} so a sustained upstream outage doesn't
   * hammer the API.
   */
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
    // `consecutiveFailures` drives the exponential backoff. Reset on
    // every successful run so a transient hiccup doesn't permanently
    // stretch the poll cadence.
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const quote = await runOnce(params);
        if (signal.aborted) return;
        onData(quote);
        consecutiveFailures = 0;
      } catch (err) {
        if (signal.aborted) return;
        // Permanent / validation errors are deterministic — retrying
        // at 3s intervals would just spam the caller. Surface once
        // and exit.
        if (err instanceof ToncastBetError) {
          opts.onError?.(err);
          return;
        }
        opts.onError?.(err);
        consecutiveFailures++;
      }
      // Backoff: 2^(n-1) × intervalMs, clamped. For intervalMs = 3000
      // the progression is 3s, 6s, 12s, 24s, 48s, then saturates at
      // MAX_BACKOFF_MS.
      const waitMs =
        consecutiveFailures === 0
          ? intervalMs
          : Math.min(
              intervalMs * 2 ** (consecutiveFailures - 1),
              MAX_BACKOFF_MS,
            );
      try {
        await sleep(waitMs, signal);
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
