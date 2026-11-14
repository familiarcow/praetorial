// Server-side config for the Option-1 round trip. No app secret lives
// here or anywhere in this app -- the server never signs.
// D-RPC1 (queue item 7b): the actual default URLs / NEAR_RPC_URL /
// NEAR_RPC_FALLBACKS resolution lives in ONE place
// (services/common/src/rpc.ts); NODE_URL_TESTNET/MAINNET here are just
// this folder's existing names for it, so call sites don't change.
import { resolveRpcUrls } from "../../common/src/rpc.js";

export const FUNDER_ID = "praetorial-dev-1101.testnet";
export const CRED_DIR = `${process.env.HOME}/.near-credentials/testnet`;
export const NODE_URL_TESTNET = resolveRpcUrls("testnet").primary;
export const NODE_URL_MAINNET = process.env.NEAR_RPC_URL_MAINNET?.trim() || resolveRpcUrls("mainnet").primary;
export const INTENTS_MAINNET_CONTRACT = "intents.near";

// Safety caps for this harness's two user-initiated actions.
export const MAX_FUND_YOCTO = 500_000_000_000_000_000_000_000n; // 0.5 NEAR, the task's hard cap
export const FUND_AMOUNT_YOCTO = 300_000_000_000_000_000_000_000n; // 0.3 NEAR, actually sent
export const MAX_TRANSFER_BACK_YOCTO = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
