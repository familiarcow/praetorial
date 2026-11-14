// RFRZ2 / D-RFRZ2a: testnet asset parity (wNEAR must be rehearsed on testnet), and the freeze-record CLI must refuse a
// resolver record whose wasm hash is not the one the args pin (new resolver wasm = SRCCHK3 release record b67b3d7).
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
const ROOT = join(here, "..", "..", "..");
const REL = join(ROOT, "release");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const SRCCHK3_HASH = "6517a422f55639d5d452ba2abcea93cc261c33729025be2afd5efcfa42d3b1c3";
// NOKEY1b (D-NOKEY1b): the drafts, the freeze record and the testnet escrow (frz3) now pin the NOKEY1 resolver (record-f9c61ec).
const NOKEY1_HASH = "8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473";
const NOKEY1_RECORD = "resolver/release/record-f9c61ec.json";
const FRZ3 = "praetorial-frz3-2611100414.praetorial-dev-1101.testnet";
const OLD_HASH = "c1fa42424cb7274eb8a3a0ac63afcd6cc5a267b1ffc9d146fdd707dac5bdf6b5";
const SRCCHK3_RECORD = "resolver/release/record-b67b3d7.json";
const ESCROW_RECORD = "contracts/escrow/release/record-c40e5fa.json";
const ESCROW_SHA = "caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f";
const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8" });

// Every mainnet asset has a testnet counterpart or an explicit, reasoned exemption. wNEAR can never be exempt.
const MAINNET_TO_TESTNET: Record<string, string> = {
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "nep141:usdc.testnet",
  "nep141:btc.omft.near": "nep141:btc.mock.testnet",
  "nep141:wrap.near": "nep141:wrap.testnet",
};
const EXEMPT: Record<string, string> = {
  "nep141:usdt.tether-token.near": "no testnet USDT exists; the 6-decimal stable path is rehearsed with usdc.testnet (same limit shape)",
  "nep141:eth.omft.near": "no testnet ETH omft mock deployed; the volatile-asset path is rehearsed with btc.mock.testnet and wrap.testnet",
  "nep141:zec.omft.near": "no testnet ZEC omft mock deployed; the volatile-asset path is rehearsed with btc.mock.testnet and wrap.testnet",
};

test("RFRZ2a: every mainnet asset_limits entry has a testnet counterpart or a reasoned exemption", () => {
  const main = readJson(join(REL, "draft-args.mainnet.json")).asset_limits.map((x: [string, unknown]) => x[0]) as string[];
  const tn = readJson(join(REL, "draft-args.testnet.json")).asset_limits.map((x: [string, unknown]) => x[0]) as string[];
  for (const id of main) {
    if (id in MAINNET_TO_TESTNET) assert.ok(tn.includes(MAINNET_TO_TESTNET[id]), `${id} must map to ${MAINNET_TO_TESTNET[id]} in draft-args.testnet.json`);
    else assert.ok(EXEMPT[id] && EXEMPT[id].length > 20, `${id} has no testnet counterpart and no written exemption reason`);
  }
  assert.ok(!("nep141:wrap.near" in EXEMPT), "wNEAR can not be exempt");
});

test("RFRZ2a: nep141:wrap.testnet carries the same limit shape (same keys, 24-decimal wNEAR storage rate) as mainnet wrap.near", () => {
  const find = (n: string, id: string) => readJson(join(REL, `draft-args.${n}.json`)).asset_limits.find((x: [string, unknown]) => x[0] === id)?.[1];
  const t = find("testnet", "nep141:wrap.testnet"), m = find("mainnet", "nep141:wrap.near");
  assert.ok(t, "wrap.testnet missing from draft-args.testnet.json asset_limits");
  assert.deepEqual(Object.keys(t).sort(), Object.keys(m).sort());
  assert.equal(t.storage_per_kib, "10240000000000000000000"); // RCB1: wNEAR rate is pinned exactly
});

test("RFRZ2: draft-input.testnet.json regenerates draft-args.testnet.json byte for byte", () => {
  const inp = readJson(join(REL, "draft-input.testnet.json"));
  const d = mkdtempSync(join(tmpdir(), "rfrz2-"));
  const r = run(["gen-new-args", "--input", join(REL, "draft-input.testnet.json"), "--out", join(d, "a.json"), "--network", "testnet", "--now-ms", String(inp.near_price.price_ts_ms + 60_000)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(d, "a.json"), "utf8"), readFileSync(join(REL, "draft-args.testnet.json"), "utf8"));
});

test("NOKEY1b: testnet + mainnet draft args/inputs pin the NOKEY1 resolver wasm hash", () => {
  for (const n of ["testnet", "mainnet"]) {
    assert.equal(readJson(join(REL, `draft-args.${n}.json`)).resolver_wasm_hash, NOKEY1_HASH, n);
    assert.equal(readJson(join(REL, `draft-input.${n}.json`)).resolver_wasm_hash, NOKEY1_HASH, n);
  }
  assert.equal(readJson(join(ROOT, NOKEY1_RECORD)).hash, NOKEY1_HASH);
});

test("NOKEY1b: release/freeze-candidate-2.json pins the NOKEY1 resolver record, the unchanged escrow wasm and the frz3 testnet escrow", () => {
  const f = readJson(join(REL, "freeze-candidate-2.json"));
  assert.equal(f.resolver.hash, NOKEY1_HASH);
  assert.equal(f.resolver.record, NOKEY1_RECORD);
  assert.equal(f.testnet_escrow.account, FRZ3);
  assert.equal(f.escrow.wasm_sha256, ESCROW_SHA); // escrow code unchanged (D-RFRZ2)
  assert.equal(f.escrow.record, ESCROW_RECORD);
  assert.equal(f.gen_new_args.testnet_sha256, sha(readFileSync(join(REL, "draft-args.testnet.json"))));
  assert.equal(f.gen_new_args.mainnet_sha256, sha(readFileSync(join(REL, "draft-args.mainnet.json"))));
});

// CLI: refuses a resolver record whose hash != the hash the args pin (and != --expect-resolver-hash when given).
function fixture(argsHash: string) {
  const d = mkdtempSync(join(tmpdir(), "rfrz2-"));
  writeFileSync(join(d, "fresh.txt"), ESCROW_SHA + "\n");
  writeFileSync(join(d, "testnet-args.json"), JSON.stringify({ resolver_wasm_hash: argsHash }) + "\n");
  writeFileSync(join(d, "mainnet-args.json"), JSON.stringify({ resolver_wasm_hash: argsHash }) + "\n");
  writeFileSync(join(d, "tests.txt"), "ok\n");
  return d;
}
const freeze = (d: string, resolverRecord: string, extra: string[] = []) => run(["freeze-record", "--commit", "a".repeat(40),
  "--escrow-record", join(ROOT, ESCROW_RECORD), "--resolver-record", join(ROOT, resolverRecord), "--fresh-escrow-hash-file", join(d, "fresh.txt"),
  "--testnet-args", join(d, "testnet-args.json"), "--mainnet-args", join(d, "mainnet-args.json"), "--test-summary-file", join(d, "tests.txt"),
  "--out", join(d, "out.json"), ...extra]);

test("RFRZ2: freeze-record refuses a resolver record whose hash differs from the args' resolver_wasm_hash", () => {
  const d = fixture(SRCCHK3_HASH);
  const r = freeze(d, "resolver/release/record-1733f97.json"); // the old c1fa4242 record
  assert.equal(r.status, 1);
  assert.match(r.stderr, /resolver wasm hash/);
  assert.equal(existsSync(join(d, "out.json")), false);
});

test("RFRZ2: freeze-record refuses a record whose hash != --expect-resolver-hash", () => {
  const d = fixture(OLD_HASH);
  const r = freeze(d, "resolver/release/record-1733f97.json", ["--expect-resolver-hash", SRCCHK3_HASH]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /resolver wasm hash/);
  assert.equal(existsSync(join(d, "out.json")), false);
});

test("RFRZ2: freeze-record accepts the SRCCHK3 record when the args and --expect-resolver-hash agree", () => {
  const d = fixture(SRCCHK3_HASH);
  const r = freeze(d, SRCCHK3_RECORD, ["--expect-resolver-hash", SRCCHK3_HASH]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readJson(join(d, "out.json")).resolver.hash, SRCCHK3_HASH);
});
