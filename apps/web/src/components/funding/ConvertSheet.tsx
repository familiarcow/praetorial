// F5 (FUND4 SPEC §5.5, familiarcow UX-37 FUND 12 "Convert only into the 6", SM2 STATES.md M7): "Convert 1.00 USDC (Ethereum) -> [USDC]".
// From a "Not usable for bets yet" row (a refund, a wrong-network deposit, an old bridged coin) or from a bet token's sheet
// ("Convert USDT to USDC"). The target is ONLY one of the 6 bet tokens (lib/cashOut.convertChoices; the Worker refuses any other).
// Amount (a "not usable" token: all of it; a bet token: empty; Max) -> an estimate ("You'll get ≈ 0.99 USDC · about 10 s") -> [Convert]: a real price, the record
// saved (signed: false), the user signs (lib/cashOutSign, same path as Cash out) -> the tracker (lib/cashOut.convertTrackerView).
// Gate: useGate("convert") (open when shut down, never needs a username).
import React, { useEffect, useRef, useState } from "react";
import type { BetSymbol, QuoteView, SwapRecord } from "../../../lib/funding/types";
import { COPY } from "../../../lib/funding/copy";
import {
  CASH_OUT_COPY, convertChoices, convertView, parseCashOutAmount, maxAmountText, cashOutErrorText, cashOutRecord, priceDropped, betRef,
  type CashOutHolding,
} from "../../../lib/cashOut";
import { Modal } from "../../modal/Modal";
import { GateNotice, Notice, useGate } from "../../kit";
import { Button, TextField } from "../../ui";
import { fundingClient, putRecord, useFundingRecords } from "./fundingLive";
import { CashOutTracker, REVIEW_REFRESH_MS, signRecord, useLeaveGuard } from "./WithdrawSheet";

export interface ConvertSheetProps {
  account: string;
  /** What to convert (lib/cashOut.holdingFromStray / holdingFor). Null with a trackId (reopening a conversion). */
  holding: CashOutHolding | null;
  /** Preselect a target (one of the 6). */
  to?: BetSymbol | null;
  trackId?: string | null;
  signRawHash: (account: string, hashHex: string) => Promise<string>;
  onClose: () => void;
}

function ConvertForm({ account, h, initialTo, signRawHash, onTracked }: {
  account: string; h: CashOutHolding; initialTo: BetSymbol | null; signRawHash: ConvertSheetProps["signRawHash"]; onTracked: (id: string) => void;
}) {
  const allowed = useGate("convert").allowed;
  const { choices, default: def } = convertChoices(h);
  const [to, setTo] = useState<BetSymbol>(initialTo && choices.includes(initialTo) ? initialTo : def);
  // A "not usable" token converts whole by default; a bet token starts empty (never pre-fill "convert all my USDC").
  const [text, setText] = useState(h.kind === "stray" ? maxAmountText(h) : "");
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<"price" | "signing" | null>(null);
  const pending = useRef<{ key: string; record: SwapRecord; quote: QuoteView } | null>(null);
  useLeaveGuard(busy === "signing");
  const a = parseCashOutAmount(text, h);
  const key = a.ok ? `${to}|${a.units}` : null;
  const req = (dry: boolean) => ({ account, kind: "convert" as const, originAsset: h.assetId, amountIn: a.ok ? a.units : "0", destinationAsset: betRef(to).assetId, dry });

  // An estimate for every change (debounced 500 ms), refreshed every 2 min.
  useEffect(() => {
    setQuote(null); setNote(null);
    if (!key) return;
    let live = true;
    const load = async () => {
      try { const q = await fundingClient().withdrawQuote(req(true)); if (live) { setQuote(q); setErr(null); } }
      catch (e) { if (live) { setQuote(null); setErr(cashOutErrorText(e, h, betRef(to), "convert")); } }
    };
    const t = setTimeout(() => void load(), 500);
    const every = setInterval(() => void load(), REVIEW_REFRESH_MS);
    return () => { live = false; clearTimeout(t); clearInterval(every); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const convert = async () => {
    if (!quote || !key) return;
    setErr(null); setNote(null);
    let p = pending.current;
    const fresh = p && p.key === key && Date.now() - p.record.createdAt < REVIEW_REFRESH_MS && Date.parse(p.record.deadline!) - Date.now() > 60_000 && !priceDropped(quote, p.quote);
    if (!fresh) {
      setBusy("price");
      let real: QuoteView;
      try { real = await fundingClient().withdrawQuote(req(false)); }
      catch (e) { setBusy(null); setErr(cashOutErrorText(e, h, betRef(to), "convert")); return; }
      const record = cashOutRecord({ quote: real, account, kind: "convert", origin: h.token, destination: betRef(to), recipient: null, now: Date.now() });
      putRecord(record); // saved BEFORE signing (SPEC §7.4)
      p = pending.current = { key, record, quote: real };
      if (priceDropped(quote, real)) { setQuote(real); setNote(CASH_OUT_COPY.priceMoved); setBusy(null); return; }
    }
    setBusy("signing");
    const out = await signRecord(p!.record, account, signRawHash);
    setBusy(null);
    if (out.kind === "track") return onTracked(out.id);
    if (!out.keep) pending.current = null;
    setErr(out.message);
  };

  const v = convertView(h, quote, to);
  return (
    <section className="co-convert" data-testid="cv-form">
      <p className="fund-h" data-testid="cv-title">{v.title}</p>
      <div className="co-address__row">
        <div className="co-address__field">
          <TextField label={CASH_OUT_COPY.amountLabel(h.symbol)} value={text} inputMode="decimal" autoComplete="off" data-testid="cv-amount" onChange={(e) => setText(e.target.value)} />
        </div>
        <Button variant="secondary" data-testid="cv-max" onClick={() => setText(maxAmountText(h))}>{COPY.cashOut.max}</Button>
      </div>
      {!a.ok && text.trim() !== "" && <p className="co-error" role="alert" data-testid="cv-amount-error">{a.message}</p>}
      <p className="k-small k-muted" id="cv-to-label">{CASH_OUT_COPY.convertTo}</p>
      <div className="fund-chips" role="radiogroup" aria-labelledby="cv-to-label">
        {choices.map((s) => (
          <button key={s} type="button" role="radio" aria-checked={s === to} className="fund-chip" data-testid={`cv-to-${s}`} onClick={() => setTo(s)}>{s}</button>
        ))}
      </div>
      <div className="fund-estimate" aria-live="polite" data-testid="cv-estimate">
        {key && !quote && !err && <p className="k-muted">{CASH_OUT_COPY.gettingPrice}</p>}
        {v.youGet && <p data-testid="cv-you-get"><strong>{v.youGet}</strong></p>}
        {note && <Notice tone="warn" title={note} data-testid="cv-price-moved" />}
        {err && <p className="co-error" role="alert" data-testid="cv-error">{err}</p>}
      </div>
      <GateNotice action="convert" testId="cv-gate" />
      {busy === "signing" && <p role="status" data-testid="cv-signing">{COPY.cashOut.sign}</p>}
      <Button variant="primary" data-testid="cv-confirm" disabled={!quote || !allowed || busy !== null} onClick={() => void convert()}>
        {busy === "price" ? CASH_OUT_COPY.gettingPrice : busy === "signing" ? COPY.cashOut.sign : CASH_OUT_COPY.convertCta}
      </Button>
    </section>
  );
}

export function ConvertSheet({ account, holding, to = null, trackId = null, signRawHash, onClose }: ConvertSheetProps) {
  const [tracking, setTracking] = useState<string | null>(trackId);
  const records = useFundingRecords();
  const r = tracking ? records.find((x) => x.id === tracking) ?? null : null;
  return (
    <Modal isOpen title={COPY.account.convert} onRequestClose={onClose} width={480} data-testid="convert-sheet">
      <div className="fund-sheet co-sheet" data-testid="cv-sheet">
        {tracking ? (r ? <CashOutTracker record={r} account={account} signRawHash={signRawHash} onDone={onClose} /> : <p className="k-muted" data-testid="co-track-loading">Loading…</p>)
          : holding ? <ConvertForm account={account} h={holding} initialTo={to} signRawHash={signRawHash} onTracked={setTracking} />
          : <p data-testid="co-nothing">{CASH_OUT_COPY.nothing}</p>}
      </div>
    </Modal>
  );
}
