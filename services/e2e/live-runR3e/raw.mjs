import { account, mk } from "./lib.mjs"; import * as C from "./config.mjs";
const k = await account(C.KEEPER);
const b = await k.viewFunction({ contractId: C.ESCROW, methodName: "get_bet", args: { bet_id: 1 } });
console.log("status", b.status, "outcome", b.outcome, "runs_used", b.runs_used, "proposed_at", b.proposed_at);
import fs from "node:fs"; fs.writeFileSync("raw_resolution.txt", String(b.last_resolution_raw));
