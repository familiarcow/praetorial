// R3h (D-E2E1b): re-run precheck, deploy state-wipe over R3c escrow, wipe snapshotted keys, confirm 0, DeleteAccount -> dev. STOPs on any failure.
import fs from "node:fs";
import { account, balance, mk, connect, keyStores } from "../live-run16a/lib.mjs";
import * as C from "./config.mjs";
const { load, save, recordTx } = mk("r3h_results.json");
const ESC = C.ESCROW, DEV = C.OPERATOR;
const fail = (step, e) => { const r = load(); r.failure = { step, error: String(e?.message ?? e).slice(0, 600), tx: e?.transaction_outcome?.id ?? e?.context?.transactionHash }; save(r); console.log("FAILED", step, JSON.stringify(r.failure)); process.exit(2); };
const near = await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL, keyStore: new keyStores.InMemoryKeyStore() });
const view = async (m, args = {}) => near.connection.provider.query({ request_type: "call_function", finality: "final", account_id: ESC, method_name: m, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") }).then((x) => JSON.parse(Buffer.from(x.result).toString()));
const state = async () => (await near.connection.provider.query({ request_type: "view_state", finality: "final", account_id: ESC, prefix_base64: "" })).values;
// precheck gate (immediately before wipe)
const bets = []; for (let i = 1; i < 200; i++) { const b = await view("get_bet", { bet_id: i }); if (!b) break; bets.push(b.status); }
const pend = (await view("pending_payouts_view", { from: 0, limit: 500 })).filter((p) => !p.done);
const offers = await view("open_offers", { from: 0, limit: 200 });
if (!bets.length || bets.some((s) => s !== "Settled") || pend.length || offers.length) fail("precheck_gate", `bets=${bets} pending=${pend.length} offers=${offers.length}`);
const r0 = load(); const snapKeys = r0.state_key_snapshot.keys.map((k) => k.key_b64);
const cur = (await state()).map((v) => v.key);
if (JSON.stringify([...cur].sort()) !== JSON.stringify([...snapKeys].sort())) fail("state_changed_since_snapshot", `cur=${cur.length} snap=${snapKeys.length}`);
const esc = await account(ESC);
let r = load(); r.balances = { dev_before: await balance(DEV), escrow_before: await balance(ESC) }; r.recheck = { ts: new Date().toISOString(), bets, pending_not_done: 0, open_offers: 0 }; save(r);
const wasm = fs.readFileSync(new URL("../live-run16a/state-wipe/target/wasm32-unknown-unknown/release/state_wipe.wasm", import.meta.url));
try { const d = await esc.deployContract(wasm); recordTx("wipe_deploy", d.transaction.hash, { status: d.status.SuccessValue !== undefined ? "Success" : JSON.stringify(d.status).slice(0, 200) }); } catch (e) { fail("wipe_deploy", e); }
try { const w = await esc.functionCall({ contractId: ESC, methodName: "wipe", args: { keys: snapKeys }, gas: 200_000_000_000_000n }); recordTx("wipe_call", w.transaction.hash, { removed: Buffer.from(w.status.SuccessValue ?? "", "base64").toString() }); } catch (e) { fail("wipe_call", e); }
await new Promise((x) => setTimeout(x, 3000));
const n = (await state()).length; r = load(); r.view_state_keys_after_wipe = n; save(r); console.log("keys after wipe", n);
if (n !== 0) fail("verify_zero_keys", "view_state returned " + n);
try { const del = await esc.deleteAccount(DEV); recordTx("delete_account", del.transaction.hash, { beneficiary: DEV, status: "Success" }); } catch (e) { fail("delete_account", e); }
await new Promise((x) => setTimeout(x, 3000));
r = load(); r.balances.dev_after = await balance(DEV);
try { await balance(ESC); r.account_deleted = false; } catch (e) { r.account_deleted = true; }
r.dev_delta_yocto = (BigInt(r.balances.dev_after) - BigInt(r.balances.dev_before)).toString();
r.escrow_before_minus_dev_delta_yocto = (BigInt(r.balances.escrow_before) - BigInt(r.dev_delta_yocto)).toString(); save(r); console.log(JSON.stringify(r.balances), r.account_deleted, r.dev_delta_yocto);
