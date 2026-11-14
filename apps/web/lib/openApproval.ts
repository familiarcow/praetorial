// REVIEW1 (#2 / #10, SM1 CRT-1, CRT-4, CRT-6): the source-check approval belongs to the exact offer it checked.
//  - offerKey(offer): a hash of every field of the reviewed offer that ends up in the signed Open (sheet, stakes, assets, referee,
//    tip, taker, invite, windows, expiry). An approval made for one key is useless for any other: editing the offer drops it.
//  - approvalGate(): the last check before signing. It refuses an approval for another key, and an approval whose sheet would have to
//    be re-stamped (BTC open_utc), so the sheet signed is always the sheet that was checked.
//  - signedMatchesReview(): compares the envelope about to be signed with the reviewed offer and approval, field by field.
//  - approvalTimeLeftMs(): age is measured from chain time (block header) and from the browser's monotonic clock since the request
//    was sent, never from the device's wall clock (a device clock that is behind made every approval look "from the future").
import { sha256 } from "js-sha256";
import type { StructuredOffer } from "../src/components/ReviewCard";
import type { OpenAttestation } from "./sourceCheckClient";
import { SOURCECHECK_FRESHNESS_NS } from "./sourceCheckClient";
import { customSheetFrom } from "./customSheet";
import { prepareSheetForOpen, type PreparedSheet } from "./openRefresh";
import { canonicalTerms, termsHash } from "./templates";
import { refereeAccount } from "./referee";
import { toBaseUnits } from "./assets";

/** Usable life is cut this much short of the contract's 1 h, for relay latency and a final block that runs a few seconds behind. */
export const APPROVAL_SAFETY_MS = 15_000;
/** At most this many automatic re-checks per reviewed offer (each one is a paid OutLayer run); after that the user presses a button. */
export const MAX_AUTO_RECHECKS = 1;

export function offerSheet(offer: StructuredOffer): any {
  return offer.typedSheet ?? customSheetFrom(offer.termSheet);
}

/** Stable JSON: object keys sorted, so the same offer always hashes the same. */
function stable(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

/** Hash of everything in the reviewed offer that is signed. Display-only labels are not part of it (they are derived from these). */
export function offerKey(offer: StructuredOffer): string {
  return sha256(stable({
    sheet: offerSheet(offer),
    deadlineUtcIso: offer.typedSheet ? null : offer.termSheet?.deadlineUtcIso ?? null,
    makerAsset: offer.makerAssetSymbol, makerAmount: String(offer.makerAmount),
    takerAsset: offer.takerAssetSymbol, takerAmount: String(offer.takerAmount),
    referee: refereeAccount(offer.referee), tipMaker: !!offer.tipMaker,
    takerAccount: offer.takerAccount ?? null, inviteByLink: !!offer.inviteByLink,
    settlementSecs: offer.settlementSecs ?? null, resolveSecs: offer.resolveSecs ?? null, offerExpirySecs: offer.offerExpirySecs ?? null,
  }));
}

export interface Approval {
  /** offerKey() of the offer this check was run for. */
  offerKey: string;
  /** The exact sheet sent to the source check (open_utc already stamped) and its terms hash. */
  sheet: any;
  termsHash: string;
  attestation: OpenAttestation;
  /** Monotonic ms when the check request was sent: checked_at is stamped after that, so age <= now - this. */
  requestedAtMono: number;
}

/** The approval, only if it was made for this exact offer. */
export function approvalFor(approval: Approval | null, offer: StructuredOffer | null): Approval | null {
  return approval && offer && approval.offerKey === offerKey(offer) ? approval : null;
}

/** Usable ms left on an approval. Age = the larger of (monotonic time since the request was sent) and (chain time - checked_at). */
export function approvalTimeLeftMs(a: Pick<Approval, "attestation" | "requestedAtMono">, now: { mono: number; chainMs: number | null }): number {
  const checkedMs = Number(BigInt(a.attestation.checked_at) / 1_000_000n);
  const byMono = Math.max(0, now.mono - a.requestedAtMono);
  const byChain = now.chainMs === null ? 0 : now.chainMs - checkedMs;
  const age = Math.max(byMono, byChain);
  const left = Number(SOURCECHECK_FRESHNESS_NS / 1_000_000n) - APPROVAL_SAFETY_MS - age;
  return left > 0 ? Math.floor(left) : 0;
}

export type GateResult =
  | { ok: true; prepared: PreparedSheet }
  | { ok: false; kind: "no-approval" | "edited" | "reconfirm"; message: string; prepared?: PreparedSheet };

export const EDITED_MESSAGE = "You changed the bet after it was checked, so it has to be checked again before it can open. Nothing was sent.";
export const RESTAMP_MESSAGE = "The bet's start time had to be refreshed, which changes its terms, so it needs a new check before it can open. Nothing was sent.";

/** Last check before building what is signed: the approval must be for this offer, and its sheet must still be usable as is. */
export function approvalGate(offer: StructuredOffer, approval: Approval | null, chainNowMs: number): GateResult {
  if (!approval) return { ok: false, kind: "no-approval", message: "Check the bet before opening it. Nothing was sent." };
  if (approval.offerKey !== offerKey(offer)) return { ok: false, kind: "edited", message: EDITED_MESSAGE };
  if (termsHash(canonicalTerms(approval.sheet)) !== approval.termsHash) return { ok: false, kind: "edited", message: EDITED_MESSAGE };
  const prepared = prepareSheetForOpen(approval.sheet, chainNowMs, approval.termsHash);
  if (prepared.requiresReconfirm) return { ok: false, kind: "reconfirm", message: RESTAMP_MESSAGE, prepared };
  return { ok: true, prepared };
}

/** The envelope about to be signed, compared with what the review showed. Returns the list of differences (empty = same). */
export function signedMatchesReview(envelope: Record<string, any>, offer: StructuredOffer, approval: Approval, makerAssetId: string, takerAssetId: string): string[] {
  const bad: string[] = [];
  if (envelope.terms_hash !== approval.termsHash) bad.push("terms");
  if (envelope.terms !== canonicalTerms(approval.sheet)) bad.push("terms text");
  if (envelope.maker_asset !== makerAssetId || envelope.taker_asset !== takerAssetId) bad.push("assets");
  if (envelope.stake_maker !== toBaseUnits(offer.makerAssetSymbol, offer.makerAmount)) bad.push("your stake");
  if (envelope.stake_taker !== toBaseUnits(offer.takerAssetSymbol, offer.takerAmount)) bad.push("their stake");
  if ((envelope.referee?.account ?? null) !== refereeAccount(offer.referee)) bad.push("referee");
  if (!!envelope.tip_maker !== !!offer.tipMaker) bad.push("tip");
  if (offer.settlementSecs !== undefined && !envelope.referee && envelope.settlement_period !== offer.settlementSecs * 1e9) bad.push("challenge window");
  if (offer.resolveSecs !== undefined && envelope.referee && envelope.resolve_deadline !== offer.resolveSecs * 1e9) bad.push("resolve deadline");
  if (offer.offerClosesAtSecs != null && envelope.funding_deadline !== offer.offerClosesAtSecs * 1e9) bad.push("offer closing time");
  return bad;
}

/** What to do when an approval runs out (or must be redone) while the review is open: one automatic re-check, then a button. */
export function recheckDecision(autoRechecksUsed: number): "auto" | "button" {
  return autoRechecksUsed < MAX_AUTO_RECHECKS ? "auto" : "button";
}
