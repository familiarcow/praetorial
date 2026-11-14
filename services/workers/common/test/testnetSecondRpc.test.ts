// CS1 (health check, 2026-11-11): 15 testnet bets that are Settled on chain showed "settling, confirming" forever on the site.
// D-DSY1: the indexer and the notifier show/announce a terminal outcome only after a SECOND RPC (rpcUrls[1] = the first
// NEAR_RPC_FALLBACKS entry) agrees. The mainnet config is guarded by mainnetReady's night checks; the testnet config had no
// NEAR_RPC_FALLBACKS at all, so every terminal bet stayed redacted ("unconfigured") and no settle notice was ever sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWranglerToml } from "../src/stackCheck.js";
import { DEFAULT_TESTNET_RPC_URL } from "../../../common/src/rpc.js";

const WORKERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };

for (const n of ["indexer", "notifier"]) {
  test(`CS1: testnet ${n} has an independent second RPC (D-DSY1), or Settled/Voided bets stay "settling, confirming" forever`, () => {
    const v = parseWranglerToml(fs.readFileSync(path.join(WORKERS, n, "wrangler.toml"), "utf8"), "testnet").vars;
    assert.equal(v.NEAR_NETWORK_ID, "testnet");
    const fb = (v.NEAR_RPC_FALLBACKS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    assert.ok(fb.length > 0, `${n}: [vars] NEAR_RPC_FALLBACKS missing on testnet`);
    const primary = v.NEAR_RPC_URL || DEFAULT_TESTNET_RPC_URL;
    assert.notEqual(host(fb[0]!), host(primary), `${n}: NEAR_RPC_FALLBACKS[0] must be a different host than the primary ${primary}`);
    for (const u of fb) assert.match(u, /^https:\/\//, `${n}: fallback ${u} must be https`);
    const MAINNET_HOSTS = ["rpc.mainnet.near.org", "free.rpc.fastnear.com", "rpc.intea.rs", "rpc.fastnear.com"];
    assert.ok(!fb.some((u) => MAINNET_HOSTS.includes(host(u))), `${n}: a testnet fallback must not be a mainnet RPC`);
  });
}
