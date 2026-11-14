// R3f part 1: finalize R3e bet 1 (Proposed YES, maker1 is YES side) and check payouts. usage: node fin_r3f.mjs
import { account, mk, balance } from "./lib.mjs";
import * as C from "./config.mjs";
const { load, save, recordTx } = mk("./results_finalize.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const a = await account(C.OPERATOR);
const view = (m, args) => a.viewFunction({ contractId: C.ESCROW, methodName: m, args });
const mt = (id) => a.viewFunction({ contractId: C.INTENTS, methodName: "mt_balance_of", args: { account_id: id, token_id: C.USDC } });
const snap = async () => ({ maker: await mt(C.MAKER), taker: await mt(C.TAKER), fee: await mt(C.FEE), escrow: await mt(C.ESCROW) });
const pend = async () => (await view("pending_payouts_view", { from: 0, limit: 100 })).filter((x) => !x.done);
let r = load(); if (!r.txs) r.txs = [];
const b0 = await view("get_bet", { bet_id: 1 });
const before = await snap();
const e = b0.envelope;
r.before = { ts: new Date().toISOString(), status: b0.status, outcome: b0.outcome, maker_side: e.maker_side, stake_maker: e.stake_maker, stake_taker: e.stake_taker, fee_bps: e.fee_bps, balances: before, near: { escrow: await balance(C.ESCROW) } };
save(r);
if (b0.status !== "Proposed" || b0.outcome !== "YES") throw new Error("unexpected state " + b0.status + "/" + b0.outcome);
const f = await a.functionCall({ contractId: C.ESCROW, methodName: "finalize", args: { bet_id: 1 }, gas: 150_000_000_000_000n });
recordTx("finalize_bet1", f.transaction.hash, { status: JSON.stringify(f.status).includes("Failure") ? "Failure" : "Success" }); await sleep(4000);
for (let i = 0; i < 4; i++) {
  if (!(await pend()).length) break;
  const d = await a.functionCall({ contractId: C.ESCROW, methodName: "drain_payouts", args: { bet_id: 1, limit: 20 }, gas: 300_000_000_000_000n });
  recordTx(`drain_${i}`, d.transaction.hash); await sleep(4000);
}
const b1 = await view("get_bet", { bet_id: 1 });
const after = await snap();
const D = (k) => (BigInt(after[k]) - BigInt(before[k])).toString();
const stake = BigInt(e.stake_maker) + BigInt(e.stake_taker);
const fee = BigInt(e.stake_maker) * BigInt(e.fee_bps) / 10000n + BigInt(e.stake_taker) * BigInt(e.fee_bps) / 10000n;
const expectedWinner = (stake - fee).toString();
const pending = await pend();
r = load();
r.after = { ts: new Date().toISOString(), status: b1.status, outcome: b1.outcome, balances: after, deltas: { maker: D("maker"), taker: D("taker"), fee: D("fee"), escrow: D("escrow") }, pending_not_done: pending.length, near: { escrow: await balance(C.ESCROW) } };
r.check = { pot: stake.toString(), documented_fee: fee.toString(), expected_winner_gain: expectedWinner, winner: "maker (maker_side YES == outcome YES)", winner_exact: D("maker") === expectedWinner, fee_exact: D("fee") === fee.toString(), pending_zero: pending.length === 0 };
save(r); console.log(JSON.stringify({ status: b1.status, deltas: r.after.deltas, check: r.check }));
