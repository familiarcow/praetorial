import fs from "node:fs";
import crypto from "node:crypto";
import { account, balance, recordTx, results, save } from "./lib.mjs";
import * as C from "./config.mjs";
let r = results();
const wasm = fs.readFileSync(C.ESCROW_WASM);
r.escrow_wasm_sha256 = crypto.createHash("sha256").update(wasm).digest("hex");
r.resolver_wasm_sha256 = C.RESOLVER_WASM_SHA; r.outcome_pubkey = C.OUTCOME_PUBKEY; r.attest_pubkey = C.ATTEST_PUBKEY;
const esc = await account(C.ESCROW);
const dep = await esc.deployContract(wasm);
recordTx("deploy_escrow", dep.transaction.hash, { wasm_sha256: r.escrow_wasm_sha256, bytes: wasm.length });
const usdcLim = { min_per_side: "1", max_per_side: "250000000", run_price: "5000", min_bond: "5000000", min_objection: "1000000" };
const btcLim = { min_per_side: "6501", max_per_side: "325059", run_price: "1", min_bond: "6501", min_objection: "1300" };
const args = {
  intents: C.INTENTS, usdc_token_id: C.USDC, outlayer: C.OUTLAYER, operator: C.OPERATOR, guardian: C.GUARDIAN,
  registry: C.REGISTRY, fee_account: C.FEE, keeper: C.KEEPER,
  limits: { max_stake: "1000000000000", max_offer_ttl_secs: 31536000, max_stake_per_side_near: "100000000000000000000000000", max_rounds: 2 },
  beta_sunset_ns: null,
  asset_limits: [[C.USDC, usdcLim], [C.BTC, btcLim]],
  outcome_pubkey: C.OUTCOME_PUBKEY, attest_pubkey: C.ATTEST_PUBKEY, resolver_wasm_hash: C.RESOLVER_WASM_SHA,
  outlayer_config: { wasm_base_url: "https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet", secrets_profile: "praetorial-resolver", secrets_account_id: C.ESCROW },
};
const res = await esc.functionCall({ contractId: C.ESCROW, methodName: "new", args, gas: 100_000_000_000_000n });
recordTx("escrow_new", res.transaction.hash);
r.new_args = { ...args };
r = results(); r.balances = r.balances ?? {};
r.balances.escrow_after_deploy = await balance(C.ESCROW);
save(r);
console.log(JSON.stringify(await (await import("./lib.mjs")).account(C.ESCROW).then(a => a.viewFunction({ contractId: C.ESCROW, methodName: "resolver_keys", args: {} }))));
