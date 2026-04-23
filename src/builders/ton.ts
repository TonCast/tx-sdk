import { Address } from "@ton/ton";
import { TON_DIRECT_GAS } from "../constants.js";
import { calcBetCost } from "../cost.js";
import { buildBatchPlaceBetsForWithRefCell } from "../payload.js";
import type { BetItem, TxParams } from "../types.js";
import { validateBetParams } from "../validate.js";

export type BuildTonBetTxParams = {
  /** Address of the target Pari market contract. */
  pariAddress: string;
  /** Address that will own the placed bets. */
  beneficiary: string;
  /** `true` → YES side, `false` → NO side. */
  isYes: boolean;
  /** Final bets array (already merged / validated upstream). */
  bets: BetItem[];
  /** Optional referral address. */
  referral: string | null;
  /** Referral share, 0..7 (percent). */
  referralPct: number;
  /**
   * TON added to `value` on top of `totalCost`. Defaults to
   * {@link TON_DIRECT_GAS} (`0n`). `PARI_EXECUTION_FEE` (`0.1 TON × N`)
   * is already inside `totalCost` and covers Pari-side gas.
   */
  tonDirectGas?: bigint;
};

/**
 * Build a TonConnect-compatible transaction for a TON-direct bet on Pari.
 *
 * ```
 * to    = pariAddress
 * value = totalCost + tonDirectGas          // TON attached to the message
 * body  = BatchPlaceBetsForWithRef(...)     // opcode 0xaabbccf0
 * ```
 *
 * With the default `tonDirectGas = TON_DIRECT_GAS = 0n`,
 * `value === totalCost` — what the wallet shows as "Sent" matches the
 * UI's "Total" line item-for-item. `PARI_EXECUTION_FEE` baked into
 * `totalCost` already covers Pari-side gas; no extra surplus / refund
 * round-trip is needed.
 *
 * No STON.fi swap, no proxy — the Pari contract receives the message
 * directly.
 */
export function buildTonBetTx(params: BuildTonBetTxParams): TxParams {
  validateBetParams({
    pariAddress: params.pariAddress,
    beneficiary: params.beneficiary,
    bets: params.bets,
    referral: params.referral,
    referralPct: params.referralPct,
  });

  const { totalCost } = calcBetCost(params.bets, params.isYes);
  const gas = params.tonDirectGas ?? TON_DIRECT_GAS;

  const body = buildBatchPlaceBetsForWithRefCell({
    beneficiary: params.beneficiary,
    isYes: params.isYes,
    bets: params.bets,
    referral: params.referral,
    referralPct: params.referralPct,
  });

  return {
    to: Address.parse(params.pariAddress),
    value: totalCost + gas,
    body,
  };
}
