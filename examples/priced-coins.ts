/**
 * Inspecting TON-equivalents of user coins before placing a bet.
 *
 * `priceCoins` returns a per-coin `PricedCoin` with:
 *   - `tonEquivalent`         — pessimistic floor (minAskUnits after slippage)
 *   - `tonEquivalentExpected` — expected output (askUnits, stable market)
 *   - `gasReserve`            — TON-wallet gas needed for the swap
 *                               (0.05 for TON, 0.3 direct / 0.6 cross for jettons)
 *   - `route`                 — "direct" | { intermediate } | null
 *   - `viable`                — false when the swap is net-destructive in TON terms
 *
 * Use {@link availableForBet} to get the TON this coin can contribute
 * to a bet — handles the TON/jetton asymmetry (TON subtracts
 * walletReserve+gas, jetton equals tonEquivalent because swap gas is
 * billed to the TON wallet separately).
 */
// WARNING: uses mainnet endpoints — test with minimal funds first.
import {
  availableForBet,
  DEFAULT_WALLET_RESERVE,
  TON_ADDRESS,
  TonClient,
  ToncastTxSdk,
} from "@toncast/tx-sdk";

const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const NOT = "EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT";

const tonClient = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
});
const txSDK = new ToncastTxSdk({ tonClient });

const priced = await txSDK.priceCoins({
  availableCoins: [
    { address: TON_ADDRESS, amount: 3_000_000_000n }, // 3 TON
    { address: USDT, amount: 50_000_000n, symbol: "USDT", decimals: 6 }, // 50 USDT
    { address: NOT, amount: 10_000n, symbol: "NOT", decimals: 9 }, // tiny balance
  ],
});

for (const c of priced) {
  const label = c.symbol ?? c.address.slice(0, 10);
  if (c.viable) {
    const capacity = availableForBet(c, DEFAULT_WALLET_RESERVE);
    console.log(
      `${label.padEnd(10)} viable, ` +
        `availableForBet=${Number(capacity) / 1e9} TON, ` +
        `expected=${Number(c.tonEquivalentExpected) / 1e9} TON, ` +
        `gas=${Number(c.gasReserve) / 1e9} TON, ` +
        `route=${
          c.route === null
            ? "n/a"
            : typeof c.route === "object"
              ? `cross via ${c.route.intermediate.slice(0, 6)}`
              : c.route
        }`,
    );
  } else {
    console.log(`${label.padEnd(10)} skipped: ${c.reason}`);
  }
}

// UI can now aggregate:
const totalAvailable = priced
  .filter((c) => c.viable)
  .reduce((s, c) => s + availableForBet(c, DEFAULT_WALLET_RESERVE), 0n);
console.log(
  `\nTotal usable balance across viable coins: ${totalAvailable} nano-TON`,
);
