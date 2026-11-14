// FE14 (S16) + NAV1 (UX-31) + H1 (UIR1 §3.2, familiarcow UX-37 #3/#4): the Home page's "My Bets" section. All logic lives in
// lib/homeSections.ts myHome (betView cards) and lib/myBets.ts (which ids to load); this file only loads and renders.
// Groups: "Needs you" (only those cards keep their one button), Open offers, In progress, Bets you decide; Settled is ONE collapsed
// summary row ("Settled (7) · won 2 · lost 1 · refunded 3"). No Duplicate here: it lives in the bet page's More actions.
// Loading: indexer /history?account= (mine) and /offers (offers made to me by name), /history?referee= (exact; scan fallback flagged
// incomplete) -> get_bet per id (the truth), plus pending_payouts while paying and required_challenge_bond for a bettor inside the
// challenge window (homeSections.extraReads, from phaseOf). People are @usernames (lib/homeNames.ts, one lookup layer).
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../ui";
import { Disclosure, EmptyState, useAppState } from "../kit";
import { fetchHistory, fetchOpenOffers, fetchRefereeHistory } from "../../lib/indexerClient";
import { getBet, requiredChallengeBond } from "../../lib/escrowAdapter";
import { viewFunction } from "../../lib/rpc";
import { ESCROW_CONTRACT_ID } from "../../lib/config";
import { chainClock } from "../../lib/chainClock";
import { money } from "../../lib/money";
import { exactTime, relTime } from "../../lib/dates";
import type { PayoutLine } from "../../lib/payoutScreen";
import { ErrorNotice } from "../objects";
import { refereeIds, INCOMPLETE_NOTE, targetedAtMe, EMPTY } from "../../lib/myBets";
import { myHome, extraReads, homeAccounts, type HomeBet } from "../../lib/homeSections";
import { useNames } from "../../lib/homeNames";
import { HomeCardList, StaleNote } from "./HomeCards";

type Load<T> = { state: "loading" } | { state: "error" } | { state: "ok"; value: T };
const chainNowMs = (): number => chainClock.nowMs() ?? Date.now();

async function loadOne(id: number, me: string): Promise<HomeBet | null> {
  let bet = null;
  try { bet = await getBet(id); } catch { bet = null; }
  if (!bet) return null;
  const want = extraReads(bet, me, chainNowMs(), ESCROW_CONTRACT_ID);
  const out: HomeBet = { id, bet, pending: null };
  if (want.pending) { try { out.pending = await viewFunction<PayoutLine[]>(ESCROW_CONTRACT_ID, "pending_payouts", { bet_id: id }); } catch { out.pending = null; } }
  if (want.bond) {
    try { const q = await requiredChallengeBond(id, me); out.bond = q ? money(q.amount, q.asset) : null; } catch { /* not read: the bet page asks again */ }
  }
  return out;
}

export default function MyBets({ me, navigate, onCreate, createDisabled }: { me: string; navigate: (to: string) => void; onCreate?: () => void; createDisabled?: boolean }) {
  const { ctx } = useAppState();
  const [mine, setMine] = useState<Load<HomeBet[]>>({ state: "loading" });
  const [refs, setRefs] = useState<Load<HomeBet[]>>({ state: "loading" });
  const [incomplete, setIncomplete] = useState(false);
  const [updatedMs, setUpdatedMs] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [nowMs, setNowMs] = useState(chainNowMs);
  const [wallMs, setWallMs] = useState(() => Date.now()); // "Updated 2 min ago" is device time, like updatedMs
  useEffect(() => { const t = setInterval(() => { setNowMs(chainNowMs()); setWallMs(Date.now()); }, 30_000); return () => clearInterval(t); }, []);

  useEffect(() => {
    let off = false;
    setMine({ state: "loading" }); setRefs({ state: "loading" }); setIncomplete(false); setNowMs(chainNowMs());
    (async () => {
      try {
        const hist = await fetchHistory(me);
        let offers: Awaited<ReturnType<typeof fetchOpenOffers>> = [];
        try { offers = await fetchOpenOffers(); } catch { offers = []; }
        const ids = [...new Set([...hist.map((h) => h.bet_id), ...targetedAtMe(offers, me)])];
        const out = (await Promise.all(ids.map((id) => loadOne(id, me)))).filter((x): x is HomeBet => !!x);
        if (!off) { setMine({ state: "ok", value: out }); setUpdatedMs(Date.now()); }
      } catch { if (!off) setMine({ state: "error" }); }
    })();
    (async () => {
      try {
        const { ids, incomplete: inc } = await refereeIds(me, { exact: fetchRefereeHistory, scan: () => fetchHistory() });
        const out = (await Promise.all(ids.map((id) => loadOne(id, me)))).filter((x): x is HomeBet => !!x && x.bet.envelope.referee?.account === me);
        if (!off) { setRefs({ state: "ok", value: out }); setIncomplete(inc); }
      } catch { if (!off) setRefs({ state: "error" }); }
    })();
    return () => { off = true; };
  }, [me, reload]);

  const items = useMemo(() => [...(mine.state === "ok" ? mine.value : []), ...(refs.state === "ok" ? refs.value : [])], [mine, refs]);
  const names = useNames(useMemo(() => homeAccounts(items), [items]));
  const home = useMemo(() => myHome(items, me, nowMs, { names, contractId: ESCROW_CONTRACT_ID, shutdown: ctx.shutdown }), [items, me, nowMs, names, ctx.shutdown]);
  const retry = useCallback(() => setReload((n) => n + 1), []);
  const exact = updatedMs !== null ? exactTime(updatedMs) : null;

  return (
    <section data-testid="my-bets" aria-labelledby="my-bets-title">
      <header className="h-head">
        <h2 id="my-bets-title">My Bets</h2>
        {updatedMs !== null && (
          <button type="button" className="h-refresh" data-testid="mybets-refresh" onClick={retry} title={`${exact!.local} · ${exact!.utc}`} aria-label="Refresh my bets">
            <span aria-hidden="true">↻</span><span data-testid="mybets-updated">Updated {wallMs - updatedMs < 60_000 ? "just now" : relTime(updatedMs, wallMs)}</span>
          </button>
        )}
      </header>
      {mine.state === "ok" && !home.empty && <StaleNote testId="mybet-stale" />}
      {mine.state === "loading" && <p data-testid="mybets-loading">Loading your bets…</p>}
      {mine.state === "error" && <ErrorNotice data-testid="mybets-error" retryTestId="mybets-retry" onRetry={retry}>{EMPTY.error}</ErrorNotice>}
      {mine.state === "ok" && refs.state !== "loading" && home.empty && (
        <EmptyState data-testid="mybets-empty" title={EMPTY.all} action={onCreate
          ? <Button variant="primary" data-testid="mybets-create" disabled={createDisabled} onClick={onCreate}>Create bet</Button>
          : <a data-testid="mybets-make-bet" href="/new">Create bet</a>} />
      )}
      {mine.state === "ok" && home.groups.map((g) => (
        <section key={g.id} data-testid={`mybets-group-${g.id}`} data-count={g.cards.length} className={`h-group h-group--${g.id}`} aria-label={g.title}>
          <h3>{g.title} <span className="count">({g.cards.length})</span></h3>
          <HomeCardList cards={g.cards} rowId="mybet-row-" navigate={navigate} note={false} />
        </section>
      ))}
      {mine.state === "ok" && home.settled && (
        <Disclosure data-testid="mybets-settled" title={home.settled.title} summary={<span data-testid="mybets-settled-summary">{home.settled.summary}</span>}>
          <HomeCardList cards={home.settled.cards} rowId="mybet-row-" navigate={navigate} grid={false} note={false} />
        </Disclosure>
      )}
      {refs.state === "ok" && incomplete && <p data-testid="mybets-incomplete" role="status">{INCOMPLETE_NOTE}</p>}
      {refs.state === "error" && <ErrorNotice data-testid="mybets-referee-error" retryTestId="mybets-referee-retry" onRetry={retry}>{EMPTY.refereeError}</ErrorNotice>}
    </section>
  );
}
