// Types for the NEAR Intents 1Click Swap API, trimmed to the fields
// this job actually sends/reads. Shape verified against the public
// docs: https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote
// (POST /v0/quote) and https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request
// -- see README.md "1Click API" for the full citation and field notes.
//
// This file defines ONLY the interface + request/response shapes. The
// real HTTP implementation (calling https://1click.chaindefuser.com)
// lives behind `live` mode and is never constructed/exercised by the
// test suite -- tests inject a fake OneClickClient (see
// test/treasuryJob.test.ts). No network call happens from this
// package's tests, ever.

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT";
export type DepositType = "ORIGIN_CHAIN" | "INTENTS";
export type RecipientType = "ORIGIN_CHAIN" | "INTENTS" | "DESTINATION_CHAIN";

/** Body of POST /v0/quote. `dry: true` asks for a priced quote without
 * generating a deposit address or committing to a swap -- that is the
 * ONLY mode this job's default (non-live) path ever sends. */
export interface OneClickQuoteRequest {
  dry: boolean;
  swapType: SwapType;
  slippageTolerance: number; // basis points, e.g. 100 = 1%
  originAsset: string; // e.g. "nep141:usdc.near"
  depositType: DepositType;
  destinationAsset: string; // e.g. "nep141:wrap.near"
  amount: string; // decimal string, smallest units of originAsset
  refundTo: string;
  refundType: DepositType;
  recipient: string;
  recipientType: RecipientType;
  deadline: string; // ISO-8601
}

/** The `quote` object within a /v0/quote response. When the request
 * had `dry: true`, `depositAddress` is omitted per the docs (no
 * deposit address is generated and no swap is initiated). */
export interface OneClickQuote {
  amountIn: string; // decimal string, originAsset smallest units
  amountOut: string; // decimal string, destinationAsset smallest units
  depositAddress?: string; // present only when dry !== true
  timeEstimate?: number; // seconds
  deadline?: string;
}

export interface OneClickQuoteResponse {
  quote: OneClickQuote;
}

/** Everything this job needs from 1Click, injected so unit tests never
 * make a network call. The real runner wires this to an HTTP client
 * hitting https://1click.chaindefuser.com (live mode only). */
export interface OneClickClient {
  getQuote(req: OneClickQuoteRequest): Promise<OneClickQuoteResponse>;
}
