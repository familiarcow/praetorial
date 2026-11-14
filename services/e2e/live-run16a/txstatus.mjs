// usage: node txstatus.mjs <signerAccountId> <txhash...>  -- prints final tx + receipt statuses (read-only)
import { connect, keyStores } from "./lib.mjs";
const near = await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL, keyStore: new keyStores.InMemoryKeyStore() });
const [signer, ...hashes] = process.argv.slice(2);
for (const h of hashes) {
  try {
    const o = await near.connection.provider.txStatus(h, signer, "FINAL");
    for (const x of o.receipts_outcome) for (const l of x.outcome.logs) console.log("  log:", l.slice(0, 400));
    console.log(h, JSON.stringify(o.status).slice(0, 120), "|", o.receipts_outcome.map((x) => JSON.stringify(x.outcome.status).slice(0, 70)).join(" | "));
  } catch (e) { console.log(h, "ERR", String(e).slice(0, 150)); }
}
