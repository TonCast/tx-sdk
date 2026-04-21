import type { Address, Cell } from "@ton/ton";
import type { DiscoveredRoute } from "./routing/discover.js";

/**
 * One entry in `BatchPlaceBetsForWithRef.bets`.
 *
 * Public-facing representation uses plain `number`s. Conversion to the
 * bigint shape expected by Tact-generated bindings happens in `payload.ts`.
 */
export type BetItem = {
  /** `yesOdds` value as stored on-chain (uint7, range 2..98, step 2). */
  yesOdds: number;
  /** Number of tickets at this `yesOdds`. uint32, must be > 0. */
  ticketsCount: number;
};

/**
 * Snapshot of available counter-side liquidity on the Pari contract.
 *
 * Indexing: each array has length 49 and maps index `i` to `yesOdds = 2 * (i + 1)`
 * (only even yesOdds from 2 to 98 are valid).
 *
 * - `Yes[i]` = number of YES tickets available at the corresponding yesOdds
 *   (matched when the user places a NO bet).
 * - `No[i]` = number of NO tickets available (matched when the user places a
 *   YES bet).
 */
export type OddsState = {
  Yes: number[];
  No: number[];
};

/**
 * TonConnect-compatible transaction parameters.
 *
 * Matches the shape returned by `@ston-fi/sdk` router helpers.
 */
export type TxParams = {
  to: Address;
  value: bigint;
  body?: Cell | null;
};

/** A single coin the user has available to spend on the bet. */
export type AvailableCoin = {
  /** Jetton master address, or {@link TON_ADDRESS} for native TON. */
  address: string;
  /** Raw amount in the coin's smallest units. */
  amount: bigint;
  /**
   * Optional human-readable ticker ("USDT", "NOT", …). Propagated verbatim
   * into `BetOption.source.symbol` and `PricedCoin.symbol` for UI labels.
   */
  symbol?: string;
  /**
   * Optional number of decimals used to render `amount` / `spend` for the
   * UI. TON is always 9, so this field is only meaningful for jettons.
   */
  decimals?: number;
};

/**
 * Output of {@link ToncastTxSdk.priceCoins}.
 *
 * One entry per input coin with its TON valuation and viability flag.
 * `viable === false` means the swap cost (gas) alone exceeds what the coin
 * can deliver in TON — it should be greyed out in the UI and must not be
 * used as `CommonBetParams.source`.
 */
export type PricedCoin = {
  /** Jetton master address, or TON_ADDRESS. */
  address: string;
  /** Echoed from {@link AvailableCoin.symbol}. */
  symbol?: string;
  /** Echoed from {@link AvailableCoin.decimals}. */
  decimals?: number;
  /** Balance, echoed from input. */
  amount: bigint;
  /**
   * Gross TON produced by swapping the full `amount` — `minAskUnits` from
   * the STON.fi simulation. For TON itself: equals `amount`.
   */
  tonEquivalent: bigint;
  /**
   * TON this coin's swap will lock in the user's wallet as gas. For TON:
   * {@link TON_DIRECT_GAS} (0.05 TON). For direct jetton swap:
   * {@link DIRECT_HOP_JETTON_GAS_ESTIMATE} (0.3 TON). For 2-hop:
   * {@link CROSS_HOP_JETTON_GAS_ESTIMATE} (0.6 TON). For `route === null`:
   * `0n` (coin is unusable anyway).
   */
  gasReserve: bigint;
  /**
   * `tonEquivalent − gasReserve` when `viable`, else `0n`. The honest
   * number to show in the UI as "this coin brings X TON to the bet".
   */
  netTon: bigint;
  /** Discovered route to TON. `null` for TON itself or when discovery failed. */
  route: "direct" | { intermediate: string } | null;
  /**
   * `true` iff swapping this coin delivers strictly more TON than it costs
   * in gas (plus, for TON, the wallet reserve). Only viable coins may be
   * used as a funding source.
   */
  viable: boolean;
  /** Human-readable explanation when `!viable`. */
  reason?: string;
};

/**
 * Data captured at quote time, used by {@link ToncastTxSdk.confirmQuote} to
 * detect price drift before the user signs.
 *
 * `null` for TON-funded quotes (no swap — no drift risk).
 */
export type LockedInRate = {
  /** Source jetton address at quote time. */
  source: string;
  /** Route used to produce the locked-in tx. */
  route: DiscoveredRoute;
  /** Offer amount locked into the signed tx (jetton smallest units). */
  offerUnits: bigint;
  /** Combined priceImpact (sum across legs) at quote time, e.g. 0.012. */
  priceImpact: number;
  /** Slippage tolerance used at quote time, e.g. "0.05". */
  slippage: string;
  /** Target TON amount the swap was sized for (equals `BetQuote.totalCost`). */
  targetTonUnits: bigint;
};

/** Common parameters for all three quote methods. */
export type CommonBetParams = {
  /** Address of the target Pari market contract. */
  pariAddress: string;
  /**
   * Address that will **own** the placed tickets on-chain (stored inside
   * Pari as the bet owner).
   */
  beneficiary: string;
  /**
   * Address that will **sign** the transaction (i.e. the wallet connected
   * via TonConnect). Used to compute the user's jetton wallet for swaps.
   *
   * Defaults to `beneficiary` when omitted.
   */
  senderAddress?: string;
  /** `true` → YES side, `false` → NO side. */
  isYes: boolean;
  /**
   * Optional referral address. Must be `null` if `referralPct === 0`, non-null
   * and distinct from `beneficiary` if `referralPct > 0`.
   */
  referral: string | null;
  /** Referral share, 0..7 (percent). `0` disables referral payout. */
  referralPct: number;
  /**
   * Address of the coin the user wants to fund the bet with (TON_ADDRESS
   * or a jetton master). MUST appear in `pricedCoins` and be `viable`.
   */
  source: string;
  /**
   * Priced coin list — the same shape returned by {@link ToncastTxSdk.priceCoins}.
   * Must include the chosen `source`; other entries are ignored.
   *
   * Typical UX: call `priceCoins()` once when the bet screen opens, show
   * the list, let the user pick one, then pass the list back in.
   */
  pricedCoins: PricedCoin[];
  /**
   * Maximum acceptable STON.fi swap price-impact (decimal string, e.g.
   * `"0.05"` for 5%). Defaults to {@link DEFAULT_SLIPPAGE}.
   *
   * Any value in `[0, 1)` is accepted. Internally the SDK resolves
   * slippage to ~1e-9 precision (enough for bps/sub-bps tuning);
   * anything finer is effectively clamped to 0 and behaves like a
   * zero-slippage request.
   */
  slippage?: string;
  /**
   * TON to keep in the wallet after the transaction completes. Defaults
   * to {@link DEFAULT_WALLET_RESERVE}.
   */
  walletReserve?: bigint;
};

/** Parameters for {@link ToncastTxSdk.quoteFixedBet}. */
export type FixedBetParams = CommonBetParams & {
  /** Target yesOdds (uint7, even, 2..98). */
  yesOdds: number;
  /** Number of tickets to place. */
  ticketsCount: number;
};

/** Parameters for {@link ToncastTxSdk.quoteLimitBet}. */
export type LimitBetParams = CommonBetParams & {
  /** Current liquidity snapshot. */
  oddsState: OddsState;
  /** Worst acceptable yesOdds. */
  worstYesOdds: number;
  /** Total number of tickets we want (matched + placement at worstYesOdds). */
  ticketsCount: number;
};

/** Parameters for {@link ToncastTxSdk.quoteMarketBet}. */
export type MarketBetParams = CommonBetParams & {
  /** Current liquidity snapshot. */
  oddsState: OddsState;
  /** Budget to spend, expressed in nano-TON equivalent. */
  maxBudgetTon: bigint;
};

/** Per-entry breakdown returned by {@link calcBetCost}. */
export type CostBreakdownEntry = BetItem & {
  /** TON cost for this single entry (includes PARI_EXECUTION_FEE). */
  cost: bigint;
};

/** Result of {@link calcBetCost}. */
export type CostBreakdown = {
  /** Sum of `PARI_EXECUTION_FEE + ticketCost * ticketsCount` over all entries. */
  totalCost: bigint;
  /** Per-entry costs, preserving input order. */
  perEntry: CostBreakdownEntry[];
};

/**
 * Reason codes reported inside infeasible {@link BetOption}s.
 *
 * - `insufficient_balance` — the chosen source cannot produce enough TON.
 * - `insufficient_ton_for_gas` — wallet TON is below the gas reservation
 *   required for this source.
 * - `slippage_exceeds_limit` — reverse-swap quote exceeds `slippage`.
 * - `no_route` — jetton has no path to TON on STON.fi (shouldn't happen
 *   for a viable `PricedCoin`, surfaces only if coin list is stale).
 * - `network_error` — upstream STON.fi / TonClient failure during build.
 * - `ton_client_required` — jetton source chosen but SDK was instantiated
 *   without a `tonClient`.
 * - `source_not_viable` — the chosen source is not `viable` in `pricedCoins`.
 * - `source_not_in_priced_coins` — `source` address missing from `pricedCoins`.
 * - `budget_too_small_for_single_entry` — Market mode, budget below
 *   `PARI_EXECUTION_FEE` so no entry can be opened.
 */
export type BetOptionFailureReason =
  | "insufficient_balance"
  | "insufficient_ton_for_gas"
  | "slippage_exceeds_limit"
  | "no_route"
  | "network_error"
  | "ton_client_required"
  | "source_not_viable"
  | "source_not_in_priced_coins"
  | "budget_too_small_for_single_entry";

/**
 * Source label used in {@link BetOption}.
 *
 * - `"TON"` — native TON (always 9 decimals).
 * - `{ address, symbol?, decimals? }` — a jetton.
 */
export type BetOptionSource =
  | "TON"
  | { address: string; symbol?: string; decimals?: number };

/** Shape describing how the strategy distributed tickets per yesOdds. */
export type StrategyBreakdown = {
  /** Tickets matched against existing counter-side liquidity. */
  matched: Array<{ yesOdds: number; tickets: number; cost: bigint }>;
  /** Remainder placed as new bets at `worstYesOdds` (Limit only). */
  unmatched?: { yesOdds: number; tickets: number; cost: bigint };
  /** Remainder placed as new bets at `lastYesOdds` (Market only). */
  placement?: { yesOdds: number; tickets: number; cost: bigint };
};

/**
 * Funding plan for a single chosen source.
 *
 * Exactly one transaction is emitted per bet — the user selects the source
 * up-front via `CommonBetParams.source`. Composite / multi-source funding
 * is out of scope: it multiplied UX risk (partial fills on separate
 * signatures) for marginal reach.
 */
export type BetOption =
  | {
      feasible: true;
      source: BetOptionSource;
      txs: TxParams[];
      /**
       * Spend = amount of `source` the user will send in raw smallest
       * units. Gas = TON gas reservation (TON for direct, 0.3 / 0.6 TON
       * for jetton swaps).
       */
      breakdown: { spend: bigint; gas: bigint };
      /** Effective slippage tolerance (echo of request or default). */
      slippage?: string;
      /** Route used — omitted for TON-funded bets. */
      route?: "direct" | { intermediate: string };
      warnings?: string[];
    }
  | {
      feasible: false;
      source: BetOptionSource;
      reason: BetOptionFailureReason;
      /** Present when `reason === "insufficient_balance" | "insufficient_ton_for_gas"`. */
      shortfall?: bigint;
      warnings?: string[];
    };

/** Result of every `quoteXxxBet`. */
export type BetQuote = {
  mode: "fixed" | "limit" | "market";
  /** Final bets array sent in `BatchPlaceBetsForWithRef.bets` (after merge). */
  bets: BetItem[];
  /** Side of the bet — echoed from the quote params. */
  isYes: boolean;
  /** Sum of per-entry costs (proxy / Pari fee inclusive). */
  totalCost: bigint;
  /** Millisecond timestamp when the quote was built. */
  quotedAt: number;
  /** Funding plan for the user-chosen source. */
  option: BetOption;
  /**
   * Rate snapshot locked into the tx at quote time. `null` for TON-funded
   * quotes. Used by {@link ToncastTxSdk.confirmQuote} to detect drift.
   */
  lockedInRate: LockedInRate | null;
  /** Strategy-specific accounting detail. */
  breakdown: StrategyBreakdown;
};
