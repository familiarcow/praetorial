import { account } from "../live-run16a/lib.mjs";
import * as C from "../live-run8/config.mjs";
const a = await account(C.KEEPER);
const v=(m,x={})=>a.viewFunction({ contractId: C.ESCROW, methodName: m, args: x });
const b = await v("get_bet",{bet_id:2});
console.log(b.status, b.runs_used, b.pending_resolution_request, b.envelope.funding_deadline, Date.now()*1e6);
console.log(Object.keys(b));
