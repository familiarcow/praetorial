// CF1e: the committed wrangler.toml files are a real TESTNET deployment config (no placeholders, safe names,
// <= 5 cron triggers account-wide, no key material). Public account ids only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_MAINNET_WEB_ORIGIN } from "../src/mainnetReady.js";

const WORKERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NAMES = ["keeper", "relayer", "monitor", "notifier", "indexer"];
const toml = Object.fromEntries(NAMES.map((n) => [n, fs.readFileSync(path.join(WORKERS, n, "wrangler.toml"), "utf8")]));
// WKMAIN1: a wrangler.toml now also carries an [env.mainnet] block set. The CF1e testnet assertions below are about the
// top-level (testnet) config only, so `active` drops every [env.mainnet*] section; the mainnet cases use `mainnetOf`.
const isMainnetHeader = (l: string) => /^\s*\[\[?env\.mainnet[\].]/.test(l);
const isHeader = (l: string) => /^\s*\[/.test(l);
const stripMainnet = (t: string) => { let skip = false; return t.split("\n").filter((l) => { if (isHeader(l)) skip = isMainnetHeader(l); return !skip; }).join("\n"); };
const mainnetOf = (t: string) => { let take = false; return t.split("\n").filter((l) => { if (isHeader(l)) take = isMainnetHeader(l); return take; }).join("\n"); };
const active = (t: string) => stripMainnet(t).split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
const nameOf = (t: string) => /^name\s*=\s*"([^"]+)"/m.exec(t)![1];

test("no REPLACE_* placeholders remain in any wrangler.toml", () => {
  for (const n of NAMES) assert.doesNotMatch(active(toml[n]), /REPLACE_/, `${n}/wrangler.toml still has a placeholder`);
});
test("worker names are praetorial-<svc>-testnet and never an existing foreign worker", () => {
  for (const n of NAMES) {
    assert.equal(nameOf(toml[n]), `praetorial-${n}-testnet`);
    assert.doesNotMatch(nameOf(toml[n]), /bondclinical|gogardenstate/);
  }
});
test("total cron triggers across all Workers <= 5 (free plan), exactly the one shared dispatcher", () => {
  let total = 0;
  for (const n of NAMES) for (const m of active(toml[n]).matchAll(/crons\s*=\s*\[([^\]]*)\]/g)) total += m[1].split(",").map((s) => s.trim()).filter(Boolean).length;
  assert.ok(total <= 5, `cron triggers ${total} > 5`);
  assert.equal(total, 1);
});
test("every service binding targets one of our testnet Workers", () => {
  const targets = new Set(NAMES.map((n) => nameOf(toml[n])));
  for (const n of NAMES) for (const m of active(toml[n]).matchAll(/service\s*=\s*"([^"]+)"/g)) assert.ok(targets.has(m[1]), `${n}: unknown service ${m[1]}`);
});
test("NEAR_NETWORK_ID is testnet everywhere; ESCROW_CONTRACT_ID is the NOKEY1b frz3 escrow (resolver 8791413f)", () => {
  for (const n of NAMES) {
    assert.match(active(toml[n]), /NEAR_NETWORK_ID\s*=\s*"testnet"/);
    assert.match(active(toml[n]), /ESCROW_CONTRACT_ID\s*=\s*"praetorial-frz3-2611100414\.praetorial-dev-1101\.testnet"/);
  }
});
// NOKEY1b (D-UPGRADE1): frz2's in-flight bets (DR1, DR7, bets 19-26) still need keeper payouts and notifications, so keeper,
// indexer and notifier carry the multi-contract list, frz3 first (the primary), frz2 second. Same frozen escrow source: both v1.
test("NOKEY1b: keeper/indexer/notifier ESCROW_CONTRACTS = frz3 then frz2 (D-UPGRADE1); relayer/monitor follow frz3 only", () => {
  const want = "praetorial-frz3-2611100414.praetorial-dev-1101.testnet@v1,praetorial-frz2-2611091914.praetorial-dev-1101.testnet@v1";
  for (const n of ["keeper", "indexer", "notifier"]) assert.match(active(toml[n]), new RegExp(`^ESCROW_CONTRACTS\\s*=\\s*"${want.replace(/\./g, "\\.")}"`, "m"), `${n} ESCROW_CONTRACTS`);
  for (const n of ["relayer", "monitor"]) assert.doesNotMatch(active(toml[n]), /ESCROW_CONTRACTS/, `${n} does not read the multi-contract list`);
});
test("no key or token material in any wrangler.toml", () => {
  for (const n of NAMES) {
    assert.doesNotMatch(toml[n], /ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/);
    assert.doesNotMatch(toml[n], /\d{8,}:[A-Za-z0-9_-]{30,}/); // telegram bot token shape
  }
});
test("indexer D1 database_id is a real uuid", () => {
  assert.match(active(toml.indexer), /database_id\s*=\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/);
});

// CF1f: the registry Worker (D-REGW1) is a testnet deployment too: own D1, no secrets (REGISTRY_ID is a public NEP-413 recipient), no cron.
test("registry wrangler.toml: praetorial-registry-testnet + D1 praetorial-registry-testnet (real uuid), secret-free, no cron, testnet", () => {
  const t = fs.readFileSync(path.join(WORKERS, "registry", "wrangler.toml"), "utf8"), a = active(t);
  assert.equal(nameOf(t), "praetorial-registry-testnet");
  assert.doesNotMatch(nameOf(t), /bondclinical|gogardenstate/);
  assert.match(a, /database_name\s*=\s*"praetorial-registry-testnet"/);
  assert.match(a, /database_id\s*=\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/);
  assert.doesNotMatch(a, /REPLACE_|crons\s*=/);
  assert.match(a, /NEAR_NETWORK_ID\s*=\s*"testnet"/);
  assert.doesNotMatch(t, /ed25519:[1-9A-HJ-NP-Za-km-z]{40,}|\d{8,}:[A-Za-z0-9_-]{30,}/);
});

// ---------------------------------------------------------------------------------------------------------------------
// WKMAIN1 (D-WKMAIN1): [env.mainnet] draft per Worker. Drafted now, deployed only on familiarcow's go (GATE-11). No deploy here.
// Wrangler `env` sections do not inherit vars / d1 / triggers / services / DO bindings / migrations, so each is listed in full.
// ---------------------------------------------------------------------------------------------------------------------
const ALL = [...NAMES, "registry", "sourcecheck"];
const MAINNET_RPC = "https://free.rpc.fastnear.com"; // services/common/src/rpc.ts DEFAULT_MAINNET_RPC_URL (checked below)
const mtoml = Object.fromEntries(ALL.map((n) => [n, fs.readFileSync(path.join(WORKERS, n, "wrangler.toml"), "utf8")]));
const mn = (n: string) => mainnetOf(mtoml[n]).split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
const varOf = (n: string, k: string) => new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m").exec(mn(n))?.[1];
// Mainnet D1/KV ids that do not exist until deploy day: the ONLY allowed placeholders (deploy-day gate below).
// MAINPREP1: both mainnet D1 databases were created 2026-11-10 (empty) and their uuids filled in, so no DEPLOY_DAY_* remains.
const KNOWN_PLACEHOLDERS: string[] = [];
const MAINNET_D1_IDS = { indexer: "cef6ee27-67bf-4d3c-8ab3-f77e20e21409", registry: "0ce99891-f3bc-401e-b3db-26fb5a995115" } as const;

test("mainnet: DEFAULT_MAINNET_RPC_URL in services/common matches the URL these tests expect", () => {
  assert.match(fs.readFileSync(path.resolve(WORKERS, "../common/src/rpc.ts"), "utf8"), new RegExp(`DEFAULT_MAINNET_RPC_URL\\s*=\\s*"${MAINNET_RPC}"`));
});
test("mainnet: every Worker has an [env.mainnet] section named praetorial-<svc>-mainnet", () => {
  for (const n of ALL) {
    assert.match(mtoml[n], /^\[env\.mainnet\]/m, `${n}: no [env.mainnet] section`);
    assert.equal(varOf(n, "name"), `praetorial-${n}-mainnet`);
    assert.doesNotMatch(varOf(n, "name") ?? "", /bondclinical|gogardenstate/);
    assert.match(mn(n), /main\s*=\s*"src\/index\.ts"/);
    assert.match(mn(n), /compatibility_date\s*=\s*"2026-01-01"/);
  }
});
test("mainnet: ESCROW_CONTRACT_ID bets.praetorial.near (D-KEYS2), INTENTS_CONTRACT_ID intents.near, NEAR_NETWORK_ID mainnet (D-LAUNCHCFG1)", () => {
  for (const n of ["keeper", "relayer", "monitor", "notifier", "indexer"]) {
    assert.equal(varOf(n, "NEAR_NETWORK_ID"), "mainnet", n);
    assert.equal(varOf(n, "ESCROW_CONTRACT_ID"), "bets.praetorial.near", n);
    assert.equal(varOf(n, "INTENTS_CONTRACT_ID"), "intents.near", n);
  }
  assert.equal(varOf("sourcecheck", "ESCROW_CONTRACT_ID"), "bets.praetorial.near");
  assert.equal(varOf("registry", "NEAR_NETWORK_ID"), "mainnet");
});
test("mainnet: RPC is the mainnet default URL wherever a Worker reads one", () => {
  for (const n of ["keeper", "monitor", "notifier", "indexer", "registry"]) assert.equal(varOf(n, "NEAR_RPC_URL"), MAINNET_RPC, n);
});
test("mainnet: account ids per D-LAUNCHCFG1 / GATE-07 / D-RCFG1 (keeper, relayer, fee, registry)", () => {
  assert.equal(varOf("keeper", "KEEPER_ACCOUNT_ID"), "keeper.praetorial.near");
  assert.equal(varOf("monitor", "KEEPER_ACCOUNT_ID"), "keeper.praetorial.near");
  assert.equal(varOf("monitor", "FEE_ACCOUNT_ID"), "praetorial.near");
  assert.equal(varOf("relayer", "RELAYER_ACCOUNT_ID"), "relayer.praetorial.near"); // proposed name, D-RCFG1 item 3
  assert.equal(varOf("registry", "REGISTRY_ID"), "registry.praetorial.near");
  // DOM1: the web is https://praetorial.com (www 301s to it); the workers.dev origin stays allowed until the cutover is confirmed (TODO-REMOVE).
  assert.equal(varOf("registry", "REGISTRY_CORS_ORIGINS"), `https://praetorial.com,https://www.praetorial.com,${LEGACY_MAINNET_WEB_ORIGIN}`); // Privy-allowed origins, GATE-08
});
test("mainnet: relayer FUND_TOKEN_CONTRACTS = the six D-ZEC1/D-LAUNCHCFG1 launch assets (apps/web/lib/assets.ts mainnet ids), WNEAR wrap.near", () => {
  const web = fs.readFileSync(path.resolve(WORKERS, "../../apps/web/lib/assets.ts"), "utf8");
  const fund = (varOf("relayer", "FUND_TOKEN_CONTRACTS") ?? "").split(",").map((s) => s.trim());
  assert.deepEqual([...fund].sort(), [
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "btc.omft.near", "eth.omft.near", "usdt.tether-token.near", "wrap.near", "zec.omft.near",
  ].sort());
  for (const id of fund) assert.ok(web.includes(`mainnet:`) && web.includes(`nep141:${id}`), `${id} not in assets.ts mainnet column`);
  assert.equal(varOf("relayer", "WNEAR_CONTRACT_ID"), "wrap.near");
});
test("mainnet sections never mention testnet, REPLACE_ or key/token material", () => {
  for (const n of ALL) {
    const raw = mainnetOf(mtoml[n]);
    assert.ok(raw.length > 0, `${n}: empty mainnet section`);
    assert.doesNotMatch(raw, /testnet/i, `${n}: mainnet section mentions testnet`);
    assert.doesNotMatch(raw, /REPLACE_/);
    assert.doesNotMatch(raw, /ed25519:[1-9A-HJ-NP-Za-km-z]{40,}|\d{8,}:[A-Za-z0-9_-]{30,}/);
  }
});
test("mainnet: cron triggers <= 5 per Worker (Free plan, D-HOST3); exactly the keeper dispatcher, none elsewhere", () => {
  for (const n of ALL) {
    let c = 0;
    for (const m of mn(n).matchAll(/crons\s*=\s*\[([^\]]*)\]/g)) c += m[1].split(",").map((s) => s.trim()).filter(Boolean).length;
    assert.ok(c <= 5, `${n}: ${c} crons`);
    assert.equal(c, n === "keeper" ? 1 : 0, n);
  }
});
test("mainnet: keeper service bindings target the mainnet Workers; DO bindings + migrations are listed in the env section (no inheritance)", () => {
  const targets = new Set(NAMES.map((n) => `praetorial-${n}-mainnet`));
  const bound = [...mn("keeper").matchAll(/service\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(bound.sort(), ["praetorial-indexer-mainnet", "praetorial-monitor-mainnet", "praetorial-notifier-mainnet", "praetorial-relayer-mainnet"]);
  for (const b of bound) assert.ok(targets.has(b));
  for (const [n, cls] of [["keeper", "KeeperDO"], ["relayer", "RelayerDO"], ["monitor", "MonitorDO"], ["notifier", "NotifierDO"]] as const) {
    assert.match(mn(n), new RegExp(`class_name\\s*=\\s*"${cls}"`), `${n}: DO binding`);
    assert.match(mn(n), new RegExp(`new_sqlite_classes\\s*=\\s*\\["${cls}"\\]`), `${n}: migration`);
  }
  for (const n of ["monitor", "notifier"]) assert.match(mn(n), /workers_dev\s*=\s*false/);
});
test("mainnet: indexer + registry D1 bindings are listed in the env section, named praetorial-<svc>-mainnet, with migrations_dir", () => {
  for (const [n, b] of [["indexer", "INDEXER_DB"], ["registry", "REGISTRY_DB"]] as const) {
    assert.match(mn(n), new RegExp(`binding\\s*=\\s*"${b}"`));
    assert.match(mn(n), new RegExp(`database_name\\s*=\\s*"praetorial-${n}-mainnet"`));
    assert.match(mn(n), /migrations_dir\s*=\s*"migrations"/);
  }
});
test("mainnet placeholders are exactly the known DEPLOY_DAY_* set (now none) and the D1 ids are the created uuids (always on)", () => {
  const found = new Set<string>();
  for (const n of ALL) for (const m of mainnetOf(mtoml[n]).matchAll(/DEPLOY_DAY_[A-Z0-9_]+/g)) found.add(m[0]);
  assert.deepEqual([...found].sort(), [...KNOWN_PLACEHOLDERS].sort());
  assert.doesNotMatch(active(mtoml.indexer) + active(mtoml.registry), /DEPLOY_DAY_/, "placeholders leaked into the testnet config");
  for (const n of ["indexer", "registry"] as const) assert.equal(varOf(n, "database_id"), MAINNET_D1_IDS[n], n);
});
// WKMAIN1b: the old skipped "mainnet config is deploy-ready" test is replaced by checkMainnetReady() (src/mainnetReady.ts),
// pinned in mainnetReady.test.ts and run on deploy day via `node --import tsx workers/scripts/check-mainnet-ready.mjs`
// (exit 1 while any DEPLOY_DAY_* / REPLACE_ / non-uuid D1 id remains). Its assertions live in that function.

// relayer/monitor default USDC_TOKEN_ID to usdc.fakes.testnet (src/env.ts), so mainnet must set it explicitly.
test("mainnet: relayer + monitor set USDC_TOKEN_ID to the mainnet USDC contract (their code default is a testnet id)", () => {
  assert.equal(varOf("relayer", "USDC_TOKEN_ID"), "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"); // relayer src reads it but no code path uses it (STAKE_ASSET_IDS decides)
  // MAINPREP1: the monitor calls intents.near mt_balance_of with it, which returns "0" for a bare id: it needs the nep141: prefix (as on testnet).
  assert.equal(varOf("monitor", "USDC_TOKEN_ID"), "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
});

// LIVE1 defect 1: the relayer must accept a stake in EVERY asset the escrow enables, configured in wrangler.toml (not a code default).
const stakeIdsOf = (t: string) => (/^STAKE_ASSET_IDS\s*=\s*"([^"]*)"/m.exec(t)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
test("relayer: STAKE_ASSET_IDS set for testnet (usdc + wNEAR) and mainnet (the six launch assets), nep141:-prefixed", () => {
  assert.deepEqual(stakeIdsOf(active(toml.relayer)), ["nep141:usdc.testnet", "nep141:wrap.testnet"]);
  assert.deepEqual(stakeIdsOf(mainnetOf(toml.relayer)), [
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "nep141:usdt.tether-token.near", "nep141:btc.omft.near",
    "nep141:wrap.near", "nep141:eth.omft.near", "nep141:zec.omft.near",
  ]);
});
test("testnet: relayer + monitor USDC_TOKEN_ID is the real testnet USDC asset (their code default usdc.fakes.testnet is not on this stack)", () => {
  for (const n of ["relayer", "monitor"]) assert.equal(/^USDC_TOKEN_ID\s*=\s*"([^"]*)"/m.exec(active(toml[n]))?.[1], "nep141:usdc.testnet", n);
});
test("LIVE1: testnet monitor watches the relayer account balance (it ran dry on 2026-11-09 and every relay failed)", () => {
  assert.match(/^CREDIT_WATCH\s*=\s*"([^"]*)"/m.exec(active(toml.monitor))?.[1] ?? "", /relayer\.praetorial-dev-1101\.testnet:\d{25,}/);
});
