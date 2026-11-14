// DR9 drill 4 setup: throwaway escrow deployed from freeze-candidate-2's wasm (caf134a4, sha-checked against release/freeze-candidate-2.json).
// Init args = frz3's (live-NOKEY1b/new_args.json) except guardian -> a fresh guardian account. intents stays the shared intents-mock
// (a private mock was built but the testnet funder ran out of NEAR, so drill 3 is NOT-DRILLED, see README). The escrow account was created by setup_d34.mjs (first attempt).
import fs from "node:fs"; import crypto from "node:crypto";
import { account, createKeyed, store, view, DEV, KEEPER, DIR, S, sleep, utils } from "./lib.mjs";
const { load, save, rec } = store("run/d34_results.json");
const R0 = load(); const ESC = R0.escrow; const ts = ESC.match(/drill9-(\d+)/)[1];
const names = { guardian: `d9-guardian-${ts}.${DEV}`, m2: `d9-m2-${ts}.${DEV}`, t2: `d9-t2-${ts}.${DEV}`, m3: `d9-m3-${ts}.${DEV}` };
const wasm = fs.readFileSync(`${S}/rbout6/escrow.wasm`), sha = crypto.createHash("sha256").update(wasm).digest("hex");
const REC = JSON.parse(fs.readFileSync(DIR + "../../../../release/freeze-candidate-2.json", "utf8")).escrow.wasm_sha256;
if (sha !== REC) throw new Error(`escrow wasm sha ${sha} != freeze-candidate-2 ${REC}`);
const base = JSON.parse(fs.readFileSync(DIR + "../../live-NOKEY1b/new_args.json", "utf8"));
const keeper = await account(KEEPER); const dev = await account(DEV);
let r = await keeper.sendMoney(DEV, utils.format.parseNearAmount("0.6")); rec("fund_dev_from_keeper_0.6_NEAR", r.transaction.hash);
for (const [k, id] of Object.entries(names)) rec(`create_${k}`, await createKeyed(dev, id, "0.1"));
const esc = await account(ESC);
r = await esc.deployContract(wasm); rec("deploy_escrow", r.transaction.hash, { wasm_sha256: sha });
const args = { ...base, guardian: names.guardian };
r = await esc.functionCall({ contractId: ESC, methodName: "new", args, gas: 100_000_000_000_000n }); rec("escrow_new", r.transaction.hash);
const R = load(); R.accounts = names; R.wasm_sha256 = sha; R.new_args = args; R.args_diff_vs_frz3 = { guardian: `${base.guardian} -> ${names.guardian}` }; delete R.mock; save(R);
await sleep(3000);
console.log(ESC, "is_shutdown", await view(ESC, "is_shutdown"), "paused", await view(ESC, "is_new_offers_paused"), "keys", JSON.stringify((await view(ESC, "resolver_keys")).map((k) => k.slice(0, 8))));
