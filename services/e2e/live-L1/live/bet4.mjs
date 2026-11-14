import { account } from "./lib.mjs"; import * as C from "./config.mjs";
const k = await account(C.KEEPER); const b = await k.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: 4 } }); console.log(b.status, b.outcome, b.runs_used, String(b.last_resolution_raw ?? "").length);
