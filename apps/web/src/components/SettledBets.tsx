// SET1 (PM, 2026-11-14: "I cant see the bets that have already finished ... I want all users to be able to see them"): Home's public
// "Settled" section, after In progress. Everyone's finished, accepted bets, mine included, as read-only kit BetCard "public" cards:
// the sentence, @maker vs @taker with stakes, the ruling and how it ended (homeSections.settledEnding); the card opens /bet/<id>.
// Source: indexer /history -> every Settled/Voided candidate (minus the CS1 hide list), newest first -> get_bet a page at a time (the
// truth; anything not finished on chain is dropped by homeSections.settledCards). A Voided bet's refund may still be draining, so its
// pending_payouts is read too (homeSections.extraReads), never called "refunded" while it is on its way.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../ui";
import { fetchHistory } from "../../lib/indexerClient";
import { getBet } from "../../lib/escrowAdapter";
import { viewFunction } from "../../lib/rpc";
import { settledCandidates, settledCards, extraReads, homeAccounts, SETTLED_LIMIT, type HomeBet } from "../../lib/homeSections";
import { exploreHidden } from "../../lib/exploreHidden";
import { ESCROW_CONTRACT_ID } from "../../lib/config";
import { chainClock } from "../../lib/chainClock";
import { useNames } from "../../lib/homeNames";
import type { PayoutLine } from "../../lib/payoutScreen";
import { ErrorNotice } from "../objects";
import { HomeCardList } from "./HomeCards";

const chainNowMs = (): number => chainClock.nowMs() ?? Date.now();

async function loadOne(id: number): Promise<HomeBet | null> {
  let bet = null;
  try { bet = await getBet(id); } catch { bet = null; }
  if (!bet) return null;
  const out: HomeBet = { id, bet, pending: null };
  if (extraReads(bet, null, chainNowMs(), ESCROW_CONTRACT_ID).pending) {
    try { out.pending = await viewFunction<PayoutLine[]>(ESCROW_CONTRACT_ID, "pending_payouts", { bet_id: id }); } catch { out.pending = null; }
  }
  return out;
}
const loadPage = async (ids: number[]): Promise<HomeBet[]> => (await Promise.all(ids.map(loadOne))).filter((x): x is HomeBet => !!x);

export default function SettledBets({ me, navigate }: { me: string | null; navigate: (to: string) => void }) {
  const [ids, setIds] = useState<number[]>([]);
  const [items, setItems] = useState<HomeBet[] | "loading" | "error">("loading");
  const [shown, setShown] = useState(0); // how many candidates have been read
  const [more, setMore] = useState<"idle" | "loading" | "error">("idle");
  const [reload, setReload] = useState(0);
  const [nowMs, setNowMs] = useState(chainNowMs);
  useEffect(() => { const t = setInterval(() => setNowMs(chainNowMs()), 30_000); return () => clearInterval(t); }, []);

  useEffect(() => {
    let off = false;
    setItems("loading"); setMore("idle");
    (async () => {
      try {
        const all = settledCandidates(await fetchHistory(), exploreHidden(ESCROW_CONTRACT_ID));
        const first = all.slice(0, SETTLED_LIMIT);
        const loaded = await loadPage(first);
        if (!off) { setIds(all); setShown(first.length); setItems(loaded); }
      } catch { if (!off) setItems("error"); }
    })();
    return () => { off = true; };
  }, [reload]);

  const showMore = useCallback(async () => {
    if (!Array.isArray(items)) return;
    const next = ids.slice(shown, shown + SETTLED_LIMIT);
    setMore("loading");
    try {
      const loaded = await loadPage(next);
      setItems((cur) => (Array.isArray(cur) ? [...cur, ...loaded] : cur));
      setShown((n) => n + next.length);
      setMore("idle");
    } catch { setMore("error"); }
  }, [ids, shown, items]);

  const names = useNames(useMemo(() => (Array.isArray(items) ? homeAccounts(items) : []), [items]));
  const cards = useMemo(() => (Array.isArray(items) ? settledCards(items, me, nowMs, { names, contractId: ESCROW_CONTRACT_ID }) : []), [items, me, nowMs, names]);
  const retry = useCallback(() => setReload((n) => n + 1), []);
  const hasMore = Array.isArray(items) && shown < ids.length;
  return (
    <section data-testid="settled" aria-labelledby="settled-title">
      <header className="h-head"><h2 id="settled-title">Settled</h2></header>
      <p className="muted">Bets that have finished: the ruling, who made it, and who was paid. Open one to see the full ruling.</p>
      {items === "loading" && <p data-testid="settled-loading">Loading settled bets…</p>}
      {items === "error" && <ErrorNotice data-testid="settled-error" retryTestId="settled-retry" onRetry={retry}>We couldn't load the settled bets.</ErrorNotice>}
      {Array.isArray(items) && cards.length === 0 && !hasMore && <p data-testid="settled-empty">No settled bets yet.</p>}
      {cards.length > 0 && <HomeCardList cards={cards} rowId="settled-row-" navigate={navigate} />}
      {more === "error" && <ErrorNotice data-testid="settled-more-error" retryTestId="settled-more-retry" onRetry={showMore}>We couldn't load more settled bets.</ErrorNotice>}
      {hasMore && more !== "error" && (
        <Button data-testid="settled-more" variant="secondary" onClick={showMore} disabled={more === "loading"}>
          {more === "loading" ? "Loading…" : "Show more"}
        </Button>
      )}
    </section>
  );
}
