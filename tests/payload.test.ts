import { Address, Dictionary } from "@ton/ton";
import { describe, expect, it } from "vitest";
import { PROXY_FORWARD_BET_OP } from "../src/constants.js";
import { loadBatchPlaceBetsForWithRef } from "../src/contracts/generated/pari.js";
import {
  buildBatchPlaceBetsForWithRefCell,
  buildProxyForwardCell,
} from "../src/payload.js";

const BENEFICIARY = "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8";
const REFERRAL = "EQA7bkHU1hRX6LtvkuAASvN0YSX0tk-N9gx5Ji3oDioslLP0";
const PARI_ADDRESS = "EQA7bkHU1hRX6LtvkuAASvN0YSX0tk-N9gx5Ji3oDioslLP0";

describe("buildBatchPlaceBetsForWithRefCell", () => {
  it("round-trips no-referral case (referral=null, pct=0)", () => {
    const cell = buildBatchPlaceBetsForWithRefCell({
      beneficiary: BENEFICIARY,
      isYes: true,
      bets: [{ yesOdds: 56, ticketsCount: 100 }],
      referral: null,
      referralPct: 0,
    });

    const parsed = loadBatchPlaceBetsForWithRef(cell.beginParse());
    expect(parsed.beneficiary.equals(Address.parse(BENEFICIARY))).toBe(true);
    expect(parsed.isYes).toBe(true);
    expect(parsed.referral).toBeNull();
    expect(parsed.referralPct).toBe(0n);

    const entry = parsed.bets.get(0);
    expect(entry?.yesOdds).toBe(56n);
    expect(entry?.ticketsCount).toBe(100n);
  });

  it("round-trips max-referral case (referral=addr, pct=7)", () => {
    const cell = buildBatchPlaceBetsForWithRefCell({
      beneficiary: BENEFICIARY,
      isYes: false,
      bets: [{ yesOdds: 42, ticketsCount: 3 }],
      referral: REFERRAL,
      referralPct: 7,
    });

    const parsed = loadBatchPlaceBetsForWithRef(cell.beginParse());
    expect(parsed.isYes).toBe(false);
    expect(parsed.referral?.equals(Address.parse(REFERRAL))).toBe(true);
    expect(parsed.referralPct).toBe(7n);
  });

  it("preserves opcode prefix 0xaabbccf0", () => {
    const cell = buildBatchPlaceBetsForWithRefCell({
      beneficiary: BENEFICIARY,
      isYes: true,
      bets: [{ yesOdds: 50, ticketsCount: 1 }],
      referral: null,
      referralPct: 0,
    });
    const slice = cell.beginParse();
    const opcode = slice.loadUint(32);
    expect(opcode).toBe(0xaabbccf0);
    expect(opcode).toBe(2864434416);
  });

  it("round-trips multiple bets and preserves order", () => {
    const bets = [
      { yesOdds: 54, ticketsCount: 17 },
      { yesOdds: 56, ticketsCount: 283 },
      { yesOdds: 58, ticketsCount: 15131 },
    ];
    const cell = buildBatchPlaceBetsForWithRefCell({
      beneficiary: BENEFICIARY,
      isYes: true,
      bets,
      referral: null,
      referralPct: 0,
    });

    const parsed = loadBatchPlaceBetsForWithRef(cell.beginParse());
    bets.forEach((b, i) => {
      const entry = parsed.bets.get(i);
      expect(entry?.yesOdds).toBe(BigInt(b.yesOdds));
      expect(entry?.ticketsCount).toBe(BigInt(b.ticketsCount));
    });
  });

  it("round-trips a 256-entry batch (uint8 key max)", () => {
    const bets = [];
    for (let i = 0; i < 256; i++) {
      bets.push({ yesOdds: 2 + (i % 49) * 2, ticketsCount: 1 });
    }
    const cell = buildBatchPlaceBetsForWithRefCell({
      beneficiary: BENEFICIARY,
      isYes: true,
      bets,
      referral: null,
      referralPct: 0,
    });
    const parsed = loadBatchPlaceBetsForWithRef(cell.beginParse());
    expect(parsed.bets.size).toBe(256);
  });

  it("stores bets dict values as refs (required by on-chain proxy)", () => {
    // The proxy (`toncast_swap_proxy.tolk`) iterates `bets` via
    // `createMapFromLowLevelDict<uint8, cell>` and calls
    // `r.loadValue().beginParse()` — i.e. it expects each leaf value to be
    // a cell ref. If we encoded BetItem inline (39 bits in the leaf) the
    // proxy would throw "No more references" and refund the user.
    //
    // This test locks in ref-per-entry encoding. If it starts failing, the
    // SDK has silently reverted to inline encoding and jetton-funded bets
    // will start refunding on-chain.
    const cell = buildBatchPlaceBetsForWithRefCell({
      beneficiary: BENEFICIARY,
      isYes: true,
      bets: [{ yesOdds: 56, ticketsCount: 100 }],
      referral: null,
      referralPct: 0,
    });
    const s = cell.beginParse();
    s.loadUint(32); // opcode
    s.loadAddress(); // beneficiary
    s.loadBit(); // isYes
    const dictRef = s.loadRef(); // the bets dict root cell

    // Re-parse as ref-per-entry. If the parser throws "No more references"
    // this assertion fails and flags the encoding regression.
    const refBased = Dictionary.loadDirect(
      Dictionary.Keys.Uint(8),
      {
        serialize: () => {},
        parse: (slc) => {
          const inner = slc.loadRef().beginParse();
          return {
            yesOdds: Number(inner.loadUintBig(7)),
            ticketsCount: Number(inner.loadUintBig(32)),
          };
        },
      },
      dictRef,
    );
    const only = refBased.get(0);
    expect(only).toEqual({ yesOdds: 56, ticketsCount: 100 });
  });

  it("loadMaybeAddress resolves null correctly (Tact Address?)", () => {
    const cell = buildBatchPlaceBetsForWithRefCell({
      beneficiary: BENEFICIARY,
      isYes: true,
      bets: [{ yesOdds: 50, ticketsCount: 1 }],
      referral: null,
      referralPct: 0,
    });
    const parsed = loadBatchPlaceBetsForWithRef(cell.beginParse());
    expect(parsed.referral).toBeNull();
  });
});

describe("buildProxyForwardCell", () => {
  it("wraps inner cell with opcode 0x50415249 and pariAddress", () => {
    const inner = buildBatchPlaceBetsForWithRefCell({
      beneficiary: BENEFICIARY,
      isYes: true,
      bets: [{ yesOdds: 56, ticketsCount: 1 }],
      referral: null,
      referralPct: 0,
    });
    const wrapped = buildProxyForwardCell({
      pariAddress: PARI_ADDRESS,
      batchPlaceBetsForWithRef: inner,
    });

    const slice = wrapped.beginParse();
    expect(slice.loadUint(32)).toBe(PROXY_FORWARD_BET_OP);
    expect(slice.loadAddress().equals(Address.parse(PARI_ADDRESS))).toBe(true);

    // Inner ref should parse as BatchPlaceBetsForWithRef.
    const innerRef = slice.loadRef();
    const parsedInner = loadBatchPlaceBetsForWithRef(innerRef.beginParse());
    expect(parsedInner.isYes).toBe(true);
  });

  it("PROXY_FORWARD_BET_OP spells 'PARI' (0x50415249)", () => {
    expect(PROXY_FORWARD_BET_OP).toBe(0x50415249);
    expect(
      String.fromCharCode(
        (PROXY_FORWARD_BET_OP >> 24) & 0xff,
        (PROXY_FORWARD_BET_OP >> 16) & 0xff,
        (PROXY_FORWARD_BET_OP >> 8) & 0xff,
        PROXY_FORWARD_BET_OP & 0xff,
      ),
    ).toBe("PARI");
  });
});
