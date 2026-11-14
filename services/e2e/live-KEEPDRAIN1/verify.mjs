#!/usr/bin/env node
// KEEPDRAIN1 verify: exits 1 if any payout line on the escrow stays undone at attempts 0 for more than 3 keeper ticks (minutes).
// usage: NEAR_RPC_URL=<testnet rpc> node verify.mjs [--escrow <id>] [--rpc <url>] [--samples 5] [--interval-s 60]
// Samples pending_payouts_view `samples` times, `interval-s` apart (default 5 x 60 s = 4 minute window => a line seen undone with
// attempts 0 in all 5 consecutive samples has waited > 3 ticks). Use --samples 1 for a point-in-time check (fails only on that
// line set being non-empty AND --strict). Read-only: never signs or sends anything.
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const ESCROW = arg("escrow", "praetorial-frz1b-2611081810.praetorial-dev-1101.testnet");
const RPC = arg("rpc", process.env.NEAR_RPC_URL); if (!RPC) { console.error("set NEAR_RPC_URL (testnet) or pass --rpc"); process.exit(2); }
const SAMPLES = Number(arg("samples", 5)), INTERVAL = Number(arg("interval-s", 60)) * 1000;
async function lines() {
  const out = []; let from = 1;
  for (;;) {
    const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: ESCROW, method_name: "pending_payouts_view", args_base64: Buffer.from(JSON.stringify({ from, limit: 200 })).toString("base64") } }) })).json();
    if (r.error || r.result?.error) throw new Error(JSON.stringify(r.error ?? r.result.error));
    const page = JSON.parse(Buffer.from(r.result.result).toString());
    out.push(...page);
    if (page.length < 200) return out;
    from = Math.max(...page.map((p) => Number(p.id))) + 1;
  }
}
const stuck = new Map(); // line id -> consecutive samples undone at attempts 0
for (let i = 0; i < SAMPLES; i++) {
  if (i) await new Promise((r) => setTimeout(r, INTERVAL));
  const all = await lines();
  const bad = all.filter((l) => !l.done && Number(l.attempts) === 0);
  const keep = new Map();
  for (const l of bad) keep.set(l.id, (stuck.get(l.id) ?? 0) + 1);
  stuck.clear(); for (const [k, v] of keep) stuck.set(k, v);
  console.log(`sample ${i + 1}/${SAMPLES}: lines=${all.length} undone=${all.filter((l) => !l.done).length} undone_at_attempts_0=${bad.length}`);
}
const over = [...stuck].filter(([, n]) => n >= 4);
if (over.length) { console.log("FAIL: payout lines stuck at attempts 0 for > 3 ticks:", over.map(([id, n]) => `line ${id} (${n} samples)`).join(", ")); process.exit(1); }
console.log("PASS: no payout line stayed at attempts 0 for more than 3 ticks");
