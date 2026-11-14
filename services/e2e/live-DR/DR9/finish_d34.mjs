// DR9 drills 3+4 finish. emergency_refund only SCHEDULES payout lines (attempts 0, not in flight): the keeper's drain loop moves the money. We deliberately did
// not run a drain, so those lines are a real delayed payout: drill 3 = retry_payout (one line) + drain_payouts (the rest) on them; drill 4 money check follows.
import { account, store, view, bal, tryCall, KEEPER, FEE, sleep } from "./lib.mjs";
import { checkRefunds, drill3Verdict } from "./expected.ts";
const { load, save, rec } = store("run/d34_results.json");
const R = load(); const ESC = R.escrow, A = R.accounts, INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const keeper = await account(KEEPER); const v = (m, a) => view(ESC, m, a);
const [betB, betC] = [R.bets.B, R.bets.C];
const pend = async (id) => await v("pending_payouts", { bet_id: id });
const before = { B: await pend(betB), C: await pend(betC) };
const d3 = { pending_before: { B: before.B.map((p) => ({ id: p.id, receiver: p.receiver, amount: p.amount, attempts: p.attempts, done: p.done, in_flight: p.in_flight })), C: before.C.map((p) => ({ id: p.id, receiver: p.receiver, amount: p.amount, attempts: p.attempts, done: p.done, in_flight: p.in_flight })) }, txs: [] };
const first = before.B[0].id;
const r1 = await tryCall(keeper, ESC, "retry_payout", { id: first }, { deposit: 0n, gas: 200_000_000_000_000n }); if (r1.hash) { rec("retry_payout_line" + first, r1.hash, { ok: r1.ok }); if (r1.ok) d3.txs.push(r1.hash); } else d3.retry_error = r1.failure;
d3.retry_failure = r1.failure; await sleep(8000);
for (const id of [betB, betC]) {
  const r = await tryCall(keeper, ESC, "drain_payouts", { bet_id: id, limit: 20 }, { deposit: 0n, gas: 300_000_000_000_000n });
  if (r.hash) rec("drain_payouts_bet" + id, r.hash, { ok: r.ok }); if (r.ok) d3.txs.push(r.hash); else d3[`drain_${id}_failure`] = r.failure;
}
const INTENTS_BAL = async () => ({ m2: await bal(INTENTS, A.m2), t2: await bal(INTENTS, A.t2), m3: await bal(INTENTS, A.m3), fee: await bal(INTENTS, FEE), esc: await bal(INTENTS, ESC) });
const b = (await v("get_bet", { bet_id: betB })), c = (await v("get_bet", { bet_id: betC }));
const lines = (x) => ({ maker: x.envelope.maker, taker: x.taker ?? null, stakeM: BigInt(x.envelope.stake_maker), stakeT: BigInt(x.envelope.stake_taker), storageM: BigInt(x.storage_maker), storageT: BigInt(x.storage_taker) });
const eB = lines(b), eC = lines(c); let s;
for (let i = 0; i < 25; i++) { await sleep(3000); s = await INTENTS_BAL(); if (s.m2 === eB.stakeM + eB.storageM && s.t2 === eB.stakeT + eB.storageT && s.m3 === eC.stakeM + eC.storageM) break; }
// accounts are fresh (balance 0 before the deposits, deposits left the balance at 0), so balance == credit; fee delta checked against the recorded pre-snapshot
const d = { m2: s.m2, t2: s.t2, m3: s.m3 };
const feeDelta = s.fee - BigInt(R.snapshot_before?.fee ?? s.fee);
const bad = [...checkRefunds(eB, FEE, { [A.m2]: d.m2, [A.t2]: d.t2, [FEE]: 0n }, 0n), ...checkRefunds(eC, FEE, { [A.m3]: d.m3, [FEE]: 0n }, s.esc)];
const pa = { B: await pend(betB), C: await pend(betC) };
d3.pending_after = { B: pa.B.length, C: pa.C.length }; d3.fully_paid = { B: await v("is_fully_paid", { bet_id: betB }), C: await v("is_fully_paid", { bet_id: betC }) };
d3.verdict = drill3Verdict({ causedDelay: before.B.every((p) => !p.done && !p.in_flight && p.attempts === 0), txs: d3.txs });
if (!(d3.fully_paid.B && d3.fully_paid.C)) d3.verdict = { verdict: "FAIL", reason: "lines not fully paid after retry/drain" };
R.drill3 = d3;
R.refunds = { expected_per_party: { B_maker: String(eB.stakeM + eB.storageM), B_taker: String(eB.stakeT + eB.storageT), C_maker: String(eC.stakeM + eC.storageM) }, observed_balance_after: Object.fromEntries(Object.entries(d).map(([k, x]) => [k, x.toString()])), escrow_intents_balance_after: s.esc.toString(), fee_account_delta_during_drill: feeDelta.toString(), mismatches: bad };
R.status_final = { B: b.status, C: c.status };
R.verdict_drill4 = bad.length === 0 && !R.refunds.mismatches.length ? "PASS" : "FAIL";
save(R); console.log(JSON.stringify(R.refunds), JSON.stringify(R.drill3), "DRILL4", R.verdict_drill4);
