import { TON_ADDRESS } from "../constants.js";
import type { BetOptionSource, PricedCoin } from "../types.js";
import { sameAddress } from "./address.js";

/**
 * Canonical {@link BetOptionSource} for a {@link PricedCoin}.
 *
 * TON collapses to the literal `"TON"`; jettons carry through the
 * optional `symbol` / `decimals` fields so UIs can render them without
 * another lookup.
 */
export function sourceLabelFromPriced(coin: PricedCoin): BetOptionSource {
  if (sameAddress(coin.address, TON_ADDRESS)) return "TON";
  return {
    address: coin.address,
    ...(coin.symbol !== undefined && { symbol: coin.symbol }),
    ...(coin.decimals !== undefined && { decimals: coin.decimals }),
  };
}

/**
 * Canonical {@link BetOptionSource} for an address + the priced-coins
 * list the caller has in hand.
 *
 * Falls back to a minimal `{ address }` label when the coin is not in
 * `pricedCoins` (e.g. the infeasible `source_not_in_priced_coins`
 * branch). Keeps SDK and planner emitting identical `source` shapes.
 */
export function sourceLabelForAddress(
  address: string,
  pricedCoins: PricedCoin[],
): BetOptionSource {
  if (sameAddress(address, TON_ADDRESS)) return "TON";
  const found = pricedCoins.find((c) => sameAddress(c.address, address));
  if (!found) return { address };
  return sourceLabelFromPriced(found);
}
