// DR9 drill 4 on the THROWAWAY escrow (never frz3): bet B Taken (m2/t2), bet C Open (m3), guardian emergency_shutdown (immediate, no timelock in the frozen
// contract), emergency_refund for both, refunds per party == offline expectation (expected.ts emergencyRefundCredits/checkRefunds).
import { account, store, view, bal, tryCall, prepareOpen, buildTakeMsg, KEEPER, FEE, USDC, sleep } from "./lib.mjs";
import { checkRefunds } from "./expected.ts";
const { load, save, rec } = store("run/d34_results.json");
const R = load(); const ESC = R.escrow, A = R.accounts, INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const [g, m2, t2, m3, keeper, nonG] = await Promise.all([account(A.guardian), account(A.m2), account(A.t2), account(A.m3), account(KEEPER), account("maker1.praetorial-dev-1101.testnet")]);
const v = (m, a) => view(ESC, m, a);
const keys = await v("resolver_keys"); const cfg = await v("outlayer_config");
if (await v("is_shutdown")) throw new Error("already shut down");
const RESUME = !!R.bets;
const B = RESUME ? null : prepareOpen({ escrow: ESC, keys, wasmBase: cfg.wasm_base_url, maker: A.m2, tag: "d4b" });
const C = RESUME ? null : prepareOpen({ escrow: ESC, keys, wasmBase: cfg.wasm_base_url, maker: A.m3, tag: "d4c" });
const mint = async (who, amt, step) => { const r = await keeper.functionCall({ contractId: INTENTS, methodName: "mint", args: { account_id: who, token_id: USDC, amount: amt }, gas: 30_000_000_000_000n }); rec(step, r.transaction.hash); };
const xfer = async (acc, args, step) => { const r = await acc.functionCall({ contractId: INTENTS, methodName: "transfer_with_msg", args, gas: 80_000_000_000_000n }); rec(step, r.transaction.hash); };
const openBet = async (acc, P, step) => { const n0 = (await v("open_offers", { from: 0, limit: 500 })).length; await xfer(acc, { receiver_id: ESC, token_id: USDC, amount: P.dep, msg: P.msg }, step); await sleep(4000); const o = (await v("open_offers", { from: 0, limit: 500 })).filter((x) => x.envelope.terms_hash === P.built.terms_hash).pop(); if (!o) throw new Error(step + " not created"); return o.envelope.bet_id; };
let betB, betC;
if (RESUME) { betB = R.bets.B; betC = R.bets.C; } else {
await mint(A.m2, B.dep, "mint_m2"); await mint(A.t2, B.dep, "mint_t2"); await mint(A.m3, C.dep, "mint_m3");
betB = await openBet(m2, B, "open_B"); await xfer(t2, { receiver_id: ESC, token_id: USDC, amount: B.dep, msg: buildTakeMsg(betB, null) }, "take_B"); await sleep(4000);
betC = await openBet(m3, C, "open_C"); }
let bB = await v("get_bet", { bet_id: betB }), bC = await v("get_bet", { bet_id: betC });
R.bets = { B: betB, C: betC }; R.status_before = { B: bB.status, C: bC.status }; save(R);
if (!RESUME && (bB.status !== "Taken" || bC.status !== "Open")) throw new Error(`unexpected statuses ${bB.status}/${bC.status}`);
const snap = async () => ({ m2: await bal(INTENTS, A.m2), t2: await bal(INTENTS, A.t2), m3: await bal(INTENTS, A.m3), fee: await bal(INTENTS, FEE), esc: await bal(INTENTS, ESC) });
const s0 = await snap(); // resume: no balance has moved since the deposits (shutdown not yet sent)
 R.snapshot_before = Object.fromEntries(Object.entries(s0).map(([k, x]) => [k, x.toString()]));
const lines = (b) => ({ maker: b.envelope.maker, taker: b.taker ?? null, stakeM: BigInt(b.envelope.stake_maker), stakeT: BigInt(b.envelope.stake_taker), storageM: BigInt(b.storage_maker), storageT: BigInt(b.storage_taker) });
const refusals = [];
const refuse = async (step, acc, method, args, expect, deposit = 1n) => { const r = await tryCall(acc, ESC, method, args, { deposit }); if (r.hash) rec(step, r.hash); refusals.push({ step, ok: !r.ok && (r.failure ?? "").includes(expect), text: (r.failure ?? "").slice(-160) }); };
await refuse("non_guardian_shutdown_refused", nonG, "emergency_shutdown", {}, "only guardian");
await refuse("emergency_refund_before_shutdown_refused", keeper, "emergency_refund", { bet_id: betB }, "only callable after emergency_shutdown", 0n);
const sd = await tryCall(g, ESC, "emergency_shutdown", {}, { deposit: 1n }); if (!sd.ok) throw new Error("shutdown failed " + sd.failure); rec("emergency_shutdown", sd.hash);
await sleep(2500); R.shutdown_view = await v("is_shutdown"); save(R);
await refuse("unpause_after_shutdown_refused", g, "unpause_new_offers", {}, "unpause is impossible after shutdown");
await refuse("second_shutdown_refused", g, "emergency_shutdown", {}, "already shut down");
for (const id of [betB, betC]) {
  let done = false;
  for (let i = 0; i < 12 && !done; i++) { const r = await tryCall(keeper, ESC, "emergency_refund", { bet_id: id }, { deposit: 0n, gas: 200_000_000_000_000n }); if (r.ok) { rec(`emergency_refund_bet${id}`, r.hash); done = true; } else { console.log("refund retry", id, (r.failure ?? "").slice(-120)); await sleep(5000); } }
  if (!done) throw new Error("emergency_refund never accepted for " + id);
}
const expB = lines(bB), expC = lines(bC); const exp = { B: expB, C: expC };
let s1; for (let i = 0; i < 25; i++) { await sleep(3000); s1 = await snap(); if (s1.m2 - s0.m2 === expB.stakeM + expB.storageM && s1.t2 - s0.t2 === expB.stakeT + expB.storageT && s1.m3 - s0.m3 === expC.stakeM + expC.storageM) break; }
const d = { m2: s1.m2 - s0.m2, t2: s1.t2 - s0.t2, m3: s1.m3 - s0.m3, fee: s1.fee - s0.fee };
const bad = [...checkRefunds(expB, FEE, { [A.m2]: d.m2, [A.t2]: d.t2, [FEE]: 0n }, 0n), ...checkRefunds(expC, FEE, { [A.m3]: d.m3, [FEE]: 0n }, s1.esc)].filter(() => true);
// checkRefunds is per bet; the shared fee-account delta is checked once here (d.fee must be 0: refunds carry no fee)
if (d.fee !== 0n) bad.push(`fee account delta ${d.fee} != 0 (note: fee account is shared with other live work; a non-zero value may be unrelated, investigate)`);
R.refunds = { expected: { B: Object.fromEntries(Object.entries(expB).map(([k, x]) => [k, String(x)])), C: Object.fromEntries(Object.entries(expC).map(([k, x]) => [k, String(x)])) }, observed_delta: Object.fromEntries(Object.entries(d).map(([k, x]) => [k, x.toString()])), escrow_intents_balance_after: s1.esc.toString(), mismatches: bad };
bB = await v("get_bet", { bet_id: betB }); bC = await v("get_bet", { bet_id: betC });
R.status_after = { B: bB.status, C: bC.status }; R.refusals = refusals; R.verdict = bad.length === 0 && refusals.every((x) => x.ok) ? "PASS" : "FAIL"; save(R);
console.log(JSON.stringify(R.refunds), JSON.stringify(R.status_after), JSON.stringify(refusals.map((x) => [x.step, x.ok])), "DRILL4", R.verdict);
process.exit(R.verdict === "PASS" ? 0 : 1);
