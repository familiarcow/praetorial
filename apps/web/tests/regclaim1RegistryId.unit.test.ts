// REGCLAIM1: the NEP-413 recipient the web signs must equal the REGISTRY_ID the deployed registry Worker verifies against
// (else every claim is 401 bad_signature). Pins the web's per-network registryId to services/workers/registry/wrangler.toml.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORKS } from "../lib/network";

const toml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../services/workers/registry/wrangler.toml"), "utf8");
const [top] = toml.split("[env.mainnet");
const idOf = (s: string) => /^REGISTRY_ID\s*=\s*"([^"]+)"/m.exec(s)![1];
test("testnet web registryId == testnet Worker REGISTRY_ID", () => assert.equal(NETWORKS.testnet.registryId, idOf(top)));
test("mainnet web registryId == mainnet Worker REGISTRY_ID", () => assert.equal(NETWORKS.mainnet.registryId, idOf(toml.slice(toml.indexOf("[env.mainnet")))));
test("registry ids are non-empty and distinct per network", () => {
  assert.ok(NETWORKS.testnet.registryId && NETWORKS.mainnet.registryId);
  assert.notEqual(NETWORKS.testnet.registryId, NETWORKS.mainnet.registryId);
});
