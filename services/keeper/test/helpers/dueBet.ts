// Test helper: a close-at-T Taken bet that is due for request_resolution.
import type { Bet, Envelope } from "@praetorial/common/types.js";

const NS = 1_000_000_000;
const MIN = 60 * NS;
const HOUR = 3600 * NS;
const DAY = 24 * HOUR;
const T_MS = Date.UTC(2026, 10, 20, 12, 0, 0);
const T_NS = T_MS * 1_000_000;
const CONTRACT = "escrow.testnet";

const closeAtTTerms = JSON.stringify({ template: { id: "btc_close_at_t", version: 1 }, fields: { t_utc: new Date(T_MS).toISOString(), op: ">", x_usd: "100000" } });
const DAY_END_NS = T_NS; // weather day end
const weatherTerms = JSON.stringify({ template: { id: "nws_daily_high", version: 1 }, fields: { station: "KNYC", date: "2026-11-19", op: ">", x_f: 50 } });

function envelope(o: Partial<Envelope> = {}): Envelope {
  return {
    bet_id: 1, version: 1, maker: "maker.testnet", taker_allow: { Any: {} }, terms_hash: "a".repeat(64),
    maker_asset: "usdc.fakes.testnet", taker_asset: "usdc.fakes.testnet", models_snapshot_hash: "d",
    outcomes: ["YES", "NO"], maker_side: "YES", stake_maker: "100", stake_taker: "100", fee_bps: 100,
    storage_charge_per_side: "1", keep_terms: true, terms: closeAtTTerms, max_paid_runs: 3, tier: 1, arbiter: null,
    funding_deadline: T_NS, early_settle_outcome: null, finality_delay: 0, settlement_period: 48 * HOUR,
    resolve_deadline: T_NS + 7 * DAY, consent_party_controlled: false, ...o,
  } as Envelope;
}
function bet(o: Partial<Omit<Bet, "envelope">> & { envelope?: Partial<Envelope> } = {}): Bet {
  const { envelope: e, ...rest } = o;
  return {
    envelope: envelope(e), status: "Taken", taker: "taker.testnet", created_at: 0, taken_at: 0, proposed_at: null,
    outcome: null, used_run_nos: [], runs_used: 0, bonds: [], pre_challenge_outcome: null, challenged_by: null,
    exhibits: [], rebuttals: [], objection_deposits: [], arbiter_submissions: [], amend_count: 0,
    pending_resolution_request: null, last_resolution_raw: null, pruned: false, next_expected_run_no: 1,
    all_results: [], window_extended: false, window_extension_ns: "0", ...rest,
  } as Bet;
}
export function dueBet(): Bet { return bet(); }
dueBet.nowMs = T_MS + 10 * 60_000;
