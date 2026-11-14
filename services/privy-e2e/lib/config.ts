export const ESCROW = process.env.ESCROW_CONTRACT_ID ?? "praetorial-e2e-2611052236.praetorial-dev-1101.testnet";
export const INTENTS = process.env.INTENTS_CONTRACT_ID ?? "intents-mock.praetorial-dev-1101.testnet";
export const USDC = process.env.USDC_TOKEN_ID ?? "nep141:usdc.testnet";
export const FUNDER_ID = "praetorial-dev-1101.testnet";
export const TAKER_ID = "taker1.praetorial-dev-1101.testnet";
export const KEEPER_ID = "keeper.praetorial-dev-1101.testnet";
export const CRED_DIR = `${process.env.HOME}/.near-credentials/testnet`;

// Safety-policy constants (task step 7).
export const MAX_TRANSFER_AMOUNT_USDC_6DP = 5_000_000n; // 5 USDC @ 6dp -- generous for this bet, still a real cap
