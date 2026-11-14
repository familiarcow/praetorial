// PUB1 (HK1 item 5): the mainnet release record names the real deploy and delete-key txs of the escrow, single-sourced
// from input.priced.json mainnet_escrow (HK1 FU1, read-only from tx.main.fastnear.com; PUB1 re-checked: the deploy tx's
// DeployContract code hash = escrow_wasm_sha256, both txs SuccessValue). Evidence: spikes/pub1/evidence/mainnet-txs.txt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const json = (f: string) => JSON.parse(readFileSync(join(ROOT, f), "utf8"));
const B58_TX = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

test("release-mainnet.json mainnet_escrow deploy_tx / delete_key_tx are the real txs (= input.priced.json), not PENDING", () => {
  const rel = json("release/mainnet-night/release-mainnet.json").mainnet_escrow;
  const inp = json("release/mainnet-night/input.priced.json").mainnet_escrow;
  assert.equal(rel.account, inp.account);
  for (const k of ["deploy_tx", "delete_key_tx"] as const) {
    assert.match(rel[k], B58_TX, k);
    assert.equal(rel[k], inp[k], k);
  }
});
