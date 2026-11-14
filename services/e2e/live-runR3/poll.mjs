import { account, mk } from "./lib.mjs"; import * as C from "./config.mjs";
const { load, save } = mk("./results.json");
const k = await account(C.KEEPER); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) { const b = await k.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: 1 } }); console.log(i, b.status, b.runs_used); if (b.status !== "Resolving") break; await sleep(6000); }
const b = await k.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: 1 } });
const r = load(); r.bet_after_request = { ...b, envelope: { ...b.envelope, terms: undefined } }; r.keeper_credit_after = await k.viewFunction({ contractId: C.ESCROW, methodName: "keeper_credit_balance", args: {} }); save(r);
console.log(b.status, String(b.last_resolution_raw).slice(0, 300));
