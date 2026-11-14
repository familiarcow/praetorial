import { account } from "./lib.mjs";
import * as C from "./config.mjs";
const a = await account(C.OPERATOR);
const b = await a.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: 1 } });
const e = b.envelope; const o = {};
for (const k of ["maker","taker","maker_side","maker_stake","taker_stake","fee_bps","fee_account","storage_charge_per_side","settlement_period"]) o[k]=e[k];
console.log(JSON.stringify({ status:b.status, outcome:b.outcome, proposed_at:b.proposed_at, ext:b.window_extension_ns, env:o, keys:Object.keys(e).join(",") }));
for (const m of ["fee_bps","fee_account","get_config"]) { try { console.log(m, JSON.stringify(await a.viewFunction({ contractId: C.ESCROW, methodName: m, args: {} }))); } catch(x){ console.log(m,"n/a"); } }
