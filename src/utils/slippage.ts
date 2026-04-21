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
