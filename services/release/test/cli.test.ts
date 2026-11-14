// RC1: the gen-new-args CLI. Files only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "cli.ts");
const NOW = 1_800_000_000_000;
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const base = (over: Record<string, unknown> = {}) => ({
  network: "mainnet", intents: "intents.near", usdc_token_id: USDC,
  outlayer: "outlayer.fake.near", operator: "operator.fake.near", guardian: "praetorial.near",
  registry: "registry.fake.near", fee_account: "fee.fake.near", keeper: "keeper.fake.near",
  max_offer_ttl_secs: 5184000,
  near_price: { price_usd: "3.68", price_ts_ms: NOW - 60000, second_price_usd: "3.68", second_price_ts_ms: NOW - 60000 }, // STG1b
  outcome_pubkey: "a1".repeat(32), attest_pubkey: "b2".repeat(32), resolver_wasm_hash: "c3".repeat(32),
  outlayer_config: { wasm_base_url: "https://fastfs.fake.example/u.near/o.near", secrets_profile: "praetorial-resolver", secrets_account_id: "secrets.fake.near" },
  assets: [
    { token_id: USDC, decimals: 6, kind: "stable" },
    { token_id: "nep141:btc.omft.near", decimals: 8, kind: "volatile", price_usd: "75823", price_ts_ms: NOW - 60000, second_price_usd: "75900", second_price_ts_ms: NOW - 60000 },
  ],
  ...over,
});
const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8" });

test("gen-new-args writes args JSON and the table; exit 0", () => {
  const d = mkdtempSync(join(tmpdir(), "rc1-"));
  writeFileSync(join(d, "in.json"), JSON.stringify(base()));
  const r = run(["gen-new-args", "--input", join(d, "in.json"), "--out", join(d, "args.json"), "--table", join(d, "table.md"), "--network", "mainnet", "--now-ms", String(NOW)]);
  assert.equal(r.status, 0, r.stderr);
  const args = JSON.parse(readFileSync(join(d, "args.json"), "utf8"));
  assert.equal(args.intents, "intents.near");
  assert.equal(args.asset_limits.length, 2);
  assert.match(readFileSync(join(d, "table.md"), "utf8"), /btc\.omft\.near/);
});

test("gen-new-args refuses (exit 1, no output file) when intents != intents.near on mainnet", () => {
  const d = mkdtempSync(join(tmpdir(), "rc1-"));
  writeFileSync(join(d, "in.json"), JSON.stringify(base({ intents: "intents-mock.fake.testnet" })));
  const r = run(["gen-new-args", "--input", join(d, "in.json"), "--out", join(d, "args.json"), "--network", "mainnet", "--now-ms", String(NOW)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /intents\.near/);
  assert.equal(existsSync(join(d, "args.json")), false);
});

test("gen-new-args requires --network (no silent default)", () => {
  const d = mkdtempSync(join(tmpdir(), "rc1-"));
  writeFileSync(join(d, "in.json"), JSON.stringify(base()));
  const r = run(["gen-new-args", "--input", join(d, "in.json"), "--out", join(d, "args.json")]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--network/);
});
