import { describe, expect, it, vi } from "vitest";
import { Throttler } from "../../src/utils/throttle.js";

describe("Throttler", () => {
  it("first call has no artificial delay", async () => {
    vi.useFakeTimers();
    const t = new Throttler(100);
    const fn = vi.fn(async () => "ok");
    const start = Date.now();
    const p = t.run(fn);
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBe("ok");
    expect(Date.now() - start).toBeLessThan(5);
  });

  it("second call waits minIntervalMs after the first", async () => {
    vi.useFakeTimers();
    const t = new Throttler(100);
    const starts: number[] = [];
    const fn = () => {
      starts.push(Date.now());
      return Promise.resolve("ok");
    };

    const p1 = t.run(fn);
    const p2 = t.run(fn);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([p1, p2]);
    expect(starts.length).toBe(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(100);
  });

  it("three parallel calls get serialised with minIntervalMs between starts", async () => {
    vi.useFakeTimers();
    const t = new Throttler(50);
    const starts: number[] = [];
    const fn = () => {
      starts.push(Date.now());
      return Promise.resolve("ok");
    };

    const promises = [t.run(fn), t.run(fn), t.run(fn)];
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(promises);
    expect(starts.length).toBe(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(50);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(50);
  });

  it("errors in one call don't break the chain", async () => {
    vi.useFakeTimers();
    const t = new Throttler(20);
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");

    const p1 = t.run(fn);
    const p2 = t.run(fn);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("minIntervalMs=0 runs without any artificial delay", async () => {
    const t = new Throttler(0);
    const starts: number[] = [];
    const fn = () => {
      starts.push(Date.now());
      return Promise.resolve("ok");
    };

    const start = Date.now();
    await Promise.all([t.run(fn), t.run(fn), t.run(fn)]);
    expect(Date.now() - start).toBeLessThan(20);
  });
});
