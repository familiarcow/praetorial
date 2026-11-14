// DRILL1 helpers. Keys are loaded in code from ~/.near-credentials/testnet and never printed.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
export const { connect, keyStores, KeyPair, utils } = require("near-api-js");
export const NODE = process.env.NEAR_RPC_URL; if (!NODE) throw new Error("set NEAR_RPC_URL");
export const CRED = `${process.env.HOME}/.near-credentials/testnet`;
export const DIR = new URL(".", import.meta.url).pathname;
export const DEV = "praetorial-dev-1101.testnet", INTENTS = "intents-mock.praetorial-dev-1101.testnet", USDC = "nep141:usdc.testnet";
export const FEE = "fee.praetorial-dev-1101.testnet", KEEPER = "keeper.praetorial-dev-1101.testnet";
export const MAKER = "maker1.praetorial-dev-1101.testnet", TAKER = "taker1.praetorial-dev-1101.testnet";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RES = DIR + "results.json";
export const load = () => (fs.existsSync(RES) ? JSON.parse(fs.readFileSync(RES, "utf8")) : { txs: [], observations: [] });
export const save = (r) => fs.writeFileSync(RES, JSON.stringify(r, null, 2));
export function recordTx(step, hash, extra = {}) { const r = load(); r.txs.push({ step, hash, url: `https://testnet.nearblocks.io/txns/${hash}`, ...extra }); save(r); console.log(`tx ${step}: ${hash}`); }
export function observe(key, value) { const r = load(); r.observations.push({ key, ...value }); save(r); console.log("obs", key, JSON.stringify(value).slice(0, 300)); }
export async function account(id) {
  const ks = new keyStores.InMemoryKeyStore();
  const k = JSON.parse(fs.readFileSync(`${CRED}/${id}.json`, "utf8"));
  await ks.setKey("testnet", id, KeyPair.fromString(k.private_key));
  return (await connect({ networkId: "testnet", nodeUrl: NODE, keyStore: ks })).account(id);
}
export async function viewer() { return (await connect({ networkId: "testnet", nodeUrl: NODE, keyStore: new keyStores.InMemoryKeyStore() })).account(DEV); }
export async function createKeyed(parentAcc, id, fundNear) {
  const kp = KeyPair.fromRandom("ed25519");
  const res = await parentAcc.createAccount(id, kp.getPublicKey(), utils.format.parseNearAmount(fundNear));
  fs.writeFileSync(`${CRED}/${id}.json`, JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  return { kp, hash: res.transaction.hash };
}
/** Call a method; returns {ok, hash, failure} where failure is the contract panic / error text (never throws on contract failure). */
export async function tryCall(acc, contractId, methodName, args = {}, { deposit = 0n, gas = 100_000_000_000_000n } = {}) {
  try {
    const r = await acc.functionCall({ contractId, methodName, args, gas, attachedDeposit: deposit });
    const st = r.status ?? {}; const fail = st.Failure ? JSON.stringify(st.Failure) : null;
    const rf = (r.receipts_outcome ?? []).map((o) => o.outcome?.status?.Failure).filter(Boolean).map((f) => JSON.stringify(f)).join(" | ");
    return { ok: !fail && !rf, hash: r.transaction.hash, failure: fail || rf || null };
  } catch (e) {
    const hash = e?.context?.transactionHash ?? e?.transaction_outcome?.id ?? null;
    return { ok: false, hash, failure: String(e?.message ?? e) + " " + JSON.stringify(e?.type ?? e?.kind ?? "") };
  }
}
export const bal = (v, acc) => v.viewFunction({ contractId: INTENTS, methodName: "mt_balance_of", args: { account_id: acc, token_id: USDC } }).then(BigInt);
export const ONE = 1n; // 1 yocto for guardian calls
// FINDING (DRILL1): the frozen contract has NO `guardian` view method (only `pending_guardian`). The guardian is read straight from contract state
// via RPC view_state: borsh Contract { intents: String, usdc_token_id: String, asset_limits: LookupMap(prefix: Vec<u8>), outlayer: String,
// outlayer_config: {String,String,String}, operator: String, guardian: String, ... } under key "STATE".
export async function guardianOf(v, escrow) {
  const r = await v.connection.provider.query({ request_type: "view_state", account_id: escrow, prefix_base64: Buffer.from("STATE").toString("base64"), finality: "final" });
  const buf = Buffer.from(r.values.find((x) => Buffer.from(x.key, "base64").toString() === "STATE").value, "base64");
  let o = 0; const str = () => { const n = buf.readUInt32LE(o); o += 4; const s = buf.subarray(o, o + n).toString("utf8"); o += n; return s; };
  str(); str(); str(); /* asset_limits prefix is a length-prefixed byte string, same wire shape */ str(); str(); str(); str(); str();
  return str();
}
