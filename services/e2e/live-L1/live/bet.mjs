import { account } from "./lib.mjs"; import * as C from "./config.mjs";
const k = await account(C.KEEPER);
for (const id of [1,2,3]) { const b = await k.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: id } }); console.log(id, b.status, b.outcome, b.runs_used, String(b.last_resolution_raw ?? "").length); }
