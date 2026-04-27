# Changelog

All notable changes to `@toncast/tx-sdk` will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.3]

### Fixed

- **Cross-hop swaps no longer compound slippage per leg.** The user-set
  `slippage` is now treated as a route-TOTAL budget (matching STON.fi /
  Omniston UI semantics), and the SDK splits it into a tighter per-leg
  slippage internally — `perLeg = 1 − √(1 − slippage)` — so the composed
  worst-case across both legs equals the user's stated slippage.
  - **Before**: a 5 % slippage on a 2-hop route (e.g. `TCAST → USDT →
    TON`) was applied as 5 % per leg, grossing the offer jetton up by
    `1/(1 − 0.05)² ≈ 1.108×`. Users observed wallets requesting ~5 %
    more jetton than the planner's linear estimate showed (mainnet:
    UI quoted 26.8 TCAST; wallet asked for 28.21 TCAST for the same
    bet).
  - **After**: total gross-up across the route is `1/(1 − slippage) ≈
    1.053×`, exactly the same factor as a direct swap at the same
    slippage. The wallet's "Sent" amount now matches the planner's
    linear estimate within ±2 % (rounding from two `grossUpForSlippage`
    ceil ops).
- **`PricedCoin.tonEquivalent` for cross-hop sources now reflects the
  TRUE route-total worst-case delivery** (`expected × (1 − slippage)`),
  not the per-leg floor STON.fi returns on `leg2.minAskUnits`. UI
  sliders bound by `tonEquivalent` thus expose ~5 % less max-bet
  capacity than 0.1.2 — but every TON inside the new range is now
  guaranteed to confirm without the wallet asking for unexpectedly
  more jetton.

### Changed

- New helpers in `src/utils/slippage.ts`:
  - `perLegSlippage(total, legCount)` — splits a route-total budget
    into per-leg (legCount=1 is a no-op for direct routes).
  - `combineLegSlippage(perLeg, legCount)` — inverse: composes per-leg
    recommendations into route-total for like-for-like comparison
    against the user's slippage.
- `PricedCoin.recommendedSlippage` for cross-hop is now the route-total
  composition of both per-pool recommendations
  (`1 − (1 − r1)(1 − r2)`), not the larger of the two leg values. It
  can be compared directly against `userSlippage`.
- `PricedCoin.recommendedMinAskUnits` for cross-hop is recomputed
  locally from the route-total recommendation
  (`tonEquivalentExpected × (1 − recommendedSlippage)`), not taken
  from the simulator's per-leg `recommendedMinAskUnits` (which would
  be sized for the wrong slippage scale).
- `simulateReverseCrossToTon` (`src/rates.ts`) and `discoverRoute`'s
  cross-hop simulator calls (`src/routing/discover.ts`) now pass
  `perLegSlippage(slippage, 2)` to STON.fi instead of the user's
  route-total slippage. Direct routes are unchanged.
- Field-level JSDoc in `src/types.ts` updated to make the route-total
  semantics explicit on `recommendedSlippage` / `effectiveSlippage`.

### Added

- New regression tests:
  - `tests/utils/slippage.test.ts` — round-trip and edge cases for
    `perLegSlippage` / `combineLegSlippage`.
  - `tests/pricing.test.ts` — pins the linear-estimate ↔ confirm-offer
    ratio at ≈ 1.0 for cross-hop (was ≈ 1.05 under the old code).
  - `tests/sdk.test.ts` — end-to-end `quote → confirmQuote` smoke
    tests for cross-hop with all three modes (`fixed`, `limit`,
    `market`), plus a "max-capacity bet still confirms" guard.

### Notes

- Direct (1-hop) routes are mathematically unchanged: `perLegSlippage(s, 1)`
  is the identity, so direct paths emit the same `tonEquivalent`,
  `offerUnits`, and `minAskAmount` as 0.1.2.
- TON-funded paths are unaffected.
- This is a *behavioural* breaking change for UI consumers reading
  `tonEquivalent` for cross-hop sources — the value will be ~5 %
  smaller for the same balance and slippage than in 0.1.2. UI
  sliders bound by `tonEquivalent` will automatically respect the
  new ceiling and stop offering bets that the wallet would have
  silently re-priced upward.
- Mainnet smoke-test on the cross-hop path is recommended before any
  production deploy. See `examples/bet-on-behalf.ts` for a worked
  example.

## [0.1.2]

### Changed

- **`PricedCoin.tonEquivalent` and `PricedCoin.tonEquivalentExpected`
  for TON sources now collapse to the spendable amount** (=
  `amount − walletReserve − gasReserve`), instead of the raw on-wallet
  balance.
  - Field meaning is now **uniform** across TON and jetton: "how much
    TON can this coin contribute to a bet". UI sliders read
    `tonEquivalent` directly without a per-source branch — matches the
    way jetton sources have always worked (`minAskUnits` from STON.fi).
  - Eliminates the failure mode introduced in 0.1.1 where UI passed
    `coin.amount` as `maxBudgetTon`, the strategy filled it almost
    entirely, planner emitted an `insufficient_balance` warning under
    `allowInsufficientBalance: true`, and the wallet refused to sign
    when `value + send-fee > balance`. With the new semantics, sliders
    bound by `tonEquivalent` (or by `maxBudgetTon = tonEquivalent`)
    leave `walletReserve` untouched on the wallet automatically.
  - The raw on-wallet balance remains available as `coin.amount`.
- `availableForBet(coin, walletReserve)` semantics unchanged — for TON
  it still recomputes from `coin.amount`, so it can be called with a
  different `walletReserve` than `priceCoins` was given. When the same
  reserve is used, it returns exactly `coin.tonEquivalent`.
- Documentation in `pricing.ts`, `types.ts` updated; test fixtures
  (`priceTon` / `tonPriced` helpers) and assertions adjusted.

### Notes

- Jetton-source pricing is unchanged.
- `availableForBet` and `BetOption.breakdown.spend` are unaffected (they
  already returned the correct numbers); this release just makes
  `tonEquivalent` itself the single source of truth for UI sizing.
- Combined with 0.1.1's `TON_DIRECT_GAS = 0n`, the recommended UI flow
  now is:
  1. `slider.max = coin.tonEquivalent`,
  2. `quoteXxxBet({ maxBudgetTon: coin.tonEquivalent })` (Market mode)
     or any value `≤ coin.tonEquivalent` (Fixed / Limit),
  3. `quote.option.breakdown.spend` matches what the wallet shows as
     "Sent" pixel-for-pixel.

## [0.1.1]

### Changed

- **`TON_DIRECT_GAS` default is now `0n`** (was `50_000_000n` / 0.05 TON).
  `PARI_EXECUTION_FEE` (`0.1 TON × N entries`, already inside `totalCost`)
  fully covers Pari's forward fees, storage, and compute gas; no extra
  surplus needs to be attached to the message `value`. Practical effect:
  - For TON-funded bets, the wallet's "Sent" amount now matches the UI's
    "Total" line exactly (was `totalCost + 0.05 TON`, surplus refunded
    later via a separate tx).
  - `PricedCoin.gasReserve` for TON sources is now `0n`.
  - `availableForBet(tonCoin, walletReserve)` now returns
    `balance − walletReserve` (was `balance − walletReserve − 0.05 TON`),
    so UI sliders sized via this helper can use up to ~0.05 TON more
    of the user's balance for the same wallet reserve.
- Override per-call still available via `BuildTonBetTxParams.tonDirectGas`
  for callers who have a verified mainnet reason to attach a surplus.
- Documentation in `constants.ts`, `builders/ton.ts`, `pricing.ts`, and
  `types.ts` updated to reflect the new default.

### Notes

- Jetton-funded paths are unaffected (`TON_DIRECT_GAS` is referenced only
  in TON-direct code paths). `DEX_CUSTOM_PAYLOAD_FORWARD_GAS` (0.1 TON
  for the proxy hop) and the `*_HOP_JETTON_GAS_ESTIMATE` reserves remain
  unchanged.
- Test fixtures updated: `tonPriced(amount)` / `priceTon(amount)`
  helpers now use `gasReserve: 0n` and `viable: amount > walletReserve`.

## [0.1.0] — initial release

First public release of `@toncast/tx-sdk` — a TypeScript SDK that builds
TonConnect-compatible transactions for placing bets on Toncast Pari
contracts. Funding can be either TON-direct or via STON.fi DEX v2+ swaps
from any jetton (direct or 2-hop).

### High-level flow

- **`priceCoins({ availableCoins })`** — values each coin in TON and
  flags which are viable funding sources. Per-coin TON valuation comes
  from a STON.fi simulation; per-pool slippage recommendation is read
  from the same simulation and used to tighten the floor where the
  pool allows.
- **`quoteXxxBet(...)`** (`fixed` / `limit` / `market`) — produces a
  `BetQuote` carrying `bets[]`, `totalCost`, `breakdown`, and a
  funding plan in `option`. For TON sources the transaction is built
  immediately. For jetton sources the option is **estimated** (no
  STON.fi roundtrip), so slider-driven UIs can re-quote freely.
- **`confirmQuote(quote, ...)`** — mandatory before signing a
  jetton-funded quote. Runs a fresh reverse simulation, rebuilds the
  transaction, and throws `SLIPPAGE_DRIFTED` if the price moved
  beyond the quote's slippage tolerance. No-op for TON sources.

### Bet modes

- **Fixed** (`computeFixedBets`, `quoteFixedBet`) — places a fixed
  number of tickets at a single `yesOdds`. Ignores current liquidity;
  on-chain matching is performed by Pari.
- **Limit** (`computeLimitBets`, `quoteLimitBet`) — greedily matches
  counter-side liquidity from best to worst yesOdds up to
  `worstYesOdds`, then parks any unmatched tail at `worstYesOdds`.
  Walk direction depends on `isYes` so YES users start at the
  lowest-yesOdds end and NO users start at the highest.
- **Market** (`computeMarketBets`, `quoteMarketBet`) — spends
  `maxBudgetTon` greedily on the best-priced counter-side liquidity,
  then parks any leftover budget on the FIRST matched yesOdds (the
  cheapest per-ticket price for the user's side). Falls back to
  `ODDS_DEFAULT_PLACEMENT = 50` when nothing matched. Unfeasible
  budgets surface as `feasible: false, reason: "budget_too_small_for_single_entry"`.

### Funding sources & routing

- **TON-direct path** (`buildTonBetTx`, planner's TON branch) —
  `value = totalCost + tonDirectGas`, body is the
  `BatchPlaceBetsForWithRef` cell. No DEX involvement.
- **Jetton-via-STON.fi path** (`buildJettonBetTx`, planner's jetton
  branch) — wraps the `BatchPlaceBetsForWithRef` cell into a
  `ProxyForward` envelope addressed to the Toncast swap proxy and
  routes via STON.fi v2+ (`getSwapJettonToTonTxParams` for direct
  pools, `getSwapJettonToJettonTxParams` for cross-hop). On-chain DEX
  floor (`minAskAmount`) is set to `totalCost` directly, so a swap
  that can't deliver the bet's full TON cost reverts cleanly instead
  of bouncing at the proxy and burning gas.
- **Route discovery** (`discoverRoute`, `PairsCache`) — consults a
  TTL-cached snapshot of `/v1/markets` first to avoid the
  deterministic HTTP 400 STON.fi returns for tokens with no direct
  TON pool. Pairs cache is symmetric across directions and
  deduplicates in-flight fetches across parallel `priceCoins` callers.

### Slippage handling

- **Per-pool effective slippage** — `priceCoins` reads STON.fi's
  `recommendedSlippageTolerance` and computes
  `effectiveSlippage = min(recommendedSlippage, userSlippage)`.
  `tonEquivalent`, planner estimates, and `confirmQuote`'s
  reverse-sim grossUp all use this single value. Deep pools (e.g.
  USDT/TON) typically resolve to ~0.3 %; the user-set slippage acts
  strictly as an upper bound.
- **Reverse-sim grossUp** (`grossUpForSlippage`) — sizes the swap so
  STON.fi's `minAskUnits` ≥ `totalCost`, preventing the proxy refund
  scenario observed on mainnet at sub-1% drift inside a 5% slippage
  band.
- **Drift detection** — `confirmQuote` throws
  `ToncastBetError("SLIPPAGE_DRIFTED")` when fresh `priceImpact`
  exceeds `effectiveSlippage`.

### Preview mode

- **`CommonBetParams.allowInsufficientBalance: boolean`** — opt-in
  preview mode. When `true`, balance shortfalls return
  `feasible: true` quotes carrying `warnings[]` + `shortfall` so UI
  can render cost / payout info regardless of feasibility.
  - **TON balance short** — wallet refuses to sign on `value > balance`. No gas burned.
  - **Jetton source, TON-for-gas short** — same protection. No gas burned.
  - **Jetton source, jetton balance short** — wallet cannot see the
    jetton balance, the tx broadcasts and the jetton wallet bounces
    on-chain (~0.01 TON of gas burns). The emitted warning
    explicitly contains the word `burn` so UI can show a stronger
    confirmation dialog (or refuse to send).

### Strategy helpers

- **`mergeSameOdds`** — folds duplicate-yesOdds entries to save one
  `PARI_EXECUTION_FEE` (0.1 TON) per duplicate. Strategies call this
  automatically; direct builder callers must call it themselves
  before passing bets to `validateBetParams`.
- **`availableTickets`** — counter-side liquidity lookup respecting
  the OddsState complementary indexing convention (YES bet at
  `yesOdds=X` matches NO orders at `No[yesOddsToIndex(100−X)]`).
- **`indexToYesOdds` / `yesOddsToIndex`** — bidirectional conversion
  with strict validation (uint7, even, 2..98).

### Validation & errors

- **`validateBetParams`** — single-source bet-input validation:
  pariAddress, beneficiary, senderAddress, bets array bounds,
  yesOdds range/step, ticketsCount uint32, referral pairing rules,
  duplicate yesOdds detection (suggests `mergeSameOdds`), 256-entry
  uint8 dictionary limit.
- **Error hierarchy** — `ToncastError` (base), `ToncastBetError`
  (typed `BetErrorCode`, programmer / validation errors — not
  retriable), `ToncastNetworkError` (wraps upstream RPC/API
  failures, retriable). Surfaces wrapped errors via
  `error.cause` for tooling that walks the chain.

### Subscriptions

- **`subscribeXxxBet`** — polling helper for live-updating UIs.
  Permanent `ToncastBetError` stops the loop after a single
  `onError` call (deterministic errors don't benefit from retry);
  transient errors back off exponentially
  (`intervalMs → 2× → 4× → … → 60 s`), reset on the first successful
  refresh. Honours both `controller.signal` and `opts.signal`,
  detaching listeners cleanly on `.stop()`.

### Networking & caching

- **`Throttler`** — per-client rate limiter. `callStonApi` /
  `callTonClient` apply it to **each retry attempt**, not just the
  initial call, so a 429 burst can't escalate against the public
  tier defaults.
- **`withRetry`** — linear backoff with explicit non-retry of HTTP
  400 (deterministic upstream errors). 429 / 5xx / network
  exceptions are retried; `AbortSignal` aborts the loop and any
  pending sleep cleanly.
- **`TtlCache` + `makeSwapCacheKey`** — memoises STON.fi simulations
  for the rate-cache TTL (default 5 minutes). `confirmQuote`
  invalidates this cache before its fresh reverse-sim, so signed
  txs always reflect current pool state.
- **`PairsCache`** — TTL-cached `/v1/markets`. Strongly recommended
  to share a single instance across `priceCoins` calls (the SDK
  does this automatically). Snapshot is built symmetrically so the
  same coin lookup works whether STON.fi lists each pair once or
  twice.

### Pricing helpers (no I/O)

- **`calcBetCost(bets, isYes)`** — total + per-entry TON cost
  mirroring `pari-proxy.tolk` exactly.
- **`ticketCost(yesOdds, isYes)`** — single-ticket cost
  (`WIN_AMOUNT_PER_TICKET × (isYes ? yesOdds : 100 − yesOdds) / 100`).
- **`availableForBet(coin, walletReserve)`** — unified capacity
  check: TON deducts walletReserve + gas, jettons return the
  pessimistic `tonEquivalent` (gas billed separately from TON
  wallet).
- **`calcWinnings(bets, referralPct)`** — net payout if the user's
  side wins, deducting `PLATFORM_FEE_PCT` + `referralPct`.
- **`breakdownTotals(quote)`** — splits `totalCost` into stake vs
  per-entry execution fees for UI rendering.
- **`yesOddsToProbabilityPct` / `yesOddsToDecimalOdds`** —
  human-readable odds conversions.

### Address & label utilities

- **`sameAddress(a, b)`** — TON-format-tolerant equality (EQ / UQ /
  raw all compare equal when they refer to the same on-chain
  address).
- **`normalizeAddress(a)`** — canonical bounceable EQ form. Used
  inside `lockedInRate.source` so `confirmQuote` always feeds
  STON.fi the same string regardless of caller formatting.
- **`sourceLabelFromPriced` / `sourceLabelForAddress`** — single
  source of truth for the `BetOption.source` shape.

### Tact-generated payload bindings

- Pari and proxy message schemas (`BatchPlaceBetsForWithRef`,
  `ProxyForward`) are generated from the on-chain Tact contracts.
  Hand-rolled serialisation is forbidden — `payload.ts` always
  routes through the generated `storeBatchPlaceBetsForWithRef`
  helper.

### High-level SDK class

- **`ToncastTxSdk`** — convenience facade that wires up an
  `apiClient` (`StonApiClient`), an optional `tonClient` (`@ston-fi/sdk`'s
  `Client`, required for jetton flows), throttlers (default 5 req/s
  for STON.fi, 1 req/s for TON RPC — tuned for free public tiers),
  retry policy, and shared caches. Exposes `priceCoins`,
  `quoteXxxBet`, `confirmQuote`, `clearRateCache`. Constructor
  options let consumers override every default (`pairsCacheTtlMs`,
  `customPayloadForwardGas`, `maxRetries`, etc.).

### Constants (locked to currently deployed Pari contract)

- `WIN_AMOUNT_PER_TICKET` = 0.1 TON
- `PARI_EXECUTION_FEE` = 0.1 TON per entry
- `CONTRACT_RESERVE` = 0.01 TON on proxy
- `PLATFORM_FEE_PCT` = 4 %
- `MAX_REFERRAL_PCT` = 7 (uint3 on-chain)
- `TON_DIRECT_GAS` = 0.05 TON
- `DEX_CUSTOM_PAYLOAD_FORWARD_GAS` = 0.1 TON
- `DIRECT_HOP_JETTON_GAS_ESTIMATE` = 0.3 TON
- `CROSS_HOP_JETTON_GAS_ESTIMATE` = 0.6 TON
- `DEFAULT_SLIPPAGE` = 0.05 (= 5 %)
- `DEFAULT_WALLET_RESERVE` = 0.05 TON
- `ODDS_MIN/MAX/STEP/COUNT` = 2 / 98 / 2 / 49

If any of these change on-chain, a new major version of this SDK is
required.

### Tooling

- ESM-first, CJS interop via `tsup`. Both type bundles
  (`.d.ts` + `.d.cts`) emitted. Subpath exports for
  `@toncast/tx-sdk/jetton` (jetton builders + route discovery —
  pulls in `@ston-fi/sdk`) and `@toncast/tx-sdk/planner`
  (planner-only).
- TypeScript 5.9.3 strict + `noUncheckedIndexedAccess`.
- Biome 2.2.6 for format + lint.
- Vitest 3.2.4 — 230 tests, 22 files.
  Coverage: 93 % statements, 87 % branches, 96 % functions, 93 % lines.
- Pre-publish gate: `npm run lint && npm run test:coverage && npm run build && attw --profile node16 --pack . && publint`.

### Documentation

- README covers the full flow with code samples, a
  `priceCoins` → `quoteXxxBet` → `confirmQuote` → TonConnect walk-through,
  per-mode parameter tables, configuration reference, troubleshooting,
  and the **REQUIREMENT FOR AI AGENTS** section mirroring `AGENTS.md`.
- Examples (`examples/`): `ton-only-fixed-bet`, `fixed-bet`,
  `limit-bet`, `market-bet`, `priced-coins`, `bet-on-behalf` —
  all typecheck under the project's strict config.
