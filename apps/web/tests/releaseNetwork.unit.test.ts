// MAINPREP (1): release pins are network-selected at build time. A mainnet build must not compare the RPC chain id to
// "testnet" (outOfDateReason "network") nor use the testnet fee account in referee checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import testnetRelease from "../lib/release.json";
import mainnetRelease from "../lib/release.mainnet.json";
import { releasePins, releaseFeeAccount, loadReleaseConfig } from "../lib/releaseConfig";
import { outOfDateReason } from "../lib/globalStates";

const here = dirname(fileURLToPath(import.meta.url));
const draft = (n: string) => JSON.parse(readFileSync(join(here, `../../../release/draft-args.${n}.json`), "utf8"));

test("release.mainnet.json: network mainnet, praetorial.near, same resolver/record/models as testnet", () => {
  assert.equal(mainnetRelease.network, "mainnet");
  assert.equal(mainnetRelease.fee_account, "praetorial.near");
  assert.equal(mainnetRelease.resolver_wasm_hash, "8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473");
  assert.equal(mainnetRelease.resolver_wasm_hash, testnetRelease.resolver_wasm_hash);
  assert.equal(mainnetRelease.release_record, testnetRelease.release_record);
  assert.deepEqual(mainnetRelease.models, testnetRelease.models);
});

test("parity: release.mainnet.json resolver_wasm_hash and fee_account equal release/draft-args.mainnet.json", () => {
  const a = draft("mainnet");
  assert.equal(mainnetRelease.resolver_wasm_hash, a.resolver_wasm_hash);
  assert.equal(mainnetRelease.fee_account, a.fee_account);
  assert.doesNotMatch(JSON.stringify(mainnetRelease), /testnet|praetorial-dev-1101/);
});

test("parity: release.json (testnet) resolver_wasm_hash and fee_account equal release/draft-args.testnet.json", () => {
  const a = draft("testnet");
  assert.equal(testnetRelease.resolver_wasm_hash, a.resolver_wasm_hash);
  assert.equal(testnetRelease.fee_account, a.fee_account);
});

test("releasePins selects by NETWORK_ID / VITE_NETWORK_ID (default testnet); unknown network throws", () => {
  assert.equal(releasePins({}).network, "testnet");
  assert.equal(releasePins({ NETWORK_ID: "testnet" }).fee_account, "fee.praetorial-dev-1101.testnet");
  assert.equal(releasePins({ NETWORK_ID: "mainnet" }).network, "mainnet");
  assert.equal(releasePins({ VITE_NETWORK_ID: "mainnet" }).fee_account, "praetorial.near");
  assert.equal(releaseFeeAccount({ VITE_NETWORK_ID: "mainnet" }), "praetorial.near");
  assert.equal(releaseFeeAccount({}), "fee.praetorial-dev-1101.testnet");
  assert.throws(() => releasePins({ NETWORK_ID: "devnet" }), /unknown NETWORK_ID/);
});

test("loadReleaseConfig() default follows the build env: mainnet build is not 'out of date' on a mainnet RPC", () => {
  const saved = { a: process.env.NETWORK_ID, b: process.env.VITE_NETWORK_ID };
  try {
    process.env.NETWORK_ID = "mainnet";
    const rel = loadReleaseConfig();
    assert.equal(rel.network, "mainnet");
    assert.equal(rel.fee_account, "praetorial.near");
    assert.equal(outOfDateReason(rel, { chainId: "mainnet" }), null);
    assert.equal(outOfDateReason(rel, { chainId: "testnet" }), "network");
    assert.equal(releaseFeeAccount(), "praetorial.near");
  } finally {
    if (saved.a === undefined) delete process.env.NETWORK_ID; else process.env.NETWORK_ID = saved.a;
    if (saved.b === undefined) delete process.env.VITE_NETWORK_ID; else process.env.VITE_NETWORK_ID = saved.b;
  }
  if (!process.env.NETWORK_ID && !process.env.VITE_NETWORK_ID) assert.equal(loadReleaseConfig().network, "testnet");
});

test("no app code imports a release json directly; components read the fee account through releaseFeeAccount()", () => {
  for (const f of ["../src/components/CreateOffer.tsx", "../src/components/RefereeChange.tsx", "../src/App.tsx", "../lib/globalStates.ts", "../lib/openEnvelope.ts", "../lib/openPins.ts"]) {
    const src = readFileSync(join(here, f), "utf8");
    assert.doesNotMatch(src, /import\s+\w+\s+from\s+"[^"]*release(\.mainnet)?\.json"/, `${f} imports a release json`);
  }
  for (const f of ["../src/components/CreateOffer.tsx", "../src/components/RefereeChange.tsx"]) {
    assert.match(readFileSync(join(here, f), "utf8"), /releaseFeeAccount\(\)/, `${f} must use releaseFeeAccount()`);
  }
});
