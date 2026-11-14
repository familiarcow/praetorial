// C1 (UIR1 §3.4 / §2.2 ReviewSummary, familiarcow UX-37 #5): the review of a bet before it is opened (create) or taken (take). Five lines
// (lib/reviewCard.ts summary) + a collapsed "Full terms"; blocking problems and warnings above them. People are @usernames; amounts and
// dates follow lib/money.ts / lib/dates.ts; no status word, hash or account id. The view model is lib/reviewCard.ts buildReviewModel.
import React from "react";
import { TermSheet } from "../../lib/termSheet";
import { RefereeChoice } from "../../lib/referee";
import { buildReviewModel, type ReviewStorage } from "../../lib/reviewCard";
import { useNames } from "../../lib/homeNames";
import { chainClock } from "../../lib/chainClock";
import { Disclosure, KeyValue, Notice, TimeLeft } from "../kit";

export interface TakerOptionUI {
  assetSymbol: string;
  amount: string | number;
  isSameAsset: boolean;
  pctFromMarket: number;
  quoteTime: string | null;
  notOffered?: boolean;
}

// The offer under review: rendered ONLY from these structured fields, never free prose. "Open" is blocked (lib/createFlow openButton)
// while flags.length > 0.
export interface StructuredOffer {
  /** FE9: whose point of view the card is written from. "taker" = the link holder; makerAmount/makerAssetSymbol then hold THEIR stake (the first side is always "you"). Default "maker". */
  side?: "maker" | "taker";
  /** FE9: the viewer's own fee/tip in human units when it comes from the bet's own min-fee copy (taker side). */
  viewerFee?: number;
  termSheet: TermSheet;
  /** CFIX1: a custom bet whose "Counts from" was never typed by hand: the source check re-stamps time.window_start to now. */
  restampWindowStart?: boolean;
  /** WT1: typed template sheet {template, fields} when a launch type is chosen; null for custom. */
  typedSheet?: Record<string, unknown> | null;
  claimText: string;
  sources: string[];
  /** TPL1: a price bet's own "who decides" line (lib/assetPriceSheet deciderLine); null/undefined = the generic AI-judge line. */
  deciderText?: string | null;
  deadlineLabel: string;
  /** C1: when the event ends (unix secs), for the review's relative "Ends in …" line; null/undefined = only the label is known. */
  eventAtSecs?: number | null;
  makerAssetSymbol: string;
  makerAmount: number;
  takerAssetSymbol: string;
  takerAmount: number;
  odds: number; // taker:maker payout ratio, e.g. 1 for 1:1
  settlementPeriodLabel: string;
  /** FE5: AI-mode dispute window in seconds, and the human-mode referee deadline in unix seconds (undefined = builder default). */
  settlementSecs?: number;
  resolveSecs?: number;
  takerOptions: TakerOptionUI[];
  referee: RefereeChoice;
  /** Registry username of the picked referee (shown with the account tail, UX-18). */
  refereeUsername?: string;
  /** RF2: the maker tips the referee. */
  tipMaker?: boolean;
  /** D-REFUI3b: when a person decides, the deadline they must rule by. */
  resolveByLabel?: string | null;
  /** FE5b: "This offer closes <date>." from the chosen expiry (same helper the envelope uses). */
  offerClosesLabel?: string | null;
  /** REVIEW1 (#2/#10): the chain time (ms) the shown deadlines were computed from, and the shown closing time (unix secs). The Open
   *  envelope derives its funding_deadline from reviewedAtMs, so the signed closing time is exactly offerClosesAtSecs. */
  reviewedAtMs?: number;
  offerClosesAtSecs?: number | null;
  /** C1: the chosen expiry was cut back to the event start (Full terms says so). */
  offerClosesClamped?: boolean;
  /** FE5b: the offer-expiry choice in seconds, passed to buildOpenEnvelope. */
  offerExpirySecs?: number;
  takerAccount: string | null;
  /** IN1: open to anyone holding a maker-signed invite link (taker_allow InvitePubkey). */
  inviteByLink?: boolean;
  flags: string[];
  priceWarning: string | null;
  /** Non-blocking notes for any custom (non-curated) venue named in the sources (D-VENUE1). */
  customVenueNotes: string[];
}

export { reviewHasSettlementLine } from "../../lib/reviewCard";

export default function ReviewCard({ offer, storage, storageUnavailable }: { offer: StructuredOffer; storage?: ReviewStorage | null; storageUnavailable?: boolean }) {
  // a named taker is shown by @username (lib/homeNames: the one lookup layer; "…" while it loads)
  const names = useNames(offer.takerAccount ? [offer.takerAccount] : []);
  const model = buildReviewModel(offer, storage, { nowMs: chainClock.nowMs() ?? Date.now(), names, storageUnavailable });
  const warnings = [...(offer.priceWarning ? [offer.priceWarning] : []), ...offer.customVenueNotes];
  return (
    <section data-testid="review-card" data-kit="ReviewSummary" data-variant={offer.side === "taker" ? "take" : "create"} className="k-card">
      {offer.flags.length > 0 && (
        <Notice tone="bad" data-testid="review-flags" title="Fix before opening:"
          body={<>{offer.flags.map((f, i) => <span key={i} data-testid={`review-flag-${i}`}>{f} </span>)}</>} />
      )}
      {warnings.length > 0 && (
        <Notice tone="warn" data-testid="review-warnings" title={warnings[0]} body={warnings.length > 1 ? warnings.slice(1).join(" ") : undefined} />
      )}
      <KeyValue data-testid="review-summary" rows={model.summary.map((r) => ({
        id: r.id,
        label: r.label,
        value: <span data-testid={`review-${r.id}`}>{r.at !== undefined && r.future ? <TimeLeft at={r.at} label={r.future} /> : r.text}</span>,
        emphasis: r.id === "claim",
      }))} />
      <Disclosure data-testid="review-full-terms" title="Full terms" summary="Sources, exact times, money, fees, refunds">
        <KeyValue variant="stacked" rows={model.terms.map((t) => ({ id: t.id, label: t.label, value: <span data-testid={`review-term-${t.id}`}>{t.value}</span> }))} />
      </Disclosure>
    </section>
  );
}
