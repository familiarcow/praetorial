// PHASE 16: keeper requests resolution via OutLayer (credit mode, no deposit); poll until the callback/outcome arrives. Records everything.
import { account, mk } from "./lib.mjs";
import * as C from "./config.mjs";
const { load, save, recordTx } = mk("./results.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keeper = await account(C.KEEPER);
const view = (m, a) => keeper.viewFunction({ contractId: C.ESCROW, methodName: m, args: a });
const betId = load().bet_id;
const pre = await view("keeper_credit_balance");
let res;
try { res = await keeper.functionCall({ contractId: C.ESCROW, methodName: "request_resolution", args: { bet_id: betId }, gas: 280_000_000_000_000n, attachedDeposit: 0n }); }
catch (e) { const r = load(); r.request_resolution_error = String(e.message).slice(0, 800); r.request_resolution_error_tx = e.context?.transactionHash ?? e.transaction_outcome?.id; save(r); console.log("request_resolution FAILED", r.request_resolution_error, r.request_resolution_error_tx); process.exit(2); }
const st = JSON.stringify(res.status).slice(0, 200);
recordTx(process.env.STEP ?? "request_resolution", res.transaction.hash, { status: st.includes("Failure") ? "Failure" : "Success", raw: st, keeper_credit_before: pre });
for (const ro of res.receipts_outcome) for (const l of ro.outcome.logs) console.log("log:", l.slice(0, 300));
for (let i = 0; i < 60; i++) { const b = await view("get_bet", { bet_id: betId }); const r = load(); r.poll = { i, status: b.status, runs_used: b.runs_used }; save(r); console.log(i, b.status); if (b.status !== "Resolving") break; await sleep(5000); }
const r = load(); r.bet_after_request = await view("get_bet", { bet_id: betId }); r.keeper_credit_after = await view("keeper_credit_balance"); save(r);
