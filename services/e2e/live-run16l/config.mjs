export const ESCROW = "praetorial-e2e-2611052236.praetorial-dev-1101.testnet";
export const INTENTS = "intents-mock.praetorial-dev-1101.testnet";
export const OPERATOR = "praetorial-dev-1101.testnet";
export const GUARDIAN = "arbiter1.praetorial-dev-1101.testnet";
export const REGISTRY = "praetorial-dev-1101.testnet";
export const FEE = "fee.praetorial-dev-1101.testnet";
export const KEEPER = "keeper.praetorial-dev-1101.testnet";
export const MAKER = "maker1.praetorial-dev-1101.testnet";
export const TAKER = "taker1.praetorial-dev-1101.testnet";
export const USDC = "nep141:usdc.testnet";       // mock NEP-141 id on mock-intents (services/README)
export const BTC = "nep141:btc.mock.testnet";    // mock BTC (escrow tests.rs MOCK_BTC), 8dp
export const OUTLAYER = "outlayer.testnet";
export const RESOLVER_WASM_SHA = "56a61269cb2700918d7bffc0699e3698816b9ecddd3de3da116f995545d18d71";
export const ESCROW_WASM = ((process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir)"); })()) + "/scratch/e16f/wasm32-unknown-unknown/release/escrow.wasm");
