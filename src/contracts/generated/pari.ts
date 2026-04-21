/**
 * Minimal slice of Tact-generated TypeScript bindings for the Toncast Pari
 * contract.
 *
 * Source of truth: Tact compiler output supplied by the Pari contract team.
 * Only the bits we actually need to build a `BatchPlaceBetsForWithRef`
 * message are kept here:
 *
 * - `BetItem` — store / load / dict-value parser.
 * - `BatchPlaceBetsForWithRef` — store / load (message with opcode 0xaabbccf0).
 *
 * Everything else from the full Tact output (wrapper classes, tuple
 * serializers, getters, other messages, deploy helpers) is intentionally
 * omitted. If Pari's message schema changes, this file must be regenerated
 * and this SDK must ship a new major version.
 */

import {
  type Address,
  type Builder,
  beginCell,
  Dictionary,
  type DictionaryValue,
  type Slice,
} from "@ton/ton";

// ─── BetItem ────────────────────────────────────────────────────────────────

export type BetItem = {
  $$type: "BetItem";
  yesOdds: bigint;
  ticketsCount: bigint;
};

export function storeBetItem(src: BetItem) {
  return (b: Builder) => {
    b.storeUint(src.yesOdds, 7);
    b.storeUint(src.ticketsCount, 32);
  };
}

export function loadBetItem(s: Slice): BetItem {
  return {
    $$type: "BetItem",
    yesOdds: s.loadUintBig(7),
    ticketsCount: s.loadUintBig(32),
  };
}

/**
 * Dict value layout: each `BetItem` is stored in a dedicated cell, referenced
 * from the hashmap leaf. This matches the on-chain proxy
 * (`toncast_swap_proxy.tolk`), which iterates the `bets` map via
 * `createMapFromLowLevelDict<uint8, cell>` + `loadValue().beginParse()` —
 * i.e. it expects each value to be `cell` (a ref), not inline bits.
 *
 * Storing `BetItem` inline (39 bits in the leaf, no refs) causes the proxy's
 * `loadValue()` to throw "No more references" and the proxy falls into
 * its `try/catch` → refunds the user's TON. Using ref-per-entry here keeps
 * the encoding compatible with both the proxy and the Pari contract itself.
 */
export function dictValueParserBetItem(): DictionaryValue<BetItem> {
  return {
    serialize: (src, b) => {
      b.storeRef(beginCell().store(storeBetItem(src)).endCell());
    },
    parse: (src) => loadBetItem(src.loadRef().beginParse()),
  };
}

// ─── BatchPlaceBetsForWithRef (opcode 0xaabbccf0 = 2864434416) ──────────────

export type BatchPlaceBetsForWithRef = {
  $$type: "BatchPlaceBetsForWithRef";
  beneficiary: Address;
  isYes: boolean;
  bets: Dictionary<number, BetItem>;
  referral: Address | null;
  referralPct: bigint;
};

export function storeBatchPlaceBetsForWithRef(src: BatchPlaceBetsForWithRef) {
  return (b: Builder) => {
    b.storeUint(2864434416, 32);
    b.storeAddress(src.beneficiary);
    b.storeBit(src.isYes);
    b.storeDict(src.bets, Dictionary.Keys.Uint(8), dictValueParserBetItem());
    // Tact `Address?` serialises using @ton/ton's standard storeAddress:
    // null → addr_none ($00, 2 bits), non-null → addr_std ($10 + wc + hash).
    b.storeAddress(src.referral);
    b.storeUint(src.referralPct, 3);
  };
}

export function loadBatchPlaceBetsForWithRef(
  s: Slice,
): BatchPlaceBetsForWithRef {
  const opcode = s.loadUint(32);
  if (opcode !== 2864434416) {
    throw new Error(
      `Invalid BatchPlaceBetsForWithRef prefix: expected 2864434416, got ${opcode}`,
    );
  }
  return {
    $$type: "BatchPlaceBetsForWithRef",
    beneficiary: s.loadAddress(),
    isYes: s.loadBit(),
    bets: Dictionary.load(Dictionary.Keys.Uint(8), dictValueParserBetItem(), s),
    referral: s.loadMaybeAddress(),
    referralPct: s.loadUintBig(3),
  };
}
