// DR0 part 1: the recorder writes an evidence dir in the layout `services/verifier/final_step.sh <dir>` reads.
// Offline: the recorded input is a committed fixture (the frozen R3e run turned into recorder input); no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeEvidenceDir, type RecordedRun } from "../recorder.js";

const here = dirname(fileURLToPath(import.meta.url));
const FINAL_STEP = join(here, "..", "..", "..", "..", "verifier", "final_step.sh");
const input = (): RecordedRun => JSON.parse(readFileSync(join(here, "..", "fixtures", "recorded_run_input.json"), "utf8"));
const scratch = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dr0-rec-"));
const finalStep = (dir: string) => spawnSync("sh", [FINAL_STEP, dir], { encoding: "utf8" });

test("recorder writes every file the offline verifier loads", () => {
  const dir = scratch();
  writeEvidenceDir(input(), dir);
  for (const f of ["results.json", "raw_resolution.txt", "results_finalize.json", "sourcecheck.log", "escrow_name.txt", "terms.json"]) {
    assert.ok(existsSync(join(dir, f)), `missing ${f}`);
  }
});

test("final_step.sh on the recorded dir: 0 FAIL, exit 0, payout/signature checks PASS", () => {
  const dir = scratch();
  writeEvidenceDir(input(), dir);
  const r = finalStep(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /# \d+ PASS, 0 FAIL, \d+ SKIP/);
  for (const c of ["E2", "B1", "B2", "B3", "B5", "B6"]) assert.match(r.stdout, new RegExp(`^PASS ${c} `, "m"), `${c} must PASS:\n${r.stdout}`);
});

test("tampered copy (winner payout changed by 1 raw unit) -> B5 FAIL, non-zero exit", () => {
  const dir = scratch();
  writeEvidenceDir(input(), dir);
  const tampered = scratch();
  cpSync(dir, tampered, { recursive: true });
  const p = join(tampered, "results_finalize.json");
  const j = JSON.parse(readFileSync(p, "utf8"));
  j.after.balances.maker = (BigInt(j.after.balances.maker) + 1n).toString();
  writeFileSync(p, JSON.stringify(j, null, 1));
  const r = finalStep(tampered);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /^FAIL B5 /m);
});

test("recorder derives deltas/escrow residue itself: a recorded run whose escrow is not drained is not written as clean", () => {
  const bad = input();
  bad.finalize.after.balances.escrow = "1";
  const dir = scratch();
  assert.throws(() => writeEvidenceDir(bad, dir), /escrow/i);
});

test("recorder does not write secrets: no env value appears in the evidence dir", () => {
  const dir = scratch();
  writeEvidenceDir(input(), dir);
  const all = ["results.json", "raw_resolution.txt", "results_finalize.json", "sourcecheck.log"].map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  for (const [k, v] of Object.entries(process.env)) {
    if (/KEY|SECRET|TOKEN|OTP|PASS/i.test(k) && v && v.length >= 8) assert.ok(!all.includes(v), `${k} value leaked into evidence`);
  }
});
