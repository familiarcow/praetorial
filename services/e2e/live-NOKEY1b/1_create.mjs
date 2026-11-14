// NOKEY1b step: create the fresh escrow sub-account and OutLayer CLI home logged in AS it (for report-pubkey). Never prints keys.
import fs from "node:fs";
import { account, mk, KeyPair, utils, CRED, balance } from "./lib.mjs";
const { load, save, recordTx } = mk("./results.json");
const ESC = process.argv[2], fund = process.argv[3] ?? "8", DEV = "praetorial-dev-1101.testnet";
const kp = KeyPair.fromRandom("ed25519");
const before = await balance(DEV);
const res = await (await account(DEV)).createAccount(ESC, kp.getPublicKey(), utils.format.parseNearAmount(fund));
fs.writeFileSync(`${CRED}/${ESC}.json`, JSON.stringify({ account_id: ESC, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
const home = ((process.env.PRAETORIAL_CACHE_DIR ?? (() => { throw new Error("set PRAETORIAL_CACHE_DIR (operator cache dir)"); })()) + "/scratch/olhome-frz3");
fs.mkdirSync(`${home}/testnet`, { recursive: true });
fs.writeFileSync(`${home}/default-network`, "testnet\n");
fs.writeFileSync(`${home}/testnet/credentials.json`, JSON.stringify({ account_id: ESC, public_key: kp.getPublicKey().toString(), private_key: kp.toString(), contract_id: "outlayer.testnet", auth_type: "near_key" }, null, 2), { mode: 0o600 });
recordTx("create_escrow_account", res.transaction.hash, { account: ESC, funded_near: fund, status: "Success" });
const r = load(); r.escrow = ESC; r.balances = { dev_before: before, dev_after_create: await balance(DEV) }; save(r);
