// CS1 (testnet case studies, 2026-11-11): an nws_daily_high bet was asked for its result at the funding deadline (the START of
// the climate day), hours before the NWS climate report exists. The resolver correctly signs RETRY, and its D-RESOLVE1 ladder
// steps 24 h, so bet 52 (KNYC, 2026-11-11) cannot settle before 2026-11-12 19:48 UTC and one of its 3 paid runs is spent.
// The keeper must wait for the day end (resolve_deadline - 7 d) plus the report lag before the first request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextActionForBet } from "../src/policy.js";
import { requestNotBeforeNs, NWS_REPORT_LAG_NS } from "../src/liveness.js";
import type { Bet, Envelope } from "@praetorial/common/types.js";

const NS = 1_000_000_000, HOUR = 3600 * NS, DAY = 24 * HOUR;
// KNYC 2026-11-11: the climate day is 05:00Z 11-11 .. 05:00Z 11-12 (lib/templates eventTimes); funding closes at the day start.
const DAY_START_NS = Date.UTC(2026, 10, 11, 5) * 1_000_000;
const DAY_END_NS = DAY_START_NS + DAY;
const terms = (id: string, fields: any) => JSON.stringify({ template: { id, version: 1 }, fields });

function bet(t: string, fundingNs: number, resolveNs: number): Bet {
  return {
    envelope: { bet_id: 52, terms: t, funding_deadline: fundingNs, resolve_deadline: resolveNs, max_paid_runs: 3, early_settle_outcome: null, referee: null } as unknown as Envelope,
    status: "Taken", outcome: null, runs_used: 0, bonds: [], pending_resolution_request: null, next_check_ns: null, no_live_judge_until_ns: null,
  } as unknown as Bet;
}

const nws = bet(terms("nws_daily_high", { station: "KNYC", date: "2026-11-11", op: ">=", x_f: 63 }), DAY_START_NS, DAY_END_NS + 7 * DAY);

test("CS1: an NWS daily-high bet is NOT requested during the climate day (the report does not exist yet)", () => {
  assert.equal(nextActionForBet(nws, 52, DAY_START_NS + 15 * HOUR), null, "mid-day: a request only buys a 24 h RETRY");
  assert.equal(nextActionForBet(nws, 52, DAY_END_NS), null, "day end: the climate report is not out yet");
});

test("CS1: an NWS daily-high bet is requested once the day is over and the report lag has passed", () => {
  assert.ok(NWS_REPORT_LAG_NS >= HOUR && NWS_REPORT_LAG_NS <= 6 * HOUR);
  assert.equal(requestNotBeforeNs(nws), DAY_END_NS + NWS_REPORT_LAG_NS);
  assert.equal(nextActionForBet(nws, 52, DAY_END_NS + NWS_REPORT_LAG_NS)?.kind, "request_resolution");
});

test("CS1: unchanged: BTC close-at-T waits T+5 min; game_winner and custom sheets keep their funding-deadline request", () => {
  const T = DAY_START_NS;
  const btc = bet(terms("btc_close_at_t", { t_utc: "2026-11-11T05:00:00Z", op: ">=", x_usd: 1 }), T, T + 7 * DAY);
  assert.equal(requestNotBeforeNs(btc), T + 5 * 60 * NS);
  const game = bet(terms("game_winner", { league: "NHL", event_id: "1", scheduled_date: "2026-11-11", pick: { team_id: "3", name: "x" } }), T, T + 8 * DAY);
  assert.equal(requestNotBeforeNs(game), null);
  assert.equal(nextActionForBet(game, 51, T)?.kind, "request_resolution");
  const custom = bet(JSON.stringify({ claim: "x", elements: [] }), T, T + 7 * DAY);
  assert.equal(requestNotBeforeNs(custom), null);
});
