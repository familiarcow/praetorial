// F3 (FUND4 SPEC §3, familiarcow UX-37 / D-FUND4a, SM2 STATES.md M5 + gaps F3-1..5): the Account page (was NAV1's Wallet).
//   @username header card (record, member since, grey ≈ $X, Add money / Cash out, collapsed Account details with the account id,
//   Change username = the old Settings page, Log out) -> transfers in flight -> one row per bet token (token units; NEAR-account and
//   in-bets lines only when non-zero; tap = token sheet) -> "Not usable for bets yet" (Convert into the 6) -> "Being paid out".
//   Empty: one Add money hero, then (ACCT2) the betting balance rows at 0 so a new user sees what they can bet with. Testnet: test
//   NEAR from the faucet instead of deposits; no $ figure.
// Every amount and every "empty / failed / unread" decision comes from lib/walletCards.ts (the view model) over
// lib/accountBalances.ts (the reads); every enable/disable comes from lib/appState gate() via useGate. Money flows are unchanged:
// the same Move / Withdraw modals (AccountModals.tsx); Add money is F4's one-time-address sheet (src/components/funding).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui";
import { GateNotice, Notice, useGate } from "../kit";
import { CURRENT_NETWORK } from "../../lib/assets";
import { parseNeed } from "../../lib/intentsBalance";
import { parseReturn } from "../../lib/fundingGate";
import { depositApiEnabled } from "../../lib/depositAddress";
import { requestTestNear } from "../../lib/faucet";
import { fundingGuide } from "../../lib/fundingGuide";
import { bettingTotalUsd, createSequence } from "../../lib/funding/balances";
import { COPY } from "../../lib/funding/copy";
import { loadMoney, loadBets, type MoneyLoad } from "../../lib/accountBalances";
import { accountRows, accountView, moneyUnread, strayRows, needHeadline, type BetsState, type StrayRow } from "../../lib/walletCards";
import { formatMoney } from "../../lib/money";
import { MONEY_HIDDEN } from "../../lib/globalStates";
import { useMoneyStale } from "../../lib/moneyContext";
import { e2eDepositApi } from "../../lib/testHooks";
import type { Holding } from "../../lib/moveToBetting";
import { MoveModal, WithdrawModal } from "./AccountModals";
import { AccountHeader } from "./wallet/AccountHeader";
import { AssetRow } from "./wallet/AssetRow";
import { TokenSheet } from "./wallet/TokenSheet";
import { StraySection } from "./wallet/StraySection";
import { InFlightCard } from "./wallet/InFlightCard";
import { EmptyWallet } from "./wallet/EmptyWallet";
import { FaucetBlock } from "./wallet/FaucetBlock";
import { FundSheet } from "./funding/FundSheet";
import { WithdrawSheet } from "./funding/WithdrawSheet";
import { ConvertSheet } from "./funding/ConvertSheet";
import { cashOutHoldings, holdingFor, holdingFromStray, visibleInFlight, dismissedIds, type CashOutHolding } from "../../lib/cashOut";

export default function WalletPage({ account, search, registryUrl, signRawHash, onBack, onLogout }: {
  account: string; search: string; registryUrl: string; signRawHash: (a: string, h: string) => Promise<string>;
  onBack?: (to: string) => void; onLogout?: () => void;
}) {
  const stale = useMoneyStale();
  // The deposit addresses and the mainnet-only reads (stray tokens, 1Click prices) are on with mainnet, or a mocked spec's seam.
  const depositOn = depositApiEnabled() || e2eDepositApi();
  // Testnet variant: test NEAR from the faucet instead of deposits (a mocked spec's mainnet seam shows the mainnet page).
  const testnet = CURRENT_NETWORK === "testnet" && !depositOn;
  const [money, setMoney] = useState<MoneyLoad | null>(null);
  const [bets, setBets] = useState<BetsState>("loading");
  const moneySeq = useRef(createSequence()).current;
  const betsSeq = useRef(createSequence()).current;
  const [sheet, setSheet] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [trackId, setTrackId] = useState<string | null>(null);
  // F5: Cash out (any token, any network, user-signed) and Convert (only into the 6). `track`: reopen one from the in-progress card.
  const [cashOut, setCashOut] = useState<{ preset: string | null; track: string | null } | null>(null);
  const [converting, setConverting] = useState<{ holding: CashOutHolding | null; track: string | null } | null>(null);
  const [moving, setMoving] = useState<Holding | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  const [wdDone, setWdDone] = useState<{ symbol: string; message: string } | null>(null);
  const [faucet, setFaucet] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });
  const need = parseNeed(search);
  const symbol = need?.symbol ?? "USDC";
  const back = parseReturn(search);

  const gates = {
    addMoney: useGate("add-money").allowed,
    cashOut: useGate("cash-out").allowed,
    move: useGate("move-to-betting").allowed,
    convert: useGate("convert").allowed,
  };

  const loadMoneyNow = useCallback(() => {
    const t = moneySeq.next();
    loadMoney(account, { mainnetReads: depositOn }).then((m) => { if (moneySeq.isCurrent(t)) setMoney(m); });
  }, [account, depositOn, moneySeq]);
  const loadBetsNow = useCallback(() => {
    const t = betsSeq.next();
    loadBets(account).then((b) => { if (betsSeq.isCurrent(t)) setBets(b); }, () => { if (betsSeq.isCurrent(t)) setBets("error"); });
  }, [account, betsSeq]);
  const refresh = useCallback(() => { loadMoneyNow(); loadBetsNow(); }, [loadMoneyNow, loadBetsNow]);
  useEffect(() => { setMoney(null); setBets("loading"); refresh(); }, [refresh]);
  // FUND1: re-read after the user comes back from another tab (faucet, exchange, their wallet).
  useEffect(() => { const f = () => loadMoneyNow(); window.addEventListener("focus", f); return () => window.removeEventListener("focus", f); }, [loadMoneyNow]);

  const map = money?.map ?? null;
  const report = money?.report ?? null;
  const bettingFailed = map?.betting === "error";
  const rows = useMemo(() => accountRows(map, report, bets, CURRENT_NETWORK), [map, report, bets]);
  // AFIX1: loading (one placeholder) -> exactly one of empty / list. Re-reads keep the last answer (setMoney only replaces it).
  const view = accountView(money, bets);
  const loading = view === "loading";
  const empty = view === "empty";
  const unread = moneyUnread(money);
  const strays = map && map.stray !== "error" ? strayRows(map.stray) : [];
  // FUND 11: the only $ figure, from 1Click prices, hidden when any price is missing (and on testnet, where tokens have no price).
  const totalUsd = map && depositOn && !stale && !empty ? bettingTotalUsd(map, money!.tokens, "mainnet") : null;
  const bettingOf = (s: string): bigint | null => (map && map.betting !== "error" ? (map.betting as Record<string, bigint>)[s] ?? 0n : null);
  const guide = map && map.betting !== "error" && report
    ? fundingGuide({ need, symbol, balanceUnits: (bettingOf(symbol) ?? 0n).toString(), report, network: CURRENT_NETWORK }) : null;
  // FUND1b (testnet): free test NEAR when the bet needs it, or when there is nothing to bet with and nothing to move.
  const nothingToBet = !!map && map.betting !== "error" && Object.values(map.betting).every((v) => (v ?? 0n) === 0n) && !!report && report.holdings.length === 0;
  const showFaucet = testnet && !!guide && (guide.showFaucet || (!need && (empty || nothingToBet)));
  const cashable = map ? cashOutHoldings(map) : [];
  const strayHolding = (r: StrayRow) => { const s = map && map.stray !== "error" ? map.stray.find((x) => x.assetId === r.assetId) : undefined; return s ? holdingFromStray(s) : null; };

  // FUND1b: one click, funded by our testnet server faucet; then re-read the balances.
  const getTestNear = async () => {
    setFaucet({ busy: true, message: null });
    const r = await requestTestNear(account);
    setFaucet({ busy: false, message: r.ok ? `${r.amountNear} test NEAR is on its way to your account. Your balance updates in a moment.` : r.message });
    if (r.ok) loadMoneyNow();
  };
  const faucetBlock = <FaucetBlock busy={faucet.busy} message={faucet.message} onGet={getTestNear} onRefresh={loadMoneyNow} />;
  const openAddMoney = () => { setSheet(null); setAddOpen(true); };
  const sheetRow = sheet ? rows.find((r) => r.symbol === sheet) ?? null : null;

  const headerActions = (
    <div className="k-actions">
      {/* Empty (mainnet): the hero below carries the one Add money button. Testnet's hero is the faucet, so the button stays here. */}
      {!loading && (!empty || testnet) && <Button variant="primary" disabled={!gates.addMoney} data-testid="account-add-money" onClick={openAddMoney}>{COPY.account.addMoney}</Button>}
      {view === "list" && <Button disabled={!gates.cashOut || cashable.length === 0} data-testid="account-cash-out" onClick={() => setCashOut({ preset: null, track: null })}>{COPY.account.cashOut}</Button>}
    </div>
  );

  return (<>
    <section data-testid="add-money" className="wallet acct">
      <AccountHeader account={account} registryUrl={registryUrl} signRawHash={signRawHash} totalUsd={totalUsd} bets={bets} actions={headerActions} onLogout={onLogout} />
      <GateNotice action="add-money" only={["login", "setting-up", "setup-failed"]} testId="account-gate" />

      {(need || back || guide?.notes.length || (showFaucet && !empty)) && (
        <div className="acct-need" data-testid="account-need">
          {need && <p data-testid="balance-headline">{needHeadline(symbol, bettingOf(symbol), need) ?? "…"}</p>}
          {guide?.missingText && <p data-testid="missing-amount"><strong>{guide.missingText}</strong> missing from your betting balance for this bet.{guide.coveredByMoving ? " You can cover it by moving the money below." : guide.afterMoveMissingText ? ` Moving the money below leaves ${guide.afterMoveMissingText} still to add.` : ""}</p>}
          {guide?.notes.map((n) => <p key={n} data-testid="funding-note" role="status">{n}</p>)}
          {showFaucet && !empty && faucetBlock}
          {back && onBack && <Button data-testid="add-money-back" onClick={() => onBack(back)}>{back === "/new" ? "Back to your bet" : "Back to the bet"}</Button>}
        </div>
      )}

      {map && <InFlightCard records={map.inFlight.filter((r) => visibleInFlight(r, Date.now(), dismissedIds(account)))} onOpen={(id) => {
        const kind = map.inFlight.find((r) => r.id === id)?.kind;
        if (kind === "withdraw") setCashOut({ preset: null, track: id });
        else if (kind === "convert") setConverting({ holding: null, track: id });
        else { setTrackId(id); setAddOpen(true); }
      }} />}

      {unread && (
        <Notice tone="bad" title={COPY.account.readError} data-testid="balance-error"
          action={<Button data-testid="balance-retry" onClick={loadMoneyNow}>{COPY.account.retry}</Button>} />
      )}
      {moved && <p data-testid="move-status" role="status">Moved to your betting balance.</p>}
      {wdDone && <p data-testid={`withdraw-status-${wdDone.symbol}`} role="status">{wdDone.message}</p>}

      {(bets === "error" || (bets !== "loading" && bets.payoutsUnread)) && <p className="k-small k-muted" data-testid="bets-error">{COPY.account.rowInBetsUnread}. <Button size="sm" variant="ghost" data-testid="bets-retry" onClick={loadBetsNow}>{COPY.account.retry}</Button></p>}
      {loading ? (
        <p className="k-muted" role="status" data-testid="account-loading">{COPY.account.loading}</p>
      ) : (<>
        {/* ACCT2 (familiarcow 11-13): an empty account keeps the hero on top AND lists every bet token at 0 below it. */}
        {empty && <EmptyWallet testnet={testnet} addMoneyAllowed={gates.addMoney} onAddMoney={openAddMoney} faucet={faucetBlock} />}
        <h2 className="acct-section__title">{COPY.account.totalLabel}</h2>
        <ul className="acct-rows" data-testid="balances">
          {rows.map((r) => (
            <AssetRow key={r.symbol} row={r} stale={stale} failed={bettingFailed} moveAllowed={gates.move} onOpen={() => setSheet(r.symbol)} onMove={setMoving} />
          ))}
        </ul>
        <StraySection rows={strays} failed={map?.stray === "error"} stale={stale} convertAllowed={gates.convert} onConvert={(r) => setConverting({ holding: strayHolding(r), track: null })} />
        {bets !== "loading" && bets !== "error" && bets.payouts.length > 0 && (
          <section className="acct-section" data-testid="payouts-section">
            <h2 className="acct-section__title">{COPY.account.payoutsTitle}</h2>
            <ul className="acct-list">
              {bets.payouts.map((p, i) => (
                <li key={`${p.betId}-${i}`} data-testid="payout-row">
                  <span>{stale ? MONEY_HIDDEN : formatMoney({ units: p.units, symbol: p.symbol }).text}</span>{" "}
                  <a href={`/bet/${p.betId}`} onClick={(e) => { if (onBack) { e.preventDefault(); onBack(`/bet/${p.betId}`); } }}>Bet #{p.betId} ›</a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </>)}
    </section>

    {sheetRow && (
      <TokenSheet row={sheetRow} stale={stale} allowed={gates} onClose={() => setSheet(null)} onAddMoney={openAddMoney}
        onMove={(h) => { setSheet(null); setMoving(h); }} onCashOutToNear={() => { setSheet(null); setWithdrawing(sheetRow.symbol); }}
        onCashOut={() => { setSheet(null); setCashOut({ preset: holdingFor(sheetRow.symbol, 0n)?.assetId ?? null, track: null }); }}
        onConvert={() => { setSheet(null); setConverting({ holding: holdingFor(sheetRow.symbol, sheetRow.betting ?? 0n), track: null }); }} />
    )}
    {addOpen && <FundSheet account={account} need={need} returnTo={back} trackId={trackId} testnet={depositOn ? null : faucetBlock} onClose={() => { setAddOpen(false); setTrackId(null); loadMoneyNow(); }} onGo={onBack} />}
    {cashOut && (
      <WithdrawSheet account={account} balances={map && bets !== "loading" && bets !== "error" ? { ...map, inBets: bets.inBets } : map} preset={cashOut.preset} trackId={cashOut.track}
        signRawHash={signRawHash} onClose={() => { setCashOut(null); loadMoneyNow(); }} />
    )}
    {converting && (
      <ConvertSheet account={account} holding={converting.holding} trackId={converting.track} signRawHash={signRawHash}
        onClose={() => { setConverting(null); loadMoneyNow(); }} />
    )}
    {moving && <MoveModal holding={moving} account={account} onChanged={refresh} onClose={(last) => { setMoving(null); if (last?.kind === "moved") setMoved(true); }} />}
    {withdrawing && map && map.betting !== "error" && (
      <WithdrawModal symbol={withdrawing} balanceUnits={(bettingOf(withdrawing) ?? 0n).toString()} account={account} onChanged={refresh}
        onClose={(last) => { const sym = withdrawing; setWithdrawing(null); if (last) setWdDone({ symbol: sym, message: last.message }); }} />
    )}
  </>);
}
