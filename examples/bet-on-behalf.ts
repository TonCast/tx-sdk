/**
 * Bet on behalf of another user (agent / concierge / gift flow).
 *
 * The wallet that SIGNS the transaction (`senderAddress`) is a separate
 * address from the one that will OWN the placed tickets (`beneficiary`).
 * Useful when a platform or agent funds bets on behalf of end users.
 *
 * Two critical effects of splitting them:
 *
 * 1. Tickets (and any eventual payout) go to `beneficiary`, NOT the signer.
 * 2. Jetton swaps route through `senderAddress`'s jetton wallet — if we
 *    passed `beneficiary` here instead, the signer's wallet couldn't
 *    authorise the transfer and the swap would fail.
 */
// WARNING: uses mainnet endpoints — test with minimal funds first.
import { TON_ADDRESS, TonClient, ToncastTxSdk } from "@toncast/tx-sdk";

const PARI_ADDRESS = "EQA7bkHU1hRX6LtvkuAASvN0YSX0tk-N9gx5Ji3oDioslLP0";

// The end user who will own the tickets on-chain.
const BENEFICIARY = "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8";

// The agent wallet actually signing the tx. Holds the funding jettons.
const AGENT = "UQAREREREREREREREREREREREREREREREREREREREREREbvW";

const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";

const tonClient = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
});
const txSDK = new ToncastTxSdk({ tonClient });

// IMPORTANT: priceCoins must describe the AGENT's holdings, not the
// beneficiary's. The agent is the one whose jettons will be consumed.
const priced = await txSDK.priceCoins({
  availableCoins: [
    { address: TON_ADDRESS, amount: 2_000_000_000n }, // agent's TON for swap gas
    { address: USDT, amount: 50_000_000n, symbol: "USDT", decimals: 6 },
  ],
});

console.log("Agent's viable sources:");
for (const c of priced) {
  if (c.viable) {
    console.log(
      `  ${c.symbol ?? c.address.slice(0, 10)} → netTon=${Number(c.netTon) / 1e9} TON`,
    );
  }
}

const picked = priced.find((c) => c.address === USDT && c.viable);
if (!picked) {
  console.error("Agent's USDT not viable for this bet — cannot proceed.");
  process.exit(1);
}

const quote = await txSDK.quoteFixedBet({
  pariAddress: PARI_ADDRESS,
  beneficiary: BENEFICIARY, // ← tickets owned by end user
  senderAddress: AGENT, // ← wallet that signs + provides jettons
  isYes: true,
  yesOdds: 56,
  ticketsCount: 10,
  referral: null,
  referralPct: 0,
  source: picked.address,
  pricedCoins: priced,
});

if (!quote.option.feasible) {
  console.error("Quote infeasible:", quote.option.reason);
  process.exit(1);
}

// Re-check slippage just before signing, in case the pool moved.
const fresh = await txSDK.confirmQuote(quote, {
  pariAddress: PARI_ADDRESS,
  beneficiary: BENEFICIARY,
  senderAddress: AGENT, // ← same distinction maintained on confirm
  referral: null,
  referralPct: 0,
});

if (fresh.option.feasible) {
  for (const tx of fresh.option.txs) {
    console.log("agent signs:", {
      to: tx.to.toString(),
      value: `${Number(tx.value) / 1e9} TON`,
    });
    // ↳ hand this tx to TonConnect session bound to the AGENT wallet.
    //   On success, tickets accrue on-chain under BENEFICIARY ownership.
  }
}
