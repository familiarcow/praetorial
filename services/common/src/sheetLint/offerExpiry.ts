// FE5b (S5): the offer-expiry choice. funding_deadline = min(latest valid funding time, now + chosen expiry), never later than
// today's rule (the template's event close, floored at now + the taker window (DR3W1)). Pure; used by buildOpenEnvelope AND the review card so they agree.
export interface SettlementOption { id: string; secs: number }
export const OFFER_EXPIRY_OPTIONS: SettlementOption[] = [{ id: "1d", secs: 86400 }, { id: "7d", secs: 7 * 86400 }, { id: "30d", secs: 30 * 86400 }];

export interface FundingDeadline { secs: number; clamped: boolean }
// DR3W1 (DR3 F1): an offer on an event that already started (climate day, game) used to be floored at review + 60 s; the source
// check alone takes 30-60 s, so it expired before anyone could take it. The floor is now a real taker window.
export const MIN_TAKER_WINDOW_SECS = 30 * 60;
/** Null when a taker still has a window before the event ends; else a plain refusal. */
export function openWindowProblem(a: { endSecs: number; nowSecs: number }): string | null {
  return a.endSecs - a.nowSecs < MIN_TAKER_WINDOW_SECS
    ? "This event ends too soon: there is not enough time for someone to take the bet. Pick a later day or time." : null;
}
export function fundingDeadlineSecs(a: { latestSecs: number; nowSecs: number; expirySecs?: number }): FundingDeadline {
  const latest = Math.max(a.latestSecs, a.nowSecs + MIN_TAKER_WINDOW_SECS);
  if (a.expirySecs === undefined) return { secs: latest, clamped: false };
  const chosen = a.nowSecs + a.expirySecs;
  return chosen < latest ? { secs: chosen, clamped: false } : { secs: latest, clamped: true };
}

export function formatUtc(secs: number): string {
  return `${new Date(secs * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
export function offerClosesLabel(d: FundingDeadline): string {
  return `This offer closes ${formatUtc(d.secs)}${d.clamped ? " (the event starts then, so that is as long as it can stay open)" : ""}.`;
}
