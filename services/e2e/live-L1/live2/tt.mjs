import { account } from "./lib.mjs"; import * as C from "./config.mjs";
const k = await account(C.KEEPER); const p = k.connection.provider;
for (const h of process.argv.slice(2)) { const tx = await p.txStatus(h, C.KEEPER); const ts=[]; for (const ro of tx.receipts_outcome){ const b = await p.block({blockId: ro.block_hash}); ts.push(new Date(Number(BigInt(b.header.timestamp_nanosec)/1000000n)).toISOString().slice(11,19)+" "+ro.outcome.executor_id.split(".")[0]); } console.log(h.slice(0,8), ts.join(" | ")); }
