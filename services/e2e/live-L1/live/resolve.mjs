// L1b: keeper credit-mode request_resolution for one bet; poll until not Resolving; save raw. usage: node resolve.mjs <example_id>
import fs from "node:fs";
import { account, mk } from "./lib.mjs"; import * as C from "./config.mjs";
const BET = process.argv[2]; const { load, save, recordTx } = mk(`./results_${BET}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keeper = await account(C.KEEPER); const view = (m, a) => keeper.viewFunction({ contractId: C.ESCROW, methodName: m, args: a });
const betId = load().bet_id; const pre = await view("keeper_credit_balance");
let res;
try { res = await keeper.functionCall({ contractId: C.ESCROW, methodName: "request_resolution", args: { bet_id: betId }, gas: 280_000_000_000_000n, attachedDeposit: 0n }); }
catch (e) { const r = load(); r.request_resolution_error = String(e.message).slice(0, 800); r.request_resolution_error_tx = e.context?.transactionHash ?? null; save(r); console.log("FAILED", r.request_resolution_error); process.exit(2); }
const st = JSON.stringify(res.status).slice(0, 200);
recordTx("request_resolution", res.transaction.hash, { status: st.includes("Failure") ? "Failure" : "Success", keeper_credit_before: pre });
for (let i = 0; i < 100; i++) { const b = await view("get_bet", { bet_id: betId }); console.log(i, b.status); if (b.status !== "Resolving") break; await sleep(5000); }
const b = await view("get_bet", { bet_id: betId }); fs.writeFileSync(`${new URL(".", import.meta.url).pathname}raw_resolution_${BET}.txt`, String(b.last_resolution_raw));
const r = load(); r.bet_after_request = { ...b, envelope: { ...b.envelope, terms: undefined } }; r.keeper_credit_after = await view("keeper_credit_balance"); save(r);
console.log(b.status, String(b.last_resolution_raw).slice(0, 300));
