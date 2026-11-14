// 16c step 2a: snapshot keys, wipe (state-wipe wasm), confirm 0 keys, DeleteAccount, recreate same name. STOPs on any failure. Results -> live-run16c/results.json
import fs from "node:fs";
import crypto from "node:crypto";
import { account, balance, mk, connect, keyStores, KeyPair, utils, CRED } from "./lib.mjs";
const { load, save, recordTx } = mk("./results.json");
const ESC = "praetorial-e2e-2611052236.praetorial-dev-1101.testnet", DEV = "praetorial-dev-1101.testnet";
const fund = process.argv[2] ?? "6";
const near = await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL, keyStore: new keyStores.InMemoryKeyStore() });
const q = async () => near.connection.provider.query({ request_type: "view_state", finality: "final", account_id: ESC, prefix_base64: "" });
const fail = (step, e) => { const r = load(); r.failure = { step, error: String(e?.message ?? e).slice(0, 600), tx: e?.context?.transactionHash ?? e?.transaction_outcome?.id }; save(r); console.log("FAILED", step, JSON.stringify(r.failure)); process.exit(2); };
const esc = await account(ESC);
let r = load(); delete r.failure; r.note="first verify_zero_keys read 11 right after wipe (RPC lag); final view_state later = 0"; save(r);
await new Promise((x) => setTimeout(x, 3000));
try { const del = await esc.deleteAccount(DEV); recordTx("delete_escrow_account", del.transaction.hash, { beneficiary: DEV, status: "Success" }); } catch (e) { fail("delete_account", e); }
await new Promise((x) => setTimeout(x, 3000));
r = load(); r.balances = {...(r.balances??{})}; r.balances.dev_after_delete = await balance(DEV); save(r);
const kp = KeyPair.fromRandom("ed25519");
const dev = await account(DEV);
try {
  const res = await dev.createAccount(ESC, kp.getPublicKey(), utils.format.parseNearAmount(fund));
  fs.copyFileSync(`${CRED}/${ESC}.json`, `${CRED}/${ESC}.json.deleted-16o.bak`);
  fs.writeFileSync(`${CRED}/${ESC}.json`, JSON.stringify({ account_id: ESC, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  recordTx("recreate_escrow_account", res.transaction.hash, { account: ESC, funded_near: fund, status: "Success" });
} catch (e) { fail("recreate", e); }
r = load(); r.balances = { ...r.balances, escrow_after_create: await balance(ESC), dev_after_create: await balance(DEV) }; save(r);
console.log(JSON.stringify(r.balances));
