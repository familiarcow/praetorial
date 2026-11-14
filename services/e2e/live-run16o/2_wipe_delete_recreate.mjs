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
const st = await (await near.account(ESC)).state();
const snapq = await q();
const keys = snapq.values.map((v) => ({ key_b64: v.key, key_utf8: Buffer.from(v.key, "base64").toString("utf8").replace(/[^\x20-\x7e]/g, "?"), value_bytes: Buffer.from(v.value, "base64").length, value_sha256: crypto.createHash("sha256").update(Buffer.from(v.value, "base64")).digest("hex") }));
let r = load(); r.txs = r.txs ?? []; r.state_key_snapshot = { account: ESC, ts: new Date().toISOString(), block_height: snapq.block_height, key_count: keys.length, total_value_bytes: keys.reduce((a, k) => a + k.value_bytes, 0), code_hash_hex: Buffer.from(utils.serialize.base_decode(st.code_hash)).toString("hex"), keys };
r.balances = { dev_before_wipe: await balance(DEV), escrow_before_wipe: await balance(ESC) }; save(r);
console.log("keys", keys.length, r.state_key_snapshot.total_value_bytes);
const esc = await account(ESC);
const wasm = fs.readFileSync(new URL("./state-wipe/target/wasm32-unknown-unknown/release/state_wipe.wasm", import.meta.url));
try { const d = await esc.deployContract(wasm); recordTx("wipe_deploy", d.transaction.hash, { status: JSON.stringify(d.status).includes("Failure") ? "Failure" : "Success" }); } catch (e) { fail("wipe_deploy", e); }
try { const w = await esc.functionCall({ contractId: ESC, methodName: "wipe", args: { keys: keys.map((k) => k.key_b64) }, gas: 200_000_000_000_000n }); recordTx("wipe_call", w.transaction.hash, { status: "Success", removed: Buffer.from(w.status.SuccessValue ?? "", "base64").toString() }); } catch (e) { fail("wipe_call", e); }
await new Promise((x) => setTimeout(x, 3000));
const n = (await q()).values.length; r = load(); r.view_state_keys_after_wipe = n; save(r); console.log("keys after wipe", n);
if (n !== 0) fail("verify_zero_keys", "view_state returned " + n);
try { const del = await esc.deleteAccount(DEV); recordTx("delete_escrow_account", del.transaction.hash, { beneficiary: DEV, status: "Success" }); } catch (e) { fail("delete_account", e); }
await new Promise((x) => setTimeout(x, 3000));
r = load(); r.balances.dev_after_delete = await balance(DEV); save(r);
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
