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
export const RESOLVER_WASM_SHA = "cd853f8feb74f83041e936c3125ba85394b7547db46dbb7772b3bb20a6be19d7";
export const OUTCOME_PUBKEY = "1457b75bd267a422ee601f8c246577a9d2151146ddfef58b35c2dce6960ae0d7";
export const ATTEST_PUBKEY = "861e05fed851ed724f917ab74b59cc739358f0f104534cb0ffa8b2269d428e05";
export const ESCROW_WASM = ((process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir)"); })()) + "/scratch/e8target/wasm32-unknown-unknown/release/escrow.wasm");
