import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "verify-bet");
const R3E = join(here, "..", "..", "e2e", "live-runR3e");

test("CLI: recorded R3e evidence exits 0 and prints PASS/SKIP per check", () => {
  const r = spawnSync(BIN, ["--evidence-dir", R3E], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const id of ["E1", "E2", "E3", "E4", "B1", "B2", "B3", "B4", "B5", "B6"]) assert.match(r.stdout, new RegExp(`^(PASS|FAIL|SKIP) +${id} `, "m"));
});

test("CLI: tampered terms exits 1 with FAIL B1", () => {
  const d = mkdtempSync(join(tmpdir(), "verifier-cli-"));
  for (const f of ["results.json", "raw_resolution.txt", "terms.json", "results_finalize.json", "sourcecheck.log", "escrow_name.txt"]) cpSync(join(R3E, f), join(d, f));
  writeFileSync(join(d, "terms.json"), readFileSync(join(d, "terms.json"), "utf8").replace("70 degrees", "60 degrees"));
  const r = spawnSync(BIN, ["--evidence-dir", d], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL +B1 /m);
});

test("CLI: usage error exits 2", () => {
  assert.equal(spawnSync(BIN, [], { encoding: "utf8" }).status, 2);
});

test("verify-escrow prints only E checks", () => {
  const r = spawnSync(join(here, "..", "verify-escrow"), ["--evidence-dir", R3E], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /^(PASS|FAIL|SKIP) +B\d /m);
});
