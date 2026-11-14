import { account } from "./lib.mjs";
import * as C from "./config.mjs";
const a = await account(C.KEEPER);
const v = (m, x = {}) => a.viewFunction({ contractId: C.ESCROW, methodName: m, args: x });
const b = await v("get_bet", { bet_id: 1 });
console.log(b.status, b.runs_used, b.envelope.funding_deadline, b.envelope.resolve_deadline, b.envelope.tier, b.envelope.max_paid_runs, b.envelope.referee, b.bonds, b.final_round_started_at);
console.log(await v("keeper_credit_balance"));
