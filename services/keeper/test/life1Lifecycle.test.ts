// LIFE1: suite version of the SM1 scratch spikes/sm1/tests/svc_keeper.test.ts (SVC-1 = LIFE-1, SVC-1b, SVC-1c, SVC-2, SVC-2b)
// plus the refusal backoff and the late-RETRY relay gate. Every expectation is the CONTRACT's behaviour (contracts/escrow/src/lib.rs):
// contractFinalizeOk / contractRequestOk below are line-by-line mirrors of finalize (3912-3951) and can_request_resolution (2638-2667).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextActionForBet, finalizeRefusal, rejudgeDueNs } from "../src/policy.js";
import { classifyResolving } from "../src/resolvingState.js";
import { runKeeperTick, MemoryStateStore, BACKOFF_BASE_MS } from "../../workers/keeper/src/tick.js";

const NS = 1_000_000_000, H = 3600 * NS;
const ROUND_WINDOW_NS = 24 * H;
const BOND = { holder: "t.near", amount: "5", round: 1, pre_challenge_outcome: "YES", asset: "u" };

function mk(over: any = {}): any {
  const { envelope: envOver, ...rest } = over;
  return {
    envelope: {
      bet_id: 1, version: 1, maker: "m.near", taker_allow: { Any: {} }, terms_hash: "a".repeat(64), maker_asset: "u", taker_asset: "u",
      models_snapshot_hash: "d", outcomes: ["YES", "NO"], maker_side: "YES", stake_maker: "1", stake_taker: "1", fee_bps: 100,
      storage_charge_per_side: "0", keep_terms: true, max_paid_runs: 3, tier: 1, arbiter: null, referee: null,
      funding_deadline: 100 * NS, early_settle_outcome: null, finality_delay: 0, settlement_period: 24 * H,
      resolve_deadline: 100 * NS + 30 * 24 * H, consent_party_controlled: false, ...(envOver ?? {}),
    },
    status: "Proposed", taker: "t.near", created_at: 0, taken_at: 0, proposed_at: 1000 * NS, outcome: "YES", used_run_nos: [1], runs_used: 1,
    bonds: [], pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [], objection_deposits: [], arbiter_submissions: [],
    amend_count: 0, pending_resolution_request: null, pending_run_no: null, last_resolution_raw: null, pruned: false, next_expected_run_no: 2,
    all_results: [], window_extended: false, window_extension_ns: "0", next_check_ns: null, no_live_judge_until_ns: null,
    ...rest,
  };
}
// The contract leaves pending_resolution_request set after the round-0 verdict (rt1b.rs:746), so a challenged bet carries it.
const challenged = (over: any = {}) => mk({ status: "Challenged", bonds: [BOND], pre_challenge_outcome: "YES", challenged_by: "t.near", pending_resolution_request: 0, ...over });

function contractFinalizeOk(b: any, nowNs: number): boolean {
  if (!["Proposed", "Challenged", "Evidence"].includes(b.status)) return false;
  if (b.bonds.length && ["Challenged", "Evidence"].includes(b.status) && !(nowNs >= b.envelope.resolve_deadline || b.runs_used >= b.envelope.max_paid_runs)) return false;
  const base = b.bonds.length ? Math.min(b.envelope.settlement_period, ROUND_WINDOW_NS) : b.envelope.settlement_period;
  return nowNs >= b.proposed_at + base + Number(b.window_extension_ns);
}
function contractRequestOk(b: any, nowNs: number): boolean {
  return ["Taken", "Challenged", "Evidence"].includes(b.status) && (nowNs >= b.envelope.funding_deadline || b.envelope.early_settle_outcome != null)
    && b.runs_used < b.envelope.max_paid_runs && nowNs < b.envelope.resolve_deadline && !b.envelope.referee
    && !(b.no_live_judge_until_ns != null && nowNs < Number(b.no_live_judge_until_ns));
}

test("LIFE-1/SVC-1b: a challenged AI ruling gets request_resolution (the paid re-judge) once the evidence window ends", () => {
  const b = challenged();
  const windowEnd = b.proposed_at + 24 * H;
  // Both sides may still add evidence (submit_exhibits / objections) during the challenge window: not yet.
  assert.equal(nextActionForBet(b, 1, b.proposed_at + 1 * H), null);
  assert.equal(rejudgeDueNs(b), windowEnd);
  assert.deepEqual(nextActionForBet(b, 1, windowEnd), { kind: "request_resolution", bet_id: 1 });
  assert.ok(contractRequestOk(b, windowEnd), "the contract accepts it");
  // Evidence (exhibits filed) is a challenged round too.
  assert.deepEqual(nextActionForBet(challenged({ status: "Evidence" }), 1, windowEnd + H), { kind: "request_resolution", bet_id: 1 });
});

test("LIFE-1: the re-judge is never planned when the contract would refuse it, and never later than resolve_deadline - 1h", () => {
  const t = 1000 * NS + 25 * H;
  assert.equal(nextActionForBet(challenged({ runs_used: 3 }), 1, t)?.kind, "finalize", "runs exhausted: the contract finalizes instead");
  assert.equal(nextActionForBet(challenged({ envelope: { referee: { account: "r.near", mode: "Human" } } }), 1, t), null);
  assert.equal(nextActionForBet(challenged({ no_live_judge_until_ns: String(t + H) }), 1, t), null);
  assert.equal(nextActionForBet(challenged({ next_check_ns: String(t + H) }), 1, t), null, "a signed RETRY's next_check_ns is honoured");
  assert.deepEqual(nextActionForBet(challenged({ next_check_ns: String(t + H) }), 1, t + H), { kind: "request_resolution", bet_id: 1 });
  // resolve_deadline 2h after the ruling: ask 1h before it even though the 24h window is still open.
  const tight = challenged({ envelope: { resolve_deadline: 1000 * NS + 2 * H } });
  assert.deepEqual(nextActionForBet(tight, 1, 1000 * NS + 1 * H), { kind: "request_resolution", bet_id: 1 });
});

test("SVC-1c/LIFE-3: a challenged bet is never finalized while a ruling is still possible; it is after resolve_deadline", () => {
  const b = challenged();
  for (const h of [1, 23, 25, 24 * 10]) {
    const t = b.proposed_at + h * H;
    const a = nextActionForBet(b, 1, t);
    assert.notEqual(a?.kind, "finalize", `finalize planned at +${h}h`);
    assert.equal(finalizeRefusal(b, t), "challenge round pending a ruling");
  }
  const after = b.envelope.resolve_deadline;
  assert.ok(contractFinalizeOk(b, after));
  assert.deepEqual(nextActionForBet(b, 1, after), { kind: "finalize", bet_id: 1 });
});

test("SVC-2: extend_window (+24h) and the bonded 24h cap are mirrored exactly", () => {
  const ext = mk({ window_extended: true, window_extension_ns: String(24 * H) });
  const t = ext.proposed_at + ext.envelope.settlement_period + 1 * NS;
  assert.equal(nextActionForBet(ext, 1, t), null);
  assert.equal(contractFinalizeOk(ext, t), false);
  const t2 = ext.proposed_at + 48 * H;
  assert.deepEqual(nextActionForBet(ext, 1, t2), { kind: "finalize", bet_id: 1 });
  // 48h settlement_period, no bond: full window; after a re-judged bond round (Proposed again, bonds=1): min(sp, 24h).
  const long = mk({ envelope: { settlement_period: 48 * H } });
  assert.equal(nextActionForBet(long, 1, long.proposed_at + 25 * H), null);
  const rejudged = mk({ envelope: { settlement_period: 48 * H }, bonds: [BOND] });
  assert.deepEqual(nextActionForBet(rejudged, 1, rejudged.proposed_at + 24 * H), { kind: "finalize", bet_id: 1 });
  // Planner agrees with the contract on a grid of states and times.
  for (const b of [ext, long, rejudged, challenged(), challenged({ runs_used: 3 }), mk()]) {
    for (let h = 0; h <= 24 * 31; h += 7) {
      const now = b.proposed_at + h * H;
      if (nextActionForBet(b, 1, now)?.kind === "finalize") assert.ok(contractFinalizeOk(b, now), `finalize planned but refused (+${h}h)`);
      if (nextActionForBet(b, 1, now)?.kind === "request_resolution") assert.ok(contractRequestOk(b, now), `request planned but refused (+${h}h)`);
    }
  }
});

function chainClient(b: any, nowMs: () => number, counts: { finalize: number; refused: number; request: number }, refuseAll = false) {
  return {
    async view(_c: string, m: string, a: any) {
      if (m === "get_bet") return a.bet_id === 1 ? b : null;
      if (m === "is_shutdown") return false;
      if (m === "pending_payouts_view") return [];
      return null;
    },
    async call(_c: string, m: string) {
      if (m === "finalize") { counts.finalize++; if (refuseAll || !contractFinalizeOk(b, nowMs() * 1e6)) { counts.refused++; throw new Error("Smart contract panicked: settlement_period not elapsed"); } b.status = "Finalized"; }
      if (m === "request_resolution") { counts.request++; if (refuseAll || !contractRequestOk(b, nowMs() * 1e6)) { counts.refused++; throw new Error("Smart contract panicked: bet not awaiting resolution"); } b.status = "Resolving"; }
      return {};
    },
    async callPayable() { return {}; },
  };
}

test("SVC-2b: over the 24h extension the Worker keeper sends no refused finalize", async () => {
  const b = mk({ window_extended: true, window_extension_ns: String(24 * H) });
  let nowMs = (b.proposed_at + b.envelope.settlement_period) / 1e6 + 1000;
  const counts = { finalize: 0, refused: 0, request: 0 };
  const store = new MemoryStateStore();
  for (let minute = 0; minute < 24 * 60 + 5; minute++) {
    await runKeeperTick({ client: chainClient(b, () => nowMs, counts) as any, contracts: [{ id: "bets.praetorial.near", version: "v1" }], store, nowMs: () => nowMs, alerts: { async send() {} } });
    nowMs += 60_000;
  }
  assert.equal(counts.refused, 0, `keeper burned gas on ${counts.refused} refused txs`);
  assert.equal(counts.finalize, 1, "finalized once, right after the extended window");
});

test("SVC-1c: after a challenge the Worker keeper requests the re-judge once and sends no refused finalize", async () => {
  const b = challenged();
  let nowMs = (b.proposed_at + 23 * H) / 1e6;
  const counts = { finalize: 0, refused: 0, request: 0 };
  const store = new MemoryStateStore();
  for (let minute = 0; minute < 6 * 60; minute++) {
    await runKeeperTick({ client: chainClient(b, () => nowMs, counts) as any, contracts: [{ id: "x", version: "v1" }], store, nowMs: () => nowMs, alerts: { async send() {} } });
    nowMs += 60_000;
  }
  assert.equal(counts.refused, 0);
  assert.equal(counts.request, 1, "one re-judge request");
  assert.equal(b.status, "Resolving");
});

test("SVC-2 backoff: a refused action is retried with a persisted, growing backoff, not every minute", async () => {
  const b = mk();
  let nowMs = (b.proposed_at + b.envelope.settlement_period) / 1e6 + 1000;
  const counts = { finalize: 0, refused: 0, request: 0 };
  const store = new MemoryStateStore();
  for (let minute = 0; minute < 60; minute++) {
    // a fresh client each tick and the state only through the store: the backoff survives a Worker restart
    await runKeeperTick({ client: chainClient(b, () => nowMs, counts, true) as any, contracts: [{ id: "x", version: "v1" }], store, nowMs: () => nowMs, alerts: { async send() {} } });
    nowMs += 60_000;
  }
  // 5 min, then 10, 20, 40 ... : at most 4 sends in the first hour (was 60).
  assert.ok(counts.finalize <= 4, `sent ${counts.finalize} refused finalize txs in 1h`);
  assert.ok(counts.finalize >= 2, "still retried");
  const st = await store.load();
  const k = "x:finalize:1";
  assert.ok(st.backoff?.[k] && st.backoff[k].until > nowMs - 60_000 && st.backoff[k].n >= 2);
  assert.equal(BACKOFF_BASE_MS, 5 * 60_000);
});

test("CON-2 trigger 2: a stored signed RETRY past its next_check_ns is not relayed and is classified stuck", async () => {
  const sig = "ab".repeat(64);
  const nowNs = 1000 * NS + 30 * H;
  const raw = JSON.stringify({ contract: "x", result: { bet_id: 1, terms_hash: "a".repeat(64), outcome: "RETRY", element_results_hash: "e", run_no: 2, checked_until: "1", judge_pair_index: 0, next_check_ns: String(nowNs - H) }, signing: { signature_hex: sig } });
  const b = challenged({ status: "Resolving", pending_run_no: 2, last_resolution_raw: raw });
  assert.deepEqual(classifyResolving("x", 1, b, nowNs), { kind: "stuck", reason: "next_check_ns must be in the future", hasRuling: true });
  let submits = 0;
  const client = { async view(_c: string, m: string, a: any) { return m === "get_bet" ? (a.bet_id === 1 ? b : null) : m === "pending_payouts_view" ? [] : false; },
    async call(_c: string, m: string) { if (m === "submit_outcome") submits++; return {}; }, async callPayable() { return {}; } };
  await runKeeperTick({ client: client as any, contracts: [{ id: "x", version: "v1" }], store: new MemoryStateStore(), nowMs: () => nowNs / 1e6, alerts: { async send() {} } });
  assert.equal(submits, 0);
  // The same RETRY while still in the future is relayed.
  const fresh = JSON.parse(raw); fresh.result.next_check_ns = String(nowNs + H);
  b.last_resolution_raw = JSON.stringify(fresh);
  assert.equal(classifyResolving("x", 1, b, nowNs).kind, "ready");
  await runKeeperTick({ client: client as any, contracts: [{ id: "x", version: "v1" }], store: new MemoryStateStore(), nowMs: () => nowNs / 1e6, alerts: { async send() {} } });
  assert.equal(submits, 1);
});

test("LIFE-9/CON-2: classifyResolving tells an in-flight run from an unusable stored output", () => {
  const nowNs = 1000 * NS + 30 * H;
  const nokey = JSON.stringify({ error: "no_live_judge_key", reason: "NEAR_AI_API_KEY missing", judge: { judge_ran: false } });
  assert.deepEqual(classifyResolving("x", 1, mk({ status: "Resolving", outcome: null, pending_run_no: 1, last_resolution_raw: nokey }), nowNs),
    { kind: "stuck", reason: "unsigned resolver output (no_live_judge_key)", hasRuling: false });
  assert.equal(classifyResolving("x", 1, challenged({ status: "Resolving", pending_run_no: 2, last_resolution_raw: nokey }), nowNs).kind, "stuck");
  // In flight: nothing stored yet / an earlier failed run's marker / the previous round's signed result.
  assert.equal(classifyResolving("x", 1, mk({ status: "Resolving", outcome: null, pending_run_no: 1, last_resolution_raw: null }), nowNs).kind, "judging");
  assert.equal(classifyResolving("x", 1, mk({ status: "Resolving", outcome: null, pending_run_no: 2, last_resolution_raw: '{"error":"outlayer_call_failed"}' }), nowNs).kind, "judging");
  assert.equal(classifyResolving("x", 1, mk({ status: "Resolving", outcome: null, pending_run_no: 2, last_resolution_raw: "null" }), nowNs).kind, "judging");
  const round0 = JSON.stringify({ contract: "x", result: { bet_id: 1, terms_hash: "a".repeat(64), outcome: "YES", element_results_hash: "e", run_no: 1, checked_until: "1" }, signing: { signature_hex: "ab".repeat(64) } });
  assert.equal(classifyResolving("x", 1, challenged({ status: "Resolving", pending_run_no: 2, last_resolution_raw: round0 }), nowNs).kind, "judging");
  // A signed result for THIS run but missing its signature (signing_error) is stuck.
  const unsigned = JSON.stringify({ contract: "x", result: { bet_id: 1, terms_hash: "a".repeat(64), outcome: "NO", element_results_hash: "e", run_no: 2, checked_until: "1" }, signing_error: "no key" });
  assert.equal(classifyResolving("x", 1, challenged({ status: "Resolving", pending_run_no: 2, last_resolution_raw: unsigned }), nowNs).kind, "stuck");
  assert.equal(classifyResolving("x", 1, mk(), nowNs).kind, "not-resolving");
});
