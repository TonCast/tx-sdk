# Changelog

All notable changes to `@toncast/tx-sdk` will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
