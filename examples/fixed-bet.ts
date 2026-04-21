/**
 * Fixed bet with full jetton support.
 *
 * Flow:
 *   1. priceCoins → show user what each coin is worth in TON.
 *   2. User picks one viable source.
 *   3. quoteFixedBet → build tx. confirmQuote → refresh just before signing.
 */
// WARNING: uses mainnet endpoints — test with minimal funds first.
import { TON_ADDRESS, TonClient, ToncastTxSdk } from "@toncast/tx-sdk";

const PARI_ADDRESS = "EQA7bkHU1hRX6LtvkuAASvN0YSX0tk-N9gx5Ji3oDioslLP0";
const BENEFICIARY = "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8";
const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

const tonClient = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
});

const txSDK = new ToncastTxSdk({ tonClient });

// 1. Price available coins.
const priced = await txSDK.priceCoins({
  availableCoins: [
    { address: TON_ADDRESS, amount: 10_000_000_000n }, // 10 TON
    { address: USDT, amount: 100_000_000n, symbol: "USDT", decimals: 6 },
  ],
});

console.log("Priced coins:");
for (const c of priced) {
  console.log(
    `  ${c.symbol ?? c.address.slice(0, 6)}: ` +
      `viable=${c.viable}, netTon=${c.netTon}, gasReserve=${c.gasReserve}`,
  );
}

// 2. Pick the cheapest viable source (TON if present; else first viable jetton).
const picked =
  priced.find((c) => c.address === TON_ADDRESS && c.viable) ??
  priced.find((c) => c.viable);

if (!picked) {
  console.log("No viable source.");
  process.exit(1);
}

// 3. Build the quote.
const quote = await txSDK.quoteFixedBet({
  pariAddress: PARI_ADDRESS,
  beneficiary: BENEFICIARY,
  isYes: true,
  yesOdds: 56,
  ticketsCount: 100,
  referral: null,
  referralPct: 0,
  source: picked.address,
  pricedCoins: priced,
});

console.log(
  `\nquote: totalCost=${quote.totalCost}, feasible=${quote.option.feasible}`,
);

if (!quote.option.feasible) {
  console.log(`  reason: ${quote.option.reason}`);
  process.exit(1);
}

// 4. Confirm just before signing — re-checks slippage for jetton sources.
const confirmed = await txSDK.confirmQuote(quote, {
  pariAddress: PARI_ADDRESS,
  beneficiary: BENEFICIARY,
  referral: null,
  referralPct: 0,
});
if (confirmed.option.feasible) {
  for (const tx of confirmed.option.txs) {
    console.log("tx:", {
      to: tx.to.toString(),
      value: tx.value.toString(),
    });
  }
}
