// Delete the item-8 escrow (beneficiary dev account) and recreate the same name. Precheck passed (precheck.json).
import fs from "node:fs";
import { account, balance, mk, KeyPair, utils, CRED } from "./lib.mjs";
const { load, save, recordTx } = mk("results.json");
const ESC = "praetorial-e2e-2611052236.praetorial-dev-1101.testnet", DEV = "praetorial-dev-1101.testnet";
const fund = process.argv[2] ?? "6";
const r = load(); r.balances = r.balances ?? {};
if (!r.pre_delete_snapshot) { r.pre_delete_snapshot = JSON.parse(fs.readFileSync(new URL("precheck.json", import.meta.url))); r.precheck_result = "PASS: 0 open offers, 0 not-done pending payouts (15 done), bets 1,2 Settled, mt balance 0 on usdc/btc.mock/usdt/wrap/eth.mock"; save(r); }
r.balances.dev_before_delete = await balance(DEV);
const esc = await account(ESC);
const del = await esc.deleteAccount(DEV);
recordTx("delete_escrow_account", del.transaction.hash, { beneficiary: DEV });
await new Promise((x) => setTimeout(x, 3000));
r.balances = load().balances; r.balances.dev_after_delete = await balance(DEV);
const kp = KeyPair.fromRandom("ed25519");
const dev = await account(DEV);
const res = await dev.createAccount(ESC, kp.getPublicKey(), utils.format.parseNearAmount(fund));
fs.copyFileSync(`${CRED}/${ESC}.json`, `${CRED}/${ESC}.json.deleted-item8.bak`);
fs.writeFileSync(`${CRED}/${ESC}.json`, JSON.stringify({ account_id: ESC, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
recordTx("recreate_escrow_account", res.transaction.hash, { account: ESC, funded_near: fund });
const r2 = load(); r2.balances = { ...r2.balances, ...r.balances, escrow_after_create: await balance(ESC), dev_after_create: await balance(DEV) }; save(r2);
console.log(JSON.stringify(r2.balances));
