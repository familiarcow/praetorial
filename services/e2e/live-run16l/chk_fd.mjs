import { account } from "./lib.mjs";
import * as C from "./config.mjs";
const a = await account(C.OPERATOR);
const b = await a.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: 1 } });
const e=b.envelope;
console.log("now", Date.now(), "funding_deadline_ms", Number(BigInt(e.funding_deadline)/1000000n), "resolve_deadline", e.resolve_deadline, "early", JSON.stringify(e.early_settle_outcome), "runs", b.runs_used, e.max_paid_runs, "status", b.status, "taken_at", b.taken_at);
