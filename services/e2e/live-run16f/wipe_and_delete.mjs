// D-E2E1a live: deploy state-wipe over the item-8 escrow, wipe the snapshotted keys, confirm 0 keys, DeleteAccount. STOPs on any failure.
import fs from "node:fs";
import { account, balance, mk, connect, keyStores } from "./lib.mjs";
const { load, save, recordTx } = mk("results.json");
const ESC = "praetorial-e2e-2611052236.praetorial-dev-1101.testnet", DEV = "praetorial-dev-1101.testnet";
const r0 = load(); const keys = r0.state_key_snapshot.keys.map((k) => k.key_b64);
const esc = await account(ESC);
const fail = (step, e) => { const r = load(); r.d_e2e1a_failure = { step, error: String(e?.message ?? e).slice(0, 600), type: e?.type, tx: e?.transaction_outcome?.id ?? e?.context?.transactionHash }; save(r); console.log("FAILED", step, JSON.stringify(r.d_e2e1a_failure)); process.exit(2); };
const wasm = fs.readFileSync(new URL("state-wipe/target/wasm32-unknown-unknown/release/state_wipe.wasm", import.meta.url));
const near = await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL, keyStore: new keyStores.InMemoryKeyStore() });
const count = async () => (await near.connection.provider.query({ request_type: "view_state", finality: "final", account_id: ESC, prefix_base64: "" })).values.length;
let r = load(); r.balances = { ...(r.balances ?? {}), dev_before_wipe: await balance(DEV), escrow_before_wipe: await balance(ESC) }; save(r);
try { const d = await esc.deployContract(wasm); recordTx("wipe_deploy", d.transaction.hash, { status: d.status.SuccessValue !== undefined ? "Success" : JSON.stringify(d.status).slice(0, 200) }); } catch (e) { fail("wipe_deploy", e); }
try { const w = await esc.functionCall({ contractId: ESC, methodName: "wipe", args: { keys }, gas: 200_000_000_000_000n }); recordTx("wipe_call", w.transaction.hash, { removed: Buffer.from(w.status.SuccessValue ?? "", "base64").toString() }); } catch (e) { fail("wipe_call", e); }
await new Promise((x) => setTimeout(x, 3000));
const n = await count(); r = load(); r.wipe_view_state_keys_after = n; save(r); console.log("keys after wipe", n);
if (n !== 0) fail("verify_zero_keys", "view_state returned " + n);
try { const del = await esc.deleteAccount(DEV); recordTx("delete_escrow_account", del.transaction.hash, { beneficiary: DEV, status: "Success" }); } catch (e) { fail("delete_account", e); }
await new Promise((x) => setTimeout(x, 3000));
r = load(); r.balances.dev_after_delete = await balance(DEV); save(r); console.log(r.balances);
