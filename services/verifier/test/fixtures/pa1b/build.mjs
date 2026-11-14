// Builds params_fixture.json: synthetic-but-realistic PA1 escrow data in the exact shapes the contract emits.
//   node test/fixtures/pa1b/build.mjs   (deterministic; no network)
// Event lines are a char-for-char port of contracts/escrow/src/lib.rs `log_str` format in propose_params/apply_params/
// cancel_params + `params_event_json` (the contract's own emit code; test/params.test.ts re-checks the Rust source for drift).
// Views are the serde JSON of `PendingParams` / `AssetLimit` (U128 = decimal string, u64 = bare number) as NEAR RPC returns them.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DAY = 86_400_000_000_000n;
const T0 = 1793000000000000000n; // 2026-10-26, ns
const USDC = "usdc.fakes.testnet", USDT = "usdt.fakes.testnet";
const lim = (min, max, minFee, cap) => ({ min_per_side: String(min), max_per_side: String(max), min_fee_per_side: String(minFee), min_fee_cap_per_side: String(cap), run_price: "250000", min_bond: "5000000", min_objection: "1000000" });
const newArgs = { guardian: "guardian.testnet", fee_account: "fee.testnet", asset_limits: [[USDC, lim(5000000, 100000000, 250000, 2500000)], [USDT, lim(5000000, 100000000, 250000, 0)]] };

const f = (v) => (v === null ? "null" : `"${v}"`);
const eventData = (p) => `{"fee_bps":${p.fee_bps === null ? "null" : p.fee_bps},"assets":[${p.assets.map((a) => `{"asset_id":"${a.asset_id}","min_fee_per_side":${f(a.min_fee_per_side)},"min_per_side":${f(a.min_per_side)},"max_per_side":${f(a.max_per_side)}}`).join(",")}],"proposed_at_ns":${p.proposed_at_ns},"effective_at_ns":${p.effective_at_ns}}`;
const line = (ev, p) => `EVENT_JSON:{"standard":"praetorial-escrow","version":"1.0.0","event":"${ev}","data":[${eventData(p)}]}`;
const pend = (at, change) => ({ ...change, proposed_at_ns: String(at), effective_at_ns: String(at + DAY) });
let n = 0;
const receipt = (at, method, logs) => ({ tx_hash: `PA1bTx${String(++n).padStart(3, "0")}`, method, block_timestamp: String(at), ok: true, logs });

// P1: fee 100 -> 150, USDC min fee 250000 -> 200000; proposed day 0, applied day 1 + 5 min.
const p1 = pend(T0 + DAY, { fee_bps: 150, assets: [{ asset_id: USDC, min_fee_per_side: "200000", min_per_side: null, max_per_side: null }] });
// P2: raise USDC min/max (min fee unchanged), proposed day 3, CANCELLED day 3 + 1h.
const p2 = pend(T0 + 3n * DAY, { fee_bps: null, assets: [{ asset_id: USDC, min_fee_per_side: null, min_per_side: "20000000", max_per_side: "500000000" }] });
// P3: USDT min fee up to its pinned cap-by-default (250000 -> stays <= cap 250000), max up; proposed day 5, applied day 6 exactly at effective.
const p3 = pend(T0 + 5n * DAY, { fee_bps: 120, assets: [{ asset_id: USDT, min_fee_per_side: "100000", min_per_side: null, max_per_side: "250000000" }] });
// P4: still pending at the end (view shows it).
const p4 = pend(T0 + 8n * DAY, { fee_bps: null, assets: [{ asset_id: USDC, min_fee_per_side: "150000", min_per_side: null, max_per_side: null }] });

const receipts = [
  receipt(BigInt(p1.proposed_at_ns), "propose_params", [line("params_proposed", p1)]),
  receipt(BigInt(p1.effective_at_ns) + 300_000_000_000n, "apply_params", [line("params_applied", p1)]),
  receipt(BigInt(p2.proposed_at_ns), "propose_params", [line("params_proposed", p2)]),
  receipt(BigInt(p2.proposed_at_ns) + 3_600_000_000_000n, "cancel_params", [line("params_cancelled", p2)]),
  receipt(BigInt(p3.proposed_at_ns), "propose_params", [line("params_proposed", p3)]),
  receipt(BigInt(p3.effective_at_ns), "apply_params", [line("params_applied", p3)]),
  receipt(BigInt(p4.proposed_at_ns), "propose_params", [line("params_proposed", p4)]),
];
// A failed apply_params (too early) logs nothing and must be ignored; an unrelated event from another standard too.
receipts.splice(5, 0, { tx_hash: "PA1bTxEarly", method: "apply_params", block_timestamp: String(BigInt(p3.proposed_at_ns) + 3_600_000_000_000n), ok: false, logs: [] });
receipts.push({ tx_hash: "PA1bTxOther", method: "mt_on_transfer", block_timestamp: String(T0 + 8n * DAY + 1000n), ok: true, logs: ["open bet_id=7 maker=a.testnet", 'EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_mint","data":[]}'] });

// Views at the end: replay of P1 then P3 on top of new(); P4 pending.
const views = {
  protocol_fee_bps: 120,
  asset_limit: { [USDC]: lim(5000000, 100000000, 200000, 2500000), [USDT]: lim(5000000, 250000000, 100000, 250000) },
};
// NEAR RPC returns the view as JSON TEXT with u64 ns as bare numbers (serde of PendingParams); keep it as text so tests exercise exact-digit parsing.
views.pending_params_raw = `{"change":{"fee_bps":null,"assets":${JSON.stringify(p4.assets)}},"proposed_at_ns":${p4.proposed_at_ns},"effective_at_ns":${p4.effective_at_ns}}`;
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "params_fixture.json"), JSON.stringify({ note: "synthetic-but-realistic; see build.mjs", new_args: newArgs, receipts, views }, null, 2) + "\n");
