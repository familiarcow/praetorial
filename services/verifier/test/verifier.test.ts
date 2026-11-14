// V1 / D-VERIFY1: verify-bet on the recorded R3e evidence (offline) -> checks PASS;
// tampered copies -> that check FAILS. No assertion is ever loosened to get green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadEvidenceDir, runBetChecks, type CheckResult } from "../src/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const R3E = join(here, "..", "..", "e2e", "live-runR3e");
const RELEASE = join(here, "..", "..", "..", "resolver", "release");
// Recorded escrow build claims (results.json summary): plain build and the stripped build actually deployed.
const ESCROW_HASH = "f50742358b404ccc7b9a80f9da86e5cd7591e32ccf7371f9e970fbe94ad0b9ed";

const FILES = ["results.json", "raw_resolution.txt", "terms.json", "results_finalize.json", "sourcecheck.log", "escrow_name.txt", "outcome_pubkey.txt"];

function copyEvidence(): string {
  const d = mkdtempSync(join(tmpdir(), "verifier-r3e-"));
  for (const f of FILES) cpSync(join(R3E, f), join(d, f));
  return d;
}
function editJson(dir: string, file: string, fn: (j: any) => void): void {
  const p = join(dir, file);
  const j = JSON.parse(readFileSync(p, "utf8"));
  fn(j);
  writeFileSync(p, JSON.stringify(j, null, 1));
}
function run(dir: string, extra: Record<string, unknown> = {}): Record<string, CheckResult> {
  const ev = loadEvidenceDir(dir);
  const res = runBetChecks(ev, { releaseDir: RELEASE, expectEscrowHash: ESCROW_HASH, ...extra });
  return Object.fromEntries(res.map((r) => [r.id, r]));
}
function expectFail(r: Record<string, CheckResult>, id: string) {
  assert.equal(r[id].status, "FAIL", `${id} should FAIL, got ${r[id].status}: ${r[id].reason}`);
}

test("R3e recorded evidence: every check that can run offline PASSes, none FAIL", () => {
  const r = run(R3E);
  for (const id of ["E1", "E2", "E3", "B1", "B2", "B3", "B5", "B6"] as const) {
    if (id === "E3") continue; // wasm bytes are not in the fixture; asserted SKIP below
    assert.equal(r[id].status, "PASS", `${id}: ${r[id].reason}`);
  }
  assert.equal(r.E3.status, "SKIP");
  assert.match(r.E3.reason, /wasm/i);
  assert.equal(r.E4.status, "SKIP");
  assert.match(r.E4.reason, /offline/i);
  assert.ok(r.B4.status !== "FAIL", `B4: ${r.B4.reason}`);
  assert.equal(Object.values(r).filter((x) => x.status === "FAIL").length, 0);
  assert.deepEqual(Object.keys(r).sort(), ["B1", "B2", "B3", "B4", "B5", "B6", "E1", "E2", "E3", "E4"]);
});

test("B1 tamper: edited terms -> FAIL", () => {
  const d = copyEvidence();
  writeFileSync(join(d, "terms.json"), readFileSync(join(d, "terms.json"), "utf8").replace("70 degrees", "60 degrees"));
  expectFail(run(d), "B1");
});

test("B1 with --terms override: other file with different bytes -> FAIL, same bytes -> PASS", () => {
  const d = copyEvidence();
  const other = join(d, "other.json");
  writeFileSync(other, "{}");
  expectFail(run(d, { termsPath: other }), "B1");
  assert.equal(run(d, { termsPath: join(R3E, "terms.json") }).B1.status, "PASS");
});

test("B2 tamper: wrong pinned attest pubkey -> FAIL", () => {
  const d = copyEvidence();
  editJson(d, "results.json", (j) => { j.recreated.views.resolver_keys[1] = "00".repeat(32); });
  expectFail(run(d), "B2");
});

test("B2 tamper: altered attestation signature -> FAIL", () => {
  const d = copyEvidence();
  const p = join(d, "sourcecheck.log");
  const t = readFileSync(p, "utf8");
  writeFileSync(p, t.replace('"signature_hex": "bc34', '"signature_hex": "bd34'));
  expectFail(run(d), "B2");
});

test("B2 tamper: stale attestation (checked_at > 1h before open) -> FAIL", () => {
  const d = copyEvidence();
  editJson(d, "results.json", (j) => { j.bet_after_request.created_at = 1794014161191825408 + 3601e9; });
  expectFail(run(d), "B2");
});

test("B3 tamper: flipped outcome -> FAIL", () => {
  const d = copyEvidence();
  const p = join(d, "raw_resolution.txt");
  const j = JSON.parse(readFileSync(p, "utf8"));
  j.result.outcome = "NO";
  writeFileSync(p, JSON.stringify(j));
  const r = run(d);
  expectFail(r, "B3");
});

test("B3 tamper: wrong pinned outcome pubkey -> FAIL", () => {
  const d = copyEvidence();
  editJson(d, "results.json", (j) => { j.recreated.views.resolver_keys[0] = "11".repeat(32); });
  expectFail(run(d), "B3");
});

test("B3 tamper: result.terms_hash differs from envelope.terms_hash -> FAIL", () => {
  const d = copyEvidence();
  editJson(d, "results.json", (j) => { j.bet_after_request.envelope.terms_hash = "ab".repeat(32); });
  expectFail(run(d), "B3");
});

test("B3 tamper: run_no out of order (starts at 2) -> FAIL", () => {
  const d = copyEvidence();
  const p = join(d, "raw_resolution.txt");
  const j = JSON.parse(readFileSync(p, "utf8"));
  j.result.run_no = 2;
  writeFileSync(p, JSON.stringify(j));
  expectFail(run(d), "B3");
});

test("B4 tamper: flipped element verdict (decision rule gives NO, result says YES) -> FAIL", () => {
  const d = copyEvidence();
  const p = join(d, "raw_resolution.txt");
  const j = JSON.parse(readFileSync(p, "utf8"));
  j.judge.elements[0].verdict = "not_met";
  writeFileSync(p, JSON.stringify(j));
  expectFail(run(d), "B4");
});

test("B4 tamper: altered quote in a model answer (content_sha256 no longer matches) -> FAIL", () => {
  const d = copyEvidence();
  const p = join(d, "raw_resolution.txt");
  const j = JSON.parse(readFileSync(p, "utf8"));
  j.judge.run_diagnostics[1].content_head = j.judge.run_diagnostics[1].content_head.replace("MAXIMUM 72", "MAXIMUM 82");
  writeFileSync(p, JSON.stringify(j));
  expectFail(run(d), "B4");
});

test("B4 tamper: a model answer that failed NEAR AI signature verification -> FAIL", () => {
  const d = copyEvidence();
  const p = join(d, "raw_resolution.txt");
  const j = JSON.parse(readFileSync(p, "utf8"));
  j.judge.run_diagnostics[0].signature_verified = false;
  writeFileSync(p, JSON.stringify(j));
  expectFail(run(d), "B4");
});

test("B5 tamper: wrong payout (winner paid pot, no fee) -> FAIL", () => {
  const d = copyEvidence();
  editJson(d, "results_finalize.json", (j) => { j.after.balances.maker = "3883848000"; });
  expectFail(run(d), "B5");
});

test("B5 tamper: winner is the wrong side -> FAIL", () => {
  const d = copyEvidence();
  editJson(d, "results_finalize.json", (j) => { j.after.balances.maker = "3881848000"; j.after.balances.taker = "3709347000"; });
  expectFail(run(d), "B5");
});

test("B5 tamper: escrow residue not 0 -> FAIL", () => {
  const d = copyEvidence();
  editJson(d, "results_finalize.json", (j) => { j.after.balances.escrow = "5"; });
  expectFail(run(d), "B5");
});

test("B5 tamper: pending payouts not zero -> FAIL", () => {
  const d = copyEvidence();
  editJson(d, "results_finalize.json", (j) => { j.after.pending_not_done = 1; });
  expectFail(run(d), "B5");
});

test("B6 tamper: finalize before the settlement window ended -> FAIL", () => {
  const d = copyEvidence();
  editJson(d, "results_finalize.json", (j) => { j.before.ts = "2026-11-07T02:29:00.000Z"; });
  expectFail(run(d), "B6");
});

test("B6 tamper: resolution submitted before funding_deadline -> FAIL", () => {
  const d = copyEvidence();
  editJson(d, "results.json", (j) => { j.bet_after_submit.proposed_at_ns = 1794014000000000000; });
  expectFail(run(d), "B6");
});

test("E1: deployed code hash must equal the expected build hash", () => {
  assert.equal(run(R3E).E1.status, "PASS");
  expectFail(run(R3E, { expectEscrowHash: "00".repeat(32) }), "E1");
});

test("E1 without an expected hash -> SKIP (never a silent PASS)", () => {
  const r = run(R3E, { expectEscrowHash: undefined });
  assert.equal(r.E1.status, "SKIP");
});

test("E2 tamper: pinned resolver_wasm_hash has no release record -> FAIL", () => {
  const d = copyEvidence();
  editJson(d, "results.json", (j) => { j.recreated.views.resolver_keys[2] = "22".repeat(32); });
  expectFail(run(d), "E2");
});

test("E2 tamper: pinned outcome_pubkey differs from new() args -> FAIL", () => {
  const d = copyEvidence();
  editJson(d, "results.json", (j) => { j.recreated.new_args.outcome_pubkey = "33".repeat(32); });
  expectFail(run(d), "E2");
});

test("E2 tamper: outlayer_config view differs from new() args -> FAIL", () => {
  const d = copyEvidence();
  editJson(d, "results.json", (j) => { j.recreated.views.outlayer_config.wasm_base_url = "https://evil.example/x"; });
  expectFail(run(d), "E2");
});

test("E3: wasm file hashing to the pin PASSes; one swapped byte FAILs", () => {
  const dir = copyEvidence();
  const wasm = Buffer.from("\0asm-test-resolver-bytes-" + "x".repeat(1000));
  const pin = createHash("sha256").update(wasm).digest("hex");
  // Synthetic pin == hash of the synthetic bytes (no 2.8 MB resolver wasm is stored in the repo).
  editJson(dir, "results.json", (j) => { j.recreated.views.resolver_keys[2] = pin; j.recreated.new_args.resolver_wasm_hash = pin; });
  const good = join(dir, "good.wasm");
  writeFileSync(good, wasm);
  assert.equal(run(dir, { wasmFile: good }).E3.status, "PASS");
  const bad = Buffer.from(wasm);
  bad[7] ^= 0x01;
  const badp = join(dir, "bad.wasm");
  writeFileSync(badp, bad);
  expectFail(run(dir, { wasmFile: badp }), "E3");
});

// ---- STG1b (D-STORAGE1): B5 reads the bet's stored per-side charges (storage_maker + storage_taker); the envelope field is "0".
test("STG1b B5: per-side stored charges (envelope storage '0') -> PASS when they sum to what the fee account got", () => {
  const d = copyEvidence();
  editJson(d, "results.json", (j) => { j.bet_after_request.envelope.storage_charge_per_side = "0"; j.bet_after_request.storage_maker = "6000"; j.bet_after_request.storage_taker = "10000"; });
  const r = run(d);
  assert.equal(r.B5.status, "PASS", r.B5.reason);
  assert.match(r.B5.reason, /16000 storage/);
});

test("STG1b B5 tamper: stored per-side charges that do not match the balance deltas -> FAIL", () => {
  const d = copyEvidence();
  editJson(d, "results.json", (j) => { j.bet_after_request.envelope.storage_charge_per_side = "0"; j.bet_after_request.storage_maker = "6000"; j.bet_after_request.storage_taker = "10001"; });
  expectFail(run(d), "B5");
});
