import { account } from "./lib.mjs"; import * as C from "./config.mjs";
const k = await account(C.KEEPER);
const tx = await k.connection.provider.txStatus("Cc9de2MwGHthBaMoBpSRN1yNoty5WfQJhRvRa6Ao5Quq", C.KEEPER);
for (const ro of tx.receipts_outcome) console.log(ro.outcome.executor_id, JSON.stringify(ro.outcome.logs).slice(0,400));
