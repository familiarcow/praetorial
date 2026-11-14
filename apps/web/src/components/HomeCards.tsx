// H1: one list of kit BetCards for every Home section. The card opens the bet; its one button (only on a "Needs you" or an Explore
// card) also opens the bet page, where the action itself sits behind gate() / GateNotice (SM2). Amounts are hidden while the
// money data is stale (FE16b).
import React from "react";
import { BetCard } from "../kit";
import { useMoneyStale } from "../../lib/moneyContext";
import { COPY as GS_COPY } from "../../lib/globalStates";
import { betPath } from "../../lib/router";
import type { HomeCard } from "../../lib/homeSections";
import "./home.css";

/** The stale-money note, once per section. */
export function StaleNote({ testId }: { testId: string }) {
  return useMoneyStale() ? <p className="k-small k-muted" data-testid={testId}>{GS_COPY.moneyStale}</p> : null;
}

export function HomeCardList({ cards, rowId, navigate, grid = true, note = true, ...rest }: {
  cards: HomeCard[]; rowId: string; navigate: (to: string) => void; grid?: boolean; /** false: the section shows one StaleNote itself */ note?: boolean;
} & { [k: `data-${string}`]: unknown }) {
  const stale = useMoneyStale();
  const open = (id: number) => navigate(betPath(id));
  return (
    <>
      {note && <StaleNote testId={`${rowId.replace(/-row-$/, "")}-stale`} />}
      <div {...(rest as object)} className={`h-list${grid ? " h-list--grid" : ""}${stale ? " h-stale" : ""}`} data-money-stale={stale ? "1" : "0"}>
        {cards.map((c) => (
          <BetCard key={c.view.id} view={c.view} variant={c.variant} href={betPath(c.view.id)} onOpen={open} onAction={() => open(c.view.id)}
            data-testid={`${rowId}${c.view.id}`} />
        ))}
      </div>
    </>
  );
}
