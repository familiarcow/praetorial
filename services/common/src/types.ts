// Mirrors contracts/escrow/src/lib.rs structs (Envelope, Bet, SubmittedResult).
// Field names/types must stay byte-for-byte consistent with the Rust side —
// these are serialized into the exact JSON the contract deserializes.

export type Outcome = "YES" | "NO" | "VOID";

export interface Envelope {
  bet_id: number;
  version: number;
  maker: string;
  taker_allow: { Any: {} } | { Account: string } | { InvitePubkey: string };
  terms_hash: string;
  models_snapshot_hash: string;
  outcomes: string[]; // ["YES","NO"]
  maker_side: "YES" | "NO";
  // Asset each side stakes, as an intents multi-token id (e.g.
  // "nep141:usdc.testnet") -- mirrors Envelope.maker_asset/taker_asset in
  // contracts/escrow/src/lib.rs exactly. For same-asset bets these are
  // equal; a cross-asset bet has maker and taker staking different
  // assets, so any USD valuation of a side (e.g. notifier high-stake
  // routing) must use THIS side's own asset, never the other side's.
  maker_asset: string;
  taker_asset: string;
  stake_maker: string; // U128 as decimal string
  stake_taker: string;
  fee_bps: number;
  /** STG1 (D-STORAGE1): always "0" now; per-side charges live on the Bet (storage_maker / storage_taker). */
  storage_charge_per_side: string;
  keep_terms: boolean;
  // Full term-sheet text; must be present (non-empty) iff keep_terms is
  // true (contract's sanity_check, escrow/src/lib.rs). Missing this
  // field when keep_terms:true makes `open` fail validation and the
  // deposit gets refunded by the standard NEP-245 on_transfer path —
  // no panic, no error log, just silently no bet (bit us in e2e).
  terms?: string | null;
  max_paid_runs: number;
  tier: number;
  arbiter?: string | null; // legacy: removed from the contract Envelope (D-REF1); never sent (buildOpenMsg strips it)
  funding_deadline: number; // ns timestamp, as number (fits for testnet horizon)
  early_settle_outcome: string | null;
  finality_delay: number;
  settlement_period: number; // ns
  resolve_deadline: number; // ns
  consent_party_controlled: boolean;
  // RF2 / D-REFUI4: optional named human referee (single mode "Human"). A bet with a referee is never
  // AI-resolved: the referee rules via `referee_rule`, so no resolver run / request_resolution.
  referee?: { account: string; mode: "Human" } | null;
}

export type BetStatus =
  | "Open" | "Taken" | "Resolving" | "Proposed" | "Challenged" | "Evidence"
  // OQ-T11: outcome decided and the payout ledger persisted, but not
  // every line drained yet -- see drain_payouts in the escrow contract.
  | "Rejudge" | "Finalized" | "Settled" | "Voided" | "Cancelled" | "Expired";

// D-DISPUTE1 (item 7r, contracts/escrow/src/lib.rs::Exhibit): an exhibit
// hash plus the authoritative on-chain submission moment and submitter.
// `submitted_at` is a U64 ns timestamp, serialized as a JSON string (same
// decimal-string-not-float convention as SubmittedResult.checked_until
// below -- ns timestamps routinely exceed Number.MAX_SAFE_INTEGER).
export interface Exhibit {
  hash: string;
  submitted_at: string;
  submitted_by: string;
}

export interface Bet {
  envelope: Envelope;
  /** STG1: maker-side storage charge, in the maker asset (set at open). */
  storage_maker?: string;
  /** STG1: taker-side storage charge, in the taken asset (set at take; "0" while Open). */
  storage_taker?: string;
  status: BetStatus;
  taker: string | null;
  created_at: number;
  taken_at: number | null;
  proposed_at: number | null;
  outcome: Outcome | null;
  used_run_nos: number[];
  runs_used: number;
  bonds: unknown[];
  pre_challenge_outcome: string | null;
  challenged_by: string | null;
  exhibits: Exhibit[];
  rebuttals: string[];
  objection_deposits: unknown[];
  arbiter_submissions: [string, string, string][];
  amend_count: number;
  pending_resolution_request: number | null;
  last_resolution_raw: string | null;
  pruned: boolean;
  // v1.1 (FM-13 / I-7): only run_no == next_expected_run_no is ever
  // accepted by submit_outcome; all_results is the full audit history
  // of every accepted run across every round (bet.outcome only ever
  // reflects the latest one).
  next_expected_run_no: number;
  // D-RUNNO1: run_no of the in-flight resolution request (null/absent when none); submit_outcome requires exactly this run_no.
  pending_run_no?: number | null;
  all_results: { run_no: number; outcome: Outcome; element_results_hash: string; checked_until: string }[];
  // v1.1 (FM-17/19): set by extend_window, once per bet.
  window_extended: boolean;
  window_extension_ns: string;
  // D-RESOLVE1 / item 7d3: resolver-signed RETRY recovery-ladder state,
  // maintained exclusively by submit_outcome (never any party call).
  // Optional + U64-as-string (matching get_bet JSON) so every pre-existing
  // caller that never saw these fields keeps working unchanged.
  first_unavailable_ns?: string;
  retry_count?: number;
  next_check_ns?: string | null; // KEEPLIVE1: get_bet returns null when no RETRY was signed
  // JCB1 (D-JCB1): request_resolution is refused until this time after a RETRY:no_live_judge (null/absent = no gate).
  no_live_judge_until_ns?: string | null;
  // JC1s: which judge pair decided this bet (null/absent until an outcome is accepted).
  judge_pair_index?: number | null;
}

export interface SubmittedResult {
  bet_id: number;
  terms_hash: string;
  outcome: Outcome;
  element_results_hash: string;
  run_no: number;
  // Root-cause fix (submit_outcome signature rejections): this is a
  // U64 on the contract side (JSON string), not a bare number. A
  // nanosecond timestamp (Date.now() * 1_000_000) routinely exceeds
  // Number.MAX_SAFE_INTEGER (2^53-1); carrying it as a JS `number`
  // meant the exact double value BigInt()'d into the signed borsh
  // buffer could differ from the decimal digits JSON.stringify put on
  // the wire (and what the contract's serde_json parsed back out),
  // breaking ed25519_verify nondeterministically. A decimal string
  // carries the exact value end-to-end with no float round-trip.
  checked_until: string;
  // D-RESOLVE1 (item 7d) / DR-SVC-RETRY-1: the contract's submit_outcome
  // appends borsh(next_check_ns: u64) to the signed buffer ONLY when
  // outcome === "RETRY" (contracts/escrow/src/lib.rs). Optional + decimal
  // string (same U64-as-string convention as checked_until) so every
  // non-RETRY caller is unaffected; required (and validated) by
  // buildSubmitOutcomeMessage whenever outcome is "RETRY".
  next_check_ns?: string;
  // JC1s (D-JUDGECHAIN1): index in the contract's judge_chain of the pair that
  // decided; signed (u32 LE, right after checked_until). Absent signs as 0.
  judge_pair_index?: number;
  // JC1x (D-JUDGECHAIN1a #1): signed not-found (404/410) observations (observed_ns = decimal-string U64); empty/absent = none.
  model_not_found?: { model: string; observed_ns: string }[];
}

export interface PendingPayout {
  id: number;
  bet_id: number;
  token_id: string;
  receiver: string;
  amount: string;
  reason: string;
  attempts: number;
  done: boolean;
  // OQ-T11 (I-4): true while a transfer for this exact line is between
  // drain_payouts/retry_payout and its on_payout_result callback.
  in_flight: boolean;
}
