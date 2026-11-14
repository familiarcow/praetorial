// LFIX1: the bet page through one full AI dispute (SM1 LIFE-1 / SVC-1, re-checked on main after LIFE1), plus the challenge gates the
// frozen escrow does NOT enforce (SM1 CON-1: a bond is accepted with no time / feasibility guard and then forfeited unreviewed; CON-5:
// a round-2 bond is accepted from Evidence before round 1 was re-judged). Every expectation is the CONTRACT's behaviour
// (contracts/escrow/src/lib.rs handle_bond / request_resolution / finalize); the page must offer a bond only when the re-judge it
// pays for can still happen.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { betView } from "../lib/betView";
import { challengeOffer, challengeGuard } from "../lib/ruling";
import { challengeRefusal, CHALLENGE_DEADLINE_MARGIN_NS, REJUDGE_DEADLINE_MARGIN_NS } from "../lib/betLifecycle";

const here = dirname(fileURLToPath(import.meta.url));
const H = 3_600_000_000_000; // 1h in ns
const DAY = 24 * H;
const T = 1_900_000_000_000 * 1e6; // funding_deadline = event time (ns)
const USDC = "nep141:usdc.near";
const ms = (ns: number) => ns / 1e6;
const P = T + H; // the AI's first ruling lands 1h after the event
const QUOTE = { amount: "5005000", asset: USDC };
const BOND1 = { holder: "taker.near", amount: "5005000", round: 1, pre_challenge_outcome: "YES", asset: USDC };

function bet(o: any = {}): any {
  const { envelope, ...rest } = o;
  return {
    envelope: {
      bet_id: 1, maker: "maker.near", taker_allow: "Any", terms_hash: "ab".repeat(32), outcomes: ["YES", "NO"], maker_side: "YES",
      maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100,
      keep_terms: true, terms: null, max_paid_runs: 3, funding_deadline: T, resolve_deadline: T + 7 * DAY,
      settlement_period: DAY, referee: null, early_settle_outcome: null, ...(envelope ?? {}),
    },
    status: "Taken", taker: "taker.near", created_at: 0, taken_at: 1, proposed_at: null, outcome: null, bonds: [], exhibits: [],
    challenged_by: null, window_extension_ns: 0, pending_resolution_request: null, runs_used: 0, fee_min_maker: "0", fee_min_taker: "0",
    tip_maker: "0", tip_taker: "0", storage_maker: "0", storage_taker: "0", next_check_ns: null, no_live_judge_until_ns: null, ...rest,
  };
}
// Round 0 ruled YES (maker's side): the taker lost and may challenge.
const ruled = (o: any = {}) => bet({ status: "Proposed", outcome: "YES", proposed_at: P, runs_used: 1, pending_resolution_request: 0, ...o });
// After the taker's bond: the contract keeps the outcome and the stale pending_resolution_request (rt1b.rs:746).
const challenged = (o: any = {}) => ruled({ status: "Challenged", bonds: [BOND1], pre_challenge_outcome: "YES", challenged_by: "taker.near", ...o });
const ids = (v: any) => [v.primary?.id, ...v.secondary.map((a: any) => a.id)].filter(Boolean);

test("LIFE-1 (main, after LIFE1): the page walks one whole dispute with the action the contract needs at each step", () => {
  // 1. Ruling YES, inside the 24h window: the loser (taker) is offered the challenge; the winner is not.
  const r0 = ruled();
  const t1 = ms(P + 2 * H);
  assert.equal(betView(r0, "taker.near", t1).primary?.id, "challenge");
  assert.equal(challengeOffer(r0, "taker.near", QUOTE, t1).kind, "available");
  assert.ok(!ids(betView(r0, "maker.near", t1)).includes("challenge"));
  // 2. Bond landed (Challenged): "the AI looks again", when, and no Finalize / no second bond / no request yet (evidence window).
  const c = challenged();
  for (const me of ["taker.near", "maker.near"]) {
    const v = betView(c, me, t1);
    assert.equal(v.phase, "challenged");
    assert.match(v.sentence, /Challenged by .*The AI looks again\./);
    assert.equal(v.next?.at, ms(P + DAY), "second look due when the challenge window ends");
    assert.ok(!ids(v).includes("finalize") && !ids(v).includes("challenge") && !ids(v).includes("request-result"), `${me}: ${ids(v)}`);
  }
  // 3. Window over: the re-judge request is offered (the keeper sends it too); Finalize still refused by the contract.
  const t3 = ms(P + DAY + 60_000);
  const v3 = betView(c, "taker.near", t3);
  assert.equal(v3.primary?.id, "request-result");
  assert.ok(!ids(v3).includes("finalize"));
  // 4. Re-judge running.
  assert.equal(betView(challenged({ status: "Resolving", pending_run_no: 2 }), "taker.near", t3).phase, "judging");
  // 5. Re-judge flipped it to NO (Proposed again, bonds kept): the maker now lost and may use the final appeal (runs left: 2 < 3).
  const r1 = ruled({ outcome: "NO", proposed_at: P + DAY + 10 * 60 * 1e9, runs_used: 2, bonds: [BOND1], pre_challenge_outcome: "YES" });
  const t5 = ms(P + DAY + H);
  const o5: any = challengeOffer(r1, "maker.near", { amount: "10005000", asset: USDC }, t5);
  assert.equal(o5.kind, "available");
  assert.equal(o5.round, 2);
  assert.equal(betView(r1, "maker.near", t5).primary?.id, "challenge");
  assert.ok(!ids(betView(r1, "taker.near", t5)).includes("challenge"), "the re-judge's winner is not offered a challenge");
});

test("CON-5: no round-2 bond while round 1 is still waiting for its re-judge (Evidence = exhibits/objections filed, not re-judged)", () => {
  const t = ms(P + 2 * H); // still inside the round-1 challenge window
  for (const me of ["taker.near", "maker.near"]) {
    for (const outcome of ["YES", "VOID"]) {
      const ev = challenged({ status: "Evidence", outcome, exhibits: [{ hash: "h", submitted_at: "1", submitted_by: me }] });
      const o = challengeOffer(ev, me, QUOTE, t);
      assert.notEqual(o.kind, "available", `${me} offered a round-2 bond on an Evidence bet (outcome ${outcome}): the contract takes it and burns max_rounds`);
      assert.ok(!ids(betView(ev, me, t)).includes("challenge"));
      assert.notEqual(challengeRefusal(ev, t), null);
    }
  }
  assert.equal(challengeRefusal(challenged({ status: "Evidence" }), t)?.id, "pending-round");
  assert.equal(challengeRefusal(challenged(), t)?.id, "pending-round");
});

test("CON-1: no bond when the re-judge it pays for can no longer run (runs used up, too close to resolve_deadline, no judge until then)", () => {
  const t = ms(P + 2 * H);
  // (a) every paid run used: the contract takes the bond, refuses request_resolution ("max_paid_runs reached") and finalize forfeits it.
  const spent = ruled({ runs_used: 3 });
  assert.equal(challengeRefusal(spent, t)?.id, "no-runs-left");
  const os: any = challengeOffer(spent, "taker.near", QUOTE, t);
  assert.equal(os.kind, "closed");
  assert.match(os.message, /used all its checks/);
  assert.ok(!ids(betView(spent, "taker.near", t)).includes("challenge"));
  assert.doesNotMatch(betView(spent, "taker.near", t).sentence, /You can challenge it/);
  // (b) resolve_deadline inside the challenge window: the keeper asks for the re-judge by resolve_deadline - 1h at the latest,
  // so a bond is offered only up to resolve_deadline - CHALLENGE_DEADLINE_MARGIN_NS.
  assert.ok(CHALLENGE_DEADLINE_MARGIN_NS > REJUDGE_DEADLINE_MARGIN_NS);
  const rd = P + 10 * H;
  const near = ruled({ envelope: { resolve_deadline: rd } });
  assert.equal(challengeRefusal(near, ms(rd - CHALLENGE_DEADLINE_MARGIN_NS - 60e9)), null, "still enough time");
  assert.equal(challengeRefusal(near, ms(rd - CHALLENGE_DEADLINE_MARGIN_NS))?.id, "deadline-near");
  assert.equal(challengeOffer(near, "taker.near", QUOTE, ms(rd - H)).kind, "closed");
  assert.ok(!ids(betView(near, "taker.near", ms(rd - H))).includes("challenge"));
  // (c) RETRY:no_live_judge holds request_resolution past the margin: nobody can ask for the re-judge in time.
  const noJudge = ruled({ no_live_judge_until_ns: T + 7 * DAY - H });
  assert.equal(challengeRefusal(noJudge, t)?.id, "no-live-judge");
  assert.equal(challengeOffer(noJudge, "taker.near", QUOTE, t).kind, "closed");
  // the window itself still closes the offer with the old words
  const late: any = challengeOffer(ruled(), "taker.near", QUOTE, ms(P + DAY));
  assert.deepEqual([late.kind, late.message], ["closed", "Challenge window closed"]);
});

test("challenge modal re-reads the bet before the bond is signed (the 15s poll can be stale)", () => {
  const shown = ruled();
  const t = ms(P + 2 * H);
  assert.deepEqual(challengeGuard(shown, ruled(), t), { ok: true });
  for (const [why, fresh] of [
    ["someone bonded first (Challenged)", challenged()],
    ["evidence filed (Evidence)", challenged({ status: "Evidence" })],
    ["finalized", ruled({ status: "Finalized" })],
    ["ruling changed", ruled({ outcome: "NO", proposed_at: P + 3 * H })],
    ["runs used up meanwhile", ruled({ runs_used: 3 })],
    ["not readable", null],
  ] as const) {
    const g = challengeGuard(shown, fresh as any, t);
    assert.equal(g.ok, false, why);
    assert.match((g as any).message, /Nothing was sent/, why);
  }
  // the window closed while the modal was open
  assert.equal(challengeGuard(shown, ruled(), ms(P + DAY)).ok, false);
  // wiring: ChallengeModal runs the guard on a fresh get_bet before it relays the bond
  const src = readFileSync(join(here, "../src/components/ResolutionModals.tsx"), "utf8");
  const modal = src.slice(src.indexOf("export function ChallengeModal"), src.indexOf("export function ConcedeModal"));
  assert.match(modal, /challengeGuard\(/);
  assert.ok(modal.indexOf("challengeGuard(") < modal.indexOf("relay("), "guard runs before the bond is relayed");
});

test("BetPage shows why a challenge is closed (not always 'window closed')", () => {
  const src = readFileSync(join(here, "../src/components/BetPage.tsx"), "utf8");
  assert.match(src, /offer\.kind === "closed"[^\n]*offer\.(message|reason)/);
});

// ---------------------------------------------------------------- LFIX1 step 3: SM1 P2 leftovers re-verified open on main (cheap fixes)
import { refereeScreen } from "../lib/refereeScreen";
import { myHome, extraReads } from "../lib/homeSections";
import { betDetail } from "../lib/betDetail";
const REF = { account: "ref.near", mode: "Human" };

test("LIFE-5: past resolve_deadline nobody is told the refund already happened, and bettors are not told to wait for the referee", () => {
  const b = bet({ envelope: { referee: REF } });
  const after = ms(T + 8 * DAY);
  const s: any = refereeScreen(b, "ref.near", after);
  assert.equal(s.state, "closed");
  assert.doesNotMatch(s.message, /were refunded/, "status is still Taken: no refund has been sent yet");
  assert.match(s.message, /stakes? back/);
  assert.notEqual(refereeScreen(b, "maker.near", after).kind, "wait", "bettor still told to wait for a ruling past the deadline");
  assert.equal(refereeScreen(b, "maker.near", ms(T + DAY)).kind, "wait", "before the deadline the wait line stays");
});

test("LIFE-6: a refund ending whose ledger line is unsent/failed says it is being sent, offers Retry, and lands in Needs you", () => {
  const voided = bet({ status: "Voided", outcome: "VOID" });
  const pending = [{ id: 9, bet_id: 1, token_id: USDC, receiver: "maker.near", amount: "10000000", reason: "void_deadline_maker", attempts: 1, done: false, in_flight: false }];
  const now = ms(T + 8 * DAY);
  const v = betView(voided, "maker.near", now, { pending });
  assert.doesNotMatch(v.sentence, /were refunded|got your stake back/, v.sentence);
  assert.equal(v.primary?.id, "retry-payout");
  assert.equal(extraReads(voided, "maker.near", now, "").pending, true, "My Bets must load the ledger for refund endings");
  const home = myHome([{ id: 1, bet: voided, pending }], "maker.near", now);
  assert.equal(home.groups.find((g) => g.id === "needs")?.cards.length ?? 0, 1, "unsent refund needs me");
  // all lines done: past tense, no action
  const done = betView(voided, "maker.near", now, { pending: [] });
  assert.match(done.sentence, /refunded/);
  assert.equal(done.primary, null);
  for (const [status, who] of [["Cancelled", "maker.near"], ["Expired", "maker.near"]] as const) {
    const x = bet({ status, taker: null, taken_at: null });
    const vv = betView(x, who, now, { pending: [{ ...pending[0], reason: "cancel_expire_refund" }] });
    assert.doesNotMatch(vv.sentence, /was refunded|were refunded/, `${status}: ${vv.sentence}`);
    assert.equal(vv.primary?.id, "retry-payout", status);
  }
});

test("LIFE-7 leftover: a referee ruling has no 'Challenge window ends' row (it was never challengeable)", () => {
  const ruledByRef = bet({ status: "Settled", outcome: "YES", proposed_at: T + H, envelope: { referee: REF } });
  assert.doesNotMatch(JSON.stringify(betDetail(ruledByRef)), /challenge_window_end/);
  assert.match(JSON.stringify(betDetail(ruled())), /challenge_window_end/, "AI rulings keep it");
});

test("LIFE-8: the reload placeholder quote never shows 'a bond of 0'", () => {
  const o: any = challengeOffer(ruled(), "taker.near", { amount: "0", asset: "" }, ms(P + 2 * H));
  assert.ok(!(o.kind === "available" && /bond of 0\b/.test(o.bondLine)), `bond line during reload: "${o.bondLine}"`);
  const src = readFileSync(join(here, "../src/components/BetPage.tsx"), "utf8");
  const eff = src.slice(src.indexOf("requiredChallengeBond(betId, myAccountId)") - 400, src.indexOf("requiredChallengeBond(betId, myAccountId)") + 300);
  assert.doesNotMatch(eff, /\}, \[bet, betId, myAccountId\]\)/, "bond quote re-fetched (and reset to loading) on every 15 s poll");
});

test("LIFE-11 rest: Concede is not offered to the side the standing ruling favours while its re-judge is pending", () => {
  const t = ms(P + 2 * H);
  // standing ruling YES = maker wins; the taker challenged
  assert.ok(!ids(betView(challenged(), "maker.near", t)).includes("concede"), "challenged: winner offered concede");
  assert.ok(ids(betView(challenged(), "taker.near", t)).includes("concede"), "the challenger may still give up");
  const stuck = challenged({ status: "Resolving", pending_run_no: 2, last_resolution_raw: JSON.stringify({ error: "no_live_judge_key" }) });
  assert.equal(betView(stuck, "maker.near", t).phase, "stuck");
  // stuck (CON-2): concede is the only per-bet exit, so both keep it (the notice says the side the ruling went against should use it)
  assert.ok(ids(betView(stuck, "taker.near", t)).includes("concede"), "stuck: the side the ruling went against is the runbook's way out");
  assert.ok(ids(betView(stuck, "maker.near", t)).includes("concede"), "stuck: the only exit stays available");
  // a re-judge in flight (judging, ruling standing): not to the winner
  const judging = challenged({ status: "Resolving", pending_run_no: 2 });
  assert.equal(betView(judging, "maker.near", t).phase, "judging");
  assert.ok(!ids(betView(judging, "maker.near", t)).includes("concede"), "judging the re-judge: winner offered concede");
  // VOID standing: either side may concede (runbook: agree it with both first)
  const sv = challenged({ outcome: "VOID" });
  assert.ok(ids(betView(sv, "maker.near", t)).includes("concede") && ids(betView(sv, "taker.near", t)).includes("concede"));
});
