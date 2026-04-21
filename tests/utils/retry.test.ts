import { beforeEach, describe, expect, it, vi } from "vitest";
import { withRetry } from "../../src/utils/retry.js";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("returns result from first attempt on success", async () => {
    const fn = vi.fn(async () => "ok");
    const p = withRetry(fn, { maxRetries: 3, delayMs: 100 });
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries once on transient failure, then succeeds (total 2 calls)", async () => {
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error("transient");
      return "ok";
    });

    const p = withRetry(fn, { maxRetries: 1, delayMs: 100 });
    // Advance through the first sleep.
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rejects with last error after exhausting retries", async () => {
    const err = new Error("boom");
    const fn = vi.fn(async () => {
      throw err;
    });

    const p = withRetry(fn, { maxRetries: 2, delayMs: 50 });
    // Prevent unhandled rejection while we advance timers.
    const caught = p.catch((e) => e);
    // 3 attempts total; 2 sleeps between them (50 + 100 = 150ms).
    await vi.advanceTimersByTimeAsync(200);
    await expect(caught).resolves.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("maxRetries=0 → single call, no retry", async () => {
    const fn = vi.fn(async () => {
      throw new Error("no retry");
    });
    const p = withRetry(fn, { maxRetries: 0, delayMs: 100 });
    await expect(p).rejects.toThrow("no retry");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses linear backoff: 100ms, 200ms, 300ms for maxRetries=3", async () => {
    const callTimes: number[] = [];
    let attempt = 0;
    const fn = vi.fn(async () => {
      callTimes.push(Date.now());
      attempt++;
      if (attempt <= 3) throw new Error("retry me");
      return "ok";
    });

    const startedAt = Date.now();
    const p = withRetry(fn, { maxRetries: 3, delayMs: 100 });
    // 100 + 200 + 300 = 600ms total between retries.
    await vi.advanceTimersByTimeAsync(700);
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(4);
    expect(callTimes[1]! - startedAt).toBeGreaterThanOrEqual(100);
    expect(callTimes[2]! - callTimes[1]!).toBeGreaterThanOrEqual(200);
    expect(callTimes[3]! - callTimes[2]!).toBeGreaterThanOrEqual(300);
  });

  it("HTTP 400 is NOT retried — throws immediately on first failure", async () => {
    // Simulates ofetch-style error shape from STON.fi API.
    const err = Object.assign(new Error("1010: Could not find pool address"), {
      statusCode: 400,
    });
    const fn = vi.fn(async () => {
      throw err;
    });
    const p = withRetry(fn, { maxRetries: 3, delayMs: 100 });
    await expect(p).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("HTTP 400 in error.cause is detected (one level deep)", async () => {
    const inner = Object.assign(new Error("pool not found"), { status: 400 });
    const wrapper = Object.assign(new Error("stonApi.simulateSwap failed"), {
      cause: inner,
    });
    const fn = vi.fn(async () => {
      throw wrapper;
    });
    const p = withRetry(fn, { maxRetries: 3, delayMs: 100 });
    await expect(p).rejects.toBe(wrapper);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("HTTP 429 IS retried (rate limit — transient)", async () => {
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        throw Object.assign(new Error("rate limited"), { statusCode: 429 });
      }
      return "ok";
    });
    const p = withRetry(fn, { maxRetries: 2, delayMs: 100 });
    await vi.advanceTimersByTimeAsync(150);
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("HTTP 500 IS retried", async () => {
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 3) {
        throw Object.assign(new Error("server error"), { statusCode: 500 });
      }
      return "ok";
    });
    const p = withRetry(fn, { maxRetries: 3, delayMs: 50 });
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("AbortSignal rejects the retry loop", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      throw new Error("transient");
    });

    const p = withRetry(fn, {
      maxRetries: 5,
      delayMs: 200,
      signal: controller.signal,
    });

    // First call happens immediately; let it finish and start the sleep.
    await Promise.resolve();
    controller.abort(new Error("cancelled"));
    await expect(p).rejects.toThrow("cancelled");
  });
});
