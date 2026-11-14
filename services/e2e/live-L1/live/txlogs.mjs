import { account } from "./lib.mjs"; import * as C from "./config.mjs";
const k = await account(C.KEEPER); const tx = await k.connection.provider.txStatus(process.argv[2], C.KEEPER);
for (const ro of tx.receipts_outcome) { const st = JSON.stringify(ro.outcome.status).slice(0, 300); console.log(ro.outcome.executor_id, st, JSON.stringify(ro.outcome.logs).slice(0, 700)); }
