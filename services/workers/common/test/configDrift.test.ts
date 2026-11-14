// LIVE1 config-drift guard: apps/web/lib/network.ts NETWORKS vs every services/workers/*/wrangler.toml (testnet [vars], mainnet [env.mainnet.vars]).
// Defect it guards: the web site was built from a network.ts naming an old escrow while every Worker used the new one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkConfigDrift, parseStringConsts, parseWebNetworks, workersDevName } from "../src/configDrift.js";
import { parseWranglerToml } from "../src/stackCheck.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCRIPT = path.join(REPO, "services/workers/scripts/check-config-drift.mjs");
const WORKERS = path.join(REPO, "services/workers");
const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
const realTomls = () => Object.fromEntries(fs.readdirSync(WORKERS).filter((d) => fs.existsSync(path.join(WORKERS, d, "wrangler.toml")))
  .map((d) => [d, fs.readFileSync(path.join(WORKERS, d, "wrangler.toml"), "utf8")]));
const real = () => ({ networkTs: read("apps/web/lib/network.ts"), networkSelectTs: read("apps/web/lib/networkSelect.ts"), tomls: realTomls(), parseToml: parseWranglerToml });

const CUR_ESCROW = parseWebNetworks(read("apps/web/lib/network.ts"), parseStringConsts(read("apps/web/lib/networkSelect.ts"))).testnet.escrow!;

test("the REAL repo files pass (web NETWORKS == every Worker wrangler.toml, testnet and mainnet)", () => {
  assert.deepEqual(checkConfigDrift(real()), []);
  assert.ok(Object.keys(realTomls()).length >= 8, "all eight Workers read (F1 adds funding)");
});

test("web network.ts naming an OLD testnet escrow -> drift reported against every Worker that declares ESCROW_CONTRACT_ID", () => {
  const r = real();
  const diffs = checkConfigDrift({ ...r, networkTs: r.networkTs.replace(`escrow: "${CUR_ESCROW}"`, `escrow: "praetorial-frz1-old.praetorial-dev-1101.testnet"`) });
  assert.ok(diffs.length >= 6, diffs.join("\n"));
  assert.ok(diffs.every((d) => d.startsWith("testnet: ") && /ESCROW_CONTRACT_ID/.test(d) && d.includes("praetorial-frz1-old")), diffs.join("\n"));
  for (const svc of ["indexer", "keeper", "monitor", "notifier", "relayer", "sourcecheck", "funding"]) assert.ok(diffs.some((d) => d.includes(`workers/${svc}/`)), svc);
});

test("one Worker with a stale testnet escrow -> exactly that Worker is reported", () => {
  const r = real();
  const tomls = { ...r.tomls, relayer: r.tomls.relayer!.replace(`ESCROW_CONTRACT_ID = "${CUR_ESCROW}"`, `ESCROW_CONTRACT_ID = "old.testnet"`) };
  const diffs = checkConfigDrift({ ...r, tomls });
  assert.equal(diffs.length, 1, diffs.join("\n"));
  assert.match(diffs[0]!, /^testnet: .*workers\/relayer\/wrangler\.toml \[vars\] ESCROW_CONTRACT_ID = "old\.testnet"/);
});

test("intents and registry id drift are reported; [env.mainnet] drift is reported as mainnet", () => {
  const r = real();
  const net = r.networkTs.replace(`intents: "intents-mock.praetorial-dev-1101.testnet"`, `intents: "intents-old.testnet"`)
    .replace(`registryId: "registry.praetorial.near"`, `registryId: "registry-old.near"`);
  const diffs = checkConfigDrift({ ...r, networkTs: net });
  assert.ok(diffs.some((d) => d.startsWith("testnet: ") && /INTENTS_CONTRACT_ID/.test(d)), diffs.join("\n"));
  assert.ok(diffs.some((d) => d.startsWith("mainnet: ") && /registry\/wrangler\.toml \[env\.mainnet\.vars\] REGISTRY_ID/.test(d)), diffs.join("\n"));
  const tomls = { ...r.tomls, indexer: r.tomls.indexer!.replace(/(\[env\.mainnet\.vars\][\s\S]*?ESCROW_CONTRACT_ID = )"bets\.praetorial\.near"/, `$1"escrow-old.near"`) };
  const d2 = checkConfigDrift({ ...r, tomls });
  assert.equal(d2.length, 1, d2.join("\n"));
  assert.match(d2[0]!, /^mainnet: .*indexer.*escrow-old\.near/);
});

test("Worker URLs: a web relayerUrl naming another Worker is drift; empty (mainnet: not configured) is skipped", () => {
  const r = real();
  const diffs = checkConfigDrift({ ...r, networkTs: r.networkTs.replace("praetorial-relayer-testnet.", "praetorial-relayer-old.") });
  assert.equal(diffs.length, 1, diffs.join("\n"));
  assert.match(diffs[0]!, /relayerUrl .* "praetorial-relayer-old" .* name = "praetorial-relayer-testnet"/);
  assert.equal(workersDevName("https://a-b.sub.workers.dev/x"), "a-b");
  assert.equal(workersDevName("/_proxy/relayer"), null);
});

test("vars a Worker does not declare are not compared; a Worker without [env.mainnet] is skipped for mainnet", () => {
  const toml = `name = "x-testnet"\n[vars]\nNEAR_NETWORK_ID = "testnet"\n`;
  const r = real();
  assert.deepEqual(checkConfigDrift({ ...r, tomls: { ...r.tomls, extra: toml } }), []);
});

test("an unreadable NETWORKS table fails closed", () => {
  const r = real();
  assert.match(checkConfigDrift({ ...r, networkTs: "export const X = 1;" })[0]!, /NETWORKS not found/);
  assert.match(checkConfigDrift({ ...r, networkTs: r.networkTs.replace(/\n\s*escrow: "[^"]*",/, "\n") })[0]!, /escrow not found/);
});

function runScript(cwd: string, extra: string[] = []) {
  const p = spawnSync(process.execPath, [SCRIPT, ...extra], { cwd, encoding: "utf8" });
  return { code: p.status, out: (p.stdout ?? "") + (p.stderr ?? "") };
}

test("script: plain node, any cwd, exits 0 on the real repo", () => {
  for (const cwd of [REPO, os.tmpdir()]) {
    const r = runScript(cwd);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /config-drift OK/);
  }
});

test("script: exits 1 with a diff message on a drifted copy of the repo inputs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfgdrift-"));
  try {
    fs.mkdirSync(path.join(tmp, "apps/web/lib"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "apps/web/lib/network.ts"), read("apps/web/lib/network.ts").replace(`escrow: "${CUR_ESCROW}"`, `escrow: "stale.testnet"`));
    fs.writeFileSync(path.join(tmp, "apps/web/lib/networkSelect.ts"), read("apps/web/lib/networkSelect.ts"));
    for (const [svc, text] of Object.entries(realTomls())) {
      fs.mkdirSync(path.join(tmp, "services/workers", svc), { recursive: true });
      fs.writeFileSync(path.join(tmp, "services/workers", svc, "wrangler.toml"), text);
    }
    const r = runScript(os.tmpdir(), ["--repo", tmp]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /CONFIG DRIFT/);
    assert.match(r.out, /NETWORKS\.testnet\.escrow = "stale\.testnet" but services\/workers\/relayer\/wrangler\.toml \[vars\] ESCROW_CONTRACT_ID/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("deploy-testnet.sh runs the drift guard before any wrangler deploy (set -e aborts on failure)", () => {
  const sh = read("services/workers/scripts/deploy-testnet.sh");
  const guard = sh.search(/node [^\n]*check-config-drift\.mjs/);
  assert.ok(guard > 0, "guard present");
  assert.ok(guard < sh.indexOf("npx wrangler deploy"), "guard before deploy");
  assert.match(sh, /set -euo pipefail/);
});

test("DOM1: a mainnet web URL on a custom domain must be that Worker's custom_domain route", () => {
  const r = real();
  const net = r.networkSelectTs.replace('MAINNET_REGISTRY_URL = "https://registry.praetorial.com"', 'MAINNET_REGISTRY_URL = "https://relayer.praetorial.com"');
  assert.notEqual(net, r.networkSelectTs);
  const diffs = checkConfigDrift({ ...r, networkSelectTs: net });
  assert.deepEqual(diffs, ['mainnet: apps/web NETWORKS.mainnet.registryUrl = "https://relayer.praetorial.com" is not a custom domain of services/workers/registry/wrangler.toml (routes: registry.praetorial.com)']);
});
