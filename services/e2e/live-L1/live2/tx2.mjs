import { account } from "./lib.mjs"; import * as C from "./config.mjs";
const k = await account(C.KEEPER); const tx = await k.connection.provider.txStatus(process.argv[2], C.KEEPER);
for (const ro of tx.receipts_outcome) { console.log(ro.block_hash.slice(0,6), ro.outcome.executor_id, JSON.stringify(ro.outcome.status).slice(0,120), JSON.stringify(ro.outcome.logs.map(l=>l.slice(0,160)))); }
