import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSwapCacheKey, TtlCache } from "../src/cache.js";

describe("TtlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("stores and retrieves values within TTL", () => {
    const cache = new TtlCache<number>(1000);
    cache.set("a", 42);
    expect(cache.get("a")).toBe(42);
  });

  it("expires values after TTL", () => {
    const cache = new TtlCache<number>(1000);
    cache.set("a", 42);
    vi.advanceTimersByTime(1001);
    expect(cache.get("a")).toBeUndefined();
  });

  it("remember() populates on miss, returns cached on hit", async () => {
    const cache = new TtlCache<string>(1000);
    const fn = vi.fn(async () => "computed");

    const first = await cache.remember("k", fn);
    const second = await cache.remember("k", fn);

    expect(first).toBe("computed");
    expect(second).toBe("computed");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("remember() re-computes after expiry", async () => {
    const cache = new TtlCache<string>(1000);
    const fn = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("v1")
      .mockResolvedValueOnce("v2");

    await expect(cache.remember("k", fn)).resolves.toBe("v1");
    vi.advanceTimersByTime(1001);
    await expect(cache.remember("k", fn)).resolves.toBe("v2");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("clear() empties the cache", () => {
    const cache = new TtlCache<string>(1000);
    cache.set("a", "v");
    cache.set("b", "v");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("makeSwapCacheKey", () => {
  it("produces stable, deterministic keys", () => {
    const k = makeSwapCacheKey({
      offerAddress: "EQ_offer",
      askAddress: "EQ_ask",
      units: "1000000",
      slippage: "0.05",
      direction: "forward",
    });
    expect(k).toMatchInlineSnapshot(`"forward|EQ_offer|EQ_ask|1000000|0.05"`);
  });

  it("buckets close units together (5-digit prefix)", () => {
    const k1 = makeSwapCacheKey({
      offerAddress: "EQ_offer",
      askAddress: "EQ_ask",
      units: "1234567",
      slippage: "0.05",
      direction: "reverse",
    });
    const k2 = makeSwapCacheKey({
      offerAddress: "EQ_offer",
      askAddress: "EQ_ask",
      units: "1234599",
      slippage: "0.05",
      direction: "reverse",
    });
    expect(k1).toBe(k2);
  });

  it("different directions produce different keys", () => {
    const fwd = makeSwapCacheKey({
      offerAddress: "EQ_offer",
      askAddress: "EQ_ask",
      units: "1000000",
      slippage: "0.05",
      direction: "forward",
    });
    const rev = makeSwapCacheKey({
      offerAddress: "EQ_offer",
      askAddress: "EQ_ask",
      units: "1000000",
      slippage: "0.05",
      direction: "reverse",
    });
    expect(fwd).not.toBe(rev);
  });

  it("leaves short units unchanged", () => {
    const k = makeSwapCacheKey({
      offerAddress: "a",
      askAddress: "b",
      units: "42",
      slippage: "0.01",
      direction: "forward",
    });
    expect(k).toContain("|42|");
  });
});
