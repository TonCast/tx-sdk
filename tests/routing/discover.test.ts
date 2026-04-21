import { describe, expect, it } from "vitest";
import { TON_ADDRESS } from "../../src/constants.js";
import { ToncastBetError } from "../../src/errors.js";
import { discoverRoute } from "../../src/routing/discover.js";
import {
  buildSimulation,
  createMockApiClient,
} from "../_utils/mockApiClient.js";

const OFFER = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"; // USDT-ish
const MID_A = "EQAmidAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const MID_B = "EQAmidByyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";

describe("discoverRoute", () => {
  it("single-hop: direct OFFER → TON with positive minAskUnits", async () => {
    const apiClient = createMockApiClient({
      simulations: {
        [`${OFFER}→${TON_ADDRESS}`]: buildSimulation({
          offerAddress: OFFER,
          askAddress: TON_ADDRESS,
          offerUnits: "1000000",
          askUnits: "2000000000",
          minAskUnits: "1980000000",
        }),
      },
    });

    const route = await discoverRoute({
      apiClient,
      offerAddress: OFFER,
      offerUnits: "1000000",
    });
    expect(route.type).toBe("direct");
    if (route.type === "direct") {
      expect(route.leg1.minAskUnits).toBe("1980000000");
    }
  });

  it("two-hop: no direct pool, prefers higher-TVL intermediate", async () => {
    const apiClient = createMockApiClient({
      simulations: {
        // No direct OFFER→TON — omitted to force rejection.
        [`${OFFER}→${MID_A}`]: buildSimulation({
          offerAddress: OFFER,
          askAddress: MID_A,
          offerUnits: "1000000",
          askUnits: "5000000000",
          minAskUnits: "4950000000",
          askJettonWallet: "EQA_A_wallet_0000000000000000000000000000000000000",
        }),
        [`${MID_A}→${TON_ADDRESS}`]: buildSimulation({
          offerAddress: MID_A,
          askAddress: TON_ADDRESS,
          offerUnits: "5000000000",
          askUnits: "3000000000",
          minAskUnits: "2970000000",
        }),
      },
      pairs: [
        [OFFER, MID_A],
        [OFFER, MID_B],
        [MID_A, TON_ADDRESS],
        // MID_B has no pair to TON → must be filtered out.
      ],
      pools: {
        [`${OFFER}↔${MID_A}`]: [{ lpTotalSupplyUsd: "1000000" }],
      },
    });

    const route = await discoverRoute({
      apiClient,
      offerAddress: OFFER,
      offerUnits: "1000000",
    });
    expect(route.type).toBe("cross");
    if (route.type === "cross") {
      expect(route.intermediate).toBe(MID_A);
      expect(route.leg1.minAskUnits).toBe("4950000000");
      expect(route.leg2.minAskUnits).toBe("2970000000");
    }
  });

  it("throws NO_ROUTE when no route exists at all", async () => {
    // Regression for Bug 10: previously threw INVALID_ADDRESS which muddled
    // monitoring — the address is fine, there's just no liquidity for it.
    const apiClient = createMockApiClient({
      pairs: [],
    });

    try {
      await discoverRoute({
        apiClient,
        offerAddress: OFFER,
        offerUnits: "1000000",
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ToncastBetError);
      if (e instanceof ToncastBetError) expect(e.code).toBe("NO_ROUTE");
    }
  });

  it("direct sim with zero minAskUnits falls through to 2-hop", async () => {
    const apiClient = createMockApiClient({
      simulations: {
        [`${OFFER}→${TON_ADDRESS}`]: buildSimulation({
          offerAddress: OFFER,
          askAddress: TON_ADDRESS,
          offerUnits: "1000000",
          askUnits: "0",
          minAskUnits: "0",
        }),
        [`${OFFER}→${MID_A}`]: buildSimulation({
          offerAddress: OFFER,
          askAddress: MID_A,
          offerUnits: "1000000",
          askUnits: "5000000000",
          minAskUnits: "4950000000",
        }),
        [`${MID_A}→${TON_ADDRESS}`]: buildSimulation({
          offerAddress: MID_A,
          askAddress: TON_ADDRESS,
          offerUnits: "5000000000",
          askUnits: "3000000000",
          minAskUnits: "2970000000",
        }),
      },
      pairs: [
        [OFFER, MID_A],
        [MID_A, TON_ADDRESS],
      ],
      pools: { [`${OFFER}↔${MID_A}`]: [{ lpTotalSupplyUsd: "5000" }] },
    });

    const route = await discoverRoute({
      apiClient,
      offerAddress: OFFER,
      offerUnits: "1000000",
    });
    expect(route.type).toBe("cross");
  });
});
