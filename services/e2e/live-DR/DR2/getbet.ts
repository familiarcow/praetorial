// Print a compact view of a DR2 bet: npx tsx getbet.ts <bet_id>
import { view } from "./chain.js";
const id = Number(process.argv[2]);
const b = await view("get_bet", { bet_id: id });
console.log(JSON.stringify({ status: b.status, outcome: b.outcome ?? null, taker: b.taker ?? null, funding_deadline_ns: b.envelope.funding_deadline, resolve_deadline_ns: b.envelope.resolve_deadline, runs_used: b.runs_used, now_ns: String(Date.now()) + "000000" }));
