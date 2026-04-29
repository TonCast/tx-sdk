import { Address } from "@ton/ton";
import {
  MAX_REFERRAL_PCT,
  ODDS_MAX,
  ODDS_MIN,
  ODDS_STEP,
  PARI_EXECUTION_FEE,
} from "./constants.js";
import { ToncastBetError } from "./errors.js";
import type { BetItem } from "./types.js";

/** Max number of entries in `BatchPlaceBetsForWithRef.bets` (uint8 key). */
const MAX_BETS_ENTRIES = 256;

function isValidAddress(value: string): boolean {
  try {
    Address.parse(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strict validation of bet parameters.
 *
 * Throws {@link ToncastBetError} with a typed {@link BetErrorCode} on any
 * violation. Called by both the low-level builders and the high-level
 * `quoteXxxBet` methods before any network I/O.
 */
export function validateBetParams(params: {
  /** Optional — when provided, is checked with the same INVALID_ADDRESS code. */
  pariAddress?: string;
  beneficiary: string;
  /** Optional sender/signer address — validated if provided. */
  senderAddress?: string;
  bets: BetItem[];
  referral: string | null;
  referralPct: number;
}): void {
  const {
    pariAddress,
    beneficiary,
    senderAddress,
    bets,
    referral,
    referralPct,
  } = params;

  if (pariAddress !== undefined && !isValidAddress(pariAddress)) {
    throw new ToncastBetError(
      "INVALID_ADDRESS",
      `pariAddress is not a valid TON address: ${pariAddress}`,
    );
  }

  if (!isValidAddress(beneficiary)) {
    throw new ToncastBetError(
      "INVALID_ADDRESS",
      `beneficiary is not a valid TON address: ${beneficiary}`,
    );
  }

  if (senderAddress !== undefined && !isValidAddress(senderAddress)) {
    throw new ToncastBetError(
      "INVALID_ADDRESS",
      `senderAddress is not a valid TON address: ${senderAddress}`,
    );
  }

  if (
    !Number.isInteger(referralPct) ||
    referralPct < 0 ||
    referralPct > MAX_REFERRAL_PCT
  ) {
    throw new ToncastBetError(
      "INVALID_REFERRAL_PCT",
      `referralPct must be an integer in [0, ${MAX_REFERRAL_PCT}], got ${referralPct}`,
    );
  }

  if (referralPct > 0 && referral === null) {
    throw new ToncastBetError(
      "REFERRAL_PCT_WITHOUT_ADDRESS",
      `referralPct > 0 requires a non-null referral address (got pct=${referralPct}, referral=null)`,
    );
  }

  if (referralPct === 0 && referral !== null) {
    throw new ToncastBetError(
      "REFERRAL_ADDRESS_WITHOUT_PCT",
      `referral address provided but referralPct is 0; set pct > 0 or pass referral=null`,
    );
  }

  if (referral !== null) {
    if (!isValidAddress(referral)) {
      throw new ToncastBetError(
        "INVALID_ADDRESS",
        `referral is not a valid TON address: ${referral}`,
      );
    }
  }

  if (!Array.isArray(bets) || bets.length === 0) {
    throw new ToncastBetError("EMPTY_BETS", `bets array must be non-empty`);
  }

  if (bets.length > MAX_BETS_ENTRIES) {
    throw new ToncastBetError(
      "TOO_MANY_BETS",
      `bets array has ${bets.length} entries, max allowed is ${MAX_BETS_ENTRIES} (uint8 key)`,
    );
  }

  // Track yesOdds seen so far to catch duplicates. Pari's dict is keyed by
  // position (uint8 index), not by yesOdds — so duplicates DO fit on-chain,
  // but each copy pays its own 0.1 TON PARI_EXECUTION_FEE for no benefit.
  // Strategies run mergeSameOdds automatically; direct builder callers
  // should call it themselves before passing bets here.
  const seenOdds = new Set<number>();

  for (let i = 0; i < bets.length; i++) {
    const b = bets[i];
    if (
      !b ||
      !Number.isInteger(b.yesOdds) ||
      b.yesOdds < ODDS_MIN ||
      b.yesOdds > ODDS_MAX ||
      b.yesOdds % ODDS_STEP !== 0
    ) {
      throw new ToncastBetError(
        "INVALID_ODDS",
        `bets[${i}].yesOdds must be an even integer in [${ODDS_MIN}, ${ODDS_MAX}], got ${b?.yesOdds}`,
      );
    }
    if (
      !Number.isInteger(b.ticketsCount) ||
      b.ticketsCount <= 0 ||
      // uint32 upper bound
      b.ticketsCount > 0xffffffff
    ) {
      throw new ToncastBetError(
        "INVALID_TICKETS_COUNT",
        `bets[${i}].ticketsCount must be a positive uint32 integer, got ${b.ticketsCount}`,
      );
    }
    if (seenOdds.has(b.yesOdds)) {
      throw new ToncastBetError(
        "DUPLICATE_YES_ODDS",
        `bets[${i}].yesOdds=${b.yesOdds} appears more than once — call mergeSameOdds(bets) to fold duplicates and save ${PARI_EXECUTION_FEE} nano-TON per extra entry.`,
      );
    }
    seenOdds.add(b.yesOdds);
  }
}
