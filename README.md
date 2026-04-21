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
- [Bet modes](#bet-modes)
- [Pricing and viability filtering](#pricing-and-viability-filtering)
- [Confirming a quote before signing](#confirming-a-quote-before-signing)
- [Single-source funding only](#single-source-funding-only)
- [Public API reference](#public-api-reference)
- [Result types](#result-types)
- [Errors](#errors)
- [Configuration](#configuration)
- [Constants](#constants)
- [REQUIREMENT FOR AI AGENTS](#requirement-for-ai-agents)
- [License](#license)

---

## What it does

Given a Pari market on the Toncast protocol and the user's available coins, the SDK produces:

1. **Priced coin list** (`priceCoins`) — a per-coin TON valuation with a `viable` flag: unviable coins (where swap gas exceeds TON delivered) are flagged so the UI can grey them out.
2. **Bet quote** (`quoteFixedBet` / `quoteLimitBet` / `quoteMarketBet`) — a single TonConnect transaction funded by the user-picked source (TON or one jetton).
3. **Confirmation step** (`confirmQuote`) — a fresh re-simulation just before the user signs, throwing `SLIPPAGE_DRIFTED` if the price moved beyond `slippage`.

Jetton swaps go through STON.fi DEX v2+, either direct or through a single intermediate hop (e.g. jetton → USDT → TON). All cost math mirrors the on-chain Pari / pari-proxy contracts exactly.

## Installation

```bash
npm install @toncast/tx-sdk @ston-fi/api @ston-fi/sdk @ton/ton
```

`@ston-fi/api` and `@ston-fi/sdk` are peer dependencies — needed only when you use jetton funding. For TON-only flows you can skip the SDK class entirely and use the pure exports (`buildTonBetTx`, `computeFixedBets`, `calcBetCost`).

## Flow overview

```text
availableCoins ─────► txSDK.priceCoins()      ────►  PricedCoin[]
                                                      │
                                                      │  UI shows
                                                      │  TON-equivalents,
                                                      │  user picks
                                                      │  one source
                                                      ▼
source + pricedCoins ► txSDK.quoteFixedBet()   ────►  BetQuote
                                                      │
                                                      │  user reviews,
                                                      │  presses "Confirm"
                                                      ▼
                      txSDK.confirmQuote()     ────►  BetQuote (fresh)
                                                      │
                                                      │  on SLIPPAGE_DRIFTED:
                                                      │  show new rate,
                                                      │  ask to re-confirm
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
// priced[i] = { address, tonEquivalent, gasReserve, netTon, route, viable, ... }

// 2. Pick a source (user's choice from UI). TON-first if viable is sensible.
const picked =
  priced.find((c) => c.address === TON_ADDRESS && c.viable) ??
  priced.find((c) => c.viable);
if (!picked) throw new Error("no viable source");

// 3. Quote.
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

// 4. Confirm just before signing (recheck slippage for jetton source).
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

### Market

Spend `maxBudgetTon` greedily on the best counter-side liquidity, placement at the last matched yesOdds (or 50% if nothing matched).

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
  tonEquivalent: bigint; // gross TON after slippage (minAskUnits)
  gasReserve: bigint;    // swap gas locked on the wallet (0 for TON)
  netTon: bigint;        // tonEquivalent − gasReserve (0n if !viable)
  route: "direct" | { intermediate: string } | null;
  viable: boolean;       // swap delivers more TON than it costs in gas
  reason?: string;       // explanation when !viable
};
```

The rules:

| Coin                      | Viable iff                                      | `gasReserve`  |
| ------------------------- | ----------------------------------------------- | ------------- |
| TON                       | `amount > walletReserve + TON_DIRECT_GAS`       | `0.05 TON`    |
| Jetton (direct route)     | `tonEquivalent > DIRECT_HOP_JETTON_GAS_ESTIMATE` | `0.3 TON`    |
| Jetton (2-hop route)      | `tonEquivalent > CROSS_HOP_JETTON_GAS_ESTIMATE`  | `0.6 TON`    |
| Jetton (no route)         | never                                           | `0n`          |

No bet parameters are required. Viability is a pure property of "is swapping this coin net-positive in TON?" — independent of bet sizing. Aggregate `netTon` across the user's viable coins in your UI if you want "total available to bet."

## Confirming a quote before signing

`BetQuote.lockedInRate` captures the jetton route, `offerUnits` and `priceImpact` at quote time. `confirmQuote` uses it to detect drift:

```ts
try {
  const fresh = await txSDK.confirmQuote(quote, {
    pariAddress,
    beneficiary,
    senderAddress,    // optional; defaults to beneficiary
    referral,
    referralPct,
  });
  // fresh.option.txs are up-to-date — use them for signing.
} catch (e) {
  if (e instanceof ToncastBetError && e.code === "SLIPPAGE_DRIFTED") {
    // Show new rate to the user; on Confirm call confirmQuote again.
  } else {
    throw e;
  }
}
```

- TON-funded quotes (`lockedInRate === null`): `confirmQuote` returns the same object — there's no swap, no drift risk.
- Jetton-funded quotes: `confirmQuote` clears the rate cache, re-runs the reverse simulation for `quote.totalCost`, and throws if `newPriceImpact > slippage`. Otherwise it returns a fresh quote with updated `offerUnits` and rebuilt `txs`.

## Single-source funding only

Every successful quote emits **exactly one transaction** funded by **one source** (TON or a single jetton). There is no composite / multi-source mode:

- Predictable UX: one TonConnect prompt, not N.
- No partial-fill risk: either the one swap succeeds and the bet is placed, or nothing happens and the user retries with a different source.

If no single viable source covers the bet, the quote is returned `feasible: false` with `reason: "insufficient_balance"` and a `shortfall` in nano-TON. The user must top up the chosen coin (or pre-swap to TON in another wallet) and quote again.

## Public API reference

### `new ToncastTxSdk(options?)`

```ts
type ToncastTxSdkOptions = {
  tonClient?: TonClient;                 // required for jetton flows
  apiClient?: StonApiClient;             // defaults to new StonApiClient()
  rateCacheTtlMs?: number;               // swap-sim cache TTL, default 5000
  customPayloadForwardGas?: bigint;      // jetton-leg TON buffer, default 0.1
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
  txs: TxParams[],                     // exactly one entry
  breakdown: { spend: bigint, gas: bigint },
  slippage?: string,
  route?: "direct" | { intermediate: string },
  warnings?: string[],                 // e.g. "high slippage 4.2%"
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

- **`ToncastBetError`** (validation / logic): `INVALID_ODDS`, `EMPTY_BETS`, `INVALID_ADDRESS`, `REFERRAL_EQUALS_BENEFICIARY`, `NO_ROUTE`, `SLIPPAGE_DRIFTED`, `SOURCE_NOT_VIABLE`, `SOURCE_NOT_IN_PRICED_COINS`, etc. Not retriable — fix the inputs.
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
| `TON_DIRECT_GAS`                     | `50_000_000n`      | TON-direct bet gas buffer                   |
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

## REQUIREMENT FOR AI AGENTS

See [AGENTS.md](./AGENTS.md). In short: this toolkit handles digital assets and may cause irreversible loss of funds if misused. An AI agent generating integration code **must** obtain explicit acknowledgment of financial risk from the developer before proceeding, and mainnet smoke-testing on minimal amounts is mandatory before any production use.

## License

MIT — see [LICENSE](./LICENSE).
