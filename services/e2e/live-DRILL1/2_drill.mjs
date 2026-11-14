// DRILL1 steps 2-5: pause, concede-while-paused, unpause/pause, guardian rotation, emergency_shutdown + refusals.
// usage (from services/): NEAR_RPC_URL=... node --import tsx e2e/live-DRILL1/2_drill.mjs
import fs from "node:fs";
import { guardianOf, account, viewer, load, save, recordTx, observe, tryCall, MAKER, TAKER, FEE, KEEPER, INTENTS, USDC, DIR, bal, sleep } from "./lib.mjs";
import { REFUSALS, matchesRefusal, concedeCredits, refundCredits, mergeCredits } from "./assertions.mjs";
import { buildOpenMsg } from "../../common/src/openMsg.ts";
const R0 = load(); const ESC = R0.escrow; const G = R0.guardians; const { A, B, C } = R0.bets; const stake = BigInt(R0.stake);
const v = await viewer(); const view = (m, a = {}) => v.viewFunction({ contractId: ESC, methodName: m, args: a });
const acc = { G1: await account(G.G1), G2: await account(G.G2), G3: await account(G.G3), maker: await account(MAKER), taker: await account(TAKER), keeper: await account(KEEPER) };
const refusals = []; const pushRef = (o) => { refusals.push(o); const r = load(); r.refusals = refusals; save(r); console.log(o.observed ? "REFUSED" : "NOT-REFUSED", o.step, (o.text ?? o.note ?? "").slice(0, 160)); };
const NONPAYABLE = new Set(["emergency_refund", "void_after_deadline", "concede", "drain_payouts"]);
const until = async (fn, pred, ms = 20000) => { const t0 = Date.now(); let x; do { x = await fn(); if (pred(x)) return x; await sleep(1500); } while (Date.now() - t0 < ms); return x; };
async function expectPanic(step, who, method, args, expected, hashStep) {
  const res = await tryCall(acc[who], ESC, method, args, { deposit: NONPAYABLE.has(method) ? 0n : 1n });
  if (res.hash) recordTx(`${hashStep ?? step}${res.ok ? "_UNEXPECTEDLY_OK" : "_refused"}`, res.hash);
  pushRef({ step, kind: "panic", caller: who === "G1" || who === "G2" || who === "G3" ? G[who] : who, method, expected, text: res.failure, observed: !res.ok && matchesRefusal(res.failure, expected) });
}
async function expectOk(step, who, method, args, hashStep) {
  const res = await tryCall(acc[who], ESC, method, args, { deposit: 1n });
  if (res.hash) recordTx(hashStep ?? step, res.hash, { ok: res.ok });
  if (!res.ok) throw new Error(`${step} failed unexpectedly: ${res.failure}`);
}
const g = async () => ({ guardian: await guardianOf(v, ESC), pending: await view("pending_guardian"), paused: await view("is_new_offers_paused"), shutdown: await view("is_shutdown") });
observe("state_initial", await g());

// ---- step 2: pause
await expectPanic("non-guardian (G3) pause_new_offers refused", "G3", "pause_new_offers", {}, REFUSALS.onlyGuardian);
await expectPanic("emergency_refund before shutdown refused", "keeper", "emergency_refund", { bet_id: C.id }, "emergency_refund is only callable after emergency_shutdown");
await expectOk("G1 pause_new_offers", "G1", "pause_new_offers", {}, "pause_new_offers_1");
if ((await view("is_new_offers_paused")) !== true) throw new Error("not paused");
// refused open + take (silent refund: the contract never panics in mt_on_transfer, it returns the whole amount)
const req = BigInt(A.req);
const mint = async (who, amt, label) => { const r = await acc.keeper.functionCall({ contractId: INTENTS, methodName: "mint", args: { account_id: who, token_id: USDC, amount: amt.toString() }, gas: 30_000_000_000_000n }); recordTx(label, r.transaction.hash); };
await mint(G.G3, req * 2n, "mint_G3_for_refused_open_and_take");
const g3before = await bal(v, G.G3), escBefore = await bal(v, ESC), countBefore = await view("bet_count"), betABefore = await view("get_bet", { bet_id: A.id });
const outA = fs.readFileSync(DIR + "sourcecheck_A.log", "utf8"); const checkedAt = outA.match(/"checked_at":\s*(\d+)/)[1]; const sig = JSON.parse(outA.slice(outA.indexOf("{", outA.indexOf("Tx:")))).signing.signature_hex;
const termsA = JSON.parse(fs.readFileSync(DIR + "job_sourcecheck_A.json", "utf8")).terms;
const now = Date.now() * 1e6;
const env = { bet_id: 0, version: 1, maker: G.G3, taker_allow: { Any: {} }, terms_hash: A.spec_hash, models_snapshot_hash: "drill1-testnet", outcomes: ["YES", "NO"], maker_side: "YES", maker_asset: USDC, taker_asset: USDC, stake_maker: stake.toString(), stake_taker: stake.toString(), fee_bps: 100, storage_charge_per_side: "0", keep_terms: true, terms: termsA, max_paid_runs: 3, tier: 1, funding_deadline: now + 7200e9, early_settle_outcome: null, finality_delay: 0, settlement_period: 3600e9, resolve_deadline: now + 30 * 86400e9, consent_party_controlled: false };
const o = await acc.G3.functionCall({ contractId: INTENTS, methodName: "transfer_with_msg", args: { receiver_id: ESC, token_id: USDC, amount: req.toString(), msg: buildOpenMsg(env, { checked_at: checkedAt, signature_hex: sig }) }, gas: 80_000_000_000_000n });
recordTx("open_while_paused_refused", o.transaction.hash);
await sleep(3000);
const afterOpen = { g3: await bal(v, G.G3), count: await view("bet_count"), esc: await bal(v, ESC) };
pushRef({ step: "open_bet while paused refused (silent full refund)", kind: "silent_refund", observed: afterOpen.g3 === g3before && afterOpen.count === countBefore && afterOpen.esc === escBefore, note: `tx succeeded; mt_on_transfer returned the full amount. bet_count ${countBefore}->${afterOpen.count}; maker balance ${g3before}->${afterOpen.g3}; escrow balance ${escBefore}->${afterOpen.esc}` });
const t = await acc.G3.functionCall({ contractId: INTENTS, methodName: "transfer_with_msg", args: { receiver_id: ESC, token_id: USDC, amount: req.toString(), msg: JSON.stringify({ kind: "Take", bet_id: A.id, invite_sig: null }) }, gas: 80_000_000_000_000n });
recordTx("take_A_while_paused_refused", t.transaction.hash);
await sleep(3000);
const betAAfter = await view("get_bet", { bet_id: A.id });
pushRef({ step: "take of Open bet A while paused refused (silent full refund)", kind: "silent_refund", observed: betAAfter.status === "Open" && betAAfter.taker === null && (await bal(v, G.G3)) === g3before && (await bal(v, ESC)) === escBefore, note: `A status ${betAAfter.status}, taker ${betAAfter.taker}; taker balance ${g3before}->${await bal(v, G.G3)}` });
// B concede while paused; payout lands
const makerB = await bal(v, MAKER), takerB = await bal(v, TAKER), feeB = await bal(v, FEE);
const cres = await tryCall(acc.taker, ESC, "concede", { bet_id: B.id }, { gas: 300_000_000_000_000n });
recordTx("concede_B_while_paused", cres.hash, { ok: cres.ok });
if (!cres.ok) throw new Error("concede failed: " + cres.failure);
await sleep(6000);
let pend = await view("pending_payouts", { bet_id: B.id });
if (pend.some((p) => !p.done)) { const d = await tryCall(acc.keeper, ESC, "drain_payouts", { bet_id: B.id, limit: 20 }, { gas: 300_000_000_000_000n }); recordTx("drain_payouts_B", d.hash, { ok: d.ok }); await sleep(6000); pend = await view("pending_payouts", { bet_id: B.id }); }
const expB = concedeCredits({ maker: MAKER, taker: TAKER, conceder: TAKER, stakeM: stake, stakeT: stake, feeBps: 100n, minFeeM: BigInt(B.fee_min_maker), minFeeT: BigInt(B.fee_min_taker), storageM: BigInt(B.storage_maker_view), storageT: BigInt(B.storage_taker_view), feeAccount: FEE });
const dM = (await bal(v, MAKER)) - makerB, dT = (await bal(v, TAKER)) - takerB, dF = (await bal(v, FEE)) - feeB;
observe("B_concede_payout", { expected: Object.fromEntries([...expB].map(([k, x]) => [k, x.toString()])), observed: { [MAKER]: dM.toString(), [TAKER]: dT.toString(), [FEE]: dF.toString() }, lines: pend.map((p) => ({ receiver: p.receiver, amount: p.amount, reason: p.reason, done: p.done })) });
pushRef({ step: "B concede while paused: payout lands exactly", kind: "state", observed: dM === expB.get(MAKER) && dF === expB.get(FEE) && dT === 0n && pend.every((p) => p.done), note: `maker +${dM} (exp ${expB.get(MAKER)}), fee +${dF} (exp ${expB.get(FEE)}), taker ${dT}` });
// ---- step 3: unpause then pause again
await expectOk("G1 unpause_new_offers", "G1", "unpause_new_offers", {}, "unpause_new_offers");
pushRef({ step: "unpause: is_new_offers_paused false", kind: "state", observed: (await until(() => view("is_new_offers_paused"), (x) => x === false)) === false });
await expectOk("G1 pause_new_offers (again)", "G1", "pause_new_offers", {}, "pause_new_offers_2");
pushRef({ step: "pause again: is_new_offers_paused true", kind: "state", observed: (await view("is_new_offers_paused")) === true });
// ---- step 4: guardian rotation
await expectPanic("non-guardian (G3) set_guardian refused", "G3", "set_guardian", { new_guardian: G.G3 }, REFUSALS.onlyGuardian);
await expectOk("G1 set_guardian(G2)", "G1", "set_guardian", { new_guardian: G.G2 }, "set_guardian_G2_1");
pushRef({ step: "set_guardian(G2) proposes only (guardian still G1, pending G2)", kind: "state", observed: (await guardianOf(v, ESC)) === G.G1 && (await view("pending_guardian")) === G.G2 });
await expectPanic("G3 accept_guardian refused (not the proposed)", "G3", "accept_guardian", {}, REFUSALS.onlyProposed);
await expectOk("G1 cancel_guardian", "G1", "cancel_guardian", {}, "cancel_guardian");
pushRef({ step: "cancel_guardian clears pending", kind: "state", observed: (await view("pending_guardian")) === null });
await expectOk("G1 set_guardian(G2) again", "G1", "set_guardian", { new_guardian: G.G2 }, "set_guardian_G2_2");
await expectOk("G2 accept_guardian", "G2", "accept_guardian", {}, "accept_guardian");
pushRef({ step: "after accept: guardian view == G2", kind: "state", observed: (await until(() => guardianOf(v, ESC), (x) => x === G.G2)) === G.G2 && (await view("pending_guardian")) === null });
await expectPanic("old guardian G1 pause_new_offers refused after rotation", "G1", "pause_new_offers", {}, REFUSALS.onlyGuardian);
// ---- step 5: shutdown
await expectPanic("non-guardian (G1, old) emergency_shutdown refused", "G1", "emergency_shutdown", {}, REFUSALS.onlyGuardian);
await expectOk("G2 emergency_shutdown", "G2", "emergency_shutdown", {}, "emergency_shutdown");
pushRef({ step: "is_shutdown true", kind: "state", observed: (await view("is_shutdown")) === true });
await expectPanic("G2 unpause_new_offers refused after shutdown", "G2", "unpause_new_offers", {}, REFUSALS.unpauseAfterShutdown);
await expectPanic("second emergency_shutdown refused", "G2", "emergency_shutdown", {}, REFUSALS.alreadyShutdown);
await expectPanic("void_after_deadline refused after shutdown", "keeper", "void_after_deadline", { bet_id: C.id }, REFUSALS.voidAfterShutdown);
await expectPanic("concede on C refused after shutdown", "maker", "concede", { bet_id: C.id }, REFUSALS.voidAfterShutdown);
// expected net balances (credits - deposits) over the whole drill
const dep = (b) => BigInt(b.req);
const refA = refundCredits({ maker: MAKER, taker: null, stakeM: stake, stakeT: 0n, storageM: BigInt(A.storage), storageT: 0n });
const refC = refundCredits({ maker: MAKER, taker: TAKER, stakeM: stake, stakeT: stake, storageM: BigInt(C.storage), storageT: BigInt(C.storage) });
const credits = mergeCredits(expB, refA, refC);
const deposits = new Map([[MAKER, dep(A) + dep(B) + dep(C)], [TAKER, dep(B) + dep(C)]]);
const net = {}; for (const a of [MAKER, TAKER, FEE]) net[a] = (credits.get(a) ?? 0n).toString(); // mints == deposits exactly, so balance delta since before-mint == credits
net[G.G3] = "0";
const r = load(); r.expected_credits = net; r.balances.before[G.G3] = g3before.toString();
r.refund_rule = "lib.rs emergency_refund: maker/taker each get stake + storage back, NO fee; concede: winner gets both stakes minus per-side fee max(1%, 500000), fee account gets fees + both storage charges";
r.expected_detail = { credits: Object.fromEntries([...credits].map(([k, x]) => [k, x.toString()])), deposits: Object.fromEntries([...deposits].map(([k, x]) => [k, x.toString()])) };
save(r);
console.log("done steps 2-5", JSON.stringify(net), "refusals", refusals.length);
