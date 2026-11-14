import { account, mk } from "./lib.mjs";
import * as C from "./config.mjs";
const { load, save } = mk("./results.json");
const k = await account(C.KEEPER);
const view = (m, a) => k.viewFunction({ contractId: C.ESCROW, methodName: m, args: a });
let b;
for (let i = 0; i < 100; i++) { b = await view("get_bet", { bet_id: 1 }); console.log(i, b.status, new Date().toISOString()); if (b.status !== "Resolving") break; await new Promise(r => setTimeout(r, 6000)); }
const r = load(); r.bet_after_request = b; r.keeper_credit_after = await view("keeper_credit_balance"); save(r);
console.log(JSON.stringify(b).slice(0, 1500));
