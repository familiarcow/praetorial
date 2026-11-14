// RCFG1 (D-RCFG1): the mainnet draft args carry the ruled account names; the generator's --final mode refuses placeholders.
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
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("RCFG1: release/draft-args.mainnet.json carries the ruled account names", () => {
  const a = readJson(join(REL, "draft-args.mainnet.json"));
  assert.equal(a.outlayer, "outlayer.near");
  assert.equal(a.operator, "operator.praetorial.near");
  assert.equal(a.registry, "registry.praetorial.near");
  assert.equal(a.fee_account, "praetorial.near");
  assert.equal(a.keeper, "keeper.praetorial.near");
  assert.equal(a.guardian, "praetorial.near");
  assert.equal(a.outlayer_config.secrets_account_id, "aikey.praetorial.near");
});

test("RCFG1: draft-input.mainnet.json regenerates draft-args.mainnet.json byte for byte, and records attest/relayer names", () => {
  const d = mkdtempSync(join(tmpdir(), "rcfg1-"));
  const r = run(["gen-new-args", "--input", join(REL, "draft-input.mainnet.json"), "--out", join(d, "a.json"), "--network", "mainnet", "--now-ms", String(NOW)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(d, "a.json"), "utf8"), readFileSync(join(REL, "draft-args.mainnet.json"), "utf8"));
  const inp = readJson(join(REL, "draft-input.mainnet.json"));
  const notes = JSON.stringify(inp.accounts_notes ?? inp.notes ?? {});
  assert.match(notes, /attest\.praetorial\.near/);
  assert.match(notes, /relayer\.praetorial\.near/);
});

test("RCFG1: draft mode still emits the three deploy-day placeholders (outcome_pubkey, attest_pubkey, wasm_base_url)", () => {
  const d = mkdtempSync(join(tmpdir(), "rcfg1-"));
  const r = run(["gen-new-args", "--input", join(REL, "draft-input.mainnet.json"), "--out", join(d, "a.json"), "--network", "mainnet", "--now-ms", String(NOW)]);
  assert.equal(r.status, 0, r.stderr);
  const a = readJson(join(d, "a.json"));
  assert.match(a.outlayer_config.wasm_base_url, /PLACEHOLDER/);
  assert.equal(a.outcome_pubkey, "0".repeat(64));
});

test("RCFG1: --final refuses the draft input, naming each offending field", () => {
  const d = mkdtempSync(join(tmpdir(), "rcfg1-"));
  const r = run(["gen-new-args", "--final", "--input", join(REL, "draft-input.mainnet.json"), "--out", join(d, "a.json"), "--network", "mainnet", "--now-ms", String(NOW)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /outcome_pubkey/);
  assert.match(r.stderr, /attest_pubkey/);
  assert.match(r.stderr, /outlayer_config\.wasm_base_url/);
  assert.equal(existsSync(join(d, "a.json")), false);
});

const finalInput = () => {
  const inp = readJson(join(REL, "draft-input.mainnet.json"));
  inp.outcome_pubkey = "a1".repeat(32);
  inp.attest_pubkey = "b2".repeat(32);
  inp.outlayer_config.wasm_base_url = "https://fastfs.example.org/u.near/o.near";
  return inp;
};
const finalRun = (inp: unknown) => {
  const d = mkdtempSync(join(tmpdir(), "rcfg1-"));
  writeFileSync(join(d, "in.json"), JSON.stringify(inp));
  const r = run(["gen-new-args", "--final", "--input", join(d, "in.json"), "--out", join(d, "a.json"), "--network", "mainnet", "--now-ms", String(NOW)]);
  return { r, out: join(d, "a.json") };
};

test("RCFG1: --final accepts a fully filled input", () => {
  const { r, out } = finalRun(finalInput());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(out), true);
});

test("RCFG1: --final refuses an all-0 outcome_pubkey, all-1 attest_pubkey, http and placeholder wasm_base_url, each by name", () => {
  let i = finalInput(); i.outcome_pubkey = "0".repeat(64);
  let x = finalRun(i); assert.equal(x.r.status, 1); assert.match(x.r.stderr, /outcome_pubkey/); assert.equal(existsSync(x.out), false);
  i = finalInput(); i.attest_pubkey = "1".repeat(64);
  x = finalRun(i); assert.equal(x.r.status, 1); assert.match(x.r.stderr, /attest_pubkey/);
  i = finalInput(); i.outlayer_config.wasm_base_url = "http://fastfs.example.org/u";
  x = finalRun(i); assert.equal(x.r.status, 1); assert.match(x.r.stderr, /outlayer_config\.wasm_base_url/);
  i = finalInput(); i.outlayer_config.wasm_base_url = "https://PLACEHOLDER.example/uploader/outlayer";
  x = finalRun(i); assert.equal(x.r.status, 1); assert.match(x.r.stderr, /outlayer_config\.wasm_base_url/);
});

test("RCFG1: --final refuses PLACEHOLDER in any field (account names, secrets account)", () => {
  const i = finalInput(); i.outlayer = "outlayer.PLACEHOLDER.near"; i.outlayer_config.secrets_account_id = "secrets.PLACEHOLDER.near";
  const x = finalRun(i);
  assert.equal(x.r.status, 1);
  assert.match(x.r.stderr, /outlayer\b/);
  assert.match(x.r.stderr, /outlayer_config\.secrets_account_id/);
});
