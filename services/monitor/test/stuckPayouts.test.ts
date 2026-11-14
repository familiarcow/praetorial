// RED-first (MON1 stuck payouts / PREMAIN1 MAINNET-RISK #1): a payout line that stays `in_flight` has no timeout in the
// frozen escrow (if on_payout_result ever ran out of gas the line is wedged forever: no retry, no refund). The monitor
// must raise ONE critical alert per wedged line (bet id, asset, amount) once it has been seen in flight longer than the
// threshold. Real-shape fixture: a recorded keyless `pending_payouts_view({from:0,limit:500})` RPC answer from the frz3
// testnet escrow (block 277128728, 53 lines, all done); no network is touched here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { PendingPayout } from "@praetorial/common/types.js";
import {
  DEFAULT_STUCK_PAYOUT_THRESHOLD_MS,
  PAYOUT_SCAN_PAGE,
  StuckPayoutTracker,
  alertForPayoutsUnchecked,
  scanUndonePayouts,
} from "../src/stuckPayouts.js";
import { createAlertRunnerState, runAlertTick, type AlertSnapshotProvider } from "../src/runner.js";
import type { Alert } from "../src/alerts.js";

const ESCROW = "praetorial-frz3-2611100414.praetorial-dev-1101.testnet";
const MIN_NS = 60_000_000_000;
const rpcAnswer = JSON.parse(fs.readFileSync(new URL("./fixtures/pending_payouts_view.frz3.testnet.json", import.meta.url), "utf8"));
/** Decodes the recorded call_function answer exactly as the NEAR view client does (result = utf8 JSON bytes). */
const realRows = (): PendingPayout[] => JSON.parse(new TextDecoder().decode(Uint8Array.from(rpcAnswer.result.result as number[])));

/** A view client over a dense, never-pruned id space, answering pending_payouts_view like lib.rs:5411. */
function ledgerClient(rows: PendingPayout[]) {
  const calls: { from: number; limit: number }[] = [];
  return {
    calls,
    async view<T>(contract: string, method: string, args: any): Promise<T> {
      assert.equal(contract, ESCROW); assert.equal(method, "pending_payouts_view");
      calls.push(args);
      const from = Math.max(1, args.from);
      return rows.filter((r) => r.id >= from).sort((a, b) => a.id - b.id).slice(0, args.limit) as T;
    },
  };
}
const line = (id: number, over: Partial<PendingPayout> = {}): PendingPayout => ({
  id, bet_id: 10 + id, token_id: "nep141:wrap.testnet", receiver: `r${id}.testnet`, amount: `${id}000000000000000000000000`,
  reason: "payout_winner", attempts: 1, done: true, in_flight: false, ...over,
});

test("threshold: 10 minutes (frz3 drain_payouts -> on_payout_result measured at 3 blocks / <2 s; ~300x margin)", () => {
  assert.equal(DEFAULT_STUCK_PAYOUT_THRESHOLD_MS, 10 * 60_000);
});

test("real frz3 fixture: rows have the contract's shape; scanning it gives no in-flight line and advances past the all-done prefix", async () => {
  const rows = realRows();
  assert.equal(rows.length, 53);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ["amount", "attempts", "bet_id", "done", "id", "in_flight", "reason", "receiver", "token_id"]);
    assert.equal(typeof r.in_flight, "boolean"); assert.equal(typeof r.amount, "string");
  }
  const scan = await scanUndonePayouts(ledgerClient(rows), ESCROW, 0);
  assert.equal(scan.complete, true);
  assert.deepEqual(scan.undone, []);
  assert.equal(scan.nextFrom, 54, "every line 1..53 is done, so the next scan starts after them");
  const tr = new StuckPayoutTracker(DEFAULT_STUCK_PAYOUT_THRESHOLD_MS * 1e6);
  assert.deepEqual(tr.tick(ESCROW, scan.undone, 0), []);
});

test("real frz3 fixture with one line wedged in flight -> one CRITICAL alert after 10 min with bet id, asset and amount; never again", async () => {
  const rows = realRows();
  const wedged = { ...rows[1]!, done: false, in_flight: true }; // bet 5, nep141:wrap.testnet, 2864130434782608695652174
  rows[1] = wedged;
  const client = ledgerClient(rows);
  const tr = new StuckPayoutTracker(DEFAULT_STUCK_PAYOUT_THRESHOLD_MS * 1e6);
  let from = 0; const sent: Alert[] = [];
  for (let m = 0; m <= 30; m++) {
    const scan = await scanUndonePayouts(client, ESCROW, from);
    from = scan.nextFrom;
    const out = tr.tick(ESCROW, scan.undone, m * MIN_NS);
    if (m < 10) assert.deepEqual(out, [], `no alert at minute ${m}`);
    sent.push(...out);
  }
  assert.equal(from, wedged.id, "the scan keeps re-reading from the oldest undone line");
  assert.equal(sent.length, 1, "exactly once per wedged line");
  const a = sent[0]!;
  assert.equal(a.severity, "critical"); assert.equal(a.kind, "payout_stuck_in_flight");
  for (const s of [`bet ${wedged.bet_id}`, wedged.token_id, wedged.amount]) assert.ok(a.message.includes(s), `message lacks ${s}: ${a.message}`);
  for (const s of [`payout id=${wedged.id}`, `receiver=${wedged.receiver}`, `attempts=${wedged.attempts}`]) assert.ok(a.detail.includes(s), `detail lacks ${s}: ${a.detail}`);
  assert.match(a.key, new RegExp(`^payout_stuck_in_flight:${ESCROW}:${wedged.id}:${wedged.attempts}$`));
});

test("a normal payout (in flight for one tick, then done) never alerts; nor does a line that is merely pending (not in flight)", () => {
  const tr = new StuckPayoutTracker(10 * MIN_NS);
  assert.deepEqual(tr.tick(ESCROW, [line(1, { done: false, in_flight: true })], 0), []);
  assert.deepEqual(tr.tick(ESCROW, [], 1 * MIN_NS), []); // done -> no longer in the undone set
  assert.deepEqual(tr.tick(ESCROW, [line(1, { done: false, in_flight: true })], 20 * MIN_NS), [], "a fresh in-flight sighting restarts the clock");
  const pend = new StuckPayoutTracker(10 * MIN_NS);
  for (let m = 0; m < 60; m += 5) assert.deepEqual(pend.tick(ESCROW, [line(2, { done: false, in_flight: false })], m * MIN_NS), []);
});

test("threshold boundary: alert exactly when observed age reaches the threshold, not a tick before", () => {
  const tr = new StuckPayoutTracker(10 * MIN_NS);
  const l = line(3, { done: false, in_flight: true });
  assert.deepEqual(tr.tick(ESCROW, [l], 0), []);
  assert.deepEqual(tr.tick(ESCROW, [l], 10 * MIN_NS - 1), []);
  assert.equal(tr.tick(ESCROW, [l], 10 * MIN_NS).length, 1);
});

test("a retried line (attempts changed) that wedges again is a NEW entry and alerts again; two wedged lines alert separately", () => {
  const tr = new StuckPayoutTracker(10 * MIN_NS);
  const a1 = line(4, { done: false, in_flight: true, attempts: 1 }), b = line(5, { done: false, in_flight: true });
  tr.tick(ESCROW, [a1, b], 0);
  const first = tr.tick(ESCROW, [a1, b], 10 * MIN_NS);
  assert.deepEqual(first.map((x) => x.key).sort(), [`payout_stuck_in_flight:${ESCROW}:4:1`, `payout_stuck_in_flight:${ESCROW}:5:1`]);
  assert.deepEqual(tr.tick(ESCROW, [a1, b], 11 * MIN_NS), []);
  const a2 = { ...a1, attempts: 2 };
  assert.deepEqual(tr.tick(ESCROW, [a2, b], 12 * MIN_NS), []);
  assert.deepEqual(tr.tick(ESCROW, [a2, b], 22 * MIN_NS).map((x) => x.key), [`payout_stuck_in_flight:${ESCROW}:4:2`]);
});

test("tracker state survives export/import (Worker restarts never reset the clock nor re-send)", () => {
  const tr = new StuckPayoutTracker(10 * MIN_NS);
  const l = line(6, { done: false, in_flight: true });
  tr.tick(ESCROW, [l], 0);
  const tr2 = new StuckPayoutTracker(10 * MIN_NS); tr2.importState(JSON.parse(JSON.stringify(tr.exportState())));
  assert.equal(tr2.tick(ESCROW, [l], 10 * MIN_NS).length, 1);
  const tr3 = new StuckPayoutTracker(10 * MIN_NS); tr3.importState(JSON.parse(JSON.stringify(tr2.exportState())));
  assert.deepEqual(tr3.tick(ESCROW, [l], 40 * MIN_NS), []);
});

test("scan pages through the whole ledger past one page (the ids are dense and never pruned) and finds an in-flight line beyond id 500", async () => {
  const rows: PendingPayout[] = [];
  for (let id = 1; id <= PAYOUT_SCAN_PAGE * 2 + 7; id++) rows.push(line(id));
  const far = PAYOUT_SCAN_PAGE * 2 + 3;
  rows[far - 1] = line(far, { done: false, in_flight: true });
  const client = ledgerClient(rows);
  const scan = await scanUndonePayouts(client, ESCROW, 0);
  assert.equal(scan.complete, true);
  assert.deepEqual(scan.undone.map((p) => p.id), [far]);
  assert.equal(scan.nextFrom, far);
  assert.equal(client.calls.length, 3);
  const again = await scanUndonePayouts(client, ESCROW, scan.nextFrom);
  assert.deepEqual(again.undone.map((p) => p.id), [far]);
  assert.equal(client.calls.length, 4, "the next scan starts at the oldest undone line: one page");
});

test("scan is bounded per tick (maxPages) and reports incomplete instead of pretending all is fine", async () => {
  const rows: PendingPayout[] = [];
  for (let id = 1; id <= PAYOUT_SCAN_PAGE * 3; id++) rows.push(line(id, { done: false }));
  const scan = await scanUndonePayouts(ledgerClient(rows), ESCROW, 0, 2);
  assert.equal(scan.complete, false);
  assert.equal(scan.undone.length, PAYOUT_SCAN_PAGE * 2);
  assert.equal(scan.nextFrom, 1);
});

test("runAlertTick: provider in-flight hook -> one CRITICAL payout_stuck_in_flight; RPC failure -> distinct 'cannot check' warning, never OK", async () => {
  const wedged = line(7, { done: false, in_flight: true, bet_id: 42, token_id: "nep141:usdc.testnet", amount: "2500000" });
  let fail = false;
  const provider: AlertSnapshotProvider = {
    contractId: ESCROW,
    fetchInvariantResults: async () => new Map(), fetchDueActions: async () => [], fetchRpcStats: async () => ({ total: 0, errors: 0 }),
    fetchContractState: async () => ({ paused: false, shutdown: false }),
    fetchUndonePayouts: async () => { if (fail) throw new Error("rpc down"); return { undone: [wedged], complete: true }; },
  };
  const state = createAlertRunnerState({ stallGraceNs: MIN_NS, cooldownNs: 30 * MIN_NS, stuckPayoutThresholdNs: 10 * MIN_NS });
  const sent: Alert[] = []; const ch = { async send(a: Alert) { sent.push(a); } };
  for (let m = 0; m <= 70; m++) await runAlertTick(provider, state, ch, m * MIN_NS);
  const stuck = sent.filter((a) => a.kind === "payout_stuck_in_flight");
  assert.equal(stuck.length, 1, "once per entry even across cooldown windows");
  assert.equal(stuck[0]!.severity, "critical");
  assert.ok(stuck[0]!.message.includes("bet 42") && stuck[0]!.message.includes("nep141:usdc.testnet") && stuck[0]!.message.includes("2500000"));
  fail = true;
  const out = await runAlertTick(provider, state, ch, 80 * MIN_NS);
  assert.deepEqual(out.map((a) => [a.kind, a.severity]), [["payout_stuck_in_flight_unchecked", "warning"]]);
  assert.deepEqual(alertForPayoutsUnchecked(ESCROW, new Error("x")).kind, "payout_stuck_in_flight_unchecked");
});

test("runAlertTick: an incomplete scan still alerts on what it saw AND raises the unchecked warning", async () => {
  const wedged = line(8, { done: false, in_flight: true });
  const provider: AlertSnapshotProvider = {
    contractId: ESCROW,
    fetchInvariantResults: async () => new Map(), fetchDueActions: async () => [], fetchRpcStats: async () => ({ total: 0, errors: 0 }),
    fetchContractState: async () => ({ paused: false, shutdown: false }),
    fetchUndonePayouts: async () => ({ undone: [wedged], complete: false }),
  };
  const state = createAlertRunnerState({ stallGraceNs: MIN_NS, cooldownNs: 30 * MIN_NS, stuckPayoutThresholdNs: 10 * MIN_NS });
  const sent: Alert[] = []; const ch = { async send(a: Alert) { sent.push(a); } };
  await runAlertTick(provider, state, ch, 0);
  await runAlertTick(provider, state, ch, 10 * MIN_NS);
  assert.deepEqual(sent.map((a) => a.kind).sort(), ["payout_stuck_in_flight", "payout_stuck_in_flight_unchecked"]);
});

test("default runner state uses the 10-minute threshold", () => {
  const s = createAlertRunnerState({ stallGraceNs: 1, cooldownNs: 1 });
  assert.equal(s.stuckPayouts.thresholdNs, DEFAULT_STUCK_PAYOUT_THRESHOLD_MS * 1e6);
});
