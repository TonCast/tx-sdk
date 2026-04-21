/**
 * Market bet — spend a TON-equivalent budget greedily on the best
 * counter-side liquidity. Any remainder placement lands on the last matched
 * yesOdds, or on 50% if nothing matched.
 */
// WARNING: uses mainnet endpoints — test with minimal funds first.
import {
  ODDS_COUNT,
  TON_ADDRESS,
  TonClient,
  ToncastTxSdk,
} from "@toncast/tx-sdk";

const PARI_ADDRESS = "EQA7bkHU1hRX6LtvkuAASvN0YSX0tk-N9gx5Ji3oDioslLP0";
const BENEFICIARY = "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8";

const tonClient = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
});
const txSDK = new ToncastTxSdk({ tonClient });

const priced = await txSDK.priceCoins({
  availableCoins: [{ address: TON_ADDRESS, amount: 1_000_000_000_000n }],
});

// Example: 17 @ yesOdds=54, 100 @ 56, 200 @ 58 (NO side = available for YES user).
const Yes = new Array(ODDS_COUNT).fill(0) as number[];
const No = new Array(ODDS_COUNT).fill(0) as number[];
No[26] = 17;
No[27] = 100;
No[28] = 200;

const quote = await txSDK.quoteMarketBet({
  pariAddress: PARI_ADDRESS,
  beneficiary: BENEFICIARY,
  isYes: true,
  oddsState: { Yes, No },
  maxBudgetTon: 884_416_000_000n, // ~884 TON
  referral: null,
  referralPct: 0,
  source: TON_ADDRESS,
  pricedCoins: priced,
});

console.log(`Entries: ${quote.bets.length}`);
console.log(quote.bets);
console.log(`totalCost: ${quote.totalCost} nanoTON`);
console.log(`placement:`, quote.breakdown.placement);
