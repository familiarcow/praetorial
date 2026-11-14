// ALRT1a RED: services/e2e/ops/tail_cpu_alert.sh offline contract. A Worker cannot observe other Workers' outcomes, so an
// operator script tails each praetorial-*-testnet Worker (`wrangler tail --format json`), counts outcome != ok and exits
// non-zero on any exceededCpu (D-CF1E3a). Here it is fed recorded tail JSON (TAIL_FIXTURE_DIR / --from-file), no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, "../ops/tail_cpu_alert.sh");
const FIX = (n: string) => path.resolve(here, "../ops/fixtures", n);
const runScript = (...args: string[]) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH!, HOME: process.env.HOME! } });

test("ALRT1a: script exists and is executable", () => {
  assert.ok(existsSync(SCRIPT));
  assert.ok((statSync(SCRIPT).mode & 0o111) !== 0, "chmod +x");
});

test("ALRT1a: clean tail => exit 0, summary says 0 non-ok / 0 exceededCpu", () => {
  const r = runScript("--from-file", FIX("tail_clean.jsonl"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout.trim().split("\n").pop()!);
  assert.equal(j.events, 3); assert.equal(j.non_ok, 0); assert.equal(j.exceeded_cpu, 0);
});

test("ALRT1a: exceededCpu in the tail => non-zero exit, counted per outcome", () => {
  const r = runScript("--from-file", FIX("tail_exceeded_cpu.jsonl"));
  assert.notEqual(r.status, 0);
  const j = JSON.parse(r.stdout.trim().split("\n").pop()!);
  assert.equal(j.events, 3); assert.equal(j.non_ok, 2); assert.equal(j.exceeded_cpu, 1);
  assert.deepEqual(j.outcomes, { ok: 1, exceededCpu: 1, exception: 1 });
  assert.match(r.stderr, /exceededCpu/);
});

test("ALRT1a: a non-CPU failure (exception) is counted but does not by itself fail the CPU alert", () => {
  const r = runScript("--from-file", FIX("tail_noncpu_failure.jsonl"));
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout.trim().split("\n").pop()!);
  assert.equal(j.non_ok, 1); assert.equal(j.exceeded_cpu, 0);
});

test("ALRT1a: source tails a single worker at a time, in JSON, for every praetorial-*-testnet Worker, and never prints secrets", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /wrangler tail/); assert.match(src, /--format json/);
  for (const w of ["indexer", "keeper", "monitor", "notifier", "registry", "relayer"]) assert.ok(src.includes(`praetorial-${w}-testnet`), w);
  assert.ok(!/CLOUDFLARE_API_TOKEN\s*=/.test(src));
});
