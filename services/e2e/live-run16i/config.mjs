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
export const RESOLVER_WASM_SHA = "eeacf0d9ae77a5c3f929a2f7f92d73a58016106960f57e8d495dbf74a89dbff8";
export const ESCROW_WASM = ((process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir)"); })()) + "/scratch/e16f/wasm32-unknown-unknown/release/escrow.wasm");
