// PHASE 16 tail: read OutLayer's signed outcome from bet.last_resolution_raw, submit_outcome, then (once settlement_period elapsed) finalize + drain_payouts.
// usage: node 16_finish.mjs submit | node 16_finish.mjs finalize
import { account, mk } from "../live-run16a/lib.mjs";
import * as C from "../live-run8/config.mjs";
const { load, save, recordTx } = mk("../live-run16c/results.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const anyone = await account(C.OPERATOR);
const view = (m, a) => anyone.viewFunction({ contractId: C.ESCROW, methodName: m, args: a });
const betId = load().bet_id;
const phase = process.argv[2];
const snap = async () => { const o = {}; for (const a of [C.MAKER, C.TAKER, C.FEE, C.ESCROW]) o[a.split(".")[0]] = await view_mt(a); return o; };
const view_mt = (a) => anyone.viewFunction({ contractId: C.INTENTS, methodName: "mt_balance_of", args: { account_id: a, token_id: C.USDC } });
if (phase === "submit") {
  const b = await view("get_bet", { bet_id: betId });
  const raw = b.last_resolution_raw;
  const r = load(); r.last_resolution_raw = raw; r.bet_status_at_submit = b.status; save(r);
  console.log("status", b.status, "raw:", String(raw).slice(0, 1500));
  let parsed; try { parsed = JSON.parse(raw); } catch { console.log("raw not JSON"); process.exit(2); }
  const res = parsed.result ?? parsed.submitted_result ?? parsed.output?.result;
  const sig = parsed.signature_hex ?? parsed.signature ?? parsed.output?.signature_hex;
  if (!res || !sig) { console.log("cannot find result/signature in raw; keys:", Object.keys(parsed)); process.exit(3); }
  const tx = await anyone.functionCall({ contractId: C.ESCROW, methodName: "submit_outcome", args: { result: res, signature_hex: sig }, gas: 100_000_000_000_000n });
  const st = JSON.stringify(tx.status).slice(0, 200);
  recordTx("submit_outcome", tx.transaction.hash, { status: st.includes("Failure") ? "Failure" : "Success", signed_result: res });
  await sleep(3000);
  const a = await view("get_bet", { bet_id: betId }); const r2 = load(); r2.after_submit = { status: a.status, outcome: a.outcome, settle_ready_ns: a.settle_ready_ns ?? null }; save(r2);
  console.log(JSON.stringify(r2.after_submit));
} else if (phase === "finalize") {
  const r0 = load(); r0.before = r0.before ?? await snap(); save(r0);
  const f = await anyone.functionCall({ contractId: C.ESCROW, methodName: "finalize", args: { bet_id: betId }, gas: 150_000_000_000_000n });
  recordTx("finalize", f.transaction.hash, { status: JSON.stringify(f.status).includes("Failure") ? "Failure" : "Success" });
  await sleep(4000);
  for (let i = 0; i < 4; i++) {
    const b = await view("get_bet", { bet_id: betId }); if (b.status === "Settled" && !(await view("pending_payouts_view", { from: 0, limit: 50 })).some((p) => p.bet_id === betId && !p.done)) break;
    const d = await anyone.functionCall({ contractId: C.ESCROW, methodName: "drain_payouts", args: { bet_id: betId, limit: 20 }, gas: 300_000_000_000_000n });
    recordTx(`drain_payouts_${i}`, d.transaction.hash, { status: JSON.stringify(d.status).includes("Failure") ? "Failure" : "Success" }); await sleep(4000);
  }
  const fin = await view("get_bet", { bet_id: betId });
  const r = load(); r.final_status = fin.status; r.outcome = fin.outcome; r.after = await snap();
  r.payouts = (await view("pending_payouts_view", { from: 0, limit: 50 })).filter((p) => p.bet_id === betId).map((p) => ({ receiver: p.receiver, token: p.token_id, amount: p.amount, reason: p.reason, done: p.done })); save(r);
  console.log(JSON.stringify({ final: fin.status, outcome: fin.outcome, payouts: r.payouts }, null, 1));
}
