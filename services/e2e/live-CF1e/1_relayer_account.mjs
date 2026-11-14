// CF1e: create relayer.praetorial-dev-1101.testnet (testnet only), key stored in ~/.near-credentials only. Never prints keys.
import fs from "node:fs";
import { account, KeyPair, utils, CRED } from "../live-FRZ1/lib.mjs";
const id = "relayer.praetorial-dev-1101.testnet";
const kp = KeyPair.fromRandom("ed25519");
const dev = await account("praetorial-dev-1101.testnet");
const r = await dev.createAccount(id, kp.getPublicKey().toString(), utils.format.parseNearAmount("0.5"));
fs.writeFileSync(`${CRED}/${id}.json`, JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
console.log("create tx", r.transaction.hash);
