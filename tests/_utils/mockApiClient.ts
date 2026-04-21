import type { StonApiClient } from "@ston-fi/api";
import { vi } from "vitest";
import { TON_ADDRESS } from "../../src/constants.js";

export type SwapSimulation = Awaited<ReturnType<StonApiClient["simulateSwap"]>>;

// Deterministic valid TON addresses generated from fixed hash bytes
// (Address(0, [0x01;32]) etc.). Used purely as well-formed TON addresses
// that pass checksum validation — no on-chain calls happen in tests.
const FAKE_ROUTER_ADDR = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const FAKE_PTON_MASTER = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";
const FAKE_WALLET = "EQADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA8id";
const FAKE_POOL = "EQAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBMWg";

const FAKE_ROUTER = {
  address: FAKE_ROUTER_ADDR,
  majorVersion: 2,
  minorVersion: 1,
  ptonMasterAddress: FAKE_PTON_MASTER,
  ptonVersion: "v2_1",
  ptonWalletAddress: FAKE_WALLET,
  routerType: "constant_product",
  poolCreationEnabled: true,
} as const;

const FAKE_FEE_ADDR = FAKE_POOL;

/**
 * Produce a minimal valid simulation result. Real API returns many more
 * fields, but only these are read by tx-sdk.
 */
export function buildSimulation(overrides: {
  offerAddress: string;
  askAddress: string;
  offerUnits: string;
  askUnits: string;
  minAskUnits: string;
  priceImpact?: string;
  askJettonWallet?: string;
}): SwapSimulation {
  return {
    askAddress: overrides.askAddress,
    askJettonWallet: overrides.askJettonWallet ?? FAKE_WALLET,
    askUnits: overrides.askUnits,
    feeAddress: FAKE_FEE_ADDR,
    feePercent: "0.002",
    feeUnits: "0",
    minAskUnits: overrides.minAskUnits,
    offerAddress: overrides.offerAddress,
    offerJettonWallet: FAKE_WALLET,
    offerUnits: overrides.offerUnits,
    poolAddress: FAKE_POOL,
    priceImpact: overrides.priceImpact ?? "0.001",
    routerAddress: FAKE_ROUTER.address,
    router: { ...FAKE_ROUTER },
    slippageTolerance: "0.01",
    swapRate: "1",
    recommendedSlippageTolerance: "0.01",
    recommendedMinAskUnits: overrides.minAskUnits,
    gasParams: {
      gasBudget: "300000000",
      forwardGas: "200000000",
      estimatedGasConsumption: "0",
    },
  };
}

export type MockApiClientOptions = {
  /** Simulations keyed by `"offer→ask"`. Missing keys will reject. */
  simulations?: Record<string, SwapSimulation>;
  pairs?: Array<[string, string]>;
  pools?: Record<
    string,
    Array<{ lpTotalSupplyUsd?: string; address?: string }>
  >;
  asset?: Partial<Awaited<ReturnType<StonApiClient["getAsset"]>>> & {
    decimals?: number;
    symbol?: string;
  };
};

function simKey(offer: string, ask: string): string {
  return `${offer}→${ask}`;
}

export function createMockApiClient(
  options: MockApiClientOptions = {},
): StonApiClient {
  const simulations = options.simulations ?? {};
  const pairs = options.pairs ?? [];
  const pools = options.pools ?? {};

  const simulateSwap = vi.fn(
    async ({
      offerAddress,
      askAddress,
    }: {
      offerAddress: string;
      askAddress: string;
    }) => {
      const sim = simulations[simKey(offerAddress, askAddress)];
      if (!sim) {
        throw new Error(
          `mockApiClient.simulateSwap: no fixture for ${offerAddress} → ${askAddress}`,
        );
      }
      return sim;
    },
  );

  const getSwapPairs = vi.fn(async () => pairs);

  const getPoolsByAssetPair = vi.fn(
    async ({
      asset0Address,
      asset1Address,
    }: {
      asset0Address: string;
      asset1Address: string;
    }) => {
      return (
        pools[`${asset0Address}↔${asset1Address}`] ??
        pools[`${asset1Address}↔${asset0Address}`] ??
        []
      );
    },
  );

  const getAsset = vi.fn(async (address: string) => ({
    balance: undefined,
    blacklisted: false,
    community: false,
    contractAddress: address,
    decimals: options.asset?.decimals ?? 9,
    defaultSymbol: true,
    deprecated: false,
    kind: (address === TON_ADDRESS ? "Ton" : "Jetton") as
      | "Ton"
      | "Wton"
      | "Jetton"
      | "NotAnAsset",
    priority: 0,
    symbol: options.asset?.symbol ?? "MOCK",
    tags: [],
  }));

  return {
    simulateSwap,
    getSwapPairs,
    getPoolsByAssetPair,
    getAsset,
  } as unknown as StonApiClient;
}
