// FE8 (S9): shown after the bet is read back from the contract. The link is /bet/:id.
// C1 (UIR1 §3.4, PEOPLE RULE, UX-37 #6): one card -- the link, Copy + Share as the primary actions, "View your bet" secondary; a named
// taker is their @username (lib/betNames, "…" while it loads), the closing time is relative (exact local + UTC on tap).
import React, { useState } from "react";
import { Button, TextField } from "../ui";
import type { Bet } from "../../lib/escrowAdapter";
import { shareScreenModel } from "../../lib/shareLink";
import { useAppRegistry, useBetNames } from "../../lib/betNames";
import { person, personLabel } from "../../lib/betView";
import { TimeLeft } from "../kit";
import CancelOffer, { type CancelWallet } from "./CancelOffer";

export default function ShareScreen({ betId, bet, wallet, onOpenBet, onMakeAnother }: {
  betId: number;
  bet: Bet;
  wallet: CancelWallet | null;
  onOpenBet: () => void;
  onMakeAnother: () => void;
}) {
  const names = useBetNames(bet, useAppRegistry());
  const allow = bet.envelope.taker_allow as unknown;
  const named = allow && typeof allow === "object" && typeof (allow as { Account?: unknown }).Account === "string" ? (allow as { Account: string }).Account : null;
  const takerLabel = named ? personLabel(person(named, wallet?.nearAddress ?? null, names)) : null;
  const m = shareScreenModel({ betId, bet, origin: window.location.origin, takerLabel });
  const closesAt = Math.floor(Number(bet.envelope.funding_deadline) / 1e6);
  const [copied, setCopied] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof (navigator as any).share === "function";
  async function copy() {
    try { await navigator.clipboard.writeText(m.link); setCopied(true); } catch { setCopied(false); }
  }
  return (
    <section data-testid="share-screen" className="k-card">
      <h2 data-testid="share-title">{m.title}</h2>
      {!cancelled && (<>
        <p data-testid="share-help">{m.help}</p>
        {m.namedTaker && <p data-testid="share-named-taker">{m.namedTaker}</p>}
        {m.inviteNote && <p data-testid="share-invite-note">{m.inviteNote}</p>}
        <TextField label="Share link" hideLabel data-testid="share-link" readOnly value={m.link} onFocus={(e) => e.currentTarget.select()} style={{ width: "100%" }} />
        <div className="k-actions">
          <Button variant="primary" data-testid="share-copy" onClick={copy}>{copied ? "Copied" : "Copy link"}</Button>
          {canShare && <Button variant="primary" data-testid="share-native" onClick={() => (navigator as any).share({ title: "A bet on Praetorial", url: m.link }).catch(() => {})}>Share</Button>}
          {copied && <span data-testid="share-copied" className="k-muted" role="status">Link copied.</span>}
        </div>
        <p data-testid="share-status" className="k-muted">Waiting for someone to take it · <TimeLeft at={closesAt} label="closes" past="closed" /></p>
        <div className="k-actions">
          <Button variant="secondary" data-testid="share-view-bet" onClick={onOpenBet}>View your bet</Button>
        </div>
      </>)}
      <CancelOffer betId={betId} bet={bet} wallet={wallet} onDone={(o) => { if (o.kind === "cancelled" || o.kind === "expired") setCancelled(true); }} />
      {cancelled && <Button data-testid="share-make-another" onClick={onMakeAnother}>Make another bet</Button>}
    </section>
  );
}
