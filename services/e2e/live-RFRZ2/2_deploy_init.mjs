// RFRZ2: deploy the record-c40e5fa escrow wasm to the fresh account, then new() with the gen-new-args testnet args. Hash must equal the record.
import fs from "node:fs";
import crypto from "node:crypto";
import { account, mk } from "./lib.mjs";
const { load, save, recordTx } = mk("./results.json");
const [, , ESC, WASM, ARGS, RECORD_SHA] = process.argv;
const wasm = fs.readFileSync(WASM), sha = crypto.createHash("sha256").update(wasm).digest("hex");
if (sha !== RECORD_SHA) throw new Error(`wasm sha ${sha} != record ${RECORD_SHA}`);
const args = JSON.parse(fs.readFileSync(ARGS, "utf8"));
const esc = await account(ESC);
const dep = await esc.deployContract(wasm);
recordTx("deploy_escrow", dep.transaction.hash, { wasm_sha256: sha, status: "Success" });
const init = await esc.functionCall({ contractId: ESC, methodName: "new", args, gas: 100_000_000_000_000n });
recordTx("escrow_new", init.transaction.hash, { status: "Success" });
const r = load(); r.new_args = args; r.wasm_sha256 = sha; save(r);
await new Promise((x) => setTimeout(x, 3000));
const view = (m) => esc.viewFunction({ contractId: ESC, methodName: m, args: {} });
const st = await esc.state();
console.log("code_hash_b58", st.code_hash, JSON.stringify({ keys: await view("resolver_keys"), cfg: await view("outlayer_config") }));
