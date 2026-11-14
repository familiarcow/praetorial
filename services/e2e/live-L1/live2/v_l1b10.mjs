// L1b10: read-only views of bet 1 (no keys, no txs)
import { account } from "./lib.mjs"; import * as C from "./config.mjs";
const k = await account(C.OPERATOR);
const b = await k.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: 1 } });
console.log(JSON.stringify({ status: b.status, outcome: b.outcome, runs_used: b.runs_used, used_run_nos: b.used_run_nos, next_expected_run_no: b.next_expected_run_no, next_run_no: b.next_run_no, pending_run_no: b.pending_run_no, max_paid_runs: b.envelope.max_paid_runs }));
