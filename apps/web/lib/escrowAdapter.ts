// Adapter over the CURRENT contracts/escrow/src interface (read read-only
// from contracts/escrow/src/lib.rs). The deployed testnet contract
// (ESCROW_CONTRACT_ID) predates cross-asset taker_options/asset_limits --
// a redeploy is queued. Everything in here is shaped to match the
// CURRENT source so it keeps working post-redeploy; functions that need
// chain features the deployed contract doesn't have yet are marked
// PENDING_REDEPLOY and never fake a result.
import { questionFromTerms } from "./templateClaim";
import { findAsset } from "./assets";
import { viewFunction } from "./rpc";
import { ESCROW_CONTRACT_ID, WNEAR_TOKEN_ID } from "./config";
import type { OpenAttestation } from "./sourceCheckClient";

export type TakerAllow =
  | { Any: Record<string, never> }
  | { Account: string }
  | { InvitePubkey: string };

export interface TakerOption {
  asset: string;
  amount: string; // U128 as decimal string
}

// RefereeMode / Referee: mirrors contracts/escrow/src/lib.rs's Referee
// struct (single `Human` mode since RF2; see lib/referee.ts for the client's
// own copy of these labels/validation).
export type RefereeMode = "Human";

export interface Referee {
  account: string;
  mode: RefereeMode;
}

// BondInfo: one challenge-round deposit (contracts/escrow/src/lib.rs's
// BondInfo). `bet.bonds.length` IS the number of challenge rounds
// opened so far -- round 1 = first entry, round 2 (the max, D-AUDIT8)
// = second entry.
export interface BondInfo {
  holder: string;
  amount: string;
  round: number;
  pre_challenge_outcome: string | null;
  asset: string;
}

// Exhibit: contracts/escrow/src/lib.rs's Exhibit struct, unchanged
// shape on get_bet's view (submitted_at is U64 -> JSON number/string).
export interface Exhibit {
  hash: string;
  submitted_at: string | number;
  submitted_by: string;
}

// ChallengeBondQuote: Contract::required_challenge_bond's return type.
// The asset is always the querying challenger's OWN stake asset (maker
// vs taker), so it travels with the amount instead of assuming USDC.
export interface ChallengeBondQuote {
  amount: string;
  asset: string;
}

// Max challenge/re-judge rounds reachable on any bet (D-AUDIT8): round
// 1 = "Review" (3-model-family panel), round 2 = "Final appeal" (5-family
// panel + debate prompt). This mirrors contracts/escrow/src/lib.rs's
// DEFAULT_MAX_ROUNDS; the UI has no view that exposes `Limits.max_rounds`
// directly, so it displays against this documented default and falls
// back to `required_challenge_bond` returning `null` as the real
// end-of-rounds signal (never guessed from this constant alone).
export const MAX_DISPUTE_ROUNDS = 2;

export interface Envelope {
  bet_id: number;
  version: number;
  maker: string;
  taker_allow: "Any" | TakerAllow;
  terms_hash: string;
  models_snapshot_hash: string;
  outcomes: string[];
  maker_side: string;
  maker_asset: string;
  taker_asset: string;
  stake_maker: string;
  stake_taker: string;
  taker_options: TakerOption[];
  fee_bps: number;
  reserve_per_side: string;
  /** STG1b: always "0" - the contract computes per-side charges from the asset rate (Bet.storage_maker / storage_taker). */
  storage_charge_per_side: string;
  keep_terms: boolean;
  terms: string | null;
  run_price: string;
  max_paid_runs: number;
  tier: number;
  arbiter: string | null;
  arbiter_fee: string;
  funding_deadline: number;
  early_settle_outcome: string | null;
  finality_delay: number;
  settlement_period: number;
  resolve_deadline: number;
  consent_party_controlled: boolean;
  referee: Referee | null;
  /** RF2 / D-REFUI4: the maker opts in to tipping the referee. */
  tip_maker?: boolean;
}

export interface Bet {
  envelope: Envelope;
  status: string;
  taker: string | null;
  created_at: number;
  taken_at: number | null;
  proposed_at: number | null;
  outcome: string | null;
  reserve_remaining: string;
  bonds: BondInfo[];
  exhibits: Exhibit[];
  challenged_by: string | null;
  window_extension_ns: number;
  /** The resolver result the contract stored on the last ruling (informational; the judges' cited quotes live in it). */
  last_resolution_raw?: string | null;
  /** D-RUNNO1: run_no of the in-flight resolution request (null/absent when none). */
  pending_run_no?: number | null;
  /** run_nos already accepted by submit_outcome. */
  used_run_nos?: number[];
  /** The bet's own copy of the taker-side min fee (PA1); the Take tip uses it. */
  fee_min_taker?: string;
  /** The bet's own copy of the maker-side min fee (PA1). */
  fee_min_maker?: string;
  /** RF2: the tip carved out of each side's stake (base units of that side's asset); "0" = none. */
  tip_maker?: string;
  tip_taker?: string;
  /** FM1 (D-FEEMIN2): min fee copy of each taker_options asset, index-aligned with envelope.taker_options. */
  fee_min_taker_options?: string[];
  /** RF2: each side's pending referee-change text (`{"account":..,"mode":"Human"}` or `"null"` for the AI); both equal = applied. */
  referee_proposal?: { maker_value: string | null; taker_value: string | null };
  /** STG1: the maker side charge (own asset), stored at open. */
  storage_maker?: string;
  /** STG1: the taker side charge (taken asset), stored at take. */
  storage_taker?: string;
}

export async function getBet(betId: number): Promise<Bet | null> {
  return viewFunction<Bet | null>(ESCROW_CONTRACT_ID, "get_bet", { bet_id: betId });
}

// open_offers (contracts/escrow/src/lib.rs) returns full Bet records
// already filtered to BetStatus::Open, NOT bare ids -- the escrowAdapter
// name is kept for back-compat with existing callers/tests.
export async function openOffers(from: number, limit: number): Promise<Bet[]> {
  return viewFunction<Bet[]>(ESCROW_CONTRACT_ID, "open_offers", { from, limit });
}

// Contract::required_challenge_bond -- `None` means either the bet is
// unknown, `challenger` is neither party, or the bet already sits at
// `limits.max_rounds` (no further challenge round possible).
export async function requiredChallengeBond(
  betId: number,
  challenger: string,
): Promise<ChallengeBondQuote | null> {
  return viewFunction<ChallengeBondQuote | null>(ESCROW_CONTRACT_ID, "required_challenge_bond", {
    bet_id: betId,
    challenger,
  });
}

export async function isPaused(): Promise<boolean> {
  return viewFunction<boolean>(ESCROW_CONTRACT_ID, "is_paused", {});
}

// D-SUNSET3: true iff `emergency_shutdown` has run (permanent, matches
// contracts/escrow/src/lib.rs's `is_shutdown` view exactly).
export async function isShutdown(): Promise<boolean> {
  return viewFunction<boolean>(ESCROW_CONTRACT_ID, "is_shutdown", {});
}

// -------------------------------------------------------------------
// emergency_refund(bet_id) is a REAL, permissionless direct escrow
// method (contracts/escrow/src/lib.rs ~4003): callable by anyone once
// emergency_shutdown has run, it returns each party exactly their own
// deposits (maker/taker stake, bonds, objection deposits). Like
// cancel it moves no new stake, so it travels the same
// relayer ESCROW_DIRECT_METHODS path, not a mt_transfer_call envelope.
export function buildEmergencyRefundArgs(betId: number): Record<string, unknown> {
  return { bet_id: betId };
}

// C1 / D-CONCEDE1: concede(bet_id) -- either bettor gives up their own
// side after the bet is Taken and before it is Finalized/Settled; the
// counterparty gets the pot minus the normal fee. Direct escrow method
// (no deposit), relayed gaslessly like cancel/emergency_refund.
export function buildConcedeArgs(betId: number): Record<string, unknown> {
  return { bet_id: betId };
}

// D-PM3 scope: allowed in Taken/Resolving/Proposed/Challenged/Evidence/
// Rejudge, only for the maker or taker, never once the contract is shut
// down (emergency refund governs).
const CONCEDABLE_STATUSES = new Set(["Taken", "Resolving", "Proposed", "Challenged", "Evidence", "Rejudge"]);
export function canConcede(
  bet: { status: string; taker: string | null; envelope: { maker: string } },
  myAccountId: string | null,
  contractShutDown: boolean,
): boolean {
  if (contractShutDown || !myAccountId) return false;
  if (!CONCEDABLE_STATUSES.has(bet.status)) return false;
  return bet.envelope.maker === myAccountId || bet.taker === myAccountId;
}

// Fee: 1% of pot per asset (D-ECON per spec). Applied to maker+taker stake.
export const FEE_BPS = 100;

export function feeOnPot(stakeMakerUsd: number, stakeTakerUsd: number): number {
  return ((stakeMakerUsd + stakeTakerUsd) * FEE_BPS) / 10_000;
}

/**
 * D-FEEMIN1/D-FEEPIN1: one side's fee in native units =
 * min(stake, max(stake * 100 / 10000, minFeePerSide)); mirrors the
 * contract's `side_fee`. `minFeePerSide` is THAT side's asset minimum.
 */
export function feeForSideUnits(stakeUnits: bigint, minFeePerSideUnits: bigint): bigint {
  const pct = (stakeUnits * BigInt(FEE_BPS)) / 10_000n;
  const fee = pct > minFeePerSideUnits ? pct : minFeePerSideUnits;
  return fee < stakeUnits ? fee : stakeUnits;
}

/** Human-unit (e.g. 10 = 10 USDC) variant for the review card; reads the asset's own minimum. */
export function feeForSideHuman(stake: number, symbol: string): number {
  const a = findAsset(symbol);
  const minHuman = a?.minFeePerSide ? Number(a.minFeePerSide) / 10 ** a.decimals : 0;
  const pct = (stake * FEE_BPS) / 10_000;
  return Math.min(stake, Math.max(pct, minHuman));
}

// D-PRICE3: 10:1 max odds enforced client-side to match handle_open's
// on-chain same-asset check (envelope.stake_maker/stake_taker ratio).
export const MAX_SAME_ASSET_ODDS = 10;

export { WNEAR_TOKEN_ID };

// -------------------------------------------------------------------
// Open an offer == a NEP-141 ft_transfer_call from the maker's wallet
// into intents, msg = {"kind":"Open","envelope":{...}}, landing on
// Contract::mt_on_transfer. That requires the deployed escrow's
// configured `intents` account to actually route the transfer, and the
// maker to hold maker_asset inside intents already. Wiring that through
// Privy's raw-sign flow for an arbitrary whitelisted asset is the
// cross-asset work queued for redeploy; v0 here builds the envelope and
// documents the call shape, but does not claim a chain tx happened
// unless openOfferTx below actually returns one.
//
// v0.2 queue item 1: direct challenges. A maker who names a specific
// taker account (the "direct challenge" flow) must have that locked
// into the envelope as TakerAllow::Account(taker) -- otherwise anyone
// could take an offer the maker meant for one named counterparty. An
// offer with no named taker stays public (TakerAllow::Any), unchanged.
export function makeTakerAllow(takerAccount: string | null | undefined | { invitePubkey: string }): Envelope["taker_allow"] {
  // IN1: invite-by-link -> TakerAllow::InvitePubkey(<32-byte ed25519 pubkey as 64 hex chars>), the contract's verify_sig hex encoding.
  if (takerAccount && typeof takerAccount === "object") {
    if (!/^[0-9a-fA-F]{64}$/.test(takerAccount.invitePubkey)) throw new Error("makeTakerAllow: invite pubkey must be 64 hex chars");
    return { InvitePubkey: takerAccount.invitePubkey.toLowerCase() };
  }
  const trimmed = takerAccount?.trim();
  return trimmed ? { Account: trimmed } : "Any";
}

// D-FETCH2 (queue item 7f2b): `TransferMsg::Open` on the CURRENT contract
// (contracts/escrow/src/lib.rs ~227-240/~855-900) requires a resolver-
// signed source-check attestation alongside the envelope --
// `{"kind":"Open","envelope":{...},"attestation":{"checked_at","signature_hex"}}`.
// `attestation` is REQUIRED (not optional) so a caller can never build an
// Open msg that silently omits it; obtain one via
// `lib/sourceCheckClient.ts::requestSourceCheck` first.
export const MAX_HORIZON_NS = 1_461n * 86_400n * 1_000_000_000n; // D-HORIZON1a
export function buildOpenMsg(
  envelope: Omit<Envelope, "taker_allow">,
  attestation: OpenAttestation,
  takerAccount?: string | null | { invitePubkey: string },
  nowNs: number = Date.now() * 1e6,
): string {
  // D-HORIZON1a: mirrors the contract's open-time rule (<= 1,461 days).
  if (
    Number.isFinite(envelope.resolve_deadline) &&
    BigInt(Math.trunc(envelope.resolve_deadline)) > BigInt(Math.trunc(nowNs)) + MAX_HORIZON_NS
  ) {
    throw new Error("Bets can last at most 4 years (D-HORIZON1a)");
  }
  const taker_allow = makeTakerAllow(takerAccount);
  // SourceCheckAttestation.checked_at is a u64 on the contract = a JSON NUMBER (a string fails serde and the whole
  // deposit is refunded silently). Splice the digits in verbatim: a JS number would round a 19-digit ns timestamp.
  const checkedAt = String(attestation.checked_at);
  if (!/^\d+$/.test(checkedAt)) throw new Error("buildOpenMsg: attestation checked_at must be a u64 integer");
  if (!/^[0-9a-f]{128}$/i.test(String(attestation.signature_hex))) throw new Error("buildOpenMsg: attestation signature_hex must be 128 hex chars");
  return (
    `{"kind":"Open","envelope":${JSON.stringify({ ...envelope, taker_allow })},` +
    `"attestation":{"checked_at":${checkedAt},"signature_hex":${JSON.stringify(attestation.signature_hex)}}}`
  );
}

/** RF2: `tip` = the taker opts in to tipping; `referee_ack` = the referee the taker agrees to (required on a referee bet, else the contract refuses the take). */
export function buildTakeMsg(betId: number, inviteSig: string | null, opts: { tip?: boolean; refereeAck?: string | null } = {}): string {
  const tip = !!opts.tip;
  const referee_ack = opts.refereeAck ?? null;
  if (tip && !referee_ack) throw new Error("buildTakeMsg: tip requires a referee (name the referee in referee_ack)");
  return JSON.stringify({ kind: "Take", bet_id: betId, invite_sig: inviteSig, tip, referee_ack });
}

// -------------------------------------------------------------------
// Challenge == a bond deposit. Per contracts/escrow/src/lib.rs's
// commit_two_party/bond machinery and services/e2e/g4_lifecycle_matrix.ts's
// sendBond helper, a challenge bond travels the same mt_transfer_call
// route as Open/Take (NOT a direct escrow method) -- msg kind "Bond",
// {bet_id, round}. `round` is the challenge round being opened (1-based;
// round 0 is the automatic initial ruling, never bonded).
export function buildChallengeMsg(betId: number, round: number): string {
  return JSON.stringify({ kind: "Bond", bet_id: betId, round });
}

// -------------------------------------------------------------------
// cancel(bet_id) is a REAL direct method on escrow itself
// (contracts/escrow/src/lib.rs, confirmed `pub fn cancel`), unlike open/take/
// challenge -- they move no new stake, so they don't travel through
// intents' mt_transfer_call. These build the escrow FunctionCall args
// directly (no `msg` envelope); the relayer calls them via
// ESCROW_DIRECT_METHODS (services/relayer/src/policy.ts).
export function buildCancelArgs(betId: number): Record<string, unknown> {
  return { bet_id: betId };
}

// -------------------------------------------------------------------
// submit_exhibits(bet_id, hashes) is a REAL direct escrow method (same
// family as cancel above) -- it moves no stake, so it
// travels straight through the relayer's ESCROW_DIRECT_METHODS path,
// NOT a mt_transfer_call envelope like Open/Take/Bond. Contract-side
// guards (contracts/escrow/src/lib.rs::submit_exhibits): caller must be
// a party or the named referee, bet.status must be Challenged or
// Evidence, max 5 exhibits per submitter, and the record is frozen
// after round 1 (bet.bonds.len() > 1 rejects with "record frozen...").
export function buildSubmitExhibitsArgs(betId: number, hashes: string[]): Record<string, unknown> {
  if (hashes.length === 0) {
    throw new Error("submit_exhibits requires at least one hash");
  }
  return { bet_id: betId, hashes };
}

// -------------------------------------------------------------------
// Dispute round bookkeeping, mirroring contracts/escrow/src/lib.rs
// exactly (no guessed constants beyond the documented MAX_DISPUTE_ROUNDS
// default -- see its own doc comment above): `bet.bonds.length` IS the
// count of challenge rounds opened so far. 0 = no dispute yet; 1 =
// round 1 ("Review", 3-model-family panel) is open/decided; 2 = round 2
// ("Final appeal", 5-family panel) is open/decided, the max.
export function currentDisputeRound(bet: Bet): number {
  return bet.bonds.length;
}

export function isFinalDisputeRound(bet: Bet, maxRounds: number = MAX_DISPUTE_ROUNDS): boolean {
  return bet.bonds.length >= maxRounds;
}

export function roundLabel(round: number): string {
  if (round <= 0) return "No dispute yet";
  if (round === 1) return "Round 1: Review (3-model panel)";
  if (round >= MAX_DISPUTE_ROUNDS) return "Round 2: Final appeal (5-model panel)";
  return `Round ${round}`;
}

// -------------------------------------------------------------------
// D1/D-REF1 appeal (settlement) window: the deadline at which `finalize`
// is allowed to run against the currently standing outcome, per
// contracts/escrow/src/lib.rs's `finalize` (lines ~2933-2950):
//   deadline = proposed_at + min(settlement_period, ROUND_WINDOW_NS) + window_extension_ns
// `ROUND_WINDOW_NS` = 24h, matching the contract's constant exactly.
// Returns null when there's no open window to count down (no proposal
// yet, i.e. `proposed_at` is unset).
export const ROUND_WINDOW_NS = 24 * 60 * 60 * 1_000_000_000;

export function appealDeadlineNs(bet: Bet): number | null {
  if (bet.proposed_at == null) return null;
  const baseWindow = Math.min(bet.envelope.settlement_period, ROUND_WINDOW_NS);
  return bet.proposed_at + baseWindow + (bet.window_extension_ns ?? 0);
}

// Milliseconds remaining until the appeal window closes (negative once
// elapsed), from a chain-timestamp-in-nanoseconds deadline. `nowMs`
// is injectable for deterministic tests; defaults to wall clock.
export function appealWindowRemainingMs(bet: Bet, nowMs: number = Date.now()): number | null {
  const deadlineNs = appealDeadlineNs(bet);
  if (deadlineNs == null) return null;
  return Math.floor(deadlineNs / 1_000_000) - nowMs;
}

// -------------------------------------------------------------------
// Browse-page term-sheet summary: on chain only `terms_hash` (always)
// and optionally the full `terms` JSON string (only when `keep_terms`
// was set, see Envelope's own doc in contracts/escrow/src/lib.rs) ever
// exist. CS1: the question comes from what the web really writes (a typed template's fields, a custom `claim`, or the
// legacy `claimText`; lib/templateClaim.ts). It used to read `claimText` only, so every current bet was unreadable and
// Explore / In progress showed nothing. Anything else is unreadable (never a hash).
export function termsClaimText(envelope: Pick<Envelope, "terms"> & { terms_hash?: string }): string | null {
  if (!envelope.terms) return null;
  try {
    return questionFromTerms(JSON.parse(envelope.terms));
  } catch {
    return null; // not JSON
  }
}

// BROWSE1b (UX-27): a terms hash is never shown to a person as the question. Browse hides such rows (termsClaimText);
// screens that must still show the bet (My bets, Take) use the same fixed "Terms not available".
export const TERMS_NOT_AVAILABLE = "Terms not available";
export function termSheetSummary(envelope: Pick<Envelope, "terms" | "terms_hash">): string {
  return termsClaimText(envelope) ?? TERMS_NOT_AVAILABLE;
}

// D-KEY1: [outcome_pubkey, attest_pubkey, resolver_wasm_hash] pinned in the escrow contract.
export async function resolverKeys(): Promise<string[]> {
  return viewFunction<string[]>(ESCROW_CONTRACT_ID, "resolver_keys", {});
}
