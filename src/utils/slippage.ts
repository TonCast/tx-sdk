/**
 * Slippage-related arithmetic helpers used by the rates / planner layers.
 */

/**
 * Size a reverse-swap target so that the DEX's slippage-adjusted minimum
 * (`minAskUnits = askUnits * (1 − slippage)`) stays ≥ `amount`.
 *
 * Without this bump, `simulateReverseSwap({ askUnits: amount })` returns
 * `offerUnits` sized to deliver `amount` in the EXPECTED case and a
 * `minAskUnits = amount * (1 − slippage)` that the router uses as its
 * on-chain rejection floor. Any adverse pool movement inside the
 * slippage band then lets the actual delivery fall below the Pari-side
 * `totalCost`, causing the Toncast proxy to refund the user instead of
 * placing the bet — the DEX considers the swap a success because it
 * exceeded its own floor, even though the bet cannot be executed.
 *
 * Grossing up the ask by `1 / (1 − slippage)` (rounded up) forces
 * `minAskUnits ≥ amount`. If the DEX cannot deliver at that floor it
 * reverts on-chain and the user's jetton is returned instead of
 * silently under-delivering to the proxy.
 *
 * Uses 10^9-scale fixed-point arithmetic on bigints to stay away from
 * JavaScript number precision hazards at large raw-unit magnitudes.
 * 10^9 keeps `slip * SCALE` comfortably below 2^53 (the IEEE 754 exact
 * integer ceiling) for any `slip ∈ [0, 1)`, and resolves slippage down
 * to ~1e-9 precision — far finer than any realistic bet configuration.
 * A coarser scale (e.g. basis-point 10^4) would silently no-op for
 * slippage values below ~5e-5 and re-open the `minAskUnits < totalCost`
 * refund scenario the helper exists to prevent.
 */
export function grossUpForSlippage(amount: bigint, slippage: string): bigint {
  const SCALE = 1_000_000_000n;
  const slip = Number(slippage);
  if (!Number.isFinite(slip) || slip < 0 || slip >= 1) {
    throw new Error(
      `grossUpForSlippage: slippage must be a number in [0, 1), got ${slippage}`,
    );
  }
  const keep = SCALE - BigInt(Math.round(slip * Number(SCALE)));
  if (keep <= 0n) {
    throw new Error(`grossUpForSlippage: slippage too large (got ${slippage})`);
  }
  // Ceiling division so the rounded minAskUnits stays ≥ `amount`.
  return (amount * SCALE + keep - 1n) / keep;
}

/**
 * Convert a route-total slippage budget into a per-leg slippage that, when
 * applied independently to each of `legCount` legs, composes back to the
 * original budget.
 *
 * Mathematically: `(1 − perLeg)^legCount = 1 − totalSlippage`, hence
 * `perLeg = 1 − (1 − totalSlippage)^(1/legCount)`.
 *
 * Why this exists — without it, a 5% user-facing slippage on a 2-hop
 * `offer → intermediate → TON` swap was being applied as 5% per leg,
 * grossing offer up by `1/(1 − 0.05)² ≈ 1.108` instead of `1/(1 − 0.05)
 * ≈ 1.053`. Users observed the wallet asking for ~5% more jetton than
 * the quote estimate showed (matched STON.fi/Omniston UI's behaviour
 * of treating slippage as a route-total floor on the final delivery).
 *
 * For `legCount === 1` returns the input unchanged — direct routes are
 * unaffected, so the fix is opt-in by route shape and doesn't perturb
 * single-hop math.
 *
 * Returned as a string so it slots directly into `slippageTolerance`
 * params on STON.fi simulator calls and compares cleanly with the
 * existing `Number(slippage)` consumers (cache keys, `sameSlippage`).
 * Precision pinned to 9 decimals to match the 10⁹-scale used inside
 * `grossUpForSlippage` — finer than any realistic bet config and well
 * inside JS Number precision.
 */
export function perLegSlippage(totalSlippage: string, legCount: 1 | 2): string {
  const total = Number(totalSlippage);
  if (!Number.isFinite(total) || total < 0 || total >= 1) {
    throw new Error(
      `perLegSlippage: slippage must be a number in [0, 1), got ${totalSlippage}`,
    );
  }
  if (legCount === 1) return totalSlippage;
  const perLeg = 1 - Math.sqrt(1 - total);
  // Cap at 9-decimal precision; trailing zeros stripped to keep the
  // serialised form tidy in cache keys / logs ("0.025320566" not
  // "0.025320566000000001").
  return Number(perLeg.toFixed(9)).toString();
}

/**
 * Inverse of {@link perLegSlippage}: combine `legCount` independent
 * per-leg slippage budgets back into the equivalent route-total
 * budget — `1 − (1 − perLeg)^legCount`.
 *
 * Used when STON.fi returns a per-pool `recommendedSlippageTolerance`
 * for each leg of a cross-hop route and we need to compare it against
 * the user-set route-total slippage on a like-for-like basis.
 */
export function combineLegSlippage(perLeg: string, legCount: 1 | 2): string {
  const v = Number(perLeg);
  if (!Number.isFinite(v) || v < 0 || v >= 1) {
    throw new Error(
      `combineLegSlippage: slippage must be a number in [0, 1), got ${perLeg}`,
    );
  }
  if (legCount === 1) return perLeg;
  const total = 1 - (1 - v) ** legCount;
  return Number(total.toFixed(9)).toString();
}
