import { sleep } from "./sleep.js";

export type RetryOptions = {
  /** Number of additional attempts after the first failure (total calls = maxRetries + 1). */
  maxRetries: number;
  /** Base delay. Actual backoff is linear: `delayMs * (attempt + 1)`. */
  delayMs: number;
  /** Optional abort signal — cancels any pending delay and breaks out. */
  signal?: AbortSignal;
};

/**
 * Execute `fn`, retrying on thrown errors up to `maxRetries` times with a
 * linear backoff (`delayMs`, `2 * delayMs`, `3 * delayMs`, …).
 *
 * HTTP 400 responses are NOT retried — they indicate a permanent bad-request
 * from upstream (e.g. STON.fi "pool not found" for a token pair that has no
 * direct pool). Retrying them burns time and network without any chance of
 * success. All OTHER errors — including 429 (rate limit), 5xx (server),
 * timeouts, `TypeError`s from network libraries, and anything without a
 * status code — are treated as potentially transient and retried.
 *
 * **IMPORTANT** — `fn` must throw ONLY transient/network errors.
 * - Do NOT let `fn` throw `ToncastBetError` (validation/programmer errors):
 *   they are deterministic and will simply re-throw on every retry, wasting
 *   `maxRetries + 1` attempts and up to `∑ delayMs * (i + 1)` of real time.
 * - Validate inputs BEFORE invoking `withRetry`, so only network/RPC
 *   exceptions reach this layer.
 *
 * The SDK's own usage pattern follows this: `validateBetParams` runs
 * synchronously before any `callStonApi` / `callTonClient` wrapper, so
 * retries only see upstream failures.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (isBadRequest(error)) {
        // 400 is a deterministic client error — retrying the same request
        // will produce the same 400. Skip the remaining attempts.
        throw error;
      }
      if (attempt < opts.maxRetries) {
        await sleep(opts.delayMs * (attempt + 1), opts.signal);
      }
    }
  }
  throw lastError;
}

/**
 * Extract an HTTP status code from a thrown error, then return `true` if it
 * is exactly 400. Covers the common shapes populated by popular HTTP
 * libraries (`ofetch`, `undici`, `axios`, `fetch` itself).
 *
 * Deliberately NOT matching 401/403/404/422/other 4xx: although those are
 * also non-retriable in principle, the SDK sees them rarely and users have
 * asked for a narrow carve-out. Rate-limit 429 MUST stay retriable so the
 * Throttler + `withRetry` combination continues to self-heal under load.
 */
function isBadRequest(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as {
    statusCode?: number;
    status?: number;
    response?: { status?: number; statusCode?: number };
    cause?: unknown;
  };
  const code =
    e.statusCode ?? e.status ?? e.response?.status ?? e.response?.statusCode;
  if (code === 400) return true;
  // Some wrappers bury the HTTP error in `cause`. Recurse one level.
  if (e.cause !== undefined && e.cause !== null && e.cause !== error) {
    return isBadRequest(e.cause);
  }
  return false;
}
