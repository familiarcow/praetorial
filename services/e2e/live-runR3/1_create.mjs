// R3c step 1: create fresh escrow sub-account (funded for the ~520 KB escrow wasm storage). Funds stay on the account.
import fs from "node:fs";
import { account, mk, KeyPair, utils, CRED, balance } from "./lib.mjs";
import * as C from "./config.mjs";
const { load, save, recordTx } = mk("./results.json");
const fund = process.argv[2] ?? "6";
const kp = KeyPair.fromRandom("ed25519");
const dev = await account(C.OPERATOR);
const before = await balance(C.OPERATOR);
const res = await dev.createAccount(C.ESCROW, kp.getPublicKey(), utils.format.parseNearAmount(fund));
fs.writeFileSync(`${CRED}/${C.ESCROW}.json`, JSON.stringify({ account_id: C.ESCROW, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
recordTx("create_escrow_account", res.transaction.hash, { account: C.ESCROW, funded_near: fund, status: "Success" });
const r = load(); r.balances = { dev_before: before, dev_after_create: await balance(C.OPERATOR) }; save(r);
