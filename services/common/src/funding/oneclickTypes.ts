// F1 (FUND4 SPEC §7.2): 1Click API v0 shapes used by the funding Worker and the web (from the live OpenAPI,
// spikes/fund3/evidence/oneclick/openapi.yaml). Types only.

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type DepositType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RefundType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RecipientType = "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type DepositMode = "SIMPLE" | "MEMO";

export interface OneClickToken {
  assetId: string; decimals: number; blockchain: string; symbol: string; price?: number | null;
  priceUpdatedAt?: string; contractAddress?: string; coingeckoId?: string;
}

export interface OneClickQuoteRequest {
  dry: boolean; swapType: SwapType; slippageTolerance: number; originAsset: string; depositType: DepositType;
  destinationAsset: string; amount: string; refundTo: string; refundType: RefundType; recipient: string;
  recipientType: RecipientType; deadline: string; depositMode?: DepositMode; referral?: string; quoteWaitingTimeMs?: number;
  appFees?: { recipient: string; fee: number }[];
}

export interface OneClickQuote {
  amountIn: string; amountInFormatted: string; amountInUsd?: string; minAmountIn: string;
  amountOut: string; amountOutFormatted: string; amountOutUsd?: string; minAmountOut: string;
  timeEstimate: number; refundFee?: string; withdrawFee?: string;
  /** non-dry only */
  depositAddress?: string; depositMemo?: string; deadline?: string; timeWhenInactive?: string;
}

export interface OneClickQuoteResponse {
  quote: OneClickQuote; quoteRequest: OneClickQuoteRequest & Record<string, unknown>; signature: string; timestamp: string; correlationId: string;
}

export type OneClickStatus = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";
export const TERMINAL_STATUSES: readonly OneClickStatus[] = ["SUCCESS", "REFUNDED", "FAILED"];

export interface OneClickTxDetails { hash: string; explorerUrl: string }
export interface OneClickSwapDetails {
  intentHashes?: string[]; nearTxHashes?: string[]; amountIn?: string; amountInFormatted?: string; amountInUsd?: string;
  amountOut?: string; amountOutFormatted?: string; amountOutUsd?: string; slippage?: number;
  originChainTxHashes?: OneClickTxDetails[]; destinationChainTxHashes?: OneClickTxDetails[];
  refundedAmount?: string; refundedAmountFormatted?: string; refundedAmountUsd?: string; refundReason?: string; depositedAmount?: string;
}
export interface OneClickStatusResponse {
  correlationId: string; quoteResponse: OneClickQuoteResponse; status: OneClickStatus; updatedAt: string; swapDetails: OneClickSwapDetails;
}

/** /v0/generate-intent response (`swap_transfer`, standard nep413). */
export interface OneClickGenerateIntentResponse {
  intent: { standard: "nep413"; payload: { message: string; nonce: string; recipient: string; callbackUrl?: string | null } };
  correlationId: string;
}
/** /v0/submit-intent request `signedData` (MultiPayloadNep413). */
export interface SignedNep413 {
  standard: "nep413"; payload: { message: string; nonce: string; recipient: string; callbackUrl?: string | null };
  public_key: string; signature: string;
}
export interface OneClickSubmitIntentResponse { intentHash: string; correlationId: string }
