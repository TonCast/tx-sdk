import type { StonApiClient } from "@ston-fi/api";
import { makeSwapCacheKey, TtlCache } from "./cache.js";
import { DEFAULT_SLIPPAGE, DEX_VERSION, TON_ADDRESS } from "./constants.js";
import { ToncastBetError } from "./errors.js";
import { grossUpForSlippage } from "./utils/slippage.js";

type NetworkCaller = <T>(fn: () => Promise<T>, method: string) => Promise<T>;

type Simulation = Awaited<ReturnType<StonApiClient["simulateSwap"]>>;

export type RatesClient = {
  /**
   * Forward simulation: "if I offer `offerUnits`, how much will I receive?"
   */
  simulateForward(params: {
    offerAddress: string;
    askAddress: string;
    offerUnits: string;
    slippage?: string;
  }): Promise<Simulation>;

  /**
   * Reverse simulation for a direct `offer → TON` swap: "to receive at least
   * `targetTonUnits`, how much jetton must I offer?"
   */
  simulateReverseToTon(params: {
    offerAddress: string;
    targetTonUnits: bigint;
    slippage?: string;
  }): Promise<Simulation>;

  /**
   * Reverse simulation for a 2-hop `offer → intermediate → TON` swap. Chains
   * two reverse calls: first sizes the intermediate amount needed to yield
   * `targetTonUnits`; then sizes the offer amount that yields that
   * intermediate amount.
   *
   * Returns forward-compatible simulations (`offerUnits` / `askUnits` set)
   * ready to be passed to `buildJettonBetTx` as the `cross` route.
   */
  simulateReverseCrossToTon(params: {
    offerAddress: string;
    intermediate: string;
    targetTonUnits: bigint;
    slippage?: string;
  }): Promise<{ leg1: Simulation; leg2: Simulation }>;

  /** Release all cached entries. */
  clearCache(): void;
};

export type CreateRatesClientOptions = {
  apiClient: StonApiClient;
  callStonApi: NetworkCaller;
  rateCacheTtlMs: number;
};

export function createRatesClient(opts: CreateRatesClientOptions): RatesClient {
  const cache = new TtlCache<Simulation>(opts.rateCacheTtlMs);

  const simulateForward: RatesClient["simulateForward"] = async ({
    offerAddress,
    askAddress,
    offerUnits,
    slippage = DEFAULT_SLIPPAGE,
  }) => {
    const key = makeSwapCacheKey({
      offerAddress,
      askAddress,
      units: offerUnits,
      slippage,
      direction: "forward",
    });
    return cache.remember(key, () =>
      opts.callStonApi(
        () =>
          opts.apiClient.simulateSwap({
            offerAddress,
            askAddress,
            offerUnits,
            slippageTolerance: slippage,
            dexVersion: DEX_VERSION,
          }),
        "simulateSwap",
      ),
    );
  };

  const simulateReverseToTon: RatesClient["simulateReverseToTon"] = async ({
    offerAddress,
    targetTonUnits,
    slippage = DEFAULT_SLIPPAGE,
  }) => {
    // Gross up the ask so that minAskUnits (DEX's on-chain rejection floor,
    // ≈ askUnits × (1 − slippage)) stays ≥ targetTonUnits. Otherwise the
    // swap can legally deliver < totalCost, and the Pari proxy refunds the
    // user instead of placing the bet — observed on mainnet with a ~0.004%
    // drift well inside a 5% slippage band.
    const askUnits = grossUpForSlippage(targetTonUnits, slippage).toString();
    const key = makeSwapCacheKey({
      offerAddress,
      askAddress: TON_ADDRESS,
      units: askUnits,
      slippage,
      direction: "reverse",
    });
    return cache.remember(key, () =>
      opts.callStonApi(
        () =>
          opts.apiClient.simulateReverseSwap({
            offerAddress,
            askAddress: TON_ADDRESS,
            askUnits,
            slippageTolerance: slippage,
            dexVersion: DEX_VERSION,
          }),
        "simulateReverseSwap",
      ),
    );
  };

  const simulateReverseCrossToTon: RatesClient["simulateReverseCrossToTon"] =
    async ({
      offerAddress,
      intermediate,
      targetTonUnits,
      slippage = DEFAULT_SLIPPAGE,
    }) => {
      // Leg 2: intermediate → TON. Gross up so leg2.minAskUnits stays
      // ≥ targetTonUnits (the final delivery floor the Pari proxy needs).
      const leg2AskUnits = grossUpForSlippage(
        targetTonUnits,
        slippage,
      ).toString();
      const leg2Key = makeSwapCacheKey({
        offerAddress: intermediate,
        askAddress: TON_ADDRESS,
        units: leg2AskUnits,
        slippage,
        direction: "reverse",
      });
      const leg2 = await cache.remember(leg2Key, () =>
        opts.callStonApi(
          () =>
            opts.apiClient.simulateReverseSwap({
              offerAddress: intermediate,
              askAddress: TON_ADDRESS,
              askUnits: leg2AskUnits,
              slippageTolerance: slippage,
              dexVersion: DEX_VERSION,
            }),
          "simulateReverseSwap",
        ),
      );

      // Leg 1: offer → intermediate, targeting the intermediate amount that
      // leg 2 determined we need. Guard against zero / missing response
      // from STON.fi — chaining with a zero target silently produces an
      // invalid leg1 (esp. the offer jetton amount).
      if (!leg2.offerUnits || BigInt(leg2.offerUnits) <= 0n) {
        throw new ToncastBetError(
          "NO_ROUTE",
          `Cross-hop reverse: leg 2 (${intermediate} → TON) returned zero offerUnits for targetTonUnits=${targetTonUnits}`,
        );
      }
      // Leg 1 must deliver enough of `intermediate` for leg 2 to clear its
      // own slippage-adjusted minimum (`leg2.offerUnits`). Without the same
      // gross-up, leg 1 may legally under-deliver the intermediate, leg 2
      // reverts, and the user is refunded in the intermediate jetton —
      // worse UX than a clean "swap didn't execute".
      const leg1AskUnits = grossUpForSlippage(
        BigInt(leg2.offerUnits),
        slippage,
      ).toString();
      const leg1Key = makeSwapCacheKey({
        offerAddress,
        askAddress: intermediate,
        units: leg1AskUnits,
        slippage,
        direction: "reverse",
      });
      const leg1 = await cache.remember(leg1Key, () =>
        opts.callStonApi(
          () =>
            opts.apiClient.simulateReverseSwap({
              offerAddress,
              askAddress: intermediate,
              askUnits: leg1AskUnits,
              slippageTolerance: slippage,
              dexVersion: DEX_VERSION,
            }),
          "simulateReverseSwap",
        ),
      );

      return { leg1, leg2 };
    };

  return {
    simulateForward,
    simulateReverseToTon,
    simulateReverseCrossToTon,
    clearCache: () => cache.clear(),
  };
}
