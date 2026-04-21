/**
 * Limit bet — consume available counter-side liquidity up to the worst
 * acceptable coefficient, then place remainder as a fresh bet at the limit.
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
  availableCoins: [{ address: TON_ADDRESS, amount: 100_000_000_000n }],
});

// Example snapshot: 17 NO-tickets at yesOdds=54, 100 at yesOdds=56.
const Yes = new Array(ODDS_COUNT).fill(0) as number[];
const No = new Array(ODDS_COUNT).fill(0) as number[];
No[26] = 17; // yesOdds 54
No[27] = 100; // yesOdds 56

const quote = await txSDK.quoteLimitBet({
  pariAddress: PARI_ADDRESS,
  beneficiary: BENEFICIARY,
  isYes: true,
  oddsState: { Yes, No },
  worstYesOdds: 56,
  ticketsCount: 300,
  referral: null,
  referralPct: 0,
  source: TON_ADDRESS,
  pricedCoins: priced,
});

console.log(`Entries after merge: ${quote.bets.length}`);
console.log(quote.bets);
console.log(`totalCost: ${quote.totalCost} nanoTON`);
console.log(`breakdown.matched:`, quote.breakdown.matched);
console.log(`breakdown.unmatched:`, quote.breakdown.unmatched);
