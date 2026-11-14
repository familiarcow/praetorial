// DR2 phase 2 "already settled: verify-only" (RED first). The keeper finalized bet 35 before the harness fetched ESPN truth, so the harness
// must (a) record the ordering honestly, (b) reconstruct who sent each tx, (c) explain every run from chain data, (d) compare chain vs ESPN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groundTruthRecord, classifyTxs, explainRuns, compareOutcome, type ChainTx } from "../verifyOnly.js";

const truth = { id: "401909960", outcome: "YES" as const, rawSha256: "ab".repeat(32), final: true, reason: "final score", pick_team_abbr: "NY", home: { team: "MIL", score: 85 }, away: { team: "NY", score: 117 }, winner: "NY" };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const tx = (hash: string, signer: string, method: string, args: unknown, logs: string[] = []): ChainTx => ({ hash, signer, method, argsB64: b64(args), tsNs: "1", logs });
const keeper = "keeper.praetorial-dev-1101.testnet";
const ctx = { betId: 35, keeper, taker: "tk", maker: "mk" };
const history: ChainTx[] = [
  tx("R1", keeper, "request_resolution", { bet_id: 35 }),
  tx("S1", keeper, "submit_outcome", { result: { bet_id: 35, run_no: 1, outcome: "RETRY", next_check_ns: "5" }, signature_hex: "x" }, ["submit_outcome RETRY bet_id=35 retry_count=1 next_check_ns=5"]),
  tx("R2", keeper, "request_resolution", { bet_id: 35 }),
  tx("S2", keeper, "submit_outcome", { result: { bet_id: 35, run_no: 2, outcome: "YES" }, signature_hex: "y" }),
  tx("X", keeper, "request_resolution", { bet_id: 34 }),
  tx("F", keeper, "finalize", { bet_id: 35 }),
];

test("ground truth written after settlement says so: outcome_read_before_this true, never fake ordering", () => {
  const g = groundTruthRecord(truth, { betId: 35, fetchedAtIso: "2026-11-11T15:30:00Z", chainOutcomeAtFetch: "YES", proposedAtNs: "1794372092553553208" });
  assert.equal(g.outcome_read_before_this, true);
  assert.match(g.ordering_note, /already Settled/);
  assert.equal(g.outcome, "YES"); assert.equal(g.raw_sha256, truth.rawSha256);
  const pre = groundTruthRecord(truth, { betId: 35, fetchedAtIso: "t", chainOutcomeAtFetch: null, proposedAtNs: null });
  assert.equal(pre.outcome_read_before_this, false);
});

test("tx classification: only this bet's request/submit/finalize, with sender role (keeper/web/taker/maker/other)", () => {
  const rows = classifyTxs(history, ctx);
  assert.deepEqual(rows.map((r) => [r.method, r.hash, r.by, r.webDriven]), [
    ["request_resolution", "R1", "keeper", false], ["submit_outcome", "S1", "keeper", false],
    ["request_resolution", "R2", "keeper", false], ["submit_outcome", "S2", "keeper", false], ["finalize", "F", "keeper", false]]);
  const t = classifyTxs([tx("T", "tk", "request_resolution", { bet_id: 35 })], ctx);
  assert.deepEqual([t[0].by, t[0].webDriven], ["taker", true]);
});

test("run explanation: a RETRY run consumes a run number but is absent from all_results; audit flag is detected separately", () => {
  const rows = classifyTxs(history, ctx);
  const e = explainRuns(rows, { used_run_nos: [1, 2], all_results: [{ run_no: 2, outcome: "YES" }], last_resolution_raw: JSON.stringify({ notes: ["17c5 audit agrees with the code outcome YES"], judge: { run_diagnostics: [{ content: '{"audit":"agree"}' }] } }) });
  assert.deepEqual(e.runs.map((r) => [r.run_no, r.outcome, r.in_all_results]), [[1, "RETRY", false], [2, "YES", true]]);
  assert.equal(e.auditFlag, false);
  const f = explainRuns(rows, { used_run_nos: [1, 2], all_results: [], last_resolution_raw: JSON.stringify({ judge: { judge_ran: false, run_diagnostics: [{ content: '{"audit":"flag"}' }] } }) });
  assert.equal(f.auditFlag, true);
});

test("outcome vs ESPN truth: YES==YES ok; mismatch is a WRONG-WINNER", () => {
  assert.deepEqual(compareOutcome("YES", "YES"), { match: true, wrongWinner: false });
  assert.deepEqual(compareOutcome("NO", "YES"), { match: false, wrongWinner: true });
  assert.deepEqual(compareOutcome("VOID", "YES"), { match: false, wrongWinner: false });
});
