// JC1y: the evidence collectors (live + offline) populate `governance`, and E1 FAILS (never silently skips) when a
// post-JC1x contract's evidence lacks it. "Post-JC1x" is decided by the evidence itself: new() args carrying judge_chain.
// Pre-JC1x evidence (R3e, l1b14) is never edited and must still verify.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvidenceDir, runBetChecks, type Evidence } from "../src/run.js";
import { collectLive } from "../src/live.js";
import { editCallArgs, loadL1b14, replayFetch } from "./live_replay.js";

const here = dirname(fileURLToPath(import.meta.url));
const R3E = join(here, "..", "..", "e2e", "live-runR3e");
const RELEASE = join(here, "..", "..", "..", "resolver", "release");
const PAIR = { model_a: "m/a", model_b: "m/b" };
const PAIR2 = { model_a: "m/c", model_b: "m/d" };
const e = (event: string, data: any) => `EVENT_JSON:${JSON.stringify({ standard: "praetorial-escrow", version: "1.0.0", event, data: [data] })}`;
const E1 = (ev: Evidence) => runBetChecks(ev, { releaseDir: RELEASE }).find((r) => r.id === "E1")!;

/** A copy of the R3e dir whose results.json new_args are post-JC1x (judge_chain + guardian); the original is untouched. */
function postJc1xDir(withGovernance?: object): string {
  const d = mkdtempSync(join(tmpdir(), "jc1y-"));
  cpSync(R3E, d, { recursive: true });
  const res = JSON.parse(readFileSync(join(d, "results.json"), "utf8"));
  res.recreated.new_args = { ...res.recreated.new_args, guardian: res.recreated.new_args.guardian ?? "g.testnet", judge_chain: [PAIR, PAIR2] };
  writeFileSync(join(d, "results.json"), JSON.stringify(res));
  if (withGovernance) writeFileSync(join(d, "governance.json"), JSON.stringify(withGovernance));
  return d;
}

test("pre-JC1x R3e evidence (no judge_chain in new()) still loads with no governance and E1 does not fail", () => {
  const ev = loadEvidenceDir(R3E);
  assert.equal(ev.governance, undefined);
  assert.notEqual(E1(ev).status, "FAIL", E1(ev).reason);
});

test("E1 FAILS (not skip) for post-JC1x evidence whose governance is missing", () => {
  const ev = loadEvidenceDir(postJc1xDir());
  assert.equal(ev.governance, undefined);
  const r = E1(ev);
  assert.equal(r.status, "FAIL", r.reason);
  assert.match(r.reason, /governance/i);
});

test("offline: governance.json beside the evidence populates governance (initial from new() args) and E1 replays it", () => {
  const logs = [e("judge_pair_proposed", { ...PAIR2, proposed_at_ns: 1, effective_at_ns: 2 })];
  const ev = loadEvidenceDir(postJc1xDir({ logs }));
  assert.deepEqual(ev.governance!.initial.chain, [PAIR, PAIR2]);
  assert.deepEqual(govLines(ev), logs);
  assert.notEqual(E1(ev).status, "FAIL", E1(ev).reason);
});

test("E1 FAILS on offline governance whose log replays to a problem (unproposed guardian rotation)", () => {
  const ev = loadEvidenceDir(postJc1xDir({ logs: [e("guardian_rotated", { old_guardian: "g.testnet", guardian: "evil.testnet" })] }));
  const r = E1(ev);
  assert.equal(r.status, "FAIL", r.reason);
});

test("E1 passes a correct post-JC1x evidence with propose+apply of a chain pair and an asset (replay agrees)", () => {
  const ap = { token_id: "eth", limit: { min_per_side: "1" }, reenable: false, proposed_at_ns: 5, effective_at_ns: 5 + 86_400_000_000_000 };
  const logs = [e("asset_proposed", ap), e("asset_applied", ap)];
  const ev = loadEvidenceDir(postJc1xDir({ logs }));
  const r = E1(ev);
  assert.notEqual(r.status, "FAIL", r.reason);
});

// ---- live collector (recorded fixtures only)
const NEW_TX = (fx: any) => Object.values<any>(fx.transactions).find((t) => t.receipts.some((r: any) => (r.receipt.receipt.Action?.actions ?? []).some((a: any) => a.FunctionCall?.method_name === "new")))!;
function postFixture(extraLogs: string[], failedLogs: string[] = []) {
  const fx = loadL1b14("live3_bet2");
  assert.ok(editCallArgs(fx, "new", (a) => { a.judge_chain = [PAIR, PAIR2]; a.guardian = a.guardian ?? "g.testnet"; }) >= 1);
  const isCall = (r: any, m: string) => (r.receipt.receipt.Action?.actions ?? []).some((a: any) => a.FunctionCall?.method_name === m);
  const all = Object.values<any>(fx.transactions).flatMap((t) => t.receipts);
  const okRc = all.find((r: any) => isCall(r, "new"));
  okRc.execution_outcome.outcome.logs = [...(okRc.execution_outcome.outcome.logs ?? []), ...extraLogs];
  if (failedLogs.length) { // a later escrow receipt that FAILED but (as the runtime allows) still carries logs
    const bad = all.find((r: any) => r !== okRc && r.receipt.receiver_id === fx.escrow && isCall(r, "request_resolution"))!;
    bad.execution_outcome.outcome.logs = [...failedLogs];
    bad.execution_outcome.outcome.status = { Failure: { ActionError: { index: 0, kind: "x" } } };
  }
  return fx;
}
const govLines = (ev: Evidence) => ev.governance!.logs.filter((l) => l.startsWith("EVENT_JSON:"));
const collect = (fx: any) => collectLive("testnet", fx.escrow, 2, { fetch: replayFetch(fx).fetch, sleep: async () => {} });

test("live: collectLive populates governance (initial guardian + chain from new(), successful receipts' logs)", async () => {
  const logs = [e("judge_pair_proposed", { ...PAIR2, proposed_at_ns: 1, effective_at_ns: 2 })];
  const ev = await collect(postFixture(logs));
  assert.ok(ev.governance, "governance populated");
  assert.deepEqual(ev.governance!.initial.chain, [PAIR, PAIR2]);
  assert.deepEqual(govLines(ev), logs);
});

test("live: logs of a FAILED receipt are not collected into governance (D-JCD1 #5)", async () => {
  const good = [e("judge_pair_proposed", { ...PAIR2, proposed_at_ns: 1, effective_at_ns: 2 })];
  const ev = await collect(postFixture(good, [e("guardian_rotated", { old_guardian: "g.testnet", guardian: "evil" })]));
  assert.deepEqual(govLines(ev), good, "only the successful receipt's governance log is collected");
});

test("live: pre-JC1x history (no judge_chain in new()) leaves governance undefined", async () => {
  const fx = loadL1b14("live3_bet2");
  const ev = await collect(fx);
  assert.equal(ev.governance, undefined);
});
