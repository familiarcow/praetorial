import { account } from "./lib.mjs";
import * as C from "./config.mjs";
const a = await account(C.OPERATOR);
const b = await a.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: 1 } });
console.log(b.status, b.runs_used, String(b.last_resolution_raw).slice(0, 6000));
