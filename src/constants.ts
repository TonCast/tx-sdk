/**
 * Hardcoded protocol constants for Toncast Pari / proxy.
 *
 * These match the currently deployed Pari proxy contract (pari-proxy.tolk) and
 * Pari message schema at the time this package was authored. If any of these
 * change on-chain, a new major version of this SDK is required.
 */

/**
 * Toncast swap proxy contract that receives TON + ProxyForward payload
 * after a STON.fi swap and forwards the inner `BatchPlaceBetsForWithRef`
 * body to the target Pari market with the correct TON value.
 *
 * Schema of the expected `ProxyForward` cell is defined in
 * `toncast_swap_proxy.tolk`:
 *
 * ```tolk
 * struct (0x50415249) ProxyForward {
 *   pariAddress: address
 *   pariCell:    cell    // ref → BatchPlaceBetsForWithRef
 * }
 * ```
 */
export const TONCAST_PROXY_ADDRESS =
  "EQCiRGAqGbzlWVq8Ryu-uTW88MMi_u5CfhRmrR0hHtf41lvl";

/** Canonical TON placeholder address used by STON.fi API for native TON. */
export const TON_ADDRESS = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

/** "PARI" opcode — proxy matches on this to forward the inner ref to Pari. */
export const PROXY_FORWARD_BET_OP = 0x50415249;

/** Pari message opcode — BatchPlaceBetsForWithRef. Numeric 2864434416. */
export const BATCH_PLACE_BETS_FOR_WITH_REF_OP = 0xaabbccf0;

// ─── Cost formula (must mirror pari-proxy.tolk) ─────────────────────────────

/** Payout per winning ticket (0.1 TON). */
export const WIN_AMOUNT_PER_TICKET = 100_000_000n;

/** Flat execution fee charged per entry in the bets map (0.1 TON). */
export const PARI_EXECUTION_FEE = 100_000_000n;

/** TON kept on the proxy contract for storage (0.01 TON). */
export const CONTRACT_RESERVE = 10_000_000n;

// ─── Gas defaults ───────────────────────────────────────────────────────────

/**
 * Extra TON to attach on top of `totalCost` when building a TON-direct
 * `value`. Defaults to **`0`** — `PARI_EXECUTION_FEE` (`0.1 TON × N entries`)
 * is already inside `totalCost` and covers Pari's forward fees, storage,
 * and compute gas with room to spare. Adding more on top is wasteful
 * (the surplus comes back as a refund tx, but it spends an extra hop
 * and shows the user a higher "Sent" number than the bet they placed).
 *
 * Override per-call via `BuildTonBetTxParams.tonDirectGas` only if you
 * have a verified mainnet reason to (e.g. an upcoming Pari upgrade
 * that raises forward-fee economics).
 */
export const TON_DIRECT_GAS = 0n;

/**
 * Fixed TON amount delivered alongside the payload on the jetton-swap route.
 *
 * Maps to `dexCustomPayloadForwardGasAmount` in STON.fi `getSwapJettonTo*`
 * transaction params. Covers forward fee from DEX to proxy + CONTRACT_RESERVE
 * + a small buffer against pool movement between simulation and execution.
 *
 * Default 0.1 TON. Can be overridden via
 * `ToncastTxSdkOptions.customPayloadForwardGas` for future-proofing if
 * forward-fee economics change upstream.
 */
export const DEX_CUSTOM_PAYLOAD_FORWARD_GAS = 100_000_000n; // 0.1 TON

/**
 * Upper bound on TON temporarily locked in a **direct** jetton→TON swap
 * message (gasAmount param to `getSwapJettonToTonTxParams`). Most of this
 * is refunded — excess of actual execution gas returns to the user — but
 * the wallet must have this much free at signing time.
 *
 * Matches the STON.fi SDK's fallback `gasBudget` default for v2+ pools.
 */
export const DIRECT_HOP_JETTON_GAS_ESTIMATE = 300_000_000n; // 0.3 TON

/**
 * Upper bound on TON locked in a **2-hop** jetton→intermediate→TON swap.
 * Sum of two single-hop budgets — one per router leg. Used by the planner
 * to size the TON gas reserve when a jetton has no direct pool with TON
 * and must route through an intermediate (typically USDT or jUSDT).
 */
export const CROSS_HOP_JETTON_GAS_ESTIMATE = 600_000_000n; // 0.6 TON

// ─── Referral ───────────────────────────────────────────────────────────────

/** `referralPct` field in `BatchPlaceBetsForWithRef` is a uint3 (0..7). */
export const MAX_REFERRAL_PCT = 7;

/**
 * Platform fee percentage deducted from each winning ticket's payout.
 *
 * On-chain: when a bet wins, Pari pays out `WIN_AMOUNT_PER_TICKET`
 * (0.1 TON) per ticket and subtracts `PLATFORM_FEE_PCT + referralPct`
 * percent. Referral keeps `referralPct`%, platform keeps the rest.
 *
 * Hardcoded to mirror the currently deployed Pari contract. **If Toncast
 * changes the platform cut on-chain, `calcWinnings` in this SDK will
 * silently report wrong payouts until this constant is updated** — bumping
 * it is a breaking change for consumers (UI "Выигрыш" values shift), so
 * it ships as a new **major version** of the SDK, the same policy we use
 * for `TONCAST_PROXY_ADDRESS` / opcode changes.
 */
export const PLATFORM_FEE_PCT = 4;

// ─── DEX ────────────────────────────────────────────────────────────────────

/** STON.fi DEX major versions supported. Only v2+ has pTON + custom-payload forwarding. */
export const DEX_VERSION: [2] = [2];

/** Default max price-impact (5%) for STON.fi swap simulations. */
export const DEFAULT_SLIPPAGE = "0.05";

// ─── Odds schema ────────────────────────────────────────────────────────────

/** Step between consecutive odds values. Only even yesOdds are allowed. */
export const ODDS_STEP = 2;

/** Smallest allowed yesOdds. */
export const ODDS_MIN = 2;

/** Largest allowed yesOdds. */
export const ODDS_MAX = 98;

/** Length of `OddsState.Yes` / `OddsState.No` arrays. */
export const ODDS_COUNT = 49;

/**
 * Fallback yesOdds for Market mode when nothing matched in `oddsState`.
 * Neutral 50% probability (coefficient ~2.0).
 */
export const ODDS_DEFAULT_PLACEMENT = 50;

// ─── Wallet safety ──────────────────────────────────────────────────────────

/** Default amount of TON to keep in the wallet after all transactions. */
export const DEFAULT_WALLET_RESERVE = 50_000_000n; // 0.05 TON

// ─── Throttle / retry ───────────────────────────────────────────────────────

/** Default throttle between TON-client calls (1 req/sec — toncenter free tier). */
export const DEFAULT_TON_CLIENT_MIN_INTERVAL_MS = 1000;

/** Default throttle between STON.fi API calls (5 req/sec — conservative public tier). */
export const DEFAULT_STON_API_MIN_INTERVAL_MS = 200;

/** Default number of retries for transient network failures. */
export const DEFAULT_MAX_RETRIES = 1;

/** Default base delay (ms) between retries; actual delay is `DEFAULT_RETRY_DELAY_MS * (attempt + 1)`. */
export const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * Default TTL (ms) for the `simulateSwap` / `simulateReverseSwap` cache.
 * 5 minutes — rate moves within a few percent over that window on the
 * vast majority of pairs, and `confirmQuote` re-simulates fresh just
 * before the user signs (the actual on-chain protection against drift).
 * So a long-lived quote-time cache trades negligible rate staleness for
 * ~1/60 fewer STON.fi API calls during slider-driven UI interactions.
 */
export const DEFAULT_RATE_CACHE_TTL_MS = 300_000;

/**
 * TTL (ms) for the STON.fi `/v1/markets` pairs-list cache. Pairs rarely
 * change (only when a new pool is created), so 5 minutes is a safe
 * default. `priceCoins` with N jettons issues ≤ 1 pairs fetch per TTL
 * window instead of N.
 */
export const PAIRS_CACHE_TTL_MS = 300_000;
