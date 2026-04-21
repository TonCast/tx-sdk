import { describe, expect, it, vi } from "vitest";
import { buildJettonBetTx } from "../../src/builders/jetton.js";
import { ToncastBetError } from "../../src/errors.js";
import {
  buildSimulation,
  createMockApiClient,
} from "../_utils/mockApiClient.js";

const OFFER = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const TON = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const PARI = "EQA7bkHU1hRX6LtvkuAASvN0YSX0tk-N9gx5Ji3oDioslLP0";
const BENEFICIARY = "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8";

// Minimal Client stub — buildJettonBetTx passes it to dexFactory().Router.create(...).open(...)
// We don't actually care about the real txParams the stub returns, only that the
// builder routes correctly and validates its inputs.
function makeFakeClient() {
  const open = vi.fn((_contract: unknown) => ({
    getSwapJettonToTonTxParams: vi.fn(async () => ({
      to: { equals: () => true } as unknown,
      value: 600_000_000n,
      body: null,
    })),
    getSwapJettonToJettonTxParams: vi.fn(async () => ({
      to: { equals: () => true } as unknown,
      value: 900_000_000n,
      body: null,
    })),
  }));
  return { open } as unknown as import("@ston-fi/sdk").Client;
}

describe("buildJettonBetTx minAskAmount floor (regression: dead-zone)", () => {
  // Rationale: historically the SDK set `minAskAmount = leg.minAskUnits`
  // = totalCost × (1 − slippage). That created a "dead zone" where the
  // DEX swap succeeded but the proxy refunded because the TON delivered
  // was below `totalCost + CONTRACT_RESERVE`. The gap grew linearly with
  // totalCost and on bets ≥ 2 TON started causing random refunds.
  //
  // Fix: always pass `minAskAmount = totalCost`. DEX reverts the whole
  // swap if it cannot deliver at least totalCost → user's jetton is
  // safe, no gas burned on the proxy. Locked in via these tests.

  function captureTxParams(): {
    capture: { minAskAmount?: string };
    tonClient: import("@ston-fi/sdk").Client;
  } {
    const capture: { minAskAmount?: string } = {};
    const open = vi.fn(() => ({
      getSwapJettonToTonTxParams: vi.fn(
        async (args: { minAskAmount: string }) => {
          capture.minAskAmount = args.minAskAmount;
          return {
            to: { equals: () => true } as unknown,
            value: 600_000_000n,
            body: null,
          };
        },
      ),
      getSwapJettonToJettonTxParams: vi.fn(
        async (args: { minAskAmount: string }) => {
          capture.minAskAmount = args.minAskAmount;
          return {
            to: { equals: () => true } as unknown,
            value: 900_000_000n,
            body: null,
          };
        },
      ),
    }));
    return {
      capture,
      tonClient: { open } as unknown as import("@ston-fi/sdk").Client,
    };
  }

  it("direct swap: minAskAmount === totalCost (not minAskUnits)", async () => {
    // bets = [{56, 100}] → totalCost = 5.7 TON.
    // Old behaviour would pass minAskUnits = 5.415 TON, creating a 0.285
    // TON dead zone above DEX_CUSTOM_PAYLOAD_FORWARD_GAS (0.1 TON) and
    // causing random proxy refunds. New behaviour must pass 5.7 TON.
    const { capture, tonClient } = captureTxParams();
    await buildJettonBetTx({
      tonClient,
      apiClient: createMockApiClient(),
      offerAddress: OFFER,
      offerUnits: "10000000",
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      bets: [{ yesOdds: 56, ticketsCount: 100 }],
      referral: null,
      referralPct: 0,
      route: {
        type: "direct",
        leg1: buildSimulation({
          offerAddress: OFFER,
          askAddress: TON,
          offerUnits: "10000000",
          askUnits: "5700000000",
          minAskUnits: "5415000000", // would have been used previously
        }),
      },
    });
    expect(capture.minAskAmount).toBe("5700000000");
  });

  it("cross-hop: leg1 uses minAskUnits (intermediate), leg2Body uses totalCost (TON)", async () => {
    const { capture, tonClient } = captureTxParams();
    const INTERMEDIATE = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_uSd";
    await buildJettonBetTx({
      tonClient,
      apiClient: createMockApiClient(),
      offerAddress: OFFER,
      offerUnits: "10000000",
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      bets: [{ yesOdds: 56, ticketsCount: 100 }],
      referral: null,
      referralPct: 0,
      route: {
        type: "cross",
        intermediate: INTERMEDIATE,
        leg1: buildSimulation({
          offerAddress: OFFER,
          askAddress: INTERMEDIATE,
          offerUnits: "10000000",
          askUnits: "3000000",
          minAskUnits: "2850000", // leg1 floor is intermediate — kept as-is
        }),
        leg2: buildSimulation({
          offerAddress: INTERMEDIATE,
          askAddress: TON,
          offerUnits: "3000000",
          askUnits: "5700000000",
          minAskUnits: "5415000000", // what old code would pass as leg2 floor
        }),
      },
    });
    // For the outer leg1 tx the intermediate floor is preserved — we
    // don't have a hard target in intermediate terms, only final TON.
    expect(capture.minAskAmount).toBe("2850000");
    // (leg2.minAskAmount lives inside the leg2Body cell; that's captured
    // in a separate build assertion — see src/builders/jetton.ts comment.)
  });
});

describe("buildJettonBetTx validation", () => {
  it("rejects invalid bets (empty)", async () => {
    const apiClient = createMockApiClient();
    const tonClient = makeFakeClient();

    await expect(
      buildJettonBetTx({
        tonClient,
        apiClient,
        offerAddress: OFFER,
        offerUnits: "1000000",
        pariAddress: PARI,
        beneficiary: BENEFICIARY,
        isYes: true,
        bets: [],
        referral: null,
        referralPct: 0,
      }),
    ).rejects.toBeInstanceOf(ToncastBetError);
  });

  it("rejects invalid referral combo", async () => {
    const apiClient = createMockApiClient();
    const tonClient = makeFakeClient();

    await expect(
      buildJettonBetTx({
        tonClient,
        apiClient,
        offerAddress: OFFER,
        offerUnits: "1000000",
        pariAddress: PARI,
        beneficiary: BENEFICIARY,
        isYes: true,
        bets: [{ yesOdds: 56, ticketsCount: 1 }],
        referral: null,
        referralPct: 3,
      }),
    ).rejects.toBeInstanceOf(ToncastBetError);
  });
});

describe("buildJettonBetTx routing", () => {
  it("uses pre-computed direct route without calling API", async () => {
    const apiClient = createMockApiClient();
    const tonClient = makeFakeClient();

    const directRoute = {
      type: "direct" as const,
      leg1: buildSimulation({
        offerAddress: OFFER,
        askAddress: TON,
        offerUnits: "1000000",
        askUnits: "2000000000",
        minAskUnits: "1980000000",
      }),
    };

    const tx = await buildJettonBetTx({
      tonClient,
      apiClient,
      offerAddress: OFFER,
      offerUnits: "1000000",
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      isYes: true,
      bets: [{ yesOdds: 56, ticketsCount: 1 }],
      referral: null,
      referralPct: 0,
      route: directRoute,
    });

    expect(tx).toBeDefined();
    // Route discovery should not have been called.
    expect(
      (apiClient.simulateSwap as unknown as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBe(0);
  });

  it("passes senderAddress (not beneficiary) to STON.fi router when the two differ", async () => {
    // Regression: beneficiary (ticket owner) and senderAddress (signing
    // wallet, jetton holder) are two different things. If the SDK passes
    // beneficiary as `userWalletAddress`, STON.fi derives the beneficiary's
    // jetton wallet — the sender's wallet cannot authorise that transfer.
    const SENDER = "UQAREREREREREREREREREREREREREREREREREREREREREbvW";
    const apiClient = createMockApiClient();
    let capturedUserWallet: string | undefined;
    const open = vi.fn(() => ({
      getSwapJettonToTonTxParams: vi.fn(
        async (args: { userWalletAddress: string }) => {
          capturedUserWallet = args.userWalletAddress;
          return {
            to: { equals: () => true } as unknown,
            value: 600_000_000n,
            body: null,
          };
        },
      ),
      getSwapJettonToJettonTxParams: vi.fn(),
    }));
    const tonClient = {
      open,
    } as unknown as import("@ston-fi/sdk").Client;

    const directRoute = {
      type: "direct" as const,
      leg1: buildSimulation({
        offerAddress: OFFER,
        askAddress: TON,
        offerUnits: "1000000",
        askUnits: "2000000000",
        minAskUnits: "1980000000",
      }),
    };

    await buildJettonBetTx({
      tonClient,
      apiClient,
      offerAddress: OFFER,
      offerUnits: "1000000",
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      senderAddress: SENDER, // ← distinct from beneficiary
      isYes: true,
      bets: [{ yesOdds: 56, ticketsCount: 1 }],
      referral: null,
      referralPct: 0,
      route: directRoute,
    });

    expect(capturedUserWallet).toBe(SENDER);
    expect(capturedUserWallet).not.toBe(BENEFICIARY);
  });

  it("falls back to beneficiary as userWalletAddress when senderAddress omitted", async () => {
    // Single-user case: BENEFICIARY === SENDER. Keep the short-form API
    // working for the common path where the signer and the owner match.
    const apiClient = createMockApiClient();
    let capturedUserWallet: string | undefined;
    const open = vi.fn(() => ({
      getSwapJettonToTonTxParams: vi.fn(
        async (args: { userWalletAddress: string }) => {
          capturedUserWallet = args.userWalletAddress;
          return {
            to: { equals: () => true } as unknown,
            value: 600_000_000n,
            body: null,
          };
        },
      ),
      getSwapJettonToJettonTxParams: vi.fn(),
    }));
    const tonClient = {
      open,
    } as unknown as import("@ston-fi/sdk").Client;

    await buildJettonBetTx({
      tonClient,
      apiClient,
      offerAddress: OFFER,
      offerUnits: "1000000",
      pariAddress: PARI,
      beneficiary: BENEFICIARY,
      // senderAddress intentionally omitted
      isYes: true,
      bets: [{ yesOdds: 56, ticketsCount: 1 }],
      referral: null,
      referralPct: 0,
      route: {
        type: "direct",
        leg1: buildSimulation({
          offerAddress: OFFER,
          askAddress: TON,
          offerUnits: "1000000",
          askUnits: "2000000000",
          minAskUnits: "1980000000",
        }),
      },
    });

    expect(capturedUserWallet).toBe(BENEFICIARY);
  });
});
