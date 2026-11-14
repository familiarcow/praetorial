// WT1: the single place the web builds an Open envelope. No stub values; typed sheets are linted with the
// resolver's rules; hashes and deadlines are derived (D-RESOLVE1, D-HORIZON1a, D-FEEPIN1).
import { customOpenProblems } from "./customLint";
import { HUMAN_RESOLVE_SECS, TemplateRefusedError, assertTemplateOk, canonicalTerms, deriveDeadlines, templateId, termsHash } from "./templates";
import { fundingDeadlineSecs } from "./offerExpiry";
import { openUtcSkewProblems } from "./openRefresh";
import { loadReleaseConfig, type ReleaseConfig } from "./releaseConfig";

export const FEE_BPS = 100; // D-FEEPIN1: the contract refuses any other fee_bps

import { estimatedStorageBytes, storageForRate } from "./storageCharge";

/** STG1b: the envelope's storage_charge_per_side is "0"; the contract computes each side's charge from its asset rate.
 *  What the maker must deposit via mt_transfer_call: stake + the maker asset's own charge (any other amount is refunded). */
export function makerDeposit(env: Record<string, any>, makerRatePerKib: string | bigint): string {
  const bytes = estimatedStorageBytes(env.terms, env.terms_hash, env.models_snapshot_hash);
  return (BigInt(env.stake_maker) + storageForRate(bytes, makerRatePerKib)).toString();
}

export interface RefereeArg { account: string; mode: "Human" }

export interface BuildOpenArgs {
  maker: string;
  /** Typed template sheet ({template, fields}) or, for custom, a sheet plus `deadlineSecs` via customDeadlineSecs. */
  sheet: any;
  customDeadlineSecs?: number;
  makerAsset: string;
  takerAsset: string;
  stakeMaker: string;
  stakeTaker: string;
  takerAccount: string | null;
  referee: RefereeArg | null;
  /** RF2 / D-REFUI4: the maker tips the referee (their own stake funds it). Needs a referee. */
  tipMaker?: boolean;
  nowMs: number;
  /** REVIEW1 (#2/#10): the chain time the review card computed its deadlines from. The offer's closing time is derived from this, so
   *  the signed funding_deadline is exactly the one the user was shown. Default: nowMs. */
  deadlineNowMs?: number;
  /** FE5/S5: AI-mode settlement window in seconds (1h-24h); default 24h. */
  settlementSecs?: number;
  /** FE5/S5: human mode only: the date the referee must rule by (unix seconds); default event + 1 year. */
  resolveSecs?: number;
  /** FE5b/S5: the chosen offer expiry in seconds (1d/7d/30d); funding closes at min(event close, now + this). Default: today's rule. */
  offerExpirySecs?: number;
  release?: ReleaseConfig;
}

export function buildOpenEnvelope(a: BuildOpenArgs): Record<string, unknown> {
  const rel = a.release ?? loadReleaseConfig();
  // RF2: the contract has a single `Human` mode; the old Witness/Source/FinalSay are refused at open.
  if (a.referee && (a.referee as { mode: string }).mode !== "Human") throw new Error(`referee mode must be Human (got ${String((a.referee as { mode: string }).mode)})`);
  if (a.tipMaker && !a.referee) throw new Error("tip requires a referee");
  const human = !!a.referee;
  const settlementSecs = a.settlementSecs ?? 24 * 3600;
  if (settlementSecs < 3600 || settlementSecs > 24 * 3600) throw new Error("settlement window must be between 1 hour and 24 hours");
  const nowSecs = Math.floor((a.deadlineNowMs ?? a.nowMs) / 1000);
  const t = templateId(a.sheet);
  let funding: number;
  let resolve: number;
  if (t.id === "custom") {
    // A custom sheet has no typed time fields: the form supplies its deadline.
    const cp = customOpenProblems(a.sheet, { humanReferee: human });
    if (cp.length) throw new TemplateRefusedError(cp);
    if (a.customDeadlineSecs === undefined) throw new Error("custom sheet needs a deadline");
    const d = a.customDeadlineSecs;
    const resolveSecs = human && a.resolveSecs !== undefined ? a.resolveSecs : d + (human ? HUMAN_RESOLVE_SECS : 7 * 86400);
    if (resolveSecs <= d) throw new Error("OPEN_RESOLVE_NOT_AFTER_EVENT: the resolve deadline has to be after the event");
    if (resolveSecs - nowSecs > 1461 * 86400) throw new Error("OPEN_DEADLINE_TOO_FAR: deadline plus the resolve window is more than 4 years (1,461 days) after open (D-HORIZON1a)");
    funding = Number(BigInt(fundingDeadlineSecs({ latestSecs: d, nowSecs, expirySecs: a.offerExpirySecs }).secs) * 1_000_000_000n);
    resolve = Number(BigInt(resolveSecs) * 1_000_000_000n);
  } else {
    assertTemplateOk(a.sheet);
    const skew = openUtcSkewProblems(a.sheet, a.nowMs);
    if (skew.length) throw new TemplateRefusedError(skew);
    const d = deriveDeadlines(a.sheet, nowSecs, { humanReferee: human, resolveSecs: a.resolveSecs, expirySecs: a.offerExpirySecs });
    funding = Number(d.fundingDeadlineNs);
    resolve = Number(d.resolveDeadlineNs);
  }
  const terms = canonicalTerms(a.sheet);
  const th = termsHash(terms);
  return {
    bet_id: 0,
    version: 1,
    maker: a.maker,
    terms_hash: th,
    models_snapshot_hash: rel.models_snapshot_hash,
    outcomes: ["YES", "NO"],
    maker_side: "YES",
    maker_asset: a.makerAsset,
    taker_asset: a.takerAsset,
    stake_maker: a.stakeMaker,
    stake_taker: a.stakeTaker,
    taker_options: [],
    fee_bps: FEE_BPS,
    storage_charge_per_side: "0", // STG1b: refused if nonzero; the contract computes per-side charges
    keep_terms: true,
    terms,
    max_paid_runs: 3,
    tier: 1,
    referee: a.referee,
    tip_maker: !!a.tipMaker,
    funding_deadline: funding,
    early_settle_outcome: null,
    finality_delay: 0,
    settlement_period: settlementSecs * 1e9,
    resolve_deadline: resolve,
    consent_party_controlled: false,
  };
}
