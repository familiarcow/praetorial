// WEBNET1 (D-WEBNET1): one network table (lib/network.ts) for every chain/service address the web uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { NETWORKS, NETWORK, resolveNetwork } from "../lib/network";
import { assetId } from "../lib/assets";

const WEB = new URL("..", import.meta.url).pathname;
const ROOT = join(WEB, "..", "..");
const read = (p: string) => readFileSync(p, "utf8");
const tomlVals = (file: string, key: string) =>
  [...read(join(ROOT, file)).matchAll(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "gm"))].map((m) => m[1]);

test("table has exactly testnet and mainnet; NETWORK defaults to testnet and re-exports from config", async () => {
  assert.deepEqual(Object.keys(NETWORKS).sort(), ["mainnet", "testnet"]);
  if (!process.env.NETWORK_ID && !process.env.VITE_NETWORK_ID) assert.equal(NETWORK.networkId, "testnet");
  assert.equal(resolveNetwork({}).networkId, "testnet");
  assert.equal(resolveNetwork({ NETWORK_ID: "mainnet" }).networkId, "mainnet");
  assert.equal(resolveNetwork({ VITE_NETWORK_ID: "mainnet" }).networkId, "mainnet");
  assert.throws(() => resolveNetwork({ NETWORK_ID: "mainet" }));
  const cfg = await import("../lib/config");
  assert.equal(cfg.ESCROW_CONTRACT_ID, NETWORK.escrow);
  assert.equal(cfg.INTENTS_CONTRACT_ID, NETWORK.intents);
  assert.equal(cfg.USDC_TOKEN_ID, NETWORK.usdcTokenId);
  assert.equal(cfg.FUNDER_ID, NETWORK.funderId);
  assert.equal(cfg.INDEXER_URL, NETWORK.indexerUrl);
  assert.equal(cfg.NEAR_RPC_URL, NETWORK.rpcUrl);
  const rc = await import("../lib/relayerClient");
  assert.equal(rc.RELAYER_URL, NETWORK.relayerUrl);
});

test("env overrides win per field, on both networks; empty override ignored", () => {
  const o = resolveNetwork({
    NETWORK_ID: "mainnet", NEAR_RPC_URL: "https://rpc.example", ESCROW_CONTRACT_ID: "e.example", INTENTS_CONTRACT_ID: "i.example",
    USDC_TOKEN_ID: "nep141:u.example", FUNDER_ID: "f.example", INDEXER_URL: "https://idx.example", RELAYER_URL: "https://rly.example",
    REGISTRY_URL: "https://reg.example", REGISTRY_ID: "r.example",
  });
  assert.equal(o.rpcUrl, "https://rpc.example"); assert.equal(o.escrow, "e.example"); assert.equal(o.intents, "i.example");
  assert.equal(o.usdcTokenId, "nep141:u.example"); assert.equal(o.funderId, "f.example"); assert.equal(o.indexerUrl, "https://idx.example");
  assert.equal(o.relayerUrl, "https://rly.example"); assert.equal(o.registryUrl, "https://reg.example"); assert.equal(o.registryId, "r.example");
  assert.equal(resolveNetwork({ VITE_INDEXER_URL: "http://localhost:8787" }).indexerUrl, "http://localhost:8787");
  assert.equal(resolveNetwork({ VITE_RELAYER_URL: "http://localhost:8788" }).relayerUrl, "http://localhost:8788");
  assert.equal(resolveNetwork({ INDEXER_URL: "" }).indexerUrl, NETWORKS.testnet.indexerUrl);
});

test("testnet entry equals the frozen release + Worker configs", () => {
  const t = NETWORKS.testnet;
  const freeze = JSON.parse(read(join(ROOT, "release/freeze-candidate-2.json")));
  assert.equal(t.escrow, freeze.testnet_escrow.account);
  for (const f of ["services/workers/relayer/wrangler.toml", "services/workers/keeper/wrangler.toml"]) {
    assert.equal(t.intents, tomlVals(f, "INTENTS_CONTRACT_ID")[0], f);
  }
  const fund = tomlVals("services/workers/relayer/wrangler.toml", "FUND_TOKEN_CONTRACTS")[0].split(",");
  assert.deepEqual(t.fundTokens, fund);
  assert.ok(fund.map((c) => `nep141:${c}`).includes(t.usdcTokenId));
  assert.equal(t.usdcTokenId, assetId("USDC", "testnet"));
  assert.equal(t.indexerUrl, "https://praetorial-indexer-testnet.familiarcow.workers.dev");
  assert.equal(t.relayerUrl, "https://praetorial-relayer-testnet.familiarcow.workers.dev");
  assert.equal(t.registryUrl, "https://praetorial-registry-testnet.familiarcow.workers.dev");
  assert.ok(read(join(ROOT, "services/workers/indexer/README.md")).includes(t.indexerUrl));
  assert.ok(read(join(ROOT, "services/e2e/live-CF1e/STATUS.md")).includes(t.relayerUrl));
  assert.equal(t.rpcUrl, "https://test.rpc.fastnear.com");
  assert.equal(t.funderId, "praetorial-dev-1101.testnet");
  for (const [k, v] of Object.entries(t)) assert.ok(v !== "" && !(Array.isArray(v) && v.length === 0), `testnet.${k} set`);
});

test("mainnet entry: real ids, no testnet string, Worker URLs empty", () => {
  const m = NETWORKS.mainnet;
  assert.equal(m.escrow, "bets.praetorial.near");
  assert.equal(m.intents, "intents.near");
  assert.equal(m.intents, tomlVals("services/workers/relayer/wrangler.toml", "INTENTS_CONTRACT_ID")[1]);
  const rpcSrc = read(join(ROOT, "services/common/src/rpc.ts"));
  assert.equal(m.rpcUrl, rpcSrc.match(/DEFAULT_MAINNET_RPC_URL\s*=\s*"([^"]+)"/)![1]);
  assert.equal(m.usdcTokenId, assetId("USDC", "mainnet"));
  assert.equal(m.usdcTokenId, "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  assert.deepEqual(m.fundTokens, tomlVals("services/workers/relayer/wrangler.toml", "FUND_TOKEN_CONTRACTS")[1].split(","));
  assert.equal(JSON.stringify(m).toLowerCase().includes("testnet"), false, "no testnet string in mainnet entry");
  assert.equal(m.indexerUrl, ""); assert.equal(m.relayerUrl, "");
  // REG1: the mainnet registry is live; tests/reg1MainnetRegistry.unit.test.ts pins the URL and the gate.
  assert.equal(m.registryUrl, "https://registry.praetorial.com");
  assert.equal(resolveNetwork({ NETWORK_ID: "mainnet" }).registryUrl, m.registryUrl);
});

test("mainnet service callers fail closed with 'service not configured' (no fetch, no testnet fallback)", () => {
  const code = `
    globalThis.fetch = () => { throw new Error("FETCH CALLED"); };
    const out = {};
    const { relaySignedDelegate } = await import("./lib/relayerClient");
    out.relay = await relaySignedDelegate("AAAA");
    const { fetchOpenOffers } = await import("./lib/indexerClient");
    try { await fetchOpenOffers(); out.idx = "no throw"; } catch (e) { out.idx = String(e.message); }
    console.log("OUT" + JSON.stringify(out));`;
  const r = spawnSync(join(WEB, "node_modules/.bin/tsx"), ["--input-type=module", "-e", code], {
    cwd: WEB, encoding: "utf8", env: { ...process.env, NETWORK_ID: "mainnet", INDEXER_URL: "", RELAYER_URL: "", VITE_INDEXER_URL: "", VITE_RELAYER_URL: "" },
  });
  const line = r.stdout.split("\n").find((l) => l.startsWith("OUT"));
  assert.ok(line, `no output: ${r.stderr}`);
  const out = JSON.parse(line.slice(3));
  assert.equal(out.relay.ok, false);
  assert.match(out.relay.error, /service not configured/i);
  assert.match(out.idx, /service not configured/i);
});

function walk(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(n)) acc.push(p);
  }
  return acc;
}

test("no module outside the table hardcodes a *.testnet/*.near account, a worker URL, or a localhost service default", () => {
  // F5: lib/funding/chainAddress.ts + intentCheck.ts are byte copies of the funding Worker's services/common/src/funding/* (test-enforced in
  // tests/funding/f5Shared.unit.test.ts); their "intents.near" / ".omft.near" are the protocol's own fixed names (mainnet-only), not config.
  const allow = new Set(["lib/network.ts", "lib/networkSelect.ts", "lib/assets.ts", "lib/assetLimits.generated.ts", "lib/refereeRegistry.ts", "lib/funding/chainAddress.ts", "lib/funding/intentCheck.ts"]);
  const files = [...walk(join(WEB, "lib")), ...walk(join(WEB, "src")), ...walk(join(WEB, "functions"))].filter((f) => !allow.has(f.slice(WEB.length)));
  const bad: string[] = [];
  for (const f of files) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").split("\n");
    src.forEach((line, i) => {
      const code = line.replace(/(^|[^:])\/\/.*$/, "$1");
      if (/placeholder=/.test(code)) return; // UI hint text, not an address in use
      if (/\.(testnet|near)\b/.test(code) || /workers\.dev/.test(code) || /localhost:878\d/.test(code)) bad.push(`${f.slice(WEB.length)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});

// BET1b+BET1c merge: the create form reads the escrow id only in StakeSection (asset_limit view); CreateOffer itself holds no ids now.
test("consumers read ids from config/network, not their own copies", () => {
  for (const f of ["lib/escrowAdapter.ts", "lib/storageCharge.ts", "lib/judgeChain.ts", "src/App.tsx", "src/components/StakeSection.tsx", "src/components/MyBets.tsx", "src/components/BetPage.tsx", "src/components/RefereeChange.tsx", "src/components/CancelOffer.tsx"]) {
    assert.match(read(join(WEB, f)), /from "\.\.?\/(\.\.\/)?lib\/(config|network)"|from "\.\/(config|network)"/, f);
  }
});

// NOKEY1b: the testnet web build targets the frz3 escrow (resolver 8791413f), the same id the testnet Workers use.
test("NOKEY1b: testnet web escrow is frz3 and equals the keeper Worker's ESCROW_CONTRACT_ID", async () => {
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(new URL("../../../services/workers/keeper/wrangler.toml", import.meta.url), "utf8");
  const top = toml.split(/^\[env\.mainnet\]/m)[0];
  assert.equal(NETWORKS.testnet.escrow, "praetorial-frz3-2611100414.praetorial-dev-1101.testnet");
  assert.equal(/^ESCROW_CONTRACT_ID\s*=\s*"([^"]+)"/m.exec(top)![1], NETWORKS.testnet.escrow);
});
