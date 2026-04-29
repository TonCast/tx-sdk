<div align="center">
  <h1>@toncast/tx-sdk</h1>
  <p><strong>Build TonConnect-ready transactions for Toncast Pari bets — from TON or any jetton via STON.fi.</strong></p>
</div>

[![TON](https://img.shields.io/badge/based%20on-TON-blue)](https://ton.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

---

## Table of contents

- [What it does](#what-it-does)
- [Installation](#installation)
- [Flow overview](#flow-overview)
- [Quick start](#quick-start)
- [Common parameters](#common-parameters)
- [Betting on behalf of another user](#betting-on-behalf-of-another-user)
- [Bet modes](#bet-modes)
- [Pricing and viability filtering](#pricing-and-viability-filtering)
- [Confirming a quote before signing](#confirming-a-quote-before-signing)
- [Rate caching and API traffic](#rate-caching-and-api-traffic)
- [Single-source funding only](#single-source-funding-only)
- [Subscriptions](#subscriptions)
- [How TON flows in a jetton bet](#how-ton-flows-in-a-jetton-bet)
- [Public API reference](#public-api-reference)
- [Result types](#result-types)
- [Errors](#errors)
- [Configuration](#configuration)
- [Constants](#constants)
- [Troubleshooting](#troubleshooting)
- [REQUIREMENT FOR AI AGENTS](#requirement-for-ai-agents)
- [License](#license)

---

## What it does

Given a Pari market on the Toncast protocol and the user's available coins, the SDK produces:

1. **Priced coin list** (`priceCoins`) — a per-coin TON valuation with a `viable` flag: unviable coins (where swap gas exceeds TON delivered) are flagged so the UI can grey them out. Rate info is cached for 5 minutes.
2. **Bet quote** (`quoteFixedBet` / `quoteLimitBet` / `quoteMarketBet`) — for TON sources, a ready-to-sign transaction; for jetton sources, an **estimated** preview based on the cached `priceCoins` rate. No STON.fi API call happens at this step for jettons — interactive UIs (sliders, ticket adjusters) can re-quote on every keystroke without network traffic.
3. **Confirmation step** (`confirmQuote`) — **mandatory** before signing a jetton-funded quote: runs a fresh reverse-simulation, builds the actual transaction, and throws `SLIPPAGE_DRIFTED` if the price moved beyond `slippage`. No-op for TON sources.

Jetton swaps go through STON.fi DEX v2+, either direct or through a single intermediate hop (e.g. jetton → USDT → TON). All cost math mirrors the on-chain Pari / pari-proxy contracts exactly.

## Installation

```bash
npm install @toncast/tx-sdk @ston-fi/api @ston-fi/sdk @ton/ton
```

`@ston-fi/api` and `@ston-fi/sdk` are peer dependencies — needed only when you use jetton funding. For TON-only flows you can skip the SDK class entirely and use the pure exports (`buildTonBetTx`, `computeFixedBets`, `calcBetCost`).

## Flow overview

```text
availableCoins ─────► txSDK.priceCoins()      ────►  PricedCoin[]
                                                      │  (one STON.fi fetch per coin,
                                                      │   cached 5 min)
                                                      │
                                                      │  UI shows TON-equivalents,
                                                      │  user picks one source
                                                      ▼
source + pricedCoins ► txSDK.quoteXxxBet()    ────►  BetQuote (PREVIEW)
                                                      │  - TON source:    tx ready
                                                      │  - Jetton source: estimated,
                                                      │                   txs: [],
                                                      │                   NO API call
                                                      │
                                                      │  (UI slider re-quotes freely;
                                                      │   no STON.fi traffic)
                                                      │
                                                      │  user presses "Confirm"
                                                      ▼
                      txSDK.confirmQuote()     ────►  BetQuote (FINAL)
                                                      │  - TON source:    unchanged
                                                      │  - Jetton source: fresh sim,
                                                      │                   tx built,
                                                      │                   estimated=false
                                                      │
                                                      │  on SLIPPAGE_DRIFTED:
                                                      │  show new rate, re-confirm
                                                      ▼
                      tonConnect.send(tx)
```

## Quick start

### TON-only, pure functions (no SDK class, no network calls)

```ts
import { buildTonBetTx, calcBetCost, computeFixedBets } from "@toncast/tx-sdk";

const { bets } = computeFixedBets({
  yesOdds: 56,
  ticketsCount: 100,
  isYes: true,
});

const { totalCost } = calcBetCost(bets, true);

const tx = buildTonBetTx({
  pariAddress: "EQA7bkHU1hRX6LtvkuAASvN0YSX0tk-N9gx5Ji3oDioslLP0",
  beneficiary: "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8",
  isYes: true,
  bets,
  referral: null,
  referralPct: 0,
});

// Sign `tx` with TonConnect / Tonkeeper / anything that accepts TxParams.
```

### TON or jetton, full SDK

```ts
import { TON_ADDRESS, TonClient, ToncastTxSdk } from "@toncast/tx-sdk";

const tonClient = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
});
const txSDK = new ToncastTxSdk({ tonClient });

// 1. Price available coins.
const priced = await txSDK.priceCoins({
  availableCoins: [
    { address: TON_ADDRESS, amount: 10_000_000_000n },
    { address: USDT, amount: 100_000_000n, symbol: "USDT", decimals: 6 },
  ],
});
// priced[i] = { address, tonEquivalent, tonEquivalentExpected, gasReserve, route, viable, ... }

// 2. Pick a source (user's choice from UI). TON-first if viable is sensible.
const picked =
  priced.find((c) => c.address === TON_ADDRESS && c.viable) ??
  priced.find((c) => c.viable);
if (!picked) throw new Error("no viable source");

// 3. Quote. For jetton source this is a PREVIEW — `option.estimated === true`,
//    `option.txs === []`. No STON.fi call happens here; the rate comes
//    from the `priceCoins` cache via linear extrapolation. Use this to
//    render UI sliders / breakdowns cheaply.
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
if (!quote.option.feasible) throw new Error(quote.option.reason);

// 4. Confirm just before signing. MANDATORY for jetton sources — this is
//    where the fresh reverse-simulation runs and `option.txs` gets populated.
//    For TON sources, confirmQuote is a no-op and returns `quote` unchanged.
const fresh = await txSDK.confirmQuote(quote, {
  pariAddress: PARI_ADDRESS,
  beneficiary: BENEFICIARY,
  referral: null,
  referralPct: 0,
});
if (fresh.option.feasible) {
  for (const tx of fresh.option.txs) {
    await tonConnect.sendTransaction(tx);
  }
}
```

## Common parameters

All three `quoteXxxBet` methods share the same base set of fields via `CommonBetParams`:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pariAddress` | `string` | **yes** | Address of the target Pari market contract on-chain. |
| `beneficiary` | `string` | **yes** | Address that will **own** the placed tickets on-chain. If the bet wins, payouts go here. Usually this is the end user's wallet. |
| `senderAddress` | `string` | no (defaults to `beneficiary`) | Address that will **sign** the transaction (the wallet connected via TonConnect). Different from `beneficiary` only when placing a bet on behalf of someone else — see [Betting on behalf of another user](#betting-on-behalf-of-another-user). |
| `isYes` | `boolean` | **yes** | `true` → YES side, `false` → NO side. |
| `referral` | `string \| null` | **yes** | Optional referral address. Must be `null` if `referralPct === 0`, and must be non-null + different from `beneficiary` if `referralPct > 0`. |
| `referralPct` | `number` (0..7) | **yes** | Referral share in percent. `0` disables. Validated on-chain as `uint3`, so the max is 7. |
| `source` | `string` | **yes** | Address of the coin to fund the bet with (`TON_ADDRESS` or a jetton master address). Must be present in `pricedCoins` and `viable`. |
| `pricedCoins` | `PricedCoin[]` | **yes** | Output of `txSDK.priceCoins(...)`. Must include the `source`; other entries are ignored. |
| `slippage` | `string` | no (default `"0.05"`) | Max acceptable per-leg STON.fi price-impact as a decimal string. `"0.05"` = 5%. |
| `walletReserve` | `bigint` | no (default `0.05 TON`) | TON kept on the wallet after all transactions complete. Safety floor to make sure the wallet stays functional. |

Plus mode-specific fields:

- **Fixed**: `yesOdds: number` (2..98 even), `ticketsCount: number`.
- **Limit**: `oddsState: OddsState`, `worstYesOdds: number`, `ticketsCount: number`.
- **Market**: `oddsState: OddsState`, `maxBudgetTon: bigint`.

## Betting on behalf of another user

Useful for agent / concierge / gift flows where the wallet signing the transaction is **not** the owner of the resulting tickets. By default `senderAddress` defaults to `beneficiary` — the common case where one person bets for themselves. To bet on behalf of someone else, pass both explicitly:

```ts
const quote = await txSDK.quoteFixedBet({
  pariAddress: PARI,
  beneficiary: "UQDr92G-zeVDGAi-1xzsOVDAdy9jwoHwxNYPG7AGnuiNfkR8",   // the RECIPIENT of tickets
  senderAddress: "UQAREREREREREREREREREREREREREREREREREREREREREbvW", // the SIGNING wallet
  isYes: true,
  yesOdds: 56,
  ticketsCount: 10,
  referral: null,
  referralPct: 0,
  source: USDT,
  pricedCoins: await txSDK.priceCoins({
    availableCoins: [{ address: USDT, amount: 50_000_000n }],  // sender's USDT
  }),
});
```

Two critical effects of splitting `senderAddress` and `beneficiary`:

1. **On-chain ownership**. The `BatchPlaceBetsForWithRef` message carries `beneficiary` as the ticket owner. If the market resolves in your favour, Pari sends the payout to `beneficiary`, not to the signer. The signer funds, the beneficiary owns.
2. **Jetton flow** routing. When the bet is funded from a jetton, the STON.fi router must derive the correct jetton-wallet to pull tokens from. The SDK passes `senderAddress` to STON.fi as `userWalletAddress`. Passing `beneficiary` here would route through the **beneficiary's** jetton wallet, which the signer's wallet cannot authorise → swap fails at the first hop. The SDK gets this right as long as you pass `senderAddress` explicitly.

### Flow diagram

```text
                           ┌────────────────────────────────┐
 [signer's wallet]         │ @toncast/tx-sdk                │
 (= senderAddress)         │                                │
                           │ buildJettonBetTx({             │
 holds jettons for swap ───▶     senderAddress: signer,     │
                           │     beneficiary:  recipient,   │
                           │     ...                        │
                           │ })                             │
                           └───────────────┬────────────────┘
                                           │
                                 STON.fi swap JETTON → TON
                                           │
                                           ▼
                                 Toncast proxy
                                           │
                                 BatchPlaceBetsForWithRef
                                 with beneficiary = recipient
                                           │
                                           ▼
                                 Pari market contract
                                           │
                                 tickets owned by RECIPIENT ← ticket receiver
                                           │
                                 change returns to `refund_address` on swap path
                                 → by STON.fi convention this is the signer's wallet
```

### Practical notes

- **TonConnect flow**: the TonConnect session on your app is bound to the signing wallet. `senderAddress` **must** be that wallet's address; `beneficiary` can be any other valid TON address.
- **Jetton balance check**: `priceCoins` must be called with the **signer's** coins — the signer is the one who actually parts with jettons. Passing the beneficiary's coins would produce a quote that looks viable but fails on-chain because the signer doesn't own those tokens.
- **Referral constraint**: `referral` can be any valid TON address, including `beneficiary` (self-referral is allowed) or `senderAddress`.
- **TON-direct path** (no swap): the distinction between signer and beneficiary still applies to ticket ownership, but no STON.fi routing is involved. `buildTonBetTx` uses `beneficiary` for tickets and ignores `senderAddress` (any TON in the signed message comes from whoever signs — TonConnect already knows who that is).

See `examples/bet-on-behalf.ts` for a self-contained runnable sample.

## Bet modes

All three modes produce a `BetQuote` with the same shape — only how `bets[]` is composed differs.

### Fixed

One `yesOdds`, one `ticketsCount`. Ignores current liquidity — on-chain matching is performed by Pari.

```ts
await txSDK.quoteFixedBet({
  ...common,
  yesOdds: 56,
  ticketsCount: 100,
});
```

### Limit

Match available counter-side liquidity up to `worstYesOdds`; place the remainder as a new bet at `worstYesOdds`.

```ts
await txSDK.quoteLimitBet({
  ...common,
  oddsState,           // { Yes: number[49], No: number[49] } from Pari
  worstYesOdds: 56,
  ticketsCount: 300,
});
```

**OddsState indexing convention** — each side is indexed by **its own-side probability**, not by yesOdds:

- `Yes[i]` — YES orders at yesOdds (= YES-probability) `2·(i+1)`. Direct: index `yesOddsToIndex(yesOdds)`.
- `No[i]` — NO orders at NO-probability `2·(i+1)`, which equals yesOdds `100 − 2·(i+1)`. Complementary: index `yesOddsToIndex(100 − yesOdds)`.

For example, `No[17] = 200` means "200 NO tickets sitting at NO-prob 36% = cheap NO tickets at Pari yesOdds **64**" — *not* at yesOdds 36. A YES bet at yesOdds=64 will match this pool; a YES bet at yesOdds=36 will not. The SDK's `availableTickets(state, isYes, yesOdds)` helper hides this asymmetry — use it instead of indexing arrays manually.

### Market

Spend `maxBudgetTon` greedily on the best counter-side liquidity, then park any residual budget on the **first matched** yesOdds — the cheapest per-ticket price on the user's side (falling back to 50% if nothing matched). This maximises tickets per TON spent; earlier versions anchored the placement to `lastYesOdds` (the most expensive matched), which could cost the user 60 %+ of tickets on a scattered order book.

```ts
await txSDK.quoteMarketBet({
  ...common,
  oddsState,
  maxBudgetTon: 884_416_000_000n,
});
```

## Pricing and viability filtering

`txSDK.priceCoins(...)` iterates the supplied coins once and returns:

```ts
type PricedCoin = {
  address: string;
  symbol?: string;
  decimals?: number;
  amount: bigint;
  // Gross TON from the full-amount swap. Two flavours:
  tonEquivalent: bigint;          // pessimistic = minAskUnits = askUnits × (1 − slippage)
  tonEquivalentExpected: bigint;  // expected = askUnits (stable-market projection)
  gasReserve: bigint;             // TON needed on the wallet for the swap (0.05/0.3/0.6)
  route: "direct" | { intermediate: string } | null;
  viable: boolean;                // tonEquivalent > gasReserve
  reason?: string;                // explanation when !viable
};
```

The rules:

| Coin                      | Viable iff                                      | `gasReserve`  |
| ------------------------- | ----------------------------------------------- | ------------- |
| TON                       | `amount > walletReserve + TON_DIRECT_GAS`       | `0n` (default — `PARI_EXECUTION_FEE` covers Pari-side gas) |
| Jetton (direct route)     | `tonEquivalent > DIRECT_HOP_JETTON_GAS_ESTIMATE` | `0.3 TON`    |
| Jetton (2-hop route)      | `tonEquivalent > CROSS_HOP_JETTON_GAS_ESTIMATE`  | `0.6 TON`    |
| Jetton (no route)         | never                                           | `0n`          |

### How much can this coin fund? `availableForBet(coin, walletReserve)`

Import the helper and use it for both UI aggregates and SDK-internal feasibility checks:

```ts
import { availableForBet, DEFAULT_WALLET_RESERVE } from "@toncast/tx-sdk";

const capacity = availableForBet(coin, DEFAULT_WALLET_RESERVE);
//   TON:    amount − walletReserve − TON_DIRECT_GAS       (default `TON_DIRECT_GAS = 0n`,
//                                                          so collapses to amount − walletReserve)
//   Jetton: tonEquivalent if viable, else 0 (no gas subtraction!)

const totalCapacity = priced
  .filter((c) => c.viable)
  .reduce((s, c) => s + availableForBet(c, DEFAULT_WALLET_RESERVE), 0n);
```

Why no gas subtraction for jettons: swap gas (`gasReserve`, 0.3/0.6 TON) is paid from the user's **TON wallet**, not from the jetton itself. The planner checks TON-wallet gas availability separately (`insufficient_ton_for_gas`), so the jetton's contribution to the bet is exactly what the swap delivers.

### `tonEquivalent` vs `tonEquivalentExpected`

Both refer to **how much TON this coin can contribute to a bet** — uniform meaning across TON and jetton sources. The difference is whether the slippage assumption is pessimistic or expected.

| Source | `tonEquivalent` (pessimistic floor) | `tonEquivalentExpected` (optimistic) |
|---|---|---|
| Jetton | `minAskUnits` from STON.fi (= `askUnits × (1 − slippage)`) | `askUnits` from STON.fi |
| TON | `amount − walletReserve − gasReserve` (no slippage axis) | same as `tonEquivalent` (collapses) |

For TON sources `tonEquivalent === tonEquivalentExpected === availableForBet(coin, walletReserve)`. The raw on-wallet balance is still available as `coin.amount`.

**UI rule of thumb**: read `coin.tonEquivalent` for slider maxima and `maxBudgetTon` arguments to `quoteXxxBet`. `tonEquivalentExpected` is only meaningful for jetton sources where the gap between expected and floor is non-zero (slippage band) and you want to show "~X TON expected" alongside the guaranteed floor. The safety-critical numbers (`availableForBet`, `option.breakdown.spend`) use `tonEquivalent`.

No bet parameters are required for `priceCoins`. Viability is a pure property of "is swapping this coin net-positive in TON?" — independent of bet sizing.

### Per-pool slippage (`recommendedSlippage` / `effectiveSlippage`)

`priceCoins` reads STON.fi's per-pool slippage recommendation from each simulation and uses it to **tighten** the slippage actually applied to that coin's swaps. The user-set `slippage` becomes a hard ceiling, never a floor:

```
effectiveSlippage = min(stonfi.recommendedSlippageTolerance, userSlippage)
```

For a deep pool like USDT/TON, STON.fi often recommends ~0.3 %, so `effectiveSlippage` collapses well below the default 5 % — the user spends fewer source jettons for the same TON delivery. For a thin memecoin pool that wants 7 % headroom while the user only allowed 5 %, the SDK clamps at 5 % (and the swap may revert at the user's tighter floor — that's the user's policy choice).

Each `PricedCoin` exposes:

| Field | Source | Meaning |
|---|---|---|
| `recommendedSlippage?` | STON.fi `recommendedSlippageTolerance` (worst-leg for cross-hop) | What STON.fi suggests for this pool + this swap size. |
| `recommendedMinAskUnits?` | STON.fi `recommendedMinAskUnits` (final leg) | TON floor at `recommendedSlippage`, raw from STON.fi. |
| `effectiveSlippage?` | `min(recommended, userSlippage)` | What the SDK actually applies — to `tonEquivalent`, planner's `offerUnits` estimate, `lockedInRate.slippage`, and ultimately the reverse-sim grossUp inside `confirmQuote`. |
| `tonEquivalent` | computed at `effectiveSlippage` | Floor delivery used by `availableForBet` and the planner. |

UI can read `recommendedSlippage` to display "STON.fi recommends 0.3 % · you set 5 %" and `effectiveSlippage` to confirm what the SDK will actually use. End-to-end: `priceCoins` → `quoteXxxBet` → `confirmQuote` all carry the same `effectiveSlippage` for the chosen source — no double-counting, no extra API roundtrip.

## Confirming a quote before signing

`confirmQuote` is the **authoritative** step that produces a signed-ready `BetQuote` for jetton sources. Behaviour:

- **TON sources**: `confirmQuote` is a no-op. Quote already has `option.txs[0]` ready from `quoteXxxBet`. Calling `confirmQuote` returns the same object — useful so your sign-button handler doesn't branch on source type.
- **Jetton sources**: `quoteXxxBet` produces an **estimated** quote (`option.estimated === true`, `option.txs === []`). To get a signable tx, call `confirmQuote`. It:
  1. Clears the rate cache.
  2. Runs a fresh reverse-simulation against STON.fi for the exact `totalCost`.
  3. Throws `ToncastBetError` with code `SLIPPAGE_DRIFTED` if the fresh `priceImpact` exceeds the slippage tolerance.
  4. Otherwise builds the transaction and returns a new `BetQuote` with `option.estimated === false`, `option.txs.length === 1`, and `option.breakdown.spend` refined to the exact `offerUnits`.

```ts
try {
  const fresh = await txSDK.confirmQuote(quote, {
    pariAddress,
    beneficiary,
    senderAddress,    // optional; defaults to beneficiary
    referral,
    referralPct,
  });
  // fresh.option.txs is the authoritative list — sign these.
  for (const tx of fresh.option.txs) {
    await tonConnect.sendTransaction(tx);
  }
} catch (e) {
  if (e instanceof ToncastBetError && e.code === "SLIPPAGE_DRIFTED") {
    // Show new rate to the user; on Confirm call confirmQuote again.
    // The underlying rate cache was already cleared inside confirmQuote,
    // so the next call will also fetch fresh.
  } else if (e instanceof ToncastBetError && e.code === "QUOTE_INFEASIBLE") {
    // The quote you passed in was `feasible: false`. Show the failure
    // reason to the user instead of trying to confirm it.
  } else {
    throw e;
  }
}
```

Why is `quoteXxxBet` not authoritative for jetton sources? Interactive UIs (sliders, ticket count adjusters) call `quoteXxxBet` many times per second as the user fiddles. Running a reverse-simulation against STON.fi on every keystroke is wasteful — and the user isn't going to sign right now anyway. Deferring the simulate to `confirmQuote` means:

- `priceCoins` is the only step that fetches swap rates during interaction (cached 5 min).
- `quoteXxxBet` is CPU-only: a linear extrapolation `(amount × totalCost / tonEquivalent)` ≈ jetton needed.
- `confirmQuote` runs exactly one reverse-simulation just before the signature, giving an exact `offerUnits` and an up-to-the-second drift check.

The linear extrapolation in `quoteXxxBet` is pessimistic (smaller swaps have lower price impact than the full-amount swap `priceCoins` simulated), so the `breakdown.spend` shown in the UI is always an upper bound. `confirmQuote` typically refines `spend` **downward** — user pays slightly less jetton than the preview suggested. Safe.

## Rate caching and API traffic

The SDK minimises STON.fi API traffic aggressively. Three cache layers cooperate:

| Layer | What it caches | Default TTL | Invalidation |
| --- | --- | --- | --- |
| **Pairs cache** | `/v1/markets` response (~40K pairs) | `PAIRS_CACHE_TTL_MS` = 5 min | `clearRateCache()` |
| **Rate cache** | `simulateSwap` / `simulateReverseSwap` responses keyed by `(offer, ask, units, slippage, direction)` | `DEFAULT_RATE_CACHE_TTL_MS` = 5 min | `clearRateCache()` or `confirmQuote` (auto) |
| **Linear extrapolation** | Jetton `offerUnits` derived from `priceCoins` output | Until next `priceCoins` call | Re-price coins |

Traffic flow for a typical UI session:

```text
Screen opens:
  priceCoins(N coins)     → 1 pairs fetch + ≤ N simulate calls.

User drags slider (many times, any mode):
  quoteXxxBet(...)        → 0 STON.fi calls (linear extrapolation).

User presses "Confirm":
  confirmQuote(quote)     → 1 simulateReverseSwap (direct) or 2 (cross-hop).

Total STON.fi calls per bet:
  1 (markets) + N (priceCoins) + 1-2 (confirmQuote)
```

Previous versions (pre-0.2.0) ran a reverse-simulation on every `quoteXxxBet` call — dozens of requests per slider interaction. The current design keeps interactive UX on pure client computation.

Also, HTTP 400 responses (e.g. "pool not found" for jettons without a direct TON pool) are no longer retried by `withRetry`, and the pairs cache pre-check avoids issuing the 400 in the first place for jettons that have no direct pair listed in `/v1/markets`. This makes the DevTools Network tab significantly quieter during `priceCoins` on mixed-jetton wallets.

## Single-source funding only

Every successful quote emits **exactly one transaction** funded by **one source** (TON or a single jetton). There is no composite / multi-source mode:

- Predictable UX: one TonConnect prompt, not N.
- No partial-fill risk: either the one swap succeeds and the bet is placed, or nothing happens and the user retries with a different source.

If no single viable source covers the bet, the quote is returned `feasible: false` with `reason: "insufficient_balance"` and a `shortfall` in nano-TON. The user must top up the chosen coin (or pre-swap to TON in another wallet) and quote again.

## Preview mode (`allowInsufficientBalance`)

By default `quoteXxxBet` returns `feasible: false` as soon as the balance falls short — even the ones the TonConnect wallet would catch on its own. That's safe but inconvenient: a slider-driven UI can't build the transaction for a user who just hasn't topped up yet, and `confirmQuote` throws `QUOTE_INFEASIBLE`.

Pass `allowInsufficientBalance: true` in any `quoteXxxBet` call to switch to preview mode:

```ts
const quote = await sdk.quoteFixedBet({
  // ...standard params...
  source: TON_ADDRESS,
  pricedCoins,
  allowInsufficientBalance: true,
});

if (quote.option.feasible) {
  // `txs[]` is built, `warnings` and `shortfall` explain the gap.
  if (quote.option.shortfall && quote.option.shortfall > 0n) {
    ui.showTopUpBanner(quote.option.shortfall);
    ui.disablePlaceBetButton();
  } else {
    ui.enablePlaceBetButton();
  }
}
```

The flag relaxes every balance-based shortfall, but **each has a different safety profile** — the emitted `warnings[]` distinguishes them:

| Case | Default | With flag | Safety |
|---|---|---|---|
| TON source, balance < totalCost + gas + walletReserve | `feasible: false` (`insufficient_balance`) | `feasible: true`, `warnings: ["insufficient_balance …"]`, `shortfall` set, tx built. | **Wallet-caught.** TonConnect refuses to sign (`value` > balance). No gas burned. |
| Jetton source, wallet TON < swap gas reservation | `feasible: false` (`insufficient_ton_for_gas`) | `feasible: true` (`estimated`), `warnings: ["insufficient_ton_for_gas …"]`, `shortfall` set. `confirmQuote` produces a concrete tx. | **Wallet-caught.** Tx `value` includes the full gas amount, wallet refuses to sign. No gas burned. |
| **Jetton source, jetton balance below `totalCost`** | `feasible: false` (`insufficient_balance`) | `feasible: true` (`estimated`), `warnings: ["insufficient_balance … burn …"]`, `shortfall` set. `confirmQuote` produces a concrete tx. | **NOT wallet-caught.** The signing wallet cannot see the jetton balance. If the UI forwards the tx, it reaches the network, the jetton wallet bounces the transfer on-chain, and **~0.01 TON of gas burns.** |

Reading the warning string is the only way to tell these apart after the fact. The jetton-balance warning always contains the word **`burn`** in its text — grep for it in UI code if you want to refuse sending without an extra confirmation.

```ts
function isGasBurnRisk(warnings: string[] | undefined): boolean {
  return warnings?.some((w) => /burn/i.test(w)) ?? false;
}
```

UI using the flag should:

1. Always read `quote.totalCost`, `calcWinnings(bets, referralPct)`, etc. to render cost / payout info regardless of feasibility.
2. For `option.feasible === true` with `shortfall` set:
   - Inspect `option.warnings`. If `isGasBurnRisk(option.warnings)` — show a stronger confirmation dialog explaining that ~0.01 TON of gas will be spent and the bet will not go through (because the user is short on the jetton itself). Let the user choose.
   - Otherwise (wallet-caught cases) — a lighter banner "Wallet will ask you to top up" is enough; the UI can let the user proceed and TonConnect will refuse harmlessly.
3. For `option.feasible === false` — these are *non-balance* blockers (`no_route`, `source_not_viable`, `source_not_in_priced_coins`, `ton_client_required`, `budget_too_small_for_single_entry`). Surface the `reason` as an error; never fall through to `confirmQuote` (it throws `QUOTE_INFEASIBLE`).

## Subscriptions

For live-updating UIs (Market / Limit sliders where the user drags amounts and the quote needs to refresh every few seconds), use the `subscribeXxxBet` helpers. They wrap `quoteXxxBet` in a polling loop with abort support:

```ts
import { subscribeMarketBet } from "@toncast/tx-sdk";

const subscription = subscribeMarketBet(
  txSDK,
  {
    pariAddress: PARI,
    beneficiary: BENEFICIARY,
    isYes: true,
    oddsState,
    maxBudgetTon: 5_000_000_000n,
    referral: null,
    referralPct: 0,
    source: TON_ADDRESS,
    pricedCoins,
  },
  (quote) => {
    // Called with each fresh BetQuote. Re-render your UI here.
    setQuote(quote);
  },
  {
    intervalMs: 3000,                    // default 3000
    signal: abortController.signal,      // optional — cancel loop externally
    onError: (err) => console.warn(err), // optional — errors do NOT stop the loop
  },
);

// Stop when the user navigates away / closes the bet UI.
subscription.stop();
await subscription.done;
```

The underlying rate cache (`rateCacheTtlMs`, default 5s) keeps STON.fi traffic bounded even at short poll intervals — two consecutive `simulateSwap` calls with the same `offerUnits` / `slippage` reuse the cached response. Invalidate manually with `txSDK.clearRateCache()` if you need an immediate refresh.

Three subscription variants mirror the three quote methods:

| Helper | Wraps | Use for |
| --- | --- | --- |
| `subscribeFixedBet` | `quoteFixedBet` | Rarely — Fixed parameters don't change; mostly for dev / debug. |
| `subscribeLimitBet` | `quoteLimitBet` | Limit-mode UI with a live `oddsState` feed. |
| `subscribeMarketBet` | `quoteMarketBet` | Market-mode slider UIs. |

## How TON flows in a jetton bet

A worked-through example of where each TON goes, for a concrete real-world bet (STON→TON direct swap, 80 tickets at yesOdds=54, side=NO, totalCost = 3.78 TON):

```text
Your wallet signs ONE outgoing JettonTransfer:
  Value:              0.3 TON   ← STON.fi's recommended gas_budget from the API
  jetton amount:      17.34 STON
  forward_ton_amount: 0.24 TON  ← STON.fi's recommended forward_gas
  forward_payload     carries:  { min_out: 3.78 TON, custom_payload: <ProxyForward> }

0.3 TON breakdown during execution:
  ├─ ~0.06 TON            returned as excess from your jetton wallet
  └─ 0.24 TON             forwarded to STON.fi router with the jetton

STON.fi router performs the swap:
  17.34 STON  →  3.9789 TON   (actual pool delivery; must be ≥ min_out)

pTON unwraps swap output and sends to Toncast proxy:
  value = ton_amount + fwd_gas = 3.9789 + 0.1 = 4.0789 TON
                                       ↑
                                       DEX_CUSTOM_PAYLOAD_FORWARD_GAS (our constant)

Toncast proxy receives 4.0789 TON:
  checks msgValue ≥ totalCost + CONTRACT_RESERVE  (3.78 + 0.01 = 3.79)  ✓
  forwards to Pari:       3.78 TON   (= totalCost exactly, funds the bet)
  keeps on contract:      0.01 TON   (CONTRACT_RESERVE for storage)
  change to your wallet:  0.29 TON   (msgValue − totalCost − reserve)
```

Net outcome:

```
Spent:  17.34 STON  → 3.78 TON on a Pari bet
Received back in TON: ~0.06 TON (jetton-wallet excess) + 0.29 TON (proxy change)
                    = ~0.35 TON of your original 0.3 TON outgoing value survived
                      (plus the ~3.78 TON you now have as a bet position)
```

A few consequences worth internalising:

- **The SDK never "eats" TON** — every TON you sign for either goes into the bet on Pari or returns to your wallet as change / excess. Forward fees (~0.001 TON per internal message) are the only unavoidable loss.
- **`DEX_CUSTOM_PAYLOAD_FORWARD_GAS = 0.1 TON`** is a slippage safety buffer, not a tip. It ensures that even if the swap delivers the absolute minimum (`minAskAmount = totalCost`), the proxy still has `totalCost + 0.1 ≥ totalCost + 0.01` and can forward. Without it, any real-world execution gas would push us below `CONTRACT_RESERVE` and the proxy would refund instead.
- **`minAskAmount = totalCost`** (not `totalCost × (1 − slippage)`) — see the DEX-level floor discussion under [Single-source funding only](#single-source-funding-only). This guarantees the proxy never receives a swap output below Pari's requirement, so refunds from the proxy are structurally impossible on successful swaps.
- **Rejected swaps** (pool moves too far against us): the DEX reverts, your jetton stays in your wallet, zero gas wasted on the Pari path. The bet simply doesn't happen — you retry with fresh rates via `confirmQuote` or a new `quoteXxxBet` call.

## Public API reference

### `new ToncastTxSdk(options?)`

```ts
type ToncastTxSdkOptions = {
  tonClient?: TonClient;                 // required for jetton flows
  apiClient?: StonApiClient;             // defaults to new StonApiClient()
  rateCacheTtlMs?: number;               // swap-sim cache TTL, default 5 min (300_000)
  pairsCacheTtlMs?: number;              // /v1/markets TTL,   default 5 min (300_000)
  customPayloadForwardGas?: bigint;      // jetton-leg TON buffer, default 0.1 TON
  maxRetries?: number;                   // default 1
  retryDelayMs?: number;                 // default 1000
  rateLimits?: {
    tonClient?: { minIntervalMs?: number };
    stonApi?: { minIntervalMs?: number };
  };
};
```

### Methods

| Method                        | Purpose                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `txSDK.priceCoins(params)`      | Value every coin in TON; flag viable sources.            |
| `txSDK.quoteFixedBet(params)`   | Build a tx for a Fixed-mode bet.                         |
| `txSDK.quoteLimitBet(params)`   | Build a tx for a Limit-mode bet.                         |
| `txSDK.quoteMarketBet(params)`  | Build a tx for a Market-mode bet.                        |
| `txSDK.confirmQuote(quote, p)`  | Fresh re-simulation + tx rebuild before signing.         |
| `txSDK.clearRateCache()`        | Drop cached swap simulations.                            |

### Pure functions

- `computeFixedBets`, `computeLimitBets`, `computeMarketBets` — bet math, no I/O.
- `calcBetCost`, `ticketCost` — on-chain cost mirror.
- `buildTonBetTx`, `buildJettonBetTx` — low-level tx builders.
- `planBetOption` — the function `quoteXxxBet` delegates to; takes strategy output + `PricedCoin[]` + `source` and returns `{ option, lockedInRate }`.
- `priceCoins` — the pure export powering `txSDK.priceCoins`.
- `subscribeFixedBet`, `subscribeLimitBet`, `subscribeMarketBet` — polling wrappers for live-updating UIs.
- `calcWinnings`, `yesOddsToDecimalOdds`, `yesOddsToProbabilityPct`, `breakdownTotals` — UI helpers.

## Result types

### `BetQuote`

```ts
type BetQuote = {
  mode: "fixed" | "limit" | "market";
  bets: BetItem[];               // final (merged) entries sent in the tx
  isYes: boolean;                // echoed from the quote params
  totalCost: bigint;             // total TON the bet will consume on Pari
  quotedAt: number;              // Date.now() at quote build time
  option: BetOption;             // feasible or infeasible plan
  lockedInRate: LockedInRate | null;  // null for TON-funded quotes
  breakdown: StrategyBreakdown;  // matched / placement / unmatched detail
};
```

### `BetOption`

Feasible:

```ts
{
  feasible: true,
  source: "TON" | { address, symbol?, decimals? },
  estimated: boolean,                  // true for jetton quotes until confirmQuote runs
  txs: TxParams[],                     // [] for estimated jetton quotes, 1 entry otherwise
  breakdown: { spend: bigint, gas: bigint },
  slippage?: string,
  route?: "direct" | { intermediate: string },
  warnings?: string[],
}
```

Infeasible:

```ts
{
  feasible: false,
  source,
  reason:
    | "insufficient_balance"
    | "insufficient_ton_for_gas"
    | "slippage_exceeds_limit"
    | "no_route"
    | "network_error"
    | "ton_client_required"
    | "source_not_viable"
    | "source_not_in_priced_coins"
    | "budget_too_small_for_single_entry",
  shortfall?: bigint,
  warnings?: string[],
}
```

## Errors

All errors extend `ToncastError`. Two subclasses:

- **`ToncastBetError`** (validation / logic): `INVALID_ODDS`, `EMPTY_BETS`, `INVALID_ADDRESS`, `NO_ROUTE`, `SLIPPAGE_DRIFTED`, `SOURCE_NOT_VIABLE`, `SOURCE_NOT_IN_PRICED_COINS`, etc. Not retriable — fix the inputs.
- **`ToncastNetworkError`** (upstream RPC/API): wraps `@ston-fi/api` or `@ston-fi/sdk` failures with `source` (`"stonApi"` | `"tonClient"`) and `method` fields. Retriable; the SDK already retries once by default.

## Configuration

Pass overrides to the constructor — see `ToncastTxSdkOptions` above. The defaults are tuned for the STON.fi public tier and toncenter's free tier; you will likely want more aggressive throttles (`rateLimits.*.minIntervalMs: 0`) and higher retries in production.

## Constants

All configuration constants are re-exported from `@toncast/tx-sdk`:

| Constant                             | Value              | Purpose                                     |
| ------------------------------------ | ------------------ | ------------------------------------------- |
| `TON_ADDRESS`                        | `EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c` | STON.fi's native-TON placeholder |
| `TONCAST_PROXY_ADDRESS`              | mainnet proxy      | Unwraps jetton payloads to Pari             |
| `WIN_AMOUNT_PER_TICKET`              | `100_000_000n`     | 0.1 TON per winning ticket                  |
| `PARI_EXECUTION_FEE`                 | `100_000_000n`     | 0.1 TON per bets-map entry                  |
| `TON_DIRECT_GAS`                     | `0n`               | TON-direct extra surplus on `value` (default off — `PARI_EXECUTION_FEE` covers Pari-side gas) |
| `DEX_CUSTOM_PAYLOAD_FORWARD_GAS`     | `100_000_000n`     | TON buffer on jetton-swap payload           |
| `DIRECT_HOP_JETTON_GAS_ESTIMATE`     | `300_000_000n`     | Direct jetton swap gas reserve              |
| `CROSS_HOP_JETTON_GAS_ESTIMATE`      | `600_000_000n`     | 2-hop jetton swap gas reserve               |
| `DEFAULT_SLIPPAGE`                   | `"0.05"`           | 5% max per-leg price impact                 |
| `DEFAULT_WALLET_RESERVE`             | `50_000_000n`      | 0.05 TON kept on the wallet                 |
| `PLATFORM_FEE_PCT`                   | `4`                | On-chain platform cut from winnings         |

## Subpath imports

For bundle-size minimisation, the package exposes two subpath exports:

- `@toncast/tx-sdk/jetton` — jetton-only entry point.
- `@toncast/tx-sdk/planner` — the `planBetOption` implementation.

Most integrators should just use the root `@toncast/tx-sdk` import.

## Troubleshooting

### `priceCoins` logs `400 Bad Request "1010: Could not find pool address"` in the console

Normal. This happens when a jetton has no **direct** pool with TON on STON.fi. The SDK catches the 400, falls through to 2-hop discovery via `/v1/markets`, and finds a `jetton → intermediate → TON` route. `priceCoins` still returns `viable: true` with `route: { intermediate: <address> }`. The 400 gets logged by the underlying HTTP library; functionally everything works. `withRetry` does **not** retry 400 responses (see `src/utils/retry.ts`), so there's no extra network traffic — just one log line.

### Quote returns `feasible: false, reason: "source_not_viable"`

The coin you picked as `source` was flagged `viable: false` in `pricedCoins`. That means swapping it in would cost more in gas than the swap delivers in TON. Inspect `pricedCoin.reason` for the specific cause (tiny jetton balance, no route, tonClient missing). Pick a different source.

### Quote returns `feasible: false, reason: "insufficient_balance"`

The source's `availableForBet(coin, walletReserve)` (after slippage-adjusted swap math) is below `totalCost`. `BetOption.shortfall` tells you in nano-TON how much more TON-equivalent the user would need to top up the selected coin with. No single other coin? The user must pre-consolidate in their wallet and try again — the SDK does not do multi-source funding.

### Quote returns `feasible: false, reason: "slippage_exceeds_limit"`

STON.fi projected `priceImpact` across the route exceeds `slippage` (default 5%). Either raise `slippage` in the quote params, or wait for the pool to recover, or pick a deeper-liquidity source.

### `confirmQuote` throws `SLIPPAGE_DRIFTED`

Between quote time and confirm time (typically seconds to minutes), the pool moved enough that a fresh simulation now reports `priceImpact > slippage`. UI should catch this, show the new rate to the user, and re-quote on explicit confirmation.

### `npm install` warns about peer deps `@ston-fi/api` / `@ston-fi/sdk` / `@ton/ton`

These are declared as **dependencies** (not peer dependencies) in `package.json`, so they install automatically. If you see warnings, it likely means a **version conflict** between the SDK's required version and what your host project has pinned. Options:
- Use `npm install` with `--legacy-peer-deps` to accept the mismatch (risky — may cause runtime bugs if APIs drifted).
- Align versions in your host project.
- Open an issue with both version numbers so the SDK's range can be widened in a patch release.

### `buildJettonBetTx` works locally but fails on-chain with a proxy refund

Since v0.1.0 this should be structurally impossible on successful swaps — the SDK sets `minAskAmount = totalCost` so the DEX reverts (rather than delivers under-target) before the proxy ever sees the message. If you see a proxy refund anyway, likely causes:

1. **Stale `TONCAST_PROXY_ADDRESS`** — the hardcoded proxy was redeployed on-chain and the SDK version you're on still points to the old one. Check the current proxy against `src/constants.ts`.
2. **Non-standard `bets` encoding** — the on-chain proxy (`toncast_swap_proxy.tolk`) iterates `bets` via `createMapFromLowLevelDict<uint8, cell>`, expecting **ref-per-entry** encoding. The SDK writes exactly that; if you're using a patched version that writes inline BetItem, the proxy catches the "No more references" exception and refunds. `tests/proxy-compatibility.test.ts` locks this invariant — do not revert.

Send the failing tx hash to the issue tracker; the maintainer can diff the payload against the current proxy schema.

## REQUIREMENT FOR AI AGENTS

See [AGENTS.md](./AGENTS.md). In short: this toolkit handles digital assets and may cause irreversible loss of funds if misused. An AI agent generating integration code **must** obtain explicit acknowledgment of financial risk from the developer before proceeding, and mainnet smoke-testing on minimal amounts is mandatory before any production use.

## License

MIT — see [LICENSE](./LICENSE).
