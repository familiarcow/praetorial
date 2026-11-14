// V1c / D-VER2: live mode derives B2/B3/B5/B6 (+B4 when raw is present) from public tx history.
// All HTTP is served from RECORDED R3e responses (fixtures/v1c); tampered copies must flip the matching check to FAIL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBetChecks, type CheckResult } from "../src/run.js";
import { collectLive } from "../src/live.js";
import { ESCROW, editCallArgs, loadFixture, replayFetch } from "./live_replay.js";

const here = dirname(fileURLToPath(import.meta.url));
const OPTS = { releaseDir: join(here, "..", "..", "..", "resolver", "release"), expectEscrowHash: "f50742358b404ccc7b9a80f9da86e5cd7591e32ccf7371f9e970fbe94ad0b9ed" };

async function run(fx: any, replayOpts: any = {}): Promise<Record<string, CheckResult>> {
  const rp = replayFetch(fx, replayOpts);
  const ev = await collectLive("testnet", ESCROW, 1, { fetch: rp.fetch, sleep: async () => {} });
  return Object.fromEntries(runBetChecks(ev, OPTS).map((r) => [r.id, r]));
}
const show = (r: Record<string, CheckResult>) => Object.values(r).map((x) => `${x.status} ${x.id} ${x.reason}`).join("\n");

test("live (recorded R3e RPC): B2 B3 B5 B6 PASS from tx history; B4 and E4 SKIP; E1 E2 PASS", async () => {
  const r = await run(loadFixture());
  for (const id of ["B2", "B3", "B5", "B6", "E1", "E2"]) assert.equal(r[id].status, "PASS", show(r));
  assert.equal(r.B4.status, "SKIP", show(r));
  assert.match(r.B4.reason, /older resolver|signature_proof|judge\.sources/i);
  assert.equal(r.E4.status, "SKIP");
  assert.doesNotMatch(r.B5.reason, /recorded before\/after balance views/, "live B5 must say it came from receipts");
  assert.match(r.B5.reason, /receipt/i);
});

test("live: tx-indexer pagination (page size 2) and 429 backoff still yield the same PASSes", async () => {
  const r = await run(loadFixture(), { pageSize: 2, fail429: 2 });
  for (const id of ["B2", "B3", "B5", "B6"]) assert.equal(r[id].status, "PASS", show(r));
});

test("tamper: altered payout receipt amount -> B5 FAIL", async () => {
  const fx = loadFixture();
  assert.ok(editCallArgs(fx, "mt_transfer", (a) => { if (a.amount === "1980000") a.amount = "2980000"; }) >= 1);
  const r = await run(fx);
  assert.equal(r.B5.status, "FAIL", show(r));
  assert.equal(r.B3.status, "PASS");
});

test("tamper: swapped outcome signature -> B3 FAIL", async () => {
  const fx = loadFixture();
  assert.equal(editCallArgs(fx, "submit_outcome", (a) => { a.signature_hex = a.signature_hex.replace(/^../, (x: string) => (x === "00" ? "01" : "00")); }) >= 1, true);
  const r = await run(fx);
  assert.equal(r.B3.status, "FAIL", show(r));
  assert.match(r.B3.reason, /signature invalid/);
});

test("tamper: swapped outcome (YES->NO in submitted result) -> B3 FAIL", async () => {
  const fx = loadFixture();
  editCallArgs(fx, "submit_outcome", (a) => { a.result.outcome = "NO"; });
  const r = await run(fx);
  assert.equal(r.B3.status, "FAIL", show(r));
});

test("tamper: finalize executed inside the settlement window -> B6 FAIL", async () => {
  const fx = loadFixture();
  const bet = JSON.parse(Buffer.from(fx.rpc[`call_function|get_bet|{"bet_id":1}`].result).toString());
  const inside = BigInt(bet.proposed_at) + 600_000_000_000n; // 10 min after proposal, window is 1 h
  for (const t of Object.values<any>(fx.transactions)) {
    const fin = t.transaction.actions.some((a: any) => a.FunctionCall?.method_name === "finalize");
    if (!fin) continue;
    for (const rc of t.receipts) if (rc.receipt.receiver_id === ESCROW) rc.execution_outcome.block_timestamp = Number(inside);
  }
  const r = await run(fx);
  assert.equal(r.B6.status, "FAIL", show(r));
  assert.match(r.B6.reason, /before proposed_at \+ settlement_period/);
});

test("tamper: stale attestation (opened >1h after checked_at) -> B2 FAIL", async () => {
  const fx = loadFixture();
  const k = `call_function|get_bet|{"bet_id":1}`;
  const bet = JSON.parse(Buffer.from(fx.rpc[k].result).toString());
  bet.created_at = Number(BigInt("1794014161191825408") + 7200_000_000_000n); // opened 2 h after the attested checked_at
  fx.rpc[k].result = Array.from(Buffer.from(JSON.stringify(bet)));
  const r = await run(fx);
  assert.equal(r.B2.status, "FAIL", show(r));
  assert.match(r.B2.reason, /stale/);
});

test("tamper: attestation checked_at altered in the Open receipt -> B2 FAIL (signature)", async () => {
  const fx = loadFixture();
  editCallArgs(fx, "mt_on_transfer", (a) => { if (a.msg?.includes('"Open"')) { const m = JSON.parse(a.msg); m.attestation.checked_at = m.attestation.checked_at + 1000; a.msg = JSON.stringify(m); } });
  const r = await run(fx);
  assert.equal(r.B2.status, "FAIL", show(r));
});

test("missing history: no submit_outcome / no finalize found -> B3 and B5 SKIP, never PASS", async () => {
  const fx = loadFixture();
  fx.accountTxs = fx.accountTxs.filter((t: any) => fx.transactions[t.transaction_hash] === undefined || !["submit_outcome", "finalize"].some((m) => fx.transactions[t.transaction_hash].transaction.actions.some((a: any) => a.FunctionCall?.method_name === m)));
  const r = await run(fx);
  assert.equal(r.B3.status, "SKIP", show(r));
  assert.equal(r.B5.status, "SKIP", show(r));
});

// L1b10: live2 bet 1 had ONE submit_outcome (run_no 1; on-chain runs_used 1, used_run_nos [1], next_expected_run_no 2),
// yet the verifier printed "run_no 1 out of order (expected 2)". It can only compute "expected 2" by seeing the same
// signed result twice, i.e. the indexer delivered one receipt twice. One receipt delivered twice is not a replay.
const submitTx = (fx: any): [string, any] => {
  const e = Object.entries<any>(fx.transactions).find(([, t]) => t.transaction.actions.some((a: any) => a.FunctionCall?.method_name === "submit_outcome"));
  assert.ok(e, "fixture has a submit_outcome tx");
  return e!;
};

test("L1b10: the SAME submit_outcome receipt delivered twice by the indexer is one run -> B3 PASS", async () => {
  const fx = loadFixture();
  const [, t] = submitTx(fx);
  const rc = t.receipts.find((r: any) => r.receipt.receiver_id === ESCROW && r.receipt.receipt.Action?.actions.some((a: any) => a.FunctionCall?.method_name === "submit_outcome"));
  t.receipts.push(JSON.parse(JSON.stringify(rc)));
  const r = await run(fx);
  assert.equal(r.B3.status, "PASS", show(r));
  assert.match(r.B3.reason, /1 submitted result/);
});

test("L1b10: a genuinely replayed run_no (a SECOND tx/receipt with run_no 1) still -> B3 FAIL out of order", async () => {
  const fx = loadFixture();
  const [h, t] = submitTx(fx);
  const h2 = h.slice(0, -1) + (h.endsWith("A") ? "B" : "A");
  const t2 = JSON.parse(JSON.stringify(t));
  t2.transaction.hash = h2;
  t2.receipts.forEach((r: any, i: number) => { r.receipt.receipt_id = `replay${i}${r.receipt.receipt_id}`; r.execution_outcome.block_timestamp = String(BigInt(r.execution_outcome.block_timestamp) + 5_000_000_000n); });
  fx.transactions[h2] = t2;
  fx.accountTxs.push({ ...fx.accountTxs.find((x: any) => x.transaction_hash === h), transaction_hash: h2 });
  const r = await run(fx);
  assert.equal(r.B3.status, "FAIL", show(r));
  assert.match(r.B3.reason, /run_no 1 out of order \(expected 2\)/);
});
