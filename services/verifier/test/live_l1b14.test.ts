// L1b14: two verifier false FAILs found on live3 (recorded read-only evidence, fixtures/l1b14; offline, no network).
//  B3: run numbers have gaps by design (D-RUNNO1: request_resolution assigns max(next_run_no, next_expected_run_no) and bumps next_run_no;
//      a refused/failed run's callback clears pending_run_no only), so B3 must check against the run_nos the escrow ASSIGNED, not 1..n.
//  E2: the escrow account was DeleteAccount'ed and recreated; E2 must look at the CURRENT incarnation's deploy + new().
// No assertion is loosened to get green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBetChecks, type CheckResult } from "../src/run.js";
import { collectLive } from "../src/live.js";
import { editActions, editCallArgs, loadL1b14, replayFetch } from "./live_replay.js";

const here = dirname(fileURLToPath(import.meta.url));
const RELEASE = join(here, "..", "..", "..", "resolver", "release");
const L3_HASH = "a240f3632e956d5eac45c2965b8fdc85b5b2aa17656d00b37bd2eb3e68afbf97";
const WRONG = "00".repeat(32);

async function run(fx: any, bet: number, expectEscrowHash?: string): Promise<Record<string, CheckResult>> {
  const rp = replayFetch(fx);
  const ev = await collectLive("testnet", fx.escrow, bet, { fetch: rp.fetch, sleep: async () => {} });
  return Object.fromEntries(runBetChecks(ev, { releaseDir: RELEASE, expectEscrowHash }).map((r) => [r.id, r]));
}
const show = (r: Record<string, CheckResult>) => Object.values(r).map((x) => `${x.status} ${x.id} ${x.reason}`).join("\n");
const b64hash = (hex: string) => Buffer.from(hex, "hex").toString("base64");
const submitTx = (fx: any): [string, any] => Object.entries<any>(fx.transactions).find(([, t]) => t.transaction.actions.some((a: any) => a.FunctionCall?.method_name === "submit_outcome"))!;

test("L1b14 B3: live3 bet 2 (run_no 3 after two refused runs 1,2) -> PASS, the gap is by design", async () => {
  const r = await run(loadL1b14("live3_bet2"), 2, L3_HASH);
  assert.equal(r.B3.status, "PASS", show(r));
  assert.match(r.B3.reason, /assigned/);
});

test("L1b14 B3: live2 bet 1 (submitted runs vs refused/failed requests) -> B3 PASS", async () => {
  const r = await run(loadL1b14("live2_bet1"), 1);
  assert.equal(r.B3.status, "PASS", show(r));
});

test("L1b14 B3: a genuinely replayed run_no on live3 (second submit_outcome with run_no 3) -> FAIL", async () => {
  const fx = loadL1b14("live3_bet2");
  const [h, t] = submitTx(fx);
  const h2 = h.slice(0, -1) + (h.endsWith("A") ? "B" : "A");
  const t2 = JSON.parse(JSON.stringify(t));
  t2.transaction.hash = h2;
  t2.receipts.forEach((r: any, i: number) => { r.receipt.receipt_id = `replay${i}${r.receipt.receipt_id}`; r.execution_outcome.block_timestamp = String(BigInt(r.execution_outcome.block_timestamp) + 5_000_000_000n); });
  fx.transactions[h2] = t2;
  fx.accountTxs.push({ ...fx.accountTxs.find((x: any) => x.transaction_hash === h), transaction_hash: h2 });
  const r = await run(fx, 2, L3_HASH);
  assert.equal(r.B3.status, "FAIL", show(r));
  assert.match(r.B3.reason, /run_no 3 out of order \(expected 4\)/);
});

test("L1b14 B3: a submitted run_no the escrow never assigned (7) -> FAIL", async () => {
  const fx = loadL1b14("live3_bet2");
  assert.ok(editCallArgs(fx, "submit_outcome", (a) => { a.result.run_no = 7; }) >= 1);
  const r = await run(fx, 2, L3_HASH);
  assert.equal(r.B3.status, "FAIL", show(r));
  assert.match(r.B3.reason, /run_no 7 .*never assigned/);
});

test("L1b14 B3: submitted run_no assigned earlier but not the pending one (2, while 3 was the latest assignment) -> FAIL", async () => {
  const fx = loadL1b14("live3_bet2");
  assert.ok(editCallArgs(fx, "submit_outcome", (a) => { a.result.run_no = 2; }) >= 1);
  const r = await run(fx, 2, L3_HASH);
  assert.equal(r.B3.status, "FAIL", show(r));
  assert.match(r.B3.reason, /run_no 2 .*assigned run_no 3/);
});

test("L1b14 E2: live3 escrow deleted + recreated: E2 checks the CURRENT incarnation (right attest key) -> PASS", async () => {
  const r = await run(loadL1b14("live3_bet2"), 2, L3_HASH);
  assert.equal(r.E2.status, "PASS", show(r));
  assert.match(r.E2.reason, /current incarnation/);
  assert.equal(r.E1.status, "PASS", show(r));
});

// current incarnation = after the latest CreateAccount: deploy tx H7UW6oFn..., new() tx Ax6Xd9Ra...
const CUR_DEPLOY = "H7UW6oFnSuzWM5KscSNZnJdw7MWGWi5thVNidFZFgPrW";
const CUR_NEW = "Ax6Xd9RauWAqjAvpevfUN4fRvpAEFTAZyVDHZRKoHH5N";

test("L1b14 E2: current incarnation deployed a different code hash -> FAIL", async () => {
  const fx = loadL1b14("live3_bet2");
  assert.equal(editActions(fx, (a, h) => { if (h === CUR_DEPLOY && a.DeployContract) { a.DeployContract.code = b64hash(WRONG); return true; } return false; }) >= 1, true);
  const r = await run(fx, 2, L3_HASH);
  assert.equal(r.E2.status, "FAIL", show(r));
  assert.match(r.E2.reason, /current incarnation.*deploy/);
});

test("L1b14 E2: current incarnation's new() has a wrong attest key while the stale one is right -> FAIL (stale not accepted)", async () => {
  const fx = loadL1b14("live3_bet2");
  let good = "";
  editCallArgs(fx, "new", (a) => { good = good || a.attest_pubkey; }, (h) => h === CUR_NEW);
  assert.match(good, /^b92575a2/);
  assert.ok(editCallArgs(fx, "new", (a) => { a.attest_pubkey = "accc1a8632647620243073c56ab978fa713b7ca446d6b7e21ce7d8d723997a16"; }, (h) => h === CUR_NEW) >= 1);
  assert.ok(editCallArgs(fx, "new", (a) => { a.attest_pubkey = good; }, (h) => h !== CUR_NEW) >= 1); // the stale first incarnation now "looks right"
  const r = await run(fx, 2, L3_HASH);
  assert.equal(r.E2.status, "FAIL", show(r));
  assert.match(r.E2.reason, /attest_pubkey/);
});
