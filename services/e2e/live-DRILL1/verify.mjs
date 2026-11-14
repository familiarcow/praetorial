// DRILL1 verify: reads ONLY chain views (+ the recorded results.json for ids/expectations). Exits 1 on any failed expectation.
// usage: NEAR_RPC_URL=<testnet rpc> node verify.mjs
import fs from "node:fs";
import { guardianOf, viewer, DIR, INTENTS, USDC } from "./lib.mjs";
import { matchesRefusal } from "./assertions.mjs";
const R = JSON.parse(fs.readFileSync(DIR + "results.json", "utf8"));
const v = await viewer(); const ESC = R.escrow;
const view = (m, a = {}) => v.viewFunction({ contractId: ESC, methodName: m, args: a });
const mt = (acc) => v.viewFunction({ contractId: INTENTS, methodName: "mt_balance_of", args: { account_id: acc, token_id: USDC } }).then(BigInt);
let failed = 0; const line = (ok, name, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`); };
const st = async (id) => (await view("get_bet", { bet_id: id }))?.status;

line(!!ESC && ESC.startsWith("drill1-") && ESC !== "praetorial-frz1b-2611081810.praetorial-dev-1101.testnet", "throwaway escrow is not the FRZ1b rehearsal escrow", ESC);
const state = await v.connection.provider.query({ request_type: "view_account", account_id: ESC, finality: "final" });
line(state.code_hash !== "11111111111111111111111111111111", "escrow has code deployed");
line(R.wasm_sha256 === "caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f", "deployed wasm sha256 recorded = freeze-candidate-2 caf134a4");
// final state
line((await guardianOf(v, ESC)) === R.guardians.G2, "guardian (view_state; no `guardian` view method exists) == G2", String(await guardianOf(v, ESC)));
line((await view("is_shutdown")) === true, "is_shutdown == true");
line((await view("is_new_offers_paused")) === true, "new offers paused (implied by shutdown)");
line((await view("pending_guardian")) === null, "no pending guardian");
// bets
const { A, B, C } = R.bets;
line((await st(A.id)) === "Voided", "bet A (Open) -> Voided by emergency_refund", await st(A.id));
line(["Finalized", "Settled"].includes(await st(B.id)), "bet B (conceded) terminal Finalized/Settled", await st(B.id));
line((await st(C.id)) === "Voided", "bet C (Taken) -> Voided by emergency_refund", await st(C.id));
for (const [n, b] of Object.entries({ A, B, C })) {
  const p = await view("pending_payouts", { bet_id: b.id });
  line(p.every((x) => x.done), `bet ${n}: no undone payout line (done lines are pruned from the view)`, `${p.length} remaining`);
  line((await view("is_fully_paid", { bet_id: b.id })) === true, `bet ${n}: is_fully_paid`);
}
// refusals recorded live must each have happened and carry the contract's string
let valid = 0;
for (const f of R.refusals ?? []) {
  if (f.invalid) { console.log(`SKIP ${f.step}  (invalid evidence, superseded: ${f.note ?? f.invalid})`); continue; }
  valid++;
  if (f.kind === "panic") line(f.observed === true && matchesRefusal(f.text, f.expected), `refusal: ${f.step}`, `expected "${f.expected}"`);
  else line(f.observed === true, `refusal: ${f.step}`, f.note ?? "");
}
line(valid >= 18, "all drill refusals/state checks recorded", `${valid} valid`);
// residue / balances: current chain balances vs recorded before + expected credits
// keeper evidence: emergency_refund issued for A and C only, never for terminal B
const ka = (R.keeper_actions ?? []).filter((x) => x.action === "emergency_refund" && x.status === "ok").map((x) => x.bet_id).sort();
line(JSON.stringify(ka) === JSON.stringify([A.id, C.id].sort()) && !(R.keeper_actions ?? []).some((x) => x.bet_id === B.id && x.action === "emergency_refund"), "keeper issued emergency_refund exactly for A and C and skipped terminal B", JSON.stringify(ka));
const accts = R.balances?.before ?? {};
for (const [acc, before] of Object.entries(accts)) {
  const exp = BigInt(R.expected_credits?.[acc] ?? "0") - BigInt(R.expected_debits?.[acc] ?? "0");
  const now = await mt(acc);
  line(now - BigInt(before) === exp, `balance delta ${acc}`, `before=${before} now=${now} delta=${now - BigInt(before)} expected=${exp}`);
}
const eb = BigInt(R.escrow_balance?.before ?? "-1"); const en = await mt(ESC);
line(eb >= 0n && en === eb, "escrow intents (usdc) balance == pre-drill balance (residue 0)", `before=${eb} now=${en}`);
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
