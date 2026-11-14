// F4 (FUND4 SPEC §4.1): step 1, "What do you have?" — any token on any network the conversion service accepts (lib/funding/tokens:
// 1Click's list, cached; unknown networks and pseudo-assets hidden). Search by symbol, network or alias ("trc20", "bep20",
// "arbitrum"...). Recent (last two picks), Popular, then All. A network is part of every row: "USDT" alone is never a choice.
// With a bet hand-off (?need) the bet's token comes first on every network. Shared with F5 (Convert / Cash out "Send as").
import React, { useEffect, useMemo, useState } from "react";
import type { TokenOption } from "../../../lib/funding/types";
import { COPY } from "../../../lib/funding/copy";
import { loadTokens, searchTokens, popularTokens } from "../../../lib/funding/tokens";
import { recentPicks } from "../../../lib/fundSheet";
import { AssetLogo, Notice } from "../../kit";
import { Button, TextField } from "../../ui";

function Row({ t, onPick }: { t: TokenOption; onPick: (t: TokenOption) => void }) {
  return (
    <li>
      <button type="button" className="fund-token" data-testid={`fund-token-${t.symbol}-${t.blockchain}`} onClick={() => onPick(t)}>
        <AssetLogo symbol={t.symbol} />
        <span className="fund-token__sym">{t.symbol}</span>
        <span className="fund-token__net k-muted">{t.exchangeNetworkName ?? t.networkName}</span>
      </button>
    </li>
  );
}

export function TokenPicker({ prefer, onPick }: { prefer: string | null; onPick: (t: TokenOption) => void }) {
  const [list, setList] = useState<TokenOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(false);
    loadTokens().then((r) => { if (live) setList(r.list); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [tries]);
  const recent = useMemo(() => {
    if (!list) return [];
    const ids = recentPicks();
    return ids.map((id) => list.find((t) => t.assetId === id)).filter((t): t is TokenOption => !!t);
  }, [list]);

  if (failed) return <Notice tone="bad" title={COPY.add.loadError} data-testid="fund-tokens-error" action={<Button data-testid="fund-tokens-retry" onClick={() => setTries((n) => n + 1)}>{COPY.account.retry}</Button>} />;
  if (!list) return <p className="k-muted" data-testid="fund-tokens-loading">Loading tokens…</p>;
  const hits = searchTokens(list, q, prefer);
  const searching = q.trim().length > 0;
  const popular = searchTokens(popularTokens(list), "", prefer);
  return (
    <section className="fund-picker" data-testid="fund-picker">
      <h3 className="fund-h">{COPY.add.step1Title}</h3>
      <TextField type="search" label={COPY.add.search} hideLabel placeholder={COPY.add.search} value={q} onChange={(e) => setQ(e.target.value)} data-testid="fund-search" autoComplete="off" spellCheck={false} />
      {searching ? (
        hits.length ? <ul className="fund-tokens" data-testid="fund-results">{hits.map((t) => <Row key={t.assetId} t={t} onPick={onPick} />)}</ul>
          : <p data-testid="fund-no-results">{COPY.add.noResults}</p>
      ) : (<>
        {recent.length > 0 && (<><h4 className="fund-sub">{COPY.add.recent}</h4><ul className="fund-tokens" data-testid="fund-recent">{recent.map((t) => <Row key={t.assetId} t={t} onPick={onPick} />)}</ul></>)}
        <h4 className="fund-sub">{COPY.add.popular}</h4>
        <ul className="fund-tokens" data-testid="fund-popular">{popular.map((t) => <Row key={t.assetId} t={t} onPick={onPick} />)}</ul>
        <h4 className="fund-sub">{COPY.add.all(list.length)}</h4>
        <ul className="fund-tokens" data-testid="fund-all">{hits.map((t) => <Row key={t.assetId} t={t} onPick={onPick} />)}</ul>
      </>)}
    </section>
  );
}
