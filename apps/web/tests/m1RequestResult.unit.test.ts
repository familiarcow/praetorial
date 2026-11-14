// M1 (SM2 gap M1-4): RequestResultSection and the request-result modal decided inline (which notice to show; did the request land).
// Both decisions live in lib/requestResult now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { requestResultMode, requestLanded } from "../lib/requestResult";

const T_MS = Date.UTC(2026, 10, 20, 12, 0, 0);
const ENV = { bet_id: 1, maker: "a.testnet", max_paid_runs: 3, funding_deadline: T_MS * 1e6, resolve_deadline: (T_MS + 7 * 86400_000) * 1e6, referee: null };
const B = (o: any = {}): any => ({
  status: "Taken", taker: "b.testnet", outcome: null, bonds: [], pending_resolution_request: null, runs_used: 0, no_live_judge_until_ns: null,
  ...o, envelope: { ...ENV, ...(o.envelope ?? {}) },
});

test("mode: before T+5 min nothing; after it 'request'; a human referee never", () => {
  assert.deepEqual(requestResultMode(B(), T_MS), { kind: "none" });
  assert.deepEqual(requestResultMode(B(), T_MS + 6 * 60_000), { kind: "request" });
  assert.deepEqual(requestResultMode(B({ envelope: { referee: { account: "r", mode: "Human" } } }), T_MS + 6 * 60_000), { kind: "none" });
});

test("mode: no live AI model -> 'wait' until the contract's time, but only while it is before the deadline and the AI decides", () => {
  const until = T_MS + 60 * 60_000;
  assert.deepEqual(requestResultMode(B({ no_live_judge_until_ns: until * 1e6 }), T_MS + 6 * 60_000), { kind: "wait", untilMs: until });
  const late = (T_MS + 8 * 86400_000);
  assert.deepEqual(requestResultMode(B({ no_live_judge_until_ns: late * 1e6 }), T_MS + 6 * 60_000).kind, "none");
  assert.deepEqual(requestResultMode(B({ no_live_judge_until_ns: until * 1e6, envelope: { referee: { account: "r", mode: "Human" } } }), T_MS + 6 * 60_000).kind, "none");
});

test("landed: a new run, a status change, or a fresh pending request proves it; a stale pending request on a challenged bet does not", () => {
  const before = B();
  assert.equal(requestLanded(before, null), false);
  assert.equal(requestLanded(before, B()), false);
  assert.equal(requestLanded(before, B({ status: "Resolving" })), true);
  assert.equal(requestLanded(before, B({ runs_used: 1 })), true);
  assert.equal(requestLanded(before, B({ pending_resolution_request: { requested_at: 1 } })), true);
  const challenged = B({ status: "Challenged", outcome: "YES", runs_used: 1, pending_resolution_request: { requested_at: 1 } });
  assert.equal(requestLanded(challenged, challenged), false);
  assert.equal(requestLanded(challenged, { ...challenged, runs_used: 2 }), true);
});
