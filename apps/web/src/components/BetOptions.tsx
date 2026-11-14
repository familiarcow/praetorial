import React, { useState } from "react";
import { Banner, TextField, CheckField } from "../ui";
import { exampleAccount } from "../../lib/network";
import { EXPIRY_CHOICES, FIXED_SETTLEMENT_PERIOD, moreOptionsSummary } from "../../lib/betOptions";

// BET1c (UX-33 section 5): "More options", one collapsed row with a live summary. Inside: offer closes in (1/7/30 days),
// only this person can take it, invite-only link, and (person decides) the referee deadline. The challenge window is
// fixed at 24h (no selector). All values and checks are CreateOffer's; this only lays them out.
const small: React.CSSProperties = { fontSize: "0.85em", color: "var(--color-text-secondary)", margin: "4px 0" };

export default function BetOptions({
  human, offerExpiry, setOfferExpiry, takerAccount, setTakerAccount, takerErr, inviteByLink, setInviteByLink,
  resolveValue, setResolveDate, resolveErr, expiryErr,
}: {
  human: boolean;
  offerExpiry: string;
  setOfferExpiry: (v: string) => void;
  takerAccount: string;
  setTakerAccount: (v: string) => void;
  takerErr: string | null;
  inviteByLink: boolean;
  setInviteByLink: (b: boolean) => void;
  /** Referee deadline date shown in the field (chosen date, else the default); "" when there is no default yet. */
  resolveValue: string;
  setResolveDate: (d: string | null) => void;
  resolveErr: string | null;
  expiryErr: string | null;
}) {
  const [userOpen, setUserOpen] = useState(false);
  // A problem inside never hides behind the collapsed row.
  const hasProblem = !!(takerErr || (human && (resolveErr || expiryErr)));
  const open = userOpen || hasProblem;
  const summary = moreOptionsSummary({ offerExpiry, takerAccount, inviteByLink: inviteByLink && !takerAccount, human, resolveByDate: human && resolveValue ? resolveValue : null });

  return (
    <div data-testid="more-options" style={{ margin: "16px 0", maxWidth: 560, border: "1px solid var(--color-border)", borderRadius: "var(--radius-container, 12px)", background: "var(--color-background-card, #fff)" }}>
      <button
        type="button"
        data-testid="more-options-toggle"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
        style={{ display: "flex", width: "100%", alignItems: "center", gap: 8, margin: 0, padding: "12px 14px", minHeight: 48, background: "none", border: 0, font: "inherit", textAlign: "left", cursor: "pointer", color: "var(--color-text-primary)" }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ display: "block" }}>More options</strong>
          <span data-testid="more-options-summary" style={{ display: "block", fontSize: "0.85em", color: "var(--color-text-secondary)" }}>{summary}</span>
        </span>
        <span aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms", fontSize: "1.2em" }}>{"›"}</span>
      </button>
      {open && (
        <div data-testid="more-options-body" style={{ padding: "0 14px 12px", borderTop: "1px solid var(--color-border)" }}>
          <label>
            Offer closes in
            <select data-testid="offer-expiry" value={offerExpiry} onChange={(e) => setOfferExpiry(e.currentTarget.value)}>
              {EXPIRY_CHOICES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
          <p style={small}>If no one has taken it by then, the offer closes.</p>

          <div data-testid="direct-challenge">
            <TextField
                label="Only this person can take it (optional)"
                data-testid="taker-account-input"
                value={takerAccount}
                onChange={(e) => setTakerAccount(e.currentTarget.value)}
                placeholder={`Their account, e.g. ${exampleAccount("taker")}`}
              />
            {takerErr && <Banner status="error" data-testid="taker-error">{takerErr}</Banner>}
          </div>

          <div data-testid="invite-by-link-row">
            <CheckField data-testid="invite-by-link" label="Invite-only link" checked={inviteByLink && !takerAccount} disabled={!!takerAccount} onChange={(e) => setInviteByLink(e.currentTarget.checked)} />
            <p style={small}>Only people you send a personal link to can take it. You make each link after opening.</p>
          </div>

          {human ? (
            <div>
              <TextField label="Referee deadline" data-testid="resolve-deadline" type="date" value={resolveValue} onChange={(e) => setResolveDate(e.currentTarget.value || null)} />
              <p data-testid="resolve-label" style={small}>If the referee hasn't ruled by this date, you're both refunded.</p>
              {resolveErr && <Banner status="error" data-testid="resolve-error">{resolveErr}</Banner>}
              {expiryErr && <Banner status="error" data-testid="expiry-error">{expiryErr}</Banner>}
            </div>
          ) : (
            <p data-testid="challenge-window-line" style={small}>After the AI rules, either of you has {FIXED_SETTLEMENT_PERIOD} to challenge.</p>
          )}
        </div>
      )}
    </div>
  );
}
