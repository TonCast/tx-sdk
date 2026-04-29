/**
 * Error hierarchy for `@toncast/tx-sdk`.
 *
 * - {@link ToncastBetError} — programmer / validation error. Not retriable.
 *   The caller passed invalid parameters and must fix them.
 * - {@link ToncastNetworkError} — transient failure from an upstream RPC/API.
 *   Potentially retriable. UI should show a "try again" state.
 *
 * All thrown errors extend {@link ToncastError} so callers can `instanceof`
 * filter at the base level.
 */

function extractMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/** Base class for every error thrown by this SDK. */
export class ToncastError extends Error {
  public readonly code: string;
  public override readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "ToncastError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * All typed codes reported by {@link ToncastBetError}.
 *
 * Validation errors ({@link validateBetParams}) throw one of these; feasibility
 * failures from strategies / planner use the same codes inside
 * `BetOption.reason`.
 */
export type BetErrorCode =
  | "INVALID_REFERRAL_PCT"
  | "REFERRAL_PCT_WITHOUT_ADDRESS"
  | "REFERRAL_ADDRESS_WITHOUT_PCT"
  | "EMPTY_BETS"
  | "TOO_MANY_BETS"
  | "INVALID_ODDS"
  | "INVALID_ODDS_INDEX"
  | "INVALID_TICKETS_COUNT"
  | "INVALID_BUDGET"
  | "INVALID_ADDRESS"
  | "INVALID_ODDS_STATE"
  | "NO_ROUTE"
  | "DUPLICATE_YES_ODDS"
  | "SLIPPAGE_DRIFTED"
  | "SOURCE_NOT_VIABLE"
  | "SOURCE_NOT_IN_PRICED_COINS"
  | "QUOTE_INFEASIBLE";

/**
 * Programmer / validation error — invalid input, conflicting parameters,
 * logical inconsistency. Retrying the same call will fail again.
 */
export class ToncastBetError extends ToncastError {
  public override readonly code: BetErrorCode;

  constructor(code: BetErrorCode, message: string) {
    super(code, message);
    this.name = "ToncastBetError";
    this.code = code;
  }
}

/**
 * Upstream RPC/API failure (network, rate limit, 5xx, timeout). The original
 * error is attached as `cause`. `source` indicates which client surfaced the
 * failure, `method` indicates which method call was attempted.
 */
export class ToncastNetworkError extends ToncastError {
  public readonly source: "stonApi" | "tonClient";
  public readonly method: string;

  constructor(source: "stonApi" | "tonClient", method: string, cause: unknown) {
    super(
      "NETWORK_ERROR",
      `${source}.${method} failed: ${extractMessage(cause)}`,
      cause,
    );
    this.name = "ToncastNetworkError";
    this.source = source;
    this.method = method;
  }
}
