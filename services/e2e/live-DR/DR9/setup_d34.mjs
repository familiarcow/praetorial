// DR9 drills 3+4 setup: throwaway ISOLATED stack on testnet = own mock-intents (so set_fail_mt_transfer cannot touch the shared mock the rehearsal uses)
// + own escrow deployed from freeze-candidate-2's wasm (caf134a4, sha-checked against release/freeze-candidate-2.json). Init args = frz3's (live-NOKEY1b/new_args.json)
// except intents -> the private mock and guardian -> a fresh guardian account. outcome_pubkey is frz3's (no resolver run happens in these drills).
import fs from "node:fs"; import crypto from "node:crypto";
import { account, createKeyed, store, view, DEV, DIR, S, sleep } from "./lib.mjs";
const { load, save, rec } = store("run/d34_results.json");
const ts = new Date().toISOString().replace(/\D/g, "").slice(2, 12);
const ESC = `praetorial-drill9-${ts}.${DEV}`, MOCK = `praetorial-d9mock-${ts}.${DEV}`;
const names = { guardian: `d9-guardian-${ts}.${DEV}`, m1: `d9-m1-${ts}.${DEV}`, t1: `d9-t1-${ts}.${DEV}`, m2: `d9-m2-${ts}.${DEV}`, t2: `d9-t2-${ts}.${DEV}`, m3: `d9-m3-${ts}.${DEV}` };
const wasmPath = `${S}/rbout6/escrow.wasm`; const wasm = fs.readFileSync(wasmPath), sha = crypto.createHash("sha256").update(wasm).digest("hex");
const REC = JSON.parse(fs.readFileSync(DIR + "../../../../release/freeze-candidate-2.json", "utf8")).escrow.wasm_sha256;
if (sha !== REC) throw new Error(`escrow wasm sha ${sha} != freeze-candidate-2 ${REC}`);
const mockWasm = fs.readFileSync(`${S}/dr9/tgt/wasm32-unknown-unknown/release/mock_intents.wasm`);
const base = JSON.parse(fs.readFileSync(DIR + "../../live-NOKEY1b/new_args.json", "utf8"));
const dev = await account(DEV);
const R = load(); R.escrow = ESC; R.mock = MOCK; R.accounts = names; R.wasm_sha256 = sha; R.mock_wasm_sha256 = crypto.createHash("sha256").update(mockWasm).digest("hex"); save(R);
rec("create_escrow_account", await createKeyed(dev, ESC, "6"));
rec("create_mock_account", await createKeyed(dev, MOCK, "3"));
for (const [k, id] of Object.entries(names)) rec(`create_${k}`, await createKeyed(dev, id, "0.2"));
const mock = await account(MOCK);
let d = await mock.deployContract(mockWasm); rec("deploy_mock", d.transaction.hash);
d = await mock.functionCall({ contractId: MOCK, methodName: "new", args: {}, gas: 50_000_000_000_000n }); rec("mock_new", d.transaction.hash);
const esc = await account(ESC);
d = await esc.deployContract(wasm); rec("deploy_escrow", d.transaction.hash, { wasm_sha256: sha });
const args = { ...base, intents: MOCK, guardian: names.guardian };
d = await esc.functionCall({ contractId: ESC, methodName: "new", args, gas: 100_000_000_000_000n }); rec("escrow_new", d.transaction.hash);
R.new_args = args; R.args_diff_vs_frz3 = { intents: `${base.intents} -> ${MOCK}`, guardian: `${base.guardian} -> ${names.guardian}` }; save(R);
await sleep(3000);
console.log(ESC, MOCK, "is_shutdown", await view(ESC, "is_shutdown"), "keys", JSON.stringify((await view(ESC, "resolver_keys")).map((k) => k.slice(0, 8))));
