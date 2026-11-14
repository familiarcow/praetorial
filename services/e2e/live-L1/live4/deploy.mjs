// L1b: deploy main's stripped escrow wasm to the fresh escrow account (init follows in 3_deploy_init.mjs with SKIP_DEPLOY=1 once pubkeys are known)
import fs from "node:fs"; import crypto from "node:crypto";
import { account, mk, balance } from "./lib.mjs"; import * as C from "./config.mjs";
const { load, save, recordTx } = mk("./results.json");
const wasm = fs.readFileSync(C.ESCROW_WASM); const sha = crypto.createHash("sha256").update(wasm).digest("hex");
const esc = await account(C.ESCROW); const dep = await esc.deployContract(wasm);
recordTx("deploy_escrow", dep.transaction.hash, { wasm_sha256: sha, wasm_bytes: wasm.length, status: "Success" });
const r = load(); r.escrow_wasm_sha256 = sha; r.source_commit = "79c4bd4 (escrow code unchanged; hash a240f363 identical)"; r.balances = { ...(r.balances ?? {}), escrow_after_deploy: await balance(C.ESCROW) }; save(r);
console.log(sha, r.balances);
