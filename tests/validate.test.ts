import { describe, expect, it } from "vitest";
import { ToncastBetError } from "../src/errors.js";
import type { BetItem } from "../src/types.js";
import { validateBetParams } from "../src/validate.js";

const BENEFICIARY = "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8";
const OTHER_ADDR = "EQA7bkHU1hRX6LtvkuAASvN0YSX0tk-N9gx5Ji3oDioslLP0";

const validBets: BetItem[] = [{ yesOdds: 56, ticketsCount: 100 }];

function expectCode(fn: () => void, code: string) {
  try {
    fn();
    throw new Error("Expected ToncastBetError, but none was thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(ToncastBetError);
    expect((e as ToncastBetError).code).toBe(code);
  }
}

describe("validateBetParams", () => {
  it("accepts a minimal valid set", () => {
    expect(() =>
      validateBetParams({
        beneficiary: BENEFICIARY,
        bets: validBets,
        referral: null,
        referralPct: 0,
      }),
    ).not.toThrow();
  });

  it("accepts referral with pct 1..7", () => {
    expect(() =>
      validateBetParams({
        beneficiary: BENEFICIARY,
        bets: validBets,
        referral: OTHER_ADDR,
        referralPct: 7,
      }),
    ).not.toThrow();
  });

  describe("referralPct", () => {
    it("rejects > 7 → INVALID_REFERRAL_PCT", () => {
      expectCode(
        () =>
          validateBetParams({
            beneficiary: BENEFICIARY,
            bets: validBets,
            referral: OTHER_ADDR,
            referralPct: 8,
          }),
        "INVALID_REFERRAL_PCT",
      );
    });

    it("rejects negative → INVALID_REFERRAL_PCT", () => {
      expectCode(
        () =>
          validateBetParams({
            beneficiary: BENEFICIARY,
            bets: validBets,
            referral: OTHER_ADDR,
            referralPct: -1,
          }),
        "INVALID_REFERRAL_PCT",
      );
    });

    it("rejects non-integer → INVALID_REFERRAL_PCT", () => {
      expectCode(
        () =>
          validateBetParams({
            beneficiary: BENEFICIARY,
            bets: validBets,
            referral: OTHER_ADDR,
            referralPct: 3.5,
          }),
        "INVALID_REFERRAL_PCT",
      );
    });
  });

  describe("referral pairing", () => {
    it("pct>0 + referral=null → REFERRAL_PCT_WITHOUT_ADDRESS", () => {
      expectCode(
        () =>
          validateBetParams({
            beneficiary: BENEFICIARY,
            bets: validBets,
            referral: null,
            referralPct: 3,
          }),
        "REFERRAL_PCT_WITHOUT_ADDRESS",
      );
    });

    it("pct=0 + referral=addr → REFERRAL_ADDRESS_WITHOUT_PCT", () => {
      expectCode(
        () =>
          validateBetParams({
            beneficiary: BENEFICIARY,
            bets: validBets,
            referral: OTHER_ADDR,
            referralPct: 0,
          }),
        "REFERRAL_ADDRESS_WITHOUT_PCT",
      );
    });

    it("referral == beneficiary → allowed (self-referral)", () => {
      expect(() =>
        validateBetParams({
          beneficiary: BENEFICIARY,
          bets: validBets,
          referral: BENEFICIARY,
          referralPct: 5,
        }),
      ).not.toThrow();
    });
  });

  describe("bets", () => {
    it("empty array → EMPTY_BETS", () => {
      expectCode(
        () =>
          validateBetParams({
            beneficiary: BENEFICIARY,
            bets: [],
            referral: null,
            referralPct: 0,
          }),
        "EMPTY_BETS",
      );
    });

    it("> 256 entries → TOO_MANY_BETS", () => {
      const tooMany: BetItem[] = [];
      for (let i = 0; i < 257; i++) {
        tooMany.push({ yesOdds: 50, ticketsCount: 1 });
      }
      expectCode(
        () =>
          validateBetParams({
            beneficiary: BENEFICIARY,
            bets: tooMany,
            referral: null,
            referralPct: 0,
          }),
        "TOO_MANY_BETS",
      );
    });

    it("odd yesOdds → INVALID_ODDS", () => {
      expectCode(
        () =>
          validateBetParams({
            beneficiary: BENEFICIARY,
            bets: [{ yesOdds: 55, ticketsCount: 10 }],
            referral: null,
            referralPct: 0,
          }),
        "INVALID_ODDS",
      );
    });

    it("yesOdds = 0 → INVALID_ODDS", () => {
      expectCode(
        () =>
          validateBetParams({
            beneficiary: BENEFICIARY,
            bets: [{ yesOdds: 0, ticketsCount: 10 }],
            referral: null,
            referralPct: 0,
          }),
        "INVALID_ODDS",
      );
    });

    it("yesOdds = 100 → INVALID_ODDS", () => {
      expectCode(
        () =>
          validateBetParams({
            beneficiary: BENEFICIARY,
            bets: [{ yesOdds: 100, ticketsCount: 10 }],
            referral: null,
            referralPct: 0,
          }),
        "INVALID_ODDS",
      );
    });

    it("ticketsCount = 0 → INVALID_TICKETS_COUNT", () => {
      expectCode(
        () =>
          validateBetParams({
            beneficiary: BENEFICIARY,
            bets: [{ yesOdds: 50, ticketsCount: 0 }],
            referral: null,
            referralPct: 0,
          }),
        "INVALID_TICKETS_COUNT",
      );
    });

    it("ticketsCount negative → INVALID_TICKETS_COUNT", () => {
      expectCode(
        () =>
          validateBetParams({
            beneficiary: BENEFICIARY,
            bets: [{ yesOdds: 50, ticketsCount: -5 }],
            referral: null,
            referralPct: 0,
          }),
        "INVALID_TICKETS_COUNT",
      );
    });
  });

  describe("addresses", () => {
    it("invalid beneficiary → INVALID_ADDRESS", () => {
      expectCode(
        () =>
          validateBetParams({
            beneficiary: "not-an-address",
            bets: validBets,
            referral: null,
            referralPct: 0,
          }),
        "INVALID_ADDRESS",
      );
    });

    it("invalid referral → INVALID_ADDRESS", () => {
      expectCode(
        () =>
          validateBetParams({
            beneficiary: BENEFICIARY,
            bets: validBets,
            referral: "garbage",
            referralPct: 3,
          }),
        "INVALID_ADDRESS",
      );
    });
  });

  describe("pariAddress (optional)", () => {
    it("valid pariAddress passes", () => {
      expect(() =>
        validateBetParams({
          pariAddress: OTHER_ADDR,
          beneficiary: BENEFICIARY,
          bets: validBets,
          referral: null,
          referralPct: 0,
        }),
      ).not.toThrow();
    });

    it("invalid pariAddress → INVALID_ADDRESS", () => {
      // Regression for Bug 8: used to throw raw Error from @ton/ton's
      // Address.parse inside builders — callers couldn't filter by code.
      expectCode(
        () =>
          validateBetParams({
            pariAddress: "not-a-ton-address",
            beneficiary: BENEFICIARY,
            bets: validBets,
            referral: null,
            referralPct: 0,
          }),
        "INVALID_ADDRESS",
      );
    });
  });

  describe("duplicate yesOdds", () => {
    it("throws DUPLICATE_YES_ODDS when two entries share yesOdds", () => {
      // Pari keys bets by position, so duplicates fit on-chain but each
      // pays its own PARI_EXECUTION_FEE for no benefit. Strategies merge
      // automatically; direct builder callers must call mergeSameOdds
      // themselves before passing bets to the validator.
      expectCode(
        () =>
          validateBetParams({
            beneficiary: BENEFICIARY,
            bets: [
              { yesOdds: 56, ticketsCount: 10 },
              { yesOdds: 56, ticketsCount: 20 },
            ],
            referral: null,
            referralPct: 0,
          }),
        "DUPLICATE_YES_ODDS",
      );
    });

    it("accepts bets with distinct yesOdds", () => {
      expect(() =>
        validateBetParams({
          beneficiary: BENEFICIARY,
          bets: [
            { yesOdds: 54, ticketsCount: 17 },
            { yesOdds: 56, ticketsCount: 100 },
          ],
          referral: null,
          referralPct: 0,
        }),
      ).not.toThrow();
    });
  });
});
