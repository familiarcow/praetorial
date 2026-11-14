import { account } from "./lib.mjs"; import * as C from "./config.mjs"; import fs from "node:fs";
const k = await account(C.KEEPER);
const b = await k.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: +process.argv[2] } });
fs.writeFileSync(process.argv[3], String(b.last_resolution_raw)); console.log(b.status, b.pending_resolution_request, b.runs_used);
