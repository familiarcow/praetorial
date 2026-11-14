// LH5(d) RED-first (D-HORIZON2): bet page "Request the result now" button after T+5min,
// calling request_resolution with the exact attach the contract wants
// (MIN_RESOLUTION_COMPUTE_DEPOSIT + input_data storage above 32 KiB; contracts/escrow/src/lib.rs).
import "./lib/assetStubs"; // M1: RequestResultSection -> ResolutionModals now draws the kit ConfirmSheet anatomy (kit imports .css)
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  noLiveJudgeWaitUntilMs, showRequestResultNow, requestResolutionDepositYocto, buildRequestResolutionArgs,
  MIN_RESOLUTION_COMPUTE_DEPOSIT_YOCTO, REQUEST_RESULT_DELAY_MS,
} from "../lib/requestResult";
import type { Bet } from "../lib/escrowAdapter";
const { default: RequestResultSection } = await import("../src/components/RequestResultSection");

const T_MS = Date.UTC(2026, 10, 20, 12, 0, 0);
const terms = JSON.stringify({ template: { id: "btc_close_at_t", version: 1 }, fields: { t_utc: new Date(T_MS).toISOString() } });
function makeBet(o: any = {}): Bet {
  return {
    envelope: { bet_id: 1, maker: "a.testnet", keep_terms: true, terms, max_paid_runs: 3, funding_deadline: T_MS * 1e6,
      resolve_deadline: (T_MS + 7 * 86400_000) * 1e6, referee: null, early_settle_outcome: null, ...o.envelope },
    status: "Taken", taker: "b.testnet", outcome: null, runs_used: 0, pending_resolution_request: null, ...o.bet,
  } as any;
}

test("constants: attach floor is 0.0200625 NEAR (= 1.25 x 0.01605, the 150 s tier cap)", () => {
  assert.equal(MIN_RESOLUTION_COMPUTE_DEPOSIT_YOCTO, 20_062_500_000_000_000_000_000n);
  assert.equal(REQUEST_RESULT_DELAY_MS, 5 * 60_000);
});

test("button is shown only from T+5min, while the bet has no outcome and a run is left", () => {
  assert.equal(showRequestResultNow(makeBet(), T_MS + 4 * 60_000), false);
  assert.equal(showRequestResultNow(makeBet(), T_MS + 5 * 60_000), true);
  assert.equal(showRequestResultNow(makeBet(), T_MS + 7 * 86400_000 + 1000), false); // past resolve_deadline
  assert.equal(showRequestResultNow(makeBet({ bet: { outcome: "YES" } }), T_MS + 3600_000), false);
  assert.equal(showRequestResultNow(makeBet({ bet: { pending_resolution_request: 3 } }), T_MS + 3600_000), false);
  assert.equal(showRequestResultNow(makeBet({ bet: { runs_used: 3 } }), T_MS + 3600_000), false);
  assert.equal(showRequestResultNow(makeBet({ bet: { status: "Open" } }), T_MS + 3600_000), false);
  assert.equal(showRequestResultNow(makeBet({ bet: { status: "Settled" } }), T_MS + 3600_000), false);
  assert.equal(showRequestResultNow(makeBet({ envelope: { referee: { account: "r.testnet", mode: "Human" } } }), T_MS + 3600_000), false);
});

test("attach: the compute floor for a small bet; storage added only above 32 KiB of input_data", () => {
  assert.equal(requestResolutionDepositYocto(makeBet()), MIN_RESOLUTION_COMPUTE_DEPOSIT_YOCTO);
  const big = makeBet({ envelope: { terms: "x".repeat(40_000) } });
  const dep = requestResolutionDepositYocto(big);
  assert.ok(dep > MIN_RESOLUTION_COMPUTE_DEPOSIT_YOCTO);
  const extraBytes = (dep - MIN_RESOLUTION_COMPUTE_DEPOSIT_YOCTO) / 10_000_000_000_000_000_000n;
  assert.ok(extraBytes >= 40_000n - 32_768n, "covers at least the terms bytes above the free 32 KiB");
});

test("args are exactly {bet_id}", () => {
  assert.deepEqual(buildRequestResolutionArgs(7), { bet_id: 7 });
});

test("section renders the button text after T+5min and nothing before", () => {
  const props = (nowMs: number) => ({ betId: 1, bet: makeBet(), nowMs, wallet: null });
  const html = renderToStaticMarkup(React.createElement(RequestResultSection, props(T_MS + 6 * 60_000)));
  assert.match(html, /Request the result now/);
  assert.match(html, /data-testid="request-result-btn"/);
  assert.match(html, /0\.0200625 NEAR/);
  assert.equal(renderToStaticMarkup(React.createElement(RequestResultSection, props(T_MS + 60_000))), "");
});

// JCB1 (D-JCB1): after RETRY:no_live_judge the contract refuses request_resolution until no_live_judge_until_ns.
const GATE_MS = T_MS + 12 * 3600_000;
const gated = () => makeBet({ bet: { no_live_judge_until_ns: String(GATE_MS * 1e6) } });

test("JCB1: button hidden while the no_live_judge gate is closed, shown from the gate time", () => {
  assert.equal(noLiveJudgeWaitUntilMs(gated(), T_MS + 3600_000), GATE_MS);
  assert.equal(showRequestResultNow(gated(), T_MS + 3600_000), false);
  assert.equal(showRequestResultNow(gated(), GATE_MS - 1), false);
  assert.equal(noLiveJudgeWaitUntilMs(gated(), GATE_MS), null);
  assert.equal(showRequestResultNow(gated(), GATE_MS), true);
  assert.equal(noLiveJudgeWaitUntilMs(makeBet(), T_MS + 3600_000), null);
  assert.equal(noLiveJudgeWaitUntilMs(makeBet({ bet: { no_live_judge_until_ns: null } }), T_MS + 3600_000), null);
});

test("JCB1: section shows the next check time instead of the button while gated", () => {
  const html = renderToStaticMarkup(React.createElement(RequestResultSection, { betId: 1, bet: gated(), nowMs: T_MS + 3600_000, wallet: null }));
  assert.match(html, /data-testid="request-result-next-check"/);
  // B1 (familiarcow UX-37 #6): relative on screen ("due in 9 days"), the exact time kept on the element (dateTime + local/UTC tooltip).
  assert.match(html, new RegExp(`dateTime="${new Date(GATE_MS).toISOString()}"`));
  assert.match(html, /due in \d+ (days|h)/);
  assert.doesNotMatch(html, /data-testid="request-result-btn"/);
  const open = renderToStaticMarkup(React.createElement(RequestResultSection, { betId: 1, bet: gated(), nowMs: GATE_MS + 1, wallet: null }));
  assert.match(open, /data-testid="request-result-btn"/);
});
