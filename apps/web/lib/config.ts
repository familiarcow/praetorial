// apps/web config. All chain/service addresses come from the single network table (lib/network.ts, WEBNET1);
// these exports are thin re-exports so callers keep compiling.
import { NETWORK } from "./network";
export const NEAR_RPC_URL = NETWORK.rpcUrl;
export const PRIVY_APP_ID = "cmw1b5stc01q60glap4q18que";
export const FUNDER_ID = NETWORK.funderId;
export const ESCROW_CONTRACT_ID = NETWORK.escrow;
export const INTENTS_CONTRACT_ID = NETWORK.intents;
export const USDC_TOKEN_ID = NETWORK.usdcTokenId;

// WNEAR_TOKEN_ID sources from the single asset table (lib/assets.ts). Shown to users as "NEAR" (D-ASSET1), backed by wNEAR.
import { assetId } from "./assets";
export const WNEAR_TOKEN_ID = assetId("NEAR") ?? "";

export const MIN_STAKE_USD = 5;

export const ONECLICK_TOKENS_URL = "https://1click.chaindefuser.com/v0/tokens";

// RPC pacing: max 3 req/s per task brief.
export const RPC_MIN_INTERVAL_MS = 350;

// Read-only indexer (Worker). Empty on mainnet = not configured (callers fail closed via requireService).
export const INDEXER_URL = NETWORK.indexerUrl;

// Username registry. Empty URL = registry not configured (UI falls back to the mock / stays off).
export const REGISTRY_URL = NETWORK.registryUrl;
export const REGISTRY_ID = NETWORK.registryId;
