// live-run16a/16 helpers: results are written to the given file; never prints keys.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
export const { connect, keyStores, KeyPair, utils } = require("near-api-js");
export const NODE = process.env.NEAR_RPC_URL; if (!NODE) throw new Error("set NEAR_RPC_URL");
export const CRED = `${process.env.HOME}/.near-credentials/testnet`;
export const DIR = new URL(".", import.meta.url).pathname;
export function mk(file) {
  const path = DIR + file;
  const load = () => (fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : { txs: [] });
  const save = (r) => fs.writeFileSync(path, JSON.stringify(r, null, 2));
  const recordTx = (step, hash, extra = {}) => { const r = load(); r.txs.push({ step, hash, url: `https://testnet.nearblocks.io/txns/${hash}`, ...extra }); save(r); console.log(`tx ${step}: ${hash}`); };
  return { load, save, recordTx };
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
