import { connect, keyStores } from "./lib.mjs";
const near = await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL, keyStore: new keyStores.InMemoryKeyStore() });
for (const id of process.argv.slice(2)) { try { const s = await (await near.account(id)).state(); console.log(id, s.amount, s.code_hash); } catch (e) { console.log(id, "ERR", String(e.message).slice(0,100)); } }
