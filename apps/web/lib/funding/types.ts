// F2 (FUND4 SPEC §7.3, amended by familiarcow UX-37 / D-FUND4a): the types every funding task codes against (F3 Account screen,
// F4 Add money sheet + tracker, F5 Cash out / Convert) and the request/response shapes of the F1 funding Worker.
//
// familiarcow's changes vs spikes/fund4/SPEC.md, applied here:
//   - ALWAYS a one-time 1Click deposit address. No permanent bridge-address ("direct") rail: no `Rail`, no "fund-direct" kind.
//   - The landing token is ALWAYS one of the 6 bet tokens (BetSymbol), credited to the user's intents balance.
//   - Refunds go to the user's intents account. Partner/app fee 0. Convert only into the 6.
//   - Cash out / Convert are user-signed through 1Click generate/submit-intent (no relayer).
// No React in this folder's non-hook modules; amounts are base-unit decimal strings (or bigint inside BalanceMap), never floats.

/** The 6 launch bet tokens (D-ASSET1, release/mainnet-night/args.mainnet.json), in display order. */
export const BET_SYMBOLS = ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"] as const;
export type BetSymbol = (typeof BET_SYMBOLS)[number];

/** The minimum a token needs to be named anywhere: the 1Click / intents asset id plus how to show it. */
export interface TokenRef {
  /** 1Click / intents.near token id, e.g. "nep141:usdt.tether-token.near". */
  assetId: string;
  /** 1Click's symbol as listed ("USDT", "wNEAR"). */
  symbol: string;
  /** 1Click `blockchain` code ("tron", "eth", "near", ...). */
  blockchain: string;
  decimals: number;
}

/** One row of the "What do you have?" picker (built from 1Click /v0/tokens by lib/funding/tokens.ts). */
export interface TokenOption extends TokenRef {
  /** Human network name ("Tron", "Ethereum", "BNB Chain"). */
  networkName: string;
  /** The name exchanges use for the network ("Tron (TRC-20)"), or null when there is no common one. */
  exchangeNetworkName: string | null;
  /** 1Click's USD price, or null when 1Click has none (then every ≈$ figure that needs it is hidden). */
  priceUsd: number | null;
  /** Rank in the "Popular" list (1 = first), null = not popular. */
  popularRank: number | null;
  /** Logo URLs/paths; "" = none (the UI shows a letter badge). */
  logo: string;
  chainLogo: string;
  /** Deposits to this chain may need a memo/tag (XRP, Stellar, TON, ...). */
  memoChain: boolean;
  /** Which bet token this IS (same token by symbol, any network), or null. Drives the landing-token default. */
  betSymbol: BetSymbol | null;
}

/** 1Click /v0/status `status`. */
export type OneClickStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";

/** What the Worker returns for a fund / withdraw / convert quote (dry quotes: depositAddress, depositMemo, deadline are null). */
export interface QuoteView {
  depositAddress: string | null;
  depositMemo: string | null;
  /** Origin-asset base units. */
  amountIn: string;
  minAmountIn: string;
  /** Destination-asset base units. */
  amountOut: string;
  minAmountOut: string;
  amountInUsd: string | null;
  amountOutUsd: string | null;
  /** Seconds after the deposit is confirmed. */
  timeEstimateSec: number;
  /** ISO date-time; after it 1Click refunds (to the user's intents account). */
  deadline: string | null;
  /** Destination-asset base units, already inside amountOut. */
  withdrawFee: string;
  /** Origin-asset base units charged on a refund (0 for INTENTS refunds). */
  refundFee: string;
  correlationId: string;
}

/** The F1 Worker's view of 1Click /v0/status (swapDetails passed through, every field optional). */
export interface TxLink { hash: string; explorerUrl: string | null }
export interface StatusView {
  status: OneClickStatus;
  updatedAt: string | null;
  correlationId: string | null;
  /** Origin units actually received at the deposit address (INCOMPLETE_DEPOSIT / REFUNDED). */
  depositedAmount: string | null;
  /** Destination units actually delivered (SUCCESS). */
  amountOut: string | null;
  /** Origin units returned (REFUNDED). */
  refundedAmount: string | null;
  refundReason: string | null;
  originTxs: TxLink[];
  destinationTxs: TxLink[];
}

export type SwapKind = "fund" | "withdraw" | "convert";

export type TrackState = "waiting" | "confirming" | "converting" | "short" | "credited" | "refunded" | "failed" | "expired" | "checking";
export const TERMINAL_STATES: readonly TrackState[] = ["credited", "refunded", "failed", "expired"];

/** One in-flight (or recently finished) 1Click swap. Persisted locally (lib/funding/store.ts) and by the Worker (/fund/list). */
export interface SwapRecord {
  /** depositAddress, or `${depositAddress}#${depositMemo}` when there is a memo. */
  id: string;
  account: string;
  kind: SwapKind;
  origin: TokenRef;
  destination: TokenRef;
  amountIn: string;
  minAmountIn: string;
  amountOut: string;
  minAmountOut: string;
  depositAddress: string;
  depositMemo: string | null;
  /** Cash out: the user's address on the destination chain. Fund / convert: null (it is always the user's own intents account). */
  recipient: string | null;
  deadline: string | null;
  /** ms since epoch. */
  createdAt: number;
  updatedAt: number;
  state: TrackState;
  /** The last 1Click status we saw (null = never checked). */
  lastStatus: OneClickStatus | null;
  /** Origin units seen at the deposit address. */
  received: string | null;
  /** Destination units delivered on SUCCESS. */
  delivered: string | null;
  /** Origin units refunded on REFUNDED, and 1Click's reason. */
  refunded: string | null;
  refundReason: string | null;
  correlationId: string | null;
  /** Cash out / convert only: the user signed and we submitted the intent. Fund: null. */
  signed: boolean | null;
  /** Local only (never sent to or taken from the server): where "Back to your bet" returns to. */
  needReturn: string | null;
  /** SECREV1 SR-1, local only (never taken from the server): true only on the record this browser wrote before signing (cashOutRecord).
   * Anyone can ask the Worker for a cash-out quote for any account, so a cash out / convert is only ever signed when this is true. */
  createdHere?: boolean;
  /** Consecutive failed status checks (drives "checking"; never "failed"). */
  checkFailures: number;
}

/** Non-bet tokens in the user's intents account (balance map B2). token = null: not in 1Click's list ("Unknown token"). */
export interface StrayHolding { assetId: string; units: bigint; token: TokenRef | null; priceUsd: number | null; dust: boolean }
/** Pending payouts (B6) for the user, per bet. */
export interface PayoutHolding { betId: number; symbol: BetSymbol | string; units: bigint }

/** Every place the user's money can sit (SPEC §1). "error" = that section could not be read: show "can't read", never 0. */
export interface BalanceMap {
  /** B1: the 6 bet tokens in the intents account, by symbol (every enabled symbol present, 0 included). */
  betting: Partial<Record<BetSymbol, bigint>> | "error";
  /** B2: non-bet tokens in the intents account, non-zero only. */
  stray: StrayHolding[] | "error";
  /** B3: bet tokens on the plain NEAR account (moveToBetting reads it). */
  nearAccount: Partial<Record<BetSymbol, bigint>> | "error";
  /** B4+B5: locked in open offers and active bets. */
  inBets: Partial<Record<BetSymbol, { units: bigint; bets: number }>> | "error";
  /** B6. */
  payouts: PayoutHolding[] | "error";
  /** B7/B9/B10: in-flight and recently finished swaps (local + server). */
  inFlight: SwapRecord[];
}

// ---- F1 funding Worker API (SPEC §7.1). Recipient / refund fields are always built by the Worker, never sent by the client. ----

export interface FundQuoteRequest {
  /** The signed-in user's account id (64-hex implicit on mainnet). Credited and refunded inside intents.near. */
  account: string;
  /** Any 1Click asset id. */
  originAsset: string;
  /** The intents asset id of the bet token to land as (must be one of the 6). */
  betWith: string;
  /** Origin base units to send (FLEX_INPUT)... */
  amountIn?: string;
  /** ...or destination base units needed (the Worker sizes amountIn from a dry EXACT_OUTPUT quote + 1%). */
  needOut?: string;
  dry: boolean;
}

export interface WithdrawQuoteRequest {
  account: string;
  kind: "withdraw" | "convert";
  /** Any token id the account holds in intents. */
  originAsset: string;
  amountIn: string;
  /** withdraw: any 1Click asset id; convert: one of the 6. */
  destinationAsset: string;
  /** withdraw only: the user's address on the destination chain. */
  recipient?: string;
  dry: boolean;
}

/** /withdraw/intent response: the generated NEP-413 payload and its hash (the browser re-checks and recomputes both). */
export interface IntentToSign { intent: unknown; hash: string }
export interface SubmitIntentRequest { depositAddress: string; signedData: unknown }

export interface FundingHealth { ok: boolean; network: string; keyConfigured: boolean }

/** Typed Worker errors (SPEC §7.1 "Errors" plus the transport cases). */
export type FundingErrorCode =
  | "too_low" | "no_route" | "bad_recipient" | "bad_refund" | "deadline" | "upstream_down" | "rate_limited"
  | "not_found" | "bad_request" | "not_configured" | "network";
export interface FundingErrorInfo { code: FundingErrorCode; /** too_low: the minimum in origin base units. */ minUnits?: string; retryAfterSec?: number; message: string }
