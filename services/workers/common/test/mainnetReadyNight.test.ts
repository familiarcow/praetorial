// MAINPREP1: deploy-night findings the WKMAIN1b check missed. Each one would have shipped a mainnet Worker that runs but is
// wrong: a monitor watching a USDC id intents.near does not know ("0" balance for the bare id, verified by RPC view
// 2026-11-10), no second RPC for terminal outcomes (D-DSY1), no NEAR balance watch on the relayer/keeper (LIVE1 outage),
// a notifier linking to a testnet example URL, and a sourcecheck Worker that refuses the unlisted workers.dev web origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkMainnetReady, MAINNET_WORKERS, MAINNET_WEB_ORIGINS, mainnetSection } from "../src/mainnetReady.js";

const WORKERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const real = (): Record<string, string> => Object.fromEntries(MAINNET_WORKERS.map((n) => [n, fs.readFileSync(path.join(WORKERS, n, "wrangler.toml"), "utf8")]));
const sub = (t: Record<string, string>, n: string, from: RegExp, to: string) => {
  const sec = mainnetSection(t[n]!);
  assert.match(sec, from, `${n} mainnet section has no ${from}`);
  t[n] = t[n]!.replace(sec, sec.replace(from, to));
};

test("MAINPREP1: the repo's mainnet Worker config has zero findings (D1 ids filled, all night checks pass)", () => {
  assert.deepEqual(checkMainnetReady(real()), []);
});

test("MAINPREP1: tonight's unlisted web origin is the workers.dev mainnet web Worker", () => {
  assert.ok(MAINNET_WEB_ORIGINS.includes("https://praetorial.com"));
});

test("MAINPREP1: monitor USDC_TOKEN_ID without the nep141: prefix is a finding", () => {
  const t = real(); sub(t, "monitor", /^USDC_TOKEN_ID = "nep141:/m, 'USDC_TOKEN_ID = "');
  assert.ok(checkMainnetReady(t).some((f) => f.startsWith("monitor:") && /USDC_TOKEN_ID/.test(f) && /nep141:/.test(f)));
});

for (const n of ["indexer", "notifier"]) {
  test(`MAINPREP1: ${n} without NEAR_RPC_FALLBACKS (D-DSY1 second RPC) is a finding`, () => {
    const t = real(); sub(t, n, /^NEAR_RPC_FALLBACKS = .*$/m, "");
    assert.ok(checkMainnetReady(t).some((f) => f.startsWith(`${n}:`) && /NEAR_RPC_FALLBACKS/.test(f)));
  });
  test(`MAINPREP1: ${n} whose fallback is the same host as NEAR_RPC_URL is a finding (not independent)`, () => {
    const t = real(); sub(t, n, /^NEAR_RPC_FALLBACKS = .*$/m, 'NEAR_RPC_FALLBACKS = "https://free.rpc.fastnear.com"');
    assert.ok(checkMainnetReady(t).some((f) => f.startsWith(`${n}:`) && /independent/.test(f)));
  });
}

test("MAINPREP1: monitor CREDIT_WATCH must watch both the relayer and the keeper account", () => {
  const t = real(); sub(t, "monitor", /^CREDIT_WATCH = .*$/m, 'CREDIT_WATCH = "keeper.praetorial.near:1"');
  assert.ok(checkMainnetReady(t).some((f) => f.startsWith("monitor:") && /CREDIT_WATCH/.test(f) && /relayer\.praetorial\.near/.test(f)));
  const u = real(); sub(u, "monitor", /^CREDIT_WATCH = .*$/m, "");
  assert.ok(checkMainnetReady(u).some((f) => f.startsWith("monitor:") && /CREDIT_WATCH/.test(f)));
});

test("MAINPREP1: notifier without an https NOTIFIER_BET_LINK_BASE is a finding (code default is a testnet example URL)", () => {
  const t = real(); sub(t, "notifier", /^NOTIFIER_BET_LINK_BASE = .*$/m, "");
  assert.ok(checkMainnetReady(t).some((f) => f.startsWith("notifier:") && /NOTIFIER_BET_LINK_BASE/.test(f)));
});

test("MAINPREP1: sourcecheck that does not allow tonight's web origin is a finding", () => {
  const t = real(); sub(t, "sourcecheck", /^SOURCECHECK_ALLOWED_ORIGINS = .*$/m, 'SOURCECHECK_ALLOWED_ORIGINS = "https://praetorial.com"');
  assert.ok(checkMainnetReady(t).some((f) => f.startsWith("sourcecheck:") && /praetorial-web-mainnet/.test(f)));
  // a caller can pass a different set of web origins (e.g. praetorial.com once the route exists)
  assert.deepEqual(checkMainnetReady(t, { webOrigins: ["https://praetorial.com"] }).filter((f) => f.startsWith("sourcecheck:")), []);
});

test("MAINPREP1: keeper/relayer/sourcecheck/registry must pin NEAR_NETWORK_ID = mainnet", () => {
  const t = real(); sub(t, "relayer", /^NEAR_NETWORK_ID = "mainnet"/m, 'NEAR_NETWORK_ID = "main"');
  assert.ok(checkMainnetReady(t).some((f) => f.startsWith("relayer:") && /NEAR_NETWORK_ID/.test(f)));
});

// KEYS2 (D-KEYS2): escrow./fee./secrets.praetorial.near are lost; the mainnet escrow is bets.praetorial.near, the fee account is
// praetorial.near. D-RLY1a: the mainnet relayer's global daily budget is 1.4 NEAR.
for (const n of ["keeper", "relayer", "monitor", "notifier", "indexer", "sourcecheck"]) {
  test(`KEYS2: ${n} ESCROW_CONTRACT_ID other than bets.praetorial.near is a finding`, () => {
    const t = real(); sub(t, n, /^ESCROW_CONTRACT_ID = .*$/m, 'ESCROW_CONTRACT_ID = "escrow.praetorial.near"');
    assert.ok(checkMainnetReady(t).some((f) => f.startsWith(`${n}:`) && /ESCROW_CONTRACT_ID/.test(f) && /bets\.praetorial\.near/.test(f)));
  });
}
test("KEYS2: monitor FEE_ACCOUNT_ID other than praetorial.near is a finding", () => {
  const t = real(); sub(t, "monitor", /^FEE_ACCOUNT_ID = .*$/m, 'FEE_ACCOUNT_ID = "fee.praetorial.near"');
  assert.ok(checkMainnetReady(t).some((f) => f.startsWith("monitor:") && /FEE_ACCOUNT_ID/.test(f)));
});
test("KEYS2: a lost account name anywhere in an [env.mainnet] section is a finding", () => {
  const t = real(); sub(t, "registry", /^REGISTRY_ID = .*$/m, 'REGISTRY_ID = "registry.praetorial.near"\n# old escrow escrow.praetorial.near');
  assert.ok(checkMainnetReady(t).some((f) => f.startsWith("registry:") && /lost account/.test(f)));
});
test("KEYS2 (D-RLY1a): relayer without RELAYER_GLOBAL_DAILY_BUDGET_YOCTO = 1.4 NEAR is a finding", () => {
  const t = real(); sub(t, "relayer", /^RELAYER_GLOBAL_DAILY_BUDGET_YOCTO = .*$/m, "");
  assert.ok(checkMainnetReady(t).some((f) => f.startsWith("relayer:") && /RELAYER_GLOBAL_DAILY_BUDGET_YOCTO/.test(f)));
});

// F1 (D-FUND4a): the funding Worker's [env.mainnet] must allow tonight's web origin, real quotes on (FUNDING_DRY_ONLY "0"), the real
// 1Click base URL, and exactly the 6 bet tokens of args.mainnet.json.
test("F1: funding mainnet config is clean today", () => {
  assert.deepEqual(checkMainnetReady(real()).filter((f) => f.startsWith("funding:")), []);
});
for (const [what, from, to] of [
  ["dry-only left on", /^FUNDING_DRY_ONLY = "0"/m, 'FUNDING_DRY_ONLY = "1"'],
  ["origin missing", /^FUNDING_ALLOWED_ORIGINS = .*$/m, 'FUNDING_ALLOWED_ORIGINS = "https://praetorial.com"'],
  ["wrong 1Click URL", /^ONECLICK_BASE_URL = .*$/m, 'ONECLICK_BASE_URL = "https://1click.example"'],
  ["a 5-token list", /^BETTING_ASSET_IDS = "[^,]+,/m, 'BETTING_ASSET_IDS = "'],
  ["a foreign bet token", /nep141:zec\.omft\.near"/m, 'nep141:evil.near"'],
] as const) {
  test(`F1: funding ${what} is a finding`, () => {
    const t = real(); sub(t, "funding", from as RegExp, to as string);
    assert.ok(checkMainnetReady(t).some((f) => f.startsWith("funding:")), what);
  });
}
