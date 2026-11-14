// BET1c (UX-33 section 5): "More options" on the make-a-bet form. Pure helpers shared by BetOptions and CreateOffer.
import { OFFER_EXPIRY_OPTIONS } from "./offerExpiry";
import { SETTLEMENT_OPTIONS } from "./stakeDeadlines";

/** UX-33: the challenge window is fixed at 24h (no selector). Still one of the contract-valid SETTLEMENT_OPTIONS. */
export const FIXED_SETTLEMENT_PERIOD = "24h";
export const FIXED_SETTLEMENT_SECS = SETTLEMENT_OPTIONS.find((o) => o.id === FIXED_SETTLEMENT_PERIOD)!.secs;

const LABELS: Record<string, string> = { "1d": "1 day", "7d": "7 days", "30d": "30 days" };
/** "Offer closes in" choices: same ids/secs as OFFER_EXPIRY_OPTIONS, plain-English labels. Default 7 days. */
export const EXPIRY_CHOICES = OFFER_EXPIRY_OPTIONS.map((o) => ({ ...o, label: LABELS[o.id] ?? o.id }));
export const DEFAULT_EXPIRY = "7d";
export const expiryLabel = (id: string): string => LABELS[id] ?? LABELS[DEFAULT_EXPIRY];

/** The one-line summary on the collapsed row, e.g. "Closes in 7 days · anyone can take · 24h to challenge". */
export function moreOptionsSummary(o: { offerExpiry: string; takerAccount: string; inviteByLink: boolean; human: boolean; resolveByDate: string | null }): string {
  const taker = o.takerAccount.trim();
  const who = taker ? `only ${taker} can take` : o.inviteByLink ? "invite-only link" : "anyone can take";
  const last = o.human ? (o.resolveByDate ? `referee rules by ${o.resolveByDate}` : null) : `${FIXED_SETTLEMENT_PERIOD} to challenge`;
  return [`Closes in ${expiryLabel(o.offerExpiry)}`, who, last].filter(Boolean).join(" · ");
}
