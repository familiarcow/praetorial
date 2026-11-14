// DR9 reclaim per D-E2E1a: snapshot keys, deploy the self-only state-wipe wasm (services/e2e/live-run16a/state-wipe) over the THROWAWAY escrow, wipe, confirm 0 keys, DeleteAccount(beneficiary dev).
// Then delete the throwaway guardian/maker/taker accounts (plain accounts) back to dev. Refuses any account that is not a praetorial-drill9-/d9- throwaway.
import fs from "node:fs"; import crypto from "node:crypto";
import { account, store, viewer, connect, keyStores, NODE, DEV, DIR, sleep } from "./lib.mjs";
const { load, save, rec } = store("run/d34_results.json");
const R = load(); const ESC = R.escrow;
if (!/^praetorial-drill9-\d+\.praetorial-dev-1101\.testnet$/.test(ESC)) throw new Error("refusing: not a drill9 throwaway: " + ESC);
const near = await connect({ networkId: "testnet", nodeUrl: NODE, keyStore: new keyStores.InMemoryKeyStore() });
const q = () => near.connection.provider.query({ request_type: "view_state", finality: "final", account_id: ESC, prefix_base64: "" });
const snapq = await q(); const keys = snapq.values.map((x) => x.key);
R.reclaim = { keys_before: keys.length, bytes: snapq.values.reduce((a, x) => a + Buffer.from(x.value, "base64").length, 0) }; save(R);
const wasm = fs.readFileSync(DIR + "../../live-run16a/state-wipe/target/wasm32-unknown-unknown/release/state_wipe.wasm");
R.reclaim.state_wipe_wasm_sha256 = crypto.createHash("sha256").update(wasm).digest("hex");
const esc = await account(ESC);
let d = await esc.deployContract(wasm); rec("wipe_deploy", d.transaction.hash);
d = await esc.functionCall({ contractId: ESC, methodName: "wipe", args: { keys }, gas: 200_000_000_000_000n }); rec("wipe_call", d.transaction.hash);
await sleep(3000); const n = (await q()).values.length; R.reclaim.keys_after = n; save(R); console.log("keys after wipe", n);
if (n !== 0) throw new Error("wipe left " + n + " keys; NOT deleting");
const devBefore = BigInt((await (await near.account(DEV)).state()).amount);
d = await esc.deleteAccount(DEV); rec("delete_escrow_account", d.transaction.hash);
for (const id of Object.values(R.accounts)) {
  if (!/\/?d9-[a-z0-9]+-\d+\.praetorial-dev-1101\.testnet$/.test(id)) continue;
  try { const a = await account(id); const r = await a.deleteAccount(DEV); rec("delete_" + id.split(".")[0], r.transaction.hash); } catch (e) { console.log("delete failed", id, String(e.message).slice(0, 100)); }
}
await sleep(3000);
R.reclaim.dev_balance_delta_yocto = (BigInt((await (await near.account(DEV)).state()).amount) - devBefore).toString();
R.reclaim.escrow_exists_after = await near.connection.provider.query({ request_type: "view_account", finality: "final", account_id: ESC }).then(() => true, () => false);
save(R); console.log(JSON.stringify(R.reclaim));
