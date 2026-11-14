// Test helper for KEEPSUBMIT1: a bet whose last_resolution_raw is a real-shape resolver output (bet 18 shape), signed with a test key.
import { signOutcome, type ResolverKeypair } from "@praetorial/common/resolverSign.js";
import type { Bet, Envelope, SubmittedResult } from "@praetorial/common/types.js";

export const NS = 1_000_000_000;
export const TERMS_HASH = "a".repeat(64);

export function makeRaw(o: { contract: string; betId: number; runNo: number; kp: ResolverKeypair; outcome?: string; termsHash?: string; checkedUntil?: string | number; signed?: boolean; contractField?: string }): string {
  const result: SubmittedResult = {
    bet_id: o.betId, terms_hash: o.termsHash ?? TERMS_HASH, outcome: (o.outcome ?? "NO") as any, element_results_hash: "b".repeat(64),
    run_no: o.runNo, checked_until: String(o.checkedUntil ?? 0), judge_pair_index: 0,
  };
  const sig = signOutcome(o.contract, result, o.kp.secretKey);
  // Real on-chain shape: checked_until is a JSON NUMBER in the stored raw (bet 18: "checked_until":0), alphabetical keys.
  const body = JSON.stringify({ bet_id: result.bet_id, checked_until: "@@CU@@", element_results_hash: result.element_results_hash, judge_pair_index: 0, outcome: result.outcome, run_no: result.run_no, terms_hash: result.terms_hash }).replace('"@@CU@@"', String(o.checkedUntil ?? 0));
  const out: any = { contract: o.contractField ?? o.contract, judge: { backend: "near-ai" }, notes: [], result: "@@R@@" };
  if (o.signed !== false) out.signing = { pubkey_hex: o.kp.publicKeyHex, signature_hex: sig };
  return JSON.stringify(out).replace('"@@R@@"', body);
}

export function makeBet(status: Bet["status"], raw: string | null, o: { betId?: number; pending?: number | null; used?: number[]; terms?: string } = {}): Bet {
  const envelope = {
    bet_id: o.betId ?? 1, version: 1, maker: "maker.testnet", taker_allow: { Any: {} }, terms_hash: o.terms ?? TERMS_HASH,
    maker_asset: "usdc.fakes.testnet", taker_asset: "usdc.fakes.testnet", models_snapshot_hash: "d", outcomes: ["YES", "NO"], maker_side: "YES",
    stake_maker: "100", stake_taker: "100", fee_bps: 100, storage_charge_per_side: "1", keep_terms: true, max_paid_runs: 3, tier: 1, arbiter: null,
    funding_deadline: 1, early_settle_outcome: null, finality_delay: 0, settlement_period: 48 * 3600 * NS, resolve_deadline: Date.now() * 1_000_000 + 1e18, consent_party_controlled: false,
  } as Envelope;
  return {
    envelope, status, taker: "taker.testnet", created_at: 0, taken_at: 0, proposed_at: null, outcome: null, used_run_nos: o.used ?? [], runs_used: 0, bonds: [],
    pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [], objection_deposits: [], arbiter_submissions: [], amend_count: 0,
    pending_resolution_request: status === "Resolving" ? 7 : null, pending_run_no: o.pending === undefined ? 1 : o.pending, last_resolution_raw: raw, pruned: false,
    next_expected_run_no: 1, all_results: [], window_extended: false, window_extension_ns: "0",
  } as unknown as Bet;
}
