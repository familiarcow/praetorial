# Source before running live-run8 scripts / g4 / privy-web-e2e against the item-8 deployment.
export NEAR_RPC_URL="${NEAR_RPC_URL:?set NEAR_RPC_URL (testnet RPC; see services/common/src/rpc.ts)}"
export ESCROW_CONTRACT_ID=praetorial-e2e-2611052236.praetorial-dev-1101.testnet
export INTENTS_CONTRACT_ID=intents-mock.praetorial-dev-1101.testnet
export USDC_TOKEN_ID=nep141:usdc.testnet
