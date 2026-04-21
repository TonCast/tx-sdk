import { Address } from "@ton/ton";
import { describe, expect, it } from "vitest";
import { buildTonBetTx } from "../../src/builders/ton.js";
import { TON_DIRECT_GAS } from "../../src/constants.js";
import { loadBatchPlaceBetsForWithRef } from "../../src/contracts/generated/pari.js";
import { ToncastBetError } from "../../src/errors.js";

const PARI_ADDRESS = "EQA7bkHU1hRX6LtvkuAASvN0YSX0tk-N9gx5Ji3oDioslLP0";
const BENEFICIARY = "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8";

describe("buildTonBetTx", () => {
  it("to = pariAddress, value = totalCost + TON_DIRECT_GAS, body = BatchPlaceBetsForWithRef", () => {
    const txParams = buildTonBetTx({
      pariAddress: PARI_ADDRESS,
      beneficiary: BENEFICIARY,
      isYes: true,
      bets: [{ yesOdds: 56, ticketsCount: 100 }],
      referral: null,
      referralPct: 0,
    });

    expect(txParams.to.equals(Address.parse(PARI_ADDRESS))).toBe(true);
    // totalCost = 0.1 fee + 100 * 0.056 = 5.7 TON; value = 5.7 + 0.05 gas
    expect(txParams.value).toBe(5_700_000_000n + TON_DIRECT_GAS);

    expect(txParams.body).toBeDefined();
    const parsed = loadBatchPlaceBetsForWithRef(txParams.body!.beginParse());
    expect(parsed.beneficiary.equals(Address.parse(BENEFICIARY))).toBe(true);
    expect(parsed.isYes).toBe(true);
    expect(parsed.referral).toBeNull();
    expect(parsed.referralPct).toBe(0n);
  });

  it("supports custom tonDirectGas override", () => {
    const txParams = buildTonBetTx({
      pariAddress: PARI_ADDRESS,
      beneficiary: BENEFICIARY,
      isYes: true,
      bets: [{ yesOdds: 50, ticketsCount: 1 }],
      referral: null,
      referralPct: 0,
      tonDirectGas: 100_000_000n,
    });
    // totalCost = 0.1 + 0.05 = 0.15 TON; value = 0.15 + 0.1 gas override
    expect(txParams.value).toBe(150_000_000n + 100_000_000n);
  });

  it("validates params (rejects invalid referral pairing)", () => {
    expect(() =>
      buildTonBetTx({
        pariAddress: PARI_ADDRESS,
        beneficiary: BENEFICIARY,
        isYes: true,
        bets: [{ yesOdds: 50, ticketsCount: 1 }],
        referral: null,
        referralPct: 5, // pct>0 + referral=null
      }),
    ).toThrow(ToncastBetError);
  });

  it("validates params (rejects empty bets)", () => {
    expect(() =>
      buildTonBetTx({
        pariAddress: PARI_ADDRESS,
        beneficiary: BENEFICIARY,
        isYes: true,
        bets: [],
        referral: null,
        referralPct: 0,
      }),
    ).toThrow(ToncastBetError);
  });

  it("referral is encoded in body", () => {
    const REFERRAL = "EQA7bkHU1hRX6LtvkuAASvN0YSX0tk-N9gx5Ji3oDioslLP0";
    const txParams = buildTonBetTx({
      pariAddress: PARI_ADDRESS,
      beneficiary: BENEFICIARY,
      isYes: false,
      bets: [{ yesOdds: 42, ticketsCount: 3 }],
      referral: REFERRAL,
      referralPct: 5,
    });
    const parsed = loadBatchPlaceBetsForWithRef(txParams.body!.beginParse());
    expect(parsed.referral?.equals(Address.parse(REFERRAL))).toBe(true);
    expect(parsed.referralPct).toBe(5n);
  });
});
