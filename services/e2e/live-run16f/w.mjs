import { account } from "./lib.mjs";
import * as C from "./config.mjs";
const a = await account(C.KEEPER);
const b = await a.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: 2 } });
console.log(b.status, b.runs_used, JSON.stringify(b.outcome), String(b.last_resolution_raw).slice(0, 1200));
