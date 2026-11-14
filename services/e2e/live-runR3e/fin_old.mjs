// R3e part C: finalize R3c bets 1 and 2 on the OLD R3c escrow, check refunds. usage: node fin_old.mjs snap|finalize
import fs from "node:fs";
import { account, mk } from "./lib.mjs";
const OLD = "praetorial-r3c-11061912.praetorial-dev-1101.testnet", INTENTS = "intents-mock.praetorial-dev-1101.testnet", USDC = "nep141:usdc.testnet";
const { load, save, recordTx } = mk("./results_fin_old.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const a = await account("praetorial-dev-1101.testnet");
const view = (m, args) => a.viewFunction({ contractId: OLD, methodName: m, args });
const mt = (id) => a.viewFunction({ contractId: INTENTS, methodName: "mt_balance_of", args: { account_id: id, token_id: USDC } });
const parties = ["maker1.praetorial-dev-1101.testnet", "taker1.praetorial-dev-1101.testnet", "fee.praetorial-dev-1101.testnet", OLD];
const snap = async () => { const o = {}; for (const p of parties) o[p.split(".")[0]] = await mt(p); return o; };
const brief = async () => { const o = {}; for (const id of [1, 2]) { const b = await view("get_bet", { bet_id: id }); o[id] = { status: b.status, outcome: b.outcome, proposed_at: b.proposed_at, maker: b.envelope.maker, taker: b.taker, stake_maker: b.envelope.stake_maker, stake_taker: b.envelope.stake_taker, storage: b.envelope.storage_charge_per_side }; } return o; };
const phase = process.argv[2];
let r = load(); if (!r.txs) r.txs = [];
if (phase === "snap") { r.before = { ts: new Date().toISOString(), balances: await snap(), bets: await brief(), pending: await view("pending_payouts_view", { from: 0, limit: 100 }) }; save(r); console.log(JSON.stringify(r.before)); }
else {
  for (const id of [1, 2]) {
    const f = await a.functionCall({ contractId: OLD, methodName: "finalize", args: { bet_id: id }, gas: 150_000_000_000_000n });
    recordTx(`finalize_bet${id}`, f.transaction.hash, { status: JSON.stringify(f.status).includes("Failure") ? "Failure" : "Success" }); await sleep(4000);
  }
  for (let i = 0; i < 4; i++) {
    const p = (await view("pending_payouts_view", { from: 0, limit: 100 })).filter((x) => !x.done);
    if (!p.length) break;
    for (const id of [1, 2]) { const d = await a.functionCall({ contractId: OLD, methodName: "drain_payouts", args: { bet_id: id, limit: 20 }, gas: 300_000_000_000_000n }); recordTx(`drain_bet${id}_${i}`, d.transaction.hash, { status: JSON.stringify(d.status).includes("Failure") ? "Failure" : "Success" }); }
    await sleep(4000);
  }
  r = load(); r.after = { ts: new Date().toISOString(), balances: await snap(), bets: await brief(), pending: await view("pending_payouts_view", { from: 0, limit: 100 }) }; save(r); console.log(JSON.stringify(r.after));
}
