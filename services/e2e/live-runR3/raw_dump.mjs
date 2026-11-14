import fs from "node:fs";
import { account, mk } from "./lib.mjs"; import * as C from "./config.mjs";
const k = await account(C.KEEPER);
const b = await k.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: 2 } });
fs.writeFileSync("raw_resolution.txt", String(b.last_resolution_raw));
const keys = Object.keys(b).filter(x=>!["envelope"].includes(x)); console.log(JSON.stringify(Object.fromEntries(keys.filter(x=>x!="last_resolution_raw").map(x=>[x,b[x]]))).slice(0,1500));
