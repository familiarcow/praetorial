// NAV1 (UX-31) + H1 (UIR1 §3.3): the Home page's "Explore Bets" section -- other people's open offers I can still take, as kit
// BetCard "offer" cards ("You put in 40 USDC · win 50 USDC", by @alice · AI judge · closes in 2 days, Take). My own offers are under
// My Bets. Token filter = logo chips (All + this network's bet tokens). 2 columns from 900px.
// Source: the indexer's /offers (fast path; untargeted, this build's escrow only: browseCards.keepOffers, minus the CS1 hide list),
// then get_bet per row (the truth; a row whose bet can't be read, was taken, or has no readable question is dropped:
// homeSections.exploreCards, from betView). Maker @usernames: lib/homeNames.ts (the one lookup layer; SM2 H1-2).
// IDX2: my own just-opened bets (lib/justOpened) show first, at once: an optimistic row from the Open result, replaced by the indexed
// row (re-read with get_bet) once the indexer lists it. After an Open/Take the page re-reads silently on BETS_CHANGED (no "Loading").
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssetLogo } from "../kit";
import { COPY } from "../../lib/globalStates";
import { fetchOpenOffers } from "../../lib/indexerClient";
import { getBet } from "../../lib/escrowAdapter";
import { exploreCards, exploreOffers, filterChips, homeAccounts, myNewCards, myNewOffers, type HomeBet, type NewOfferItem } from "../../lib/homeSections";
import { justOpened, sessionStore } from "../../lib/justOpened";
import { BETS_CHANGED } from "../../lib/indexerRefresh";
import type { Bet } from "../../lib/escrowAdapter";
import { exploreHidden } from "../../lib/exploreHidden";
import { ESCROW_CONTRACT_ID } from "../../lib/config";
import { chainClock } from "../../lib/chainClock";
import { keepOffers, BROWSE_EMPTY } from "../../lib/browseCards";
import { useNames } from "../../lib/homeNames";
import { ErrorNotice } from "../objects";
import { HomeCardList } from "./HomeCards";

const chainNowMs = (): number => chainClock.nowMs() ?? Date.now();

export default function BrowsePage({ myAccountId, navigate }: { myAccountId: string | null; navigate?: (to: string) => void }) {
  const go = useCallback((to: string) => {
    if (navigate) return navigate(to);
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [navigate]);
  const [nowMs, setNowMs] = useState(chainNowMs);
  useEffect(() => { const t = setInterval(() => setNowMs(chainNowMs()), 30_000); return () => clearInterval(t); }, []);
  const [token, setToken] = useState<string>("all");
  const [items, setItems] = useState<HomeBet[] | "loading" | "error">("loading");
  const [reload, setReload] = useState(0);
  const optimistic = useCallback((): NewOfferItem[] => myNewOffers(justOpened(sessionStore(), myAccountId, Date.now()), null, new Map()), [myAccountId]);
  const [mine, setMine] = useState<NewOfferItem[]>(optimistic);
  const silent = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!silent.current) setItems("loading");
    silent.current = false;
    const entries = justOpened(sessionStore(), myAccountId, Date.now());
    // at once: rows already shown stay as they are, a bet opened since then appears as its optimistic row
    setMine((m) => { const shown = new Map(m.map((x) => [x.id, x] as const)); return entries.map((e) => shown.get(e.id) ?? { id: e.id, bet: e.bet, source: "optimistic" as const }); });
    const read = async (id: number): Promise<Bet | null> => { try { return await getBet(id); } catch { return null; } };
    (async () => {
      let listed: ReturnType<typeof keepOffers> | null = null;
      try {
        // BROWSE1: only rows for THIS build's escrow contract; CS1: minus the hide list; not my own offers.
        listed = keepOffers(await fetchOpenOffers(), ESCROW_CONTRACT_ID);
        const rows = exploreOffers(listed, myAccountId, exploreHidden(ESCROW_CONTRACT_ID));
        const loaded = await Promise.all(rows.map(async (s) => ({ id: s.bet_id, bet: await read(s.bet_id) })));
        if (!cancelled) setItems(loaded.filter((x): x is HomeBet => !!x.bet));
      } catch {
        if (!cancelled) setItems("error");
      }
      // IDX2: my just-opened bets -- the indexed row once listed (fresh get_bet), else the optimistic one
      const ids = new Set((listed ?? []).map((o) => o.bet_id));
      const fresh = new Map(await Promise.all(entries.filter((e) => ids.has(e.id)).map(async (e) => [e.id, await read(e.id)] as const)));
      if (!cancelled) setMine(myNewOffers(entries, listed, fresh));
    })();
    return () => { cancelled = true; };
  }, [myAccountId, reload]);

  // IDX2: an Open/Take nudged the indexer -> re-read quietly (the list stays on screen while it refreshes)
  useEffect(() => {
    const on = () => { silent.current = true; setReload((n) => n + 1); };
    window.addEventListener(BETS_CHANGED, on);
    return () => window.removeEventListener(BETS_CHANGED, on);
  }, []);

  const names = useNames(useMemo(() => [...new Set([...(Array.isArray(items) ? homeAccounts(items) : []), ...homeAccounts(mine)])], [items, mine]));
  const cards = useMemo(() => (Array.isArray(items) ? exploreCards(items, myAccountId, nowMs, { names, contractId: ESCROW_CONTRACT_ID }, token) : []), [items, myAccountId, nowMs, names, token]);
  const retry = useCallback(() => setReload((n) => n + 1), []);
  const newCards = useMemo(() => myNewCards(mine, myAccountId, nowMs, { names, contractId: ESCROW_CONTRACT_ID }), [mine, myAccountId, nowMs, names]);

  return (
    <section data-testid="browse-page" aria-labelledby="explore-title">
      <header className="h-head"><h2 id="explore-title">Explore Bets</h2></header>
      <p className="muted">Open offers from other people, not taken yet. Open one to take it.</p>
      <div className="h-chips" role="group" aria-label="Filter by token" data-testid="browse-asset-filter">
        {filterChips().map((s) => (
          <button key={s} type="button" className="h-chip" data-testid={`browse-chip-${s}`} aria-pressed={token === s} onClick={() => setToken(s)}>
            {s !== "all" && <AssetLogo symbol={s} size="16px" />}{s === "all" ? "All" : s}
          </button>
        ))}
      </div>
      {newCards.length > 0 && (
        <section data-testid="my-new-offers" aria-label="Your new bet">
          <p className="muted" data-testid="my-new-offers-note">Your new bet is open. Others see it here too.</p>
          {(["indexed", "optimistic"] as const).map((src) => {
            const cs = newCards.filter((c) => c.source === src);
            return cs.length ? <HomeCardList key={src} cards={cs} rowId="my-new-row-" navigate={go} note={false} data-source={src} /> : null;
          })}
        </section>
      )}
      <section data-testid="open-offers-list" aria-label="Open offers">
        {items === "loading" && <p data-testid="offers-status">{COPY.loading}</p>}
        {items === "error" && <ErrorNotice data-testid="offers-status" retryTestId="offers-retry" onRetry={retry}>{COPY.listLoadFailed}</ErrorNotice>}
        {Array.isArray(items) && cards.length === 0 && <p data-testid="offers-status">{token === "all" ? BROWSE_EMPTY : `No open bets in ${token} right now.`}</p>}
        {cards.length > 0 && <HomeCardList cards={cards} rowId="offer-row-" navigate={go} />}
      </section>
    </section>
  );
}
