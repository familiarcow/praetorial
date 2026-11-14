import { account, balance } from "./lib.mjs";
import * as C from "./config.mjs";
const a = await account(C.OPERATOR);
const view = (m, args) => a.viewFunction({ contractId: C.ESCROW, methodName: m, args });
const mt = (acc, t) => a.viewFunction({ contractId: C.INTENTS, methodName: "mt_balance_of", args: { account_id: acc, token_id: t } });
console.log("dev", await balance(C.OPERATOR));
for (const id of [1,2]) { const b = await view("get_bet",{bet_id:id}); const o={}; for (const k in b){ const v=b[k]; if(k!=="last_resolution_raw") o[k]=v; } console.log(id, JSON.stringify(o)); if (b.resolve_deadline) console.log("deadline ET", new Date(Number(BigInt(b.resolve_deadline)/1000000n)).toLocaleString("en-US",{timeZone:"America/New_York"})); }
console.log("pending", JSON.stringify(await view("pending_payouts_view",{from:0,limit:50})));
for (const t of [C.USDC,C.BTC]) for (const x of [C.MAKER,C.TAKER,C.FEE,C.ESCROW]) console.log(x.split(".")[0],t,await mt(x,t));
