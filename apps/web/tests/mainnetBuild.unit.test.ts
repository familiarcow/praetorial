// MAINPREP (5): a mainnet bundle must carry no testnet account ids. vite defines __PRAETORIAL_BUILD_NETWORK__ (buildDefines) and the
// testnet-only tables are gated on it so Rollup drops them; in node/tests the constant is undefined and both networks stay available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDefines } from "../lib/networkSelect";
import { exampleAccount, resolveNetwork, NETWORKS } from "../lib/network";
import { assetId } from "../lib/assets";
import { releasePins } from "../lib/releaseConfig";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

test("buildDefines: the build network as a JSON string literal (default testnet); unknown network throws", () => {
  assert.deepEqual(buildDefines({ NETWORK_ID: "mainnet" }), { __PRAETORIAL_BUILD_NETWORK__: '"mainnet"' });
  assert.deepEqual(buildDefines({ VITE_NETWORK_ID: "mainnet" }), { __PRAETORIAL_BUILD_NETWORK__: '"mainnet"' });
  assert.deepEqual(buildDefines({}), { __PRAETORIAL_BUILD_NETWORK__: '"testnet"' });
  assert.throws(() => buildDefines({ NETWORK_ID: "x" }), /unknown NETWORK_ID/);
  assert.match(read("../vite.config.ts"), /define:\s*buildDefines\(/);
});

test("in node (no build define) both networks' tables stay available", () => {
  assert.ok(NETWORKS.testnet && NETWORKS.mainnet);
  assert.equal(assetId("USDC", "testnet"), "nep141:usdc.testnet");
  assert.equal(releasePins({ NETWORK_ID: "testnet" }).network, "testnet");
});

test("resolveNetwork fails closed when the selected network's table is not in this build", () => {
  const saved = NETWORKS.testnet;
  try {
    (NETWORKS as Record<string, unknown>).testnet = undefined;
    assert.throws(() => resolveNetwork({ NETWORK_ID: "testnet" }), /not in this build/);
    assert.equal(resolveNetwork({ NETWORK_ID: "mainnet" }).escrow, "bets.praetorial.near");
  } finally { NETWORKS.testnet = saved; }
});

test("exampleAccount: placeholder account ids follow the network (taker.near on mainnet)", () => {
  assert.equal(exampleAccount("taker", "mainnet"), "taker.near");
  assert.equal(exampleAccount("taker", "testnet"), "taker.testnet");
  for (const f of ["../src/components/CreateOffer.tsx", "../src/components/BetPage.tsx", "../src/components/RefereeChange.tsx"]) {
    assert.doesNotMatch(read(f), /placeholder="[^"]*\.testnet/, `${f} hard-codes a .testnet placeholder`);
  }
});

test("testnet-only tables are gated on the build define (dropped from a mainnet bundle)", () => {
  for (const f of ["../lib/network.ts", "../lib/assets.ts", "../lib/releaseConfig.ts", "../lib/refereeRegistry.ts"]) {
    assert.match(read(f), /MAINNET_ONLY_BUILD/, `${f} must gate its testnet table on MAINNET_ONLY_BUILD`);
  }
});

test("the gated NETWORKS table is still readable by the LIVE1 config-drift guard (deploy:testnet runs it first)", async () => {
  const { parseWebNetworks, parseStringConsts } = await import("../../../services/workers/common/src/configDrift");
  const nets = parseWebNetworks(read("../lib/network.ts"), parseStringConsts(read("../lib/networkSelect.ts")));
  assert.equal(nets.testnet.escrow, NETWORKS.testnet.escrow);
  assert.equal(nets.mainnet.escrow, "bets.praetorial.near");
  assert.equal(nets.mainnet.intents, "intents.near");
});
