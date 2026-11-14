// D-E2E1a: snapshot all storage keys (key b64 + sha256 of value) of the item-8 escrow into results.json. Read-only.
import crypto from "node:crypto";
import { connect, keyStores, mk } from "./lib.mjs";
const ESC = "praetorial-e2e-2611052236.praetorial-dev-1101.testnet";
const near = await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL, keyStore: new keyStores.InMemoryKeyStore() });
const q = await near.connection.provider.query({ request_type: "view_state", finality: "final", account_id: ESC, prefix_base64: "" });
const keys = q.values.map((v) => ({ key_b64: v.key, key_utf8: Buffer.from(v.key, "base64").toString("utf8").replace(/[^\x20-\x7e]/g, "?"), value_bytes: Buffer.from(v.value, "base64").length, value_sha256: crypto.createHash("sha256").update(Buffer.from(v.value, "base64")).digest("hex") }));
const { load, save } = mk("results.json");
const r = load(); r.state_key_snapshot = { account: ESC, ts: new Date().toISOString(), block_height: q.block_height, key_count: keys.length, total_value_bytes: keys.reduce((a, k) => a + k.value_bytes, 0), keys }; save(r);
console.log(keys.length, r.state_key_snapshot.total_value_bytes);
