import { ODDS_COUNT, ODDS_MAX, ODDS_MIN, ODDS_STEP } from "../constants.js";
import { ToncastBetError } from "../errors.js";
import type { BetItem, OddsState } from "../types.js";

/**
 * Convert an array index (0..48) to a yesOdds value (2, 4, …, 98).
 */
export function indexToYesOdds(i: number): number {
  if (!Number.isInteger(i) || i < 0 || i >= ODDS_COUNT) {
    throw new ToncastBetError(
      "INVALID_ODDS_INDEX",
      `OddsState index must be an integer in [0, ${ODDS_COUNT - 1}], got ${i}`,
    );
  }
  return ODDS_MIN + i * ODDS_STEP;
}

/**
 * Convert a yesOdds value (2, 4, …, 98) to the corresponding OddsState index.
 */
export function yesOddsToIndex(yesOdds: number): number {
  if (
    !Number.isInteger(yesOdds) ||
    yesOdds < ODDS_MIN ||
    yesOdds > ODDS_MAX ||
    yesOdds % ODDS_STEP !== 0
  ) {
    throw new ToncastBetError(
      "INVALID_ODDS",
      `yesOdds must be an even integer in [${ODDS_MIN}, ${ODDS_MAX}], got ${yesOdds}`,
    );
  }
  return (yesOdds - ODDS_MIN) / ODDS_STEP;
}

/**
 * Counter-side liquidity available to match a bet at `yesOdds`.
 *
 * ## OddsState indexing convention
 *
 * `oddsState.Yes` and `oddsState.No` are asymmetric: each side is indexed by
 * its OWN-side percentage (so UIs can render both sides on their own scale
 * without per-entry translation):
 *
 * - `Yes[i]` — YES orders at yesOdds (= YES-probability) of `2*(i+1)`.
 *   `i = yesOddsToIndex(yesOdds)`.
 * - `No[i]` — NO orders at NO-probability of `2*(i+1)`, which equals
 *   yesOdds `= 100 - 2*(i+1)`. `i = yesOddsToIndex(100 - yesOdds)`.
 *
 * Concretely: `No[17] = 200` means 200 NO orders sitting at
 * NO-prob = 36% ⇔ Pari yesOdds = 64 (cheap NO tickets, popular among NO
 * bettors). It is NOT "200 NO orders at yesOdds=36".
 *
 * ## Matching
 *
 * A YES bet at Pari `yesOdds=X` is matched on-chain against NO orders sitting
 * in the same Bets contract (same on-chain yesOdds=X). In `oddsState`, those
 * orders live at `No[yesOddsToIndex(100 - X)]` because of the complementary
 * indexing above. A NO bet at `yesOdds=X` is matched against YES orders
 * living at `Yes[yesOddsToIndex(X)]` (direct indexing).
 *
 * Assumes `oddsState` has been through {@link validateOddsState}. Throws
 * {@link ToncastBetError} with code `INVALID_ODDS_STATE` if a cell is missing
 * or non-integer — failing fast rather than silently coercing bad contract/UI
 * data to 0.
 */
export function availableTickets(
  oddsState: OddsState,
  isYes: boolean,
  yesOdds: number,
): number {
  // Ensure yesOdds itself is a valid value before taking its complement.
  yesOddsToIndex(yesOdds);
  const side = isYes ? "No" : "Yes";
  // YES matches NO orders, which are indexed by NO-probability = 100 − yesOdds.
  // NO matches YES orders, which are indexed by yesOdds directly.
  const lookupYesOdds = isYes ? 100 - yesOdds : yesOdds;
  const i = yesOddsToIndex(lookupYesOdds);
  const value = oddsState[side][i];
  if (value === undefined) {
    throw new ToncastBetError(
      "INVALID_ODDS_STATE",
      `OddsState.${side}[${i}] is missing (yesOdds=${yesOdds})`,
    );
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new ToncastBetError(
      "INVALID_ODDS_STATE",
      `OddsState.${side}[${i}] must be a non-negative integer, got ${value} (yesOdds=${yesOdds})`,
    );
  }
  return value;
}

/**
 * Validate that the incoming OddsState has the expected shape AND content.
 *
 * Shape: two arrays of length {@link ODDS_COUNT} named `Yes` and `No`.
 * Content: each cell must be a non-negative integer within `uint32`
 * (matches the on-chain representation of matched ticket counts).
 *
 * Throws {@link ToncastBetError} with code `INVALID_ODDS_STATE` on any
 * violation so callers can filter by typed error code. This catches
 * corrupted data from the contract/UI early, before a strategy silently
 * treats invalid cells as zero.
 */
export function validateOddsState(oddsState: OddsState): void {
  if (
    !oddsState ||
    !Array.isArray(oddsState.Yes) ||
    !Array.isArray(oddsState.No) ||
    oddsState.Yes.length !== ODDS_COUNT ||
    oddsState.No.length !== ODDS_COUNT
  ) {
    throw new ToncastBetError(
      "INVALID_ODDS_STATE",
      `OddsState must have Yes and No arrays of length ${ODDS_COUNT}`,
    );
  }
  const MAX_UINT32 = 0xffffffff;
  for (const side of ["Yes", "No"] as const) {
    const arr = oddsState[side];
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (
        v === undefined ||
        !Number.isInteger(v) ||
        (v as number) < 0 ||
        (v as number) > MAX_UINT32
      ) {
        throw new ToncastBetError(
          "INVALID_ODDS_STATE",
          `OddsState.${side}[${i}] must be a uint32 integer (0..${MAX_UINT32}), got ${v}`,
        );
      }
    }
  }
}

/**
 * Merge entries sharing the same yesOdds — saves one `PARI_EXECUTION_FEE`
 * per duplicate when submitted on-chain.
 */
export function mergeSameOdds(bets: BetItem[]): BetItem[] {
  const map = new Map<number, number>();
  for (const b of bets) {
    map.set(b.yesOdds, (map.get(b.yesOdds) ?? 0) + b.ticketsCount);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([yesOdds, ticketsCount]) => ({ yesOdds, ticketsCount }));
}
