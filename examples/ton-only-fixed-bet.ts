/**
 * TON-only Fixed bet — minimal setup, no swap needed.
 *
 * Uses the package's pure exports without instantiating `ToncastTxSdk` —
 * no TonClient, no STON.fi simulation, no async work.
 * Signs / sends the transaction through whatever wallet integration the
 * caller prefers (TonConnect, Tonkeeper deeplink, etc.).
 */
// WARNING: no network calls here, but the returned tx targets mainnet.
//          Verify pariAddress and bet parameters carefully before signing.
import { buildTonBetTx, calcBetCost, computeFixedBets } from "@toncast/tx-sdk";

const PARI_ADDRESS = "EQA7bkHU1hRX6LtvkuAASvN0YSX0tk-N9gx5Ji3oDioslLP0";
const BENEFICIARY = "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8";

// 1. Describe the bet.
const { bets } = computeFixedBets({
  yesOdds: 56,
  ticketsCount: 100,
  isYes: true,
});

// 2. Know what you'll pay before you ask the user to sign.
const { totalCost } = calcBetCost(bets, true);
console.log(`total cost: ${totalCost} nanoTON`);

// 3. Build the TonConnect transaction params.
const tx = buildTonBetTx({
  pariAddress: PARI_ADDRESS,
  beneficiary: BENEFICIARY,
  isYes: true,
  bets,
  referral: null,
  referralPct: 0,
});

console.log({
  to: tx.to.toString(),
  value: tx.value.toString(),
  bodyBocBase64: tx.body?.toBoc().toString("base64"),
});
