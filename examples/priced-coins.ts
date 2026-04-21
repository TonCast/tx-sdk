/**
 * Inspecting TON-equivalents of user coins before placing a bet.
 *
 * `priceCoins` returns a per-coin `PricedCoin` with:
 *   - `tonEquivalent`  — gross TON after slippage (minAskUnits)
 *   - `gasReserve`     — TON locked as swap gas (0 for TON, 0.3/0.6 for jettons)
 *   - `netTon`         — what the coin actually brings to the bet
 *   - `viable`         — false when netTon ≤ 0 (filtered from bet sources)
 */
// WARNING: uses mainnet endpoints — test with minimal funds first.
import { TON_ADDRESS, TonClient, ToncastTxSdk } from "@toncast/tx-sdk";

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
    console.log(
      `${label.padEnd(10)} viable, netTon=${Number(c.netTon) / 1e9} TON, ` +
        `gas=${Number(c.gasReserve) / 1e9} TON, route=${
          typeof c.route === "object"
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
  .reduce((s, c) => s + c.netTon, 0n);
console.log(
  `\nTotal usable balance across viable coins: ${totalAvailable} nano-TON`,
);
