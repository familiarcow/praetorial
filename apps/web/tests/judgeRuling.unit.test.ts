// KEEPSUBMIT1W: the web fallback "Apply the judge's ruling". Pure visibility predicate + exact submit_outcome args.
// The stored raw is what escrow.on_resolution kept; the web forwards result + signature byte for byte (the contract verifies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { planJudgeRuling } from "../lib/judgeRuling";
import { gasForMethod } from "../lib/relayGas";

const CONTRACT = "escrow.testnet";
const SIG = "ab".repeat(64);
const TERMS = "cd".repeat(32);
const raw = (o: { contract?: string; betId?: number; runNo?: number | string; sig?: string | null; checkedUntil?: string; extra?: string } = {}) =>
  `{"contract":"${o.contract ?? CONTRACT}","judge":{"backend":"near-ai"},"notes":[],"result":{"bet_id":${o.betId ?? 7},"checked_until":${o.checkedUntil ?? "1783000000123456789"},"element_results_hash":"${"ee".repeat(32)}","judge_pair_index":0,"outcome":"YES","run_no":${o.runNo ?? 3},"terms_hash":"${TERMS}"${o.extra ?? ""}}${o.sig === null ? "" : `,"signing":{"pubkey_hex":"${"11".repeat(32)}","signature_hex":"${o.sig ?? SIG}"}`}}`;
const bet = (o: Partial<{ status: string; raw: string | null; pending: number | null; used: number[]; terms: string }> = {}) => ({
  status: o.status ?? "Resolving", last_resolution_raw: o.raw === undefined ? raw() : o.raw, pending_run_no: o.pending === undefined ? 3 : o.pending, used_run_nos: o.used ?? [],
  envelope: { terms_hash: o.terms ?? TERMS },
}) as any;

test("signed result for the pending run in Resolving -> ok, args are the stored result + signature", () => {
  const p = planJudgeRuling(CONTRACT, 7, bet());
  assert.equal(p.ok, true);
  if (!p.ok) return;
  assert.equal(p.args.signature_hex, SIG);
  assert.deepEqual(Object.keys(p.args).sort(), ["result", "signature_hex"]);
  assert.deepEqual(p.args.result, { bet_id: 7, checked_until: "1783000000123456789", element_results_hash: "ee".repeat(32), judge_pair_index: 0, outcome: "YES", run_no: 3, terms_hash: TERMS });
});

test("exact passthrough: a u64 above 2^53 keeps every digit; optional fields (next_check_ns, model_not_found) pass through", () => {
  const p = planJudgeRuling(CONTRACT, 7, bet({ raw: raw({ checkedUntil: "1783000000123456789", extra: `,"next_check_ns":"1783000099999999999","model_not_found":[{"model":"m1","observed_ns":"1783000000000000001"}]` }) }));
  assert.equal(p.ok, true);
  if (!p.ok) return;
  assert.equal(p.args.result.checked_until, "1783000000123456789");
  assert.equal(p.args.result.next_check_ns, "1783000099999999999");
  assert.deepEqual(p.args.result.model_not_found, [{ model: "m1", observed_ns: "1783000000000000001" }]);
});

test("the NOKEY1 unsigned error output -> hidden", () => {
  const f = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/escrow/tests/fixtures/nokey1_no_key_output.json"), "utf8");
  const p = planJudgeRuling(CONTRACT, 7, bet({ raw: f }));
  assert.equal(p.ok, false);
});

test("unsigned result (no signing block) -> hidden", () => assert.equal(planJudgeRuling(CONTRACT, 7, bet({ raw: raw({ sig: null }) })).ok, false));
test("bad signature shape (not 128 hex) -> hidden", () => assert.equal(planJudgeRuling(CONTRACT, 7, bet({ raw: raw({ sig: "zz" }) })).ok, false));

test("malformed / truncated / empty / null raw -> hidden", () => {
  for (const r of [raw().slice(0, 60), "not json", "", null, "[]", "null", "{\"result\":5}"]) assert.equal(planJudgeRuling(CONTRACT, 7, bet({ raw: r })).ok, false, String(r));
});

test("run_no mismatch with pending_run_no, no pending run, or run already used -> hidden", () => {
  assert.equal(planJudgeRuling(CONTRACT, 7, bet({ pending: 4 })).ok, false);
  assert.equal(planJudgeRuling(CONTRACT, 7, bet({ pending: null })).ok, false);
  assert.equal(planJudgeRuling(CONTRACT, 7, bet({ used: [3] })).ok, false);
});

test("any state other than Resolving -> hidden", () => {
  for (const s of ["Open", "Taken", "Proposed", "Challenged", "Evidence", "Rejudge", "Finalized", "Settled", "Voided", "Cancelled", "Expired"]) assert.equal(planJudgeRuling(CONTRACT, 7, bet({ status: s })).ok, false, s);
});

test("raw for another bet, another contract, or other terms -> hidden", () => {
  assert.equal(planJudgeRuling(CONTRACT, 8, bet()).ok, false);
  assert.equal(planJudgeRuling("other.testnet", 7, bet()).ok, false);
  assert.equal(planJudgeRuling(CONTRACT, 7, bet({ terms: "00".repeat(32) })).ok, false);
});

test("submit_outcome takes no deposit (not payable in the contract) and has a gas entry", () => {
  const rs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/escrow/src/lib.rs"), "utf8");
  const i = rs.indexOf("pub fn submit_outcome(");
  assert.ok(i > 0);
  assert.ok(!/#\[payable\]\s*$/.test(rs.slice(Math.max(0, i - 400), i).trimEnd().split("\n").slice(-12).join("\n").replace(/\/\/\/.*\n/g, "")), "submit_outcome must not be #[payable]");
  assert.equal(gasForMethod("submit_outcome"), 300);
});
