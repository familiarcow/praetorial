// NAV1 (UX-31 Home "In progress") + H1 (familiarcow UX-37 #2): other people's accepted, unfinished bets, read-only kit BetCard "public"
// cards (pill + @maker vs @taker + who decides + the bet's sentence, from betView). My bets and the ones I referee are under My Bets.
// Source: indexer /history (unfiltered) -> newest IN_PROGRESS_LIMIT candidates (minus the CS1 hide list) -> get_bet each (the truth;
// a bet that moved on, is mine, or can't be read readably is dropped: homeSections.inProgressCards). 2 columns from 900px.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { fetchHistory } from "../../lib/indexerClient";
import { getBet } from "../../lib/escrowAdapter";
import { inProgressCandidates, inProgressCards, homeAccounts, IN_PROGRESS_LIMIT, type HomeBet } from "../../lib/homeSections";
import { exploreHidden } from "../../lib/exploreHidden";
import { ESCROW_CONTRACT_ID } from "../../lib/config";
import { chainClock } from "../../lib/chainClock";
import { useNames } from "../../lib/homeNames";
import { ErrorNotice } from "../objects";
import { HomeCardList } from "./HomeCards";

const chainNowMs = (): number => chainClock.nowMs() ?? Date.now();

export default function InProgressBets({ me, navigate, guest = false }: { me: string | null; navigate: (to: string) => void; guest?: boolean }) {
  const [items, setItems] = useState<HomeBet[] | "loading" | "error">("loading");
  const [reload, setReload] = useState(0);
  const [nowMs, setNowMs] = useState(chainNowMs);
  useEffect(() => { const t = setInterval(() => setNowMs(chainNowMs()), 30_000); return () => clearInterval(t); }, []);

  useEffect(() => {
    let off = false;
    setItems("loading");
    (async () => {
      try {
        const ids = inProgressCandidates(await fetchHistory(), IN_PROGRESS_LIMIT, exploreHidden(ESCROW_CONTRACT_ID));
        const loaded = await Promise.all(ids.map(async (id) => { try { return { id, bet: await getBet(id) }; } catch { return { id, bet: null }; } }));
        if (!off) setItems(loaded.filter((x): x is HomeBet => !!x.bet));
      } catch { if (!off) setItems("error"); }
    })();
    return () => { off = true; };
  }, [reload]);

  const names = useNames(useMemo(() => (Array.isArray(items) ? homeAccounts(items) : []), [items]));
  const cards = useMemo(() => (Array.isArray(items) ? inProgressCards(items, me, nowMs, { names, contractId: ESCROW_CONTRACT_ID }) : []), [items, me, nowMs, names]);
  const retry = useCallback(() => setReload((n) => n + 1), []);
  return (
    <section data-testid="in-progress" aria-labelledby="in-progress-title">
      <header className="h-head"><h2 id="in-progress-title">In progress</h2></header>
      <p className="muted">{guest ? "Bets that have been taken and are not settled yet." : "Other people's bets that have been taken and are not settled yet. Yours are under My Bets."}</p>
      {items === "loading" && <p data-testid="in-progress-loading">Loading bets in progress…</p>}
      {items === "error" && <ErrorNotice data-testid="in-progress-error" retryTestId="in-progress-retry" onRetry={retry}>We couldn't load the bets in progress.</ErrorNotice>}
      {Array.isArray(items) && cards.length === 0 && <p data-testid="in-progress-empty">No bets in progress right now.</p>}
      {cards.length > 0 && <HomeCardList cards={cards} rowId="progress-row-" navigate={navigate} />}
    </section>
  );
}
