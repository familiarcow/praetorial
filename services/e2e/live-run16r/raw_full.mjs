import { account } from "./lib.mjs";
import * as C from "./config.mjs";
import fs from "node:fs";
const a = await account(C.KEEPER);
const b = await a.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: 2 } });
fs.writeFileSync("raw_resolution.json", b.last_resolution_raw);
console.log(b.status, b.retry_count, b.runs_used);
