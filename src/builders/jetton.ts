import type { StonApiClient } from "@ston-fi/api";
import { type Client, type DEX, dexFactory, routerFactory } from "@ston-fi/sdk";
import type { Cell } from "@ton/ton";
import {
  DEFAULT_SLIPPAGE,
  DEX_CUSTOM_PAYLOAD_FORWARD_GAS,
  TONCAST_PROXY_ADDRESS,
} from "../constants.js";
import { calcBetCost } from "../cost.js";
import { ToncastBetError, ToncastNetworkError } from "../errors.js";
import {
  buildBatchPlaceBetsForWithRefCell,
  buildProxyForwardCell,
} from "../payload.js";
import { type DiscoveredRoute, discoverRoute } from "../routing/discover.js";
import type { BetItem, TxParams } from "../types.js";
import { validateBetParams } from "../validate.js";

type NetworkCaller = <T>(fn: () => Promise<T>, method: string) => Promise<T>;

export type BuildJettonBetTxParams = {
  /** Active `@ston-fi/sdk` Client (connected to TON endpoint). */
  tonClient: Client;
  /** Active `@ston-fi/api` StonApiClient. */
  apiClient: StonApiClient;
  /** Jetton master address being sold. */
  offerAddress: string;
  /** Amount of the offer jetton (raw units, stringified). */
  offerUnits: string;
  /** Target Pari market contract. */
  pariAddress: string;
  /** Address that will own the placed bets (proxy forwards here). */
  beneficiary: string;
  /**
   * Address that signs the tx in TonConnect and owns the jettons being
   * swapped. Passed to STON.fi as `userWalletAddress` — the router uses it
   * to derive the jetton-wallet address the outgoing transfer targets.
   *
   * Defaults to `beneficiary` for the single-user case. **MUST be set
   * explicitly when betting on behalf of another user** — otherwise
   * STON.fi routes through the beneficiary's jetton wallet, which the
   * sender cannot authorise.
   */
  senderAddress?: string;
  /** `true` → YES side, `false` → NO side. */
  isYes: boolean;
  /** Final (merged) bets. */
  bets: BetItem[];
  /** Optional referral address. */
  referral: string | null;
  /** Referral share, 0..7 (percent). */
  referralPct: number;
  /** Max acceptable swap slippage (default 0.05). */
  slippage?: string;
  /**
   * TON buffer delivered alongside the payload on proxy. Default
   * {@link DEX_CUSTOM_PAYLOAD_FORWARD_GAS} (0.1 TON).
   */
  customPayloadForwardGas?: bigint;
  /** Pre-computed route — pass in to avoid a duplicate `discoverRoute` call. */
  route?: DiscoveredRoute;
  /** Optional wrapped network caller (throttle + retry). */
  callStonApi?: NetworkCaller;
  /** Optional wrapped network caller for tonClient calls. */
  callTonClient?: NetworkCaller;
};

const defaultApiCaller: NetworkCaller = async (fn, method) => {
  try {
    return await fn();
  } catch (cause) {
    throw new ToncastNetworkError("stonApi", method, cause);
  }
};

const defaultTonCaller: NetworkCaller = async (fn, method) => {
  try {
    return await fn();
  } catch (cause) {
    throw new ToncastNetworkError("tonClient", method, cause);
  }
};

/**
 * Build a TonConnect-compatible transaction for a jetton-funded bet.
 *
 * Flow (mirrors `pari-proxy.tolk` PtonTonTransfer handling):
 *
 * 1. Build `BatchPlaceBetsForWithRef` cell (payload destined for Pari).
 * 2. Wrap it into a `ProxyForward` cell addressed to `TONCAST_PROXY_ADDRESS`.
 * 3. Discover the swap route `offerAddress → TON` (direct or 2-hop).
 * 4. Ask STON.fi router for `getSwapJetton*TxParams` with our payload attached
 *    as `dexCustomPayload` and the proxy as `receiverAddress`. The proxy
 *    will unwrap and forward to Pari.
 */
export async function buildJettonBetTx(
  params: BuildJettonBetTxParams,
): Promise<TxParams> {
  validateBetParams({
    pariAddress: params.pariAddress,
    beneficiary: params.beneficiary,
    senderAddress: params.senderAddress,
    bets: params.bets,
    referral: params.referral,
    referralPct: params.referralPct,
  });

  // Sender = who signs + owns the jettons. Defaults to beneficiary for the
  // common single-user case.
  const senderAddress = params.senderAddress ?? params.beneficiary;

  const slippage = params.slippage ?? DEFAULT_SLIPPAGE;
  const forwardGas =
    params.customPayloadForwardGas ?? DEX_CUSTOM_PAYLOAD_FORWARD_GAS;
  const callStonApi = params.callStonApi ?? defaultApiCaller;
  const callTonClient = params.callTonClient ?? defaultTonCaller;

  const { totalCost } = calcBetCost(params.bets, params.isYes);
  if (totalCost <= 0n) {
    throw new ToncastBetError(
      "EMPTY_BETS",
      `bets produced zero totalCost — cannot build jetton TX`,
    );
  }

  // 1. Inner payload (what Pari will receive).
  const pariCell = buildBatchPlaceBetsForWithRefCell({
    beneficiary: params.beneficiary,
    isYes: params.isYes,
    bets: params.bets,
    referral: params.referral,
    referralPct: params.referralPct,
  });

  // 2. Proxy envelope.
  const proxyPayload = buildProxyForwardCell({
    pariAddress: params.pariAddress,
    batchPlaceBetsForWithRef: pariCell,
  });

  // 3. Route discovery (or reuse a pre-computed route).
  const route =
    params.route ??
    (await discoverRoute({
      apiClient: params.apiClient,
      offerAddress: params.offerAddress,
      offerUnits: params.offerUnits,
      slippage,
      callStonApi,
    }));

  // 4. Build the actual TX using @ston-fi/sdk router helpers.
  //
  // `totalCost` is used as the DEX `minAskAmount` floor: the swap only
  // succeeds if it delivers ≥ totalCost TON to the proxy. Otherwise the
  // DEX reverts and the user's jetton is returned — preferable to a
  // swap that succeeds but then gets refunded at the proxy because the
  // delivered TON was below `totalCost + CONTRACT_RESERVE` (which would
  // burn swap gas for nothing, and is a real risk for large bets under
  // the old `minAskAmount = minAskUnits` scheme where the gap could
  // exceed `DEX_CUSTOM_PAYLOAD_FORWARD_GAS`).
  if (route.type === "direct") {
    return await buildDirectSwapTx({
      tonClient: params.tonClient,
      route,
      offerAddress: params.offerAddress,
      offerUnits: params.offerUnits,
      userWalletAddress: senderAddress,
      proxyPayload,
      forwardGas,
      totalCost,
      callTonClient,
    });
  }

  return await buildCrossSwapTx({
    tonClient: params.tonClient,
    route,
    offerAddress: params.offerAddress,
    offerUnits: params.offerUnits,
    userWalletAddress: senderAddress,
    proxyPayload,
    forwardGas,
    totalCost,
    callTonClient,
  });
}

async function buildDirectSwapTx(args: {
  tonClient: Client;
  route: Extract<DiscoveredRoute, { type: "direct" }>;
  offerAddress: string;
  offerUnits: string;
  userWalletAddress: string;
  proxyPayload: Cell;
  forwardGas: bigint;
  /** Minimum TON the DEX must deliver (= `calcBetCost(bets, isYes).totalCost`). */
  totalCost: bigint;
  callTonClient: NetworkCaller;
}): Promise<TxParams> {
  const { leg1 } = args.route;

  const contracts = dexFactory(leg1.router);
  const router = args.tonClient.open(
    contracts.Router.create(leg1.router.address),
  );
  const proxyTon = contracts.pTON.create(leg1.router.ptonMasterAddress);

  const txParams = await args.callTonClient(
    () =>
      router.getSwapJettonToTonTxParams({
        userWalletAddress: args.userWalletAddress,
        receiverAddress: TONCAST_PROXY_ADDRESS,
        offerJettonAddress: args.offerAddress,
        offerAmount: args.offerUnits,
        // Hard floor: swap must deliver ≥ totalCost TON, or DEX reverts
        // the whole swap (user's jetton is refunded). Previously we used
        // `leg1.minAskUnits` (= totalCost × (1 − slippage)), which let
        // the swap succeed while delivering < totalCost — that TON then
        // got refunded by the proxy, burning gas and confusing the user.
        // Using totalCost directly removes the "dead zone" that grew
        // linearly with bet size (see README for the math).
        minAskAmount: args.totalCost.toString(),
        proxyTon,
        gasAmount: leg1.gasParams.gasBudget ?? "300000000",
        forwardGasAmount: leg1.gasParams.forwardGas ?? "200000000",
        dexCustomPayload: args.proxyPayload,
        dexCustomPayloadForwardGasAmount: args.forwardGas.toString(),
      }),
    "getSwapJettonToTonTxParams",
  );

  return txParams;
}

async function buildCrossSwapTx(args: {
  tonClient: Client;
  route: Extract<DiscoveredRoute, { type: "cross" }>;
  offerAddress: string;
  offerUnits: string;
  userWalletAddress: string;
  proxyPayload: Cell;
  forwardGas: bigint;
  /** Minimum TON the full 2-hop swap must deliver. */
  totalCost: bigint;
  callTonClient: NetworkCaller;
}): Promise<TxParams> {
  const { leg1, leg2, intermediate } = args.route;

  const leg1Budget = BigInt(leg1.gasParams.gasBudget ?? "300000000");
  const leg2Budget = BigInt(leg2.gasParams.gasBudget ?? "300000000");
  const leg1Fwd = BigInt(leg1.gasParams.forwardGas);
  const leg2Fwd = BigInt(leg2.gasParams.forwardGas);

  const contractsA = dexFactory(leg1.router);
  const routerA = args.tonClient.open(
    contractsA.Router.create(leg1.router.address),
  );

  // Leg 2 body — pure cell builder, no provider needed. routerFactory
  // dispatches to the correct v2+ class via leg2.router info; the cast is
  // safe because createSwapBody is identical across all v2+ routers.
  const bodyBuilder = routerFactory(leg2.router) as InstanceType<
    typeof DEX.v2_1.Router.CPI
  >;
  if (!leg2.askJettonWallet) {
    throw new ToncastNetworkError(
      "stonApi",
      "simulateSwap",
      new Error(
        `leg2.askJettonWallet is missing for ${intermediate} → TON simulation`,
      ),
    );
  }
  const leg2Body = await bodyBuilder.createSwapBody({
    askJettonWalletAddress: leg2.askJettonWallet,
    receiverAddress: TONCAST_PROXY_ADDRESS,
    refundAddress: args.userWalletAddress,
    // Leg 2 is the TON-producing hop. Its `minAskAmount` is the hard
    // floor for TON delivered to the proxy — same reasoning as the
    // direct-swap case: below totalCost ⇒ revert the whole swap.
    minAskAmount: args.totalCost.toString(),
    dexCustomPayload: args.proxyPayload,
    dexCustomPayloadForwardGasAmount: args.forwardGas.toString(),
  });

  const txParams = await args.callTonClient(
    () =>
      routerA.getSwapJettonToJettonTxParams({
        userWalletAddress: args.userWalletAddress,
        receiverAddress: leg2.router.address,
        offerJettonAddress: args.offerAddress,
        askJettonAddress: intermediate,
        offerAmount: args.offerUnits,
        minAskAmount: leg1.minAskUnits,
        dexCustomPayload: leg2Body,
        dexCustomPayloadForwardGasAmount: leg2Budget.toString(),
        gasAmount: (leg1Budget + leg2Budget).toString(),
        forwardGasAmount: (leg1Fwd + leg2Fwd).toString(),
      }),
    "getSwapJettonToJettonTxParams",
  );

  return txParams;
}
