import fs from "node:fs"; import { account } from "./lib.mjs"; import * as C from "./config.mjs";
const k = await account(C.KEEPER);
const tx = await k.connection.provider.txStatus(process.argv[2], C.KEEPER);
for (const ro of tx.receipts_outcome) for (const l of ro.outcome.logs) { if (l.includes("execution_requested")) { const ev = JSON.parse(l.slice(l.indexOf("{"))); const rd = JSON.parse(ev.data[0].request_data); console.log(Object.keys(rd)); fs.writeFileSync(process.argv[3], typeof rd.input_data === "string" ? rd.input_data : JSON.stringify(rd.input_data)); console.log(JSON.stringify({ ...rd, input_data: undefined }).slice(0, 900)); } }
