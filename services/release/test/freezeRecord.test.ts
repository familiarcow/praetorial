// FRZ1: the `freeze-record` CLI writes release/freeze-candidate-2.json and refuses on any mismatch. Files only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "cli.ts");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const COMMIT = "a".repeat(40);
const ESC_SHA = "6b59b3350ebd20b4bd5c7684d5a97d6c45e96d61241fca69fd9427cd1618362c";
const RES_SHA = "0015abc21a5d939d10ba6fff57fbbeb7c4e1b8bc16f99c4adfa798c55de5b01f";

function fixture(over: { fresh?: string; resolverBuilds?: string[]; escrowBuilds?: string[] } = {}) {
  const d = mkdtempSync(join(tmpdir(), "frz1-"));
  const b = (h: string[]) => h.map((s, i) => ({ route: `r${i}`, sha256: s }));
  const rec = (hash: string, builds: string[]) => ({
    commit: "b".repeat(40), image_digest: "sha256:" + "c".repeat(64), platform: "linux/amd64", repo: "x", hash, builds: b(builds),
  });
  writeFileSync(join(d, "escrow-record.json"), JSON.stringify(rec(ESC_SHA, over.escrowBuilds ?? [ESC_SHA, ESC_SHA, ESC_SHA])));
  writeFileSync(join(d, "resolver-record.json"), JSON.stringify(rec(RES_SHA, over.resolverBuilds ?? [RES_SHA, RES_SHA, RES_SHA])));
  writeFileSync(join(d, "fresh.txt"), (over.fresh ?? ESC_SHA) + "\n");
  writeFileSync(join(d, "testnet-args.json"), JSON.stringify({ net: "testnet", resolver_wasm_hash: RES_SHA }) + "\n");
  writeFileSync(join(d, "mainnet-args.json"), JSON.stringify({ net: "mainnet", resolver_wasm_hash: RES_SHA }) + "\n");
  writeFileSync(join(d, "tests.txt"), "escrow cargo test ok; services npm test pass; tsc 0\n");
  return d;
}
const run = (d: string, extra: string[] = [], out = "out.json") =>
  spawnSync(process.execPath, ["--import", "tsx", CLI, "freeze-record",
    "--commit", COMMIT,
    "--escrow-record", join(d, "escrow-record.json"),
    "--resolver-record", join(d, "resolver-record.json"),
    "--fresh-escrow-hash-file", join(d, "fresh.txt"),
    "--testnet-args", join(d, "testnet-args.json"),
    "--mainnet-args", join(d, "mainnet-args.json"),
    "--test-summary-file", join(d, "tests.txt"),
    "--out", join(d, out), ...extra], { encoding: "utf8" });

test("freeze-record writes commit, escrow sha, resolver hash+record path, args hashes, test summary", () => {
  const d = fixture();
  const r = run(d);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(join(d, "out.json"), "utf8"));
  assert.equal(j.commit, COMMIT);
  assert.equal(j.escrow.wasm_sha256, ESC_SHA);
  assert.equal(j.escrow.record, join(d, "escrow-record.json"));
  assert.equal(j.escrow.fresh_build_sha256, ESC_SHA);
  assert.equal(j.resolver.hash, RES_SHA);
  assert.equal(j.resolver.record, join(d, "resolver-record.json"));
  assert.equal(j.gen_new_args.testnet_sha256, sha(JSON.stringify({ net: "testnet", resolver_wasm_hash: RES_SHA }) + "\n"));
  assert.equal(j.gen_new_args.mainnet_sha256, sha(JSON.stringify({ net: "mainnet", resolver_wasm_hash: RES_SHA }) + "\n"));
  assert.match(j.test_summary, /tsc 0/);
  assert.equal(j.testnet_escrow, undefined);
});

test("freeze-record refuses (exit 1, no file) when the fresh build hash differs from the escrow record", () => {
  const d = fixture({ fresh: "0".repeat(64) });
  const r = run(d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fresh build/);
  assert.equal(existsSync(join(d, "out.json")), false);
});

test("freeze-record refuses when the resolver record does not verify (build hashes differ)", () => {
  const d = fixture({ resolverBuilds: [RES_SHA, RES_SHA, "1".repeat(64)] });
  const r = run(d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /resolver record/);
  assert.equal(existsSync(join(d, "out.json")), false);
});

test("freeze-record refuses when the escrow record has fewer than 3 builds", () => {
  const d = fixture({ escrowBuilds: [ESC_SHA, ESC_SHA] });
  const r = run(d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /escrow record/);
  assert.equal(existsSync(join(d, "out.json")), false);
});

test("freeze-record refuses a malformed fresh hash file", () => {
  const d = fixture({ fresh: "not-a-hash" });
  const r = run(d);
  assert.equal(r.status, 1);
  assert.equal(existsSync(join(d, "out.json")), false);
});

test("freeze-record records the testnet escrow account and verify output hash when given", () => {
  const d = fixture();
  writeFileSync(join(d, "verify.txt"), "E1 PASS\n");
  const r = run(d, ["--testnet-escrow", "frz1.praetorial-dev-1101.testnet", "--deploy-tx", "TXHASH", "--verify-output", join(d, "verify.txt")]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(join(d, "out.json"), "utf8"));
  assert.equal(j.testnet_escrow.account, "frz1.praetorial-dev-1101.testnet");
  assert.equal(j.testnet_escrow.deploy_tx, "TXHASH");
  assert.equal(j.testnet_escrow.verify_output_sha256, sha("E1 PASS\n"));
});

// D-FRZ1 / FRZ1a: a draft record may carry explicit 'pending FRZ1b' deploy fields; claiming a deploy needs verify output.
test("freeze-record --pending-frz1b writes a draft with explicit 'pending FRZ1b' deploy fields", () => {
  const d = fixture();
  const r = run(d, ["--pending-frz1b", "yes"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(join(d, "out.json"), "utf8"));
  assert.equal(j.status, "draft");
  assert.equal(j.testnet_escrow.account, "pending FRZ1b");
  assert.equal(j.testnet_escrow.deploy_tx, "pending FRZ1b");
  assert.equal(j.testnet_escrow.verify_output_sha256, "pending FRZ1b");
  for (const k of ["E1", "E2", "E3", "E4"]) assert.equal(j.verify_escrow[k], "pending FRZ1b");
  assert.equal(j.tag, "pending FRZ1b");
});

test("freeze-record refuses --pending-frz1b combined with real deploy fields", () => {
  const d = fixture();
  const r = run(d, ["--pending-frz1b", "yes", "--testnet-escrow", "a.testnet"]);
  assert.equal(r.status, 1);
  assert.equal(existsSync(join(d, "out.json")), false);
});

test("freeze-record refuses a deploy tx claimed without verify output", () => {
  const d = fixture();
  const r = run(d, ["--testnet-escrow", "a.testnet", "--deploy-tx", "TXHASH"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /verify/);
  assert.equal(existsSync(join(d, "out.json")), false);
});

test("a record without pending or deploy fields is not labelled draft-pending", () => {
  const d = fixture();
  const r = run(d);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(join(d, "out.json"), "utf8"));
  assert.equal(j.status, undefined);
});
