// F1: the funding wrangler.toml. BETTING_ASSET_IDS == the 6 asset_limits ids of release/mainnet-night/args.mainnet.json (testnet
// and mainnet, since 1Click is mainnet-only); testnet is dry-only, mainnet is not; no "*" origin; no fee/recipient vars at all
// (familiarcow: no partner fee, recipients are built in code); no key material; the DO + SQLite migration exist in both envs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HERE } from "./helpers.js";
import { parseWranglerToml } from "../../common/src/stackCheck.js";
import { mainnetSection } from "../../common/src/mainnetReady.js";
import { BET } from "./helpers.js";

const REPO = path.resolve(HERE, "../../../..");
const toml = fs.readFileSync(path.join(HERE, "../wrangler.toml"), "utf8");
const args = JSON.parse(fs.readFileSync(path.join(REPO, "release/mainnet-night/args.mainnet.json"), "utf8"));

test("BETTING_ASSET_IDS (both envs) are exactly the 6 asset_limits ids of args.mainnet.json", () => {
  const want = (args.asset_limits as [string, unknown][]).map(([id]) => id).sort();
  assert.equal(want.length, 6);
  assert.deepEqual([...BET].sort(), want, "test fixture matches the release args");
  for (const net of ["testnet", "mainnet"]) {
    const v = parseWranglerToml(toml, net).vars;
    assert.deepEqual(v.BETTING_ASSET_IDS!.split(",").sort(), want, net);
  }
});

test("names, network, dry-only per env, origins never '*', 1Click base URL", () => {
  const t = parseWranglerToml(toml, "testnet"), m = parseWranglerToml(toml, "mainnet");
  assert.equal(t.name, "praetorial-funding-testnet");
  assert.equal(m.name, "praetorial-funding-mainnet");
  assert.equal(t.vars.NEAR_NETWORK_ID, "testnet");
  assert.equal(m.vars.NEAR_NETWORK_ID, "mainnet");
  assert.equal(t.vars.FUNDING_DRY_ONLY, "1");
  assert.equal(m.vars.FUNDING_DRY_ONLY, "0");
  for (const c of [t, m]) {
    assert.equal(c.vars.ONECLICK_BASE_URL, "https://1click.chaindefuser.com");
    assert.ok(!c.vars.FUNDING_ALLOWED_ORIGINS!.split(",").includes("*"));
    assert.deepEqual(c.crons, [], "no cron (the account's 5 are used)");
  }
  assert.ok(m.vars.FUNDING_ALLOWED_ORIGINS!.split(",").includes("https://praetorial.com"));
  assert.ok(!/localhost/.test(m.vars.FUNDING_ALLOWED_ORIGINS!));
  assert.equal(m.vars.INTENTS_CONTRACT_ID, "intents.near");
  assert.equal(t.vars.INTENTS_CONTRACT_ID, undefined, "testnet: dry-only, no balance reads (and no drift vs the web's mock intents id)");
});

test("no fee or recipient knobs, no key material, the key is a secret (never a var)", () => {
  assert.doesNotMatch(toml, /APP_FEE|appFees|FEE_RECIPIENT|RECIPIENT|REFUND_TO/i);
  assert.doesNotMatch(toml, /^\s*ONECLICK_API_KEY\s*=/m);
  assert.doesNotMatch(toml, /eyJ[A-Za-z0-9_-]{10,}|ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/);
});

test("FUNDING_STORE Durable Object (SQLite) bound + migrated in both envs", () => {
  const top = toml.split(/^\[env\.mainnet\]/m)[0]!;
  assert.match(top, /\[\[durable_objects\.bindings\]\]\s*name = "FUNDING_STORE"\s*class_name = "FundingStoreDO"/);
  assert.match(top, /new_sqlite_classes = \["FundingStoreDO"\]/);
  const m = mainnetSection(toml);
  assert.match(m, /\[\[env\.mainnet\.durable_objects\.bindings\]\]\s*name = "FUNDING_STORE"\s*class_name = "FundingStoreDO"/);
  assert.match(m, /\[\[env\.mainnet\.migrations\]\]\s*tag = "v1"\s*new_sqlite_classes = \["FundingStoreDO"\]/);
});
