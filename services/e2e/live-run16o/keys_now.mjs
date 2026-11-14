import { connect, keyStores } from "./lib.mjs";
const near = await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL, keyStore: new keyStores.InMemoryKeyStore() });
const q = await near.connection.provider.query({ request_type: "view_state", finality: "final", account_id: "praetorial-e2e-2611052236.praetorial-dev-1101.testnet", prefix_base64: "" });
console.log("keys", q.values.length);
const tx = await near.connection.provider.txStatus("A9gtoj7NyX9bT9zh5kUf4apqA65PNqGSGCaz4A4SA5Ui", "praetorial-e2e-2611052236.praetorial-dev-1101.testnet");
console.log(JSON.stringify(tx.status).slice(0,300));
