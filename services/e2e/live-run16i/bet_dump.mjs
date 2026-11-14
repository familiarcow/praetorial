import { account } from "./lib.mjs";
import * as C from "./config.mjs";
const a = await account(C.KEEPER);
const b = await a.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: 1 } });
console.log(Object.keys(b).join(","), "\nraw:", String(b.last_resolution_raw).slice(0, 300), "\nstatus", b.status, "outcome", JSON.stringify(b.outcome), "settle_ready", b.settle_ready_ns);
