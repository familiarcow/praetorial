// MAINPREP1: deploy-night preflight of the final mainnet args. `gen-new-args --preflight` applies every --final check EXCEPT
// the three OutLayer-sourced fields (outcome_pubkey, attest_pubkey, outlayer_config.wasm_base_url), which it lists as PENDING.
// Any other placeholder is still refused. The output file is written (for review) but marked not deployable on stdout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "cli.ts");
const REL = join(here, "..", "..", "..", "release");
const NOW = 1_794_127_760_000; // 60 s after the draft input's price timestamps
const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8" });
const draft = () => JSON.parse(readFileSync(join(REL, "draft-input.mainnet.json"), "utf8"));
const pre = (inp: unknown, extra: string[] = []) => {
  const d = mkdtempSync(join(tmpdir(), "mainprep1-"));
  writeFileSync(join(d, "in.json"), JSON.stringify(inp));
  const r = run(["gen-new-args", "--preflight", "--input", join(d, "in.json"), "--out", join(d, "a.json"), "--network", "mainnet", "--now-ms", String(NOW), ...extra]);
  return { r, out: join(d, "a.json") };
};

test("MAINPREP1: --preflight accepts the draft input and lists exactly the three OutLayer-sourced fields as PENDING", () => {
  const { r, out } = pre(draft());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(out), true);
  const pending = r.stdout.split("\n").filter((l) => l.startsWith("PENDING "));
  assert.deepEqual(pending.map((l) => l.split(" ")[1]).sort(), ["attest_pubkey", "outcome_pubkey", "outlayer_config.wasm_base_url"]);
  assert.match(r.stdout, /NOT DEPLOYABLE/);
});

test("MAINPREP1: --preflight still refuses any other placeholder (account names), naming it", () => {
  const i = draft(); i.keeper = "PLACEHOLDER.near";
  const { r, out } = pre(i);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /keeper: contains PLACEHOLDER/);
  assert.doesNotMatch(r.stderr, /outcome_pubkey/);
  assert.equal(existsSync(out), false);
});

test("MAINPREP1: --preflight refuses an http (non-https) wasm_base_url even though the field is OutLayer-sourced", () => {
  const i = draft(); i.outlayer_config.wasm_base_url = "http://fastfs.example.org/u.near/outlayer.near";
  const { r } = pre(i);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /wasm_base_url/);
});

test("MAINPREP1: --preflight with all three fields filled says DEPLOYABLE-SHAPE and lists nothing pending", () => {
  const i = draft();
  i.outcome_pubkey = "a1".repeat(32); i.attest_pubkey = "b2".repeat(32);
  i.outlayer_config.wasm_base_url = "https://main.fastfs.io/ops.praetorial.near/outlayer.near";
  const { r } = pre(i);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split("\n").filter((l) => l.startsWith("PENDING ")).length, 0);
  assert.match(r.stdout, /no OutLayer-sourced field pending/);
});

test("MAINPREP1: --preflight and --final together are refused (ambiguous)", () => {
  const { r } = pre(draft(), ["--final"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--preflight and --final/);
});

test("MAINPREP1: --preflight keeps the price staleness check (prices older than 30 min are refused)", () => {
  const d = mkdtempSync(join(tmpdir(), "mainprep1-"));
  writeFileSync(join(d, "in.json"), JSON.stringify(draft()));
  const r = run(["gen-new-args", "--preflight", "--input", join(d, "in.json"), "--out", join(d, "a.json"), "--network", "mainnet", "--now-ms", String(NOW + 31 * 60_000)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /old|stale|30/i);
});

test("MAINPREP1: mainnet --final and --preflight refuse a testnet value (e.g. a test.fastfs.io/.testnet wasm_base_url), naming it", () => {
  const i = draft();
  i.outcome_pubkey = "a1".repeat(32); i.attest_pubkey = "b2".repeat(32);
  i.outlayer_config.wasm_base_url = "https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet";
  for (const mode of ["--final", "--preflight"]) {
    const d = mkdtempSync(join(tmpdir(), "mainprep1-"));
    writeFileSync(join(d, "in.json"), JSON.stringify(i));
    const r = run(["gen-new-args", mode, "--input", join(d, "in.json"), "--out", join(d, "a.json"), "--network", "mainnet", "--now-ms", String(NOW)]);
    assert.equal(r.status, 1, mode);
    assert.match(r.stderr, /outlayer_config\.wasm_base_url: testnet value/, mode);
    assert.equal(existsSync(join(d, "a.json")), false);
  }
});
