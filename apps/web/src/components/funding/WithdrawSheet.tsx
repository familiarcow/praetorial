// F5 (FUND4 SPEC §5, familiarcow UX-37 FUND 14 / D-FUND4a, SM2 STATES.md M7): the "Cash out" sheet. Full-screen on 375 px, a modal on
// desktop. One primary per step:
//   1 What do you want to cash out? (the 6 bet tokens and "Not usable for bets yet" tokens, non-zero only) + amount + Max
//   2 Send as (any token on any network the conversion service delivers; default per lib/cashOut.defaultSendAs)
//   3 Your address (lib/cashOut.checkAddress, memo chains blocked) -> Review
//   4 Review (an estimate, refreshed every 2 min: you send / they receive ≈ / at least / to / network fee) -> [Cash out]
//   5 Cash out: a real price, the record saved (signed: false), then the USER signs the transfer (lib/cashOutSign: the payload is
//     re-checked in the browser before the wallet is asked; never our relayer) -> the tracker (lib/cashOut.cashOutTrackerView).
// The sheet only renders lib/cashOut's words. Gate: useGate("cash-out") (allowed even when Praetorial is shut down, and never
// needs a username: money must always be able to leave). Unknown is "checking", never "failed".
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { BalanceMap, QuoteView, SwapRecord, TokenOption } from "../../../lib/funding/types";
import { COPY } from "../../../lib/funding/copy";
import { loadTokens } from "../../../lib/funding/tokens";
import { isTerminal } from "../../../lib/funding/tracker";
import { FundingError } from "../../../lib/funding/fundingClient";
import { displaySymbol, helpText } from "../../../lib/fundSheet";
import {
  CASH_OUT_COPY, cashOutHoldings, parseCashOutAmount, maxAmountText, lockedLine, defaultSendAs, sendAsList, checkAddress, reviewView,
  cashOutErrorText, cashOutRecord, priceDropped, cashOutTrackerView, dismiss, type CashOutHolding, type CashOutCta,
} from "../../../lib/cashOut";
import { signAndSubmit } from "../../../lib/cashOutSign";
import { Modal } from "../../modal/Modal";
import { AssetLogo, CopyButton, Disclosure, GateNotice, KeyValue, Notice, useGate } from "../../kit";
import { Button, TextField } from "../../ui";
import { AddressInput, addressReady, type MemoAnswer } from "./AddressInput";
import { fundingClient, putRecord, setFocus, useFundingRecords } from "./fundingLive";

type Sign = (account: string, hashHex: string) => Promise<string>;
export const REVIEW_REFRESH_MS = 2 * 60_000;

// ---------------------------------------------------------------- signing (shared with ConvertSheet)
export type SignOutcome = { kind: "track"; id: string } | { kind: "error"; message: string; keep: boolean };
const workerDown = (e: unknown) => e instanceof FundingError && ["network", "upstream_down", "not_configured", "rate_limited"].includes(e.code);

/** Sign + submit one saved record, and fold the outcome into the store. `keep`: the same record can be signed on the next tap. */
export async function signRecord(record: SwapRecord, account: string, signRawHash: Sign): Promise<SignOutcome> {
  const res = await signAndSubmit(record, { client: fundingClient(), signRawHash, now: Date.now });
  const now = Date.now();
  switch (res.kind) {
    case "submitted": putRecord({ ...record, signed: true, updatedAt: now }); return { kind: "track", id: record.id };
    case "already": return { kind: "track", id: record.id };
    // Signed; whether it arrived is unknown: "checking" (the Worker's list corrects `signed` if it never landed).
    case "unknown": putRecord({ ...record, signed: true, state: "checking", updatedAt: now }); return { kind: "track", id: record.id };
    case "cancelled": dismiss(account, record.id); return { kind: "error", message: COPY.cashOut.signRefused, keep: true };
    case "mismatch": dismiss(account, record.id); return { kind: "error", message: COPY.cashOut.payloadMismatch, keep: false };
    case "expired": dismiss(account, record.id); return { kind: "error", message: CASH_OUT_COPY.expiredUnsigned, keep: false };
    case "refused": dismiss(account, record.id); return { kind: "error", message: workerDown(res.error) ? COPY.common.workerDown : CASH_OUT_COPY.refusedSubmit, keep: false };
  }
}

/** MON-5: warn before the tab closes between the signature and the submit. */
export function useLeaveGuard(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const f = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = CASH_OUT_COPY.leaveWarning; return CASH_OUT_COPY.leaveWarning; };
    window.addEventListener("beforeunload", f);
    return () => window.removeEventListener("beforeunload", f);
  }, [on]);
}

// ---------------------------------------------------------------- tracker (shared with ConvertSheet)
export function CashOutTracker({ record, account, signRawHash, onDone }: { record: SwapRecord; account: string; signRawHash: Sign; onDone: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { setFocus(record.id); return () => setFocus(null); }, [record.id]);
  useLeaveGuard(busy);
  const v = cashOutTrackerView(record, now);
  const run = async (c: CashOutCta) => {
    if (c === "done") return onDone();
    if (c === "cancel") { dismiss(account, record.id); return onDone(); }
    if (c === "help") {
      try { await navigator.clipboard.writeText(helpText(record, now)); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
      return;
    }
    setBusy(true); setErr(null);
    const out = await signRecord(record, account, signRawHash);
    setBusy(false);
    if (out.kind === "error") setErr(out.message);
  };
  const label: Record<CashOutCta, string> = {
    confirm: busy ? COPY.cashOut.sign : COPY.cashOut.confirmCta, cancel: COPY.cashOut.cancelCta, done: CASH_OUT_COPY.doneCta, help: copied ? COPY.add.copied : COPY.track.helpCta,
  };
  return (
    <section className="fund-track co-track" data-testid="co-tracker" data-state={record.state} data-signed={String(record.signed)} aria-live="polite">
      {v.steps.length > 0 && (
        <ol className="fund-steps" data-testid="co-steps">
          {v.steps.map((s) => (
            <li key={s.label} data-status={s.status} aria-current={s.status === "current" ? "step" : undefined}>
              <span className="fund-steps__dot" aria-hidden="true">{s.status === "done" ? "✓" : ""}</span>{s.label}
            </li>
          ))}
        </ol>
      )}
      <Notice tone={v.tone} title={<span data-testid="co-track-message">{v.message}</span>} data-testid="co-track-notice" />
      {record.recipient && (
        <Disclosure title={CASH_OUT_COPY.fullAddress} data-testid="co-track-address">
          <code className="fund-mono">{record.recipient}</code>
        </Disclosure>
      )}
      {err && <p className="co-error" role="alert" data-testid="co-track-error">{err}</p>}
      {v.ctas.length > 0 && (
        <div className="k-actions">
          {v.ctas.map((c) => (
            <Button key={c} variant={c === "confirm" || c === "done" ? "primary" : "secondary"} disabled={busy} data-testid={`co-cta-${c}`} onClick={() => void run(c)}>{label[c]}</Button>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- steps
function HoldingRow({ h, onPick }: { h: CashOutHolding; onPick: () => void }) {
  return (
    <li>
      <button type="button" className="fund-token" data-testid="co-holding" data-asset={h.assetId} onClick={onPick}>
        <AssetLogo symbol={h.symbol} />
        <span className="fund-token__sym">{h.label}</span>
        <span className="fund-token__net">{h.amountText}</span>
      </button>
    </li>
  );
}

function PickStep({ holdings, onPick }: { holdings: CashOutHolding[]; onPick: (h: CashOutHolding) => void }) {
  if (!holdings.length) return <p data-testid="co-nothing">{CASH_OUT_COPY.nothing}</p>;
  const betting = holdings.filter((h) => h.kind === "betting"), other = holdings.filter((h) => h.kind === "stray");
  return (
    <section className="fund-picker" data-testid="co-pick">
      <h3 className="fund-h">{COPY.cashOut.step1Title}</h3>
      {betting.length > 0 && (<><h4 className="fund-sub">{CASH_OUT_COPY.fromBalance}</h4><ul className="fund-tokens">{betting.map((h) => <HoldingRow key={h.assetId} h={h} onPick={() => onPick(h)} />)}</ul></>)}
      {other.length > 0 && (<><h4 className="fund-sub">{CASH_OUT_COPY.fromOther}</h4><ul className="fund-tokens">{other.map((h) => <HoldingRow key={h.assetId} h={h} onPick={() => onPick(h)} />)}</ul></>)}
    </section>
  );
}

function AmountStep({ h, locked, text, setText, onBack, onNext }: {
  h: CashOutHolding; locked: string | null; text: string; setText: (s: string) => void; onBack: (() => void) | null; onNext: (units: string) => void;
}) {
  const a = parseCashOutAmount(text, h);
  const [touched, setTouched] = useState(false);
  return (
    <section className="fund-amount" data-testid="co-amount-step">
      {onBack && <Button variant="ghost" size="sm" data-testid="co-back" onClick={onBack}>‹ {COPY.cashOut.step1Title}</Button>}
      <p className="fund-h" data-testid="co-holding-line">{h.label} · {h.amountText}</p>
      <div className="co-address__row">
        <div className="co-address__field">
          <TextField label={CASH_OUT_COPY.amountLabel(h.symbol)} value={text} inputMode="decimal" autoComplete="off" data-testid="co-amount"
            onChange={(e) => { setText(e.target.value); setTouched(true); }} />
        </div>
        <Button variant="secondary" data-testid="co-max" onClick={() => { setText(maxAmountText(h)); setTouched(true); }}>{COPY.cashOut.max}</Button>
      </div>
      {touched && !a.ok && text.trim() !== "" && <p className="co-error" role="alert" data-testid="co-amount-error">{a.message}</p>}
      {locked && <p className="k-small k-muted" data-testid="co-locked">{locked}</p>}
      <Button variant="primary" data-testid="co-amount-next" disabled={!a.ok} onClick={() => { if (a.ok) onNext(a.units); }}>{CASH_OUT_COPY.next}</Button>
    </section>
  );
}

function SendAsStep({ h, tokens, failed, onRetry, onBack, onPick }: {
  h: CashOutHolding; tokens: TokenOption[] | null; failed: boolean; onRetry: () => void; onBack: () => void; onPick: (t: TokenOption) => void;
}) {
  const [q, setQ] = useState("");
  if (failed) return <Notice tone="bad" title={COPY.add.loadError} data-testid="co-tokens-error" action={<Button data-testid="co-tokens-retry" onClick={onRetry}>{COPY.account.retry}</Button>} />;
  if (!tokens) return <p className="k-muted" data-testid="co-tokens-loading">Loading networks…</p>;
  const list = sendAsList(tokens, h, q);
  const same = q.trim() ? [] : list.filter((t) => displaySymbol(t) === h.symbol);
  const rest = q.trim() ? list : list.filter((t) => displaySymbol(t) !== h.symbol);
  const row = (t: TokenOption) => (
    <li key={t.assetId}>
      <button type="button" className="fund-token" data-testid={`co-sendas-${displaySymbol(t)}-${t.blockchain}`} onClick={() => onPick(t)}>
        <AssetLogo symbol={displaySymbol(t)} />
        <span className="fund-token__sym">{displaySymbol(t)}</span>
        <span className="fund-token__net k-muted">{t.exchangeNetworkName ?? t.networkName}</span>
      </button>
    </li>
  );
  return (
    <section className="fund-picker" data-testid="co-sendas">
      <Button variant="ghost" size="sm" data-testid="co-back" onClick={onBack}>‹ {CASH_OUT_COPY.back}</Button>
      <h3 className="fund-h">{COPY.cashOut.sendAsTitle}</h3>
      <TextField type="search" label={COPY.add.search} hideLabel placeholder={COPY.add.search} value={q} onChange={(e) => setQ(e.target.value)} data-testid="co-sendas-search" autoComplete="off" spellCheck={false} />
      {same.length > 0 && (<><h4 className="fund-sub">{COPY.cashOut.popularFor(h.symbol)}</h4><ul className="fund-tokens" data-testid="co-sendas-same">{same.map(row)}</ul></>)}
      {rest.length > 0 ? <ul className="fund-tokens" data-testid="co-sendas-all">{rest.map(row)}</ul> : q.trim() && <p data-testid="co-sendas-none">{COPY.add.noResults}</p>}
    </section>
  );
}

function ReviewStep({ account, h, units, dest, recipient, signRawHash, onBack, onTracked }: {
  account: string; h: CashOutHolding; units: string; dest: TokenOption; recipient: string; signRawHash: Sign; onBack: () => void; onTracked: (id: string) => void;
}) {
  const allowed = useGate("cash-out").allowed;
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<"price" | "signing" | null>(null);
  const pending = useRef<{ record: SwapRecord; quote: QuoteView } | null>(null);
  useLeaveGuard(busy === "signing");
  const req = (dry: boolean) => ({ account, kind: "withdraw" as const, originAsset: h.assetId, amountIn: units, destinationAsset: dest.assetId, recipient, dry });

  // The estimate, refreshed every 2 min while the user reads it (dry: nothing is saved).
  useEffect(() => {
    let live = true;
    const load = async () => {
      try { const q = await fundingClient().withdrawQuote(req(true)); if (live) { setQuote(q); setErr(null); } }
      catch (e) { if (live) { setQuote(null); setErr(cashOutErrorText(e, h, dest)); } }
    };
    void load();
    const t = setInterval(() => { if (!pending.current) void load(); }, REVIEW_REFRESH_MS);
    return () => { live = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h.assetId, units, dest.assetId, recipient]);

  const cashOut = async () => {
    if (!quote) return;
    setErr(null); setNote(null);
    let p = pending.current;
    const fresh = p && Date.now() - p.record.createdAt < REVIEW_REFRESH_MS && Date.parse(p.record.deadline!) - Date.now() > 60_000 && !priceDropped(quote, p.quote);
    if (!fresh) {
      setBusy("price");
      let real: QuoteView;
      try { real = await fundingClient().withdrawQuote(req(false)); }
      catch (e) { setBusy(null); setErr(cashOutErrorText(e, h, dest)); return; }
      const record = cashOutRecord({ quote: real, account, kind: "withdraw", origin: h.token, destination: dest, recipient, now: Date.now() });
      putRecord(record); // saved BEFORE signing (SPEC §7.4)
      p = pending.current = { record, quote: real };
      if (priceDropped(quote, real)) { setQuote(real); setNote(CASH_OUT_COPY.priceMoved); setBusy(null); return; }
    }
    setBusy("signing");
    const out = await signRecord(p!.record, account, signRawHash);
    setBusy(null);
    if (out.kind === "track") return onTracked(out.id);
    if (!out.keep) pending.current = null;
    setErr(out.message);
  };

  const v = quote ? reviewView(quote, h, dest, recipient) : null;
  return (
    <section className="co-review" data-testid="co-review">
      <Button variant="ghost" size="sm" data-testid="co-back" disabled={busy !== null} onClick={onBack}>‹ {CASH_OUT_COPY.back}</Button>
      {!v && !err && <p className="k-muted" data-testid="co-review-loading">{CASH_OUT_COPY.gettingPrice}</p>}
      {v && (<>
        <KeyValue variant="total" rows={v.rows.map((r) => ({ id: r.id, label: r.label, value: <span data-testid={`co-review-${r.id}`}>{r.value}</span>, emphasis: r.id === "receive" }))} data-testid="co-review-rows" />
        <Disclosure title={CASH_OUT_COPY.fullAddress} data-testid="co-review-address">
          <code className="fund-mono" data-testid="co-review-full-address">{v.fullAddress}</code> <CopyButton value={v.fullAddress} />
        </Disclosure>
      </>)}
      {note && <Notice tone="warn" title={note} data-testid="co-price-moved" />}
      {err && <p className="co-error" role="alert" data-testid="co-review-error">{err}</p>}
      <GateNotice action="cash-out" testId="co-gate" />
      {busy === "signing" && <p role="status" data-testid="co-signing">{COPY.cashOut.sign}</p>}
      <Button variant="primary" data-testid="co-confirm" disabled={!v || !allowed || busy !== null} onClick={() => void cashOut()}>
        {busy === "price" ? CASH_OUT_COPY.gettingPrice : busy === "signing" ? COPY.cashOut.sign : COPY.cashOut.cta}
      </Button>
    </section>
  );
}

// ---------------------------------------------------------------- the sheet
type Step =
  | { name: "pick" }
  | { name: "amount"; h: CashOutHolding }
  | { name: "sendAs"; h: CashOutHolding; units: string }
  | { name: "address"; h: CashOutHolding; units: string; dest: TokenOption }
  | { name: "review"; h: CashOutHolding; units: string; dest: TokenOption; recipient: string }
  | { name: "track"; id: string };

export interface WithdrawSheetProps {
  account: string;
  /** F3's balance map (the 6, the "not usable" tokens, what's locked in bets). null while it loads. */
  balances: Pick<BalanceMap, "betting" | "stray" | "inBets"> | null;
  /** Start on this token (the token sheet's Cash out). */
  preset?: string | null;
  /** Reopen this cash out's tracker (the Account "in progress" card). */
  trackId?: string | null;
  signRawHash: Sign;
  onClose: () => void;
}

export function WithdrawSheet({ account, balances, preset = null, trackId = null, signRawHash, onClose }: WithdrawSheetProps) {
  const holdings = useMemo(() => (balances ? cashOutHoldings(balances) : []), [balances]);
  const presetHolding = preset ? holdings.find((h) => h.assetId === preset) ?? null : null;
  const [step, setStep] = useState<Step>(trackId ? { name: "track", id: trackId } : presetHolding ? { name: "amount", h: presetHolding } : { name: "pick" });
  const [amountText, setAmountText] = useState("");
  const [address, setAddress] = useState("");
  const [memo, setMemo] = useState<MemoAnswer>(null);
  const [tokens, setTokens] = useState<TokenOption[] | null>(null);
  const [tokensFailed, setTokensFailed] = useState(false);
  const [tries, setTries] = useState(0);
  const records = useFundingRecords();
  useEffect(() => {
    let live = true;
    setTokensFailed(false);
    loadTokens().then((r) => { if (live) setTokens(r.list); }, () => { if (live) setTokensFailed(true); });
    return () => { live = false; };
  }, [tries]);
  const ownDeposits = records.filter((r) => r.kind === "fund" && !isTerminal(r)).map((r) => r.depositAddress);

  const toSendAs = (h: CashOutHolding, units: string) => {
    const def = tokens ? defaultSendAs(h, tokens, records) : null;
    setAddress(""); setMemo(null);
    setStep(def ? { name: "address", h, units, dest: def } : { name: "sendAs", h, units });
  };

  let body: React.ReactNode;
  if (step.name === "track") {
    const r = records.find((x) => x.id === step.id);
    body = r ? <CashOutTracker record={r} account={account} signRawHash={signRawHash} onDone={onClose} /> : <p className="k-muted" data-testid="co-track-loading">Loading…</p>;
  } else if (!balances) {
    body = <p className="k-muted" data-testid="co-loading">…</p>;
  } else if (step.name === "pick") {
    body = <PickStep holdings={holdings} onPick={(h) => { setAmountText(""); setStep({ name: "amount", h }); }} />;
  } else if (step.name === "amount") {
    body = <AmountStep h={step.h} locked={step.h.kind === "betting" ? lockedLine(balances.inBets, step.h.symbol) : null} text={amountText} setText={setAmountText}
      onBack={presetHolding && step.h === presetHolding ? null : () => setStep({ name: "pick" })} onNext={(units) => toSendAs(step.h, units)} />;
  } else if (step.name === "sendAs") {
    body = <SendAsStep h={step.h} tokens={tokens} failed={tokensFailed} onRetry={() => setTries((n) => n + 1)} onBack={() => setStep({ name: "amount", h: step.h })}
      onPick={(dest) => { setAddress(""); setMemo(null); setStep({ name: "address", h: step.h, units: step.units, dest }); }} />;
  } else if (step.name === "address") {
    const ready = addressReady(checkAddress(step.dest, address, { account, ownDeposits }), step.dest, memo);
    body = (
      <section className="co-address-step" data-testid="co-address-step">
        <Button variant="ghost" size="sm" data-testid="co-back" onClick={() => setStep({ name: "amount", h: step.h })}>‹ {CASH_OUT_COPY.back}</Button>
        <p className="co-sendas-line" data-testid="co-sendas-current">
          {CASH_OUT_COPY.sendAsCurrent(displaySymbol(step.dest), step.dest.networkName)}{" "}
          <Button variant="ghost" size="sm" data-testid="co-sendas-change" onClick={() => setStep({ name: "sendAs", h: step.h, units: step.units })}>{CASH_OUT_COPY.change}</Button>
        </p>
        <AddressInput dest={step.dest} account={account} ownDeposits={ownDeposits} value={address} onChange={setAddress} memo={memo} onMemo={setMemo} />
        <Button variant="primary" data-testid="co-address-next" disabled={!ready} onClick={() => setStep({ name: "review", h: step.h, units: step.units, dest: step.dest, recipient: address.trim() })}>{CASH_OUT_COPY.review}</Button>
      </section>
    );
  } else {
    body = <ReviewStep account={account} h={step.h} units={step.units} dest={step.dest} recipient={step.recipient} signRawHash={signRawHash}
      onBack={() => setStep({ name: "address", h: step.h, units: step.units, dest: step.dest })} onTracked={(id) => setStep({ name: "track", id })} />;
  }
  return (
    <Modal isOpen title={COPY.cashOut.title} onRequestClose={onClose} width={480} data-testid="cash-out-sheet">
      <div className="fund-sheet co-sheet" data-testid="co-sheet">{body}</div>
    </Modal>
  );
}
