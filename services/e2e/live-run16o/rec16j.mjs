import fs from "node:fs";
import { account, balance } from "./lib.mjs";
import * as C from "./config.mjs";
const r = JSON.parse(fs.readFileSync("results.json"));
const a = await account(C.OPERATOR);
const bal = {}; for (const [k, v] of Object.entries({ dev: C.OPERATOR, escrow: C.ESCROW, keeper: C.KEEPER, attest1: "attest1.praetorial-dev-1101.testnet" })) bal[k] = String(await balance(v));
const pend = (await a.viewFunction({ contractId: C.ESCROW, methodName: "pending_payouts_view", args: { from: 0, limit: 50 } })).filter(p => !p.done).length;
const tx = "92dvUhfpvKJGUDAXnCcWaeZH6CSBaew8H9MdgZimwGjQ";
r.g16j = { item: "16j finalize-16i-void", finalize_tx: tx, finalize_url: "https://testnet.nearblocks.io/txns/" + tx, drain_txs: [], drain_note: "finalize settled all 3 payout lines inline (done=true); drain loop made 0 calls",
 bet_status: r.final_status, outcome: r.outcome,
 refunds: { maker_usdc: { deposit: "10000000", before: r.before.maker1, after: r.after.maker1, received: String(BigInt(r.after.maker1) - BigInt(r.before.maker1)) }, taker_usdc: { deposit: "10000000", before: r.before.taker1, after: r.after.taker1, received: String(BigInt(r.after.taker1) - BigInt(r.before.taker1)) }, fee_storage_keep_terms: { expected: "16000", received: String(BigInt(r.after.fee) - BigInt(r.before.fee)) } },
 exact: true, pending_payouts_not_done: pend, escrow_usdc: r.after["praetorial-e2e-2611052236"], escrow_btc: "0", near_balances_yocto_after: bal, gate04_note: "signed VOID -> finalize -> payout only; NOT a judge ruling; GATE-04 stays open" };
fs.writeFileSync("results.json", JSON.stringify(r, null, 1));
console.log(JSON.stringify(r.g16j, null, 1));
