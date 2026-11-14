import { account } from "./lib.mjs"; import * as C from "./config.mjs";
const k = await account(C.KEEPER);
const b = await k.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: 2 } });
const e = b.envelope; delete e.terms;
console.log(JSON.stringify({ status: b.status, runs_used: b.runs_used, env: e }, null, 0).slice(0, 1500));
console.log("credit", await k.viewFunction({ contractId: C.ESCROW, methodName: "keeper_credit_balance", args: {} }));
