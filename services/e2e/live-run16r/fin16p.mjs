// item 16p: finalize Proposed-VOID bet 1 (16l escrow), drain only if pending, verify exact refunds.
import { account, mk, balance } from "./lib.mjs";
import * as C from "./config.mjs";
const { load, save, recordTx } = mk("./results.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const a = await account(C.OPERATOR);
const view = (m, args) => a.viewFunction({ contractId: C.ESCROW, methodName: m, args });
const mt = (acc, t) => a.viewFunction({ contractId: C.INTENTS, methodName: "mt_balance_of", args: { account_id: acc, token_id: t } });
const snap = async () => { const o = {}; for (const t of [C.USDC, C.BTC]) for (const x of [C.MAKER, C.TAKER, C.FEE, C.ESCROW]) o[`${x.split(".")[0]}|${t}`] = await mt(x, t); return o; };
const b0 = await view("get_bet", { bet_id: 1 });
const nbMs = Number((BigInt(b0.proposed_at) + 3600n * 1000000000n) / 1000000n);
const deadline = Date.now() + 540000;
for (;;) {
  const blk = await a.connection.provider.block({ finality: "final" });
  const ms = Number(BigInt(blk.header.timestamp_nanosec) / 1000000n);
  if (ms > nbMs + 5000) break;
  if (Date.now() > deadline) { console.log("still waiting, rerun"); process.exit(4); }
  console.log("waiting", Math.round((nbMs - ms) / 1000), "s");
  await sleep(Math.min(Math.max(nbMs - ms, 5000), 20000));
}
const before = await snap(); const devBefore = await balance(C.OPERATOR);
console.log("status before", b0.status, JSON.stringify(b0.outcome));
const out = { not_before_ms: nbMs, status_before: b0.status, outcome_before: b0.outcome, balances_before: before, dev_near_before: devBefore, txs: [] };
let r = load(); r.finalize_16p = out; save(r);
try {
  const f = await a.functionCall({ contractId: C.ESCROW, methodName: "finalize", args: { bet_id: 1 }, gas: 150_000_000_000_000n });
  const st = JSON.stringify(f.status).includes("Failure") ? "Failure" : "Success";
  recordTx("finalize_16p", f.transaction.hash, { status: st });
  out.txs.push({ step: "finalize", hash: f.transaction.hash, url: `https://testnet.nearblocks.io/txns/${f.transaction.hash}`, status: st, raw_status: JSON.stringify(f.status).slice(0, 300) });
} catch (e) { out.error = String(e.message ?? e).slice(0, 1500); r = load(); r.finalize_16p = out; save(r); console.log("FAILED", out.error); process.exit(1); }
await sleep(5000);
const pend = async () => (await view("pending_payouts_view", { from: 0, limit: 50 })).filter((p) => !p.done);
for (let i = 0; i < 3 && (await pend()).length; i++) {
  const d = await a.functionCall({ contractId: C.ESCROW, methodName: "drain_payouts", args: { bet_id: 1, limit: 20 }, gas: 300_000_000_000_000n });
  recordTx(`drain_16p_${i}`, d.transaction.hash, { status: "Success" });
  out.txs.push({ step: `drain_${i}`, hash: d.transaction.hash, url: `https://testnet.nearblocks.io/txns/${d.transaction.hash}` }); await sleep(5000);
}
const fin = await view("get_bet", { bet_id: 1 }); const after = await snap();
out.status_after = fin.status; out.outcome_after = fin.outcome; out.balances_after = after; out.pending_payouts = (await pend()).length; out.dev_near_after = await balance(C.OPERATOR);
out.deltas = Object.fromEntries(Object.keys(after).map((k) => [k, (BigInt(after[k]) - BigInt(before[k])).toString()]));
out.verified = { maker_usdc_plus_10: out.deltas[`maker1|${C.USDC}`] === "10000000", taker_usdc_plus_10: out.deltas[`taker1|${C.USDC}`] === "10000000", escrow_zero: after[`praetorial-e2e-2611052236|${C.USDC}`] === "0" && after[`praetorial-e2e-2611052236|${C.BTC}`] === "0", pending_zero: out.pending_payouts === 0 };
r = load(); r.finalize_16p = out; save(r); console.log(JSON.stringify(out, null, 1));
