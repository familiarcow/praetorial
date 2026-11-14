// F4 (FUND4 SPEC §4, familiarcow UX-37 FUND 12/13, D-FUND4a, SM2 STATES.md M6): the "Add money" sheet. Full-screen sheet on 375 px, a
// modal on desktop. One path (ACCT2, familiarcow 11-13: the "From near.com" tab and its account-ID send are gone -- too much room to lose
// money; near.com users pick the token, network NEAR, and paste the one-time address like everyone else):
//   1 What do you have? (any token, any network) -> 2 amount + estimate, with "You'll bet with"
//      limited to the 6 bet tokens (default: the same token when it is one, else USDC; locked to the bet's token on a hand-off) ->
//      3 the ONE-TIME deposit address (QR, memo, countdown; gone at the deadline) -> 4 the live tracker. No permanent addresses.
// Opened from Account, from the header strip, and OVER create / take / the bet page (App: an /add-money?asset&need&return
// hand-off), so the draft underneath is kept; "Back to your bet" just closes the sheet.
// Testnet (no conversion service): the test-network block the Account page passes in (test NEAR, then Move to betting).
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { BetSymbol, QuoteView, SwapRecord, TokenOption, TokenRef } from "../../../lib/funding/types";
import { BET_SYMBOLS } from "../../../lib/funding/types";
import { COPY } from "../../../lib/funding/copy";
import { resolveBetWith, betWithChoices } from "../../../lib/funding/landing";
import { loadTokens } from "../../../lib/funding/tokens";
import { addressUsable } from "../../../lib/funding/tracker";
import { displayAmount } from "../../../lib/funding/format";
import { fromBaseUnits } from "../../../lib/decimal";
import { findAsset } from "../../../lib/assets";
import { fetchIntentsBalances, type Need } from "../../../lib/intentsBalance";
import {
  parseAmountInput, recordFromQuote, quoteLines, fundErrorText, needOutUnits, rememberPick, displaySymbol, networkName, trackerView,
} from "../../../lib/fundSheet";
import { Modal } from "../../modal/Modal";
import { Button, TextField } from "../../ui";
import { TokenPicker } from "./TokenPicker";
import { AddressStep } from "./AddressStep";
import { Tracker } from "./Tracker";
import { fundingClient, putRecord, setFocus, useFundingRecords } from "./fundingLive";

export interface FundSheetProps {
  account: string;
  /** A bet hand-off: the bet's full pay-now (the sheet subtracts the live balance) and where "Back to your bet" returns. */
  need?: Need | null;
  returnTo?: string | null;
  /** Reopen this deposit's tracker (header strip, Account card). */
  trackId?: string | null;
  /** Testnet: no conversion service; render this block (test NEAR + Move) instead of the flow. */
  testnet?: React.ReactNode | null;
  onClose: () => void;
  /** "Back to your bet" / "Place a bet" when the sheet is not already over that page. */
  onGo?: (path: string) => void;
}

type Step = { name: "pick" } | { name: "amount"; origin: TokenOption } | { name: "deposit"; id: string };

/** The landing token as a TokenRef (mainnet ids: the conversion service is mainnet-only). */
function landingRef(symbol: BetSymbol, assetId: string): TokenRef {
  return { assetId, symbol, blockchain: "near", decimals: findAsset(symbol)!.decimals };
}
const isBetSymbol = (s: string | undefined | null): s is BetSymbol => !!s && (BET_SYMBOLS as readonly string[]).includes(s);

function AmountStep({ account, origin, locked, needFull, returnTo, onBack, onIssued }: {
  account: string; origin: TokenOption; locked: BetSymbol | null; needFull: Need | null; returnTo: string | null;
  onBack: () => void; onIssued: (r: SwapRecord) => void;
}) {
  const [picked, setPicked] = useState<BetSymbol | null>(null);
  const choice = resolveBetWith({ origin, picked, locked, network: "mainnet" });
  const dest = choice.ok ? landingRef(choice.symbol, choice.destinationAsset) : null;
  const [text, setText] = useState("");
  const [dry, setDry] = useState<{ key: string; quote: QuoteView } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"quote" | "address" | null>(null);
  const [needOut, setNeedOut] = useState<string | null>(null);
  const parsed = parseAmountInput(text, origin.decimals);
  const key = parsed.ok && dest ? `${origin.assetId}|${dest.assetId}|${parsed.units}` : null;
  const seq = useRef(0);

  // A bet hand-off: the shortfall = full pay-now minus the live balance; the amount to send is sized to cover it.
  useEffect(() => {
    if (!needFull || !dest || needFull.symbol !== dest.symbol) return;
    let live = true;
    (async () => {
      let bal: string | null = null;
      try { bal = (await fetchIntentsBalances(account))[needFull.symbol] ?? "0"; } catch { bal = null; }
      const out = needOutUnits(needFull, bal);
      if (!live) return;
      setNeedOut(out);
      if (!out) return;
      setBusy("quote");
      try {
        const q = await fundingClient().fundQuote({ account, originAsset: origin.assetId, betWith: dest.assetId, needOut: out, dry: true });
        if (!live) return;
        setText(fromBaseUnits(q.amountIn, origin.decimals));
        setDry({ key: `${origin.assetId}|${dest.assetId}|${q.amountIn}`, quote: q });
        setErr(null);
      } catch (e) { if (live) setErr(fundErrorText(e, origin)); }
      finally { if (live) setBusy(null); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, origin.assetId, dest?.assetId, needFull?.amount]);

  // A dry estimate for every change (debounced 500 ms, the newest answer wins).
  useEffect(() => {
    if (!key || !dest || !parsed.ok || dry?.key === key) return;
    const my = ++seq.current;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setBusy("quote");
      try {
        const q = await fundingClient().fundQuote({ account, originAsset: origin.assetId, betWith: dest.assetId, amountIn: parsed.units, dry: true }, ctl.signal);
        if (seq.current === my) { setDry({ key, quote: q }); setErr(null); }
      } catch (e) {
        if ((e as Error)?.name !== "AbortError" && seq.current === my) { setDry(null); setErr(fundErrorText(e, origin)); }
      } finally { if (seq.current === my) setBusy(null); }
    }, 500);
    return () => { clearTimeout(t); ctl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = dry && dry.key === key ? dry.quote : null;
  const lines = current && dest ? quoteLines(current, origin, dest) : null;
  const covers = current && dest && needOut && BigInt(current.amountOut) >= BigInt(needOut)
    ? COPY.add.covers(displayAmount(needOut, dest.decimals, dest.symbol, { round: "up" })) : null;

  const getAddress = async () => {
    if (!parsed.ok || !dest) return;
    setBusy("address");
    setErr(null);
    try {
      const q = await fundingClient().fundQuote({ account, originAsset: origin.assetId, betWith: dest.assetId, amountIn: parsed.units, dry: false });
      const r = recordFromQuote({ quote: q, account, origin, destination: dest, now: Date.now(), needReturn: returnTo });
      putRecord(r); // saved BEFORE the address is shown (SPEC §7.4)
      onIssued(r);
    } catch (e) { setErr(fundErrorText(e, origin)); }
    finally { setBusy(null); }
  };

  const sym = displaySymbol(origin);
  return (
    <section className="fund-amount" data-testid="fund-amount-step">
      <Button variant="ghost" size="sm" data-testid="fund-back" onClick={onBack}>‹ {COPY.add.step1Title}</Button>
      <p className="fund-h" data-testid="fund-origin">{COPY.add.addressTitle(sym, networkName(origin.blockchain))}</p>
      <TextField label={`${COPY.add.amountTitle} (${sym})`} value={text} inputMode="decimal" autoComplete="off" data-testid="fund-amount"
        onChange={(e) => { setText(e.target.value); setErr(null); }} />
      <div className="fund-betwith" data-testid="fund-betwith">
        {locked ? <p data-testid="fund-betwith-locked">{COPY.add.betWithLocked(locked)}</p> : (<>
          <p className="k-small k-muted" id="fund-betwith-label">{COPY.add.betWith(choice.ok ? choice.symbol : "USDC")}</p>
          <div className="fund-chips" role="radiogroup" aria-labelledby="fund-betwith-label">
            {betWithChoices("mainnet").map((s) => (
              <button key={s} type="button" role="radio" aria-checked={choice.ok && choice.symbol === s} className="fund-chip"
                data-testid={`fund-betwith-${s}`} onClick={() => setPicked(s)}>{s}</button>
            ))}
          </div>
        </>)}
      </div>
      <div className="fund-estimate" data-testid="fund-estimate" aria-live="polite">
        {busy === "quote" && !lines && <p className="k-muted">Getting an estimate…</p>}
        {lines && (<>
          <p data-testid="fund-you-get"><strong>{lines.youGet}</strong></p>
          <p className="k-small k-muted" data-testid="fund-eta">{[lines.eta, lines.fee].filter(Boolean).join(" · ")}</p>
          {covers && <p data-testid="fund-covers">{covers}</p>}
          {lines.belowBet && <p className="k-small" data-testid="fund-below-bet">{lines.belowBet}</p>}
        </>)}
        {!parsed.ok && parsed.reason === "too-precise" && <p className="k-small" role="alert" data-testid="fund-amount-invalid">That amount has too many decimals for {sym}.</p>}
        {err && <p role="alert" data-testid="fund-error">{err}</p>}
      </div>
      <Button variant="primary" data-testid="fund-get-address" disabled={!current || busy !== null} onClick={() => void getAddress()}>
        {busy === "address" ? "Getting your address…" : COPY.add.getAddressCta}
      </Button>
    </section>
  );
}

function DepositStep({ record, now, onNewAddress, onCta }: {
  record: SwapRecord; now: number; onNewAddress: () => void; onCta: (c: "back" | "bet" | "new-address") => void;
}) {
  const [sent, setSent] = useState(false);
  const v = trackerView(record, now);
  const showAddress = v.showAddress && addressUsable(record, now);
  return (
    <section className="fund-deposit" data-testid="fund-deposit">
      {showAddress && (record.state === "short" || !sent) && (
        <AddressStep record={record} now={now} onNewAddress={onNewAddress}
          onSent={record.state === "waiting" && !sent ? () => setSent(true) : undefined}
          onTxHash={(h) => fundingClient().submitTx(record.depositAddress, h, record.depositMemo)} />
      )}
      {(sent || !showAddress || record.state !== "waiting") && <Tracker record={record} now={now} onCta={onCta} />}
      {sent && showAddress && record.state === "waiting" && (
        <Button variant="ghost" size="sm" data-testid="fund-show-address" onClick={() => setSent(false)}>Show the address again</Button>
      )}
    </section>
  );
}

export function FundSheet({ account, need = null, returnTo = null, trackId = null, testnet = null, onClose, onGo }: FundSheetProps) {
  const locked = need && isBetSymbol(need.symbol) ? need.symbol : null;
  const [step, setStep] = useState<Step>(trackId ? { name: "deposit", id: trackId } : { name: "pick" });
  const [now, setNow] = useState(Date.now());
  const records = useFundingRecords();
  const depositId = step.name === "deposit" ? step.id : null;
  const record = depositId ? records.find((r) => r.id === depositId) ?? null : null;

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { setFocus(depositId); return () => setFocus(null); }, [depositId]);

  const pickOrigin = useCallback((t: TokenOption) => { rememberPick(t.assetId); setStep({ name: "amount", origin: t }); }, []);
  /** Start again with the same token (a new address). */
  const startWith = useCallback(async (assetId: string) => {
    try {
      const t = (await loadTokens()).list.find((x) => x.assetId === assetId);
      setStep(t ? { name: "amount", origin: t } : { name: "pick" });
    } catch { setStep({ name: "pick" }); }
  }, []);
  const onCta = (c: "back" | "bet" | "new-address") => {
    if (c === "new-address") { if (record) void startWith(record.origin.assetId); return; }
    const to = c === "back" ? record?.needReturn ?? returnTo : "/new";
    onClose();
    if (to && onGo) onGo(to);
  };

  const title = COPY.add.title;
  if (testnet) {
    return (
      <Modal isOpen title={title} onRequestClose={onClose} data-testid="add-money-sheet">
        <p data-testid="deposit-mainnet-note">Deposit addresses are available on mainnet. On this test network you can only move money you already hold on NEAR.</p>
        {testnet}
      </Modal>
    );
  }
  return (
    <Modal isOpen title={title} onRequestClose={onClose} width={480} data-testid="add-money-sheet">
      <div className="fund-sheet" data-testid="fund-sheet">
        {locked && step.name !== "deposit" && <p className="k-small" data-testid="fund-locked-note">{COPY.add.betWithLocked(locked)}</p>}
        {step.name === "pick" ? (
          <TokenPicker prefer={locked} onPick={pickOrigin} />
        ) : step.name === "amount" ? (
          <AmountStep account={account} origin={step.origin} locked={locked} needFull={need} returnTo={returnTo}
            onBack={() => setStep({ name: "pick" })} onIssued={(r) => setStep({ name: "deposit", id: r.id })} />
        ) : record ? (
          <DepositStep key={record.id} record={record} now={now} onCta={onCta} onNewAddress={() => void startWith(record.origin.assetId)} />
        ) : (
          <p className="k-muted" data-testid="fund-deposit-loading">Loading your deposit…</p>
        )}
      </div>
    </Modal>
  );
}
