// CF1e2: read-only check that the cancelled bet 1 left no funds / pending payouts in the escrow.
import { account } from "../live-FRZ1/lib.mjs";
const E = "praetorial-frz1b-2611081810.praetorial-dev-1101.testnet";
const M = "intents-mock.praetorial-dev-1101.testnet";
const a = await account("maker1.praetorial-dev-1101.testnet");
const v = (contractId, methodName, args = {}) => a.viewFunction({ contractId, methodName, args });
const show = async (label, p) => { try { console.log(label, JSON.stringify(await p)); } catch (e) { console.log(label, "ERR", String(e.message).slice(0, 200)); } };
await show("get_bet(1)", v(E, "get_bet", { bet_id: 1 }));
await show("pending_payouts(1)", v(E, "pending_payouts", { bet_id: 1 }));
await show("pending_payouts_view(0,100)", v(E, "pending_payouts_view", { from: 0, limit: 100 }));
await show("payout_ids_in_order", v(E, "payout_ids_in_order"));
for (const id of ["maker1.praetorial-dev-1101.testnet", E])
  await show(`mt_balance_of(${id.split(".")[0]})`, v(M, "mt_balance_of", { account_id: id, token_id: "nep141:usdc.testnet" }));
const r = JSON.parse((await import("node:fs")).readFileSync(new URL("results.json", import.meta.url), "utf8"));
console.log("results.json usdc_before_cancel", r.usdc_before_cancel, "usdc_after_cancel", r.usdc_after_cancel, "status", r.bet_status_after_cancel);
