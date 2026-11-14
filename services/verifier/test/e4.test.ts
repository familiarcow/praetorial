// FRZ1b: E4 is a live report-pubkey check, not a hardcoded SKIP. Fake OutLayer runner; no network, no spend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBetChecks, loadEvidenceDir, type Evidence } from "../src/run.js";
import { collectE4 } from "../src/e4.js";

const here = dirname(fileURLToPath(import.meta.url));
const R3E = join(here, "..", "..", "e2e", "live-runR3e");
const OUT = "11".repeat(32), ATT = "22".repeat(32), ESC = "esc.testnet", SIGNER = "attest1.testnet";
const base = (): Evidence => { const ev = loadEvidenceDir(R3E); ev.escrow = ESC; ev.pins = { ...ev.pins, outcome_pubkey: OUT, attest_pubkey: ATT }; return ev; };
const e4 = (ev: Evidence) => runBetChecks(ev, {}).find((r) => r.id === "E4")!;
const good = { outcome: { public_key: OUT, predecessor: ESC }, attest: { attest_public_key: ATT, predecessor: SIGNER } };

test("E4 PASS: live report-pubkey of the escrow (outcome) and the attest signer (attest) equal the bound pins", () => {
  const ev = base(); ev.e4 = good;
  const r = e4(ev); assert.equal(r.status, "PASS", r.reason);
});
test("E4 FAIL: outcome pubkey differs from the bound one", () => {
  const ev = base(); ev.e4 = { ...good, outcome: { public_key: "33".repeat(32), predecessor: ESC } };
  const r = e4(ev); assert.equal(r.status, "FAIL"); assert.match(r.reason, /outcome/i);
});
test("E4 FAIL: attest pubkey differs from the bound one", () => {
  const ev = base(); ev.e4 = { ...good, attest: { attest_public_key: "44".repeat(32), predecessor: SIGNER } };
  const r = e4(ev); assert.equal(r.status, "FAIL"); assert.match(r.reason, /attest/i);
});
test("E4 FAIL: outcome key was derived for a different predecessor than the escrow", () => {
  const ev = base(); ev.e4 = { ...good, outcome: { public_key: OUT, predecessor: "other.testnet" } };
  assert.equal(e4(ev).status, "FAIL");
});
test("E4 FAIL: live run was attempted and errored (never a silent SKIP)", () => {
  const ev = base(); ev.e4 = { error: "outlayer run failed" };
  const r = e4(ev); assert.equal(r.status, "FAIL"); assert.match(r.reason, /outlayer run failed/);
});
test("E4 FAIL: only one of the two pubkeys was reproduced", () => {
  const ev = base(); ev.e4 = { outcome: good.outcome };
  assert.equal(e4(ev).status, "FAIL");
});
test("E4 SKIP only when no live run was supplied (offline), and says offline", () => {
  const r = e4(base()); assert.equal(r.status, "SKIP"); assert.match(r.reason, /offline/i);
});

test("collectE4 runs the pinned wasm url in report-pubkey mode once as the escrow and once as the attest signer", async () => {
  const ev = base(); ev.outlayerConfig = { wasm_base_url: "https://fs.example/a/b" }; ev.pins.resolver_wasm_hash = "ab".repeat(32);
  const calls: { home: string; url: string; input: string }[] = [];
  const run = async (home: string, url: string, input: string) => {
    calls.push({ home, url, input });
    return home === "H_ESC" ? `Tx: x\n{"mode":"report-pubkey","predecessor":"${ESC}","public_key":"${OUT}","attest_public_key":"99"}` : `{"mode":"report-pubkey","predecessor":"${SIGNER}","public_key":"88","attest_public_key":"${ATT}"}`;
  };
  const r = await collectE4(ev, { escrowHome: "H_ESC", attestHome: "H_ATT" }, run);
  assert.deepEqual(r, good);
  assert.equal(calls.length, 2);
  for (const c of calls) { assert.equal(c.url, `https://fs.example/a/b/${"ab".repeat(32)}.wasm`); assert.deepEqual(JSON.parse(c.input), { mode: "report-pubkey" }); }
});
test("collectE4 without OutLayer homes returns an error (so E4 FAILs), not undefined", async () => {
  const ev = base(); ev.outlayerConfig = { wasm_base_url: "https://x" };
  const r = await collectE4(ev, {}, async () => "");
  assert.ok(r.error && /home/i.test(r.error));
});
test("collectE4 runner failure or unparsable output -> error", async () => {
  const ev = base(); ev.outlayerConfig = { wasm_base_url: "https://x" };
  assert.ok((await collectE4(ev, { escrowHome: "a", attestHome: "b" }, async () => { throw new Error("boom"); })).error);
  assert.ok((await collectE4(ev, { escrowHome: "a", attestHome: "b" }, async () => "no json here")).error);
});

test("CLI: verify-escrow with E4 SKIPPED by explicit --offline exits non-zero", () => {
  const r = spawnSync(join(here, "..", "verify-escrow"), ["--offline", "--evidence-dir", R3E], { encoding: "utf8" });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^SKIP +E4 /m);
});

// Found live in FRZ1b: `outlayer run --wasm <url> <json>` treats the positional as a PROJECT/ignores it and runs the default
// resolve path; report-pubkey input MUST go through `--input <file>`.
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { cliRunner } from "../src/e4.js";
test("cliRunner passes the job via --input <file> (never positional) and sets OUTLAYER_HOME", async () => {
  const d = mkdtempSync(join(tmpdir(), "e4-bin-"));
  const bin = join(d, "fake-outlayer");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${d}/argv"\nprintf '%s' "$OUTLAYER_HOME" > "${d}/home"\ni=0; for a in "$@"; do if [ "$p" = "--input" ]; then cat "$a" > "${d}/input"; fi; p="$a"; done\necho '{"mode":"report-pubkey"}'\n`);
  chmodSync(bin, 0o755);
  await cliRunner(bin)("/h/x", "https://fs/x.wasm", '{"mode":"report-pubkey"}');
  const argv = readFileSync(join(d, "argv"), "utf8").trim().split("\n");
  assert.deepEqual(argv.slice(0, 3), ["run", "--wasm", "https://fs/x.wasm"]);
  assert.equal(argv[3], "--input"); assert.equal(argv.length, 5);
  assert.equal(readFileSync(join(d, "input"), "utf8"), '{"mode":"report-pubkey"}');
  assert.equal(readFileSync(join(d, "home"), "utf8"), "/h/x");
});
