// usage: node txfail.mjs <signer> <hash> -- prints receipts (executor, status, logs) of a tx; read-only
import { connect, keyStores } from "./lib.mjs";
const near = await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL, keyStore: new keyStores.InMemoryKeyStore() });
const o = await near.connection.provider.txStatus(process.argv[3], process.argv[2], "FINAL");
for (const x of o.receipts_outcome) console.log(x.outcome.executor_id, JSON.stringify(x.outcome.status).slice(0, 700), x.outcome.logs.map((l) => l.slice(0, 200)));
