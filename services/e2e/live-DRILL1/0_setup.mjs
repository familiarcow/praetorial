// DRILL1 step 0: fund dev, create throwaway escrow drill1-<ts> + guardians G1/G2/G3, report-pubkey as the escrow, deploy caf134a4 wasm, new().
import fs from "node:fs"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
import { account, createKeyed, recordTx, load, save, DEV, DIR, CRED, utils, viewer, sleep } from "./lib.mjs";
const ts = new Date().toISOString().replace(/\D/g, "").slice(2, 12);
const ESC = `drill1-${ts}.${DEV}`; const G = [1, 2, 3].map((i) => `drill1-g${i}-${ts}.${DEV}`);
const S = ((process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir)"); })()) + "/scratch");
const WASM = `${S}/frz1b/esc/escrow.wasm`; const REC = JSON.parse(fs.readFileSync(DIR + "../../../release/freeze-candidate-2.json", "utf8")).escrow.wasm_sha256;
const wasm = fs.readFileSync(WASM), sha = crypto.createHash("sha256").update(wasm).digest("hex");
if (sha !== REC) throw new Error(`wasm sha ${sha} != release ${REC}`);
const frz = JSON.parse(fs.readFileSync(DIR + "../live-FRZ1/results.json", "utf8")).new_args;
const dev = await account(DEV); const v = await viewer();
const funder = await account("pf-109110569.testnet");
const t = await funder.sendMoney(DEV, utils.format.parseNearAmount("6.4")); recordTx("fund_dev_from_pf-109110569", t.transaction.hash, { near: "6.4" });
const e = await createKeyed(dev, ESC, "6.5"); recordTx("create_escrow_account", e.hash, { account: ESC, funded_near: "6.5" });
for (const g of G) { const r = await createKeyed(dev, g, "0.3"); recordTx("create_guardian_account", r.hash, { account: g, funded_near: "0.3" }); }
const home = `${S}/olhome-drill1`; fs.mkdirSync(`${home}/testnet`, { recursive: true }); fs.writeFileSync(`${home}/default-network`, "testnet\n");
const k = JSON.parse(fs.readFileSync(`${CRED}/${ESC}.json`, "utf8"));
fs.writeFileSync(`${home}/testnet/credentials.json`, JSON.stringify({ account_id: ESC, public_key: k.public_key, private_key: k.private_key, contract_id: "outlayer.testnet", auth_type: "near_key" }, null, 2), { mode: 0o600 });
const url = `${frz.outlayer_config.wasm_base_url}/${frz.resolver_wasm_hash}.wasm`;
fs.writeFileSync(DIR + "job_report_pubkey.json", JSON.stringify({ mode: "report-pubkey" }));
let out; for (let a = 0; a < 3 && !out; a++) { try { out = execFileSync("/bin/sh", ["-c", `outlayer run --wasm ${url} --input ${DIR}job_report_pubkey.json 2>&1`], { env: { ...process.env, OUTLAYER_HOME: home }, encoding: "utf8", timeout: 280000 }); } catch (err) { console.log("outlayer retry"); } }
fs.writeFileSync(DIR + "report_pubkey_outcome.log", out);
const j = JSON.parse(out.slice(out.indexOf("{", out.indexOf("Tx:")), out.lastIndexOf("}") + 1));
if (j.predecessor !== ESC) throw new Error("predecessor mismatch");
const args = { ...frz, guardian: G[0], outcome_pubkey: j.public_key };
fs.writeFileSync(DIR + "new_args.json", JSON.stringify(args, null, 2));
const esc = await account(ESC);
const dep = await esc.deployContract(wasm); recordTx("deploy_escrow", dep.transaction.hash, { wasm_sha256: sha });
const init = await esc.functionCall({ contractId: ESC, methodName: "new", args, gas: 100_000_000_000_000n }); recordTx("escrow_new", init.transaction.hash);
const r = load(); r.escrow = ESC; r.guardians = { G1: G[0], G2: G[1], G3: G[2] }; r.wasm_sha256 = sha; r.new_args = args;
r.frz1b_args_diff = { guardian: `${frz.guardian} -> ${G[0]}`, outcome_pubkey: `${frz.outcome_pubkey} -> ${j.public_key} (report-pubkey bound to the new escrow account)` }; save(r);
await sleep(3000);
console.log("guardian state", JSON.stringify(await v.viewFunction({ contractId: ESC, methodName: "is_shutdown", args: {} })));
console.log(ESC);
