// E2S1 (D-STORAGE1): since STG1 the contract refuses any nonzero envelope storage_charge_per_side (lib.rs), so every
// re-runnable harness must send "0" and fund stake + the per-side charge from the asset table. Static guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const E2E = join(dirname(fileURLToPath(import.meta.url)), "..");
const FROZEN_REASON = "frozen evidence of a pre-STG1 run";
// Explicit exclusions (dir name -> reason). Never edited.
const FROZEN: Record<string, string> = {
  "live-run8": FROZEN_REASON, "live-run11b": FROZEN_REASON, "live-run16": FROZEN_REASON, "live-run16a": FROZEN_REASON,
  "live-run16c": FROZEN_REASON, "live-run16f": FROZEN_REASON, "live-run16i": FROZEN_REASON, "live-run16l": FROZEN_REASON,
  "live-run16o": FROZEN_REASON, "live-run16r": FROZEN_REASON, "live-runR3": FROZEN_REASON, "live-L1": FROZEN_REASON,
  "live-WT1": FROZEN_REASON, "probe17a": FROZEN_REASON, "probe17c2_raw.json": FROZEN_REASON, "probe17c2_result.json": FROZEN_REASON,
  "redteam17d": FROZEN_REASON, "replay17b": FROZEN_REASON,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "test" || n === "__pycache__") continue;
    const p = join(dir, n);
    if (relative(E2E, p).split("/")[0] in FROZEN) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js)$/.test(n) && !/^results.*\.json$/.test(n)) out.push(p);
  }
  return out;
}

test("every frozen exclusion exists (no stale list)", () => {
  const present = new Set(readdirSync(E2E));
  for (const k of Object.keys(FROZEN)) assert.ok(present.has(k), `stale exclusion ${k}`);
});

test("harness scan covers the known re-runnable harnesses", () => {
  const files = walk(E2E).map((f) => relative(E2E, f));
  for (const f of ["g3_round_trip.ts", "g4_lifecycle_matrix.ts", "g6_authcall_proof.ts", "run.ts", "live-runR3e/open_take.mjs"])
    assert.ok(files.includes(f), `${f} not scanned`);
});

test("no non-frozen harness sets storage_charge_per_side to anything but \"0\"", () => {
  const bad: string[] = [];
  for (const f of walk(E2E)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/storage_charge_per_side["']?\s*:\s*([^,}\n]+)/g)) {
      if (m[1].trim() !== '"0"') bad.push(`${relative(E2E, f)}: ${m[0]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("no non-frozen harness hardcodes a flat storage charge into deposits", () => {
  const bad: string[] = [];
  for (const f of walk(E2E)) {
    const src = readFileSync(f, "utf8");
    if (/storageChargePerSide\s*=\s*\d|storage\s*=\s*[\d_]+n\b/.test(src)) bad.push(relative(E2E, f));
    if (/amount:\s*"1002000"/.test(src)) bad.push(relative(E2E, f) + " (literal 1002000)");
  }
  assert.deepEqual(bad, []);
});
