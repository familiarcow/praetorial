// DR9 helper (read-only): payouts + balances on the throwaway escrow
import { store, view, bal } from "./lib.mjs";
const R = store("run/d34_results.json").load(); const INTENTS = "intents-mock.praetorial-dev-1101.testnet";
for (const id of [R.bets.B, R.bets.C]) console.log("bet", id, JSON.stringify(await view(R.escrow, "pending_payouts", { bet_id: id })).slice(0, 900), "fully_paid", JSON.stringify(await view(R.escrow, "is_fully_paid", { bet_id: id })));
for (const k of ["m2", "t2", "m3"]) console.log(k, (await bal(INTENTS, R.accounts[k])).toString());
console.log("esc", (await bal(INTENTS, R.escrow)).toString());
