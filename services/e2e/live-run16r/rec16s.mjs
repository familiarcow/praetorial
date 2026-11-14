import fs from "node:fs";
const p = new URL("./results.json", import.meta.url).pathname;
const r = JSON.parse(fs.readFileSync(p, "utf8"));
const f = r.finalize_16s;
r["16s"] = {
  finalize_tx: f.txs[0].hash, finalize_status: f.txs[0].raw_status, drain_txs: [],
  bet1: { before: "Proposed VOID", after: `${f.status_after} ${f.outcome_after}` },
  balances_before: f.balances_before, balances_after: f.balances_after, deltas: f.deltas,
  pending_payouts_after: f.pending_payouts, dev_near_before: f.dev_near_before, dev_near_after: f.dev_near_after,
  escrow_note: "escrow USDC 20.016 remaining = bet 2 stakes 2x10 + 2x8000 storage (still Resolving); BTC 0",
  bet2: { status: "Resolving (submit_outcome reverted 'run_no out of order', pre-16t contract)", resolve_deadline_ns: "1796585497402000000", not_before_ET: "2026-12-06 14:31:37 EST", action: "none; deadline not passed (checked 2026-11-06 ~17:30 EST); void_after_deadline NOT called" },
};
fs.writeFileSync(p, JSON.stringify(r, null, 2));
