import { Address, beginCell, type Cell, Dictionary } from "@ton/ton";
import { PROXY_FORWARD_BET_OP } from "./constants.js";
import {
  type BatchPlaceBetsForWithRef,
  dictValueParserBetItem,
  storeBatchPlaceBetsForWithRef,
} from "./contracts/generated/pari.js";
import type { BetItem } from "./types.js";

/**
 * Build the `BatchPlaceBetsForWithRef` message cell that Pari expects.
 *
 * This is the body of a TON-direct bet and the inner `ref` of the proxy
 * payload for jetton bets.
 *
 * All serialisation goes through the Tact-generated `storeBatchPlaceBetsForWithRef`
 * helper in `contracts/generated/pari.ts` — do not hand-roll serialisation here.
 */
export function buildBatchPlaceBetsForWithRefCell(params: {
  beneficiary: string;
  isYes: boolean;
  bets: BetItem[];
  referral: string | null;
  referralPct: number;
}): Cell {
  const dict = Dictionary.empty(
    Dictionary.Keys.Uint(8),
    dictValueParserBetItem(),
  );

  params.bets.forEach((b, i) => {
    dict.set(i, {
      $$type: "BetItem",
      yesOdds: BigInt(b.yesOdds),
      ticketsCount: BigInt(b.ticketsCount),
    });
  });

  const message: BatchPlaceBetsForWithRef = {
    $$type: "BatchPlaceBetsForWithRef",
    beneficiary: Address.parse(params.beneficiary),
    isYes: params.isYes,
    bets: dict,
    referral: params.referral ? Address.parse(params.referral) : null,
    referralPct: BigInt(params.referralPct),
  };

  return beginCell().store(storeBatchPlaceBetsForWithRef(message)).endCell();
}

/**
 * Wrap a `BatchPlaceBetsForWithRef` cell into the `ProxyForward` envelope
 * expected by the Toncast proxy when payload arrives via a STON.fi jetton
 * swap.
 *
 * ```
 * ProxyForward {
 *   opcode:       uint32 = 0x50415249 ("PARI")
 *   pariAddress:  Address
 *   pariCell:     ref Cell  // BatchPlaceBetsForWithRef
 * }
 * ```
 *
 * Matches `struct (0x50415249) ProxyForward { pariAddress, pariCell }` in
 * `pari-proxy.tolk`.
 */
export function buildProxyForwardCell(params: {
  pariAddress: string;
  batchPlaceBetsForWithRef: Cell;
}): Cell {
  return beginCell()
    .storeUint(PROXY_FORWARD_BET_OP, 32)
    .storeAddress(Address.parse(params.pariAddress))
    .storeRef(params.batchPlaceBetsForWithRef)
    .endCell();
}
