import { connect, keyStores } from "./lib.mjs";
import * as C from "./config.mjs";
const near = await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL, keyStore: new keyStores.InMemoryKeyStore() });
const t = await near.connection.provider.txStatus(process.argv[2], C.KEEPER);
console.log(JSON.stringify(t.status).slice(0,600));
for (const ro of t.receipts_outcome) console.log(ro.outcome.executor_id, ro.outcome.gas_burnt, JSON.stringify(ro.outcome.logs).slice(0,800), JSON.stringify(ro.outcome.status).slice(0,300));
