// 16a step 3: recreate the SAME escrow account name, deploy main's escrow wasm, new() with OutlayerConfig, top up keeper_credit, verify views.
// usage: NEAR_RPC_URL=... node 16a_2_recreate_deploy.mjs [fund_near=6]
import fs from "node:fs";
import crypto from "node:crypto";
import { account, balance, mk, KeyPair, utils, CRED } from "./lib.mjs";
import * as C from "./config.mjs";
const { load, save, recordTx } = mk("./results.json");
// stripped (no name section) build of main escrow: CARGO_PROFILE_RELEASE_STRIP=symbols cargo build --release --target wasm32-unknown-unknown (plain build is 893 KB -> storage > funds)
const WASM = C.ESCROW_WASM;
const fund = process.argv[2] ?? "6";
const DEV = C.OPERATOR, ESC = C.ESCROW;
const OUTCOME_PUBKEY = process.argv[3]; if (!OUTCOME_PUBKEY) throw new Error("outcome pubkey arg required");
const ATTEST1_PUBKEY = process.argv[4]; if (!ATTEST1_PUBKEY) throw new Error("attest pubkey arg required"); const _x = ""; // attest1 signer, item 11b / D-ATTEST2
const wasm = fs.readFileSync(WASM);
const sha = crypto.createHash("sha256").update(wasm).digest("hex");
let r = load(); r.recreated = { wasm_sha256: sha, wasm_bytes: wasm.length, outcome_pubkey: OUTCOME_PUBKEY, attest_pubkey: ATTEST1_PUBKEY, resolver_wasm_hash: C.RESOLVER_WASM_SHA }; r.balances = r.balances ?? {};
save(r);
// account creation already done (tx recorded in results.json by the first attempt; deploy then failed LackBalanceForState on the 893 KB unstripped wasm)
const esc = await account(ESC);
const dep = process.env.SKIP_DEPLOY ? null : await esc.deployContract(wasm);
if (dep) recordTx("deploy_escrow", dep.transaction.hash, { wasm_sha256: sha, status: "Success" });
const usdcLim = { min_per_side: "1", max_per_side: "250000000", run_price: "5000", min_bond: "5000000", min_objection: "1000000" };
const btcLim = { min_per_side: "6501", max_per_side: "325059", run_price: "1", min_bond: "6501", min_objection: "1300" };
const args = {
  intents: C.INTENTS, usdc_token_id: C.USDC, outlayer: C.OUTLAYER, operator: C.OPERATOR, guardian: C.GUARDIAN,
  registry: C.REGISTRY, fee_account: C.FEE, keeper: C.KEEPER,
  limits: { max_stake: "1000000000000", max_offer_ttl_secs: 31536000, max_stake_per_side_near: "100000000000000000000000000", max_rounds: 2 },
  beta_sunset_ns: null,
  asset_limits: [[C.USDC, usdcLim], [C.BTC, btcLim]],
  outcome_pubkey: OUTCOME_PUBKEY, attest_pubkey: ATTEST1_PUBKEY, resolver_wasm_hash: C.RESOLVER_WASM_SHA,
  outlayer_config: { wasm_base_url: "https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet", secrets_profile: "praetorial-resolver", secrets_account_id: DEV },
};
const init = await esc.functionCall({ contractId: ESC, methodName: "new", args, gas: 100_000_000_000_000n });
recordTx("escrow_new", init.transaction.hash, { status: "Success" });
r = load(); r.recreated.new_args = args; save(r);
const keeper = await account(C.KEEPER);
const top = await keeper.functionCall({ contractId: ESC, methodName: "topup_keeper_credit", args: {}, gas: 30_000_000_000_000n, attachedDeposit: utils.format.parseNearAmount("0.15") });
recordTx("topup_keeper_credit", top.transaction.hash, { near: "0.15", status: "Success" });
await new Promise((x) => setTimeout(x, 3000));
const view = (m, a = {}) => esc.viewFunction({ contractId: ESC, methodName: m, args: a });
r = load(); r.recreated.views = { outlayer_config: await view("outlayer_config"), resolver_keys: await view("resolver_keys"), keeper_credit_balance: await view("keeper_credit_balance") };
r.balances = { ...r.balances, dev_after_create: await balance(DEV), escrow_after_deploy: await balance(ESC) }; save(r);
console.log(JSON.stringify(r.recreated.views), JSON.stringify(r.balances));
