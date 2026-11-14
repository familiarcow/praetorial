import { account } from "./lib.mjs"; import * as C from "./config.mjs";
const k = await account(C.KEEPER);
for (const id of [1,2,3]) { const b = await k.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: id } });
 const why = await k.viewFunction({ contractId: C.ESCROW, methodName: "can_request_resolution", args: { bet_id: id } });
 console.log(id, b.status, b.outcome, b.runs_used, "fd", new Date(Number(BigInt(b.envelope.funding_deadline)/1000000n)).toISOString(), why); }
console.log(new Date().toISOString());
