import React, { useState } from "react";
import { Button } from "../ui";
import { useLoginFirst } from "../kit/Gate";
import type { Bet } from "../../lib/escrowAdapter";
import { requestResultMode, requestResolutionDepositYocto, formatNear } from "../../lib/requestResult";
import { isChallengedRuling } from "../../lib/betLifecycle";
import type { BetPageWallet } from "./BetPage";
import { RequestResultModal } from "./ResolutionModals";
import { timeLeft, exactTime } from "../../lib/dates";

// LH5 / D-HORIZON2: manual fallback if the keeper is down. Anyone may press it.
// MODAL1c3: the button opens a modal (ResolutionModals.tsx) that states the exact NEAR deposit before the confirm.
export default function RequestResultSection({ betId, bet, nowMs, wallet, onChanged }: {
  betId: number; bet: Bet; nowMs: number; wallet: BetPageWallet | null; onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const loginFirst = useLoginFirst(); // GUEST1: a guest gets "Log in to bet" instead of the modal
  const mode = requestResultMode(bet, nowMs); // SM2 gap M1-4: the lib decides which block shows
  // Rendered ahead of the visibility gate: once the request lands this section hides, but the result screen must stay.
  const modal = open ? <RequestResultModal bet={bet} betId={betId} wallet={wallet} onClose={() => setOpen(false)} onChanged={onChanged} /> : null;
  // The modal keeps one stable position in the tree (a move would remount it and lose the result screen).
  let section: React.ReactNode = null;
  if (mode.kind === "wait") {
    const waitMs = mode.untilMs;
    // JCB1: no judge model is live; the escrow refuses another paid run until this time.
    section = (
      <section data-testid="request-result-section" className="k-card k-action k-stack b1-action" data-kind="info">
        <p className="k-action__text">Waiting for a live AI model</p>
        <p data-testid="request-result-next-check" className="k-action__hint">None of the AI models is answering right now. The next check is <time dateTime={new Date(waitMs).toISOString()} title={`${exactTime(waitMs).local} · ${exactTime(waitMs).utc}`}>{timeLeft({ at: waitMs, now: nowMs, future: "due", past: "due" }).text}</time>.</p>
      </section>
    );
  } else if (mode.kind === "request") {
    const deposit = requestResolutionDepositYocto(bet);
    const rejudge = isChallengedRuling(bet); // LIFE1: the challenged ruling's re-judge
    section = (
    <section data-testid="request-result-section" className="k-card k-action k-stack b1-action" data-kind="primary">
      <p className="k-action__text">{rejudge ? "New ruling not started yet?" : "Result not in yet?"}</p>
      <p data-testid="request-result-explainer" className="k-action__hint">
        {rejudge
          ? "The keeper normally asks the AI to look at a challenged ruling again when the evidence window ends. If it hasn't, anyone can ask now."
          : "The keeper normally asks for the result a few minutes after the event. If it hasn't, anyone can ask now."} This attaches
        {" "}{formatNear(deposit)} NEAR from your wallet; whatever the check doesn't use is refunded.
      </p>
      <div className="k-actions k-actions--stack">
        <Button data-testid="request-result-btn" variant="primary" onClick={loginFirst ?? (() => setOpen(true))} disabled={!loginFirst && !wallet}>
          {rejudge ? "Ask for the new ruling now" : "Request the result now"}
        </Button>
      </div>
    </section>
    );
  }
  return <>{section}{modal}</>;
}
