// Shared helpers for the item-8 live testnet run. Never prints key material.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const { connect, keyStores, KeyPair, utils } = require("near-api-js");
export const NODE = process.env.NEAR_RPC_URL; // shared RPC config: set NEAR_RPC_URL (see services/common/src/rpc.ts); none hardcoded here
if (!NODE) throw new Error("set NEAR_RPC_URL");
export const CRED = `${process.env.HOME}/.near-credentials/testnet`;
export const OUT = new URL(".", import.meta.url).pathname;
export const RESULTS = OUT + "results.json";
export function results() { return fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, "utf8")) : { txs: [] }; }
export function save(r) { fs.writeFileSync(RESULTS, JSON.stringify(r, null, 2)); }
export function recordTx(step, hash, extra = {}) {
  const r = results();
  r.txs.push({ step, hash, url: `https://testnet.nearblocks.io/txns/${hash}`, ...extra });
  save(r);
  console.log(`tx ${step}: ${hash}`);
}
export async function account(id) {
  const ks = new keyStores.InMemoryKeyStore();
  const k = JSON.parse(fs.readFileSync(`${CRED}/${id}.json`, "utf8"));
  await ks.setKey("testnet", id, KeyPair.fromString(k.private_key));
  const near = await connect({ networkId: "testnet", nodeUrl: NODE, keyStore: ks });
  return near.account(id);
}
export async function balance(id) {
  const near = await connect({ networkId: "testnet", nodeUrl: NODE, keyStore: new keyStores.InMemoryKeyStore() });
  return (await (await near.account(id)).state()).amount;
}
export { KeyPair, utils };
