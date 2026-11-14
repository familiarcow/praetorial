// LIFE1: suite version of the SM1 scratch spikes/sm1/tests/life_web.test.ts cases LIFE-1, LIFE-3 (+ LIFE-2b's finalize half) and
// LIFE-9, plus CON-2/CON-3 bet-page cases. Every expectation is the CONTRACT's behaviour (contracts/escrow/src/lib.rs).
import "./lib/assetStubs"; // M1: RequestResultSection -> ResolutionModals now draws the kit ConfirmSheet anatomy (kit imports .css)
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { showRequestResultNow } from "../lib/requestResult";
import { finalizeOffer } from "../lib/ruling";
import { statusChip } from "../lib/liveBet";
import { planJudgeRuling } from "../lib/judgeRuling";
import { lifecycleNotice, resolvingState, rejudgeDueMs, finalizeRefusal } from "../lib/betLifecycle";
import { requestResultTerms } from "../lib/resolutionFlows";
const { default: RequestResultSection } = await import("../src/components/RequestResultSection");

const H = 3_600_000_000_000; // 1h in ns
const DAY = 24 * H;
const T = 1_900_000_000_000 * 1e6; // funding_deadline (ns)
const USDC = "nep141:usdc.near";
const ms = (ns: number) => ns / 1e6;
const C = "bets.praetorial.near";
const BOND = { holder: "taker.near", amount: "1", round: 1, pre_challenge_outcome: "YES", asset: USDC };

function bet(o: any = {}): any {
  const { envelope, ...rest } = o;
  return {
    envelope: {
      bet_id: 1, maker: "maker.near", taker_allow: "Any", terms_hash: "ab".repeat(32), outcomes: ["YES", "NO"], maker_side: "YES",
      maker_asset: USDC, taker_asset: USDC, stake_maker: "10000000", stake_taker: "10000000", taker_options: [], fee_bps: 100,
      keep_terms: true, terms: null, max_paid_runs: 3, funding_deadline: T, resolve_deadline: T + 30 * DAY,
      settlement_period: DAY, referee: null, early_settle_outcome: null, ...(envelope ?? {}),
    },
    status: "Taken", taker: "taker.near", created_at: 0, taken_at: 1, proposed_at: null, outcome: null, bonds: [], exhibits: [],
    challenged_by: null, window_extension_ns: 0, pending_resolution_request: null, runs_used: 0, fee_min_maker: "0", fee_min_taker: "0",
    tip_maker: "0", tip_taker: "0", storage_maker: "0", storage_taker: "0", ...rest,
  };
}
// After a challenge the contract keeps the round-0 outcome and leaves pending_resolution_request set (rt1b.rs:746).
const challenged = (o: any = {}) => bet({ status: "Challenged", outcome: "YES", proposed_at: T + H, runs_used: 1, pending_resolution_request: 0, bonds: [BOND], challenged_by: "taker.near", ...o });

test("LIFE-1: a challenged ruling offers the re-judge request once the evidence window ends (the contract accepts it)", () => {
  const b = challenged();
  assert.equal(rejudgeDueMs(b), ms(T + H + DAY));
  assert.equal(showRequestResultNow(b, ms(T + 2 * H)), false, "evidence window still open");
  assert.equal(showRequestResultNow(b, ms(T + H + DAY)), true, "UI hides the only re-judge trigger on a Challenged bet");
  assert.equal(showRequestResultNow(challenged({ status: "Evidence" }), ms(T + H + DAY + H)), true);
  // the contract's own refusals still hide it
  assert.equal(showRequestResultNow(challenged({ runs_used: 3 }), ms(T + H + DAY)), false);
  assert.equal(showRequestResultNow(challenged(), ms(T + 30 * DAY)), false);
  assert.equal(showRequestResultNow(challenged({ no_live_judge_until_ns: T + 3 * DAY }), ms(T + 2 * DAY)), false);
});

test("LIFE-1 copy: the page says when the AI looks again, and the request button/modal says it is the re-judge", () => {
  const b = challenged();
  const chip = statusChip(b, "maker.near");
  assert.doesNotMatch(chip.sentence, /on its way/);
  assert.match(chip.sentence, /add evidence until .* UTC\. Then the AI looks at it again\./);
  const html = renderToStaticMarkup(React.createElement(RequestResultSection, { betId: 1, bet: b, nowMs: ms(T + H + DAY), wallet: null }));
  assert.match(html, /Ask for the new ruling now/);
  assert.match(html, /challenged ruling again/);
  assert.match(requestResultTerms(b).lines.join(" "), /look at the challenged ruling again/);
});

test("LIFE-3: Challenged, window elapsed, before resolve_deadline, runs left -> no Finalize button (contract refuses it)", () => {
  const b = challenged();
  const now = ms(T + H + DAY + H);
  assert.equal(finalizeOffer(b, now).show, false, "Finalize shown; contract panics 'challenge round pending a ruling'");
  assert.equal(finalizeRefusal(b, now), "challenge round pending a ruling");
  assert.equal(finalizeOffer(b, ms(T + 30 * DAY)).show, true, "after resolve_deadline finalize settles the standing ruling");
  assert.equal(finalizeOffer(challenged({ runs_used: 3 }), now).show, true, "runs exhausted: no ruling can come, finalize is open");
});

test("LIFE-2b/SVC-2: Finalize follows the contract window: full settlement_period with no bond, plus window_extension_ns", () => {
  const b = bet({ status: "Proposed", outcome: "NO", proposed_at: T + H, envelope: { settlement_period: 48 * H } });
  assert.equal(finalizeOffer(b, ms(T + H + 25 * H)).show, false);
  assert.equal(finalizeOffer(b, ms(T + H + 48 * H)).show, true);
  const ext = bet({ status: "Proposed", outcome: "NO", proposed_at: T + H, window_extension_ns: DAY });
  assert.equal(finalizeOffer(ext, ms(T + H + DAY + 1e3)).show, false);
  assert.equal(finalizeOffer(ext, ms(T + H + 2 * DAY)).show, true);
});

const NOKEY = JSON.stringify({ error: "no_live_judge_key", reason: "NEAR_AI_API_KEY missing" });

test("LIFE-9: Resolving with an unsigned error object -> the page explains it and what happens next (no endless 'working out')", () => {
  const b = bet({ status: "Resolving", pending_resolution_request: 4, pending_run_no: 1, last_resolution_raw: NOKEY });
  const now = ms(T + 2 * H);
  assert.equal(planJudgeRuling(C, 1, b).ok, false);
  assert.equal(resolvingState(C, 1, b, now).kind, "stuck");
  const n = lifecycleNotice(C, 1, b, now);
  assert.ok(n, "no explanation shown");
  assert.equal(n!.id, "stuck-no-ruling");
  assert.match(n!.lines.join(" "), /stakes back after .* UTC/);
  assert.match(n!.lines.join(" "), /concede/);
});

test("CON-2: a re-judge stuck in Resolving with the earlier ruling set says the money is locked and who can end it", () => {
  const b = challenged({ status: "Resolving", pending_run_no: 2, runs_used: 2, last_resolution_raw: NOKEY });
  const n = lifecycleNotice(C, 1, b, ms(T + 3 * DAY));
  assert.equal(n?.id, "stuck-ruling");
  assert.match(n!.lines.join(" "), /earlier ruling \(YES\) still stands/);
  assert.match(n!.lines.join(" "), /if taker\.near concedes, the earlier ruling is paid out as it stands and every challenge bond is returned/);
});

test("LIFE-9b: a stored signed RETRY whose next_check_ns has passed is stuck, not 'Apply the judge's ruling'", () => {
  const nowNs = T + 3 * DAY;
  const raw = (nc: number) => JSON.stringify({ contract: C, result: { bet_id: 1, terms_hash: "ab".repeat(32), outcome: "RETRY", element_results_hash: "e", run_no: 1, checked_until: "1", next_check_ns: String(nc) }, signing: { signature_hex: "ab".repeat(64) } });
  const late = bet({ status: "Resolving", pending_run_no: 1, used_run_nos: [], last_resolution_raw: raw(nowNs - H) });
  assert.equal(planJudgeRuling(C, 1, late).ok, true, "self-check: the signature/run checks pass");
  assert.deepEqual(resolvingState(C, 1, late, ms(nowNs)), { kind: "stuck", reason: "next_check_ns must be in the future", hasRuling: false });
  const ok = bet({ status: "Resolving", pending_run_no: 1, used_run_nos: [], last_resolution_raw: raw(nowNs + H) });
  assert.equal(resolvingState(C, 1, ok, ms(nowNs)).kind, "ready");
  assert.equal(lifecycleNotice(C, 1, ok, ms(nowNs)), null);
});

test("in-flight runs are not called stuck: nothing stored, an earlier failed run's marker, the previous round's result", () => {
  const now = ms(T + 2 * H);
  assert.equal(resolvingState(C, 1, bet({ status: "Resolving", pending_run_no: 1, last_resolution_raw: null }), now).kind, "judging");
  assert.equal(resolvingState(C, 1, bet({ status: "Resolving", pending_run_no: 2, last_resolution_raw: '{"error":"outlayer_call_failed"}' }), now).kind, "judging");
  const round0 = JSON.stringify({ contract: C, result: { bet_id: 1, terms_hash: "ab".repeat(32), outcome: "YES", element_results_hash: "e", run_no: 1, checked_until: "1" }, signing: { signature_hex: "ab".repeat(64) } });
  const b = challenged({ status: "Resolving", pending_run_no: 2, used_run_nos: [1], last_resolution_raw: round0 });
  assert.equal(resolvingState(C, 1, b, now).kind, "judging");
  assert.equal(lifecycleNotice(C, 1, b, now), null);
  assert.equal(statusChip(b, "maker.near").label, "Ruling in progress");
});

test("CON-3: an AI bet whose paid runs are all used says the refund comes after resolve_deadline", () => {
  const b = bet({ status: "Taken", runs_used: 3 });
  const n = lifecycleNotice(C, 1, b, ms(T + 2 * DAY));
  assert.equal(n?.id, "runs-exhausted");
  assert.equal(showRequestResultNow(b, ms(T + 2 * DAY)), false);
  assert.equal(lifecycleNotice(C, 1, bet({ status: "Taken", runs_used: 1 }), ms(T + 2 * DAY)), null);
});
